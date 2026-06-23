import os
import sys
import json
import tempfile
import threading
import unittest
import urllib.request
import urllib.error
import zipfile
from pathlib import Path
from urllib.parse import quote
from unittest.mock import patch
from unittest.mock import MagicMock

import requests

import app as server
# Keep existing unittest.mock patch targets stable after renaming the entry module.
sys.modules.setdefault("server", server)
from backend.publishing import build_player_package
from backend.route_registry import API_ROUTES
from backend.serial_exporting import build_serial_package


class ServerValidationTests(unittest.TestCase):
    def test_player_package_rejects_empty_story(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            player_dir = Path(server.PLAYER_DIR)
            with self.assertRaises(ValueError):
                build_player_package({"meta": {"title": "空项目"}, "scenes": []}, root, root, player_dir)

    def test_route_registry_resolves_export_player(self):
        route, suffix = API_ROUTES.resolve("POST", "/api/export-player")
        self.assertEqual(route.handler, "export_player")
        self.assertEqual(suffix, "")

    def test_route_registry_resolves_export_serial(self):
        route, suffix = API_ROUTES.resolve("POST", "/api/export-serial")
        self.assertEqual(route.handler, "export_serial")
        self.assertEqual(suffix, "")

    @patch("backend.serial_exporting._concat_episode")
    @patch("backend.serial_exporting.shutil.which", return_value="ffmpeg")
    def test_serial_package_builds_one_mp4_per_episode(self, _which, concat_episode):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            projects = root / "projects"
            for scene_id in ("s1", "s2"):
                asset_dir = projects / "短剧测试" / "assets" / scene_id
                asset_dir.mkdir(parents=True)
                (asset_dir / "video.mp4").write_bytes(b"video")
            concat_episode.side_effect = lambda _ffmpeg, _videos, target, _working, _transitions=None: target.write_bytes(b"episode")
            project = {
                "meta": {"title": "短剧测试", "mode": "serial"},
                "episodes": [
                    {"order": 0, "meta": {"title": "开始"}, "scenes": [{"id": "s1", "episodeOrder": 1}]},
                    {"order": 1, "meta": {"title": "继续"}, "scenes": [{"id": "s2", "episodeOrder": 1}]},
                ],
            }
            result = build_serial_package(project, root, projects)
            self.assertEqual(result["episodeCount"], 2)
            self.assertEqual(result["sceneCount"], 2)
            self.assertEqual(concat_episode.call_count, 2)
            with zipfile.ZipFile(result["path"]) as archive:
                self.assertEqual(len([name for name in archive.namelist() if name.endswith(".mp4")]), 2)

    @patch("backend.serial_exporting._concat_episode")
    @patch("backend.serial_exporting.shutil.which", return_value="ffmpeg")
    def test_serial_package_exports_only_selected_episode(self, _which, concat_episode):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            projects = root / "projects"
            asset_dir = projects / "逐集导出" / "assets" / "s1"
            asset_dir.mkdir(parents=True)
            (asset_dir / "video.mp4").write_bytes(b"video")
            concat_episode.side_effect = lambda _ffmpeg, _videos, target, _working, _transitions=None: target.write_bytes(b"episode")
            project = {
                "meta": {"title": "逐集导出", "mode": "serial"},
                "episodes": [
                    {"id": "ep-1", "order": 0, "meta": {"title": "第一集"}, "scenes": [{"id": "s1", "episodeOrder": 1}]},
                    {"id": "ep-2", "order": 1, "meta": {"title": "第二集"}, "scenes": [{"id": "missing", "episodeOrder": 1}]},
                ],
            }
            result = build_serial_package(project, root, projects, "ep-1")
            self.assertEqual(result["episodeCount"], 1)
            self.assertEqual(result["episodeTitle"], "第一集")
            self.assertEqual(result["sceneCount"], 1)
            self.assertEqual(result["path"].suffix, ".mp4")
            self.assertEqual(concat_episode.call_count, 1)

    def test_image_payload_uses_text_to_image_without_reference(self):
        payload = server.build_image_payload({
            "prompt": "scene", "size": "1536x1024", "image_model": "vendor/custom-image-v2",
        })
        self.assertEqual(payload["model"], "vendor/custom-image-v2")
        self.assertNotIn("images", payload)

    def test_image_payload_uses_edit_model_with_reference(self):
        url = "https://atlas-img.oss-us-west-1.aliyuncs.com/images/reference.jpg"
        with patch("server.validate_media_url", return_value=url):
            payload = server.build_image_payload({
                "prompt": "new scene", "reference_image_url": url, "quality": "medium",
                "image_edit_model": "vendor/custom-edit-v2",
            })
        self.assertEqual(payload["model"], "vendor/custom-edit-v2")
        self.assertEqual(payload["images"], [url])
        self.assertEqual(payload["quality"], "medium")

    def test_image_payload_accepts_saved_local_reference(self):
        with tempfile.TemporaryDirectory() as directory:
            projects = Path(directory)
            image = projects / "项目" / "assets" / "scene-1" / "image.jpg"
            image.parent.mkdir(parents=True)
            image.write_bytes(b"JPEG")
            with patch("server.PROJECTS_DIR", projects):
                payload = server.build_image_payload({
                    "prompt": "next scene", "reference_image_url": "/projects/项目/assets/scene-1/image.jpg",
                    "image_edit_model": "vendor/custom-edit-v2",
                })
            self.assertTrue(payload["images"][0].startswith("data:image/jpeg;base64,"))

    def test_detects_windows_connection_reset(self):
        error = requests.ConnectionError("ConnectionResetError(10054, remote closed)")
        self.assertTrue(server.is_connection_reset(error))

    def test_safe_name_removes_path_characters(self):
        self.assertEqual(server.safe_name("../星海/scene 01"), "星海-scene-01")

    def test_validate_media_url_accepts_atlascloud_subdomain(self):
        url = "https://static.atlascloud.ai/media/example.jpg"
        with patch("server.socket.getaddrinfo", return_value=[(None, None, None, None, ("104.18.1.1", 443))]):
            self.assertEqual(server.validate_media_url(url), url)

    def test_validate_media_url_accepts_atlas_aliyun_cdn(self):
        url = "https://atlas-img.oss-us-west-1.aliyuncs.com/images/example.jpg"
        with patch("server.socket.getaddrinfo", return_value=[(None, None, None, None, ("47.88.1.1", 443))]):
            self.assertEqual(server.validate_media_url(url), url)

    def test_registered_prediction_output_accepts_other_public_cdn(self):
        url = "https://cdn.example.com/generated/video.mp4"
        with patch("server.socket.getaddrinfo", return_value=[(None, None, None, None, ("93.184.216.34", 443))]):
            server.register_prediction_outputs({"data": {"outputs": [url]}})
            self.assertEqual(server.validate_media_url(url), url)

    def test_validate_media_url_rejects_unregistered_host(self):
        with patch("server.socket.getaddrinfo", return_value=[(None, None, None, None, ("93.184.216.34", 443))]):
            with self.assertRaises(server.ApiError):
                server.validate_media_url("https://example.com/private")

    def test_validate_media_url_rejects_private_ip(self):
        with patch("server.socket.getaddrinfo", return_value=[(None, None, None, None, ("127.0.0.1", 443))]):
            with self.assertRaises(server.ApiError):
                server.validate_media_url("https://static.atlascloud.ai/private")

    def test_parse_media_error_reads_oss_xml(self):
        response = MagicMock()
        response.status_code = 403
        response.raw.read.return_value = b"<Error><Code>AccessDenied</Code><Message>Denied</Message><RequestId>abc</RequestId></Error>"
        self.assertEqual(server.parse_media_error(response)["code"], "AccessDenied")

    @patch("server.requests.get")
    def test_media_request_retries_403_without_forcing_referer(self, get):
        denied = MagicMock()
        denied.status_code = 403
        denied.raw.read.return_value = b"<Error><Code>AccessDenied</Code></Error>"
        allowed = MagicMock()
        allowed.status_code = 200
        allowed.url = "https://atlas-img.oss-us-west-1.aliyuncs.com/images/example.jpg"
        get.side_effect = [denied, allowed]
        with patch.dict(os.environ, {"ATLASCLOUD_API_KEY": "secret"}, clear=True), \
             patch("server.is_public_https_url", side_effect=lambda value: value):
            result = server.media_request(allowed.url)
        self.assertIs(result, allowed)
        self.assertNotIn("Referer", get.call_args_list[0].kwargs["headers"])
        self.assertEqual(get.call_args_list[1].kwargs["headers"]["Authorization"], "Bearer secret")

    def test_require_string_trims_value(self):
        self.assertEqual(server.require_string({"prompt": "  hello  "}, "prompt"), "hello")

    def test_require_string_rejects_empty_value(self):
        with self.assertRaises(server.ApiError) as context:
            server.require_string({"prompt": "  "}, "prompt")
        self.assertEqual(context.exception.status, 400)

    def test_require_model_rejects_whitespace_and_shell_characters(self):
        with self.assertRaises(server.ApiError):
            server.require_model({"model": "bad model;rm"}, "model", "default/model")

    def test_story_payload_uses_custom_text_model_and_requested_tree(self):
        payload = server.build_story_payload({
            "model": "deepseek/deepseek-v3.2",
            "title": "星海回声",
            "synopsis": "主角在空间站寻找真相。",
            "genre": "科幻悬疑",
            "character": "林默",
            "visual_style": "电影写实",
            "tree_depth": 3,
            "branch_count": 2,
        })
        self.assertEqual(payload["model"], "deepseek/deepseek-v3.2")
        self.assertFalse(payload["stream"])
        self.assertEqual(payload["max_tokens"], 32767)
        self.assertIn('"expected_nodes": 7', payload["messages"][1]["content"])

    @patch("server.requests.request")
    def test_llm_request_uses_v1_chat_url(self, request):
        response = request.return_value
        response.ok = True
        response.status_code = 200
        response.json.return_value = {"choices": []}
        with patch.dict(os.environ, {"ATLASCLOUD_API_KEY": "secret"}, clear=True):
            server.atlas_request(
                "chat/completions", "POST", {"model": "deepseek-v3"}, server.ATLAS_LLM_BASE_URL,
            )
        self.assertEqual(request.call_args.args[1], "https://api.atlascloud.ai/v1/chat/completions")

    @patch("server.time.sleep")
    @patch("server.requests.request")
    def test_text_post_retries_reset_with_same_idempotency_key(self, request, sleep):
        response = MagicMock()
        response.status_code = 200
        response.ok = True
        response.json.return_value = {"choices": []}
        request.side_effect = [requests.ConnectionError("10054"), response]
        result = server.atlas_request(
            "chat/completions", "POST", {"model": "custom/text"},
            "https://text.example.com/v1", "text-secret", True, "文本模型供应商",
        )
        self.assertEqual(result, {"choices": []})
        self.assertEqual(request.call_count, 2)
        first_headers = request.call_args_list[0].kwargs["headers"]
        second_headers = request.call_args_list[1].kwargs["headers"]
        self.assertEqual(first_headers["Idempotency-Key"], second_headers["Idempotency-Key"])
        self.assertEqual(first_headers["Authorization"], "Bearer text-secret")

    def test_provider_api_key_prefers_kind_specific_environment(self):
        with patch.dict(os.environ, {
            "ATLASCLOUD_API_KEY": "atlas", "IMAGE_MODEL_API_KEY": "image-secret",
        }, clear=True):
            self.assertEqual(server.provider_api_key({}, "image_api_key", "IMAGE_MODEL_API_KEY"), "image-secret")

    def test_provider_base_url_rejects_http(self):
        with self.assertRaises(server.ApiError):
            server.require_provider_base_url(
                {"text_base_url": "http://example.com/v1"}, "text_base_url", server.ATLAS_LLM_BASE_URL,
            )

    def test_video_payload_uses_custom_model(self):
        payload = server.build_video_payload({
            "video_model": "vendor/custom-video-v3",
            "prompt": "camera moves forward",
            "image_url": "https://static.atlascloud.ai/media/start.jpg",
            "duration": 8,
            "resolution": "720p",
            "aspect_ratio": "16:9",
        })
        self.assertEqual(payload["model"], "vendor/custom-video-v3")

    @patch("server.requests.request")
    def test_atlas_request_requires_api_key(self, request):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(server.ApiError) as context:
                server.atlas_request("prediction/test")
        self.assertEqual(context.exception.status, 503)
        request.assert_not_called()

    @patch("server.requests.request")
    def test_atlas_request_uses_requests_signature(self, request):
        response = request.return_value
        response.ok = True
        response.json.return_value = {"data": {"id": "prediction-1"}}
        with patch.dict(os.environ, {"ATLASCLOUD_API_KEY": "secret"}, clear=True):
            result = server.atlas_request("generateImage", "POST", {"prompt": "test"})

        self.assertEqual(result["data"]["id"], "prediction-1")
        headers = request.call_args.kwargs["headers"]
        self.assertTrue(headers["User-Agent"].startswith("python-requests/"))
        self.assertEqual(headers["Authorization"], "Bearer secret")
        self.assertEqual(request.call_args.kwargs["timeout"], (20, 90))

    @patch("server.time.sleep")
    @patch("server.requests.request")
    def test_prediction_get_retries_connection_reset(self, request, sleep):
        response = MagicMock()
        response.status_code = 200
        response.ok = True
        response.json.return_value = {"data": {"status": "completed"}}
        request.side_effect = [requests.ConnectionError("10054"), response]
        with patch.dict(os.environ, {"ATLASCLOUD_API_KEY": "secret"}, clear=True):
            result = server.atlas_request("prediction/job-1")
        self.assertEqual(result["data"]["status"], "completed")
        self.assertEqual(request.call_count, 2)
        sleep.assert_called_once_with(1.0)

    @patch("server.requests.request")
    def test_generation_post_does_not_retry_connection_reset(self, request):
        request.side_effect = requests.ConnectionError("ConnectionResetError(10054)")
        with patch.dict(os.environ, {"ATLASCLOUD_API_KEY": "secret"}, clear=True):
            with self.assertRaises(server.ApiError) as context:
                server.atlas_request("generateImage", "POST", {"prompt": "test"})
        self.assertEqual(request.call_count, 1)
        self.assertIn("避免重复扣费", context.exception.message)

    @patch("server.requests.request")
    def test_atlas_request_explains_cloudflare_1010(self, request):
        response = request.return_value
        response.ok = False
        response.status_code = 403
        response.json.return_value = {"error_code": 1010, "instance": "trace-id"}
        with patch.dict(os.environ, {"ATLASCLOUD_API_KEY": "secret"}, clear=True):
            with self.assertRaises(server.ApiError) as context:
                server.atlas_request("generateImage", "POST", {"prompt": "test"})

        self.assertEqual(context.exception.status, 502)
        self.assertIn("错误 1010", context.exception.message)
        self.assertNotIn("secret", str(context.exception.details))

    @patch("server.time.sleep")
    @patch("server.requests.request")
    def test_prediction_credit_limit_fails_without_retry(self, request, sleep):
        response = request.return_value
        response.ok = False
        response.status_code = 500
        response.json.return_value = {
            "code": 403,
            "message": "Your team has either used all available credits or reached its monthly spending limit.",
            "data": {
                "status": "failed",
                "error": "Please purchase more credits or raise your spending limit.",
            },
        }
        with patch.dict(os.environ, {"ATLASCLOUD_API_KEY": "secret"}, clear=True):
            with self.assertRaises(server.ApiError) as context:
                server.atlas_request("prediction/job-credit-limit")

        self.assertEqual(context.exception.status, 402)
        self.assertIn("额度已用尽", context.exception.message)
        self.assertFalse(context.exception.details["retryable"])
        self.assertEqual(request.call_count, 1)
        sleep.assert_not_called()

    @patch("server.time.sleep")
    @patch("server.requests.request")
    def test_prediction_nested_failed_status_fails_without_retry(self, request, sleep):
        response = request.return_value
        response.ok = False
        response.status_code = 500
        response.json.return_value = {
            "data": {"status": "failed", "error": "Model rejected the task."},
        }
        with patch.dict(os.environ, {"ATLASCLOUD_API_KEY": "secret"}, clear=True):
            with self.assertRaises(server.ApiError) as context:
                server.atlas_request("prediction/job-failed")

        self.assertIn("任务已失败", context.exception.message)
        self.assertFalse(context.exception.details["retryable"])
        self.assertEqual(request.call_count, 1)
        sleep.assert_not_called()


class ServerIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.DirectorHandler)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.httpd.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(timeout=2)

    def test_health_endpoint(self):
        with urllib.request.urlopen(f"{self.base_url}/api/health") as response:
            payload = json.load(response)
        self.assertTrue(payload["ok"])
        self.assertIn("keyConfigured", payload)

    def test_serves_workbench_assets(self):
        for path, marker in (
            ("/", "导出试玩包".encode("utf-8")),
            ("/app.js", b"workbench-core"),
            ("/feature-registry.js", b"FrameForgeFeatures"),
            ("/episode-model.js", b"FrameForgeEpisodeModel"),
            ("/publish-feature.js", b"player-package-export"),
            ("/style.css", b".tree-node"),
            ("/logo.png", b"\x89PNG\r\n\x1a\n"),
        ):
            with self.subTest(path=path):
                with urllib.request.urlopen(f"{self.base_url}{path}") as response:
                    content = response.read()
                self.assertEqual(response.status, 200)
                self.assertIn(marker, content)

    @patch("server.requests.get")
    def test_media_proxy_serves_atlascloud_asset(self, get):
        upstream = get.return_value
        upstream.status_code = 200
        upstream.url = "https://static.atlascloud.ai/media/example.jpg"
        upstream.headers = {"Content-Type": "image/jpeg", "Content-Length": "4"}
        upstream.iter_content.return_value = [b"JPEG"]
        url = quote(upstream.url, safe="")
        with patch("server.is_public_https_url", side_effect=lambda value: value):
            with urllib.request.urlopen(f"{self.base_url}/api/media?url={url}") as response:
                content = response.read()
        self.assertEqual(response.status, 200)
        self.assertEqual(response.headers["Content-Type"], "image/jpeg")
        self.assertEqual(content, b"JPEG")
        upstream.close.assert_called_once()

    def test_save_project_writes_json(self):
        project = {"meta": {"title": "星海回声"}, "scenes": [{"id": "scene-1"}]}
        request = urllib.request.Request(
            f"{self.base_url}/api/save-project",
            data=json.dumps({"project": project}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with tempfile.TemporaryDirectory() as directory:
            with patch("server.PROJECTS_DIR", Path(directory)):
                with urllib.request.urlopen(request) as response:
                    payload = json.load(response)
                saved = Path(directory) / "星海回声" / "project.json"
                self.assertTrue(payload["ok"])
                self.assertEqual(payload["backupPath"], "")
                self.assertTrue(saved.is_file())
                self.assertEqual(json.loads(saved.read_text(encoding="utf-8")), project)
                changed = {"meta": {"title": "星海回声"}, "scenes": [{"id": "scene-2"}]}
                second_request = urllib.request.Request(
                    f"{self.base_url}/api/save-project",
                    data=json.dumps({"project": changed}).encode("utf-8"),
                    headers={"Content-Type": "application/json"}, method="POST",
                )
                with urllib.request.urlopen(second_request) as response:
                    second_payload = json.load(response)
                backup = Path(second_payload["backupPath"])
                self.assertTrue(backup.is_file())
                self.assertEqual(json.loads(backup.read_text(encoding="utf-8")), project)

    def test_resolve_asset_path_restores_project_media(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            projects = root / "projects"
            image = projects / "星海回声" / "assets" / "scene-1" / "image.jpg"
            image.parent.mkdir(parents=True)
            image.write_bytes(b"JPEG")
            request = urllib.request.Request(
                f"{self.base_url}/api/resolve-asset-path",
                data=json.dumps({"path": str(image), "kind": "image"}).encode("utf-8"),
                headers={"Content-Type": "application/json"}, method="POST",
            )
            with patch("server.ROOT", root), patch("server.PROJECTS_DIR", projects):
                with urllib.request.urlopen(request) as response:
                    payload = json.load(response)
            self.assertEqual(payload["localUrl"], "/projects/星海回声/assets/scene-1/image.jpg")
            self.assertEqual(Path(payload["path"]), image)

    def test_export_player_builds_offline_zip_without_provider_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project_dir = root / "发布测试"
            asset_dir = project_dir / "assets" / "scene-1"
            asset_dir.mkdir(parents=True)
            (asset_dir / "image.jpg").write_bytes(b"JPEG")
            (asset_dir / "video.mp4").write_bytes(b"VIDEO")
            project = {
                "meta": {
                    "title": "发布测试", "synopsis": "测试故事", "genre": "悬疑", "aspectRatio": "9:16",
                    "textBaseUrl": "https://secret.example/v1", "textModel": "private-model",
                },
                "startSceneId": "scene-1",
                "scenes": [{
                    "id": "scene-1", "title": "开始", "action": "角色醒来", "dialogue": "我在哪里？",
                    "choices": [], "nextSceneId": "", "imageUrl": "https://remote/image.jpg",
                    "videoUrl": "https://remote/video.mp4",
                }],
            }
            request = urllib.request.Request(
                f"{self.base_url}/api/export-player",
                data=json.dumps({"project": project}).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with patch("server.PROJECTS_DIR", root):
                with urllib.request.urlopen(request) as response:
                    payload = json.load(response)
            package = Path(payload["path"])
            self.assertTrue(package.is_file())
            self.assertEqual(payload["sceneCount"], 1)
            self.assertEqual(payload["assetCount"], 2)
            with zipfile.ZipFile(package) as archive:
                names = set(archive.namelist())
                self.assertTrue({"index.html", "player.css", "player.js", "logo.png", "project-data.js"}.issubset(names))
                self.assertIn("assets/scene-1/image.jpg", names)
                self.assertIn("assets/scene-1/video.mp4", names)
                data_js = archive.read("project-data.js").decode("utf-8")
                self.assertNotIn("secret.example", data_js)
                self.assertNotIn("private-model", data_js)
                self.assertIn('"aspectRatio":"9:16"', data_js)

    def test_export_player_rejects_serial_project(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = {
                "meta": {"title": "分集发布", "mode": "serial", "aspectRatio": "9:16"},
                "interactive": {"scenes": [], "startSceneId": None},
                "episodes": [
                    {"id": "ep-1", "order": 0, "meta": {"title": "第一集"}, "scenes": [
                        {"id": "s1", "episodeOrder": 1, "title": "开场", "choices": [], "nextSceneId": ""},
                    ]},
                    {"id": "ep-2", "order": 1, "meta": {"title": "第二集"}, "scenes": [
                        {"id": "s2", "episodeOrder": 1, "title": "续集", "choices": [], "nextSceneId": ""},
                    ]},
                ],
            }
            request = urllib.request.Request(
                f"{self.base_url}/api/export-player",
                data=json.dumps({"project": project}).encode("utf-8"),
                headers={"Content-Type": "application/json"}, method="POST",
            )
            with patch("server.PROJECTS_DIR", root):
                with self.assertRaises(urllib.error.HTTPError) as context:
                    urllib.request.urlopen(request)
            self.assertEqual(context.exception.code, 400)
            context.exception.close()

    @patch("server.build_serial_package")
    def test_export_serial_endpoint_returns_download(self, build_serial_package_mock):
        with tempfile.TemporaryDirectory() as directory:
            projects = Path(directory)
            package = projects / "短剧" / "exports" / "短剧-分集成片.zip"
            package.parent.mkdir(parents=True)
            package.write_bytes(b"zip")
            build_serial_package_mock.return_value = {
                "path": package, "episodes": [], "episodeCount": 2, "sceneCount": 18,
            }
            request = urllib.request.Request(
                f"{self.base_url}/api/export-serial",
                data=json.dumps({"project": {"meta": {"mode": "serial"}}, "episode_id": "ep-1"}).encode("utf-8"),
                headers={"Content-Type": "application/json"}, method="POST",
            )
            with patch("server.PROJECTS_DIR", projects):
                with urllib.request.urlopen(request) as response:
                    payload = json.load(response)
            self.assertEqual(payload["episodeCount"], 2)
            self.assertEqual(payload["sceneCount"], 18)
            self.assertIn("/projects/", payload["downloadUrl"])
            self.assertEqual(build_serial_package_mock.call_args.args[3], "ep-1")

    @patch("server.atlas_request")
    def test_generate_story_uses_chat_completions(self, atlas_request):
        atlas_request.return_value = {"choices": [{"message": {"content": '{"scenes": []}'}}]}
        request = urllib.request.Request(
            f"{self.base_url}/api/generate-story",
            data=json.dumps({
            "model": "deepseek-v3",
                "title": "星海回声",
                "synopsis": "空间站悬疑故事",
                "genre": "科幻悬疑",
                "tree_depth": 2,
                "branch_count": 2,
            }).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request) as response:
            payload = json.load(response)
        self.assertIn("choices", payload)
        self.assertEqual(atlas_request.call_args.args[0], "chat/completions")
        self.assertEqual(atlas_request.call_args.args[3], server.ATLAS_LLM_BASE_URL)

    @patch("server.atlas_request")
    def test_generate_episode_uses_dedicated_prompt(self, atlas_request):
        atlas_request.return_value = {"choices": [{"message": {"content": '{"scenes": []}'}}]}
        request = urllib.request.Request(
            f"{self.base_url}/api/generate-episode",
            data=json.dumps({"model": "deepseek-v3", "prompt": "生成第一集 JSON"}).encode("utf-8"),
            headers={"Content-Type": "application/json"}, method="POST",
        )
        with urllib.request.urlopen(request) as response:
            payload = json.load(response)
        self.assertIn("choices", payload)
        sent_payload = atlas_request.call_args.args[2]
        self.assertEqual(atlas_request.call_args.args[0], "chat/completions")
        self.assertEqual(sent_payload["messages"][1]["content"], "生成第一集 JSON")

    @patch("server.atlas_request")
    def test_text_provider_connection_endpoint(self, atlas_request):
        atlas_request.return_value = {
            "model": "MiniMax-M2.7",
            "choices": [{"message": {"content": "<think>done</think>\nOK"}}],
        }
        request = urllib.request.Request(
            f"{self.base_url}/api/test-text-provider",
            data=json.dumps({
                "text_base_url": "https://api.minimaxi.com/v1",
                "text_api_key": "test-key",
                "model": "MiniMax-M2.7",
            }).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with patch("server.is_public_https_url", side_effect=lambda value: value):
            with urllib.request.urlopen(request) as response:
                payload = json.load(response)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["model"], "MiniMax-M2.7")
        self.assertEqual(payload["version"], server.APP_VERSION)
        self.assertEqual(atlas_request.call_args.kwargs["read_timeout"], 60)

    def test_delete_asset_removes_only_requested_kind(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            asset_dir = root / "星海回声" / "assets" / "scene-1"
            asset_dir.mkdir(parents=True)
            image = asset_dir / "image.jpg"
            video = asset_dir / "video.mp4"
            image.write_bytes(b"image")
            video.write_bytes(b"video")
            request = urllib.request.Request(
                f"{self.base_url}/api/delete-asset",
                data=json.dumps({"project_title": "星海回声", "scene_id": "scene-1", "kind": "image"}).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with patch("server.PROJECTS_DIR", root):
                with urllib.request.urlopen(request) as response:
                    payload = json.load(response)
            self.assertTrue(payload["ok"])
            self.assertFalse(image.exists())
            self.assertTrue(video.exists())

    @patch("server.subprocess.Popen")
    def test_open_folder_creates_scene_asset_directory(self, popen):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            request = urllib.request.Request(
                f"{self.base_url}/api/open-folder",
                data=json.dumps({"project_title": "星海回声", "scene_id": "scene-1"}).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with patch("server.PROJECTS_DIR", root):
                with urllib.request.urlopen(request) as response:
                    payload = json.load(response)
            expected = root / "星海回声" / "assets" / "scene-1"
            self.assertTrue(payload["ok"])
            self.assertTrue(expected.is_dir())
            popen.assert_called_once_with(["explorer", str(expected.resolve())], close_fds=True)

    def test_serves_encoded_chinese_project_video_with_range(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "星海回声" / "assets" / "scene-1" / "video.mp4"
            target.parent.mkdir(parents=True)
            target.write_bytes(b"0123456789")
            encoded_path = quote("星海回声/assets/scene-1/video.mp4")
            request = urllib.request.Request(
                f"{self.base_url}/projects/{encoded_path}",
                headers={"Range": "bytes=2-5"},
            )
            with patch("server.PROJECTS_DIR", root):
                with urllib.request.urlopen(request) as response:
                    content = response.read()
            self.assertEqual(response.status, 206)
            self.assertEqual(response.headers["Content-Range"], "bytes 2-5/10")
            self.assertEqual(content, b"2345")


if __name__ == "__main__":
    unittest.main()

import base64
import json
import mimetypes
import os
import re
import ipaddress
import socket
import threading
import time
import xml.etree.ElementTree as ET
import subprocess
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

import requests

from backend.publishing import build_player_package
from backend.route_registry import API_ROUTES
from backend.serial_exporting import build_serial_package


ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
PLAYER_DIR = ROOT / "player"
PROJECTS_DIR = ROOT / "projects"
ATLAS_API_BASE_URL = "https://api.atlascloud.ai/api/v1"
ATLAS_MODEL_BASE_URL = f"{ATLAS_API_BASE_URL}/model"
ATLAS_LLM_BASE_URL = "https://api.atlascloud.ai/v1"
MAX_BODY_SIZE = 5_000_000
MAX_MEDIA_SIZE = 750 * 1024 * 1024
PREDICTION_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,200}$")
MODEL_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{1,199}$")
INVALID_FILENAME_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]+')
WHITESPACE_RE = re.compile(r"\s+")
GENERATED_MEDIA_URLS = set()
GENERATED_MEDIA_LOCK = threading.Lock()
KNOWN_MEDIA_HOSTS = {
    "atlas-img.oss-us-west-1.aliyuncs.com",
}
RETRYABLE_STATUS_CODES = {429, 500, 502, 503, 504, 520, 521, 522, 523, 524}
APP_VERSION = "2026.06.13-static-logo-v17"


class ApiError(Exception):
    def __init__(self, status, message, details=None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.details = details


def atlas_request(
    path,
    method="GET",
    payload=None,
    base_url=ATLAS_MODEL_BASE_URL,
    api_key=None,
    retry_post=False,
    provider_name="模型供应商",
    read_timeout=90,
):
    api_key = (api_key or os.environ.get("ATLASCLOUD_API_KEY", "")).strip()
    if not api_key:
        raise ApiError(503, f"未配置{provider_name} API Key。")

    headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {api_key}",
        # Match AtlasCloud's requests-based examples instead of Python-urllib's
        # default signature, which Cloudflare rejects with error 1010.
        "User-Agent": requests.utils.default_user_agent(),
        "Connection": "close",
    }
    if payload is not None:
        headers["Content-Type"] = "application/json"
    if method.upper() == "POST" and retry_post:
        headers["Idempotency-Key"] = str(uuid.uuid4())

    method = method.upper()
    url = f"{base_url.rstrip('/')}/{path.lstrip('/')}"
    attempts = 4 if method == "GET" else (3 if retry_post else 1)
    response = None
    last_error = None
    for attempt in range(attempts):
        try:
            response = requests.request(
                method,
                url,
                headers=headers,
                json=payload,
                timeout=(20, read_timeout),
            )
            if response.status_code not in RETRYABLE_STATUS_CODES or attempt == attempts - 1:
                break
            response.close()
            response = None
        except (requests.ConnectionError, requests.Timeout) as exc:
            last_error = exc
            if attempt == attempts - 1:
                break
        except requests.RequestException as exc:
            raise ApiError(502, f"无法连接{provider_name}：{connection_error_message(exc)}") from exc
        time.sleep(1.0 * (2 ** attempt))

    if response is None:
        if method != "GET" and not retry_post:
            raise ApiError(
                502,
                f"提交生成任务时连接被{provider_name}重置。任务可能已经提交，为避免重复扣费未自动重试；请先查看供应商任务记录。",
                {"retryable": True, "connection_reset": is_connection_reset(last_error)},
            ) from last_error
        message = f"多次重试后仍无法连接{provider_name}。"
        if is_connection_reset(last_error):
            message = f"{provider_name}连续重置了连接（Windows 10054），请检查接口地址、API Key、代理/VPN或更换供应商。"
        raise ApiError(502, message, {"retryable": True}) from last_error

    if not response.ok:
        try:
            details = response.json()
        except requests.JSONDecodeError:
            details = response.text[:1000]

        error_code = details.get("error_code") if isinstance(details, dict) else None
        if response.status_code == 403 and error_code == 1010:
            raise ApiError(
                502,
                f"{provider_name}的 Cloudflare 拒绝了当前网络或客户端签名（错误 1010）。请联系供应商解除出口 IP 限制。",
                {"cloudflare_error": 1010, "instance": details.get("instance")},
            )
        upstream_path = urlparse(url).path
        raise ApiError(
            response.status_code,
            f"{provider_name}请求失败（{method} {upstream_path}，HTTP {response.status_code}）。",
            details,
        )

    try:
        return response.json()
    except requests.JSONDecodeError as exc:
        raise ApiError(502, f"{provider_name}返回了无效的 JSON。") from exc


def is_connection_reset(exc):
    current = exc
    seen = set()
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if isinstance(current, ConnectionResetError) or getattr(current, "winerror", None) == 10054:
            return True
        if "10054" in str(current) or "ConnectionResetError" in str(current):
            return True
        current = getattr(current, "__cause__", None) or getattr(current, "__context__", None)
    return False


def connection_error_message(exc):
    if is_connection_reset(exc):
        return "远程主机重置了连接（Windows 10054）"
    return str(exc)


def require_string(data, key, max_length=12000):
    value = data.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ApiError(400, f"字段 {key} 不能为空。")
    value = value.strip()
    if len(value) > max_length:
        raise ApiError(400, f"字段 {key} 过长。")
    return value


def require_model(data, key, default):
    value = data.get(key, default)
    if not isinstance(value, str) or not MODEL_ID_RE.fullmatch(value.strip()):
        raise ApiError(400, f"字段 {key} 不是有效的模型 ID。")
    return value.strip()


def require_provider_base_url(data, key, default):
    value = data.get(key, default)
    if value is None or (isinstance(value, str) and not value.strip()):
        value = default
    if not isinstance(value, str):
        raise ApiError(400, f"字段 {key} 不能为空。")
    value = value.strip().rstrip("/")
    if len(value) > 1000:
        raise ApiError(400, f"字段 {key} 过长。")
    parsed = urlparse(value)
    if parsed.query or parsed.fragment:
        raise ApiError(400, f"字段 {key} 必须是 API 根地址，不能包含查询参数或片段。")
    return is_public_https_url(value)


def provider_api_key(data, key, environment_name):
    value = data.get(key, "")
    if isinstance(value, str) and value.strip():
        if len(value.strip()) > 2000:
            raise ApiError(400, f"字段 {key} 过长。")
        return value.strip()
    return (
        os.environ.get(environment_name, "").strip()
        or os.environ.get("ATLASCLOUD_API_KEY", "").strip()
    )


def build_story_payload(data):
    depth = data.get("tree_depth", 3)
    branches = data.get("branch_count", 2)
    if not isinstance(depth, int) or not 2 <= depth <= 5:
        raise ApiError(400, "剧情树深度必须是 2 到 5。")
    if not isinstance(branches, int) or not 2 <= branches <= 4:
        raise ApiError(400, "每节点分支数必须是 2 到 4。")
    node_count = sum(branches ** level for level in range(depth))
    if node_count > 160:
        raise ApiError(400, "剧情树节点数超过 160 个安全上限。")

    story = {
        "title": require_string(data, "title", 80),
        "synopsis": require_string(data, "synopsis", 6000),
        "genre": require_string(data, "genre", 80),
        "character": str(data.get("character", ""))[:3000],
        "visual_style": str(data.get("visual_style", ""))[:3000],
        "tree_depth": depth,
        "branch_count": branches,
        "expected_nodes": node_count,
    }
    system_prompt = (
        "你是互动影游编剧兼分镜导演。请严格输出单个 JSON 对象，不要输出 Markdown、代码围栏或解释。"
        "剧情必须形成从起点到多个结局的有向树，每次玩家选择都应造成可感知的剧情差异。"
    )
    user_prompt = (
        "根据下面的项目设定生成完整剧情树。每个非结局节点必须恰好拥有 branch_count 个 choices，"
        "最后一层节点 choices 为空。总节点数应为 expected_nodes。\n"
        f"项目设定：{json.dumps(story, ensure_ascii=False)}\n"
        "返回结构：{\"startKey\":\"n0\",\"scenes\":[{\"key\":\"n0\",\"title\":\"...\","
        "\"shot\":\"大全景|全景|中景|近景|特写\",\"duration\":8,\"action\":\"...\","
        "\"dialogue\":\"...\",\"choices\":[{\"text\":\"...\",\"effect\":\"...\","
        "\"targetKey\":\"n1\"}]}]}。key 必须唯一，targetKey 必须指向 scenes 中存在的 key。"
    )
    return {
        "model": require_model(data, "model", "deepseek-v3"),
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.7,
        "max_tokens": 32767,
        "stream": False,
    }


def build_image_payload(data):
    allowed_sizes = {"1024x1024", "1536x1024", "1024x1536", "auto"}
    size = data.get("size", "1536x1024")
    if size not in allowed_sizes:
        raise ApiError(400, "不支持的图像尺寸。")

    output_format = data.get("output_format", "jpeg")
    quality = data.get("quality", "high")
    if output_format not in {"jpeg", "png"}:
        raise ApiError(400, "不支持的图片格式。")
    if quality not in {"low", "medium", "high"}:
        raise ApiError(400, "不支持的图片质量。")

    reference_url = data.get("reference_image_url", "")
    payload = {
        "model": require_model(data, "image_model", "openai/gpt-image-2/text-to-image"),
        "enable_base64_output": False,
        "enable_sync_mode": False,
        "output_format": output_format,
        "prompt": require_string(data, "prompt"),
        "quality": quality,
        "size": size,
        "moderation": data.get("moderation", "low"),
    }
    if reference_url:
        payload["model"] = require_model(data, "image_edit_model", "openai/gpt-image-2/edit")
        payload["images"] = [resolve_reference_image(require_string(data, "reference_image_url", 10000))]
    return payload


def resolve_reference_image(value):
    if not value.startswith("/projects/"):
        return validate_media_url(value)
    relative = unquote(urlparse(value).path).removeprefix("/projects/")
    target = (PROJECTS_DIR / relative).resolve()
    try:
        target.relative_to(PROJECTS_DIR.resolve())
    except ValueError as exc:
        raise ApiError(400, "无效的本地参考图路径。") from exc
    if not target.is_file():
        raise ApiError(400, "本地参考图不存在，请重新生成或保存。")
    if target.stat().st_size > 25 * 1024 * 1024:
        raise ApiError(413, "本地参考图超过 25MB，无法作为图生图输入。")
    mime_type = mimetypes.guess_type(target.name)[0] or "image/jpeg"
    if mime_type not in {"image/jpeg", "image/png", "image/webp"}:
        raise ApiError(400, "本地参考图必须是 JPEG、PNG 或 WebP。")
    encoded = base64.b64encode(target.read_bytes()).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"


def build_video_payload(data):
    duration = data.get("duration", 8)
    if not isinstance(duration, int) or not 1 <= duration <= 15:
        raise ApiError(400, "视频时长必须是 1 到 15 秒的整数。")

    image_url = require_string(data, "image_url", 200000)
    if not (image_url.startswith("https://") or image_url.startswith("data:image/")):
        raise ApiError(400, "起始图片必须是 HTTPS URL 或图片 data URI。")

    payload = {
        "model": require_model(data, "video_model", "xai/grok-imagine-video-v1.5/image-to-video"),
        "prompt": require_string(data, "prompt"),
        "image_url": image_url,
        "duration": duration,
        "resolution": data.get("resolution", "720p"),
        "aspect_ratio": data.get("aspect_ratio", "16:9"),
    }
    if payload["resolution"] not in {"480p", "720p"}:
        raise ApiError(400, "不支持的视频分辨率。")
    if payload["aspect_ratio"] not in {"16:9", "9:16", "1:1"}:
        raise ApiError(400, "不支持的视频画幅。")
    return payload


def safe_name(value, fallback="item"):
    value = INVALID_FILENAME_RE.sub("-", str(value).strip())
    value = WHITESPACE_RE.sub("-", value).strip(". -")
    value = re.sub(r"-+", "-", value)
    if value.upper() in {"CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "LPT1", "LPT2", "LPT3"}:
        value = f"_{value}"
    return value[:80] or fallback


def is_public_https_url(value):
    if not isinstance(value, str) or len(value) > 10000:
        raise ApiError(400, "无效的素材 URL。")
    parsed = urlparse(value)
    hostname = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or not hostname or parsed.username or parsed.password:
        raise ApiError(400, "素材地址必须是公开的 HTTPS URL。")
    try:
        addresses = {item[4][0] for item in socket.getaddrinfo(hostname, 443, type=socket.SOCK_STREAM)}
    except socket.gaierror as exc:
        raise ApiError(400, "无法解析素材服务器地址。") from exc
    for address in addresses:
        ip = ipaddress.ip_address(address)
        if not ip.is_global:
            raise ApiError(400, "不允许读取本机或内网素材地址。")
    return value


def register_prediction_outputs(result):
    outputs = result.get("data", {}).get("outputs", []) if isinstance(result, dict) else []
    if not isinstance(outputs, list):
        return
    valid = []
    for output in outputs:
        if not isinstance(output, str):
            continue
        try:
            valid.append(is_public_https_url(output))
        except ApiError:
            continue
    with GENERATED_MEDIA_LOCK:
        GENERATED_MEDIA_URLS.update(valid)


def validate_media_url(value, require_registered=True):
    value = is_public_https_url(value)
    hostname = (urlparse(value).hostname or "").lower()
    known_host = (
        hostname == "atlascloud.ai"
        or hostname.endswith(".atlascloud.ai")
        or hostname in KNOWN_MEDIA_HOSTS
    )
    with GENERATED_MEDIA_LOCK:
        generated = value in GENERATED_MEDIA_URLS
    if require_registered and not (known_host or generated):
        raise ApiError(400, "该地址不是当前生成任务返回的素材 URL。请重新查询生成任务后再试。")
    return value


def media_request(url, range_header=None):
    base_headers = {
        "Accept": "*/*",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36",
    }
    if range_header:
        base_headers["Range"] = range_header

    header_variants = [base_headers]
    api_key = os.environ.get("ATLASCLOUD_API_KEY", "").strip()
    if api_key:
        header_variants.append({**base_headers, "Authorization": f"Bearer {api_key}"})
    header_variants.append({**base_headers, "Referer": "https://api.atlascloud.ai/"})
    header_variants.append({**base_headers, "Referer": "https://atlascloud.ai/"})
    header_variants.append({**base_headers, "Referer": "https://www.atlascloud.ai/"})

    response = None
    error_details = None
    for headers in header_variants:
        last_error = None
        for attempt in range(3):
            try:
                response = requests.get(url, headers=headers, stream=True, timeout=(20, 180), allow_redirects=True)
                break
            except (requests.ConnectionError, requests.Timeout) as exc:
                last_error = exc
                response = None
                if attempt < 2:
                    time.sleep(1.0 * (2 ** attempt))
            except requests.RequestException as exc:
                raise ApiError(502, f"无法读取生成素材：{connection_error_message(exc)}") from exc
        if response is None:
            raise ApiError(502, f"多次重试后仍无法读取生成素材：{connection_error_message(last_error)}", {"retryable": True}) from last_error
        if response.status_code in {200, 206}:
            break
        error_details = parse_media_error(response)
        status = response.status_code
        response.close()
        response = None
        if status != 403:
            break

    if response is None:
        message = "素材服务器拒绝访问。"
        if error_details.get("code") in {"NoSuchKey", "InvalidObjectState"}:
            message = "生成素材已失效或被源站删除，请重新生成。"
        elif error_details.get("code") in {"AccessDenied", "RefererDenied"}:
            message = "素材源站拒绝下载，可能是防盗链或临时权限已过期。"
        raise ApiError(502, message, error_details)
    try:
        is_public_https_url(response.url)
    except ApiError:
        response.close()
        raise ApiError(502, "素材地址被重定向到不受信任的站点。")
    return response


def parse_media_error(response):
    status = response.status_code
    raw = response.raw.read(4096, decode_content=True) if response.raw else b""
    text = raw.decode("utf-8", errors="replace").strip()
    details = {"status": status}
    if text:
        try:
            root = ET.fromstring(text)
            details["code"] = root.findtext("Code") or ""
            details["message"] = root.findtext("Message") or ""
            details["requestId"] = root.findtext("RequestId") or ""
        except ET.ParseError:
            details["message"] = text[:500]
    return {key: value for key, value in details.items() if value not in {None, ""}}


def media_extension(content_type, url, kind):
    content_type = (content_type or "").split(";", 1)[0].strip().lower()
    known = {
        "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
        "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
    }
    if content_type in known:
        return known[content_type]
    suffix = Path(urlparse(url).path).suffix.lower()
    if suffix in {".jpg", ".jpeg", ".png", ".webp", ".mp4", ".webm", ".mov"}:
        return ".jpg" if suffix == ".jpeg" else suffix
    return ".jpg" if kind == "image" else ".mp4"


class DirectorHandler(SimpleHTTPRequestHandler):
    server_version = "DirectorWorkbench/0.1"

    def log_message(self, format, *args):
        print(f"[{self.log_date_time_string()}] {format % args}")

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ApiError(400, "无效的 Content-Length。") from exc
        if length <= 0 or length > MAX_BODY_SIZE:
            raise ApiError(400, "请求内容为空或过大。")
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ApiError(400, "请求必须是有效的 JSON。") from exc
        if not isinstance(data, dict):
            raise ApiError(400, "JSON 顶层必须是对象。")
        return data

    def handle_api_error(self, exc):
        payload = {"error": exc.message}
        if exc.details is not None:
            payload["details"] = exc.details
        self.send_json(exc.status, payload)

    def do_GET(self):
        parsed_request = urlparse(self.path)
        try:
            path = unquote(parsed_request.path, errors="strict")
        except UnicodeDecodeError:
            self.send_json(400, {"error": "URL 路径编码无效。"})
            return
        if path.startswith("/projects/"):
            self.serve_project_file(path)
            return
        route, suffix = API_ROUTES.resolve("GET", path)
        if route:
            try:
                getattr(self, route.handler)(parsed_request, suffix)
            except ApiError as exc:
                self.handle_api_error(exc)
            return

        if path.startswith("/api/"):
            self.send_json(404, {"error": "接口不存在。"})
            return

        self.serve_static(path)

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            route, suffix = API_ROUTES.resolve("POST", path)
            if not route:
                self.send_json(404, {"error": "接口不存在。"})
                return
            data = self.read_json()
            getattr(self, route.handler)(data)
        except ApiError as exc:
            self.handle_api_error(exc)

    def api_health(self, parsed_request, suffix):
        self.send_json(200, {
            "ok": True,
            "version": APP_VERSION,
            "keyConfigured": bool(os.environ.get("ATLASCLOUD_API_KEY", "").strip()),
        })

    def api_media(self, parsed_request, suffix):
        query = parse_qs(parsed_request.query)
        url = validate_media_url(query.get("url", [""])[0])
        download = query.get("download", ["0"])[0] == "1"
        filename = safe_name(query.get("filename", ["generated-media"])[0], "generated-media")
        self.proxy_media(url, download, filename)

    def api_prediction(self, parsed_request, prediction_id):
        if not PREDICTION_ID_RE.fullmatch(prediction_id):
            raise ApiError(400, "无效的任务 ID。")
        base_url = require_provider_base_url(
            {"base_url": self.headers.get("X-Provider-Base-Url", "")},
            "base_url",
            ATLAS_MODEL_BASE_URL,
        )
        provider_kind = self.headers.get("X-Provider-Kind", "").strip()
        environment_name = {
            "image": "IMAGE_MODEL_API_KEY",
            "video": "VIDEO_MODEL_API_KEY",
        }.get(provider_kind, "ATLASCLOUD_API_KEY")
        api_key = self.headers.get("X-Provider-Api-Key", "").strip() or os.environ.get(
            environment_name, ""
        ).strip() or os.environ.get("ATLASCLOUD_API_KEY", "").strip()
        result = atlas_request(
            f"prediction/{prediction_id}", base_url=base_url, api_key=api_key,
            provider_name="媒体模型供应商",
        )
        register_prediction_outputs(result)
        self.send_json(200, result)

    def generate_story(self, data):
        payload = build_story_payload(data)
        base_url = require_provider_base_url(data, "text_base_url", ATLAS_LLM_BASE_URL)
        api_key = provider_api_key(data, "text_api_key", "TEXT_MODEL_API_KEY")
        self.send_json(200, atlas_request(
            "chat/completions", "POST", payload, base_url, api_key,
            retry_post=True, provider_name="文本模型供应商", read_timeout=240,
        ))

    def generate_episode(self, data):
        base_url = require_provider_base_url(data, "text_base_url", ATLAS_LLM_BASE_URL)
        api_key = provider_api_key(data, "text_api_key", "TEXT_MODEL_API_KEY")
        prompt = require_string(data, "prompt", 50000)
        payload = {
            "model": require_model(data, "model", "deepseek-v3"),
            "messages": [
                {
                    "role": "system",
                    "content": "你是专业短剧编剧。必须只返回符合用户指定结构的 JSON，不要输出 Markdown 或解释。",
                },
                {"role": "user", "content": prompt},
            ],
            "stream": False,
            "temperature": 0.8,
        }
        self.send_json(200, atlas_request(
            "chat/completions", "POST", payload, base_url, api_key,
            retry_post=True, provider_name="文本模型供应商", read_timeout=240,
        ))

    def test_text_provider(self, data):
        base_url = require_provider_base_url(data, "text_base_url", ATLAS_LLM_BASE_URL)
        api_key = provider_api_key(data, "text_api_key", "TEXT_MODEL_API_KEY")
        payload = {
            "model": require_model(data, "model", "deepseek-v3"),
            "messages": [{"role": "user", "content": "只回复 OK"}],
            "stream": False,
            "max_tokens": 32,
        }
        result = atlas_request(
            "chat/completions", "POST", payload, base_url, api_key,
            retry_post=True, provider_name="文本模型供应商", read_timeout=60,
        )
        content = result.get("choices", [{}])[0].get("message", {}).get("content", "")
        self.send_json(200, {
            "ok": True,
            "model": result.get("model", payload["model"]),
            "preview": str(content)[-120:],
            "version": APP_VERSION,
        })

    def generate_image(self, data):
        base_url = require_provider_base_url(data, "image_base_url", ATLAS_MODEL_BASE_URL)
        api_key = provider_api_key(data, "image_api_key", "IMAGE_MODEL_API_KEY")
        self.send_json(200, atlas_request(
            "generateImage", "POST", build_image_payload(data), base_url, api_key,
            provider_name="文生图供应商",
        ))

    def generate_video(self, data):
        base_url = require_provider_base_url(data, "video_base_url", ATLAS_MODEL_BASE_URL)
        api_key = provider_api_key(data, "video_api_key", "VIDEO_MODEL_API_KEY")
        self.send_json(200, atlas_request(
            "generateVideo", "POST", build_video_payload(data), base_url, api_key,
            provider_name="图生视频供应商",
        ))

    def proxy_media(self, url, download, filename):
        response = media_request(url, self.headers.get("Range"))
        try:
            self.send_response(response.status_code)
            content_type = response.headers.get("Content-Type", "application/octet-stream")
            self.send_header("Content-Type", content_type)
            for name in ("Content-Length", "Content-Range", "Accept-Ranges"):
                if response.headers.get(name):
                    self.send_header(name, response.headers[name])
            self.send_header("Cache-Control", "private, max-age=3600")
            if download:
                extension = media_extension(content_type, url, "video" if content_type.startswith("video/") else "image")
                if not Path(filename).suffix:
                    filename += extension
                encoded = quote(filename, safe="._-")
                self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{encoded}")
            self.end_headers()
            for chunk in response.iter_content(chunk_size=128 * 1024):
                if chunk:
                    self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            response.close()

    def save_asset(self, data):
        url = validate_media_url(require_string(data, "url", 10000))
        kind = data.get("kind")
        if kind not in {"image", "video"}:
            raise ApiError(400, "素材类型必须是 image 或 video。")
        project_name = safe_name(data.get("project_title", "untitled-project"), "untitled-project")
        scene_id = safe_name(data.get("scene_id", "scene"), "scene")
        response = media_request(url)
        try:
            length = int(response.headers.get("Content-Length", "0") or 0)
            if length > MAX_MEDIA_SIZE:
                raise ApiError(413, "素材超过 750MB，未保存。")
            extension = media_extension(response.headers.get("Content-Type"), url, kind)
            target_dir = PROJECTS_DIR / project_name / "assets" / scene_id
            target_dir.mkdir(parents=True, exist_ok=True)
            target = target_dir / f"{kind}{extension}"
            temporary = target.with_suffix(target.suffix + ".part")
            total = 0
            with temporary.open("wb") as output:
                for chunk in response.iter_content(chunk_size=256 * 1024):
                    if not chunk:
                        continue
                    total += len(chunk)
                    if total > MAX_MEDIA_SIZE:
                        raise ApiError(413, "素材超过 750MB，未保存。")
                    output.write(chunk)
            temporary.replace(target)
        except Exception:
            if "temporary" in locals():
                temporary.unlink(missing_ok=True)
            raise
        finally:
            response.close()
        relative = target.relative_to(ROOT).as_posix()
        self.send_json(200, {"ok": True, "localUrl": f"/{relative}", "path": str(target)})

    def save_project(self, data):
        project = data.get("project")
        has_legacy_scenes = isinstance(project, dict) and isinstance(project.get("scenes"), list)
        has_interactive_scenes = isinstance(project, dict) and isinstance(project.get("interactive"), dict) and isinstance(project["interactive"].get("scenes"), list)
        has_episodes = isinstance(project, dict) and isinstance(project.get("episodes"), list)
        if not isinstance(project, dict) or not (has_legacy_scenes or has_interactive_scenes or has_episodes):
            raise ApiError(400, "无效的项目数据。")
        title = project.get("meta", {}).get("title", "untitled-project") if isinstance(project.get("meta"), dict) else "untitled-project"
        project_dir = PROJECTS_DIR / safe_name(title, "untitled-project")
        project_dir.mkdir(parents=True, exist_ok=True)
        target = project_dir / "project.json"
        temporary = project_dir / "project.json.part"
        temporary.write_text(json.dumps(project, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(target)
        self.send_json(200, {"ok": True, "path": str(target)})

    def export_player(self, data):
        project = data.get("project")
        if isinstance(project, dict) and isinstance(project.get("meta"), dict) and project["meta"].get("mode") == "serial":
            raise ApiError(400, "AI 短剧不能导出互动试玩包，请使用分集成片导出。")
        try:
            result = build_player_package(project, ROOT, PROJECTS_DIR, PLAYER_DIR)
        except (ValueError, FileNotFoundError) as exc:
            raise ApiError(400, str(exc)) from exc
        except OSError as exc:
            raise ApiError(500, f"生成试玩包失败：{exc}") from exc
        relative = result["path"].relative_to(PROJECTS_DIR).as_posix()
        self.send_json(200, {
            "ok": True,
            "path": str(result["path"]),
            "downloadUrl": f"/projects/{quote(relative, safe='/')}",
            "warnings": result["warnings"],
            "sceneCount": result["sceneCount"],
            "assetCount": result["assetCount"],
        })

    def export_serial(self, data):
        project = data.get("project")
        try:
            result = build_serial_package(project, ROOT, PROJECTS_DIR, data.get("episode_id"))
        except (ValueError, FileNotFoundError) as exc:
            raise ApiError(400, str(exc)) from exc
        except (OSError, RuntimeError) as exc:
            raise ApiError(500, f"生成短剧分集成片失败：{exc}") from exc
        relative = result["path"].relative_to(PROJECTS_DIR).as_posix()
        self.send_json(200, {
            "ok": True,
            "path": str(result["path"]),
            "downloadUrl": f"/projects/{quote(relative, safe='/')}",
            "episodeCount": result["episodeCount"],
            "episodeTitle": result.get("episodeTitle", ""),
            "sceneCount": result["sceneCount"],
        })

    def delete_asset(self, data):
        kind = data.get("kind")
        if kind not in {"image", "video"}:
            raise ApiError(400, "素材类型必须是 image 或 video。")
        project_name = safe_name(data.get("project_title", "untitled-project"), "untitled-project")
        scene_id = safe_name(data.get("scene_id", "scene"), "scene")
        target_dir = (PROJECTS_DIR / project_name / "assets" / scene_id).resolve()
        try:
            target_dir.relative_to(PROJECTS_DIR.resolve())
        except ValueError:
            raise ApiError(400, "无效的素材路径。")
        deleted = []
        if target_dir.is_dir():
            for target in target_dir.glob(f"{kind}.*"):
                if target.is_file() and not target.name.endswith(".part"):
                    target.unlink()
                    deleted.append(str(target))
            for temporary in target_dir.glob(f"{kind}.*.part"):
                temporary.unlink(missing_ok=True)
        self.send_json(200, {"ok": True, "deleted": deleted})

    def open_folder(self, data):
        project_name = safe_name(data.get("project_title", "untitled-project"), "untitled-project")
        scene_id = data.get("scene_id", "")
        target = PROJECTS_DIR / project_name
        if scene_id:
            target = target / "assets" / safe_name(scene_id, "scene")
        target = target.resolve()
        try:
            target.relative_to(PROJECTS_DIR.resolve())
        except ValueError:
            raise ApiError(400, "无效的文件夹路径。")
        target.mkdir(parents=True, exist_ok=True)
        try:
            subprocess.Popen(["explorer", str(target)], close_fds=True)
        except OSError as exc:
            raise ApiError(500, f"无法打开文件夹：{exc}") from exc
        self.send_json(200, {"ok": True, "path": str(target)})

    def serve_project_file(self, path):
        relative = path.removeprefix("/projects/")
        target = (PROJECTS_DIR / relative).resolve()
        try:
            target.relative_to(PROJECTS_DIR.resolve())
        except ValueError:
            self.send_error(403)
            return
        if not target.is_file():
            self.send_error(404)
            return
        file_size = target.stat().st_size
        start, end = 0, file_size - 1
        range_header = self.headers.get("Range", "")
        if range_header:
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header.strip())
            if not match:
                self.send_error(416)
                return
            if match.group(1):
                start = int(match.group(1))
                end = int(match.group(2)) if match.group(2) else end
            elif match.group(2):
                length = int(match.group(2))
                start = max(0, file_size - length)
            if start >= file_size or start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{file_size}")
                self.end_headers()
                return
            end = min(end, file_size - 1)
        content_length = end - start + 1
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        self.send_response(206 if range_header else 200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(content_length))
        self.send_header("Accept-Ranges", "bytes")
        if range_header:
            self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            with target.open("rb") as source:
                source.seek(start)
                remaining = content_length
                while remaining > 0:
                    chunk = source.read(min(128 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            # Browsers routinely cancel an old Range request when seeking,
            # switching scenes, or reloading the video element.
            pass

    def serve_file(self, target, cache_control="no-cache"):
        if not target.is_file():
            self.send_error(404)
            return
        content = target.read_bytes()
        mime_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", f"{mime_type}; charset=utf-8" if mime_type.startswith("text/") or mime_type == "application/javascript" else mime_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", cache_control)
        self.end_headers()
        self.wfile.write(content)

    def serve_static(self, path):
        relative = "index.html" if path == "/" else path.lstrip("/")
        target = (STATIC_DIR / relative).resolve()
        try:
            target.relative_to(STATIC_DIR.resolve())
        except ValueError:
            self.send_error(403)
            return
        self.serve_file(target)


def main():
    host = os.environ.get("DIRECTOR_HOST", "127.0.0.1")
    port = int(os.environ.get("DIRECTOR_PORT", "8000"))
    server = ThreadingHTTPServer((host, port), DirectorHandler)
    print(f"Narrative Forge（叙事锻造工坊）：http://{host}:{port}")
    print("默认模型密钥：" + ("已配置" if os.environ.get("ATLASCLOUD_API_KEY") else "未配置"))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n工作台已停止。")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

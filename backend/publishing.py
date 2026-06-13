import json
import re
import zipfile
from pathlib import Path
from urllib.parse import unquote, urlparse


INVALID_NAME_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]+')
VIDEO_EXTENSIONS = {".mp4", ".webm", ".mov", ".m4v"}


def release_name(value, fallback="narrative-forge-game"):
    cleaned = INVALID_NAME_RE.sub("-", str(value or "").strip())
    cleaned = re.sub(r"\s+", "-", cleaned).strip(". -")
    if cleaned.upper() in {"CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "LPT1", "LPT2", "LPT3"}:
        cleaned = f"_{cleaned}"
    return cleaned[:80] or fallback


def _validate_public_project(project):
    scenes = project["scenes"]
    if not scenes:
        raise ValueError("项目没有可发布的剧情节点。")
    scene_ids = [scene["id"] for scene in scenes]
    if len(set(scene_ids)) != len(scene_ids):
        raise ValueError("项目存在重复的剧情节点 ID。")
    valid_ids = set(scene_ids)
    if project["startSceneId"] not in valid_ids:
        raise ValueError("项目没有有效的试玩起点。")
    for scene in scenes:
        targets = [choice["targetSceneId"] for choice in scene["choices"]]
        if not targets and scene["nextSceneId"]:
            targets.append(scene["nextSceneId"])
        for target in targets:
            if target not in valid_ids:
                raise ValueError(f"“{scene['title']}”指向不存在的剧情节点。")


def _project_asset_from_url(local_url, root, project_dir):
    if not isinstance(local_url, str) or not local_url.startswith("/projects/"):
        return None
    relative = unquote(urlparse(local_url).path).removeprefix("/")
    candidate = (root / relative).resolve()
    try:
        candidate.relative_to(project_dir.resolve())
    except ValueError:
        return None
    return candidate if candidate.is_file() else None


def _find_asset(scene, kind, root, project_dir):
    local = _project_asset_from_url(scene.get(f"{kind}LocalUrl", ""), root, project_dir)
    if local:
        return local
    scene_dir = project_dir / "assets" / release_name(scene.get("id"), "scene")
    if not scene_dir.is_dir():
        return None
    candidates = sorted(
        path for path in scene_dir.glob(f"{kind}.*")
        if path.is_file() and not path.name.endswith(".part")
    )
    return candidates[0] if candidates else None


def _public_project(project, root, project_dir):
    meta = project.get("meta") if isinstance(project.get("meta"), dict) else {}
    mode = str(meta.get("mode") or "interactive")
    public_episodes = []
    if mode == "serial" and isinstance(project.get("episodes"), list):
        scenes = []
        episodes = sorted(
            (episode for episode in project["episodes"] if isinstance(episode, dict)),
            key=lambda episode: int(episode.get("order", 0)),
        )
        for episode_index, episode in enumerate(episodes):
            episode_meta = episode.get("meta") if isinstance(episode.get("meta"), dict) else {}
            public_episodes.append({
                "id": str(episode.get("id") or f"episode-{episode_index + 1}"),
                "order": episode_index,
                "title": str(episode_meta.get("title") or f"第{episode_index + 1}集"),
                "synopsis": str(episode_meta.get("synopsis") or ""),
            })
            episode_scenes = episode.get("scenes") if isinstance(episode.get("scenes"), list) else []
            for scene_index, scene in enumerate(sorted(
                (item for item in episode_scenes if isinstance(item, dict)),
                key=lambda item: int(item.get("episodeOrder", item.get("order", 0))),
            )):
                scenes.append({**scene, "episode": episode_index + 1, "episodeOrder": scene_index + 1})
    elif isinstance(project.get("interactive"), dict) and isinstance(project["interactive"].get("scenes"), list):
        scenes = project["interactive"]["scenes"]
    else:
        scenes = project.get("scenes") if isinstance(project.get("scenes"), list) else []
    public_scenes = []
    assets = []
    warnings = []

    for index, source in enumerate(scenes):
        if not isinstance(source, dict):
            continue
        scene_id = str(source.get("id") or f"scene-{index + 1}")
        scene = {
            "id": scene_id,
            "order": int(source.get("order", index)) if str(source.get("order", index)).lstrip("-").isdigit() else index,
            "title": str(source.get("title") or f"剧情节点 {index + 1}"),
            "action": str(source.get("action") or ""),
            "dialogue": str(source.get("dialogue") or ""),
            "episode": int(source.get("episode", 1)) if str(source.get("episode", 1)).isdigit() else 1,
            "episodeOrder": int(source.get("episodeOrder", index + 1)) if str(source.get("episodeOrder", index + 1)).isdigit() else index + 1,
            "nextSceneId": str(source.get("nextSceneId") or ""),
            "choices": [],
            "image": "",
            "video": "",
        }
        for choice in source.get("choices", []) if isinstance(source.get("choices"), list) else []:
            if not isinstance(choice, dict):
                continue
            scene["choices"].append({
                "text": str(choice.get("text") or "未命名选择"),
                "effect": str(choice.get("effect") or ""),
                "targetSceneId": str(choice.get("targetSceneId") or ""),
            })

        for kind in ("image", "video"):
            source_path = _find_asset(source, kind, root, project_dir)
            if source_path:
                arcname = f"assets/{release_name(scene_id, f'scene-{index + 1}')}/{kind}{source_path.suffix.lower()}"
                scene[kind] = arcname
                assets.append((source_path, arcname))
            elif source.get(f"{kind}Url") or source.get(f"{kind}LocalUrl"):
                warnings.append(f"“{scene['title']}”缺少可打包的本地{('图片' if kind == 'image' else '视频')}素材。")
        public_scenes.append(scene)

    if mode == "serial":
        public_scenes.sort(key=lambda item: (item["episode"], item["episodeOrder"]))
        for index, scene in enumerate(public_scenes):
            scene["order"] = index
            scene["choices"] = []
            scene["nextSceneId"] = public_scenes[index + 1]["id"] if index + 1 < len(public_scenes) else ""
        start_scene_id = public_scenes[0]["id"] if public_scenes else ""
    else:
        public_scenes.sort(key=lambda item: item["order"])
        interactive = project.get("interactive") if isinstance(project.get("interactive"), dict) else project
        start_scene_id = str(interactive.get("startSceneId") or (public_scenes[0]["id"] if public_scenes else ""))
    return {
        "format": "frameforge-player-release",
        "version": 1,
        "meta": {
            "title": str(meta.get("title") or "未命名互动影游"),
            "synopsis": str(meta.get("synopsis") or ""),
            "genre": str(meta.get("genre") or ""),
            "aspectRatio": str(meta.get("aspectRatio") or "16:9"),
            "mode": mode,
        },
        "startSceneId": start_scene_id,
        "scenes": public_scenes,
        "episodes": public_episodes,
    }, assets, warnings


def build_player_package(project, root, projects_dir, player_dir):
    has_legacy = isinstance(project, dict) and isinstance(project.get("scenes"), list)
    has_interactive = isinstance(project, dict) and isinstance(project.get("interactive"), dict) and isinstance(project["interactive"].get("scenes"), list)
    has_episodes = isinstance(project, dict) and isinstance(project.get("episodes"), list)
    if not isinstance(project, dict) or not (has_legacy or has_interactive or has_episodes):
        raise ValueError("无效的项目数据。")
    title = project.get("meta", {}).get("title", "narrative-forge-game") if isinstance(project.get("meta"), dict) else "narrative-forge-game"
    project_dir = projects_dir / release_name(title, "narrative-forge-game")
    export_dir = project_dir / "exports"
    export_dir.mkdir(parents=True, exist_ok=True)
    package_name = f"{release_name(title)}-试玩包.zip"
    target = export_dir / package_name
    temporary = target.with_suffix(target.suffix + ".part")
    public_project, assets, warnings = _public_project(project, root, project_dir)
    _validate_public_project(public_project)

    required_runtime = ("index.html", "player.css", "player.js")
    for filename in required_runtime:
        if not (player_dir / filename).is_file():
            raise FileNotFoundError(f"缺少试玩运行时文件：{filename}")
    logo_path = root / "static" / "logo.png"
    if not logo_path.is_file():
        raise FileNotFoundError("缺少项目 Logo：static/logo.png")

    try:
        with zipfile.ZipFile(temporary, "w", allowZip64=True) as archive:
            for filename in required_runtime:
                archive.write(player_dir / filename, filename, compress_type=zipfile.ZIP_DEFLATED)
            archive.write(logo_path, "logo.png", compress_type=zipfile.ZIP_DEFLATED)
            project_json = json.dumps(public_project, ensure_ascii=False, separators=(",", ":"))
            project_json = project_json.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
            archive.writestr(
                "project-data.js",
                f"window.FRAMEFORGE_PROJECT={project_json};\n",
                compress_type=zipfile.ZIP_DEFLATED,
            )
            archive.writestr(
                "release.json",
                json.dumps(public_project, ensure_ascii=False, indent=2),
                compress_type=zipfile.ZIP_DEFLATED,
            )
            archive.writestr(
                "使用说明.txt",
                "Narrative Forge（叙事锻造工坊）互动影游试玩包\n\n解压全部文件后，双击 index.html 开始试玩。\n请勿单独移动 index.html，assets 文件夹必须保持相对位置。\n",
                compress_type=zipfile.ZIP_DEFLATED,
            )
            for source, arcname in assets:
                compression = zipfile.ZIP_STORED if source.suffix.lower() in VIDEO_EXTENSIONS else zipfile.ZIP_DEFLATED
                archive.write(source, arcname, compress_type=compression)
        temporary.replace(target)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise

    return {
        "path": target,
        "project_dir": project_dir,
        "warnings": warnings,
        "sceneCount": len(public_project["scenes"]),
        "assetCount": len(assets),
    }

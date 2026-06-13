import json
import shutil
import subprocess
import zipfile
from pathlib import Path
from urllib.parse import unquote, urlparse

from .publishing import release_name


VIDEO_EXTENSIONS = {".mp4", ".webm", ".mov", ".m4v"}


def _project_video_from_url(local_url, root, projects_dir):
    if not isinstance(local_url, str) or not local_url.startswith("/projects/"):
        return None
    relative = unquote(urlparse(local_url).path).removeprefix("/")
    candidate = (root / relative).resolve()
    try:
        candidate.relative_to(projects_dir.resolve())
    except ValueError:
        return None
    return candidate if candidate.is_file() and candidate.suffix.lower() in VIDEO_EXTENSIONS else None


def _find_scene_video(scene, root, projects_dir, project_dir):
    local = _project_video_from_url(scene.get("videoLocalUrl", ""), root, projects_dir)
    if local:
        return local
    scene_dir = project_dir / "assets" / release_name(scene.get("id"), "scene")
    if not scene_dir.is_dir():
        return None
    candidates = sorted(
        path for path in scene_dir.glob("video.*")
        if path.is_file() and path.suffix.lower() in VIDEO_EXTENSIONS and not path.name.endswith(".part")
    )
    return candidates[0] if candidates else None


def _probe_video(ffmpeg, video):
    ffprobe_path = Path(ffmpeg).with_name("ffprobe.exe" if Path(ffmpeg).suffix.lower() == ".exe" else "ffprobe")
    ffprobe = str(ffprobe_path) if ffprobe_path.is_file() else shutil.which("ffprobe")
    if not ffprobe:
        raise FileNotFoundError("未找到 ffprobe，无法分析镜头视频。")
    completed = subprocess.run(
        [ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(video)],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60, check=False,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if completed.returncode != 0:
        raise RuntimeError(f"无法读取镜头视频信息：{(completed.stderr or '').strip()[-800:]}")
    payload = json.loads(completed.stdout or "{}")
    streams = payload.get("streams") or []
    video_stream = next((stream for stream in streams if stream.get("codec_type") == "video"), None)
    if not video_stream:
        raise RuntimeError(f"镜头文件没有视频流：{video.name}")
    duration = float(payload.get("format", {}).get("duration") or video_stream.get("duration") or 0)
    if duration <= 0:
        raise RuntimeError(f"无法确定镜头时长：{video.name}")
    return {
        "duration": duration,
        "width": int(video_stream.get("width") or 0),
        "height": int(video_stream.get("height") or 0),
        "has_audio": any(stream.get("codec_type") == "audio" for stream in streams),
    }


def _transition_duration(value, clip_duration):
    duration = {"cut": 0.0, "match": 0.0, "dissolve": 0.20, "fade": 0.40}.get(value, 0.0)
    return max(0.0, min(duration, clip_duration / 4))


def _normalize_clip(ffmpeg, source, target, info, width, height, fade_in=0.0, fade_out=0.0):
    command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(source)]
    audio_input = "0:a:0"
    if not info["has_audio"]:
        command.extend(["-f", "lavfi", "-t", f"{info['duration']:.4f}", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"])
        audio_input = "1:a:0"
    video_filters = [
        f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p"
    ]
    audio_filters = ["aresample=48000:async=1:first_pts=0"]
    if fade_in > 0:
        video_filters.append(f"fade=t=in:st=0:d={fade_in:.3f}")
        audio_filters.append(f"afade=t=in:st=0:d={fade_in:.3f}")
    if fade_out > 0:
        start = max(0, info["duration"] - fade_out)
        video_filters.append(f"fade=t=out:st={start:.3f}:d={fade_out:.3f}")
        audio_filters.append(f"afade=t=out:st={start:.3f}:d={fade_out:.3f}")
    command.extend([
        "-map", "0:v:0", "-map", audio_input, "-vf", ",".join(video_filters),
        "-af", ",".join(audio_filters), "-t", f"{info['duration']:.4f}",
        "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-c:a", "aac", "-b:a", "192k",
        str(target),
    ])
    completed = subprocess.run(
        command, capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=30 * 60, check=False, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if completed.returncode != 0 or not target.is_file():
        raise RuntimeError(f"镜头标准化失败：{(completed.stderr or completed.stdout or '').strip()[-1200:]}")


def _concat_episode(ffmpeg, videos, target, working_dir, transitions=None):
    temporary = target.with_name(f".{target.stem}.part.mp4")
    normalize_dir = working_dir / f".{target.stem}-segments"
    list_file = working_dir / f".{target.stem}-concat.txt"
    shutil.rmtree(normalize_dir, ignore_errors=True)
    normalize_dir.mkdir(parents=True, exist_ok=True)
    temporary.unlink(missing_ok=True)
    try:
        infos = [_probe_video(ffmpeg, video) for video in videos]
        width = max(2, infos[0]["width"] // 2 * 2)
        height = max(2, infos[0]["height"] // 2 * 2)
        normalized = []
        transitions = transitions or []
        for index, (video, info) in enumerate(zip(videos, infos)):
            segment = normalize_dir / f"segment-{index:03d}.mp4"
            fade_in = _transition_duration(transitions[index] if index < len(transitions) else "match", info["duration"])
            next_transition = transitions[index + 1] if index + 1 < len(transitions) else "cut"
            fade_out = _transition_duration(next_transition, info["duration"])
            _normalize_clip(ffmpeg, video, segment, info, width, height, fade_in, fade_out)
            normalized.append(segment)
        list_file.write_text("".join(f"file '{segment.resolve().as_posix()}'\n" for segment in normalized), encoding="utf-8")
        command = [
            ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-fflags", "+genpts",
            "-f", "concat", "-safe", "0", "-i", str(list_file), "-map", "0:v:0", "-map", "0:a:0",
            "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-c:a", "aac", "-b:a", "192k",
            "-movflags", "+faststart", str(temporary),
        ]
        completed = subprocess.run(
            command, capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=60 * 60, check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if completed.returncode != 0 or not temporary.is_file():
            details = (completed.stderr or completed.stdout or "未知 ffmpeg 错误").strip()[-1600:]
            raise RuntimeError(f"ffmpeg 拼接失败：{details}")
        temporary.replace(target)
    finally:
        list_file.unlink(missing_ok=True)
        shutil.rmtree(normalize_dir, ignore_errors=True)
        temporary.unlink(missing_ok=True)


def build_serial_package(project, root, projects_dir, episode_id=None):
    if not isinstance(project, dict):
        raise ValueError("无效的短剧项目数据。")
    meta = project.get("meta") if isinstance(project.get("meta"), dict) else {}
    if meta.get("mode") != "serial":
        raise ValueError("只有 AI 短剧项目可以导出分集成片。")
    episodes = project.get("episodes") if isinstance(project.get("episodes"), list) else []
    episodes = sorted((item for item in episodes if isinstance(item, dict)), key=lambda item: int(item.get("order", 0)))
    if not episodes:
        raise ValueError("短剧项目没有可导出的分集。")
    indexed_episodes = list(enumerate(episodes, 1))
    if episode_id:
        indexed_episodes = [(index, episode) for index, episode in indexed_episodes if str(episode.get("id") or "") == str(episode_id)]
        if not indexed_episodes:
            raise ValueError("找不到当前选中的分集，请重新选择后再导出。")
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise FileNotFoundError("未找到 ffmpeg，无法拼接短剧视频。")

    title = str(meta.get("title") or "narrative-forge-serial")
    project_dir = projects_dir / release_name(title, "narrative-forge-serial")
    export_dir = project_dir / "exports"
    export_dir.mkdir(parents=True, exist_ok=True)
    episode_outputs = []
    total_scenes = 0

    episode_titles = []
    for episode_index, episode in indexed_episodes:
        episode_meta = episode.get("meta") if isinstance(episode.get("meta"), dict) else {}
        scenes = episode.get("scenes") if isinstance(episode.get("scenes"), list) else []
        scenes = sorted((item for item in scenes if isinstance(item, dict)), key=lambda item: int(item.get("episodeOrder", item.get("order", 0))))
        if not scenes:
            raise ValueError(f"第{episode_index}集没有镜头，无法导出。")
        videos = []
        missing = []
        for scene_index, scene in enumerate(scenes, 1):
            video = _find_scene_video(scene, root, projects_dir, project_dir)
            if video:
                videos.append(video)
            else:
                missing.append(f"第{scene_index}镜“{scene.get('title') or '未命名'}”")
        if missing:
            raise ValueError(f"第{episode_index}集缺少本地视频：{'、'.join(missing[:6])}{'……' if len(missing) > 6 else ''}")
        episode_title = release_name(episode_meta.get("title"), f"第{episode_index:02d}集")
        target = export_dir / f"{release_name(title)}-第{episode_index:02d}集-{episode_title}.mp4"
        transitions = [str(scene.get("transition") or ("cut" if index == 0 else "match")) for index, scene in enumerate(scenes)]
        _concat_episode(ffmpeg, videos, target, export_dir, transitions)
        episode_outputs.append(target)
        episode_titles.append(str(episode_meta.get("title") or f"第{episode_index}集"))
        total_scenes += len(scenes)

    if episode_id:
        return {
            "path": episode_outputs[0],
            "episodes": episode_outputs,
            "episodeCount": 1,
            "episodeTitle": episode_titles[0],
            "sceneCount": total_scenes,
        }

    package = export_dir / f"{release_name(title)}-分集成片.zip"
    temporary_zip = package.with_suffix(package.suffix + ".part")
    try:
        with zipfile.ZipFile(temporary_zip, "w", allowZip64=True) as archive:
            for output in episode_outputs:
                archive.write(output, output.name, compress_type=zipfile.ZIP_STORED)
        temporary_zip.replace(package)
    finally:
        temporary_zip.unlink(missing_ok=True)

    return {
        "path": package,
        "episodes": episode_outputs,
        "episodeCount": len(episode_outputs),
        "episodeTitle": "",
        "sceneCount": total_scenes,
    }

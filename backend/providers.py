"""多供应商图像 / 视频生成适配器层（纯逻辑，不直接发起网络请求）。

设计目标：把不同供应商各异的协议，统一归一化成前端已经依赖的契约：
  - 提交任务  → {"data": {"id": "<task_id>"}}
  - 轮询任务  → {"data": {"status": "<succeeded|failed|processing...>", "outputs": ["<url>"...], "error": "..."}}

app.py 负责真正的 HTTP（复用其重试 / 错误分类），本模块只负责：
  - 构造各供应商的请求体（submit_spec / probe_spec）
  - 从各供应商的响应里抽取 task_id / 产物 URL / 状态（read_* / normalize_poll）

新增一家供应商 = 在这里实现一个 Adapter 子类并注册，无需改动 app.py 的核心流程。
"""

from urllib.parse import urlparse


class ProviderError(Exception):
    """供应商配置 / 响应解析错误。app.py 会捕获并转换为面向用户的 ApiError。"""

    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


# 内部统一尺寸 → 各供应商尺寸格式映射
def _aspect_of(size):
    if size in ("1024x1536", "720x1280"):
        return "portrait"
    if size in ("1536x1024", "1280x720"):
        return "landscape"
    return "square"


def _first_url(value):
    """从任意嵌套结构里捞出第一个 https 链接。"""
    if isinstance(value, str) and value.startswith("http"):
        return value
    if isinstance(value, dict):
        for item in value.values():
            found = _first_url(item)
            if found:
                return found
    if isinstance(value, list):
        for item in value:
            found = _first_url(item)
            if found:
                return found
    return None


def _normalize_status(raw):
    """把各家任务状态归一为前端识别的取值。前端把 completed/succeeded 视为完成。"""
    text = str(raw or "").lower()
    if text in {"succeeded", "success", "completed", "complete", "done", "finished"}:
        return "succeeded"
    if text in {"failed", "error", "cancelled", "canceled", "expired"}:
        return "failed"
    return "processing"


class BaseAdapter:
    name = "base"
    kind = "image"            # image | video
    label = "供应商"
    synchronous = False       # True 表示提交即同步返回产物（无任务 id）
    default_base_url = ""
    default_model = ""
    default_edit_model = ""   # 仅图像、且支持参考图编辑时使用

    # —— 提交 ——
    def submit_spec(self, params):
        """返回 {method, path, json, extra_headers}。params 为 app 校验后的通用参数。"""
        raise NotImplementedError

    def read_submit(self, resp):
        """异步：返回 task_id 字符串。"""
        raise NotImplementedError

    def read_outputs(self, resp):
        """同步：返回产物 URL 列表。"""
        raise NotImplementedError

    # —— 轮询 ——
    def poll_path(self, task_id):
        raise NotImplementedError

    def normalize_poll(self, resp):
        """返回 {status, outputs, error}。"""
        raise NotImplementedError

    # —— 测试连接（零成本：仅校验连通 + 鉴权）——
    def probe_spec(self):
        """返回 {method, path, json, extra_headers}。app 发起后：401/403 视为鉴权失败，
        其余任何可达的 HTTP 响应（含 400/404）视为连通且鉴权通过。"""
        raise NotImplementedError


# ─────────────────────────────────────────────
#  AtlasCloud（默认，异步 generateImage / generateVideo / prediction）
# ─────────────────────────────────────────────
class AtlasCloudImageAdapter(BaseAdapter):
    name = "atlascloud"
    kind = "image"
    label = "AtlasCloud"
    default_base_url = "https://api.atlascloud.ai/api/v1/model"
    default_model = "openai/gpt-image-2/text-to-image"
    default_edit_model = "openai/gpt-image-2/edit"

    def submit_spec(self, params):
        payload = {
            "model": params["model"],
            "enable_base64_output": False,
            "enable_sync_mode": False,
            "output_format": params["output_format"],
            "prompt": params["prompt"],
            "quality": params["quality"],
            "size": params["size"],
            "moderation": params.get("moderation", "low"),
        }
        ref_images = params.get("reference_images") or ([params["reference_image"]] if params.get("reference_image") else [])
        if ref_images:
            payload["model"] = params.get("edit_model") or self.default_edit_model
            payload["images"] = ref_images
        return {"method": "POST", "path": "generateImage", "json": payload, "extra_headers": {}}

    def read_submit(self, resp):
        task_id = (resp or {}).get("data", {}).get("id")
        if not task_id:
            raise ProviderError("AtlasCloud 未返回任务 ID。", 502)
        return task_id

    def poll_path(self, task_id):
        return f"prediction/{task_id}"

    def normalize_poll(self, resp):
        data = (resp or {}).get("data", {}) if isinstance(resp, dict) else {}
        outputs = [u for u in (data.get("outputs") or []) if isinstance(u, str)]
        return {"status": _normalize_status(data.get("status")), "outputs": outputs, "error": data.get("error")}

    def probe_spec(self):
        # 任意任务 id 查询：401/403 → 鉴权失败；404 → 连通且鉴权 OK，零成本
        return {"method": "GET", "path": "prediction/connectivity-check", "json": None, "extra_headers": {}}


class AtlasCloudVideoAdapter(AtlasCloudImageAdapter):
    kind = "video"
    default_model = "xai/grok-imagine-video-v1.5/image-to-video"
    default_edit_model = ""

    def submit_spec(self, params):
        payload = {
            "model": params["model"],
            "prompt": params["prompt"],
            "image_url": params["image_url"],
            "duration": params["duration"],
            "resolution": params.get("resolution", "720p"),
            "aspect_ratio": params.get("aspect_ratio", "16:9"),
        }
        return {"method": "POST", "path": "generateVideo", "json": payload, "extra_headers": {}}


# ─────────────────────────────────────────────
#  OpenAI 兼容图像（同步 POST /images/generations）
# ─────────────────────────────────────────────
class OpenAIImageAdapter(BaseAdapter):
    name = "openai"
    kind = "image"
    label = "OpenAI 兼容"
    synchronous = True
    default_base_url = "https://api.openai.com/v1"
    default_model = "dall-e-3"
    default_edit_model = ""

    _SIZE_MAP = {"landscape": "1792x1024", "portrait": "1024x1792", "square": "1024x1024"}

    def submit_spec(self, params):
        payload = {
            "model": params["model"],
            "prompt": params["prompt"],
            "n": 1,
            "size": self._SIZE_MAP[_aspect_of(params["size"])],
            "response_format": "url",
        }
        return {"method": "POST", "path": "images/generations", "json": payload, "extra_headers": {}}

    def read_outputs(self, resp):
        items = (resp or {}).get("data", []) if isinstance(resp, dict) else []
        urls = []
        for item in items:
            if isinstance(item, dict) and isinstance(item.get("url"), str):
                urls.append(item["url"])
        if not urls:
            # 仅返回 b64 的供应商（如 gpt-image-1）暂不支持，给出明确提示
            if any(isinstance(i, dict) and i.get("b64_json") for i in items):
                raise ProviderError(
                    "该 OpenAI 兼容供应商仅返回 base64 图像，当前未支持。请改用返回 url 的模型（如 dall-e-3），或选择其他供应商。",
                    502,
                )
            raise ProviderError("OpenAI 兼容供应商未返回图像 URL。", 502)
        return urls

    def probe_spec(self):
        return {"method": "GET", "path": "models", "json": None, "extra_headers": {}}


# ─────────────────────────────────────────────
#  阿里云百炼 通义万相（异步：提交→ /tasks/{id} 轮询）
#  图像与视频共用同一 host，base_url 形如 https://dashscope.aliyuncs.com
# ─────────────────────────────────────────────
class DashScopeImageAdapter(BaseAdapter):
    name = "dashscope"
    kind = "image"
    label = "阿里通义万相"
    default_base_url = "https://dashscope.aliyuncs.com"
    default_model = "wan2.2-t2i-flash"
    default_edit_model = ""

    _SIZE_MAP = {"landscape": "1280*720", "portrait": "720*1280", "square": "1024*1024"}

    def submit_spec(self, params):
        payload = {
            "model": params["model"],
            "input": {"prompt": params["prompt"]},
            "parameters": {"size": self._SIZE_MAP[_aspect_of(params["size"])], "n": 1},
        }
        return {
            "method": "POST",
            "path": "api/v1/services/aigc/text2image/image-synthesis",
            "json": payload,
            "extra_headers": {"X-DashScope-Async": "enable"},
        }

    def read_submit(self, resp):
        task_id = (resp or {}).get("output", {}).get("task_id")
        if not task_id:
            raise ProviderError("通义万相未返回 task_id。", 502)
        return task_id

    def poll_path(self, task_id):
        return f"api/v1/tasks/{task_id}"

    def normalize_poll(self, resp):
        output = (resp or {}).get("output", {}) if isinstance(resp, dict) else {}
        status = _normalize_status(output.get("task_status"))
        outputs = []
        for result in output.get("results", []) or []:
            url = result.get("url") if isinstance(result, dict) else None
            if isinstance(url, str):
                outputs.append(url)
        if not outputs:
            found = _first_url(output)
            if found:
                outputs.append(found)
        return {"status": status, "outputs": outputs, "error": output.get("message") or (resp or {}).get("message")}

    def probe_spec(self):
        return {"method": "GET", "path": "api/v1/tasks/connectivity-check", "json": None, "extra_headers": {}}


class DashScopeVideoAdapter(DashScopeImageAdapter):
    kind = "video"
    default_model = "wan2.2-i2v-flash"

    def submit_spec(self, params):
        payload = {
            "model": params["model"],
            "input": {"prompt": params["prompt"], "img_url": params["image_url"]},
            "parameters": {"resolution": params.get("resolution", "720P").upper().replace("P", "P")},
        }
        return {
            "method": "POST",
            "path": "api/v1/services/aigc/video-generation/video-synthesis",
            "json": payload,
            "extra_headers": {"X-DashScope-Async": "enable"},
        }

    def normalize_poll(self, resp):
        output = (resp or {}).get("output", {}) if isinstance(resp, dict) else {}
        status = _normalize_status(output.get("task_status"))
        outputs = []
        video_url = output.get("video_url")
        if isinstance(video_url, str):
            outputs.append(video_url)
        if not outputs:
            found = _first_url(output)
            if found:
                outputs.append(found)
        return {"status": status, "outputs": outputs, "error": output.get("message") or (resp or {}).get("message")}


# ─────────────────────────────────────────────
#  火山方舟 Seedance（异步：/contents/generations/tasks）
#  base_url 形如 https://ark.cn-beijing.volces.com/api/v3
# ─────────────────────────────────────────────
class SeedanceVideoAdapter(BaseAdapter):
    name = "seedance"
    kind = "video"
    label = "火山方舟 Seedance"
    default_base_url = "https://ark.cn-beijing.volces.com/api/v3"
    default_model = "doubao-seedance-1-0-pro-250528"

    _RATIO_MAP = {"16:9": "16:9", "9:16": "9:16", "1:1": "1:1"}

    def submit_spec(self, params):
        content = [{"type": "text", "text": params["prompt"]}]
        if params.get("image_url"):
            content.append({"type": "image_url", "image_url": {"url": params["image_url"]}})
        payload = {
            "model": params["model"],
            "content": content,
            "duration": max(4, min(15, int(params.get("duration", 5)))),
            "ratio": self._RATIO_MAP.get(params.get("aspect_ratio", "16:9"), "16:9"),
            "resolution": params.get("resolution", "720p"),
        }
        return {"method": "POST", "path": "contents/generations/tasks", "json": payload, "extra_headers": {}}

    def read_submit(self, resp):
        task_id = (resp or {}).get("id")
        if not task_id:
            raise ProviderError("火山方舟未返回任务 id。", 502)
        return task_id

    def poll_path(self, task_id):
        return f"contents/generations/tasks/{task_id}"

    def normalize_poll(self, resp):
        status = _normalize_status((resp or {}).get("status"))
        outputs = []
        content = (resp or {}).get("content", {}) if isinstance(resp, dict) else {}
        video_url = content.get("video_url") if isinstance(content, dict) else None
        if isinstance(video_url, str):
            outputs.append(video_url)
        if not outputs:
            found = _first_url(resp)
            if found:
                outputs.append(found)
        return {"status": status, "outputs": outputs, "error": (resp or {}).get("error")}

    def probe_spec(self):
        return {"method": "GET", "path": "contents/generations/tasks/connectivity-check", "json": None, "extra_headers": {}}


_IMAGE_ADAPTERS = {
    cls.name: cls() for cls in (AtlasCloudImageAdapter, OpenAIImageAdapter, DashScopeImageAdapter)
}
_VIDEO_ADAPTERS = {
    cls.name: cls() for cls in (AtlasCloudVideoAdapter, SeedanceVideoAdapter, DashScopeVideoAdapter)
}


def get_adapter(kind, name):
    table = _IMAGE_ADAPTERS if kind == "image" else _VIDEO_ADAPTERS
    adapter = table.get((name or "atlascloud").strip().lower())
    if adapter is None:
        raise ProviderError(f"未知的{('文生图' if kind == 'image' else '图生视频')}供应商：{name}")
    return adapter


def list_providers():
    """供前端 / 文档展示的供应商清单。"""
    def describe(adapter):
        return {
            "name": adapter.name,
            "label": adapter.label,
            "defaultBaseUrl": adapter.default_base_url,
            "defaultModel": adapter.default_model,
            "defaultEditModel": adapter.default_edit_model,
            "synchronous": adapter.synchronous,
        }
    return {
        "image": [describe(a) for a in _IMAGE_ADAPTERS.values()],
        "video": [describe(a) for a in _VIDEO_ADAPTERS.values()],
    }

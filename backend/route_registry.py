from dataclasses import dataclass


@dataclass(frozen=True)
class Route:
    method: str
    path: str
    handler: str
    prefix: bool = False


class RouteRegistry:
    def __init__(self):
        self._routes = []

    def register(self, method, path, handler, prefix=False):
        route = Route(method.upper(), path, handler, prefix)
        if route in self._routes:
            raise ValueError(f"重复路由：{route.method} {route.path}")
        self._routes.append(route)
        return self

    def resolve(self, method, path):
        method = method.upper()
        for route in self._routes:
            if route.method != method:
                continue
            if route.prefix and path.startswith(route.path):
                return route, path[len(route.path):]
            if not route.prefix and path == route.path:
                return route, ""
        return None, ""

    @property
    def routes(self):
        return tuple(self._routes)


API_ROUTES = (
    RouteRegistry()
    .register("GET", "/api/health", "api_health")
    .register("GET", "/api/providers", "api_providers")
    .register("GET", "/api/jobs/", "api_job", prefix=True)
    .register("GET", "/api/media", "api_media")
    .register("GET", "/api/predictions/", "api_prediction", prefix=True)
    .register("GET", "/api/provider-config", "get_provider_config")
    .register("POST", "/api/generate-story", "generate_story")
    .register("POST", "/api/generate-episode", "generate_episode")
    .register("POST", "/api/test-text-provider", "test_text_provider")
    .register("POST", "/api/test-image-provider", "test_image_provider")
    .register("POST", "/api/test-video-provider", "test_video_provider")
    .register("POST", "/api/generate-image", "generate_image")
    .register("POST", "/api/generate-video", "generate_video")
    .register("POST", "/api/save-asset", "save_asset")
    .register("POST", "/api/resolve-asset-path", "resolve_asset_path")
    .register("POST", "/api/save-project", "save_project")
    .register("POST", "/api/export-player", "export_player")
    .register("POST", "/api/export-serial", "export_serial")
    .register("POST", "/api/cancel-job", "cancel_job")
    .register("POST", "/api/delete-asset", "delete_asset")
    .register("POST", "/api/open-folder", "open_folder")
    .register("POST", "/api/agent-chat", "agent_chat")
    .register("POST", "/api/provider-config", "save_provider_config")
)

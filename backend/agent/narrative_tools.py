"""剧情助手专属 Tools（无 pydantic 依赖）。"""
from __future__ import annotations

import json
from typing import Any

from .base import ParamsBase, Tool, ToolResult


# ── 共享上下文容器 ─────────────────────────────────────────────────────────────

class ProjectContext:
    def __init__(self, data: dict[str, Any]) -> None:
        self._data = data

    @property
    def data(self) -> dict[str, Any]:
        return self._data

    def get_mode(self) -> str:
        return self._data.get("mode", "interactive")

    def get_scenes(self) -> list[dict[str, Any]]:
        return self._data.get("scenes", [])

    def get_scene_by_id(self, scene_id: str) -> dict[str, Any] | None:
        for s in self.get_scenes():
            if s.get("id") == scene_id:
                return s
        return None

    def summary(self) -> dict[str, Any]:
        return {
            "title": self._data.get("title", ""),
            "synopsis": self._data.get("synopsis", ""),
            "genre": self._data.get("genre", ""),
            "style": self._data.get("style", ""),
            "characters": self._data.get("character", ""),
            "mode": self.get_mode(),
            "scene_count": len(self.get_scenes()),
        }


# ── GetProjectSummary ─────────────────────────────────────────────────────────

class GetProjectSummaryParams(ParamsBase):
    _field_descriptions = {}


class GetProjectSummaryTool(Tool):
    name = "get_project_summary"
    description = (
        "获取当前项目的全局设定摘要（标题、简介、风格、角色）以及所有节点的 id、"
        "标题和简短描述。调用此工具以了解整体剧情结构。"
    )
    params_cls = GetProjectSummaryParams
    category = "read"

    def __init__(self, ctx: ProjectContext) -> None:
        self.ctx = ctx

    async def execute(self, params: GetProjectSummaryParams) -> ToolResult:
        info = self.ctx.summary()
        scenes_brief = [
            {
                "id": s.get("id", ""),
                "title": s.get("title", ""),
                "shot": s.get("shot", ""),
                "choices": [c.get("text", "") for c in s.get("choices", [])],
            }
            for s in self.ctx.get_scenes()
        ]
        result = {**info, "scenes": scenes_brief}
        return ToolResult(output=json.dumps(result, ensure_ascii=False, indent=2))


# ── GetSceneDetail ────────────────────────────────────────────────────────────

class GetSceneDetailParams(ParamsBase):
    scene_id: str
    _field_descriptions = {"scene_id": "要查询的 scene/node 的 id 字段值"}


class GetSceneDetailTool(Tool):
    name = "get_scene_detail"
    description = (
        "获取指定 scene/node 的完整字段，包括 action、dialogue、choices、"
        "imagePrompt、videoPrompt 等。修改前请先调用此工具。"
    )
    params_cls = GetSceneDetailParams
    category = "read"

    def __init__(self, ctx: ProjectContext) -> None:
        self.ctx = ctx

    async def execute(self, params: GetSceneDetailParams) -> ToolResult:
        scene = self.ctx.get_scene_by_id(params.scene_id)
        if scene is None:
            return ToolResult(
                output=f"未找到 scene id={params.scene_id}，请用 get_project_summary 确认 id。",
                is_error=True,
            )
        return ToolResult(output=json.dumps(scene, ensure_ascii=False, indent=2))


# ── UpdateScene ───────────────────────────────────────────────────────────────

class UpdateSceneParams(ParamsBase):
    scene_id: str
    patch: dict
    reason: str = ""
    _field_descriptions = {
        "scene_id": "要修改的 scene/node 的 id（必须是已存在的 id）",
        "patch": (
            "仅包含需要变更的字段字典。"
            "禁止修改 id、isStart、order、episodeOrder 字段。"
            "choices[].targetSceneId 和 nextSceneId 必须指向已存在的节点 id。"
            "transition 只能是 match/dissolve/cut/fade。"
            "例：{\"action\": \"新的动作描述\", \"dialogue\": \"新台词\"}"
        ),
        "reason": "简要说明本次修改的理由（可选）",
    }


class UpdateSceneTool(Tool):
    name = "update_scene"
    description = (
        "提出对某个 scene/node 字段的修改建议。工具返回修改后的完整 scene JSON，"
        "前端展示「应用修改」按钮供用户确认，不会自动写入。\n"
        "⚠️ 调用前必须先 get_scene_detail 读取完整字段。\n"
        "⚠️ patch 中禁止修改 id / isStart / order / episodeOrder。\n"
        "⚠️ targetSceneId / nextSceneId 必须是已存在节点的 id，可先 get_project_summary 查看所有 id。\n"
        "可修改字段：title, action, dialogue, shot, transition（只能 match/dissolve/cut/fade）, "
        "entryState, exitState, imagePrompt, videoPrompt, nextSceneId, choices。"
    )
    params_cls = UpdateSceneParams
    category = "narrative"

    def __init__(self, ctx: ProjectContext) -> None:
        self.ctx = ctx

    async def execute(self, params: UpdateSceneParams) -> ToolResult:
        scene = self.ctx.get_scene_by_id(params.scene_id)
        if scene is None:
            return ToolResult(
                output=f"未找到 scene id={params.scene_id}，请先调用 get_project_summary 确认所有节点 id。",
                is_error=True,
            )

        # 安全检查：禁止修改受保护字段
        protected = {"id", "isStart", "order", "episodeOrder"}
        bad_fields = [f for f in params.patch if f in protected]
        if bad_fields:
            return ToolResult(
                output=f"不允许修改受保护字段：{bad_fields}。请从 patch 中移除这些字段。",
                is_error=True,
            )

        # 校验 transition 值
        if "transition" in params.patch:
            valid_transitions = {"match", "dissolve", "cut", "fade"}
            if params.patch["transition"] not in valid_transitions:
                return ToolResult(
                    output=f"transition 字段值无效：{params.patch['transition']}。只能是 match/dissolve/cut/fade。",
                    is_error=True,
                )

        # 校验 targetSceneId / nextSceneId 是否指向已有节点
        all_ids = {s.get("id") for s in self.ctx.get_scenes()}
        for key in ("nextSceneId",):
            if key in params.patch and params.patch[key] and params.patch[key] not in all_ids:
                return ToolResult(
                    output=f"{key} 值 '{params.patch[key]}' 不是已存在的节点 id。已知 id：{sorted(all_ids)}",
                    is_error=True,
                )
        if "choices" in params.patch and isinstance(params.patch["choices"], list):
            for choice in params.patch["choices"]:
                tid = choice.get("targetSceneId", "")
                if tid and tid not in all_ids:
                    return ToolResult(
                        output=f"choices 中 targetSceneId='{tid}' 不存在。已知 id：{sorted(all_ids)}",
                        is_error=True,
                    )

        updated = {**scene, **params.patch}
        result = {
            "scene_id": params.scene_id,
            "patch": params.patch,
            "updated_scene": updated,
            "reason": params.reason,
        }
        return ToolResult(output=json.dumps(result, ensure_ascii=False, indent=2))


# ── SuggestBranch ─────────────────────────────────────────────────────────────

class SuggestBranchParams(ParamsBase):
    scene_id: str
    direction: str = ""
    count: int = 2
    _field_descriptions = {
        "scene_id": "要为其建议新分支的 scene/node id",
        "direction": "可选：描述你希望新分支的走向或情感基调，如「走向悲剧」「增加反转」",
        "count": "建议的分支数量，1-4 条",
    }


class SuggestBranchTool(Tool):
    name = "suggest_branch"
    description = (
        "为指定 scene/node 建议 1-4 条新的分支选项（choices），"
        "每条包含选项文字和下一步剧情方向描述。"
        "结果仅作建议，用户可手动应用。"
    )
    params_cls = SuggestBranchParams
    category = "narrative"

    def __init__(self, ctx: ProjectContext) -> None:
        self.ctx = ctx

    async def execute(self, params: SuggestBranchParams) -> ToolResult:
        scene = self.ctx.get_scene_by_id(params.scene_id)
        if scene is None:
            return ToolResult(
                output=f"未找到 scene id={params.scene_id}",
                is_error=True,
            )
        context_for_llm = {
            "scene_id": params.scene_id,
            "title": scene.get("title", ""),
            "action": scene.get("action", ""),
            "dialogue": scene.get("dialogue", ""),
            "existing_choices": scene.get("choices", []),
            "direction_hint": params.direction,
            "requested_count": params.count,
            "instruction": (
                "请根据以上场景内容，生成建议的分支选项列表，"
                "每条包含 choice_text（选项文字）和 next_hint（下一步剧情走向描述）。"
                "以 JSON 数组格式输出。"
            ),
        }
        return ToolResult(output=json.dumps(context_for_llm, ensure_ascii=False, indent=2))


# ── 工厂函数 ──────────────────────────────────────────────────────────────────

def build_narrative_tools(ctx: ProjectContext) -> list[Tool]:
    return [
        GetProjectSummaryTool(ctx),
        GetSceneDetailTool(ctx),
        UpdateSceneTool(ctx),
        SuggestBranchTool(ctx),
    ]

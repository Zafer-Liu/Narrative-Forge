"""Tool 基类、ToolResult、ToolRegistry（无 pydantic 依赖，仅用标准库）。"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Literal, get_type_hints
import inspect

ToolCategory = Literal["read", "write", "narrative"]

MAX_OUTPUT_CHARS = 8000


@dataclass
class ToolResult:
    output: str
    is_error: bool = False


class ParamsBase:
    """Tool 参数基类，提供简单的类型校验与 JSON schema 生成。
    子类声明类属性 + 类型注解，可带默认值。
    """
    _field_descriptions: dict[str, str] = {}   # 子类可重写以提供字段描述

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ParamsBase":
        hints = get_type_hints(cls)
        kwargs: dict[str, Any] = {}
        for name, typ in hints.items():
            if name.startswith("_"):
                continue
            raw = data.get(name)
            default = getattr(cls, name, inspect.Parameter.empty)
            if raw is None:
                if default is inspect.Parameter.empty:
                    raise ValueError(f"缺少必填参数: {name}")
                kwargs[name] = default
            else:
                # 简单类型转换
                origin = getattr(typ, "__origin__", None)
                if typ is int or typ == int:
                    kwargs[name] = int(raw)
                elif typ is float or typ == float:
                    kwargs[name] = float(raw)
                elif typ is bool or typ == bool:
                    kwargs[name] = bool(raw)
                elif typ is str or typ == str:
                    kwargs[name] = str(raw)
                elif origin is dict or typ is dict:
                    kwargs[name] = raw if isinstance(raw, dict) else {}
                elif origin is list or typ is list:
                    kwargs[name] = raw if isinstance(raw, list) else []
                else:
                    kwargs[name] = raw
        inst = cls.__new__(cls)
        for k, v in kwargs.items():
            setattr(inst, k, v)
        return inst

    @classmethod
    def json_schema(cls) -> dict[str, Any]:
        """生成兼容 OpenAI function calling 的 JSON schema。"""
        hints = get_type_hints(cls)
        properties: dict[str, Any] = {}
        required: list[str] = []
        desc_map = getattr(cls, "_field_descriptions", {})

        for name, typ in hints.items():
            if name.startswith("_"):
                continue
            has_default = name in cls.__dict__
            origin = getattr(typ, "__origin__", None)
            if typ is int or typ == int:
                t = "integer"
            elif typ is float or typ == float:
                t = "number"
            elif typ is bool or typ == bool:
                t = "boolean"
            elif origin is dict or typ is dict:
                t = "object"
            elif origin is list or typ is list:
                t = "array"
            else:
                t = "string"
            prop: dict[str, Any] = {"type": t}
            if name in desc_map:
                prop["description"] = desc_map[name]
            properties[name] = prop
            if not has_default:
                required.append(name)

        schema: dict[str, Any] = {
            "type": "object",
            "properties": properties,
        }
        if required:
            schema["required"] = required
        return schema


class Tool(ABC):
    name: str
    description: str
    params_cls: type[ParamsBase]
    category: ToolCategory = "read"

    def get_schema(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "parameters": self.params_cls.json_schema(),
        }

    @abstractmethod
    async def execute(self, params: ParamsBase) -> ToolResult: ...


# ── 流事件 ────────────────────────────────────────────────────────────────────

@dataclass
class TextDelta:
    text: str


@dataclass
class ToolCallStart:
    tool_name: str
    tool_id: str


@dataclass
class ToolCallDelta:
    text: str


@dataclass
class ToolCallComplete:
    tool_id: str
    tool_name: str
    arguments: dict[str, Any]


@dataclass
class StreamEnd:
    stop_reason: str
    input_tokens: int = 0
    output_tokens: int = 0


StreamEvent = TextDelta | ToolCallStart | ToolCallDelta | ToolCallComplete | StreamEnd


# ── ToolRegistry ──────────────────────────────────────────────────────────────

class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool) -> "ToolRegistry":
        self._tools[tool.name] = tool
        return self

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def get_all_schemas(self) -> list[dict[str, Any]]:
        return [t.get_schema() for t in self._tools.values()]

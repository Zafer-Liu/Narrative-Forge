"""Narrative Forge — 内嵌 Agent+Tool 框架
风格参考 mewcode-python，精简适配 Python stdlib HTTP 服务环境。
"""
from .base import Tool, ToolResult, ToolRegistry
from .conversation import ConversationManager
from .client import LLMClient, OpenAICompatClient
from .agent import Agent

__all__ = [
    "Tool", "ToolResult", "ToolRegistry",
    "ConversationManager",
    "LLMClient", "OpenAICompatClient",
    "Agent",
]

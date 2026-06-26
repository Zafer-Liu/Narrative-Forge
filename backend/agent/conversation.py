"""简单的多轮对话历史管理，兼容 OpenAI Chat Completions 格式。"""
from __future__ import annotations

from typing import Any

Message = dict[str, Any]


class ConversationManager:
    """维护 messages 列表，支持注入 system 消息、添加 user/assistant/tool 回合。"""

    def __init__(self, system_prompt: str = "") -> None:
        self._system_prompt = system_prompt
        self.history: list[Message] = []

    # ── 写入 ──────────────────────────────────────────────────────────────────

    def add_user_message(self, content: str) -> None:
        self.history.append({"role": "user", "content": content})

    def add_assistant_message(
        self,
        content: str,
        tool_calls: list[dict[str, Any]] | None = None,
    ) -> None:
        msg: Message = {"role": "assistant", "content": content}
        if tool_calls:
            msg["tool_calls"] = tool_calls
        self.history.append(msg)

    def add_tool_result(self, tool_call_id: str, tool_name: str, content: str) -> None:
        self.history.append({
            "role": "tool",
            "tool_call_id": tool_call_id,
            "name": tool_name,
            "content": content,
        })

    # ── 读取 ──────────────────────────────────────────────────────────────────

    @property
    def system_prompt(self) -> str:
        return self._system_prompt

    def get_messages(self) -> list[Message]:
        """返回完整对话历史（不含 system，system 单独走 API 参数）。"""
        return list(self.history)

    def token_estimate(self) -> int:
        """粗略估算 token 数（4 字符 ≈ 1 token）。"""
        total = len(self._system_prompt)
        for msg in self.history:
            total += len(str(msg.get("content", "")))
        return total // 4

    def trim_to_window(self, max_tokens: int = 80_000) -> None:
        """当估算 token 超出窗口时，从最早的 user/assistant 对开始裁剪，
        始终保留最新的至少 2 条消息。"""
        while self.token_estimate() > max_tokens and len(self.history) > 2:
            self.history.pop(0)

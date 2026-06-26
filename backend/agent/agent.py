"""Agent 主循环（同步版本，适配 threading HTTP 服务）。

事件流：
  {"type": "text", "text": "..."}
  {"type": "tool_use", "name": "...", "id": "...", "args": {...}}
  {"type": "tool_result", "id": "...", "name": "...", "output": "...", "is_error": false}
  {"type": "done", "turns": N}
  {"type": "error", "message": "..."}
"""
from __future__ import annotations

import json
import logging
from typing import Any, Iterator

from .base import (
    MAX_OUTPUT_CHARS,
    StreamEnd,
    TextDelta,
    ToolCallComplete,
    ToolResult,
    ToolRegistry,
)
from .client import LLMClient, LLMError
from .conversation import ConversationManager

AgentEvent = dict[str, Any]


class Agent:
    """同步 Agent，驱动一次「用户消息 → LLM 流 → 工具执行 → 循环」的完整对话。

    用法：
        agent = Agent(client, registry, max_turns=10)
        for event in agent.run(conversation):
            yield_sse(event)
    """

    def __init__(
        self,
        client: LLMClient,
        registry: ToolRegistry,
        max_turns: int = 15,
    ) -> None:
        self.client = client
        self.registry = registry
        self.max_turns = max_turns

    def run(self, conversation: ConversationManager) -> Iterator[AgentEvent]:
        """驱动 Agent 循环，以生成器方式逐个 yield AgentEvent 字典。"""
        turns = 0

        while turns < self.max_turns:
            turns += 1
            conversation.trim_to_window()

            # ── LLM 流式调用 ─────────────────────────────────────────────────
            tools = self.registry.get_all_schemas()
            text_acc = ""
            tool_calls: list[ToolCallComplete] = []

            try:
                stream = self.client.stream_sync(conversation, tools=tools)
                for event in stream:
                    if isinstance(event, TextDelta):
                        text_acc += event.text
                        yield {"type": "text", "text": event.text}
                    elif isinstance(event, ToolCallComplete):
                        tool_calls.append(event)
                        yield {
                            "type": "tool_use",
                            "id": event.tool_id,
                            "name": event.tool_name,
                            "args": event.arguments,
                        }
                    elif isinstance(event, StreamEnd):
                        pass  # token 统计，暂不下发
            except LLMError as e:
                yield {"type": "error", "message": str(e)}
                return

            # ── 将 LLM 回复加入历史 ───────────────────────────────────────────
            if tool_calls:
                tc_history = [
                    {
                        "id": tc.tool_id,
                        "type": "function",
                        "function": {
                            "name": tc.tool_name,
                            "arguments": json.dumps(tc.arguments, ensure_ascii=False),
                        },
                    }
                    for tc in tool_calls
                ]
                conversation.add_assistant_message(text_acc, tool_calls=tc_history)
            else:
                conversation.add_assistant_message(text_acc)

            # ── 无工具调用 → 对话结束 ─────────────────────────────────────────
            if not tool_calls:
                yield {"type": "done", "turns": turns}
                return

            # ── 执行工具 ──────────────────────────────────────────────────────
            for tc in tool_calls:
                result = self._run_tool(tc)
                output = result.output[:MAX_OUTPUT_CHARS]
                conversation.add_tool_result(tc.tool_id, tc.tool_name, output)
                yield {
                    "type": "tool_result",
                    "id": tc.tool_id,
                    "name": tc.tool_name,
                    "output": output,
                    "is_error": result.is_error,
                }

        yield {"type": "error", "message": f"Agent 达到最大轮次上限 ({self.max_turns})"}

    def _run_tool(self, tc: ToolCallComplete) -> ToolResult:
        """执行单个工具调用，所有异常转为 ToolResult(is_error=True)。"""
        import asyncio

        tool = self.registry.get(tc.tool_name)
        if tool is None:
            return ToolResult(output=f"未知工具: {tc.tool_name}", is_error=True)

        try:
            params = tool.params_cls.from_dict(tc.arguments)
        except (ValueError, TypeError) as e:
            return ToolResult(output=f"参数验证失败: {e}", is_error=True)

        try:
            loop = asyncio.new_event_loop()
            try:
                result = loop.run_until_complete(tool.execute(params))
            finally:
                loop.close()
            return result
        except Exception as e:
            return ToolResult(output=f"工具执行出错: {e}", is_error=True)

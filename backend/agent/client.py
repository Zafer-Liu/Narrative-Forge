"""LLM 客户端 — OpenAI Chat Completions 流式实现。
复用 Narrative Forge 已有的 requests 库，无需引入 openai SDK。
"""
from __future__ import annotations

import json
import uuid
from abc import ABC, abstractmethod
from typing import Any, AsyncIterator, Iterator

import requests

from .base import (
    StreamEnd,
    StreamEvent,
    TextDelta,
    ToolCallComplete,
    ToolCallDelta,
    ToolCallStart,
)
from .conversation import ConversationManager


class LLMError(Exception):
    pass


class LLMClient(ABC):
    @abstractmethod
    def stream_sync(
        self,
        conversation: ConversationManager,
        tools: list[dict[str, Any]] | None = None,
    ) -> Iterator[StreamEvent]:
        """同步流式迭代，供 threading HTTP 服务直接使用。"""
        ...


class OpenAICompatClient(LLMClient):
    """面向任意 OpenAI Chat Completions 兼容接口的流式客户端。
    使用 requests + stream=True + iter_lines，无需 asyncio，
    直接在 SimpleHTTPRequestHandler 线程中驱动。
    """

    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: str,
        max_tokens: int = 4096,
        temperature: float = 0.7,
        timeout: int = 300,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.max_tokens = max_tokens
        self.temperature = temperature
        self.timeout = timeout

    def stream_sync(
        self,
        conversation: ConversationManager,
        tools: list[dict[str, Any]] | None = None,
    ) -> Iterator[StreamEvent]:
        messages: list[dict[str, Any]] = []
        if conversation.system_prompt:
            messages.append({"role": "system", "content": conversation.system_prompt})
        messages.extend(conversation.get_messages())

        payload: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "stream": True,
            "max_tokens": self.max_tokens,
            "temperature": self.temperature,
        }
        # Chat Completions tool 格式
        if tools:
            payload["tools"] = [
                {
                    "type": "function",
                    "function": {
                        "name": t["name"],
                        "description": t.get("description", ""),
                        "parameters": t.get("parameters", t.get("input_schema", {})),
                    },
                }
                for t in tools
            ]
            payload["tool_choice"] = "auto"

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        }

        try:
            resp = requests.post(
                f"{self.base_url}/chat/completions",
                json=payload,
                headers=headers,
                stream=True,
                timeout=self.timeout,
            )
            resp.raise_for_status()
        except requests.RequestException as e:
            raise LLMError(f"LLM 请求失败: {e}") from e

        # 用于累积 tool call 增量（按索引跟踪）
        active_calls: dict[int, dict[str, str]] = {}
        input_tokens = 0
        output_tokens = 0

        for line in resp.iter_lines():
            if not line:
                continue
            if isinstance(line, bytes):
                line = line.decode("utf-8")
            if not line.startswith("data:"):
                continue
            data_str = line[5:].strip()
            if data_str == "[DONE]":
                break
            try:
                chunk = json.loads(data_str)
            except json.JSONDecodeError:
                continue

            # usage（部分 provider 在最后一个 chunk 给出）
            usage = chunk.get("usage")
            if usage:
                input_tokens = usage.get("prompt_tokens", 0)
                output_tokens = usage.get("completion_tokens", 0)

            choices = chunk.get("choices", [])
            if not choices:
                continue
            choice = choices[0]
            delta = choice.get("delta", {})
            finish_reason = choice.get("finish_reason")

            # 文本 delta
            content = delta.get("content")
            if content:
                yield TextDelta(text=content)

            # tool call delta
            tool_calls_delta = delta.get("tool_calls")
            if tool_calls_delta:
                for tc in tool_calls_delta:
                    idx = tc.get("index", 0)
                    if idx not in active_calls:
                        active_calls[idx] = {"id": "", "name": "", "args": ""}
                    call = active_calls[idx]

                    if tc.get("id"):
                        call["id"] = tc["id"]
                    fn = tc.get("function", {})
                    if fn.get("name"):
                        call["name"] = fn["name"]
                        yield ToolCallStart(tool_name=call["name"], tool_id=call["id"])
                    if fn.get("arguments"):
                        call["args"] += fn["arguments"]
                        yield ToolCallDelta(text=fn["arguments"])

            if finish_reason == "tool_calls":
                for _idx, call in sorted(active_calls.items()):
                    try:
                        args = json.loads(call["args"]) if call["args"] else {}
                    except json.JSONDecodeError:
                        args = {}
                    yield ToolCallComplete(
                        tool_id=call["id"] or uuid.uuid4().hex,
                        tool_name=call["name"],
                        arguments=args,
                    )
                active_calls.clear()

        yield StreamEnd(
            stop_reason="end_turn",
            input_tokens=input_tokens,
            output_tokens=output_tokens,
        )

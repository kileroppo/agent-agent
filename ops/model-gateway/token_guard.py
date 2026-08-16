import json
import math
from typing import Literal, Optional, Union

from fastapi import HTTPException
from litellm.caching.caching import DualCache
from litellm.integrations.custom_logger import CustomLogger
from litellm.proxy._types import UserAPIKeyAuth


MAX_INPUT_TOKENS = 40_000
MAX_OUTPUT_TOKENS = 8_192


class AgentArmyTokenGuard(CustomLogger):
    """Reject oversized prompts before they can reach the paid provider."""

    async def async_pre_call_hook(
        self,
        user_api_key_dict: UserAPIKeyAuth,
        cache: DualCache,
        data: dict,
        call_type: Literal[
            "completion",
            "text_completion",
            "embeddings",
            "image_generation",
            "moderation",
            "audio_transcription",
            "pass_through_endpoint",
            "rerank",
            "mcp_call",
            "anthropic_messages",
        ],
    ) -> Optional[Union[Exception, str, dict]]:
        if call_type not in ("completion", "anthropic_messages"):
            return data

        estimated_input_tokens = estimate_input_tokens(data)
        if estimated_input_tokens > MAX_INPUT_TOKENS:
            return HTTPException(
                status_code=413,
                detail=(
                    f"输入预计 {estimated_input_tokens} Token，超过单次上限 "
                    f"{MAX_INPUT_TOKENS}；请新开会话、压缩历史或减少工具。"
                ),
            )

        output_key = "max_completion_tokens" if "max_completion_tokens" in data else "max_tokens"
        requested = positive_int(data.get(output_key))
        data[output_key] = min(requested or MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS)
        return data


def estimate_input_tokens(data: dict) -> int:
    messages = data.get("messages") if isinstance(data.get("messages"), list) else []
    tools = data.get("tools") if isinstance(data.get("tools"), list) else None
    # Step 3.7 没有公开 tokenizer。按 UTF-8 每 3 字节约 1 Token 保守估算，
    # 只做付费前硬门禁；Provider 响应中的 usage 才进入正式账本。
    serialized = json.dumps(
        {"messages": messages, "tools": tools},
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return math.ceil(len(serialized.encode("utf-8")) / 3)


def positive_int(value) -> Optional[int]:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


token_guard = AgentArmyTokenGuard()

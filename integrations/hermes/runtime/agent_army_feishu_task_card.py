"""Deterministic Feishu task-card rendering and delivery decisions.

This module deliberately owns no task queue, persistence, or network client.
The Agent Army task service remains the authority for
``agent.army/task-card/v1`` and the Hermes adapter only uses these helpers to
render and advance one profile-scoped card anchor.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, Mapping, Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from urllib.parse import parse_qsl, urlsplit
from zoneinfo import ZoneInfo


TASK_CARD_SCHEMA = "agent.army/task-card/v1"
TASK_CARD_ADAPTER_SEAM = "agent.army/hermes-feishu-task-card-adapter/v1"
SUPPORTED_HERMES_VERSION = "0.19.0"
SUPPORTED_HERMES_GIT_COMMIT = "fd39696ccfbb1221ac9fdb6119f629f9821e195d"
TRUSTED_TASK_CARD_TOOL_NAMES = frozenset({
    "mcp__agent_army__task_create",
    "mcp__agent_army__task_get",
})
ALLOWED_ACTIONS = frozenset({"approve", "reject", "pause", "resume"})
SUPERVISOR_MAX_CONCURRENCY = 3
TASK_CARD_POLICIES = frozenset({"routed-task", "durable-task", "incident-only", "disabled"})
_XIAOD_PUBLIC_VIDEO_INGRESS_PATH = "/api/feishu/commander"
_XIAOD_PUBLIC_VIDEO_INGRESS_TIMEOUT_SECONDS = 25

_ACTION_PRESENTATION = {
    "approve": ("批准", "primary"),
    "reject": ("拒绝", "danger"),
    "pause": ("暂停", "default"),
    "resume": ("继续", "primary"),
}
_HEADER_TEMPLATES = {
    "blue": "blue",
    "green": "green",
    "orange": "orange",
    "red": "red",
    "grey": "grey",
    "gray": "grey",
    "turquoise": "turquoise",
    "violet": "violet",
}
_DELIVERY_STATES_WITH_UNCERTAIN_ANCHOR = frozenset({"sending", "anchor_uncertain", "unknown"})
_INCIDENT_TASK_KINDS = frozenset({
    "incident",
    "recovery",
    "approval",
    "operations.incident",
    "operations.incident-response",
    "operations.recovery",
    "operations.failure-recovery",
    "governance.approval",
})
_ROUTINE_HEALTH_TASK_KINDS = frozenset({"operations.health-review"})
_TRUSTED_FEISHU_LINK_HOSTS = frozenset({"feishu.cn", "feishu.com", "larksuite.com"})
# This is deliberately only a lexical pre-filter. Platform-specific routing
# semantics live in ``_is_supported_xiaod_video_url`` below so they stay in
# lock-step with A君's URL parser (notably YouTube's required non-empty ``v``).
_XIAOD_PUBLIC_VIDEO_URL_RE = re.compile(r"https?://[^\s<>]+", re.IGNORECASE)
_STATE_LABELS = {
    "queued": "排队中",
    "running": "处理中",
    "waiting_approval": "等待审批",
    "needs_input": "需要处理",
    "waiting_test": "等待验收",
    "paused": "已暂停",
    "recovery_pending": "等待恢复",
    "technical_repair": "技术修复中",
    "succeeded": "已完成",
    "failed": "处理失败",
    "cancelled": "已取消",
}
_OWNER_LABELS = {
    "ajun": "A君",
    "architect": "架构师",
    "reviewer": "审核官",
    "operator": "运维官",
    "technical-expert": "技术专家",
    "xiaod": "小D",
    "office-assistant": "小办",
    "intel-researcher": "小R",
    "creator": "创建官",
}


class HermesTaskCardCompatibilityError(RuntimeError):
    """Raised when Hermes does not satisfy the pinned Adapter seam."""


def _text(value: Any, limit: int, fallback: str = "") -> str:
    cleaned = " ".join(str(value or "").split())
    return cleaned[:limit] or fallback


def _field(value: Mapping[str, Any], *names: str) -> Any:
    for name in names:
        if name in value:
            return value[name]
    return None


def _presentation_label(value: Any, labels: Mapping[str, str], limit: int) -> str:
    text = _text(value, limit)
    return labels.get(text.lower(), text)


def _display_time(value: Any) -> str:
    text = _text(value, 80)
    if not text:
        return ""
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d %H:%M")
    except (ValueError, TypeError):
        return text


def _identity(value: Mapping[str, Any], name: str) -> str:
    aliases = {
        "agentId": ("agentId", "agent_id"),
        "profileId": ("profileId", "profile_id"),
        "chatId": ("chatId", "chat_id"),
    }
    return _text(_field(value, *aliases[name]), 240)


def _trusted_delivery_url(value: Any) -> str:
    raw_url = str(value or "").strip()
    if any(character.isspace() for character in raw_url):
        return ""
    url = raw_url[:500]
    if not url:
        return ""
    try:
        parsed = urlsplit(url)
        hostname = (parsed.hostname or "").lower().rstrip(".")
        trusted_host = any(
            hostname == suffix or hostname.endswith(f".{suffix}")
            for suffix in _TRUSTED_FEISHU_LINK_HOSTS
        )
        if parsed.scheme != "https" or not trusted_host or parsed.username or parsed.password:
            return ""
        return url
    except (TypeError, ValueError):
        return ""


def _strict_loopback_http_url(value: Any, *, expected_path: str) -> str:
    """Accept exactly one non-proxyable local HTTP endpoint.

    ``startswith('http://127.0.0.1:')`` is insufficient: it accepts
    credentials, suffix paths and query/fragment forms whose final destination
    is not the fixed local API contract.  Keep this parser deliberately narrow
    because this URL is used for a privileged local task-registration hop.
    """
    raw_url = str(value or "")
    if (
        not raw_url
        or raw_url != raw_url.strip()
        or len(raw_url) > 500
        or any(character.isspace() for character in raw_url)
        or "?" in raw_url
        or "#" in raw_url
    ):
        return ""
    try:
        parsed = urlsplit(raw_url)
        port = parsed.port
    except (TypeError, ValueError):
        return ""
    if (
        parsed.scheme != "http"
        or parsed.hostname != "127.0.0.1"
        or port is None
        or not 1 <= port <= 65535
        or parsed.netloc != f"127.0.0.1:{port}"
        or parsed.path != expected_path
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        return ""
    return f"http://127.0.0.1:{port}{expected_path}"


def _is_supported_xiaod_video_url(value: Any) -> bool:
    """Mirror A君's dedicated 小D public-video fast-path exactly.

    Hermes consumes recognised bare links, so a wider matcher here would hide
    a link from generic chat only for A君 to reject it and fall back to a
    planner/provider. Keep URL parsing and every accepted host/path aligned
    with ``isSupportedXiaodVideoUrl`` in the A君 commander router.
    """
    text = str(value or "").strip()
    if not _XIAOD_PUBLIC_VIDEO_URL_RE.fullmatch(text):
        return False
    try:
        parsed = urlsplit(text)
        # Accessing ``port`` rejects malformed authority values that a URL
        # constructor would reject rather than treating them as a valid host.
        parsed.port
    except (TypeError, ValueError):
        return False
    if parsed.scheme.lower() not in {"http", "https"}:
        return False
    hostname = (parsed.hostname or "").lower()
    if hostname.startswith("www."):
        hostname = hostname[4:]
    pathname = parsed.path
    if hostname == "bilibili.com":
        return bool(re.match(r"^/video/(?:BV|av)[a-z0-9]+", pathname, re.IGNORECASE))
    if hostname == "b23.tv":
        return len(pathname) > 1
    if hostname == "youtube.com":
        if pathname == "/watch":
            for name, candidate in parse_qsl(parsed.query, keep_blank_values=True):
                if name == "v":
                    return bool(candidate)
            return False
        return bool(re.match(r"^/(?:shorts|live)/[^/]+", pathname, re.IGNORECASE))
    if hostname == "youtu.be":
        return len(pathname) > 1
    if hostname == "douyin.com":
        return bool(re.match(r"^/(?:video|note)/[^/]+", pathname, re.IGNORECASE))
    if hostname == "v.douyin.com":
        return len(pathname) > 1
    return False


def _markdown_link_label(value: str) -> str:
    return value.replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]")


def task_card_policy_decision(
    projection: Mapping[str, Any], task_card_policy: Any = None
) -> Dict[str, Any]:
    """Return a fail-closed delivery decision for an explicit card policy.

    Missing policy preserves the original v1 AJun contract.  ``incident-only``
    accepts only a structured taskKind/category marker; presentation copy is
    never inspected to infer incident intent.
    """
    policy = _text(
        task_card_policy if task_card_policy is not None else projection.get("taskCardPolicy"),
        40,
    ).lower()
    if not policy:
        return {"allowed": True, "policy": "legacy", "reason": "legacy_v1"}
    if policy not in TASK_CARD_POLICIES:
        return {"allowed": False, "policy": policy, "reason": "policy_unsupported"}
    if policy == "disabled":
        return {"allowed": False, "policy": policy, "reason": "policy_disabled"}
    if policy != "incident-only":
        return {"allowed": True, "policy": policy, "reason": "policy_allows_task"}
    task_kind = _text(_field(projection, "taskKind", "category", "taskType"), 120).lower()
    if task_kind in _ROUTINE_HEALTH_TASK_KINDS:
        return {"allowed": False, "policy": policy, "reason": "routine_health_excluded"}
    if task_kind in _INCIDENT_TASK_KINDS:
        return {"allowed": True, "policy": policy, "reason": "incident_kind_allowed"}
    state = _text(projection.get("state"), 80).lower()
    structured_actions = {
        str(candidate.get("id") or candidate.get("action") or "").strip().lower()
        if isinstance(candidate, Mapping) else str(candidate or "").strip().lower()
        for candidate in projection.get("actions") or []
    }
    if state == "waiting_approval" or structured_actions.intersection({"approve", "reject"}):
        return {"allowed": True, "policy": policy, "reason": "approval_state_allowed"}
    return {"allowed": False, "policy": policy, "reason": "incident_kind_required"}


def _action_identity(projection: Mapping[str, Any], task_id: str) -> Dict[str, str]:
    identity = {"taskId": task_id, "task_id": task_id}
    for name in ("agentId", "profileId", "chatId"):
        value = _identity(projection, name)
        if value:
            identity[name] = value
    return identity


def _normalized_actions(projection: Mapping[str, Any]) -> Iterable[Dict[str, Any]]:
    if projection.get("terminal") is True:
        return []
    normalized = []
    for candidate in projection.get("actions") or []:
        action = candidate.get("id") or candidate.get("action") if isinstance(candidate, Mapping) else candidate
        action = str(action or "").strip().lower()
        if action in ALLOWED_ACTIONS and not any(item["action"] == action for item in normalized):
            normalized.append({
                "action": action,
                "label": _text(candidate.get("label"), 80) if isinstance(candidate, Mapping) else "",
                "approvalId": _text(candidate.get("approvalId"), 240) if isinstance(candidate, Mapping) else "",
                "governanceMode": _text(candidate.get("governanceMode"), 80) if isinstance(candidate, Mapping) else "",
            })
    return normalized


def render_task_card(
    projection: Mapping[str, Any], *, details_expanded: bool = False
) -> Dict[str, Any]:
    """Render one authoritative task projection as a Feishu interactive card."""
    if not isinstance(projection, Mapping) or projection.get("schemaVersion") != TASK_CARD_SCHEMA:
        raise ValueError(f"expected {TASK_CARD_SCHEMA} projection")
    task_id = _text(projection.get("taskId"), 160)
    if not task_id:
        raise ValueError("task-card projection requires taskId")

    title = _text(projection.get("title"), 120, "任务进展")
    state = _presentation_label(projection.get("state"), _STATE_LABELS, 40) or "处理中"
    summary = _text(projection.get("summary"), 1200, "任务状态已更新。")
    owner = _presentation_label(projection.get("owner"), _OWNER_LABELS, 80)
    next_action = projection.get("nextAction")
    if isinstance(next_action, Mapping):
        next_action = next_action.get("label") or next_action.get("text") or next_action.get("title")
    next_action = _text(next_action, 300)
    task_ref = _text(projection.get("taskRef"), 80, task_id[:8])
    updated_at = _display_time(projection.get("updatedAt"))
    revision = projection.get("sourceRevision")
    content_hash = _text(projection.get("contentHash"), 160)
    tone = str(projection.get("tone") or "").lower()
    template = {
        "active": "blue",
        "attention": "orange",
        "success": "green",
        "danger": "red",
        "muted": "grey",
    }.get(tone, _HEADER_TEMPLATES.get(tone, "blue"))
    action_identity = _action_identity(projection, task_id)

    facts = [f"**状态**：{state}"]
    if owner:
        facts.append(f"**负责人**：{owner}")
    body = f"{'　'.join(facts)}\n\n{summary}"
    elements: list[Dict[str, Any]] = [{"tag": "markdown", "content": body}]
    if next_action and "".join(next_action.split()) not in "".join(summary.split()):
        elements.append({"tag": "markdown", "content": f"**下一步**：{next_action}"})

    show_details = details_expanded or projection.get("terminal") is True
    if show_details:
        details = projection.get("details") if isinstance(projection.get("details"), Mapping) else {}
        task_type = _text(details.get("taskType"), 80, "军团任务")
        created_at = _display_time(details.get("createdAt"))
        detail_lines = [
            "**任务详情**",
            f"**任务编号**：{task_ref}",
            f"**任务类型**：{task_type}",
        ]
        if created_at:
            detail_lines.append(f"**创建时间**：{created_at}")
        if updated_at:
            detail_lines.append(f"**最近更新**：{updated_at}")
        elements.append({"tag": "markdown", "content": "\n".join(detail_lines)})

    buttons = []
    for action_view in _normalized_actions(projection):
        action = action_view["action"]
        fallback_label, button_type = _ACTION_PRESENTATION[action]
        label = action_view.get("label") or fallback_label
        buttons.append(
            {
                "tag": "button",
                "text": {"tag": "plain_text", "content": label},
                "type": button_type,
                "value": {
                    "agent_army_task_card_action": action,
                    **action_identity,
                    "source_revision": revision,
                    "content_hash": content_hash,
                    "approval_id": action_view["approvalId"],
                    "governance_mode": action_view["governanceMode"],
                },
            }
        )
    if buttons:
        elements.append({"tag": "action", "actions": buttons})

    primary_link = projection.get("primaryLink")
    if isinstance(primary_link, Mapping):
        link_url = _trusted_delivery_url(primary_link.get("url"))
        link_label = _text(primary_link.get("label"), 80, "打开交付结果")
        if link_url:
            if projection.get("terminal") is True:
                markdown_label = _markdown_link_label(link_label)
                markdown_url = link_url.replace("(", "%28").replace(")", "%29")
                elements.append({"tag": "markdown", "content": f"[{markdown_label}]({markdown_url})"})
            else:
                elements.append({
                    "tag": "action",
                    "actions": [{
                        "tag": "button",
                        "text": {"tag": "plain_text", "content": link_label},
                        "type": "primary",
                        "url": link_url,
                    }],
                })

    if projection.get("terminal") is not True:
        elements.append({
            "tag": "action",
            "actions": [
                {
                    "tag": "button",
                    "text": {
                        "tag": "plain_text",
                        "content": "收起任务详情" if details_expanded else "查看任务详情",
                    },
                    "type": "default",
                    "value": {
                        "agent_army_task_card_action": "collapse_details" if details_expanded else "details",
                        **action_identity,
                        "source_revision": revision,
                        "content_hash": content_hash,
                    },
                },
                {
                    "tag": "button",
                    "text": {"tag": "plain_text", "content": "刷新任务状态"},
                    "type": "default",
                    "value": {
                        "agent_army_task_card_action": "refresh",
                        **action_identity,
                        "source_revision": revision,
                        "content_hash": content_hash,
                    },
                },
            ],
        })

    note = f"任务 {task_ref}"
    if updated_at:
        note += f" · 更新于 {updated_at}"
    elements.append({"tag": "note", "elements": [{"tag": "plain_text", "content": note[:300]}]})
    return {
        "config": {"wide_screen_mode": True, "update_multi": True},
        "header": {"title": {"tag": "plain_text", "content": title}, "template": template},
        "elements": elements,
    }


def _revision_key(value: Any) -> Optional[tuple[int, Any]]:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return (0, float(value))
    text = str(value).strip()
    if not text:
        return None
    try:
        return (0, float(text))
    except ValueError:
        pass
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return (1, parsed.timestamp())
    except ValueError:
        return (2, text)


def _compare_revision(current: Any, incoming: Any) -> Optional[int]:
    left, right = _revision_key(current), _revision_key(incoming)
    if left is None or right is None or left[0] != right[0]:
        return 0 if current == incoming else None
    return (right[1] > left[1]) - (right[1] < left[1])


def decide_task_card_delivery(
    record: Optional[Mapping[str, Any]], projection: Mapping[str, Any], *, task_card_policy: Any = None
) -> Dict[str, Any]:
    """Choose send/update/skip without guessing whether an anchor was created.

    Equal revisions with different hashes are rejected as a conflict.  This is
    what prevents an old callback/projection from restoring decision buttons
    after a newer or terminal state has already been rendered.
    """
    if not isinstance(projection, Mapping) or projection.get("schemaVersion") != TASK_CARD_SCHEMA:
        raise ValueError(f"expected {TASK_CARD_SCHEMA} projection")
    task_id = _text(projection.get("taskId"), 160)
    if not task_id:
        raise ValueError("task-card projection requires taskId")
    revision = projection.get("sourceRevision")
    content_hash = _text(projection.get("contentHash"), 160)
    common = {"taskId": task_id, "sourceRevision": revision, "contentHash": content_hash}
    for name in ("agentId", "profileId", "chatId"):
        value = _identity(projection, name)
        if value:
            common[name] = value

    policy_decision = task_card_policy_decision(projection, task_card_policy)
    if not policy_decision["allowed"]:
        return {
            "operation": "skip",
            "reason": policy_decision["reason"],
            "taskCardPolicy": policy_decision["policy"],
            **common,
        }

    if not record:
        return {"operation": "send", "reason": "anchor_missing", **common}
    recorded_task_id = _text(_field(record, "taskId", "task_id"), 160)
    if recorded_task_id and recorded_task_id != task_id:
        return {"operation": "skip", "reason": "task_mismatch", **common}
    for name, reason in (
        ("agentId", "agent_mismatch"),
        ("profileId", "profile_mismatch"),
        ("chatId", "chat_mismatch"),
    ):
        recorded_identity = _identity(record, name)
        projection_identity = _identity(projection, name)
        if recorded_identity and not projection_identity:
            return {"operation": "skip", "reason": f"{name[:-2].lower()}_missing", **common}
        if recorded_identity and projection_identity and recorded_identity != projection_identity:
            return {"operation": "skip", "reason": reason, **common}

    message_id = _text(_field(record, "messageId", "message_id"), 240)
    delivery_state = _text(_field(record, "deliveryState", "delivery_state"), 40).lower()
    if not message_id:
        if delivery_state in _DELIVERY_STATES_WITH_UNCERTAIN_ANCHOR:
            return {"operation": "anchor_uncertain", "reason": "send_outcome_unknown", **common}
        if delivery_state in {"not_started", "failed_not_started"}:
            attempts = int(_field(record, "attemptCount", "attempt_count") or 0)
            if attempts >= 2:
                return {"operation": "skip", "reason": "retry_exhausted", **common}
            return {"operation": "send", "reason": "send_not_started", **common}
        return {"operation": "anchor_uncertain", "reason": "message_id_missing", **common}

    recorded_revision = _field(record, "lastSourceRevision", "last_source_revision", "sourceRevision")
    recorded_hash = _text(_field(record, "lastContentHash", "last_content_hash", "contentHash"), 160)
    comparison = _compare_revision(recorded_revision, revision)
    if comparison == -1:
        return {"operation": "skip", "reason": "stale_projection", "messageId": message_id, **common}
    if comparison == 0:
        if recorded_hash == content_hash:
            return {"operation": "skip", "reason": "unchanged", "messageId": message_id, **common}
        return {"operation": "skip", "reason": "revision_conflict", "messageId": message_id, **common}
    if comparison is None:
        return {"operation": "skip", "reason": "revision_incomparable", "messageId": message_id, **common}
    return {"operation": "update", "reason": "newer_projection", "messageId": message_id, **common}


def poll_interval_seconds(
    created_at: Any = None, *, age_seconds: Optional[float] = None, now: Optional[datetime] = None
) -> int:
    """Return the shared supervisor cadence: 2s active, then 15s, then 60s."""
    if age_seconds is None:
        current = now or datetime.now(timezone.utc)
        if current.tzinfo is None:
            current = current.replace(tzinfo=timezone.utc)
        try:
            created = created_at if isinstance(created_at, datetime) else datetime.fromisoformat(
                str(created_at).replace("Z", "+00:00")
            )
            if created.tzinfo is None:
                created = created.replace(tzinfo=timezone.utc)
            age_seconds = max(0.0, (current - created).total_seconds())
        except (TypeError, ValueError):
            age_seconds = 0.0
    if age_seconds <= 5 * 60:
        return 2
    if age_seconds <= 30 * 60:
        return 15
    return 60


def is_trusted_task_card_event(event_type: Any, tool_name: Any) -> bool:
    """Accept only structured results from the two task-card-producing MCP tools."""
    return (
        event_type == "tool.completed"
        and isinstance(tool_name, str)
        and tool_name in TRUSTED_TASK_CARD_TOOL_NAMES
    )


def trusted_task_card_handler(adapter: Any, source: Any, *, feishu_platform: Any) -> Optional[Callable[..., Any]]:
    """Resolve the formal task-card event interface for one Feishu Adapter.

    The Gateway imports this helper from the installed plugin module.  It never
    parses model prose or knows task-card schemas; a non-Feishu source and an
    Adapter without the installed seam both fail closed.
    """
    if getattr(source, "platform", None) != feishu_platform:
        return None
    handler = getattr(adapter, "handle_agent_army_task_result", None)
    return handler if callable(handler) else None


class AgentArmyFeishuTaskCardAdapter:
    """Formal Adapter for Hermes' Feishu host at the task-card Seam.

    Hermes owns transport and Session lifecycle.  This Adapter owns the
    profile-private anchor ledger, authoritative projection polling, callback
    validation and card rendering.  The host interface is deliberately small
    and validated once when the seam is installed.
    """

    REQUIRED_HOST_INTERFACE = (
        "_feishu_send_with_retry",
        "_finalize_send_result",
        "_is_interactive_operator_authorized",
        "_run_blocking",
    )

    def __init__(self, host: Any, host_symbols: Mapping[str, Any]):
        self.host = host
        self._symbols = dict(host_symbols)
        self._logger = self._symbols.get("logger") or logging.getLogger(__name__)
        get_home = self._symbols.get("get_hermes_home")
        if not callable(get_home):
            raise HermesTaskCardCompatibilityError("Hermes host is missing get_hermes_home")
        self._home = Path(get_home())
        self._path = self._home / "agent_army_task_cards.json"
        self._legacy_path = self._home / "ajun_task_cards.json"
        self._lock = threading.RLock()
        self._supervisor_task: Optional[asyncio.Task[Any]] = None
        self._wake = asyncio.Event()
        self._suppress_final_by_chat: Dict[str, float] = {}
        self._xiaod_public_video_event_refs: set[str] = set()
        self._xiaod_public_video_inflight_refs: set[str] = set()
        # ``handle_message`` is invoked under Hermes' per-chat lock.  A public
        # video registration can legitimately wait for a bounded local HTTP
        # call, so retain its task here and release that lock before waiting.
        # The map also gives disconnect a lifecycle-owned cancellation point;
        # never leave a fire-and-forget task that can fail silently.
        self._xiaod_public_video_route_tasks: Dict[str, asyncio.Task[Any]] = {}

    def policy(self) -> str:
        policy = (
            os.getenv("AGENT_ARMY_TASK_CARD_POLICY", "")
            or os.getenv("AGENT_ARMY_FEISHU_TASK_CARD_POLICY", "")
        ).strip().lower()
        if not policy and os.getenv("AJUN_FEISHU_DYNAMIC_TASK_CARD", "").strip().lower() == "true":
            policy = "routed-task"
        return policy if policy in TASK_CARD_POLICIES - {"disabled"} else "disabled"

    def identity(
        self, *, chat_id: str = "", projection: Optional[Mapping[str, Any]] = None
    ) -> Dict[str, str]:
        projection = projection if isinstance(projection, Mapping) else {}
        agent_id = str(
            projection.get("agentId")
            or os.getenv("AGENT_ARMY_FEISHU_AGENT_ID", "")
            or os.getenv("AJUN_FEISHU_ENTRY_AGENT_ID", "")
            or "ajun"
        ).strip()
        profile_id = str(
            projection.get("profileId")
            or os.getenv("AGENT_ARMY_PROFILE_ID", "")
            or os.getenv("AGENT_ARMY_FEISHU_PROFILE_ID", "")
            or os.getenv("HERMES_PROFILE", "")
            or self._home.name
        ).strip()
        if profile_id == ".hermes":
            profile_id = "ajun"
        return {
            "agentId": agent_id,
            "profileId": profile_id,
            "chatId": str(projection.get("chatId") or chat_id or "").strip(),
        }

    @staticmethod
    def key(*, task_id: str, chat_id: str, agent_id: str, profile_id: str) -> str:
        raw = "\x1f".join((profile_id, agent_id, chat_id, task_id))
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    @staticmethod
    def base_url() -> str:
        base_url = os.getenv("AGENT_ARMY_TASK_CARD_BASE_URL", "").strip().rstrip("/")
        return base_url if base_url.startswith("http://127.0.0.1:") else ""

    def enabled(self) -> bool:
        return self.policy() != "disabled"

    @staticmethod
    def _xiaod_public_video_profile() -> bool:
        agent_id = (
            os.getenv("AGENT_ARMY_FEISHU_AGENT_ID", "")
            or os.getenv("AJUN_FEISHU_ENTRY_AGENT_ID", "")
        ).strip()
        profile_id = (
            os.getenv("AGENT_ARMY_PROFILE_ID", "")
            or os.getenv("AGENT_ARMY_FEISHU_PROFILE_ID", "")
        ).strip()
        return agent_id == "xiaod" and profile_id == "xiaod"

    @staticmethod
    def _xiaod_public_video_ingress_url() -> str:
        return _strict_loopback_http_url(
            os.getenv("AJUN_FEISHU_COMMANDER_INGRESS_URL", ""),
            expected_path=_XIAOD_PUBLIC_VIDEO_INGRESS_PATH,
        )

    @staticmethod
    def _xiaod_public_video_receipt(
        body: Mapping[str, Any],
        *,
        source_event_ref: str,
        chat_id: str,
        requester_ref: str,
    ) -> Optional[str]:
        """Return the one verified task ID in an accepted A君 response.

        A 2xx alone is not a task acknowledgement: a clarification response
        also uses that status.  Require the task and card to identify the same
        dedicated 小D task *and* bind it to this Feishu source.  A synchronous
        terminal response may correctly omit ``completionWatch``; when it is
        present it is nevertheless fully validated before it can be trusted.
        """
        if not isinstance(body, Mapping):
            return None
        task = body.get("task")
        task_card = body.get("taskCard")
        completion_watch = body.get("completionWatch")
        if not isinstance(task, Mapping) or not isinstance(task_card, Mapping):
            return None
        if task_card.get("schemaVersion") != TASK_CARD_SCHEMA:
            return None
        task_id = _text(task.get("taskId"), 160)
        if not task_id or _text(task_card.get("taskId"), 160) != task_id:
            return None
        response_task_id = _text(body.get("taskId"), 160)
        if response_task_id and response_task_id != task_id:
            return None
        if (
            _text(task.get("taskType"), 80) != "media.transcribe-and-refine"
            or _text(task.get("assigneeAgentId"), 80) != "xiaod"
        ):
            return None
        source = task.get("source")
        requester = task.get("requester")
        if not isinstance(source, Mapping) or not isinstance(requester, Mapping):
            return None
        if (
            _text(source.get("channel"), 80) != "feishu"
            or _text(source.get("eventRef"), 320) != source_event_ref
            or _text(source.get("chatRef"), 320) != chat_id
            or _text(source.get("targetAgentId"), 80) != "xiaod"
            or _text(source.get("profileId"), 80) != "xiaod"
            or _text(requester.get("kind"), 80) != "feishu-user"
            or _text(requester.get("ref"), 320) != requester_ref
        ):
            return None
        if (
            _text(task_card.get("agentId"), 80) != "xiaod"
            or _text(task_card.get("profileId"), 80) != "xiaod"
            or _text(task_card.get("chatId"), 320) != chat_id
            or _text(task_card.get("taskKind"), 80) != "media.transcribe-and-refine"
        ):
            return None
        if completion_watch is not None:
            if not isinstance(completion_watch, Mapping):
                return None
            if (
                _text(completion_watch.get("kind"), 80) != "ajun_task"
                or _text(completion_watch.get("taskId"), 160) != task_id
                or not _strict_loopback_http_url(
                    f"{completion_watch.get('baseUrl') or ''}/api/feishu/task-status",
                    expected_path="/api/feishu/task-status",
                )
            ):
                return None
        return task_id

    @staticmethod
    def _xiaod_public_video_route_key(source_event_ref: str, text: str) -> str:
        """Keep exact redelivery idempotent without hiding changed content.

        A Feishu delivery retry has the same event ID *and* body.  A malformed
        or conflicting replay with the same event ID but a different URL must
        still reach A君, whose durable idempotency layer can reject or reconcile
        that conflict instead of Hermes silently treating it as delivered.
        """
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
        return f"{source_event_ref}\x1f{digest}"

    def _mark_xiaod_public_video_event_delivered(self, route_key: str) -> None:
        with self._lock:
            if len(self._xiaod_public_video_event_refs) >= 2048:
                self._xiaod_public_video_event_refs.clear()
            self._xiaod_public_video_event_refs.add(route_key)

    def _finish_xiaod_public_video_route(
        self, route_key: str, task: asyncio.Task[Any]
    ) -> None:
        """Collect a background route result so exceptions cannot be orphaned."""
        with self._lock:
            if self._xiaod_public_video_route_tasks.get(route_key) is task:
                self._xiaod_public_video_route_tasks.pop(route_key, None)
            self._xiaod_public_video_inflight_refs.discard(route_key)
        try:
            task.result()
        except asyncio.CancelledError:
            self._logger.debug("[Feishu] 小D public-video registration cancelled")
        except Exception:
            self._logger.exception("[Feishu] 小D public-video registration crashed")

    async def stop_xiaod_public_video_routes(self) -> None:
        """Cancel lifecycle-owned public-video registration work on disconnect."""
        with self._lock:
            tasks = list(self._xiaod_public_video_route_tasks.values())
        for task in tasks:
            if not task.done():
                task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        with self._lock:
            self._xiaod_public_video_route_tasks.clear()
            self._xiaod_public_video_inflight_refs.clear()

    @staticmethod
    def _is_plain_text_event(event: Any) -> bool:
        if getattr(event, "media_urls", None) or getattr(event, "media_types", None):
            return False
        is_command = getattr(event, "is_command", None)
        if callable(is_command) and is_command():
            return False
        message_type = str(getattr(event, "message_type", "") or "").lower()
        return not message_type or message_type.endswith("text")

    async def route_xiaod_public_video_event(self, event: Any) -> bool:
        """Handle only the dedicated 小D bare-public-video ingress.

        This wrapper runs inside Hermes' existing ``handle_message`` call, so
        text batching and the host's per-chat lock already happened.  Returning
        ``True`` consumes recognised intake even if local routing is unavailable;
        it must never fall through to generic model chat after a failed route.
        """
        if not self._xiaod_public_video_profile() or not self._is_plain_text_event(event):
            return False
        text = str(getattr(event, "text", "") or "").strip()
        if not _is_supported_xiaod_video_url(text):
            return False
        source = getattr(event, "source", None)
        chat_id = str(getattr(source, "chat_id", "") or "").strip()
        # The normalized Hermes SessionSource is the one identity that already
        # passed Feishu admission.  Do not trust ad-hoc event ``sender_id``
        # fields, which are absent on real MessageEvent and can be spoofed by
        # synthetic/test event shapes.
        requester_ref = str(
            getattr(source, "user_id", "") or getattr(source, "user_id_alt", "") or ""
        ).strip()
        message_id = str(getattr(event, "message_id", "") or "").strip()

        async def reply(message: str) -> None:
            if chat_id:
                await self.host.send(chat_id, message, reply_to=message_id or None)

        if not message_id:
            await reply("小D无法登记这条公开视频链接：缺少稳定消息编号；没有启动下载、转录或外部动作。")
            return True
        if not requester_ref:
            await reply("小D无法登记这条公开视频链接：缺少可验证的飞书用户身份；没有启动下载、转录或外部动作。")
            return True
        ingress_url = self._xiaod_public_video_ingress_url()
        if not ingress_url:
            await reply("小D的公开视频任务入口未配置或不符合本机回环安全规则；没有启动下载、转录或外部动作。")
            return True
        source_event_ref = f"feishu:{message_id}"
        route_key = self._xiaod_public_video_route_key(source_event_ref, text)
        with self._lock:
            if (
                route_key in self._xiaod_public_video_event_refs
                or route_key in self._xiaod_public_video_inflight_refs
            ):
                return True
            self._xiaod_public_video_inflight_refs.add(route_key)

        async def complete_route() -> None:
            payload = json.dumps({
                # A君 uses this original Feishu event reference as its durable
                # idempotency key, including when Hermes restarts and redelivers it.
                "sourceEventRef": source_event_ref,
                "text": text,
                "chatRef": chat_id,
                "requesterRef": requester_ref,
                "targetAgentId": "xiaod",
                "profileId": "xiaod",
                "taskCardPolicy": (
                    os.getenv("AGENT_ARMY_TASK_CARD_POLICY", "")
                    or os.getenv("AGENT_ARMY_FEISHU_TASK_CARD_POLICY", "")
                ).strip(),
            }, ensure_ascii=False).encode("utf-8")

            def post_to_ajun() -> tuple[int, Dict[str, Any]]:
                request = Request(
                    ingress_url,
                    data=payload,
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with urlopen(request, timeout=_XIAOD_PUBLIC_VIDEO_INGRESS_TIMEOUT_SECONDS) as response:
                    body = json.loads(response.read().decode("utf-8"))
                    return int(response.status), body if isinstance(body, dict) else {}

            try:
                status, body = await asyncio.wait_for(
                    self.host._run_blocking(post_to_ajun),
                    timeout=_XIAOD_PUBLIC_VIDEO_INGRESS_TIMEOUT_SECONDS,
                )
            except asyncio.TimeoutError:
                await reply("小D等待本机任务登记超时，不能确认任务是否建立；这条消息未标记为成功，可按原链接稍后重试。")
                return
            except (HTTPError, URLError, OSError, ValueError, json.JSONDecodeError) as exc:
                self._logger.warning("[Feishu] 小D public-video A君 ingress failed: %s", exc)
                await reply("小D暂时没有收到可验证的任务登记回执，不能确认任务是否建立；这条消息未标记为成功，可按原链接稍后重试。")
                return
            if status not in {200, 201, 202}:
                self._logger.warning("[Feishu] 小D public-video A君 ingress returned status=%s", status)
                await reply("小D暂时没有收到可验证的任务登记回执，不能确认任务是否建立；这条消息未标记为成功，可按原链接稍后重试。")
                return
            task_id = self._xiaod_public_video_receipt(
                body,
                source_event_ref=source_event_ref,
                chat_id=chat_id,
                requester_ref=requester_ref,
            )
            if not task_id:
                self._logger.warning("[Feishu] 小D public-video A君 ingress returned an unverifiable receipt")
                await reply("小D收到的登记回执与本条飞书来源不一致或不完整，不能确认任务已建立；这条消息未标记为成功，可按原链接稍后重试。")
                return
            self._mark_xiaod_public_video_event_delivered(route_key)
            delivered = await self.handle_trusted_task_result(
                type("FeishuTaskSource", (), {"chat_id": chat_id, "message_id": message_id})(),
                {"structuredContent": body},
            )
            if not delivered:
                acknowledgement = body.get("reply") if isinstance(body, dict) else None
                response = (
                    acknowledgement
                    if isinstance(acknowledgement, str) and acknowledgement.strip()
                    else "小D已登记这条公开视频链接，正在按任务链处理。"
                )
                if body.get("completionWatch") is None:
                    response += "\n\n说明：本次回执没有自动完成回告监听；请以任务状态为准。"
                await reply(response)

        try:
            task = asyncio.create_task(complete_route())
            with self._lock:
                self._xiaod_public_video_route_tasks[route_key] = task
            task.add_done_callback(
                lambda completed: self._finish_xiaod_public_video_route(route_key, completed)
            )
        except RuntimeError as exc:
            with self._lock:
                self._xiaod_public_video_inflight_refs.discard(route_key)
            self._logger.warning("[Feishu] 小D public-video route could not start: %s", exc)
            await reply("小D暂时无法开始本机任务登记；没有启动下载、转录或外部动作，请稍后重试。")
        return True

    def _save(self, records: Mapping[str, Mapping[str, Any]]) -> None:
        with self._lock:
            temporary = self._path.with_name(f"{self._path.name}.{uuid.uuid4()}.tmp")
            try:
                with temporary.open("x", encoding="utf-8") as handle:
                    handle.write(json.dumps(records, ensure_ascii=False))
                os.chmod(temporary, 0o600)
                temporary.replace(self._path)
                os.chmod(self._path, 0o600)
            except OSError as exc:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass
                raise RuntimeError("dynamic task card ledger write failed; delivery stopped") from exc

    def _load(self) -> Dict[str, Dict[str, Any]]:
        with self._lock:
            try:
                if not self._path.exists() and self._legacy_path.exists():
                    legacy = json.loads(self._legacy_path.read_text(encoding="utf-8"))
                    migrated: Dict[str, Dict[str, Any]] = {}
                    if isinstance(legacy, dict):
                        for legacy_task_id, legacy_record in legacy.items():
                            if not isinstance(legacy_record, dict):
                                continue
                            identity = self.identity(chat_id=str(legacy_record.get("chat_id") or ""))
                            record = dict(legacy_record)
                            record.update({
                                "task_id": str(record.get("task_id") or legacy_task_id),
                                "agent_id": identity["agentId"],
                                "profile_id": identity["profileId"],
                            })
                            record_key = self.key(
                                task_id=record["task_id"],
                                chat_id=str(record.get("chat_id") or ""),
                                agent_id=record["agent_id"],
                                profile_id=record["profile_id"],
                            )
                            migrated[record_key] = record
                    self._save(migrated)
                payload = json.loads(self._path.read_text(encoding="utf-8"))
                if not isinstance(payload, dict):
                    raise ValueError("dynamic task card ledger must be an object")
                return payload
            except FileNotFoundError:
                return {}
            except (OSError, ValueError, json.JSONDecodeError) as exc:
                raise RuntimeError(
                    "dynamic task card ledger is unreadable; refusing duplicate delivery"
                ) from exc

    def _put(self, record: Mapping[str, Any]) -> None:
        record_key = self.key(
            task_id=str(record.get("task_id") or ""),
            chat_id=str(record.get("chat_id") or ""),
            agent_id=str(record.get("agent_id") or ""),
            profile_id=str(record.get("profile_id") or ""),
        )
        with self._lock:
            records = self._load()
            records[record_key] = dict(record)
            self._save(records)

    def start(self) -> None:
        if not self.enabled():
            return
        if self._supervisor_task is None or self._supervisor_task.done():
            self._supervisor_task = asyncio.create_task(self._supervise())

    def wake(self) -> None:
        self.start()
        if self._supervisor_task is not None:
            self._wake.set()

    def mark_final_suppression(self, chat_id: str) -> None:
        if chat_id:
            self._suppress_final_by_chat[chat_id] = time.time() + 120

    def consume_final_suppression(self, chat_id: str) -> bool:
        return float(self._suppress_final_by_chat.pop(chat_id, 0) or 0) >= time.time()

    async def debounce(
        self,
        *,
        chat_id: str,
        projection: Dict[str, Any],
        completion_watch: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Wait five seconds before the first anchor; fast terminal tasks stay text-only."""
        del completion_watch
        task_id = str(projection.get("taskId") or "")
        identity = self.identity(chat_id=chat_id, projection=projection)
        record_key = self.key(
            task_id=task_id,
            chat_id=identity["chatId"],
            agent_id=identity["agentId"],
            profile_id=identity["profileId"],
        )
        if isinstance(self._load().get(record_key), dict):
            return {"projection": projection}
        if projection.get("terminal") is True:
            return {"projection": None}
        await asyncio.sleep(5)
        base_url = self.base_url()
        if not base_url:
            return {"projection": None}
        payload = json.dumps({
            "taskId": task_id,
            "agentId": identity["agentId"],
            "profileId": identity["profileId"],
            "chatId": identity["chatId"],
            "chatRef": identity["chatId"],
        }, ensure_ascii=False).encode("utf-8")

        def read_projection() -> dict:
            request = Request(
                f"{base_url}/api/feishu/task-status",
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urlopen(request, timeout=5) as response:
                return json.loads(response.read().decode("utf-8"))

        try:
            body = await self.host._run_blocking(read_projection)
            latest = body.get("taskCard") if isinstance(body, dict) else None
            message = str(body.get("message") or "") if isinstance(body, dict) else ""
            if not isinstance(latest, dict) or latest.get("terminal") is True:
                return {"projection": None, "message": message}
            latest.update(identity)
            latest["taskCardPolicy"] = self.policy()
            return {"projection": latest}
        except (HTTPError, URLError, OSError, ValueError, json.JSONDecodeError) as exc:
            self._logger.warning(
                "[Feishu] Dynamic task card debounce lookup failed; using text fallback: %s", exc
            )
            return {"projection": None}

    @staticmethod
    def _structured_result(result: Any) -> Optional[Dict[str, Any]]:
        wrapper = json.loads(result) if isinstance(result, str) else result
        if not isinstance(wrapper, dict):
            return None
        nested = wrapper.get("result")
        if isinstance(nested, str):
            try:
                nested = json.loads(nested)
            except (ValueError, json.JSONDecodeError):
                nested = None
        structured = wrapper.get("structuredContent")
        if not isinstance(structured, dict) and isinstance(nested, dict):
            structured = nested.get("structuredContent")
            if not isinstance(structured, dict):
                structured = nested
        return structured if isinstance(structured, dict) else None

    async def handle_trusted_task_result(self, source: Any, result: Any) -> bool:
        """Consume only structured MCP results; model prose never creates a card."""
        if not self.enabled():
            return False
        chat_id = str(getattr(source, "chat_id", "") or "")
        if not chat_id:
            return False
        try:
            structured = self._structured_result(result)
            if not isinstance(structured, dict):
                return False
            task_card = structured.get("taskCard")
            task_card = task_card if isinstance(task_card, dict) else None
            completion_watch = structured.get("completionWatch")
            completion_watch = completion_watch if isinstance(completion_watch, dict) else None
            task_id = str(
                (task_card or {}).get("taskId")
                or structured.get("taskId")
                or (completion_watch or {}).get("taskId")
                or ""
            ).strip()
            if not task_id:
                return False
            identity = self.identity(chat_id=chat_id, projection=task_card)
            record_key = self.key(
                task_id=task_id,
                chat_id=chat_id,
                agent_id=identity["agentId"],
                profile_id=identity["profileId"],
            )
            existing = self._load().get(record_key)
            if task_card is None and completion_watch is None and not isinstance(existing, dict):
                return False
            if task_card is None:
                task_card = {"schemaVersion": TASK_CARD_SCHEMA, "taskId": task_id, **identity}
            debounced = (
                {"projection": task_card}
                if isinstance(existing, dict)
                else await self.debounce(
                    chat_id=chat_id,
                    projection=task_card,
                    completion_watch=completion_watch,
                )
            )
            latest = debounced.get("projection") if isinstance(debounced, dict) else None
            if not isinstance(latest, dict):
                return False
            latest.update(identity)
            latest["taskCardPolicy"] = self.policy()
            if not task_card_policy_decision(latest, latest["taskCardPolicy"])["allowed"]:
                return False
            delivered = await self.deliver(
                chat_id=chat_id,
                projection=latest,
                reply_to=str(getattr(source, "message_id", "") or "") or None,
                completion_watch=completion_watch,
            )
            if delivered and latest.get("terminal") is not True:
                self.mark_final_suppression(chat_id)
            return delivered
        except (RuntimeError, ValueError, TypeError, json.JSONDecodeError) as exc:
            self._logger.warning(
                "[Feishu] Structured task result ignored; text delivery continues: %s", exc
            )
            return False

    async def deliver(
        self,
        *,
        chat_id: str,
        projection: Dict[str, Any],
        reply_to: Optional[str] = None,
        completion_watch: Optional[Dict[str, Any]] = None,
    ) -> bool:
        del completion_watch
        try:
            task_id = str(projection.get("taskId") or "")
            if not task_id:
                return False
            identity = self.identity(chat_id=chat_id, projection=projection)
            projection.update(identity)
            projection["taskCardPolicy"] = self.policy()
            record_key = self.key(
                task_id=task_id,
                chat_id=identity["chatId"],
                agent_id=identity["agentId"],
                profile_id=identity["profileId"],
            )
            try:
                records = self._load()
            except RuntimeError as exc:
                self._logger.error(
                    "[Feishu] Dynamic task card ledger unreadable; fallback suppressed: %s", exc
                )
                return True
            previous = records.get(record_key) if isinstance(records.get(record_key), dict) else None
            decision = decide_task_card_delivery(previous, projection)
            operation = str(decision.get("operation") or "")
            if operation in {"skip", "anchor_uncertain"}:
                return True
            card = render_task_card(
                projection,
                details_expanded=bool(previous and previous.get("details_expanded")),
            )
            now = time.time()
            source_revision = projection.get("sourceRevision")
            content_hash = str(projection.get("contentHash") or "")
            base_url = self.base_url() or str((previous or {}).get("base_url") or "")

            if operation == "update" and previous:
                message_id = str(decision.get("messageId") or previous.get("message_id") or "")
                if not message_id or not await self._update(message_id=message_id, card=card):
                    return True
                record = dict(previous)
                record.update({
                    "last_source_revision": source_revision,
                    "last_content_hash": content_hash,
                    "last_notified_state": str(projection.get("state") or ""),
                    "delivery_state": "sent",
                    "updated_at": now,
                    "terminal": projection.get("terminal") is True,
                })
                try:
                    self._put(record)
                except RuntimeError as exc:
                    self._logger.error(
                        "[Feishu] Dynamic task card was updated but its ledger could not advance: %s",
                        exc,
                    )
                    return True
                if not record["terminal"]:
                    self.wake()
                return True

            record = {
                "task_id": task_id,
                "chat_id": chat_id,
                "message_id": "",
                "delivery_id": str(uuid.uuid4()),
                "agent_id": identity["agentId"],
                "profile_id": identity["profileId"],
                "profile_fingerprint": hashlib.sha256(str(self._home).encode("utf-8")).hexdigest()[:24],
                "last_source_revision": source_revision,
                "last_content_hash": content_hash,
                "last_notified_state": str(projection.get("state") or ""),
                "delivery_state": "sending",
                "attempt_count": int((previous or {}).get("attempt_count", 0) or 0) + 1,
                "base_url": base_url,
                "created_at": now,
                "updated_at": now,
                "next_poll_at": now,
                "terminal": projection.get("terminal") is True,
            }
            try:
                self._put(record)
            except RuntimeError as exc:
                self._logger.error(
                    "[Feishu] Dynamic task card intent was not persisted; send skipped: %s", exc
                )
                return False
            try:
                provider_response = await self.host._feishu_send_with_retry(
                    chat_id=chat_id,
                    msg_type="interactive",
                    payload=json.dumps(card, ensure_ascii=False),
                    reply_to=reply_to,
                    metadata=None,
                )
            except Exception as exc:
                record.update({"delivery_state": "anchor_uncertain", "updated_at": time.time()})
                try:
                    self._put(record)
                except RuntimeError as ledger_exc:
                    self._logger.error(
                        "[Feishu] Dynamic card outcome uncertain and ledger update failed: %s",
                        ledger_exc,
                    )
                self._logger.warning(
                    "[Feishu] Dynamic task card send outcome is uncertain; duplicate fallback suppressed: %s",
                    exc,
                )
                return True
            send_result = self.host._finalize_send_result(
                provider_response, "send Agent Army dynamic task card failed"
            )
            try:
                current = self._load().get(record_key)
            except RuntimeError as exc:
                self._logger.error(
                    "[Feishu] Dynamic task card provider call completed but ledger became unreadable: %s",
                    exc,
                )
                return True
            record = current if isinstance(current, dict) else record
            if send_result.success and send_result.message_id:
                record.update({
                    "message_id": send_result.message_id,
                    "delivery_state": "sent",
                    "last_notified_state": str(projection.get("state") or ""),
                    "updated_at": time.time(),
                })
            elif send_result.success:
                record.update({"delivery_state": "anchor_uncertain", "updated_at": time.time()})
            else:
                record.update({"delivery_state": "not_started", "updated_at": time.time()})
            try:
                self._put(record)
            except RuntimeError as exc:
                self._logger.error(
                    "[Feishu] Dynamic task card provider call completed but ledger update failed: %s", exc
                )
                return True
            if record.get("delivery_state") == "sent" and not record.get("terminal"):
                self.wake()
            return bool(send_result.success)
        except Exception as exc:
            self._logger.warning(
                "[Feishu] Dynamic task card delivery failed; using text fallback when safe: %s", exc
            )
            return False

    async def _update(self, *, message_id: str, card: Dict[str, Any]) -> bool:
        try:
            from lark_oapi.api.im.v1 import PatchMessageRequest, PatchMessageRequestBody

            body = PatchMessageRequestBody.builder().content(
                json.dumps(card, ensure_ascii=False)
            ).build()
            request = PatchMessageRequest.builder().message_id(message_id).request_body(body).build()
            response = await self.host._run_blocking(
                self.host._client.im.v1.message.patch, request
            )
            if response and getattr(response, "success", lambda: False)():
                return True
            self._logger.warning(
                "[Feishu] Dynamic task card update rejected: code=%s",
                getattr(response, "code", None),
            )
        except Exception as exc:
            self._logger.warning("[Feishu] Dynamic task card update failed: %s", exc)
        return False

    async def _supervise(self) -> None:
        semaphore = asyncio.Semaphore(SUPERVISOR_MAX_CONCURRENCY)
        while self.enabled():
            now = time.time()
            records = self._load()
            due = [
                dict(record)
                for record in records.values()
                if isinstance(record, dict)
                and record.get("delivery_state") == "sent"
                and not record.get("terminal")
                and str(record.get("base_url") or "").startswith("http://127.0.0.1:")
                and float(record.get("next_poll_at", 0) or 0) <= now
            ]

            async def bounded(record: Dict[str, Any]) -> None:
                async with semaphore:
                    await self._poll_one(record)

            if due:
                await asyncio.gather(*(bounded(record) for record in due))
                continue
            self._wake.clear()
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=2)
            except asyncio.TimeoutError:
                pass

    async def _poll_one(self, record: Dict[str, Any]) -> None:
        task_id = str(record.get("task_id") or "")
        chat_id = str(record.get("chat_id") or "")
        base_url = str(record.get("base_url") or "").rstrip("/")
        try:
            payload = json.dumps({
                "taskId": task_id,
                "agentId": str(record.get("agent_id") or ""),
                "profileId": str(record.get("profile_id") or ""),
                "chatId": chat_id,
                "chatRef": chat_id,
            }, ensure_ascii=False).encode("utf-8")

            def read_projection() -> dict:
                request = Request(
                    f"{base_url}/api/feishu/task-status",
                    data=payload,
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with urlopen(request, timeout=5) as response:
                    return json.loads(response.read().decode("utf-8"))

            body = await self.host._run_blocking(read_projection)
            projection = body.get("taskCard") if isinstance(body, dict) else None
            if isinstance(projection, dict):
                await self.deliver(chat_id=chat_id, projection=projection)
        except asyncio.CancelledError:
            raise
        except (HTTPError, URLError, OSError, ValueError, json.JSONDecodeError) as exc:
            self._logger.warning("[Feishu] Dynamic task card projection lookup failed: %s", exc)
        finally:
            records = self._load()
            record_key = self.key(
                task_id=task_id,
                chat_id=chat_id,
                agent_id=str(record.get("agent_id") or ""),
                profile_id=str(record.get("profile_id") or ""),
            )
            current = records.get(record_key)
            if isinstance(current, dict) and not current.get("terminal"):
                now = time.time()
                age = max(0, now - float(current.get("created_at", now) or now))
                current["next_poll_at"] = now + poll_interval_seconds(age_seconds=age)
                current["updated_at"] = now
                self._put(current)

    def handle_action(self, *, event: Any, action_value: Mapping[str, Any]) -> Any:
        action = str(action_value.get("agent_army_task_card_action") or "")
        task_id = str(action_value.get("task_id") or action_value.get("taskId") or "")
        source_revision = action_value.get("source_revision")
        content_hash = str(action_value.get("content_hash") or "")
        approval_id = str(action_value.get("approval_id") or "")
        governance_mode = str(action_value.get("governance_mode") or "local")
        operator = getattr(event, "operator", None)
        open_id = str(getattr(operator, "open_id", "") or "")
        context = getattr(event, "context", None)
        chat_id = str(getattr(context, "open_chat_id", "") or "")
        message_id = str(getattr(context, "open_message_id", "") or "")
        response_type = self._symbols.get("P2CardActionTriggerResponse")
        response = response_type() if response_type else None

        def error_response(content: str) -> Any:
            if response is not None:
                try:
                    from lark_oapi.event.callback.model.p2_card_action_trigger import CallBackToast

                    toast = CallBackToast()
                    toast.type = "error"
                    toast.content = content
                    response.toast = toast
                except ImportError:
                    pass
            return response

        try:
            records = self._load()
        except RuntimeError as exc:
            self._logger.error("[Feishu] Dynamic task card callback ledger unreadable: %s", exc)
            return error_response("卡片记录暂时不可读取，本次操作未生效。")
        identity = self.identity(chat_id=chat_id)
        action_agent_id = str(action_value.get("agentId") or "")
        action_profile_id = str(action_value.get("profileId") or "")
        action_chat_id = str(action_value.get("chatId") or "")
        record_key = self.key(
            task_id=task_id,
            chat_id=chat_id,
            agent_id=identity["agentId"],
            profile_id=identity["profileId"],
        )
        record = records.get(record_key) if isinstance(records.get(record_key), dict) else None
        valid = (
            action in {"approve", "reject", "pause", "resume", "refresh", "details", "collapse_details"}
            and task_id
            and message_id
            and record
            and str(record.get("message_id") or "") == message_id
            and str(record.get("chat_id") or "") == chat_id
            and str(record.get("agent_id") or "") == identity["agentId"] == action_agent_id
            and str(record.get("profile_id") or "") == identity["profileId"] == action_profile_id
            and action_chat_id == chat_id
            and self.host._is_interactive_operator_authorized(open_id)
        )
        if not valid:
            return error_response("无法确认这张卡片的来源，本次操作未生效。")
        base_url = self.base_url()
        if not base_url:
            return error_response("任务入口不可用，本次操作未生效。")
        if action in {"refresh", "details", "collapse_details"}:
            endpoint = f"{base_url}/api/feishu/task-status"
            request_body = {
                "taskId": task_id,
                "agentId": identity["agentId"],
                "profileId": identity["profileId"],
                "chatId": chat_id,
                "chatRef": chat_id,
            }
        else:
            endpoint = f"{base_url}/api/feishu/task-card-actions"
            request_body = {
                "taskId": task_id,
                "action": action,
                "approvalId": approval_id,
                "governanceMode": governance_mode,
                "sourceRevision": source_revision,
                "contentHash": content_hash,
                "requesterRef": open_id,
                "chatRef": chat_id,
                "chatId": chat_id,
                "agentId": identity["agentId"],
                "profileId": identity["profileId"],
                "messageId": message_id,
            }
        try:
            request = Request(
                endpoint,
                data=json.dumps(request_body, ensure_ascii=False).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urlopen(request, timeout=8) as provider_response:
                status = int(provider_response.status)
                body = json.loads(provider_response.read().decode("utf-8"))
            projection = body.get("taskCard") if isinstance(body, dict) else None
            if status not in {200, 201, 202} or not isinstance(projection, dict):
                raise ValueError("authoritative decision was not accepted")
            projection.update(identity)
            projection["taskCardPolicy"] = self.policy()
            details_expanded = action == "details" or (
                action not in {"details", "collapse_details"}
                and bool(record.get("details_expanded"))
            )
            decided_card = render_task_card(projection, details_expanded=details_expanded)
            record["details_expanded"] = details_expanded
            record["next_poll_at"] = 0
            self._put(record)
            self.wake()
            callback_card_type = self._symbols.get("CallBackCard")
            if response is not None and callback_card_type is not None:
                card = callback_card_type()
                card.type = "raw"
                card.data = decided_card
                response.card = card
                try:
                    from lark_oapi.event.callback.model.p2_card_action_trigger import CallBackToast

                    toast = CallBackToast()
                    toast.type = "success"
                    toast.content = str(
                        "已展开任务详情。"
                        if action == "details"
                        else "已收起任务详情。"
                        if action == "collapse_details"
                        else body.get("message")
                        or ("已刷新到最新状态。" if action == "refresh" else "操作已处理。")
                    )[:120]
                    response.toast = toast
                except ImportError:
                    pass
            return response
        except (HTTPError, URLError, OSError, ValueError, json.JSONDecodeError) as exc:
            self._logger.warning(
                "[Feishu] Dynamic task card action rejected without changing card: %s", exc
            )
            return error_response("操作未生效，请重试。")


def install_agent_army_feishu_task_card_adapter(
    host_class: type,
    *,
    hermes_version: str,
    hermes_git_commit: str,
    host_symbols: Mapping[str, Any],
) -> type:
    """Install the pinned Adapter at an explicit Hermes plugin Seam.

    Installation is idempotent.  Unsupported versions or missing host methods
    raise before an Adapter instance is created, so Hermes upgrades fail closed
    instead of receiving guessed source edits.
    """
    if hermes_version != SUPPORTED_HERMES_VERSION:
        raise HermesTaskCardCompatibilityError(
            f"unsupported Hermes version {hermes_version!r}; expected {SUPPORTED_HERMES_VERSION!r}"
        )
    if hermes_git_commit != SUPPORTED_HERMES_GIT_COMMIT:
        raise HermesTaskCardCompatibilityError(
            "unsupported Hermes Git identity; Adapter seam is pinned to "
            f"{SUPPORTED_HERMES_GIT_COMMIT}"
        )
    required_symbols = (
        "CallBackCard",
        "P2CardActionTriggerResponse",
        "SendResult",
        "get_hermes_home",
    )
    missing_symbols = [
        symbol_name
        for symbol_name in required_symbols
        if not callable(host_symbols.get(symbol_name))
    ]
    if missing_symbols:
        raise HermesTaskCardCompatibilityError(
            "Hermes Feishu Adapter interface changed; missing: "
            + ", ".join(sorted(missing_symbols))
        )
    if getattr(host_class, "__agent_army_task_card_seam__", None) == TASK_CARD_ADAPTER_SEAM:
        return host_class
    missing = [
        name
        for name in AgentArmyFeishuTaskCardAdapter.REQUIRED_HOST_INTERFACE
        if not callable(getattr(host_class, name, None))
    ]
    for lifecycle_method in ("__init__", "connect", "send", "handle_message", "_on_card_action_trigger"):
        if not callable(getattr(host_class, lifecycle_method, None)):
            missing.append(lifecycle_method)
    if missing:
        raise HermesTaskCardCompatibilityError(
            "Hermes Feishu Adapter interface changed; missing: " + ", ".join(sorted(set(missing)))
        )

    original_init = host_class.__init__
    original_connect = host_class.connect
    original_send = host_class.send
    original_handle_message = host_class.handle_message
    original_card_action = host_class._on_card_action_trigger
    original_disconnect = getattr(host_class, "disconnect", None)

    def adapter_for(instance: Any) -> AgentArmyFeishuTaskCardAdapter:
        adapter = getattr(instance, "_agent_army_task_card_adapter", None)
        if not isinstance(adapter, AgentArmyFeishuTaskCardAdapter):
            adapter = AgentArmyFeishuTaskCardAdapter(instance, host_symbols)
            instance._agent_army_task_card_adapter = adapter
        return adapter

    def patched_init(instance: Any, *args: Any, **kwargs: Any) -> None:
        original_init(instance, *args, **kwargs)
        patch_message = getattr(
            getattr(
                getattr(
                    getattr(instance, "_client", None),
                    "im",
                    None,
                ),
                "v1",
                None,
            ),
            "message",
            None,
        )
        if not callable(getattr(patch_message, "patch", None)):
            raise HermesTaskCardCompatibilityError(
                "Hermes Feishu Adapter interface changed; missing: _client.im.v1.message.patch"
            )
        adapter_for(instance)

    async def patched_connect(instance: Any, *args: Any, **kwargs: Any) -> Any:
        result = await original_connect(instance, *args, **kwargs)
        if result:
            adapter = adapter_for(instance)
            if adapter.enabled():
                adapter.start()
            else:
                restore = getattr(instance, "_restore_ajun_task_completion_notifications", None)
                if callable(restore):
                    restore()
        return result

    async def patched_send(instance: Any, chat_id: str, content: str, *args: Any, **kwargs: Any) -> Any:
        metadata = kwargs.get("metadata")
        if isinstance(metadata, dict) and metadata.get("notify") is True:
            if adapter_for(instance).consume_final_suppression(chat_id):
                result_type = host_symbols.get("SendResult")
                if result_type is None:
                    raise HermesTaskCardCompatibilityError("Hermes host is missing SendResult")
                return result_type(success=True)
        return await original_send(instance, chat_id, content, *args, **kwargs)

    async def patched_disconnect(instance: Any, *args: Any, **kwargs: Any) -> Any:
        # Hermes' real Feishu adapter awaits its owned background maps during
        # disconnect.  Do the same for the small route map added by this seam
        # before the transport/executor is torn down.
        await adapter_for(instance).stop_xiaod_public_video_routes()
        if callable(original_disconnect):
            return await original_disconnect(instance, *args, **kwargs)
        return None

    async def patched_handle_message(instance: Any, event: Any, *args: Any, **kwargs: Any) -> Any:
        # The host calls handle_message from _handle_message_with_guards, after
        # Feishu text batching and under its per-chat lock.  The recognised
        # route only schedules its bounded, lifecycle-owned local request here;
        # no 25-second local HTTP wait holds that lock.
        if await adapter_for(instance).route_xiaod_public_video_event(event):
            return None
        return await original_handle_message(instance, event, *args, **kwargs)

    def patched_card_action(instance: Any, data: Any) -> Any:
        event = getattr(data, "event", None)
        action = getattr(event, "action", None)
        action_value = getattr(action, "value", {}) or {}
        if isinstance(action_value, dict) and action_value.get("agent_army_task_card_action"):
            return adapter_for(instance).handle_action(event=event, action_value=action_value)
        return original_card_action(instance, data)

    delegates = {
        "_agent_army_task_card_policy": lambda self: adapter_for(self).policy(),
        "_agent_army_task_card_identity": lambda self, **kwargs: adapter_for(self).identity(**kwargs),
        "_agent_army_task_card_base_url": lambda self: adapter_for(self).base_url(),
        "_agent_army_task_card_key": lambda self, **kwargs: adapter_for(self).key(**kwargs),
        "_agent_army_dynamic_task_cards_enabled": lambda self: adapter_for(self).enabled(),
        "_load_agent_army_task_cards": lambda self: adapter_for(self)._load(),
        "_save_agent_army_task_cards": lambda self, records: adapter_for(self)._save(records),
        "_put_agent_army_task_card": lambda self, record: adapter_for(self)._put(record),
        "_start_agent_army_task_card_supervisor": lambda self: adapter_for(self).start(),
        "_wake_agent_army_task_card_supervisor": lambda self: adapter_for(self).wake(),
        "_mark_agent_army_final_suppression": lambda self, chat_id: adapter_for(self).mark_final_suppression(chat_id),
        "_consume_agent_army_final_suppression": lambda self, chat_id: adapter_for(self).consume_final_suppression(chat_id),
        "_debounce_agent_army_task_card": lambda self, **kwargs: adapter_for(self).debounce(**kwargs),
        "handle_agent_army_task_result": lambda self, source, result: adapter_for(self).handle_trusted_task_result(source, result),
        "_deliver_agent_army_task_card": lambda self, **kwargs: adapter_for(self).deliver(**kwargs),
        "_handle_agent_army_task_card_action": lambda self, **kwargs: adapter_for(self).handle_action(**kwargs),
    }
    host_class.__init__ = patched_init
    host_class.connect = patched_connect
    host_class.send = patched_send
    if callable(original_disconnect):
        host_class.disconnect = patched_disconnect
    host_class.handle_message = patched_handle_message
    host_class._on_card_action_trigger = patched_card_action
    for name, implementation in delegates.items():
        setattr(host_class, name, implementation)
    host_class.__agent_army_task_card_seam__ = TASK_CARD_ADAPTER_SEAM
    host_class.__agent_army_task_card_hermes_version__ = hermes_version
    host_class.__agent_army_task_card_hermes_git_commit__ = hermes_git_commit
    host_class.__agent_army_task_card_host_methods__ = tuple(sorted(delegates))
    return host_class

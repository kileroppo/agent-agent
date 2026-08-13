"""Deterministic Feishu task-card rendering and delivery decisions.

This module deliberately owns no task queue, persistence, or network client.
The Agent Army task service remains the authority for
``agent.army/task-card/v1`` and the Hermes adapter only uses these helpers to
render and advance one profile-scoped card anchor.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Iterable, Mapping, Optional
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo


TASK_CARD_SCHEMA = "agent.army/task-card/v1"
ALLOWED_ACTIONS = frozenset({"approve", "reject", "pause", "resume"})
SUPERVISOR_MAX_CONCURRENCY = 3
TASK_CARD_POLICIES = frozenset({"routed-task", "durable-task", "incident-only", "disabled"})

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

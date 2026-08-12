"""Deterministic Feishu task-card rendering and delivery decisions.

This module deliberately owns no task queue, persistence, or network client.
The AJun runtime remains the authority for ``agent.army/task-card/v1`` and the
Hermes adapter only uses these helpers to render and advance one card anchor.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Iterable, Mapping, Optional
from zoneinfo import ZoneInfo


TASK_CARD_SCHEMA = "agent.army/task-card/v1"
ALLOWED_ACTIONS = frozenset({"approve", "reject", "pause", "resume"})
SUPERVISOR_MAX_CONCURRENCY = 3

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
    "intel-researcher": "小研",
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


def render_task_card(projection: Mapping[str, Any]) -> Dict[str, Any]:
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

    facts = [f"**状态**：{state}"]
    if owner:
        facts.append(f"**负责人**：{owner}")
    body = f"{'　'.join(facts)}\n\n{summary}"
    elements: list[Dict[str, Any]] = [{"tag": "markdown", "content": body}]
    if next_action and "".join(next_action.split()) not in "".join(summary.split()):
        elements.append({"tag": "markdown", "content": f"**下一步**：{next_action}"})

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
                    "task_id": task_id,
                    "source_revision": revision,
                    "content_hash": content_hash,
                    "approval_id": action_view["approvalId"],
                    "governance_mode": action_view["governanceMode"],
                },
            }
        )
    if buttons:
        elements.append({"tag": "action", "actions": buttons})

    if projection.get("terminal") is not True:
        elements.append({
            "tag": "action",
            "actions": [{
                "tag": "button",
                "text": {"tag": "plain_text", "content": f"查看最新状态 · {task_ref}"[:80]},
                "type": "default",
                "value": {
                    "agent_army_task_card_action": "refresh",
                    "task_id": task_id,
                    "source_revision": revision,
                    "content_hash": content_hash,
                },
            }],
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
    record: Optional[Mapping[str, Any]], projection: Mapping[str, Any]
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

    if not record:
        return {"operation": "send", "reason": "anchor_missing", **common}
    recorded_task_id = _text(_field(record, "taskId", "task_id"), 160)
    if recorded_task_id and recorded_task_id != task_id:
        return {"operation": "skip", "reason": "task_mismatch", **common}

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

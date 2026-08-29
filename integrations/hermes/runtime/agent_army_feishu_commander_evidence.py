"""Locally decidable evidence for the Feishu commander chain (Hermes side).

When the local A君 runtime on 4321 is unreachable, the runtime cannot record
anything: only this side can leave a trace of "a Feishu message arrived, the
commander ingress failed, and this is what the user was told" (requirement 2.4).

Hard constraints:

* Pure standard library (json / hashlib / datetime / pathlib / os). No Hermes
  imports, no third-party packages, so it can never break adapter import.
* **Never raises.** Every failure returns ``False``. Evidence must not become a
  new failure mode on the very path that is already failing.
* No message text, no ``.env`` content, no token / cookie / authorization link.
  ``chat_ref`` and ``requester_ref`` only appear as the first 12 hex characters
  of their sha256 digest.
* Appends one JSON line to ``<hermes_home>/agent_army_commander_evidence-<YYYY-MM-DD>.jsonl``
  with mode 0600, next to the existing ``agent_army_task_cards.json`` ledger.

Python 3.9 compatible on purpose: the Hermes venv is not guaranteed to be newer.
"""

import hashlib
import json
import os
import re

from datetime import datetime, timezone
from pathlib import Path

EVIDENCE_SCHEMA = "agent.army/feishu-commander-chain-evidence/v1"
EVIDENCE_SIDE = "hermes-gateway"
EVIDENCE_FILE_PREFIX = "agent_army_commander_evidence-"

# Hermes-side kinds. `ingress_http_error` covers the Hermes view of a 403 from
# the local runtime; `degraded_notice_send_failed` is the "completely silent"
# case in requirement 2.4.
EVIDENCE_KINDS = (
    "ingress_unreachable",
    "ingress_http_error",
    "ingress_bad_response",
    "degraded_notice_sent",
    "degraded_notice_send_failed",
)

_OUTCOMES = {
    "ingress_unreachable": "本机 A君 总管入口不可达；未启动任何外部动作。",
    "ingress_http_error": "本机 A君 总管入口返回错误状态；未启动任何外部动作。",
    "ingress_bad_response": "本机 A君 总管入口返回了无法解析的响应；未启动任何外部动作。",
    "degraded_notice_sent": "已在飞书会话内发出可归因的降级说明；未启动任何外部动作。",
    "degraded_notice_send_failed": "降级说明发送失败，飞书会话内没有任何回复；未启动任何外部动作。",
}

_NEXT_STEP = "在本机执行 npm run diagnose:feishu-chain 逐项判定链路，并按输出的唯一下一步处理。"

_SECRET_SHAPED = (
    re.compile(r"sk-[A-Za-z0-9_-]{8,}"),
    re.compile(r"bearer\s+\S+", re.IGNORECASE),
    re.compile(r"[?&](?:token|access_token|api_key|apikey|key|secret|password|passwd)=", re.IGNORECASE),
    re.compile(r"\b(?:authorization|cookie|set-cookie)\b\s*[:=]", re.IGNORECASE),
    re.compile(r"\b[A-Za-z0-9+/]{40,}={0,2}\b"),
)

_MAX_TEXT_LENGTH = 300


def digest_ref(value):
    """Return ``sha256:<12 hex>`` for a non-empty string, otherwise ``None``."""
    try:
        text = value.strip() if isinstance(value, str) else ""
        if not text:
            return None
        return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]
    except Exception:
        return None


def resolve_hermes_home(hermes_home=None):
    """Mirror Hermes ``get_hermes_home()`` without importing Hermes."""
    candidate = hermes_home
    if candidate is None or (isinstance(candidate, str) and not candidate.strip()):
        candidate = os.environ.get("HERMES_HOME", "") or os.path.join(
            os.path.expanduser("~"), ".hermes"
        )
    return Path(str(candidate)).expanduser()


def evidence_file_path(hermes_home=None, now=None):
    moment = now if isinstance(now, datetime) else datetime.now(timezone.utc)
    day = moment.astimezone(timezone.utc).strftime("%Y-%m-%d")
    return resolve_hermes_home(hermes_home) / (EVIDENCE_FILE_PREFIX + day + ".jsonl")


def _text(value):
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    if not trimmed:
        return None
    return trimmed[:_MAX_TEXT_LENGTH]


def _contains_secret_shape(record):
    for field, value in record.items():
        if not isinstance(value, str) or not value:
            continue
        if field.endswith("Digest"):
            continue
        for pattern in _SECRET_SHAPED:
            if pattern.search(value):
                return True
    return False


def build_commander_chain_evidence(
    *,
    kind,
    source_event_ref,
    chat_ref=None,
    requester_ref=None,
    http_status=None,
    reason=None,
    profile_agent_id=None,
    now=None
):
    """Build one already-redacted evidence record. Returns ``None`` when invalid."""
    if kind not in EVIDENCE_KINDS:
        return None
    moment = now if isinstance(now, datetime) else datetime.now(timezone.utc)
    recorded_at = (
        moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.")
        + "%03dZ" % (moment.microsecond // 1000)
    )
    status = http_status if isinstance(http_status, int) and not isinstance(http_status, bool) else None
    record = {
        "schemaVersion": EVIDENCE_SCHEMA,
        "recordedAt": recorded_at,
        "side": EVIDENCE_SIDE,
        "kind": kind,
        # A Feishu message id is not a credential, and requirement 2.4 needs it
        # to align this record with one concrete message.
        "sourceEventRef": _text(source_event_ref),
        "chatRefDigest": digest_ref(chat_ref),
        "requesterRefDigest": digest_ref(requester_ref),
        "profileAgentId": _text(profile_agent_id),
        "httpStatus": status,
        "reason": _text(reason),
        "outcome": _OUTCOMES.get(kind, "本机记录了一次链路事实；未启动任何外部动作。"),
        "truthLayer": "reachable",
        "externalActionStarted": False,
        "nextStep": _NEXT_STEP,
    }
    if _contains_secret_shape(record):
        return None
    return record


def record_commander_chain_evidence(
    *,
    hermes_home=None,
    kind=None,
    source_event_ref=None,
    chat_ref=None,
    requester_ref=None,
    http_status=None,
    reason=None,
    profile_agent_id=None,
    now=None
):
    """Append one evidence line. Returns ``True`` only when it really landed."""
    try:
        record = build_commander_chain_evidence(
            kind=kind,
            source_event_ref=source_event_ref,
            chat_ref=chat_ref,
            requester_ref=requester_ref,
            http_status=http_status,
            reason=reason,
            profile_agent_id=profile_agent_id,
            now=now,
        )
        if record is None:
            return False
        target = evidence_file_path(hermes_home, now=now)
        target.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(record, ensure_ascii=False) + "\n"
        descriptor = os.open(str(target), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            os.write(descriptor, line.encode("utf-8"))
        finally:
            os.close(descriptor)
        try:
            os.chmod(str(target), 0o600)
        except OSError:
            pass
        return True
    except Exception:
        # Evidence writing must never raise on the failing path it observes.
        return False


def read_commander_chain_evidence(hermes_home=None, limit=200):
    """Read recent Hermes-side evidence records. Never raises; may return []."""
    records = []
    try:
        home = resolve_hermes_home(hermes_home)
        names = sorted(
            name
            for name in os.listdir(str(home))
            if name.startswith(EVIDENCE_FILE_PREFIX) and name.endswith(".jsonl")
        )
        for name in names:
            try:
                content = (home / name).read_text(encoding="utf-8")
            except OSError:
                continue
            for line in content.split("\n"):
                stripped = line.strip()
                if not stripped:
                    continue
                try:
                    parsed = json.loads(stripped)
                except ValueError:
                    continue
                if isinstance(parsed, dict):
                    records.append(parsed)
    except Exception:
        return []
    if isinstance(limit, int) and limit > 0:
        return records[-limit:]
    return records

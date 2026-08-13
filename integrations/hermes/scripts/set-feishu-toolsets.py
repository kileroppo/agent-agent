#!/usr/bin/env python3
"""Atomically replace one Hermes profile's Feishu toolset allowlist.

The helper is deliberately platform-specific and accepts no profile path or
arbitrary config key. HERMES_HOME selects the profile and Hermes' own config
API performs the read/write.
"""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import re
import sys
from typing import NoReturn

import yaml
from hermes_cli.config import load_config, save_config


_NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{0,127}$")
_ALLOWED_KEYS = {"schemaVersion", "expectedCurrent", "target"}
_APPROVED_TARGETS = {"clarify", "memory", "session_search", "skills"}
_SENSITIVE_EXACT_KEYS = {
    "api_key",
    "apikey",
    "access_key",
    "secret_key",
    "client_secret",
    "secret",
    "token",
    "access_token",
    "refresh_token",
    "auth_token",
    "bearer_token",
    "password",
    "passwd",
    "cookie",
    "authorization",
    "private_key",
    "credential",
    "credentials",
    "auth",
}
_SENSITIVE_KEY_SUFFIXES = (
    "_api_key",
    "_apikey",
    "_access_key",
    "_secret_key",
    "_secret",
    "_token",
    "_password",
    "_passwd",
    "_cookie",
    "_authorization",
    "_private_key",
    "_credential",
    "_credentials",
    "_auth",
)
_SAFE_SENSITIVE_CONTAINER_METADATA = {
    "type",
    "provider",
    "scheme",
    "method",
    "source",
    "key_env",
    "username",
    "user",
    "client_id",
    "tenant_id",
}


def _emit(
    *,
    status: str,
    code: str,
    changed: bool = False,
    state: dict | None = None,
) -> None:
    payload: dict[str, object] = {
        "schemaVersion": 1,
        "status": status,
        "code": code,
        "changed": changed,
    }
    if state is not None:
        payload["state"] = state
    sys.stdout.write(
        json.dumps(payload, sort_keys=True) + "\n"
    )


def _fail(code: str, exit_code: int) -> NoReturn:
    _emit(status="error", code=code)
    raise SystemExit(exit_code)


def _typed_names(
    value: object,
    field: str,
    *,
    approved: set[str] | None = None,
) -> list[str]:
    if not isinstance(value, list):
        _fail(f"{field}_not_typed_list", 2)
    if any(not isinstance(name, str) or not _NAME_PATTERN.fullmatch(name) for name in value):
        _fail(f"{field}_contains_invalid_name", 2)
    if len(value) != len(set(value)):
        _fail(f"{field}_contains_duplicates", 2)
    if approved is not None and any(name not in approved for name in value):
        _fail(f"{field}_contains_unapproved_name", 2)
    return sorted(value)


def _payload() -> tuple[list[str], list[str]]:
    try:
        value = json.load(sys.stdin)
    except (json.JSONDecodeError, UnicodeDecodeError):
        _fail("invalid_json", 2)
    if not isinstance(value, dict):
        _fail("payload_not_object", 2)
    if set(value) != _ALLOWED_KEYS or value.get("schemaVersion") != 1:
        _fail("invalid_payload_contract", 2)
    return (
        _typed_names(value.get("expectedCurrent"), "expected_current"),
        _typed_names(value.get("target"), "target", approved=_APPROVED_TARGETS),
    )


def _normalized_key(value: object) -> str:
    camel_normalized = re.sub(
        r"([a-z0-9])([A-Z])",
        r"\1_\2",
        str(value),
    ).lower()
    return re.sub(
        r"[^a-z0-9]+",
        "_",
        camel_normalized,
    ).strip("_").lower()


def _sensitive_key(value: object) -> bool:
    key = _normalized_key(value)
    return key in _SENSITIVE_EXACT_KEYS or any(
        key.endswith(suffix) for suffix in _SENSITIVE_KEY_SUFFIXES
    )


def _secret_reference(value: object) -> bool:
    if value is None or isinstance(value, bool):
        return True
    if not isinstance(value, str):
        return False
    candidate = value.strip().strip("\"'")
    return (
        not candidate
        or candidate in {"~", "***", "null"}
        or re.fullmatch(r"\$\{[A-Za-z_][A-Za-z0-9_]*\}", candidate) is not None
        or re.match(r"^(?:env|secret|paperclip-secret)://", candidate) is not None
    )


def _assert_secret_safe(
    value: object,
    *,
    sensitive_context: bool = False,
    depth: int = 0,
    ancestors: set[int] | None = None,
) -> None:
    if depth > 64:
        _fail("config_structure_unsafe", 4)
    if not isinstance(value, (dict, list)):
        if isinstance(value, str) and "=" in value:
            env_key, env_value = value.split("=", 1)
            if _sensitive_key(env_key) and not _secret_reference(env_value):
                _fail("embedded_secret_detected", 5)
        if sensitive_context and not _secret_reference(value):
            _fail("embedded_secret_detected", 5)
        return
    object_id = id(value)
    lineage = ancestors or set()
    if object_id in lineage:
        _fail("config_structure_unsafe", 4)
    next_lineage = {*lineage, object_id}
    if isinstance(value, list):
        for child in value:
            _assert_secret_safe(
                child,
                sensitive_context=sensitive_context,
                depth=depth + 1,
                ancestors=next_lineage,
            )
        return
    for raw_key, child in value.items():
        key = _normalized_key(raw_key)
        child_sensitive = _sensitive_key(raw_key)
        inherited_sensitive = sensitive_context and key not in _SAFE_SENSITIVE_CONTAINER_METADATA
        _assert_secret_safe(
            child,
            sensitive_context=child_sensitive or inherited_sensitive,
            depth=depth + 1,
            ancestors=next_lineage,
        )


def _audit_config_secrets() -> None:
    raw = sys.stdin.read(2 * 1024 * 1024 + 1)
    if len(raw) > 2 * 1024 * 1024:
        _fail("config_too_large", 4)
    try:
        parsed = yaml.safe_load(raw)
    except yaml.YAMLError:
        _fail("config_parse_failed", 4)
    _assert_secret_safe(parsed)
    _emit(status="safe", code="ok")


def _load_without_output() -> dict:
    # Hermes may print migration or managed-scope notices. They are intentionally
    # discarded so this process emits only the small structured result contract.
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            config = load_config()
    except SystemExit:
        _fail("config_operation_failed", 4)
    if not isinstance(config, dict):
        _fail("config_not_object", 4)
    return config


def _save_without_output(config: dict) -> None:
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            save_config(
                config,
                preserve_keys={("platform_toolsets", "feishu")},
                merge_existing=False,
            )
    except SystemExit:
        _fail("config_operation_failed", 4)


def _current_feishu_toolsets(config: dict) -> list[str]:
    platform_toolsets = config.get("platform_toolsets")
    if platform_toolsets is None:
        return []
    if not isinstance(platform_toolsets, dict):
        _fail("platform_toolsets_not_object", 4)
    current = platform_toolsets.get("feishu")
    if current is None:
        return []
    return _typed_names(current, "current")


def _safe_mcp_state(config: dict) -> dict | None:
    servers = config.get("mcp_servers")
    if servers is None:
        return None
    if not isinstance(servers, dict):
        _fail("mcp_servers_not_object", 4)
    server = servers.get("agent-army")
    if server is None:
        return None
    if not isinstance(server, dict):
        _fail("agent_army_mcp_not_object", 4)

    raw_args = server.get("args")
    args = raw_args if isinstance(raw_args, list) else []
    if any(not isinstance(item, str) for item in args):
        _fail("agent_army_mcp_args_not_typed_list", 4)

    raw_env = server.get("env")
    if isinstance(raw_env, dict):
        env = {str(key): value for key, value in raw_env.items()}
    elif isinstance(raw_env, list):
        env = {}
        for entry in raw_env:
            if not isinstance(entry, str) or "=" not in entry:
                continue
            key, value = entry.split("=", 1)
            env[key] = value
    else:
        env = {}

    scope_keys = {
        "AGENT_ARMY_AGENT_ID",
        "AGENT_ARMY_PROFILE_ID",
        "AGENT_ARMY_ALLOWED_AGENT_IDS",
        "AGENT_ARMY_ALLOWED_TASK_TYPES",
        "AGENT_ARMY_ALLOWED_MCP_TOOLS",
        "AGENT_ARMY_ALLOWED_LOCAL_AI_CAPABILITIES",
        "AGENT_ARMY_ALLOW_MISSIONS",
        "AGENT_ARMY_TASK_CARD_POLICY",
    }
    context_keys = {
        "PAPERCLIP_TASK_ID",
        "PAPERCLIP_RUN_ID",
        "PAPERCLIP_AGENT_ID",
        "PAPERCLIP_API_KEY",
    }
    safe_env: dict[str, str] = {}
    for key in scope_keys:
        raw_value = env.get(key)
        if not isinstance(raw_value, (str, int, float, bool)):
            continue
        value = str(raw_value)
        if key in {"AGENT_ARMY_AGENT_ID", "AGENT_ARMY_PROFILE_ID"}:
            if re.fullmatch(r"[a-z][a-z0-9-]{0,63}", value):
                safe_env[key] = value
        elif key == "AGENT_ARMY_ALLOW_MISSIONS":
            if value in {"true", "false"}:
                safe_env[key] = value
        elif key == "AGENT_ARMY_TASK_CARD_POLICY":
            if value in {"disabled", "routed-task", "durable-task", "incident-only"}:
                safe_env[key] = value
        else:
            names = [item.strip() for item in value.split(",") if item.strip()]
            if all(_NAME_PATTERN.fullmatch(name) for name in names):
                safe_env[key] = ",".join(names)
    for key in context_keys:
        if isinstance(env.get(key), str) and env[key]:
            safe_env[key] = f"${{{key}}}"

    command = str(server.get("command") or "")
    serialized_args = json.dumps(args, separators=(",", ":"), ensure_ascii=False)
    return {
        "enabled": server.get("enabled") is not False,
        "commandSha256": hashlib.sha256(command.encode()).hexdigest(),
        "argsSha256": hashlib.sha256(serialized_args.encode()).hexdigest(),
        "timeout": server.get("timeout") if isinstance(server.get("timeout"), (int, float)) else 0,
        "env": safe_env,
    }


def _safe_runtime_policy(config: dict) -> dict:
    agent = config.get("agent") if isinstance(config.get("agent"), dict) else {}
    guardrails = config.get("tool_loop_guardrails") if isinstance(config.get("tool_loop_guardrails"), dict) else {}
    compression = config.get("compression") if isinstance(config.get("compression"), dict) else {}
    memory = config.get("memory") if isinstance(config.get("memory"), dict) else {}
    sessions = config.get("sessions") if isinstance(config.get("sessions"), dict) else {}
    session_reset = config.get("session_reset") if isinstance(config.get("session_reset"), dict) else {}
    raw_effort = agent.get("reasoning_effort", "")
    reasoning_effort = "none" if raw_effort is False else str(raw_effort or "medium")
    return {
        "agent": {
            "maxTurns": int(agent.get("max_turns", 500)),
            "reasoningEffort": reasoning_effort,
            "apiMaxRetries": int(agent.get("api_max_retries", 3)),
        },
        "toolLoopGuardrails": {
            "hardStopEnabled": guardrails.get("hard_stop_enabled") is True,
        },
        "compression": {
            "enabled": compression.get("enabled") is not False,
            "threshold": float(compression.get("threshold", 0.5)),
            "targetRatio": float(compression.get("target_ratio", 0.2)),
            "protectFirstN": int(compression.get("protect_first_n", 3)),
            "protectLastN": int(compression.get("protect_last_n", 20)),
        },
        "memory": {
            "writeApproval": memory.get("write_approval") is not False,
            "nudgeInterval": int(memory.get("nudge_interval", 0)),
        },
        "sessions": {
            "autoPrune": sessions.get("auto_prune") is True,
            "retentionDays": int(sessions.get("retention_days", 90)),
        },
        "sessionReset": {
            "mode": str(session_reset.get("mode") or "none"),
            "idleMinutes": int(session_reset.get("idle_minutes", 1440)),
            "notify": session_reset.get("notify") is not False,
        },
    }


def _inspect() -> None:
    try:
        config = _load_without_output()
        _emit(
            status="inspected",
            code="ok",
            state={
                "mcp": _safe_mcp_state(config),
                "feishuToolsets": _current_feishu_toolsets(config),
                "runtimePolicy": _safe_runtime_policy(config),
            },
        )
    except SystemExit:
        raise
    except Exception:
        _fail("config_operation_failed", 4)


def _apply_toolsets() -> None:
    expected_current, target = _payload()
    try:
        config = _load_without_output()
        current = _current_feishu_toolsets(config)
        if current != expected_current:
            _fail("expected_current_mismatch", 3)
        if current == target:
            _emit(status="unchanged", code="ok")
            return

        platform_toolsets = config.setdefault("platform_toolsets", {})
        if not isinstance(platform_toolsets, dict):
            _fail("platform_toolsets_not_object", 4)
        platform_toolsets["feishu"] = target
        _save_without_output(config)
        verified = _current_feishu_toolsets(_load_without_output())
        if verified != target:
            _fail("write_verification_failed", 4)
        _emit(status="updated", code="ok", changed=True)
    except SystemExit:
        raise
    except Exception:
        _fail("config_operation_failed", 4)


def main() -> None:
    action = sys.argv[1] if len(sys.argv) == 2 else ""
    if action == "inspect":
        _inspect()
    elif action == "apply-toolsets":
        _apply_toolsets()
    elif action == "audit-config-secrets":
        _audit_config_secrets()
    else:
        _fail("unsupported_action", 2)


if __name__ == "__main__":
    main()

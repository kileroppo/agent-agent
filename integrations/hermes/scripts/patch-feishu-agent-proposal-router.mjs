#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultAdapter = path.join(process.env.HERMES_HOME || path.join(process.env.HOME || '', '.hermes', 'hermes-agent'), 'plugins/platforms/feishu/adapter.py');
const taskCardRuntimeSource = fileURLToPath(new URL('../runtime/agent_army_feishu_task_card.py', import.meta.url));

export function applyPatch(source) {
  let result = source;
  if (result.includes('AJUN_COMMANDER_INGRESS_PRECEDENCE_V1')) return finishFeishuExperiencePatches(upgradeFeishuSlashConfirmPatch(upgradeFeishuBusinessUiPatch(upgradeCommanderIngressTimeoutPatch(upgradeProposalTrialReadinessPatch(upgradeTaskControlCardPatch(result))))));
  if (result.includes('AJUN_COMMANDER_TASK_NOTIFY_V4')) return finishFeishuExperiencePatches(upgradeFeishuSlashConfirmPatch(upgradeFeishuBusinessUiPatch(upgradeCommanderIngressPrecedencePatch(upgradeCommanderIngressTimeoutPatch(upgradeProposalTrialReadinessPatch(upgradeTaskControlCardPatch(result)))))));
  if (result.includes('AJUN_COMMANDER_TASK_NOTIFY_V3')) return finishFeishuExperiencePatches(upgradeFeishuSlashConfirmPatch(upgradeFeishuBusinessUiPatch(upgradeCommanderIngressTimeoutPatch(upgradeProposalTrialReadinessPatch(upgradeTaskControlCardPatch(upgradeCommanderProgressNotificationPatch(result)))))));
  if (!result.includes('AJUN_FEISHU_COMMANDER_INGRESS_URL')) {
    if (result.includes('def _route_ajun_agent_proposal_event(')) result = upgradeLegacyProposalPatch(result);
    else {
      result = insert(result, '_XIAOD_HTTP_URL_RE = re.compile(r"https?://[^\\s<>\\u3002\\uff0c\\uff01\\uff1f]+", re.IGNORECASE)\n', `${proposalPattern}\n`);
      result = insert(result, '            if await self._route_xiaod_retry_query(event):\n                return\n            await self.handle_message(event)\n', '            if await self._route_xiaod_retry_query(event):\n                return\n            if await self._route_ajun_commander_event(event):\n                return\n            if await self._route_ajun_agent_proposal_event(event):\n                return\n            await self.handle_message(event)\n');
      result = insert(result, '    async def _route_xiaod_status_query(self, event: MessageEvent) -> bool:\n', `${commanderRouter}\n\n${proposalRouter}\n\n    async def _route_xiaod_status_query(self, event: MessageEvent) -> bool:\n`);
      result = insert(result, '        if await self._route_xiaod_retry_query(event):\n            return\n        if event.message_type == MessageType.TEXT', '        if await self._route_xiaod_retry_query(event):\n            return\n        if await self._route_ajun_commander_event(event):\n            return\n        if await self._route_ajun_agent_proposal_event(event):\n            return\n        if event.message_type == MessageType.TEXT');
    }
  }
  if (!result.includes('AJUN_APPROVAL_CARD_V2') && !result.includes('AJUN_APPROVAL_CARD_V1')) result = upgradeCommanderApprovalPatch(result);
  return finishFeishuExperiencePatches(upgradeFeishuSlashConfirmPatch(upgradeFeishuBusinessUiPatch(upgradeCommanderIngressPrecedencePatch(upgradeCommanderIngressTimeoutPatch(upgradeProposalTrialReadinessPatch(upgradeTaskControlCardPatch(upgradeCommanderProgressNotificationPatch(upgradeCommanderCompletionPersistencePatch(upgradeCommanderCompletionPatch(result))))))))));
}

function finishFeishuExperiencePatches(source) {
  return upgradeDynamicTaskCardPatch(upgradeFeishuReactionReliabilityPatch(
    upgradeFeishuImmediateStatusPatch(
      upgradeFeishuSenderIdentityPatch(
        upgradeFeishuBusyQuickActionsPatch(upgradeFeishuMobileMessagePatch(source))
      )
    )
  ));
}

function upgradeDynamicTaskCardPatch(source) {
  if (source.includes('AGENT_ARMY_FEISHU_DYNAMIC_TASK_CARD_V1')) return source;
  if (
    !source.includes('AJUN_FEISHU_COMMANDER_INGRESS_URL')
    || !source.includes('self._ajun_completion_watches_path = get_hermes_home() / "ajun_completion_watches.json"')
    || !source.includes('    async def _send_ajun_approval_card(')
  ) return source;

  let result = source;
  result = result.replace(
    '        self._ajun_completion_watches_path = get_hermes_home() / "ajun_completion_watches.json"\n',
    `        self._ajun_completion_watches_path = get_hermes_home() / "ajun_completion_watches.json"
        # AGENT_ARMY_FEISHU_DYNAMIC_TASK_CARD_V1: one profile-private anchor ledger and one supervisor.
        self._ajun_task_cards_path = get_hermes_home() / "ajun_task_cards.json"
        self._ajun_task_cards_lock = __import__("threading").RLock()
        self._ajun_task_card_supervisor_task = None
        self._ajun_task_card_wake = asyncio.Event()
`
  );
  result = result.replace(
    '            self._restore_ajun_task_completion_notifications()\n',
    `            if self._ajun_dynamic_task_cards_enabled():
                self._start_ajun_task_card_supervisor()
            else:
                self._restore_ajun_task_completion_notifications()
`
  );

  const routeStart = result.indexOf('    async def _route_ajun_commander_event');
  const routeEnd = result.indexOf('\n    async def _route_ajun_agent_proposal_event', routeStart);
  if (routeStart < 0 || routeEnd < 0) return source;
  let route = result.slice(routeStart, routeEnd);
  route = route.replace(
    '            reply = body.get("reply") if isinstance(body, dict) else None\n',
    `            reply = body.get("reply") if isinstance(body, dict) else None
            task_card = body.get("taskCard") if isinstance(body, dict) else None
            dynamic_task_card_enabled = self._ajun_dynamic_task_cards_enabled()
`
  );
  route = route.replace(
    '            if status in {200, 201, 202} and chat_id and isinstance(completion_watch, dict):\n',
    '            if status in {200, 201, 202} and chat_id and isinstance(completion_watch, dict) and not dynamic_task_card_enabled:\n'
  );
  route = route.replace(
    '            if status in {200, 201, 202} and isinstance(reply, str) and reply:\n',
    `            if status in {200, 201, 202} and chat_id and dynamic_task_card_enabled and isinstance(task_card, dict):
                delivered = await self._deliver_ajun_task_card(chat_id=chat_id, projection=task_card, reply_to=event.message_id, completion_watch=completion_watch)
                if delivered:
                    return True
            if status in {200, 201, 202} and isinstance(reply, str) and reply:
`
  );
  result = `${result.slice(0, routeStart)}${route}${result.slice(routeEnd)}`;

  result = insert(
    result,
    '    async def _send_ajun_approval_card(self, chat_id: str, approval: Dict[str, Any], *, reply_to: Optional[str] = None) -> SendResult:\n',
    `${dynamicTaskCardMethods}\n\n    async def _send_ajun_approval_card(self, chat_id: str, approval: Dict[str, Any], *, reply_to: Optional[str] = None) -> SendResult:\n`
  );
  result = insert(
    result,
    '        ajun_approval_action = action_value.get("ajun_approval_action") if isinstance(action_value, dict) else None\n',
    `        task_card_action = action_value.get("agent_army_task_card_action") if isinstance(action_value, dict) else None
        if task_card_action:
            return self._handle_ajun_task_card_action(event=event, action_value=action_value)
        ajun_approval_action = action_value.get("ajun_approval_action") if isinstance(action_value, dict) else None
`
  );
  result = insert(
    result,
    '    def _handle_ajun_approval_card_action(self, *, event: Any, action_value: Dict[str, Any], loop: Any) -> Any:\n',
    `${dynamicTaskCardCallback}\n\n    def _handle_ajun_approval_card_action(self, *, event: Any, action_value: Dict[str, Any], loop: Any) -> Any:\n`
  );
  return result;
}


export function upgradeFeishuSenderIdentityPatch(source) {
  if (source.includes('AGENT_ARMY_FEISHU_OPEN_ID_AUTH_V1')) return source;
  const current = `        # Prefer tenant-scoped user_id; fall back to app-scoped open_id.
        primary_id = user_id or open_id
        # bot/v3/bots/basic_batch only accepts open_id.`;
  if (!source.includes(current)) return source;
  return source.replace(
    current,
    `        # AGENT_ARMY_FEISHU_OPEN_ID_AUTH_V1: keep the app-scoped open_id as
        # Hermes' primary identity. Setup writes this ID to FEISHU_ALLOWED_USERS;
        # granting broader message permissions may additionally expose user_id and
        # must not silently invalidate the existing allowlist or session identity.
        primary_id = open_id or user_id
        # bot/v3/bots/basic_batch only accepts open_id.`
  );
}

export function upgradeFeishuReactionReliabilityPatch(source) {
  if (source.includes('AGENT_ARMY_FEISHU_REACTION_RELIABILITY_V5')) return source;
  if (
    !source.includes('async def _add_reaction(self, message_id: str, emoji_type: str)')
    || !source.includes('async def _remove_reaction(self, message_id: str, reaction_id: str)')
  ) return source;

  let result = source;
  const hasPreviousReliabilityPatch = (
    result.includes('AGENT_ARMY_FEISHU_REACTION_RELIABILITY_V2')
    || result.includes('AGENT_ARMY_FEISHU_REACTION_RELIABILITY_V3')
    || result.includes('AGENT_ARMY_FEISHU_REACTION_RELIABILITY_V4')
  );
  if (hasPreviousReliabilityPatch) {
    result = result
      .replaceAll(
        '{99991663, 231002, 231008, 231018, 231021, 231022}',
        '{99991663, 99991672, 231002, 231008, 231018, 231021, 231022}'
      )
      .replaceAll(
        /AGENT_ARMY_FEISHU_REACTION_RELIABILITY_V[234]/g,
        'AGENT_ARMY_FEISHU_REACTION_RELIABILITY_V5'
      );
    const reliabilityMarker = `            # AGENT_ARMY_FEISHU_REACTION_RELIABILITY_V5: preserve the SDK's
            # established wire-compatible body and expose only redacted rejection data.`;
    result = result.replace(`${reliabilityMarker}\n${reliabilityMarker}`, reliabilityMarker);
  }
  if (result.includes('AGENT_ARMY_FEISHU_REACTION_RELIABILITY_V1')) {
    result = result.replace(
      `            # AGENT_ARMY_FEISHU_REACTION_RELIABILITY_V1: construct the SDK model
            # explicitly and surface rejected calls without logging message/user data.
            from lark_oapi.api.im.v1 import (
                CreateMessageReactionRequest,
                CreateMessageReactionRequestBody,
                Emoji,
            )
            reaction_type = Emoji.builder().emoji_type(emoji_type).build()
            body = (
                CreateMessageReactionRequestBody.builder()
                .reaction_type(reaction_type)
                .build()
            )`,
      `            # AGENT_ARMY_FEISHU_REACTION_RELIABILITY_V5: preserve the SDK's
            # established wire-compatible body and expose only redacted rejection data.
            from lark_oapi.api.im.v1 import (
                CreateMessageReactionRequest,
                CreateMessageReactionRequestBody,
            )
            body = (
                CreateMessageReactionRequestBody.builder()
                .reaction_type({"emoji_type": emoji_type})
                .build()
            )`
    );
  } else if (!hasPreviousReliabilityPatch) {
    result = result.replace(
      '            from lark_oapi.api.im.v1 import (\n                CreateMessageReactionRequest,',
      `            # AGENT_ARMY_FEISHU_REACTION_RELIABILITY_V5: preserve the SDK's
            # established wire-compatible body and expose only redacted rejection data.
            from lark_oapi.api.im.v1 import (
                CreateMessageReactionRequest,`
    );
  }
  result = result.replace(
    `            logger.debug(
                "[Feishu] Add reaction %s on %s rejected: code=%s msg=%s",
                emoji_type,
                message_id,
                getattr(response, "code", None),
                getattr(response, "msg", None),
            )`,
    `            reaction_error_code = getattr(response, "code", None)
            reaction_error_reason = (
                "permission_required"
                if reaction_error_code in {99991663, 99991672, 231002, 231008, 231018, 231021, 231022}
                else "invalid_emoji"
                if reaction_error_code == 231001
                else "provider_rejected"
            )
            logger.warning(
                "[Feishu] Add reaction rejected: emoji=%s code=%s reason=%s",
                emoji_type,
                reaction_error_code,
                reaction_error_reason,
            )`
  );
  for (const indent of ['        ', '            ']) {
    result = result.replace(
      `${indent}logger.debug(
${indent}    "[Feishu] Remove reaction %s on %s rejected: code=%s msg=%s",
${indent}    reaction_id,
${indent}    message_id,
${indent}    getattr(response, "code", None),
${indent}    getattr(response, "msg", None),
${indent})`,
      `${indent}reaction_error_code = getattr(response, "code", None)
${indent}reaction_error_reason = (
${indent}    "permission_required"
${indent}    if reaction_error_code in {99991663, 99991672, 231002, 231008, 231018, 231021, 231022}
${indent}    else "provider_rejected"
${indent})
${indent}logger.warning(
${indent}    "[Feishu] Remove reaction rejected: code=%s reason=%s",
${indent}    reaction_error_code,
${indent}    reaction_error_reason,
${indent})`
    );
  }

  if (!result.includes('AGENT_ARMY_FEISHU_REACTION_RELIABILITY_V5')) {
    throw new Error('Hermes 飞书处理图标结构不匹配，拒绝猜测修改。');
  }
  return result;
}

function upgradeFeishuMobileMessagePatch(source) {
  if (source.includes('AGENT_ARMY_FEISHU_MOBILE_FORMAT_V4')) return source;
  if (
    source.includes('AGENT_ARMY_FEISHU_MOBILE_FORMAT_V2')
    || source.includes('AGENT_ARMY_FEISHU_MOBILE_FORMAT_V1')
    || source.includes('AGENT_ARMY_FEISHU_MOBILE_FORMAT_V3')
  ) {
    const helperStart = source.search(/# AGENT_ARMY_FEISHU_MOBILE_FORMAT_V[123]:/);
    const helperEnd = source.indexOf('\n_MARKDOWN_HINT_RE = re.compile(', helperStart);
    if (helperStart < 0 || helperEnd < 0) return source;
    return `${source.slice(0, helperStart)}${feishuMobileMessageHelpers}\n${source.slice(helperEnd)}`;
  }
  if (!source.includes('_MARKDOWN_HINT_RE = re.compile(')) return source;
  let result = insert(
    source,
    '_MARKDOWN_HINT_RE = re.compile(\n',
    `${feishuMobileMessageHelpers}\n\n_MARKDOWN_HINT_RE = re.compile(\n`
  );
  result = result.replace(
    '        formatted = self.format_message(content)\n',
    '        # AGENT_ARMY_FEISHU_MOBILE_FORMAT_V1: adapt density and wide tables before rendering.\n        content = _agent_army_format_feishu_message(content)\n        formatted = self.format_message(content)\n'
  );
  result = result.replace(
    '        content = self.format_message(content)\n        try:\n            msg_type, payload = self._build_outbound_payload(content)\n',
    '        content = _agent_army_format_feishu_message(content)\n        content = self.format_message(content)\n        try:\n            msg_type, payload = self._build_outbound_payload(content)\n'
  );
  return result;
}

function upgradeFeishuImmediateStatusPatch(source) {
  if (
    source.includes('AGENT_ARMY_FEISHU_IMMEDIATE_STATUS_V1')
    || !source.includes('async def _dispatch_inbound_event(self, event: MessageEvent)')
    || !source.includes('async def on_processing_start(self, event: MessageEvent)')
  ) return source;

  let result = transformPythonMethod(source, '_dispatch_inbound_event', (body) => {
    let upgraded = body.replace(
      '        """Apply Feishu-specific burst protection before entering the base adapter."""\n',
      `        """Apply Feishu-specific burst protection before entering the base adapter."""
        # AGENT_ARMY_FEISHU_IMMEDIATE_STATUS_V1: one immediate status, attached to the user's message.
        if event.message_type in {MessageType.TEXT, MessageType.COMMAND}:
            await self.on_processing_start(event)
`
    );
    if (!upgraded.includes('AGENT_ARMY_FEISHU_IMMEDIATE_STATUS_V1')) {
      const signatureEnd = upgraded.indexOf('\n');
      if (signatureEnd >= 0) {
        upgraded = `${upgraded.slice(0, signatureEnd + 1)}        # AGENT_ARMY_FEISHU_IMMEDIATE_STATUS_V1: one immediate status, attached to the user's message.
        if event.message_type in {MessageType.TEXT, MessageType.COMMAND}:
            await self.on_processing_start(event)
${upgraded.slice(signatureEnd + 1)}`;
      }
    }
    upgraded = addQuickRouteCompletion(upgraded);
    return upgraded;
  });

  result = transformPythonMethod(result, '_handle_message_with_guards', addQuickRouteCompletion);
  result = transformPythonMethod(result, '_enqueue_text_event', (body) => body.replace(
    `        existing.text = next_text
        existing._last_chunk_len = chunk_len  # type: ignore[attr-defined]
        existing.timestamp = event.timestamp
        if event.message_id:
            existing.message_id = event.message_id
`,
    `        # Keep exactly one processing badge when rapid text chunks are merged:
        # remove it from the earlier chunk and retain the already-created badge
        # on the latest user message.
        if existing.message_id and event.message_id and existing.message_id != event.message_id:
            await self.on_processing_complete(existing, ProcessingOutcome.SUCCESS)
        existing.text = next_text
        existing._last_chunk_len = chunk_len  # type: ignore[attr-defined]
        existing.timestamp = event.timestamp
        if event.message_id:
            existing.message_id = event.message_id
`
  ));
  return result;
}

function transformPythonMethod(source, methodName, transform) {
  const marker = `    async def ${methodName}(`;
  const start = source.indexOf(marker);
  if (start < 0) return source;
  const next = source.slice(start + marker.length).search(/\n    (?:async )?def /);
  const end = next < 0 ? source.length : start + marker.length + next;
  const body = source.slice(start, end);
  const upgraded = transform(body);
  return `${source.slice(0, start)}${upgraded}${source.slice(end)}`;
}

function addQuickRouteCompletion(body) {
  const routeNames = [
    '_route_xiaod_media_event',
    '_route_ajun_commander_event',
    '_route_xiaod_url_event',
    '_route_xiaod_status_query',
    '_route_xiaod_retry_query',
    '_route_ajun_agent_proposal_event'
  ];
  let result = body;
  for (const routeName of routeNames) {
    const pattern = new RegExp(
      `(\\n([ \\t]+)if await self\\.${routeName}\\(event\\):\\n)([ \\t]+)return`,
      'g'
    );
    result = result.replace(
      pattern,
      '$1$3await self.on_processing_complete(event, ProcessingOutcome.SUCCESS)\n$3return'
    );
  }
  return result;
}

function upgradeFeishuBusyQuickActionsPatch(source) {
  if (source.includes('AGENT_ARMY_FEISHU_BUSY_QUICK_ACTIONS_V2')) return source;
  if (!source.includes('    async def send_exec_approval(')) return source;
  let result = source;
  if (result.includes('AGENT_ARMY_FEISHU_BUSY_QUICK_ACTIONS_V1')) {
    result = result.replace(
      'AGENT_ARMY_FEISHU_BUSY_QUICK_ACTIONS_V1',
      'AGENT_ARMY_FEISHU_BUSY_QUICK_ACTIONS_V2'
    );
  } else {
    result = insert(
      result,
      '    async def send_exec_approval(\n',
      `${feishuBusyQuickActionsMethod}\n\n    async def send_exec_approval(\n`
    );
  }
  result = insert(
    result,
    '        ajun_approval_action = action_value.get("ajun_approval_action") if isinstance(action_value, dict) else None\n',
    `        busy_action = action_value.get("agent_army_busy_action") if isinstance(action_value, dict) else None
        if busy_action:
            return self._handle_agent_army_busy_card_action(data=data, event=event, action_value=action_value, loop=loop)
        ajun_approval_action = action_value.get("ajun_approval_action") if isinstance(action_value, dict) else None
`
  );
  result = insert(
    result,
    '    def _handle_approval_card_action(self, *, event: Any, action_value: Dict[str, Any], loop: Any) -> Any:\n',
    `${feishuBusyQuickActionsCallback}\n\n    def _handle_approval_card_action(self, *, event: Any, action_value: Dict[str, Any], loop: Any) -> Any:\n`
  );
  const busySyntheticCommand = `        busy_action = action_value.get("agent_army_busy_action") if isinstance(action_value, dict) else None
        if busy_action == "stop":
            synthetic_text = "/stop"
        elif busy_action in {"queue", "steer", "interrupt", "status"}:
            synthetic_text = f"/busy {busy_action}"
        else:
            synthetic_text = f"/card {action_tag}"
`;
  const legacyBusySyntheticCommand = `        busy_action = action_value.get("agent_army_busy_action") if isinstance(action_value, dict) else None
        if busy_action == "stop":
            synthetic_text = "/stop"
        elif busy_action in {"queue", "steer", "interrupt", "status"}:
            synthetic_text = f"/busy {busy_action}"
        else:
            synthetic_text = f"/card {action_tag}"
`;
  if (result.includes(legacyBusySyntheticCommand)) {
    result = result.replace(legacyBusySyntheticCommand, busySyntheticCommand);
  } else {
    result = result.replace(
      '        synthetic_text = f"/card {action_tag}"\n',
      busySyntheticCommand
    );
  }
  result = result.replace(
    `        if action_value:
            try:
                synthetic_text += f" {json.dumps(action_value, ensure_ascii=False)}"
            except Exception:
                pass
`,
    `        if action_value and not busy_action:
            try:
                synthetic_text += f" {json.dumps(action_value, ensure_ascii=False)}"
            except Exception:
                pass
`
  );
  result = result.replace(
    '            message_id=token or str(uuid.uuid4()),\n',
    '            message_id=str(getattr(context, "open_message_id", "") or "") or None,\n'
  );
  return result;
}

function upgradeFeishuSlashConfirmPatch(source) {
  if (source.includes('AGENT_ARMY_FEISHU_SLASH_CONFIRM_V1') || !source.includes('    async def send_exec_approval(')) return source;
  let result = insert(source, '    async def send_exec_approval(\n', `${feishuSlashConfirmMethod}\n\n    async def send_exec_approval(\n`);
  result = insert(
    result,
    '        if hermes_action:\n',
    '        slash_confirm_action = action_value.get("hermes_slash_confirm_action") if isinstance(action_value, dict) else None\n        if slash_confirm_action:\n            return self._handle_slash_confirm_card_action(event=event, action_value=action_value, loop=loop)\n        if hermes_action:\n'
  );
  result = insert(result, '    def _handle_approval_card_action(self, *, event: Any, action_value: Dict[str, Any], loop: Any) -> Any:\n', `${feishuSlashConfirmCallback}\n\n    def _handle_approval_card_action(self, *, event: Any, action_value: Dict[str, Any], loop: Any) -> Any:\n`);
  result = insert(result, '    async def _resolve_approval(\n', `${feishuSlashConfirmResolver}\n\n    async def _resolve_approval(\n`);
  return result;
}

function upgradeFeishuBusinessUiPatch(source) {
  if (source.includes('AGENT_ARMY_FEISHU_BUSINESS_UI_V1') || !source.includes('_APPROVAL_LABEL_MAP')) return source;
  let result = source;
  result = result.replace(
    `_APPROVAL_LABEL_MAP: Dict[str, str] = {
    "once": "Approved once",
    "session": "Approved for session",
    "always": "Approved permanently",
    "deny": "Denied",
}`,
    `# AGENT_ARMY_FEISHU_BUSINESS_UI_V1: keep operator-facing approval cards concise and Chinese.
_APPROVAL_LABEL_MAP: Dict[str, str] = {
    "once": "已授权本次操作",
    "session": "已授权当前会话",
    "always": "已保存长期授权",
    "deny": "已拒绝本次操作",
}`
  );
  result = result
    .replace('actions = [_btn("✅ Allow Once", "approve_once", "primary")]', 'actions = [_btn("✅ 仅允许本次", "approve_once", "primary")]')
    .replace('actions.append(_btn("✅ Session", "approve_session"))', 'actions.append(_btn("✅ 当前会话允许", "approve_session"))')
    .replace('actions.append(_btn("✅ Always", "approve_always"))', 'actions.append(_btn("✅ 始终允许", "approve_always"))')
    .replace('actions.append(_btn("❌ Deny", "deny", "danger"))', 'actions.append(_btn("❌ 拒绝", "deny", "danger"))')
    .replace('**Smart DENY:** owner override applies to this one operation only.', '**说明：** 本次拒绝只影响当前操作。')
    .replace('⚠️ Command Approval Required', '⚠️ 需要你确认一次操作')
    .replace('**Reason:**', '**原因：**')
    .replace('_APPROVAL_LABEL_MAP.get(choice, "Resolved")', '_APPROVAL_LABEL_MAP.get(choice, "已处理")')
    .replace(
      '        return {\n            "config": {"wide_screen_mode": True},',
      '        detail = "本次操作不会执行。" if choice == "deny" else "仅对这一次操作生效。" if choice == "once" else "仅在当前会话内生效。" if choice == "session" else "已保存为长期授权，可在设置中撤销。"\n        return {\n            "config": {"wide_screen_mode": True},'
    )
    .replace('"content": f"{icon} **{label}** by {user_name}",', '"content": f"{icon} **{label}**\\n{detail}",');
  return result;
}

function upgradeCommanderIngressPrecedencePatch(source) {
  if (source.includes('AJUN_COMMANDER_INGRESS_PRECEDENCE_V1') || !source.includes('AJUN_FEISHU_COMMANDER_INGRESS_URL')) return source;
  let result = source;
  for (const indent of ['        ', '            ']) {
    const childIndent = `${indent}    `;
    const legacyOrder = `${indent}if await self._route_xiaod_url_event(event):
${childIndent}return
${indent}if await self._route_xiaod_status_query(event):
${childIndent}return
${indent}if await self._route_xiaod_retry_query(event):
${childIndent}return
${indent}if await self._route_ajun_commander_event(event):
${childIndent}return
`;
    const commanderFirst = `${indent}# AJUN_COMMANDER_INGRESS_PRECEDENCE_V1: one A君 task chain owns text URLs and recovery.
${indent}if await self._route_ajun_commander_event(event):
${childIndent}return
${indent}if await self._route_xiaod_url_event(event):
${childIndent}return
${indent}if await self._route_xiaod_status_query(event):
${childIndent}return
${indent}if await self._route_xiaod_retry_query(event):
${childIndent}return
`;
    result = result.replaceAll(legacyOrder, commanderFirst);
  }
  return result;
}

function upgradeCommanderIngressTimeoutPatch(source) {
  if (!source.includes('AJUN_FEISHU_COMMANDER_INGRESS_URL')) return source;
  // A previous patch release marked the approval callback but missed the
  // actual commander route. Upgrade every commander-route definition in place:
  // an adapter can contain an older duplicate and Python uses the last one.
  const routeMarker = '    async def _route_ajun_commander_event';
  const parts = source.split(routeMarker);
  if (parts.length === 1) return source;
  return parts.map((part, index) => {
    if (index === 0) return part;
    const nextMethod = part.search(/\n    (?:async )?def /);
    const body = nextMethod < 0 ? part : part.slice(0, nextMethod);
    const rest = nextMethod < 0 ? '' : part.slice(nextMethod);
    const upgraded = body
      .replace(
        '            with urlopen(request, timeout=8) as response:\n',
        '            # AJUN_COMMANDER_INGRESS_TIMEOUT_V1: natural-language understanding can take longer than a simple status check.\n            with urlopen(request, timeout=25) as response:\n'
      )
      .replace(
        '            await self.send(chat_id, "军团总管暂时无法登记这条命令；未启动任何外部动作，请稍后重试。", reply_to=event.message_id)\n',
        '            await self.send(chat_id, "我这次没能及时理解完这句话，也没有启动任何动作。请直接再说一次你想要的结果。", reply_to=event.message_id)\n'
      );
    return `${routeMarker}${upgraded}${rest}`;
  }).join('');
}

function upgradeProposalTrialReadinessPatch(source) {
  if (source.includes('AJUN_PROPOSAL_TRIAL_READINESS_V1') || !source.includes('AJUN_APPROVAL_CARD_V2')) return source;
  let result = source;
  result = result.replace(
    '        approval_action = str(approval.get("action") or "")\n',
    '        approval_action = str(approval.get("action") or "")\n        # AJUN_PROPOSAL_TRIAL_READINESS_V1: keep a draft honest when no real worker exists yet.\n        proposal_ready_for_trial = approval.get("trialReadyForTest") is True\n'
  );
  result = result.replace(
    '        note = "同意后仅进入小范围试用，不会直接上线。" if governance_mode == "proposal" else "决定会先写入 Paperclip；确认范围、有效期后才会继续任务。" if is_governance else "只会批准卡片所列范围，不会永久扩权。"\n',
    '        note = "同意后仅进入小范围试用，不会直接上线。" if governance_mode == "proposal" and proposal_ready_for_trial else "当前还没有对应的真实执行能力；同意只保留草案并转为待补能力，不会进入试用或上线。" if governance_mode == "proposal" else "决定会先写入 Paperclip；确认范围、有效期后才会继续任务。" if is_governance else "只会批准卡片所列范围，不会永久扩权。"\n'
  );
  result = result.replace(
    '        approve_label = "批准所列范围"\n        reject_label = "拒绝并关闭"\n',
    '        approve_label = "批准所列范围"\n        reject_label = "拒绝并关闭"\n        if governance_mode == "proposal" and not proposal_ready_for_trial:\n            approve_label = "同意保留草案"\n'
  );
  result = result.replace(
    '                label = "已批准，现进入小范围试用" if governance_mode == "proposal" and action == "approve" else "已拒绝，草案已关闭" if governance_mode == "proposal" else "已批准，正在按确认范围执行" if action == "approve" else "已拒绝本次变更，原任务状态保持不变"\n',
    '                if governance_mode == "proposal" and action == "approve":\n                    label = "已批准，现进入小范围试用" if str(result.get("status", "") or "") == "testing" else "已记录草案；当前还缺真实执行能力，已转为待补能力，不会进入试用或上线"\n                else:\n                    label = "已拒绝，草案已关闭" if governance_mode == "proposal" else "已批准，正在按确认范围执行" if action == "approve" else "已拒绝本次变更，原任务状态保持不变"\n'
  );
  return result;
}

function upgradeTaskControlCardPatch(source) {
  if (source.includes('AJUN_TASK_CONTROL_CARD_V1') || !source.includes('AJUN_APPROVAL_CARD_V2')) return source;
  let result = source;
  result = result.replace(
    /(        governance_mode = str\(approval\.get\("governanceMode"\) or "local"\)\n)(        is_governance = .*)/,
    '$1        approval_action = str(approval.get("action") or "")\n        # AJUN_TASK_CONTROL_CARD_V1: pause/resume decisions have truthful labels.\n$2'
  );
  result = result.replace(
    '        card = {"config": {"wide_screen_mode": True}, "header": {"title": {"tag": "plain_text", "content": title}, "template": "orange"}, "elements": [',
    '        approve_label = "批准所列范围"\n        reject_label = "拒绝并关闭"\n        if approval_action == "pause-task":\n            approve_label, reject_label = "同意暂停", "保持继续处理"\n        elif approval_action == "resume-task":\n            approve_label, reject_label = "同意继续", "保持暂停"\n        card = {"config": {"wide_screen_mode": True}, "header": {"title": {"tag": "plain_text", "content": title}, "template": "orange"}, "elements": ['
  );
  result = result.replace(
    '{"tag": "action", "actions": [_button("批准所列范围", "approve", "primary"), _button("拒绝并关闭", "reject", "danger")]}',
    '{"tag": "action", "actions": [_button(approve_label, "approve", "primary"), _button(reject_label, "reject", "danger")]}'
  );
  result = result.replace(
    '                label = "已批准，现进入小范围试用" if governance_mode == "proposal" and action == "approve" else "已拒绝，草案已关闭" if governance_mode == "proposal" else "已批准并恢复任务" if action == "approve" else "已拒绝并关闭任务"',
    '                label = "已批准，现进入小范围试用" if governance_mode == "proposal" and action == "approve" else "已拒绝，草案已关闭" if governance_mode == "proposal" else "已批准，正在按确认范围执行" if action == "approve" else "已拒绝本次变更，原任务状态保持不变"'
  );
  return result;
}

function upgradeCommanderCompletionPatch(source) {
  // V3 is added separately when the real adapter exposes its startup hooks.
  // Keep V2-only older adapters stable when this script is run again.
  if (source.includes('AJUN_COMMANDER_TASK_NOTIFY_V2')) return source;
  let result = source;
  const legacyBlock = `            completion_watch = body.get("completionWatch") if isinstance(body, dict) else None
            # AJUN_COMMANDER_XIAOD_NOTIFY_V1: reuse the existing Xiaod terminal notifier.
            if status in {200, 201, 202} and chat_id and isinstance(completion_watch, dict):
                watch_kind = str(completion_watch.get("kind", "") or "")
                watch_job_id = str(completion_watch.get("jobId", "") or "")
                watch_base_url = str(completion_watch.get("baseUrl", "") or "").strip()
                if watch_kind == "xiaod_job" and watch_job_id and watch_base_url.startswith("http://127.0.0.1:"):
                    self._xiaod_latest_job_by_chat[chat_id] = (watch_job_id, watch_base_url)
                    self._schedule_xiaod_job_completion_notification(chat_id=chat_id, task_id=watch_job_id, ingress_url=watch_base_url)
`;
  const currentBlock = `            completion_watch = body.get("completionWatch") if isinstance(body, dict) else None
            # AJUN_COMMANDER_TASK_NOTIFY_V2: follow the whole A君 task, including safe retry and expert handoff.
            if status in {200, 201, 202} and chat_id and isinstance(completion_watch, dict):
                watch_kind = str(completion_watch.get("kind", "") or "")
                watch_task_id = str(completion_watch.get("taskId", "") or "")
                watch_base_url = str(completion_watch.get("baseUrl", "") or "").strip()
                if watch_kind == "ajun_task" and watch_task_id and watch_base_url.startswith("http://127.0.0.1:"):
                    self._schedule_ajun_task_completion_notification(chat_id=chat_id, task_id=watch_task_id, base_url=watch_base_url)
`;
  if (result.includes('AJUN_COMMANDER_XIAOD_NOTIFY_V1')) result = result.replace(legacyBlock, currentBlock);
  else result = insert(result, '            approval = body.get("approval") if isinstance(body, dict) else None\n', `            approval = body.get("approval") if isinstance(body, dict) else None
            completion_watch = body.get("completionWatch") if isinstance(body, dict) else None
            # AJUN_COMMANDER_TASK_NOTIFY_V2: follow the whole A君 task, including safe retry and expert handoff.
            if status in {200, 201, 202} and chat_id and isinstance(completion_watch, dict):
                watch_kind = str(completion_watch.get("kind", "") or "")
                watch_task_id = str(completion_watch.get("taskId", "") or "")
                watch_base_url = str(completion_watch.get("baseUrl", "") or "").strip()
                if watch_kind == "ajun_task" and watch_task_id and watch_base_url.startswith("http://127.0.0.1:"):
                    self._schedule_ajun_task_completion_notification(chat_id=chat_id, task_id=watch_task_id, base_url=watch_base_url)
`);
  if (!result.includes('def _schedule_ajun_task_completion_notification(')) {
    result = insert(result, '    async def _send_ajun_approval_card(self, chat_id: str, approval: Dict[str, Any], *, reply_to: Optional[str] = None) -> SendResult:\n', `${commanderCompletionMethods}\n\n    async def _send_ajun_approval_card(self, chat_id: str, approval: Dict[str, Any], *, reply_to: Optional[str] = None) -> SendResult:\n`);
  }
  return result;
}

function upgradeCommanderCompletionPersistencePatch(source) {
  if (source.includes('AJUN_COMMANDER_TASK_NOTIFY_V3')) return source;
  const initMarker = '        self._xiaod_latest_job_by_chat: Dict[str, tuple[str, str]] = {}\n';
  const connectMarker = '            self._mark_connected()\n            logger.info("[Feishu] Connected in %s mode (%s)", self._connection_mode, self._domain_name)\n';
  // Older/minimal adapter fixtures do not expose lifecycle hooks. Preserve the
  // existing V2 behavior there rather than guessing where a restore should run.
  if (!source.includes(initMarker) || !source.includes(connectMarker)) return source;
  let result = source;
  result = insert(result, initMarker, `        self._xiaod_latest_job_by_chat: Dict[str, tuple[str, str]] = {}
        # AJUN_COMMANDER_TASK_NOTIFY_V3: keep original-chat completion watches across Hermes restarts.
        self._ajun_completion_watches_path = get_hermes_home() / "ajun_completion_watches.json"
`);
  result = insert(result, connectMarker, `            self._mark_connected()
            self._restore_ajun_task_completion_notifications()
            logger.info("[Feishu] Connected in %s mode (%s)", self._connection_mode, self._domain_name)
`);
  result = result.replace(
    '        key = f"ajun:{task_id}"\n        tasks = self._xiaod_job_notification_tasks\n',
    '        key = f"ajun:{task_id}"\n        self._remember_ajun_task_completion_notification(chat_id=chat_id, task_id=task_id, base_url=base_url)\n        tasks = self._xiaod_job_notification_tasks\n'
  );
  result = result.replace(
    '                    if result.success:\n                        return\n            except asyncio.CancelledError:',
    '                    if result.success:\n                        self._forget_ajun_task_completion_notification(task_id)\n                        return\n            except asyncio.CancelledError:'
  );
  result = insert(result, '    def _schedule_ajun_task_completion_notification(self, *, chat_id: str, task_id: str, base_url: str) -> None:\n', `${commanderCompletionPersistenceMethods}\n\n    def _schedule_ajun_task_completion_notification(self, *, chat_id: str, task_id: str, base_url: str) -> None:\n`);
  return result;
}

function upgradeCommanderProgressNotificationPatch(source) {
  if (source.includes('AJUN_COMMANDER_TASK_NOTIFY_V4') || !source.includes('AJUN_COMMANDER_TASK_NOTIFY_V3')) return source;
  let result = source;
  result = result.replace(
    '        for _attempt in range(900):\n',
    '        # AJUN_COMMANDER_TASK_NOTIFY_V4: notify meaningful handoffs, then keep waiting for the final result.\n        last_status = self._ajun_task_completion_notification_status(task_id)\n        for _attempt in range(900):\n'
  );
  result = result.replace(
    `                body = await self._run_blocking(_get_ajun_task_status)
                if isinstance(body, dict) and body.get("terminal") is True and isinstance(body.get("message"), str):
                    result = await self.send(chat_id, body["message"])
                    if result.success:
                        self._forget_ajun_task_completion_notification(task_id)
                        return
`,
    `                body = await self._run_blocking(_get_ajun_task_status)
                if isinstance(body, dict) and isinstance(body.get("message"), str):
                    current_status = str(body.get("status", "") or "")
                    is_terminal = body.get("terminal") is True
                    # The original request already received an acknowledgement. Only notify later
                    # handoffs, never every ordinary polling heartbeat.
                    if not is_terminal and current_status and current_status != last_status and current_status not in {"queued", "running"}:
                        update = await self.send(chat_id, body["message"])
                        if update.success:
                            last_status = current_status
                            self._remember_ajun_task_completion_notification(chat_id=chat_id, task_id=task_id, base_url=base_url, last_status=last_status)
                    if is_terminal:
                        result = await self.send(chat_id, body["message"])
                        if result.success:
                            self._forget_ajun_task_completion_notification(task_id)
                            return
`
  );
  result = result.replace(
    '    def _remember_ajun_task_completion_notification(self, *, chat_id: str, task_id: str, base_url: str) -> None:\n',
    `    def _ajun_task_completion_notification_status(self, task_id: str) -> str:
        watch = self._load_ajun_task_completion_notifications().get(task_id)
        return str(watch.get("last_status", "") or "") if isinstance(watch, dict) else ""

    def _remember_ajun_task_completion_notification(self, *, chat_id: str, task_id: str, base_url: str, last_status: str = "") -> None:
`
  );
  result = result.replace(
    '        watches[task_id] = {"chat_id": chat_id, "task_id": task_id, "base_url": base_url}\n',
    `        existing = watches.get(task_id)
        known_status = str(existing.get("last_status", "") or "") if isinstance(existing, dict) else ""
        watches[task_id] = {"chat_id": chat_id, "task_id": task_id, "base_url": base_url, "last_status": last_status or known_status}
`
  );
  return result;
}

function upgradeCommanderApprovalPatch(source) {
  let result = insert(source, '            reply = body.get("reply") if isinstance(body, dict) else None\n            if status in {200, 201, 202} and isinstance(reply, str) and reply:\n                if chat_id:\n                    await self.send(chat_id, reply, reply_to=event.message_id)\n                return True\n', `            reply = body.get("reply") if isinstance(body, dict) else None
            approval = body.get("approval") if isinstance(body, dict) else None
            if status in {200, 201, 202} and isinstance(reply, str) and reply:
                if chat_id and isinstance(approval, dict) and approval.get("governanceMode") in {"local", "paperclip"}:
                    card_result = await self._send_ajun_approval_card(chat_id, approval, reply_to=event.message_id)
                    if not card_result.success:
                        await self.send(chat_id, reply, reply_to=event.message_id)
                elif chat_id:
                    await self.send(chat_id, reply, reply_to=event.message_id)
                return True
`);
  result = insert(result, '    async def _route_ajun_agent_proposal_event(self, event: MessageEvent) -> bool:\n', `${approvalCardMethods}\n\n    async def _route_ajun_agent_proposal_event(self, event: MessageEvent) -> bool:\n`);
  result = insert(result, '        if hermes_action:\n', '        ajun_approval_action = action_value.get("ajun_approval_action") if isinstance(action_value, dict) else None\n        if ajun_approval_action:\n            return self._handle_ajun_approval_card_action(event=event, action_value=action_value, loop=loop)\n        if hermes_action:\n');
  result = insert(result, '    def _handle_approval_card_action(self, *, event: Any, action_value: Dict[str, Any], loop: Any) -> Any:\n', `${approvalCardCallback}\n\n    def _handle_approval_card_action(self, *, event: Any, action_value: Dict[str, Any], loop: Any) -> Any:\n`);
  result = insert(result, '    async def _resolve_approval(\n', `${approvalCardResolver}\n\n    async def _resolve_approval(\n`);
  return result;
}

function upgradeLegacyProposalPatch(source) {
  let result = insert(source, '            if await self._route_xiaod_retry_query(event):\n                return\n            if await self._route_ajun_agent_proposal_event(event):\n', '            if await self._route_xiaod_retry_query(event):\n                return\n            if await self._route_ajun_commander_event(event):\n                return\n            if await self._route_ajun_agent_proposal_event(event):\n');
  result = insert(result, '        if await self._route_xiaod_retry_query(event):\n            return\n        if await self._route_ajun_agent_proposal_event(event):\n', '        if await self._route_xiaod_retry_query(event):\n            return\n        if await self._route_ajun_commander_event(event):\n            return\n        if await self._route_ajun_agent_proposal_event(event):\n');
  return insert(result, '    async def _route_ajun_agent_proposal_event(self, event: MessageEvent) -> bool:\n', `${commanderRouter}\n\n    async def _route_ajun_agent_proposal_event(self, event: MessageEvent) -> bool:\n`);
}

function insert(source, marker, replacement) {
  if (!source.includes(marker)) throw new Error(`Hermes 当前 Feishu 适配器结构不匹配，找不到补丁锚点：${marker.slice(0, 72)}`);
  return source.replace(marker, replacement);
}

const proposalPattern = `_AJUN_AGENT_PROPOSAL_RE = re.compile(\n    r"(?:创建|新建|招募|招)\\s*(?:一个\\s*)?(?:agent|智能体|岗位)",\n    re.IGNORECASE,\n)`;
const feishuMobileMessageHelpers = String.raw`# AGENT_ARMY_FEISHU_MOBILE_FORMAT_V4: adapt spacing to content instead of forcing one reply template.
def _agent_army_table_cells(line: str) -> List[str]:
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def _agent_army_should_stack_table(headers: List[str], rows: List[List[str]]) -> bool:
    if len(headers) > 3 or len(rows) > 4:
        return True
    widths = []
    for index, header in enumerate(headers):
        values = [header] + [row[index] if index < len(row) else "" for row in rows]
        widths.append(max((len(re.sub(r"[*_~]", "", value)) for value in values), default=0))
    return any(width > 12 for width in widths) or sum(widths) > 28


def _agent_army_stack_table(headers: List[str], rows: List[List[str]]) -> str:
    blocks: List[str] = []
    if len(headers) == 2:
        for row in rows:
            label = row[0] if row else ""
            value = row[1] if len(row) > 1 else ""
            if label or value:
                blocks.append(f"**{label or headers[0]}**\n{value or '—'}")
        return "\n\n".join(blocks)

    for row_index, row in enumerate(rows, start=1):
        title = row[0] if row and row[0] else f"第 {row_index} 项"
        details = []
        for index in range(1, len(headers)):
            value = row[index] if index < len(row) else ""
            if value:
                details.append(f"- **{headers[index]}**：{value}")
        blocks.append(f"**{title}**" + (f"\n{chr(10).join(details)}" if details else ""))
    return "\n\n".join(blocks)


def _agent_army_mobileize_tables(content: str) -> str:
    lines = content.splitlines()
    output: List[str] = []
    index = 0
    separator_re = re.compile(r"^\s*\|?\s*:?-{3,}.*\|\s*$")
    while index < len(lines):
        if (
            index + 1 < len(lines)
            and "|" in lines[index]
            and separator_re.match(lines[index + 1])
        ):
            table_lines = [lines[index], lines[index + 1]]
            cursor = index + 2
            while cursor < len(lines) and "|" in lines[cursor] and lines[cursor].strip():
                table_lines.append(lines[cursor])
                cursor += 1
            headers = _agent_army_table_cells(table_lines[0])
            rows = [_agent_army_table_cells(line) for line in table_lines[2:]]
            if rows and _agent_army_should_stack_table(headers, rows):
                output.extend(_agent_army_stack_table(headers, rows).splitlines())
            else:
                output.extend(table_lines)
            index = cursor
            continue
        output.append(lines[index].rstrip())
        index += 1
    return "\n".join(output)


def _agent_army_wrap_dense_paragraph(block: str) -> str:
    compact = block.strip()
    if (
        len(compact) <= 220
        or "\n" in compact
        or compact.startswith(("#", "-", "*", ">", "|"))
        or re.match(r"^\d+[.)、]\s+\S", compact)
    ):
        return compact
    sentences = [part.strip() for part in re.split(r"(?<=[。！？；])", compact) if part.strip()]
    if len(sentences) < 2:
        return compact
    paragraphs: List[str] = []
    current = ""
    for sentence in sentences:
        if current and len(current) + len(sentence) > 140:
            paragraphs.append(current)
            current = sentence
        else:
            current += sentence
    if current:
        paragraphs.append(current)
    return "\n\n".join(paragraphs)


def _agent_army_is_section_heading(line: str) -> bool:
    compact = line.strip()
    return bool(
        re.match(r"^#{1,6}\s+\S", compact)
        or re.match(r"^\*\*[^*\n]{1,36}\*\*[：:]?$", compact)
    )


def _agent_army_expand_inline_numbered_items(content: str) -> str:
    """Split a real 1)/2)/3) sequence that a model compressed onto one line."""
    marker_re = re.compile(r"(?<![\w.])(\d{1,2})(?:[)）、]\s*|\.\s+)(?=(?:\*\*)?\S)")
    output: List[str] = []
    for line in content.splitlines():
        matches = list(marker_re.finditer(line))
        numbers = [int(match.group(1)) for match in matches]
        if len(matches) < 2 or numbers != list(range(numbers[0], numbers[0] + len(numbers))):
            output.append(line)
            continue

        prefix = line[:matches[0].start()].rstrip()
        if prefix:
            output.append(prefix)
            output.append("")
        for item_index, match in enumerate(matches):
            end = matches[item_index + 1].start() if item_index + 1 < len(matches) else len(line)
            item = line[match.end():end].strip()
            output.append(f"{match.group(1)}. {item}")
    return "\n".join(output)


def _agent_army_expand_inline_callouts(content: str) -> str:
    """Give concluding notes their own small section instead of burying them in an item."""
    callout_re = re.compile(
        r"(?<=[。！？；])\s*(?:\*\*)?"
        r"(单独说明|补充说明|说明|注意|提醒|下一步|结论|风险)"
        r"[：:](?:\*\*)?\s*"
    )
    output: List[str] = []
    for line in content.splitlines():
        match = callout_re.search(line)
        if not match:
            output.append(line)
            continue
        before = line[:match.start()].rstrip()
        after = line[match.end():].strip()
        if before:
            output.append(before)
            output.append("")
        output.append(f"**{match.group(1)}**")
        if after:
            output.append(after)
    return "\n".join(output)


def _agent_army_breathe_long_lists(content: str) -> str:
    """Space only long list items; concise lists remain visually compact."""
    lines = content.splitlines()
    output: List[str] = []
    index = 0
    top_level_item = re.compile(r"^(?:[-*]|\d+[.)、])\s+\S")
    any_item = re.compile(r"^\s*(?:[-*]|\d+[.)、])\s+\S")
    while index < len(lines):
        if not top_level_item.match(lines[index]):
            output.append(lines[index])
            index += 1
            continue

        items: List[List[str]] = []
        cursor = index
        while cursor < len(lines) and top_level_item.match(lines[cursor]):
            item = [lines[cursor]]
            cursor += 1
            while (
                cursor < len(lines)
                and lines[cursor].strip()
                and not top_level_item.match(lines[cursor])
                and (lines[cursor].startswith((" ", "\t")) or not any_item.match(lines[cursor]))
            ):
                item.append(lines[cursor])
                cursor += 1
            items.append(item)
        lengths = [len(re.sub(r"[*_~\`]", "", " ".join(item))) for item in items]
        spacious = len(items) >= 3 and (
            max(lengths, default=0) > 42
            or (sum(lengths) / max(len(lengths), 1)) > 30
        )
        if spacious and output and output[-1] != "":
            output.append("")
        for item_index, item in enumerate(items):
            if spacious and item_index and output and output[-1] != "":
                output.append("")
            output.extend(item)
        if spacious and cursor < len(lines) and lines[cursor].strip():
            output.append("")
        index = cursor
    return "\n".join(output)


def _agent_army_breathe_sections(content: str) -> str:
    """Separate real sections without changing short conversational replies."""
    lines = content.splitlines()
    heading_count = sum(1 for line in lines if _agent_army_is_section_heading(line))
    if heading_count == 0 and len(content) < 280:
        return content
    output: List[str] = []
    for line in lines:
        if _agent_army_is_section_heading(line):
            if output and output[-1].strip():
                output.append("")
            output.append(line.strip())
            output.append("")
            continue
        output.append(line)
    return "\n".join(output)


def _agent_army_format_feishu_message(content: str) -> str:
    """Adapt hierarchy, list spacing and wide tables for mobile Feishu."""
    if not isinstance(content, str) or not content:
        return content
    fence = chr(96) * 3
    fence_parts = re.split(rf"({re.escape(fence)}[\s\S]*?{re.escape(fence)})", content)
    formatted: List[str] = []
    for index, part in enumerate(fence_parts):
        if index % 2:
            formatted.append(part.rstrip())
            continue
        mobile = _agent_army_expand_inline_callouts(
            _agent_army_expand_inline_numbered_items(_agent_army_mobileize_tables(part))
        )
        breathed = _agent_army_breathe_sections(_agent_army_breathe_long_lists(mobile))
        blocks = re.split(r"\n{2,}", breathed)
        formatted.append("\n\n".join(_agent_army_wrap_dense_paragraph(block) for block in blocks if block.strip()))
    return re.sub(r"\n[ \t]*\n(?:[ \t]*\n)+", "\n\n", "".join(formatted)).strip()`;

const feishuBusyQuickActionsMethod = `    # AGENT_ARMY_FEISHU_BUSY_QUICK_ACTIONS_V2: one-tap controls shared by every Agent.
    async def send_busy_quick_actions(
        self, chat_id: str, content: str, current_mode: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        if not self._client:
            return SendResult(success=False, error="Not connected")
        try:
            mode_labels = {
                "interrupt": "直接调整当前任务",
                "queue": "下一步单独处理",
                "steer": "加入当前任务",
            }
            card = {
                "config": {"wide_screen_mode": True},
                "header": {
                    "title": {"content": "任务要求已更新", "tag": "plain_text"},
                    "template": "blue",
                },
                "elements": [
                    {"tag": "markdown", "content": content},
                    {
                        "tag": "action",
                        "actions": [
                            {
                                "tag": "button",
                                "text": {"tag": "plain_text", "content": "下一步单独处理"},
                                "type": "primary" if current_mode != "queue" else "default",
                                "value": {
                                    "agent_army_busy_action": "queue",
                                    "agent_army_busy_current_mode": current_mode,
                                },
                            },
                            {
                                "tag": "button",
                                "text": {"tag": "plain_text", "content": "查看当前设置"},
                                "value": {
                                    "agent_army_busy_action": "status",
                                    "agent_army_busy_current_mode": current_mode,
                                },
                            },
                            {
                                "tag": "button",
                                "text": {"tag": "plain_text", "content": "停止当前任务"},
                                "type": "danger",
                                "value": {
                                    "agent_army_busy_action": "stop",
                                    "agent_army_busy_current_mode": current_mode,
                                },
                            },
                        ],
                    },
                    {
                        "tag": "note",
                        "elements": [{
                            "tag": "plain_text",
                            "content": f"当前方式：{mode_labels.get(current_mode, mode_labels['interrupt'])}。点击按钮会直接执行。",
                        }],
                    },
                ],
            }
            response = await self._feishu_send_with_retry(
                chat_id=chat_id,
                msg_type="interactive",
                payload=json.dumps(card, ensure_ascii=False),
                reply_to=reply_to,
                metadata=metadata,
            )
            return self._finalize_send_result(response, "send_busy_quick_actions failed")
        except Exception as exc:
            logger.warning("[Feishu] send_busy_quick_actions failed: %s", exc)
            return SendResult(success=False, error=str(exc))`;

const feishuBusyQuickActionsCallback = `    def _handle_agent_army_busy_card_action(
        self, *, data: Any, event: Any, action_value: Dict[str, Any], loop: Any,
    ) -> Any:
        """Acknowledge a busy control immediately and execute its exact command."""
        action = str(action_value.get("agent_army_busy_action", "") or "")
        current_mode = str(action_value.get("agent_army_busy_current_mode", "interrupt") or "interrupt")
        if action not in {"queue", "steer", "interrupt", "status", "stop"}:
            return P2CardActionTriggerResponse() if P2CardActionTriggerResponse else None
        operator = getattr(event, "operator", None)
        open_id = str(getattr(operator, "open_id", "") or "")
        chat_id = str(getattr(getattr(event, "context", None), "open_chat_id", "") or "")
        sender_id = SimpleNamespace(open_id=open_id, user_id=str(getattr(operator, "user_id", "") or ""))
        if not chat_id or not self._allow_group_message(sender_id, chat_id, is_bot=False):
            return P2CardActionTriggerResponse() if P2CardActionTriggerResponse else None
        if not self._submit_on_loop(loop, self._handle_card_action_event(data)):
            return P2CardActionTriggerResponse() if P2CardActionTriggerResponse else None
        if P2CardActionTriggerResponse is None:
            return None

        response = P2CardActionTriggerResponse()
        if CallBackCard is None:
            return response
        labels = {
            "interrupt": "直接调整当前任务",
            "queue": "下一步单独处理",
            "steer": "加入当前任务",
        }
        if action == "stop":
            card_data = {
                "config": {"wide_screen_mode": True},
                "header": {
                    "title": {"tag": "plain_text", "content": "正在停止当前任务"},
                    "template": "red",
                },
                "elements": [{"tag": "markdown", "content": "已收到停止指令，执行结果会在本会话回复。"}],
            }
        else:
            selected_mode = action if action in labels else current_mode
            if selected_mode not in labels:
                selected_mode = "interrupt"
            title = "正在读取当前设置" if action == "status" else f"已选择：{labels[selected_mode]}"
            status_text = (
                "读取结果会在本会话回复。"
                if action == "status"
                else "正在应用设置，完成后会在本会话回复确认。"
            )
            def _button(label: str, target: str, button_type: Optional[str] = None) -> Dict[str, Any]:
                button = {
                    "tag": "button",
                    "text": {"tag": "plain_text", "content": label},
                    "value": {
                        "agent_army_busy_action": target,
                        "agent_army_busy_current_mode": selected_mode,
                    },
                }
                if button_type:
                    button["type"] = button_type
                return button
            card_data = {
                "config": {"wide_screen_mode": True},
                "header": {
                    "title": {"tag": "plain_text", "content": title},
                    "template": "green" if action != "status" else "blue",
                },
                "elements": [
                    {"tag": "markdown", "content": status_text},
                    {
                        "tag": "action",
                        "actions": [
                            _button("下一步单独处理", "queue", "primary" if selected_mode == "queue" else None),
                            _button("查看当前设置", "status"),
                            _button("停止当前任务", "stop", "danger"),
                        ],
                    },
                    {
                        "tag": "note",
                        "elements": [{
                            "tag": "plain_text",
                            "content": f"当前方式：{labels[selected_mode]}。",
                        }],
                    },
                ],
            }
        card = CallBackCard()
        card.type = "raw"
        card.data = card_data
        response.card = card
        return response`;

const feishuSlashConfirmMethod = `    # AGENT_ARMY_FEISHU_SLASH_CONFIRM_V1: render destructive slash confirmation as native Chinese buttons.
    async def send_slash_confirm(
        self, chat_id: str, title: str, message: str, session_key: str,
        confirm_id: str, metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        if not self._client:
            return SendResult(success=False, error="Not connected")
        try:
            card = {
                "config": {"wide_screen_mode": True},
                "header": {
                    "title": {"content": "⚠️ 确认开始新会话", "tag": "plain_text"},
                    "template": "orange",
                },
                "elements": [
                    {
                        "tag": "markdown",
                        "content": (
                            f"**{title or '确认操作'}**\\n\\n"
                            "继续后，接下来的回答将从空白上下文开始，当前对话不会再参与回答。"
                        ),
                    },
                    {
                        "tag": "action",
                        "actions": [
                            {
                                "tag": "button",
                                "text": {"tag": "plain_text", "content": "开始新会话"},
                                "type": "primary",
                                "value": {"hermes_slash_confirm_action": "once", "confirm_id": confirm_id},
                            },
                            {
                                "tag": "button",
                                "text": {"tag": "plain_text", "content": "以后不再询问"},
                                "value": {"hermes_slash_confirm_action": "always", "confirm_id": confirm_id},
                            },
                            {
                                "tag": "button",
                                "text": {"tag": "plain_text", "content": "保留当前会话"},
                                "type": "danger",
                                "value": {"hermes_slash_confirm_action": "cancel", "confirm_id": confirm_id},
                            },
                        ],
                    },
                    {
                        "tag": "note",
                        "elements": [{"tag": "plain_text", "content": "“以后不再询问”也会关闭 /clear、/reset 和 /undo 的确认提示，可在配置中重新开启。"}],
                    },
                ],
            }
            response = await self._feishu_send_with_retry(
                chat_id=chat_id,
                msg_type="interactive",
                payload=json.dumps(card, ensure_ascii=False),
                reply_to=None,
                metadata=metadata,
            )
            result = self._finalize_send_result(response, "send_slash_confirm failed")
            if result.success:
                self._approval_state[f"slash:{confirm_id}"] = {
                    "session_key": session_key,
                    "chat_id": chat_id,
                }
            return result
        except Exception as exc:
            logger.warning("[Feishu] send_slash_confirm failed: %s", exc)
            return SendResult(success=False, error=str(exc))`;
const feishuSlashConfirmCallback = `    def _handle_slash_confirm_card_action(self, *, event: Any, action_value: Dict[str, Any], loop: Any) -> Any:
        confirm_id = str(action_value.get("confirm_id", "") or "")
        choice = str(action_value.get("hermes_slash_confirm_action", "") or "")
        state_key = f"slash:{confirm_id}"
        state = self._approval_state.get(state_key)
        operator = getattr(event, "operator", None)
        open_id = str(getattr(operator, "open_id", "") or "")
        callback_chat_id = str(getattr(getattr(event, "context", None), "open_chat_id", "") or "")
        if not state or choice not in {"once", "always", "cancel"}:
            return P2CardActionTriggerResponse() if P2CardActionTriggerResponse else None
        sender_id = SimpleNamespace(open_id=open_id, user_id=str(getattr(operator, "user_id", "") or ""))
        expected_chat_id = str(state.get("chat_id", "") or "")
        if not self._allow_group_message(sender_id, expected_chat_id, is_bot=False):
            return P2CardActionTriggerResponse() if P2CardActionTriggerResponse else None
        if callback_chat_id and expected_chat_id and callback_chat_id != expected_chat_id:
            return P2CardActionTriggerResponse() if P2CardActionTriggerResponse else None
        self._approval_state.pop(state_key, None)
        self._submit_on_loop(
            loop,
            self._resolve_slash_confirm_card(
                session_key=str(state.get("session_key", "") or ""),
                confirm_id=confirm_id,
                choice=choice,
                chat_id=expected_chat_id,
            ),
        )
        if P2CardActionTriggerResponse is None:
            return None
        response = P2CardActionTriggerResponse()
        if CallBackCard is not None:
            labels = {"once": "已开始新会话", "always": "已开始新会话，以后不再询问", "cancel": "已保留当前会话"}
            card = CallBackCard()
            card.type = "raw"
            card.data = {
                "config": {"wide_screen_mode": True},
                "header": {"title": {"tag": "plain_text", "content": labels[choice]}, "template": "green" if choice != "cancel" else "grey"},
                "elements": [{"tag": "markdown", "content": "操作已处理。"}],
            }
            response.card = card
        return response`;
const feishuSlashConfirmResolver = `    async def _resolve_slash_confirm_card(
        self, *, session_key: str, confirm_id: str, choice: str, chat_id: str,
    ) -> None:
        try:
            from tools import slash_confirm as _slash_confirm_mod
            result_text = await _slash_confirm_mod.resolve(session_key, confirm_id, choice)
            if result_text and chat_id:
                await self.send(chat_id, result_text, reply_to=None)
        except Exception as exc:
            logger.error("[Feishu] Failed to resolve slash confirmation: %s", exc)`;
const commanderRouter = `    async def _route_ajun_commander_event(self, event: MessageEvent) -> bool:
        """Relay the one Feishu commander entry to the local A君 runtime."""
        ingress_url = os.getenv("AJUN_FEISHU_COMMANDER_INGRESS_URL", "").strip()
        if not ingress_url or event.message_type != MessageType.TEXT:
            return False
        if not ingress_url.startswith("http://127.0.0.1:"):
            logger.error("[Feishu] Refusing non-local A君 commander ingress URL")
            return False
        if getattr(event, "_ajun_commander_routed", False):
            return True
        setattr(event, "_ajun_commander_routed", True)
        chat_id = getattr(event.source, "chat_id", "") if event.source else ""
        sender = getattr(event.source, "sender_id", "") if event.source else ""
        payload = json.dumps({
            "sourceEventRef": f"feishu:{event.message_id or ''}",
            "text": (event.text or "").strip(),
            "chatRef": chat_id,
            "requesterRef": sender,
            # When this adapter is installed for a named employee's Feishu app,
            # keep that identity. A君 still owns the shared task record,
            # approvals and follow-up instead of creating a second task system.
            "targetAgentId": os.getenv("AJUN_FEISHU_ENTRY_AGENT_ID", "").strip(),
        }, ensure_ascii=False).encode("utf-8")

        def _post_to_ajun() -> tuple[int, dict]:
            request = Request(ingress_url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
            with urlopen(request, timeout=8) as response:
                return int(response.status), json.loads(response.read().decode("utf-8"))

        try:
            status, body = await self._run_blocking(_post_to_ajun)
            reply = body.get("reply") if isinstance(body, dict) else None
            if status in {200, 201, 202} and isinstance(reply, str) and reply:
                if chat_id:
                    await self.send(chat_id, reply, reply_to=event.message_id)
                return True
        except (HTTPError, URLError, OSError, ValueError, json.JSONDecodeError) as exc:
            logger.warning("[Feishu] A君 commander ingress failed: %s", exc)
        if chat_id:
            await self.send(chat_id, "军团总管暂时无法登记这条命令；未启动任何外部动作，请稍后重试。", reply_to=event.message_id)
        return True`;
const commanderCompletionMethods = `    def _schedule_ajun_task_completion_notification(self, *, chat_id: str, task_id: str, base_url: str) -> None:
        """Follow one A君 task through recovery and notify its originating chat once."""
        key = f"ajun:{task_id}"
        tasks = self._xiaod_job_notification_tasks
        existing = tasks.get(key)
        if existing and not existing.done():
            return
        task = asyncio.create_task(self._notify_ajun_task_completion(chat_id=chat_id, task_id=task_id, base_url=base_url))
        tasks[key] = task
        task.add_done_callback(lambda _task: tasks.pop(key, None))

    async def _notify_ajun_task_completion(self, *, chat_id: str, task_id: str, base_url: str) -> None:
        """Poll the local A君 task-chain view and send one final result."""
        endpoint = f"{base_url.rstrip('/')}/api/feishu/task-status"
        payload = json.dumps({"taskId": task_id, "chatRef": chat_id}, ensure_ascii=False).encode("utf-8")
        for _attempt in range(900):
            try:
                def _get_ajun_task_status() -> dict:
                    request = Request(endpoint, data=payload, headers={"Content-Type": "application/json"}, method="POST")
                    with urlopen(request, timeout=5) as response:
                        return json.loads(response.read().decode("utf-8"))

                body = await self._run_blocking(_get_ajun_task_status)
                if isinstance(body, dict) and body.get("terminal") is True and isinstance(body.get("message"), str):
                    result = await self.send(chat_id, body["message"])
                    if result.success:
                        return
            except asyncio.CancelledError:
                raise
            except (HTTPError, URLError, OSError, ValueError, json.JSONDecodeError) as exc:
                logger.warning("[Feishu] A君 task status lookup failed: %s", exc)
            await asyncio.sleep(2)
        logger.warning("[Feishu] A君 task did not reach a final state within 30 minutes")`;
const commanderCompletionPersistenceMethods = `    def _load_ajun_task_completion_notifications(self) -> Dict[str, Dict[str, str]]:
        try:
            payload = json.loads(self._ajun_completion_watches_path.read_text(encoding="utf-8"))
            return payload if isinstance(payload, dict) else {}
        except (OSError, ValueError, json.JSONDecodeError):
            return {}

    def _save_ajun_task_completion_notifications(self, watches: Dict[str, Dict[str, str]]) -> None:
        try:
            temp_path = self._ajun_completion_watches_path.with_suffix(".tmp")
            temp_path.write_text(json.dumps(watches, ensure_ascii=False), encoding="utf-8")
            temp_path.replace(self._ajun_completion_watches_path)
        except OSError as exc:
            logger.warning("[Feishu] Could not save A君 task completion watches: %s", exc)

    def _remember_ajun_task_completion_notification(self, *, chat_id: str, task_id: str, base_url: str) -> None:
        if not chat_id or not task_id or not base_url.startswith("http://127.0.0.1:"):
            return
        watches = self._load_ajun_task_completion_notifications()
        watches[task_id] = {"chat_id": chat_id, "task_id": task_id, "base_url": base_url}
        self._save_ajun_task_completion_notifications(watches)

    def _forget_ajun_task_completion_notification(self, task_id: str) -> None:
        watches = self._load_ajun_task_completion_notifications()
        if watches.pop(task_id, None) is not None:
            self._save_ajun_task_completion_notifications(watches)

    def _restore_ajun_task_completion_notifications(self) -> None:
        for watch in self._load_ajun_task_completion_notifications().values():
            if not isinstance(watch, dict):
                continue
            chat_id = str(watch.get("chat_id", "") or "")
            task_id = str(watch.get("task_id", "") or "")
            base_url = str(watch.get("base_url", "") or "").strip()
            if chat_id and task_id and base_url.startswith("http://127.0.0.1:"):
                self._schedule_ajun_task_completion_notification(chat_id=chat_id, task_id=task_id, base_url=base_url)`;
const dynamicTaskCardMethods = `    def _ajun_dynamic_task_cards_enabled(self) -> bool:
        if os.getenv("AJUN_FEISHU_DYNAMIC_TASK_CARD", "").strip().lower() != "true":
            return False
        try:
            from .agent_army_task_card import render_task_card, decide_task_card_delivery, poll_interval_seconds
            return all((render_task_card, decide_task_card_delivery, poll_interval_seconds))
        except ImportError as exc:
            logger.warning("[Feishu] Dynamic task card runtime unavailable; using text fallback: %s", exc)
            return False

    def _load_ajun_task_cards(self) -> Dict[str, Dict[str, Any]]:
        with self._ajun_task_cards_lock:
            try:
                payload = json.loads(self._ajun_task_cards_path.read_text(encoding="utf-8"))
                if not isinstance(payload, dict):
                    raise ValueError("dynamic task card ledger must be an object")
                return payload
            except FileNotFoundError:
                return {}
            except (OSError, ValueError, json.JSONDecodeError) as exc:
                raise RuntimeError("dynamic task card ledger is unreadable; refusing duplicate delivery") from exc

    def _save_ajun_task_cards(self, records: Dict[str, Dict[str, Any]]) -> None:
        with self._ajun_task_cards_lock:
            temp_path = self._ajun_task_cards_path.with_name(
                self._ajun_task_cards_path.name + "." + str(__import__("uuid").uuid4()) + ".tmp"
            )
            try:
                with temp_path.open("x", encoding="utf-8") as handle:
                    handle.write(json.dumps(records, ensure_ascii=False))
                os.chmod(temp_path, 0o600)
                temp_path.replace(self._ajun_task_cards_path)
                os.chmod(self._ajun_task_cards_path, 0o600)
            except OSError as exc:
                try:
                    temp_path.unlink(missing_ok=True)
                except OSError:
                    pass
                raise RuntimeError("dynamic task card ledger write failed; delivery stopped") from exc

    def _put_ajun_task_card(self, task_id: str, record: Dict[str, Any]) -> None:
        with self._ajun_task_cards_lock:
            records = self._load_ajun_task_cards()
            records[task_id] = record
            self._save_ajun_task_cards(records)

    def _start_ajun_task_card_supervisor(self) -> None:
        if not self._ajun_dynamic_task_cards_enabled():
            return
        task = self._ajun_task_card_supervisor_task
        if task is None or task.done():
            self._ajun_task_card_supervisor_task = asyncio.create_task(self._supervise_ajun_task_cards())

    def _wake_ajun_task_card_supervisor(self) -> None:
        self._start_ajun_task_card_supervisor()
        if self._ajun_task_card_supervisor_task is not None:
            self._ajun_task_card_wake.set()

    async def _deliver_ajun_task_card(
        self, *, chat_id: str, projection: Dict[str, Any], reply_to: Optional[str] = None,
        completion_watch: Optional[Dict[str, Any]] = None,
    ) -> bool:
        """Render one authoritative projection into one persistent Feishu message anchor."""
        try:
            from .agent_army_task_card import render_task_card, decide_task_card_delivery
            task_id = str(projection.get("taskId", "") or "")
            if not task_id:
                return False
            try:
                records = self._load_ajun_task_cards()
            except RuntimeError as exc:
                # An existing anchor may still be visible. Treat an unreadable
                # ledger as handled-uncertain and never add a fallback message.
                logger.error("[Feishu] Dynamic task card ledger unreadable; fallback suppressed: %s", exc)
                return True
            previous = records.get(task_id) if isinstance(records.get(task_id), dict) else None
            decision = decide_task_card_delivery(previous, projection)
            operation = str(decision.get("operation", "") or "") if isinstance(decision, dict) else ""
            if operation == "skip":
                return True
            if operation == "anchor_uncertain":
                # A prior send may already have succeeded. Never create a duplicate anchor blindly.
                return True
            card = render_task_card(projection)
            now = __import__("time").time()
            source_revision = projection.get("sourceRevision")
            content_hash = str(projection.get("contentHash", "") or "")
            base_url = ""
            if isinstance(completion_watch, dict):
                base_url = str(completion_watch.get("baseUrl", "") or "").strip()
            if not base_url and previous:
                base_url = str(previous.get("base_url", "") or "")
            if not base_url:
                ingress_url = os.getenv("AJUN_FEISHU_COMMANDER_INGRESS_URL", "").strip()
                if ingress_url.startswith("http://127.0.0.1:"):
                    base_url = ingress_url.split("/api/feishu/commander", 1)[0]

            if operation == "update" and previous:
                message_id = str(decision.get("messageId", "") or previous.get("message_id", "") or "")
                if not message_id:
                    return True
                updated = await self._update_ajun_task_card(message_id=message_id, card=card)
                if not updated:
                    return True
                record = dict(previous)
                record.update({"last_source_revision": source_revision, "last_content_hash": content_hash, "last_notified_state": str(projection.get("state", "") or ""), "delivery_state": "sent", "updated_at": now, "terminal": projection.get("terminal") is True})
                try:
                    self._put_ajun_task_card(task_id, record)
                except RuntimeError as exc:
                    logger.error("[Feishu] Dynamic task card was updated but its ledger could not advance: %s", exc)
                    return True
                if not record["terminal"]:
                    self._wake_ajun_task_card_supervisor()
                return True

            record = {
                "task_id": task_id, "chat_id": chat_id, "message_id": "",
                "delivery_id": str(__import__("uuid").uuid4()), "agent_id": "ajun",
                "profile_fingerprint": __import__("hashlib").sha256(str(get_hermes_home()).encode("utf-8")).hexdigest()[:24],
                "last_source_revision": source_revision, "last_content_hash": content_hash,
                "last_notified_state": str(projection.get("state", "") or ""),
                "delivery_state": "sending", "attempt_count": int((previous or {}).get("attempt_count", 0) or 0) + 1, "base_url": base_url,
                "created_at": now, "updated_at": now, "next_poll_at": now,
                "terminal": projection.get("terminal") is True,
            }
            try:
                self._put_ajun_task_card(task_id, record)
            except RuntimeError as exc:
                # No provider call occurred. Text fallback is safe because the
                # sending intent was not durably recorded.
                logger.error("[Feishu] Dynamic task card intent was not persisted; send skipped: %s", exc)
                return False
            try:
                response = await self._feishu_send_with_retry(
                    chat_id=chat_id, msg_type="interactive", payload=json.dumps(card, ensure_ascii=False),
                    reply_to=reply_to, metadata=None,
                )
            except Exception as exc:
                # The transport may have failed after Feishu accepted the card.
                # Preserve the sending intent as uncertain and suppress a text
                # fallback that could become a second visible task message.
                record.update({"delivery_state": "anchor_uncertain", "updated_at": __import__("time").time()})
                try:
                    self._put_ajun_task_card(task_id, record)
                except RuntimeError as ledger_exc:
                    logger.error("[Feishu] Dynamic card outcome uncertain and ledger update failed: %s", ledger_exc)
                logger.warning("[Feishu] Dynamic task card send outcome is uncertain; duplicate fallback suppressed: %s", exc)
                return True
            send_result = self._finalize_send_result(response, "send A君 dynamic task card failed")
            try:
                records = self._load_ajun_task_cards()
            except RuntimeError as exc:
                # The provider call has already happened. The old anchor may
                # exist even though its ledger cannot be read, so fail closed
                # and suppress every text/card fallback.
                logger.error("[Feishu] Dynamic task card provider call completed but ledger became unreadable: %s", exc)
                return True
            record = records.get(task_id) if isinstance(records.get(task_id), dict) else record
            if send_result.success:
                if send_result.message_id:
                    record.update({"message_id": send_result.message_id, "delivery_state": "sent", "last_notified_state": str(projection.get("state", "") or ""), "updated_at": __import__("time").time()})
                else:
                    record.update({"delivery_state": "anchor_uncertain", "updated_at": __import__("time").time()})
            else:
                # A normal API error response proves this attempt did not create
                # an anchor. One text fallback is safe; the card intent remains
                # available for at most one explicit not-started retry.
                record.update({"delivery_state": "not_started", "updated_at": __import__("time").time()})
            try:
                self._put_ajun_task_card(task_id, record)
            except RuntimeError as exc:
                # The provider call already occurred. Never add a text fallback
                # or another card when the anchor ledger cannot be advanced.
                logger.error("[Feishu] Dynamic task card provider call completed but ledger update failed: %s", exc)
                return True
            if record.get("delivery_state") == "sent" and not record.get("terminal"):
                self._wake_ajun_task_card_supervisor()
            return bool(send_result.success)
        except Exception as exc:
            logger.warning("[Feishu] Dynamic task card delivery failed; using text fallback when safe: %s", exc)
            return False

    async def _update_ajun_task_card(self, *, message_id: str, card: Dict[str, Any]) -> bool:
        """Use Feishu's card-capable message PATCH, never text-only edit_message."""
        try:
            from lark_oapi.api.im.v1 import PatchMessageRequest, PatchMessageRequestBody
            body = PatchMessageRequestBody.builder().content(json.dumps(card, ensure_ascii=False)).build()
            request = PatchMessageRequest.builder().message_id(message_id).request_body(body).build()
            response = await self._run_blocking(self._client.im.v1.message.patch, request)
            if response and getattr(response, "success", lambda: False)():
                return True
            logger.warning("[Feishu] Dynamic task card update rejected: code=%s", getattr(response, "code", None))
        except Exception as exc:
            logger.warning("[Feishu] Dynamic task card update failed: %s", exc)
        return False

    async def _supervise_ajun_task_cards(self) -> None:
        """One bounded supervisor scans all card watches; no per-task timers or fixed timeout."""
        semaphore = asyncio.Semaphore(3)
        while self._ajun_dynamic_task_cards_enabled():
            now = __import__("time").time()
            records = self._load_ajun_task_cards()
            due = [
                dict(record) for record in records.values()
                if isinstance(record, dict)
                and record.get("delivery_state") == "sent"
                and not record.get("terminal")
                and str(record.get("base_url", "") or "").startswith("http://127.0.0.1:")
                and float(record.get("next_poll_at", 0) or 0) <= now
            ]
            async def _bounded(record: Dict[str, Any]) -> None:
                async with semaphore:
                    await self._poll_one_ajun_task_card(record)
            if due:
                await asyncio.gather(*(_bounded(record) for record in due))
                continue
            self._ajun_task_card_wake.clear()
            try:
                await asyncio.wait_for(self._ajun_task_card_wake.wait(), timeout=2)
            except asyncio.TimeoutError:
                pass

    async def _poll_one_ajun_task_card(self, record: Dict[str, Any]) -> None:
        task_id = str(record.get("task_id", "") or "")
        chat_id = str(record.get("chat_id", "") or "")
        base_url = str(record.get("base_url", "") or "").rstrip("/")
        try:
            endpoint = f"{base_url}/api/feishu/task-status"
            payload = json.dumps({"taskId": task_id, "chatRef": chat_id}, ensure_ascii=False).encode("utf-8")
            def _read_projection() -> dict:
                request = Request(endpoint, data=payload, headers={"Content-Type": "application/json"}, method="POST")
                with urlopen(request, timeout=5) as response:
                    return json.loads(response.read().decode("utf-8"))
            body = await self._run_blocking(_read_projection)
            projection = body.get("taskCard") if isinstance(body, dict) else None
            if isinstance(projection, dict):
                await self._deliver_ajun_task_card(chat_id=chat_id, projection=projection)
        except asyncio.CancelledError:
            raise
        except (HTTPError, URLError, OSError, ValueError, json.JSONDecodeError) as exc:
            logger.warning("[Feishu] Dynamic task card projection lookup failed: %s", exc)
        finally:
            from .agent_army_task_card import poll_interval_seconds
            records = self._load_ajun_task_cards()
            current = records.get(task_id)
            if isinstance(current, dict) and not current.get("terminal"):
                now = __import__("time").time()
                age = max(0, now - float(current.get("created_at", now) or now))
                current["next_poll_at"] = now + poll_interval_seconds(age_seconds=age)
                current["updated_at"] = now
                self._put_ajun_task_card(task_id, current)`;
const dynamicTaskCardCallback = `    def _handle_ajun_task_card_action(self, *, event: Any, action_value: Dict[str, Any]) -> Any:
        """Write the authoritative decision first, then replace the clicked card."""
        action = str(action_value.get("agent_army_task_card_action", "") or "")
        task_id = str(action_value.get("task_id", "") or "")
        source_revision = action_value.get("source_revision")
        content_hash = str(action_value.get("content_hash", "") or "")
        approval_id = str(action_value.get("approval_id", "") or "")
        governance_mode = str(action_value.get("governance_mode", "local") or "local")
        operator = getattr(event, "operator", None)
        open_id = str(getattr(operator, "open_id", "") or "")
        context = getattr(event, "context", None)
        chat_id = str(getattr(context, "open_chat_id", "") or "")
        # The clicked message from callback context is the only valid anchor.
        message_id = str(getattr(context, "open_message_id", "") or "")
        response = P2CardActionTriggerResponse() if P2CardActionTriggerResponse else None
        def _error_response(content: str) -> Any:
            if response is not None:
                from lark_oapi.event.callback.model.p2_card_action_trigger import CallBackToast
                toast = CallBackToast(); toast.type = "error"; toast.content = content
                response.toast = toast
            return response
        try:
            records = self._load_ajun_task_cards()
        except RuntimeError as exc:
            logger.error("[Feishu] Dynamic task card callback ledger unreadable: %s", exc)
            return _error_response("卡片记录暂时不可读取，本次操作未生效。")
        record = records.get(task_id) if isinstance(records.get(task_id), dict) else None
        valid = (
            action in {"approve", "reject", "pause", "resume"}
            and task_id and message_id and record
            and str(record.get("message_id", "") or "") == message_id
            and record.get("last_source_revision") == source_revision
            and str(record.get("last_content_hash", "") or "") == content_hash
            and self._is_interactive_operator_authorized(open_id)
        )
        if not valid:
            return _error_response("卡片状态已变化，请等待刷新后再操作。")
        ingress_url = os.getenv("AJUN_FEISHU_COMMANDER_INGRESS_URL", "").strip()
        if not ingress_url.startswith("http://127.0.0.1:"):
            return _error_response("任务入口不可用，本次操作未生效。")
        endpoint = ingress_url.split("/api/feishu/commander", 1)[0] + "/api/feishu/task-card-actions"
        payload = json.dumps({
            "taskId": task_id, "action": action, "approvalId": approval_id,
            "governanceMode": governance_mode, "sourceRevision": source_revision,
            "contentHash": content_hash, "requesterRef": open_id, "chatRef": chat_id,
            "messageId": message_id,
        }, ensure_ascii=False).encode("utf-8")
        try:
            request = Request(endpoint, data=payload, headers={"Content-Type": "application/json"}, method="POST")
            with urlopen(request, timeout=8) as provider_response:
                status = int(provider_response.status)
                body = json.loads(provider_response.read().decode("utf-8"))
            projection = body.get("taskCard") if isinstance(body, dict) else None
            if status not in {200, 201, 202} or not isinstance(projection, dict):
                raise ValueError("authoritative decision was not accepted")
            # The authoritative response wins. A stale callback can never restore old buttons.
            from .agent_army_task_card import render_task_card
            decided_card = render_task_card(projection)
            # Do not claim the callback card was visibly applied before Feishu
            # acknowledges it. Keep the old revision in the ledger so the
            # supervisor converges the same message through the PATCH path even
            # if the synchronous callback response is dropped.
            record["next_poll_at"] = 0
            self._put_ajun_task_card(task_id, record)
            self._wake_ajun_task_card_supervisor()
            if response is not None and CallBackCard is not None:
                card = CallBackCard(); card.type = "raw"; card.data = decided_card
                response.card = card
            return response
        except (HTTPError, URLError, OSError, ValueError, json.JSONDecodeError) as exc:
            logger.warning("[Feishu] Dynamic task card action rejected without changing card: %s", exc)
            return _error_response("操作未生效，请重试。")`;
const approvalCardMethods = `    async def _send_ajun_approval_card(self, chat_id: str, approval: Dict[str, Any], *, reply_to: Optional[str] = None) -> SendResult:
        """AJUN_APPROVAL_CARD_V2: send a local or Paperclip-governed approval card."""
        approval_id = str(approval.get("approvalId", "") or "")
        if not approval_id:
            return SendResult(success=False, error="missing A君 approval id")
        scope = approval.get("requestedScope") if isinstance(approval.get("requestedScope"), dict) else {}
        scope_text = str(scope.get("title") or scope.get("taskType") or "本次任务")[:500]
        reason = str(approval.get("reason") or "需要确认本次范围。")[:500]
        valid_until = str(approval.get("validUntil") or "")[:80]
        governance_mode = str(approval.get("governanceMode") or "local")
        approval_action = str(approval.get("action") or "")
        # AJUN_PROPOSAL_TRIAL_READINESS_V1: keep a draft honest when no real worker exists yet.
        proposal_ready_for_trial = approval.get("trialReadyForTest") is True
        # AJUN_TASK_CONTROL_CARD_V1: pause/resume decisions have truthful labels.
        is_governance = governance_mode in {"paperclip", "proposal"}
        def _button(label: str, action: str, style: str) -> dict:
            return {"tag": "button", "text": {"tag": "plain_text", "content": label}, "type": style, "value": {"ajun_approval_action": action, "approval_id": approval_id, "governance_mode": governance_mode}}
        title = "A君 · 新岗位审核" if governance_mode == "proposal" else "A君 · 组织级审批" if is_governance else "A君 · 本次审批"
        note = "同意后仅进入小范围试用，不会直接上线。" if governance_mode == "proposal" and proposal_ready_for_trial else "当前还没有对应的真实执行能力；同意只保留草案并转为待补能力，不会进入试用或上线。" if governance_mode == "proposal" else "决定会先写入 Paperclip；确认范围、有效期后才会继续任务。" if is_governance else "只会批准卡片所列范围，不会永久扩权。"
        approve_label = "批准所列范围"
        reject_label = "拒绝并关闭"
        if governance_mode == "proposal" and not proposal_ready_for_trial:
            approve_label = "同意保留草案"
        if approval_action == "pause-task":
            approve_label, reject_label = "同意暂停", "保持继续处理"
        elif approval_action == "resume-task":
            approve_label, reject_label = "同意继续", "保持暂停"
        card = {"config": {"wide_screen_mode": True}, "header": {"title": {"tag": "plain_text", "content": title}, "template": "orange"}, "elements": [
            {"tag": "markdown", "content": f"**事项**：{scope_text}\\n**原因**：{reason}\\n**有效期**：{valid_until or '本次任务'}\\n\\n{note}"},
            {"tag": "action", "actions": [_button(approve_label, "approve", "primary"), _button(reject_label, "reject", "danger")]}
        ]}
        try:
            response = await self._feishu_send_with_retry(chat_id=chat_id, msg_type="interactive", payload=json.dumps(card, ensure_ascii=False), reply_to=reply_to, metadata=None)
            return self._finalize_send_result(response, "send A君 approval card failed")
        except Exception as exc:
            logger.warning("[Feishu] Failed to send A君 approval card: %s", exc)
            return SendResult(success=False, error=str(exc))`;
const approvalCardCallback = `    def _handle_ajun_approval_card_action(self, *, event: Any, action_value: Dict[str, Any], loop: Any) -> Any:
        approval_id = str(action_value.get("approval_id", "") or "")
        action = str(action_value.get("ajun_approval_action", "") or "")
        governance_mode = str(action_value.get("governance_mode", "local") or "local")
        operator = getattr(event, "operator", None)
        open_id = str(getattr(operator, "open_id", "") or "")
        chat_id = str(getattr(getattr(event, "context", None), "open_chat_id", "") or "")
        if not approval_id or action not in {"approve", "reject"} or governance_mode not in {"local", "paperclip", "proposal"} or not self._is_interactive_operator_authorized(open_id):
            return P2CardActionTriggerResponse() if P2CardActionTriggerResponse else None
        self._submit_on_loop(loop, self._resolve_ajun_approval(approval_id, action, open_id, chat_id, governance_mode))
        if P2CardActionTriggerResponse is None:
            return None
        response = P2CardActionTriggerResponse()
        if CallBackCard is not None:
            card = CallBackCard(); card.type = "raw"
            card.data = {"config": {"wide_screen_mode": True}, "header": {"title": {"tag": "plain_text", "content": "A君 · 审批处理中"}, "template": "blue"}, "elements": [{"tag": "markdown", "content": "已收到你的决定，正在校验范围并更新任务。"}]}
            response.card = card
        return response`;
const approvalCardResolver = `    async def _resolve_ajun_approval(self, approval_id: str, action: str, open_id: str, chat_id: str, governance_mode: str = "local") -> None:
        ingress_url = os.getenv("AJUN_FEISHU_COMMANDER_INGRESS_URL", "").strip()
        if not ingress_url.startswith("http://127.0.0.1:"):
            logger.error("[Feishu] Refusing non-local A君 approval ingress URL")
            return
        base = ingress_url.split("/api/feishu/commander", 1)[0]
        endpoint_group = "proposal-approvals" if governance_mode == "proposal" else "governance-approvals" if governance_mode == "paperclip" else "approvals"
        endpoint = f"{base}/api/feishu/{endpoint_group}/{approval_id}/{action}"
        payload = json.dumps({"requesterRef": open_id, "chatRef": chat_id}, ensure_ascii=False).encode("utf-8")
        def _post_to_ajun() -> tuple[int, dict]:
            request = Request(endpoint, data=payload, headers={"Content-Type": "application/json"}, method="POST")
            with urlopen(request, timeout=8) as response:
                return int(response.status), json.loads(response.read().decode("utf-8"))
        try:
            status, body = await self._run_blocking(_post_to_ajun)
            result = body.get("proposal") if governance_mode == "proposal" and isinstance(body, dict) else body.get("task") if isinstance(body, dict) else None
            if status in {200, 201, 202} and isinstance(result, dict):
                if governance_mode == "proposal" and action == "approve":
                    label = "已批准，现进入小范围试用" if str(result.get("status", "") or "") == "testing" else "已记录草案；当前还缺真实执行能力，已转为待补能力，不会进入试用或上线"
                else:
                    label = "已拒绝，草案已关闭" if governance_mode == "proposal" else "已批准，正在按确认范围执行" if action == "approve" else "已拒绝本次变更，原任务状态保持不变"
                if chat_id:
                    await self.send(chat_id, f"{label}。", reply_to=None)
                return
        except (HTTPError, URLError, OSError, ValueError, json.JSONDecodeError) as exc:
            logger.warning("[Feishu] A君 approval callback failed: %s", exc)
        if chat_id:
            await self.send(chat_id, "审批未生效：任务范围、会话或有效期未通过校验，未执行任何动作。", reply_to=None)`;
const proposalRouter = `    async def _route_ajun_agent_proposal_event(self, event: MessageEvent) -> bool:
        """Route Feishu natural-language Agent creation to the local A君 proposal gate.

        This intentionally bypasses the LLM. A user message can create only a
        draft proposal; Paperclip approval and a restricted test remain gates.
        """
        ingress_url = os.getenv("AJUN_AGENT_PROPOSAL_INGRESS_URL", "").strip()
        if not ingress_url or event.message_type != MessageType.TEXT:
            return False
        if not ingress_url.startswith("http://127.0.0.1:"):
            logger.error("[Feishu] Refusing non-local A君 proposal ingress URL")
            return False
        if not _AJUN_AGENT_PROPOSAL_RE.search(event.text or ""):
            return False
        if getattr(event, "_ajun_agent_proposal_routed", False):
            return True
        setattr(event, "_ajun_agent_proposal_routed", True)
        payload = json.dumps({
            "sourceEventRef": f"feishu:{event.message_id or ''}",
            "requestedOutcome": (event.text or "").strip(),
        }, ensure_ascii=False).encode("utf-8")

        def _post_to_ajun() -> tuple[int, dict]:
            request = Request(ingress_url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
            with urlopen(request, timeout=8) as response:
                return int(response.status), json.loads(response.read().decode("utf-8"))

        chat_id = getattr(event.source, "chat_id", "") if event.source else ""
        try:
            status, body = await self._run_blocking(_post_to_ajun)
            proposal = body.get("proposal") if isinstance(body, dict) else None
            proposal_id = proposal.get("proposalId") if isinstance(proposal, dict) else None
            proposal_status = proposal.get("status") if isinstance(proposal, dict) else None
            if status in {200, 201, 202} and proposal_id:
                if proposal_status == "pending_approval":
                    message = f"已生成 Agent 草案「{proposal_id}」并提交 Paperclip 审核；通过受限测试前不会上线。"
                else:
                    message = f"已找到 Agent 草案「{proposal_id}」，当前状态：{proposal_status or 'draft'}。"
                if chat_id:
                    await self.send(chat_id, message, reply_to=event.message_id)
                return True
        except (HTTPError, URLError, OSError, ValueError, json.JSONDecodeError) as exc:
            logger.warning("[Feishu] A君 proposal ingress failed: %s", exc)
        if chat_id:
            await self.send(chat_id, "创建官暂时无法登记草案；未创建或上线任何 Agent，请稍后重试。", reply_to=event.message_id)
        return True`;

async function main() {
  const filePath = process.argv[2] || defaultAdapter;
  const original = await fs.readFile(filePath, 'utf8');
  const patched = applyPatch(original);
  const taskCardRuntimeTarget = path.join(path.dirname(filePath), 'agent_army_task_card.py');
  await fs.copyFile(taskCardRuntimeSource, taskCardRuntimeTarget);
  if (patched === original) return console.log(`Hermes 飞书动态任务卡已存在：${filePath}`);
  await fs.writeFile(filePath, patched);
  console.log(`已安装 Hermes 飞书动态任务卡与军团总管路由：${filePath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

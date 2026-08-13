import {
  replaceRequired,
  SUPPORTED_HERMES_GIT_COMMIT,
  SUPPORTED_HERMES_VERSION,
} from './patch-support.mjs';

const adapterSeamMarker = 'AGENT_ARMY_HERMES_FEISHU_ADAPTER_SEAM_V1';

export function installFeishuExperiencePatches(source) {
  return [
    upgradeFeishuBusinessUiPatch,
    upgradeFeishuSlashConfirmPatch,
    upgradeFeishuMobileMessagePatch,
    upgradeFeishuPostBlockRowsPatch,
    upgradeFeishuBusyQuickActionsPatch,
    upgradeFeishuSenderIdentityPatch,
    upgradeFeishuImmediateStatusPatch,
    upgradeFeishuReactionReliabilityPatch,
    installTaskCardAdapterSeam,
  ].reduce((result, patchUnit) => patchUnit(result), source);
}

function insert(source, marker, replacement) {
  return replaceRequired(
    source,
    marker,
    replacement,
    `Hermes 当前 Feishu 适配器结构不匹配，找不到补丁锚点：${marker.slice(0, 72)}`,
  );
}

function installTaskCardAdapterSeam(source) {
  if (source.includes(adapterSeamMarker)) return source;
  let result = source;
  const methodsStart = result.indexOf('    def _agent_army_task_card_policy(');
  const generalizedMethodsStart = result.indexOf('    def _agent_army_dynamic_task_cards_enabled(');
  const legacyMethodsStart = result.indexOf('    def _ajun_dynamic_task_cards_enabled(');
  const activeMethodsStart = methodsStart >= 0
    ? methodsStart
    : generalizedMethodsStart >= 0
      ? generalizedMethodsStart
      : legacyMethodsStart;
  const methodsEnd = result.indexOf('\n    async def _send_ajun_approval_card(', activeMethodsStart);
  if (activeMethodsStart >= 0 && methodsEnd >= 0) {
    result = `${result.slice(0, activeMethodsStart)}${result.slice(methodsEnd + 1)}`;
  }
  for (const callbackName of ['_handle_agent_army_task_card_action', '_handle_ajun_task_card_action']) {
    const callbackStart = result.indexOf(`    def ${callbackName}(`);
    const callbackEnd = result.indexOf('\n    def _handle_ajun_approval_card_action(', callbackStart);
    if (callbackStart >= 0 && callbackEnd >= 0) {
      result = `${result.slice(0, callbackStart)}${result.slice(callbackEnd + 1)}`;
      break;
    }
  }
  return `${result.trimEnd()}\n\n# ${adapterSeamMarker}: pinned, validated plugin installation only.\nfrom .agent_army_task_card import install_agent_army_feishu_task_card_adapter\n\ninstall_agent_army_feishu_task_card_adapter(\n    FeishuAdapter,\n    hermes_version="${SUPPORTED_HERMES_VERSION}",\n    hermes_git_commit="${SUPPORTED_HERMES_GIT_COMMIT}",\n    host_symbols=globals(),\n)\n`;
}

function upgradeFeishuPostBlockRowsPatch(source) {
  if (source.includes('AGENT_ARMY_FEISHU_SEMANTIC_LAYOUT_V1')) return source;
  let result = source;
  const current = '    if "```" not in content:\n        return [[{"tag": "md", "text": content}]]';
  const legacyV1 = `    if "\`\`\`" not in content:
        # AGENT_ARMY_FEISHU_POST_BLOCK_ROWS_V1: Feishu collapses blank lines
        # inside one md element. Preserve intentional breathing room as real
        # post rows, with a non-breaking spacer row between semantic blocks.
        blocks = [block.strip() for block in re.split(r"\\n{2,}", content) if block.strip()]
        if len(blocks) <= 1:
            return [[{"tag": "md", "text": content}]]
        rows: List[List[Dict[str, str]]] = []
        for block_index, block in enumerate(blocks):
            if block_index:
                rows.append([{"tag": "text", "text": "\\u00a0"}])
            rows.append([{"tag": "md", "text": block}])
        return rows`;
  const v2 = `    if "\`\`\`" not in content:
        # AGENT_ARMY_FEISHU_POST_BLOCK_ROWS_V2: use three stable spacing tiers.
        # Adjacent semantic lines become adjacent post rows; section breaks get
        # one spacer row; markdown tables stay together so they still render.
        blocks = [block.strip() for block in re.split(r"\\n{2,}", content) if block.strip()]
        table_separator_re = re.compile(r"(?m)^\\s*\\|?\\s*:?-{3,}.*\\|\\s*$")
        rows: List[List[Dict[str, str]]] = []
        for block_index, block in enumerate(blocks):
            if block_index:
                rows.append([{"tag": "text", "text": "\\u00a0"}])
            block_lines = [line.rstrip() for line in block.splitlines() if line.strip()]
            if table_separator_re.search(block):
                rows.append([{"tag": "md", "text": block}])
                continue
            for line in block_lines:
                rows.append([{"tag": "md", "text": line}])
        return rows or [[{"tag": "md", "text": content}]]`;
  if (!result.includes('AGENT_ARMY_FEISHU_POST_BLOCK_ROWS_V2')) {
    if (result.includes(legacyV1)) result = result.replace(legacyV1, v2);
    else if (result.includes(current)) result = result.replace(current, v2);
  }
  const v2Start = `    if "\`\`\`" not in content:
        # AGENT_ARMY_FEISHU_POST_BLOCK_ROWS_V2: use three stable spacing tiers.`;
  if (!result.includes(v2Start)) return result;
  return result.replace(
    v2Start,
    `    # AGENT_ARMY_FEISHU_SEMANTIC_LAYOUT_V1: derive rows from Markdown AST.
    try:
        from .agent_army_layout import build_semantic_post_rows
    except ImportError:
        build_semantic_post_rows = None
    if build_semantic_post_rows is not None:
        return build_semantic_post_rows(content)

${v2Start}`
  );
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
  if (source.includes('AGENT_ARMY_FEISHU_MOBILE_FORMAT_V9')) return source;
  if (
    source.includes('AGENT_ARMY_FEISHU_MOBILE_FORMAT_V2')
    || source.includes('AGENT_ARMY_FEISHU_MOBILE_FORMAT_V1')
    || source.includes('AGENT_ARMY_FEISHU_MOBILE_FORMAT_V3')
    || source.includes('AGENT_ARMY_FEISHU_MOBILE_FORMAT_V4')
    || source.includes('AGENT_ARMY_FEISHU_MOBILE_FORMAT_V5')
    || source.includes('AGENT_ARMY_FEISHU_MOBILE_FORMAT_V6')
    || source.includes('AGENT_ARMY_FEISHU_MOBILE_FORMAT_V7')
    || source.includes('AGENT_ARMY_FEISHU_MOBILE_FORMAT_V8')
  ) {
    const helperStart = source.search(/# AGENT_ARMY_FEISHU_MOBILE_FORMAT_V[12345678]:/);
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

const feishuMobileMessageHelpers = String.raw`# AGENT_ARMY_FEISHU_MOBILE_FORMAT_V9: normalize spacing and emphasis instead of trusting model whitespace.
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


def _agent_army_strip_inline_bold(text: str) -> str:
    return re.sub(r"\*\*([^*\n]+)\*\*", r"\1", text)


def _agent_army_normalize_emphasis(content: str) -> str:
    """Keep bold for headings and leading labels, not arbitrary model emphasis."""
    list_re = re.compile(r"^(\s*(?:[-*]|\d+[.)、])\s+)(.*)$")
    label_inside_re = re.compile(r"^\*\*([^*\n]{1,32}[：:])\*\*\s*(.*)$")
    label_outside_re = re.compile(r"^\*\*([^*\n]{1,32})\*\*\s*([：:])\s*(.*)$")
    output: List[str] = []
    for line in content.splitlines():
        compact = line.strip()
        if _agent_army_is_section_heading(line) or re.match(r"^#{1,6}\s+\S", compact):
            output.append(line)
            continue

        list_match = list_re.match(line)
        prefix = list_match.group(1) if list_match else ""
        body = list_match.group(2) if list_match else line
        inside_match = label_inside_re.match(body)
        outside_match = label_outside_re.match(body)
        if inside_match:
            label = inside_match.group(1)
            rest = _agent_army_strip_inline_bold(inside_match.group(2)).strip()
            output.append(f"{prefix}**{label}**" + (f" {rest}" if rest else ""))
            continue
        if outside_match:
            label = f"{outside_match.group(1)}{outside_match.group(2)}"
            rest = _agent_army_strip_inline_bold(outside_match.group(3)).strip()
            output.append(f"{prefix}**{label}**" + (f" {rest}" if rest else ""))
            continue
        output.append(f"{prefix}{_agent_army_strip_inline_bold(body)}")
    return "\n".join(output)


def _agent_army_breathe_long_lists(content: str) -> str:
    """Space long numbered procedures; keep ordinary bullet lists consistent."""
    lines = content.splitlines()
    output: List[str] = []
    index = 0
    numbered_item = re.compile(r"^\d+[.)、]\s+\S")
    bullet_item = re.compile(r"^[-*]\s+\S")
    any_item = re.compile(r"^\s*(?:[-*]|\d+[.)、])\s+\S")
    while index < len(lines):
        item_matcher = numbered_item if numbered_item.match(lines[index]) else bullet_item
        if not item_matcher.match(lines[index]):
            output.append(lines[index])
            index += 1
            continue

        items: List[List[str]] = []
        cursor = index
        while cursor < len(lines) and item_matcher.match(lines[cursor]):
            item = [lines[cursor]]
            cursor += 1
            while (
                cursor < len(lines)
                and lines[cursor].strip()
                and not item_matcher.match(lines[cursor])
                and (lines[cursor].startswith((" ", "\t")) or not any_item.match(lines[cursor]))
            ):
                item.append(lines[cursor])
                cursor += 1
            items.append(item)
        lengths = [len(re.sub(r"[*_~\`]", "", " ".join(item))) for item in items]
        spacious = item_matcher is numbered_item and len(items) >= 3 and (
            max(lengths, default=0) > 42
            or (sum(lengths) / max(len(lengths), 1)) > 30
        )
        if (
            spacious
            and output
            and output[-1] != ""
            and not _agent_army_is_section_heading(output[-1])
        ):
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
    """Canonicalize vertical rhythm regardless of whitespace produced by the model."""
    lines = content.splitlines()
    heading_count = sum(1 for line in lines if _agent_army_is_section_heading(line))
    if heading_count == 0 and len(content) < 280:
        return content
    output: List[str] = []
    for line in lines:
        if _agent_army_is_section_heading(line):
            while output and not output[-1].strip():
                output.pop()
            previous = output[-1].strip() if output else ""
            if previous and not _agent_army_is_section_heading(previous):
                output.append("")
            output.append(line.strip())
            continue
        if not line.strip():
            if output and _agent_army_is_section_heading(output[-1]):
                continue
            if output and output[-1] != "":
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
            _agent_army_normalize_emphasis(
                _agent_army_expand_inline_numbered_items(_agent_army_mobileize_tables(part))
            )
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

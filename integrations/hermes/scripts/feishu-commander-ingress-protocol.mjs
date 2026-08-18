import { replaceRequired } from './patch-support.mjs';

export function installFeishuCommanderIngress(source) {
  if (source.includes('AJUN_FEISHU_COMMANDER_INGRESS_URL')) return source;
  if (source.includes('def _route_ajun_agent_proposal_event(')) {
    return installCommanderRouteAlongsideLegacyProposal(source);
  }
  let result = insert(source, '_XIAOD_HTTP_URL_RE = re.compile(r"https?://[^\\s<>\\u3002\\uff0c\\uff01\\uff1f]+", re.IGNORECASE)\n', `${proposalPattern}\n`);
  result = insert(result, '            if await self._route_xiaod_retry_query(event):\n                return\n            await self.handle_message(event)\n', '            if await self._route_xiaod_retry_query(event):\n                return\n            if await self._route_ajun_commander_event(event):\n                return\n            if await self._route_ajun_agent_proposal_event(event):\n                return\n            await self.handle_message(event)\n');
  result = insert(result, '    async def _route_xiaod_status_query(self, event: MessageEvent) -> bool:\n', `${commanderRouter}\n\n${proposalRouter}\n\n    async def _route_xiaod_status_query(self, event: MessageEvent) -> bool:\n`);
  return insert(result, '        if await self._route_xiaod_retry_query(event):\n            return\n        if event.message_type == MessageType.TEXT', '        if await self._route_xiaod_retry_query(event):\n            return\n        if await self._route_ajun_commander_event(event):\n            return\n        if await self._route_ajun_agent_proposal_event(event):\n            return\n        if event.message_type == MessageType.TEXT');
}

export function upgradeFeishuCommanderIngressProtocol(source, { precedence = false } = {}) {
  let result = upgradeCommanderIngressTimeout(source);
  if (precedence) result = upgradeCommanderIngressPrecedence(result);
  result = upgradeCommanderProfileGuard(result);
  result = upgradeCommanderDirectReplyBypass(result);
  // 末位：锚点 C 必须是 AJUN_COMMANDER_INGRESS_TIMEOUT_V1 升级后的降级文案。
  return upgradeCommanderSilentFailureEvidence(result);
}

export const silentFailureEvidenceMarker = 'AGENT_ARMY_FEISHU_COMMANDER_SILENT_FAILURE_EVIDENCE_V1';
export const silentFailureEvidenceImport = 'from .agent_army_commander_evidence import record_commander_chain_evidence';

// 只校验本次升级**应当**注入的内容：没有总管路由的旧安装不会被误报失败关闭。
export function assertCommanderSilentFailureEvidenceInstalled(source) {
  if (!source.includes('AJUN_FEISHU_COMMANDER_INGRESS_URL')) return;
  if (!source.includes(silentFailureEvidenceImport) || !source.includes(silentFailureEvidenceMarker)) {
    throw new Error('Hermes 总管静默失败证据单元缺失或不完整；拒绝继续。');
  }
}

// 需求 2.4：4321 不可达时只有 Hermes 侧能留证据；降级文案发送失败时飞书会话内彻底无声。
// 本单元只改 `except` 异常分支与降级发送块，**绝不触碰 AGENT_ARMY_FEISHU_COMMANDER_DIRECT_REPLY_V1 分支**
// —— 这是需求 3.1（handled:false 原样交回 Hermes 普通聊天）的结构性保证。
export function upgradeCommanderSilentFailureEvidence(source) {
  // 已注入过也要确认单元完整（缺 import 的半成品必须失败关闭，不得静默放过）。
  if (source.includes(silentFailureEvidenceMarker)) {
    assertCommanderSilentFailureEvidenceInstalled(source);
    return source;
  }
  // 未安装总管路由的适配器与本单元无关，直接跳过。
  if (!source.includes('AJUN_FEISHU_COMMANDER_INGRESS_URL')) return source;
  const withImport = insertCommanderEvidenceImport(source);
  const upgraded = transformPythonMethod(withImport, '_route_ajun_commander_event', (body) => {
    const withExceptEvidence = replaceRequired(
      body,
      commanderExceptAnchor,
      commanderExceptWithEvidence,
      'Hermes 当前 Feishu 适配器结构不匹配，找不到总管路由异常锚点',
    );
    return replaceRequired(
      withExceptEvidence,
      commanderDegradedSendAnchor,
      commanderDegradedSendWithEvidence,
      'Hermes 当前 Feishu 适配器结构不匹配，找不到降级发送锚点',
    );
  });
  assertCommanderSilentFailureEvidenceInstalled(upgraded);
  return upgraded;
}

// 锚点 A：正式 Adapter Seam 的 task card 导入之后。安装流程里 Seam 由
// feishu-experience-patches 在本单元之后追加，因此该锚点尚不存在时退回追加到文件末尾
// （Python 在调用期解析全局名，模块级导入位置不影响路由运行）。
function insertCommanderEvidenceImport(source) {
  const seamImport = 'from .agent_army_task_card import install_agent_army_feishu_task_card_adapter';
  if (source.includes(seamImport)) {
    return source.replace(seamImport, `${seamImport}\n${commanderEvidenceImportBlock}`);
  }
  return `${source.trimEnd()}\n\n${commanderEvidenceImportBlock}`;
}

const commanderEvidenceImportBlock = `# ${silentFailureEvidenceMarker}: silent commander failures stay locally decidable.
try:
    from .agent_army_commander_evidence import record_commander_chain_evidence
except Exception:  # pragma: no cover - evidence must never break adapter import
    def record_commander_chain_evidence(**_kwargs) -> bool:
        return False


def _agent_army_note_commander_evidence(**kwargs) -> bool:
    """Record one commander-chain fact. Never raises: evidence is not a new failure mode."""
    try:
        home = kwargs.pop("hermes_home", None)
        if home is None:
            try:
                home = get_hermes_home()
            except Exception:
                home = None
        return record_commander_chain_evidence(hermes_home=home, **kwargs)
    except Exception:
        return False
`;

const commanderExceptAnchor = `        except (HTTPError, URLError, OSError, ValueError, json.JSONDecodeError) as exc:
            logger.warning("[Feishu] A君 commander ingress failed: %s", exc)
`;

const commanderExceptWithEvidence = `        except (HTTPError, URLError, OSError, ValueError, json.JSONDecodeError) as exc:
            logger.warning("[Feishu] A君 commander ingress failed: %s", exc)
            # Commander silent-failure evidence (unit marker declared at module import):
            # a warning-only log cannot be aligned to one Feishu message.
            _agent_army_note_commander_evidence(
                kind="ingress_http_error" if isinstance(exc, HTTPError) else "ingress_bad_response" if isinstance(exc, ValueError) else "ingress_unreachable",
                source_event_ref=f"feishu:{event.message_id or ''}",
                chat_ref=chat_id,
                requester_ref=sender,
                http_status=getattr(exc, "code", None),
                reason=type(exc).__name__,
                profile_agent_id=os.getenv("AGENT_ARMY_FEISHU_AGENT_ID", "").strip() or "ajun",
            )
`;

const commanderDegradedSendAnchor = `        if chat_id:
            await self.send(chat_id, "我这次没能及时理解完这句话，也没有启动任何动作。请直接再说一次你想要的结果。", reply_to=event.message_id)
        return True`;

const commanderDegradedSendWithEvidence = `        if chat_id:
            # Commander silent-failure evidence (unit marker declared at module import):
            # a degraded notice that never lands must still leave evidence.
            try:
                degraded_result = await self.send(chat_id, "我这次没能及时理解完这句话，也没有启动任何动作。请直接再说一次你想要的结果。", reply_to=event.message_id)
                degraded_kind = "degraded_notice_sent" if getattr(degraded_result, "success", True) else "degraded_notice_send_failed"
                degraded_reason = None if degraded_kind == "degraded_notice_sent" else str(getattr(degraded_result, "error", "") or "")[:200]
            except Exception as send_exc:
                degraded_kind = "degraded_notice_send_failed"
                degraded_reason = type(send_exc).__name__
            _agent_army_note_commander_evidence(
                kind=degraded_kind,
                source_event_ref=f"feishu:{event.message_id or ''}",
                chat_ref=chat_id,
                requester_ref=sender,
                reason=degraded_reason,
                profile_agent_id=os.getenv("AGENT_ARMY_FEISHU_AGENT_ID", "").strip() or "ajun",
            )
        return True`;

function transformPythonMethod(source, methodName, transform) {
  const marker = `    async def ${methodName}(`;
  const start = source.indexOf(marker);
  if (start < 0) return source;
  const next = source.slice(start + marker.length).search(/\n    (?:async )?def /);
  const end = next < 0 ? source.length : start + marker.length + next;
  const body = source.slice(start, end);
  return `${source.slice(0, start)}${transform(body)}${source.slice(end)}`;
}

function upgradeCommanderDirectReplyBypass(source) {
  if (source.includes('AGENT_ARMY_FEISHU_COMMANDER_DIRECT_REPLY_V1')) return source;
  return transformPythonMethod(source, '_route_ajun_commander_event', (body) => body.replace(
    '            reply = body.get("reply") if isinstance(body, dict) else None\n',
    `            # AGENT_ARMY_FEISHU_COMMANDER_DIRECT_REPLY_V1: explicit no-task messages stay in normal Hermes chat.
            if status in {200, 201, 202} and isinstance(body, dict) and body.get("handled") is False:
                setattr(event, "_ajun_commander_routed", False)
                return False
            reply = body.get("reply") if isinstance(body, dict) else None
`,
  ));
}

function upgradeCommanderProfileGuard(source) {
  if (source.includes('AGENT_ARMY_FEISHU_COMMANDER_PROFILE_GUARD_V1')) return source;
  return transformPythonMethod(source, '_route_ajun_commander_event', (body) => {
    let upgraded = body.replace(
      '        if not ingress_url or event.message_type != MessageType.TEXT:\n            return False\n',
      `        if not ingress_url or event.message_type != MessageType.TEXT:
            return False
        # AGENT_ARMY_FEISHU_COMMANDER_PROFILE_GUARD_V1: only AJun owns commander ingress.
        entry_agent_id = (os.getenv("AGENT_ARMY_FEISHU_AGENT_ID", "") or os.getenv("AJUN_FEISHU_ENTRY_AGENT_ID", "") or "ajun").strip()
        if entry_agent_id != "ajun":
            return False
`,
    );
    upgraded = upgraded.replace(
      '            "targetAgentId": os.getenv("AJUN_FEISHU_ENTRY_AGENT_ID", "").strip(),\n',
      '            "targetAgentId": entry_agent_id,\n',
    );
    return upgraded;
  });
}

function upgradeCommanderIngressPrecedence(source) {
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

function upgradeCommanderIngressTimeout(source) {
  if (!source.includes('AJUN_FEISHU_COMMANDER_INGRESS_URL')) return source;
  // Upgrade every commander route because Python uses the last definition when
  // a previous Hermes patch accidentally left a duplicate in the adapter.
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
        '            # AJUN_COMMANDER_INGRESS_TIMEOUT_V1: natural-language understanding can take longer than a simple status check.\n            with urlopen(request, timeout=25) as response:\n',
      )
      .replace(
        '            await self.send(chat_id, "军团总管暂时无法登记这条命令；未启动任何外部动作，请稍后重试。", reply_to=event.message_id)\n',
        '            await self.send(chat_id, "我这次没能及时理解完这句话，也没有启动任何动作。请直接再说一次你想要的结果。", reply_to=event.message_id)\n',
      );
    return `${routeMarker}${upgraded}${rest}`;
  }).join('');
}

function installCommanderRouteAlongsideLegacyProposal(source) {
  let result = insert(source, '            if await self._route_xiaod_retry_query(event):\n                return\n            if await self._route_ajun_agent_proposal_event(event):\n', '            if await self._route_xiaod_retry_query(event):\n                return\n            if await self._route_ajun_commander_event(event):\n                return\n            if await self._route_ajun_agent_proposal_event(event):\n');
  result = insert(result, '        if await self._route_xiaod_retry_query(event):\n            return\n        if await self._route_ajun_agent_proposal_event(event):\n', '        if await self._route_xiaod_retry_query(event):\n            return\n        if await self._route_ajun_commander_event(event):\n            return\n        if await self._route_ajun_agent_proposal_event(event):\n');
  return insert(result, '    async def _route_ajun_agent_proposal_event(self, event: MessageEvent) -> bool:\n', `${commanderRouter}\n\n    async def _route_ajun_agent_proposal_event(self, event: MessageEvent) -> bool:\n`);
}

function insert(source, marker, replacement) {
  return replaceRequired(
    source,
    marker,
    replacement,
    `Hermes 当前 Feishu 适配器结构不匹配，找不到补丁锚点：${marker.slice(0, 72)}`,
  );
}

const proposalPattern = `_AJUN_AGENT_PROPOSAL_RE = re.compile(\n    r"(?:创建|新建|招募|招)\\s*(?:一个\\s*)?(?:agent|智能体|岗位)",\n    re.IGNORECASE,\n)`;

const commanderRouter = `    async def _route_ajun_commander_event(self, event: MessageEvent) -> bool:
        """Relay the one Feishu commander entry to the local A君 runtime."""
        ingress_url = os.getenv("AJUN_FEISHU_COMMANDER_INGRESS_URL", "").strip()
        if not ingress_url or event.message_type != MessageType.TEXT:
            return False
        # AGENT_ARMY_FEISHU_COMMANDER_PROFILE_GUARD_V1: only AJun owns commander ingress.
        entry_agent_id = (os.getenv("AGENT_ARMY_FEISHU_AGENT_ID", "") or os.getenv("AJUN_FEISHU_ENTRY_AGENT_ID", "") or "ajun").strip()
        if entry_agent_id != "ajun":
            # A stale commander URL in an employee profile must never capture
            # ordinary employee conversation.
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
            "targetAgentId": entry_agent_id,
            "profileId": (os.getenv("AGENT_ARMY_PROFILE_ID", "") or os.getenv("AGENT_ARMY_FEISHU_PROFILE_ID", "") or "").strip(),
            "taskCardPolicy": (os.getenv("AGENT_ARMY_TASK_CARD_POLICY", "") or os.getenv("AGENT_ARMY_FEISHU_TASK_CARD_POLICY", "") or "").strip(),
        }, ensure_ascii=False).encode("utf-8")

        def _post_to_ajun() -> tuple[int, dict]:
            request = Request(ingress_url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
            with urlopen(request, timeout=8) as response:
                return int(response.status), json.loads(response.read().decode("utf-8"))

        try:
            status, body = await self._run_blocking(_post_to_ajun)
            # AGENT_ARMY_FEISHU_COMMANDER_DIRECT_REPLY_V1: explicit no-task messages stay in normal Hermes chat.
            if status in {200, 201, 202} and isinstance(body, dict) and body.get("handled") is False:
                # Explicit no-task/direct-reply messages belong to the normal
                # Hermes conversation path with its own Profile and memory.
                setattr(event, "_ajun_commander_routed", False)
                return False
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

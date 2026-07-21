#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const defaultAdapter = path.join(process.env.HERMES_HOME || path.join(process.env.HOME || '', '.hermes', 'hermes-agent'), 'plugins/platforms/feishu/adapter.py');

export function applyPatch(source) {
  if (source.includes('AJUN_APPROVAL_CARD_V1')) return source;
  if (source.includes('AJUN_FEISHU_COMMANDER_INGRESS_URL')) return upgradeCommanderApprovalPatch(source);
  if (source.includes('def _route_ajun_agent_proposal_event(')) return upgradeLegacyProposalPatch(source);
  let result = insert(source, '_XIAOD_HTTP_URL_RE = re.compile(r"https?://[^\\s<>\\u3002\\uff0c\\uff01\\uff1f]+", re.IGNORECASE)\n', `${proposalPattern}\n`);
  result = insert(result, '            if await self._route_xiaod_retry_query(event):\n                return\n            await self.handle_message(event)\n', '            if await self._route_xiaod_retry_query(event):\n                return\n            if await self._route_ajun_commander_event(event):\n                return\n            if await self._route_ajun_agent_proposal_event(event):\n                return\n            await self.handle_message(event)\n');
  result = insert(result, '    async def _route_xiaod_status_query(self, event: MessageEvent) -> bool:\n', `${commanderRouter}\n\n${proposalRouter}\n\n    async def _route_xiaod_status_query(self, event: MessageEvent) -> bool:\n`);
  result = insert(result, '        if await self._route_xiaod_retry_query(event):\n            return\n        if event.message_type == MessageType.TEXT', '        if await self._route_xiaod_retry_query(event):\n            return\n        if await self._route_ajun_commander_event(event):\n            return\n        if await self._route_ajun_agent_proposal_event(event):\n            return\n        if event.message_type == MessageType.TEXT');
  return result;
}

function upgradeCommanderApprovalPatch(source) {
  let result = insert(source, '            reply = body.get("reply") if isinstance(body, dict) else None\n            if status in {200, 201, 202} and isinstance(reply, str) and reply:\n                if chat_id:\n                    await self.send(chat_id, reply, reply_to=event.message_id)\n                return True\n', '            reply = body.get("reply") if isinstance(body, dict) else None\n            approval = body.get("approval") if isinstance(body, dict) else None\n            if status in {200, 201, 202} and isinstance(reply, str) and reply:\n                if chat_id and isinstance(approval, dict) and approval.get("governanceMode") == "local":\n                    card_result = await self._send_ajun_approval_card(chat_id, approval, reply_to=event.message_id)\n                    if not card_result.success:\n                        await self.send(chat_id, reply, reply_to=event.message_id)\n                elif chat_id:\n                    await self.send(chat_id, reply, reply_to=event.message_id)\n                return True\n');
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
const approvalCardMethods = `    async def _send_ajun_approval_card(self, chat_id: str, approval: Dict[str, Any], *, reply_to: Optional[str] = None) -> SendResult:
        """AJUN_APPROVAL_CARD_V1: send a one-off A君 local approval card."""
        approval_id = str(approval.get("approvalId", "") or "")
        if not approval_id:
            return SendResult(success=False, error="missing A君 approval id")
        scope = approval.get("requestedScope") if isinstance(approval.get("requestedScope"), dict) else {}
        scope_text = str(scope.get("title") or scope.get("taskType") or "本次任务")[:500]
        reason = str(approval.get("reason") or "需要确认本次范围。")[:500]
        valid_until = str(approval.get("validUntil") or "")[:80]
        def _button(label: str, action: str, style: str) -> dict:
            return {"tag": "button", "text": {"tag": "plain_text", "content": label}, "type": style, "value": {"ajun_approval_action": action, "approval_id": approval_id}}
        card = {"config": {"wide_screen_mode": True}, "header": {"title": {"tag": "plain_text", "content": "A君 · 本次审批"}, "template": "orange"}, "elements": [
            {"tag": "markdown", "content": f"**事项**：{scope_text}\\n**原因**：{reason}\\n**有效期**：{valid_until or '本次任务'}\\n\\n只会批准卡片所列范围，不会永久扩权。"},
            {"tag": "action", "actions": [_button("批准本次范围", "approve", "primary"), _button("拒绝并关闭", "reject", "danger")]}
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
        operator = getattr(event, "operator", None)
        open_id = str(getattr(operator, "open_id", "") or "")
        chat_id = str(getattr(getattr(event, "context", None), "open_chat_id", "") or "")
        if not approval_id or action not in {"approve", "reject"} or not self._is_interactive_operator_authorized(open_id):
            return P2CardActionTriggerResponse() if P2CardActionTriggerResponse else None
        self._submit_on_loop(loop, self._resolve_ajun_approval(approval_id, action, open_id, chat_id))
        if P2CardActionTriggerResponse is None:
            return None
        response = P2CardActionTriggerResponse()
        if CallBackCard is not None:
            card = CallBackCard(); card.type = "raw"
            card.data = {"config": {"wide_screen_mode": True}, "header": {"title": {"tag": "plain_text", "content": "A君 · 审批处理中"}, "template": "blue"}, "elements": [{"tag": "markdown", "content": "已收到你的决定，正在校验范围并更新任务。"}]}
            response.card = card
        return response`;
const approvalCardResolver = `    async def _resolve_ajun_approval(self, approval_id: str, action: str, open_id: str, chat_id: str) -> None:
        ingress_url = os.getenv("AJUN_FEISHU_COMMANDER_INGRESS_URL", "").strip()
        if not ingress_url.startswith("http://127.0.0.1:"):
            logger.error("[Feishu] Refusing non-local A君 approval ingress URL")
            return
        base = ingress_url.split("/api/feishu/commander", 1)[0]
        endpoint = f"{base}/api/feishu/approvals/{approval_id}/{action}"
        payload = json.dumps({"requesterRef": open_id, "chatRef": chat_id}, ensure_ascii=False).encode("utf-8")
        def _post_to_ajun() -> tuple[int, dict]:
            request = Request(endpoint, data=payload, headers={"Content-Type": "application/json"}, method="POST")
            with urlopen(request, timeout=8) as response:
                return int(response.status), json.loads(response.read().decode("utf-8"))
        try:
            status, body = await self._run_blocking(_post_to_ajun)
            task = body.get("task") if isinstance(body, dict) else None
            if status in {200, 201, 202} and isinstance(task, dict):
                label = "已批准并恢复任务" if action == "approve" else "已拒绝并关闭任务"
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
  if (patched === original) return console.log(`Hermes 飞书军团总管路由已存在：${filePath}`);
  await fs.writeFile(filePath, patched);
  console.log(`已安装 Hermes 飞书军团总管路由：${filePath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

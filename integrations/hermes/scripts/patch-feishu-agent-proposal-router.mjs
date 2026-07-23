#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const defaultAdapter = path.join(process.env.HERMES_HOME || path.join(process.env.HOME || '', '.hermes', 'hermes-agent'), 'plugins/platforms/feishu/adapter.py');

export function applyPatch(source) {
  let result = source;
  if (result.includes('AJUN_COMMANDER_TASK_NOTIFY_V4')) return upgradeCommanderIngressTimeoutPatch(upgradeProposalTrialReadinessPatch(upgradeTaskControlCardPatch(result)));
  if (result.includes('AJUN_COMMANDER_TASK_NOTIFY_V3')) return upgradeCommanderIngressTimeoutPatch(upgradeProposalTrialReadinessPatch(upgradeTaskControlCardPatch(upgradeCommanderProgressNotificationPatch(result))));
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
  return upgradeCommanderIngressTimeoutPatch(upgradeProposalTrialReadinessPatch(upgradeTaskControlCardPatch(upgradeCommanderProgressNotificationPatch(upgradeCommanderCompletionPersistencePatch(upgradeCommanderCompletionPatch(result))))));
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
  if (patched === original) return console.log(`Hermes 飞书军团总管路由已存在：${filePath}`);
  await fs.writeFile(filePath, patched);
  console.log(`已安装 Hermes 飞书军团总管路由：${filePath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

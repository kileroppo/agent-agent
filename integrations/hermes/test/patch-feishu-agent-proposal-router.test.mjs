import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPatch } from '../scripts/patch-feishu-agent-proposal-router.mjs';

const fixture = `_XIAOD_HTTP_URL_RE = re.compile(r"https?://[^\\s<>\\u3002\\uff0c\\uff01\\uff1f]+", re.IGNORECASE)
    def __init__(self):
        self._xiaod_latest_job_by_chat: Dict[str, tuple[str, str]] = {}
    async def connect(self):
            self._mark_connected()
            logger.info("[Feishu] Connected in %s mode (%s)", self._connection_mode, self._domain_name)
    async def _handle_message_with_guards(self, event: MessageEvent) -> None:
            if await self._route_xiaod_retry_query(event):
                return
            await self.handle_message(event)
    async def _route_xiaod_status_query(self, event: MessageEvent) -> bool:
        pass
    async def _dispatch_inbound_event(self, event: MessageEvent) -> None:
        if await self._route_xiaod_retry_query(event):
            return
        if event.message_type == MessageType.TEXT:
            pass
    def _on_card_action_trigger(self, data: Any) -> Any:
        if hermes_action:
            return self._handle_approval_card_action(event=event, action_value=action_value, loop=loop)
    def _handle_approval_card_action(self, *, event: Any, action_value: Dict[str, Any], loop: Any) -> Any:
        pass
    async def _resolve_approval(
        self,
    ) -> None:
        pass
`;

test('Hermes 飞书补丁把单一军团总管文本路由到本机 A君入口，且可重复执行', () => {
  const commanderPatched = applyPatch(fixture); const patched = applyPatch(commanderPatched);
  assert.match(patched, /_AJUN_AGENT_PROPOSAL_RE/);
  assert.match(patched, /def _route_ajun_commander_event/);
  assert.match(patched, /AJUN_FEISHU_COMMANDER_INGRESS_URL/);
  assert.match(patched, /AJUN_FEISHU_ENTRY_AGENT_ID/);
  assert.match(patched, /reply_to=event.message_id/);
  assert.match(patched, /def _route_ajun_agent_proposal_event/);
  assert.match(patched, /sourceEventRef/);
  assert.match(patched, /AJUN_COMMANDER_TASK_NOTIFY_V2/);
  assert.match(patched, /AJUN_COMMANDER_TASK_NOTIFY_V3/);
  assert.match(patched, /AJUN_COMMANDER_TASK_NOTIFY_V4/);
  assert.match(patched, /AJUN_COMMANDER_INGRESS_TIMEOUT_V1/);
  assert.match(patched, /timeout=25/);
  assert.doesNotMatch(patched, /军团总管暂时无法登记这条命令/);
  assert.match(patched, /AJUN_PROPOSAL_TRIAL_READINESS_V1/);
  assert.match(patched, /同意保留草案/);
  assert.match(patched, /completionWatch/);
  assert.match(patched, /_schedule_ajun_task_completion_notification/);
  assert.match(patched, /_restore_ajun_task_completion_notifications/);
  assert.match(patched, /ajun_completion_watches\.json/);
  assert.match(patched, /last_status/);
  assert.match(patched, /api\/feishu\/task-status/);
  assert.equal(applyPatch(patched), patched);
});

test('已安装的旧版小D通知可升级为完整任务跟进', () => {
  const current = applyPatch(fixture);
  const legacy = current.replace(/        # AJUN_COMMANDER_TASK_NOTIFY_V3:[\s\S]*?        self\._ajun_completion_watches_path = get_hermes_home\(\) \/ "ajun_completion_watches\.json"\n/, '').replace('            self._restore_ajun_task_completion_notifications()\n', '').replace(/    def _load_ajun_task_completion_notifications\([\s\S]*?    def _schedule_ajun_task_completion_notification/, '    def _schedule_ajun_task_completion_notification').replace('        self._remember_ajun_task_completion_notification(chat_id=chat_id, task_id=task_id, base_url=base_url)\n', '').replace('                        self._forget_ajun_task_completion_notification(task_id)\n', '').replace(/            completion_watch = body\.get\("completionWatch"\)[\s\S]*?                    self\._schedule_ajun_task_completion_notification\(chat_id=chat_id, task_id=watch_task_id, base_url=watch_base_url\)\n/, `            completion_watch = body.get("completionWatch") if isinstance(body, dict) else None
            # AJUN_COMMANDER_XIAOD_NOTIFY_V1: reuse the existing Xiaod terminal notifier.
            if status in {200, 201, 202} and chat_id and isinstance(completion_watch, dict):
                watch_kind = str(completion_watch.get("kind", "") or "")
                watch_job_id = str(completion_watch.get("jobId", "") or "")
                watch_base_url = str(completion_watch.get("baseUrl", "") or "").strip()
                if watch_kind == "xiaod_job" and watch_job_id and watch_base_url.startswith("http://127.0.0.1:"):
                    self._xiaod_latest_job_by_chat[chat_id] = (watch_job_id, watch_base_url)
                    self._schedule_xiaod_job_completion_notification(chat_id=chat_id, task_id=watch_job_id, ingress_url=watch_base_url)
`).replace(/    def _schedule_ajun_task_completion_notification\([\s\S]*?        logger\.warning\("\[Feishu\] A君 task did not reach a final state within 30 minutes"\)\n\n/, '');
  const upgraded = applyPatch(legacy);
  assert.match(upgraded, /AJUN_COMMANDER_TASK_NOTIFY_V2/);
  assert.match(upgraded, /_schedule_ajun_task_completion_notification/);
  assert.match(upgraded, /completionWatch/);
});

test('总管补丁可升级为 local 与 Paperclip 组织级审批卡', () => {
  const upgraded = applyPatch(applyPatch(fixture));
  assert.match(upgraded, /_send_ajun_approval_card/);
  assert.match(upgraded, /AJUN_APPROVAL_CARD_V2/);
  assert.match(upgraded, /ajun_approval_action/);
  assert.match(upgraded, /governance_mode/);
  assert.match(upgraded, /governance-approvals/);
  assert.match(upgraded, /_resolve_ajun_approval/);
  assert.match(upgraded, /AJUN_TASK_CONTROL_CARD_V1/);
  assert.match(upgraded, /同意暂停/);
  assert.match(upgraded, /保持继续处理/);
  assert.equal(applyPatch(upgraded), upgraded);
});

test('已安装的旧创建官补丁可原地升级为军团总管路由', () => {
  const legacy = `
    async def _handle_message_with_guards(self, event: MessageEvent) -> None:
            if await self._route_xiaod_retry_query(event):
                return
            if await self._route_ajun_agent_proposal_event(event):
                return
    async def _route_ajun_agent_proposal_event(self, event: MessageEvent) -> bool:
        pass
    async def _dispatch_inbound_event(self, event: MessageEvent) -> None:
        if await self._route_xiaod_retry_query(event):
            return
        if await self._route_ajun_agent_proposal_event(event):
            return
    def _on_card_action_trigger(self, data: Any) -> Any:
        if hermes_action:
            return self._handle_approval_card_action(event=event, action_value=action_value, loop=loop)
    def _handle_approval_card_action(self, *, event: Any, action_value: Dict[str, Any], loop: Any) -> Any:
        pass
    async def _resolve_approval(
        self,
    ) -> None:
        pass
`;
  const upgraded = applyPatch(applyPatch(legacy));
  assert.match(upgraded, /def _route_ajun_commander_event/);
  assert.match(upgraded, /AJUN_FEISHU_COMMANDER_INGRESS_URL/);
  assert.equal(applyPatch(upgraded), upgraded);
});

test('旧补丁留下重复总管入口时，实际生效的后一个入口也会升级等待时间', () => {
  const duplicateOldRoute = `
    async def _route_ajun_commander_event(self, event: MessageEvent) -> bool:
        ingress_url = os.getenv("AJUN_FEISHU_COMMANDER_INGRESS_URL", "").strip()
        def _post_to_ajun() -> tuple[int, dict]:
            request = Request(ingress_url, data=b"{}", method="POST")
            with urlopen(request, timeout=8) as response:
                return int(response.status), {}
        if chat_id:
            await self.send(chat_id, "军团总管暂时无法登记这条命令；未启动任何外部动作，请稍后重试。", reply_to=event.message_id)
        return True
`;
  const upgraded = applyPatch(`${applyPatch(fixture)}${duplicateOldRoute}`);
  assert.doesNotMatch(upgraded, /_route_ajun_commander_event[\s\S]{0,1200}timeout=8/);
  assert.match(upgraded, /我这次没能及时理解完这句话/);
  assert.equal(applyPatch(upgraded), upgraded);
});

test('已安装 V4 补丁时，文本链接先进入 A君任务链，避免直连小D与总管重复通知', () => {
  const v4 = `${applyPatch(fixture)}\n    async def _dispatch_inbound_event(self, event: MessageEvent) -> None:\n        if await self._route_xiaod_url_event(event):\n            return\n        if await self._route_xiaod_status_query(event):\n            return\n        if await self._route_xiaod_retry_query(event):\n            return\n        if await self._route_ajun_commander_event(event):\n            return\n`;
  const upgraded = applyPatch(v4);
  assert.match(upgraded, /AJUN_COMMANDER_INGRESS_PRECEDENCE_V1/);
  assert.match(upgraded, /AJUN_COMMANDER_INGRESS_PRECEDENCE_V1:[\s\S]*?_route_ajun_commander_event[\s\S]*?_route_xiaod_url_event/);
  assert.equal(applyPatch(upgraded), upgraded);
});

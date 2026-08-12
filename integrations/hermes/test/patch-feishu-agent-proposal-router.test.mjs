import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  applyPatch,
  upgradeFeishuReactionReliabilityPatch,
  upgradeFeishuSenderIdentityPatch,
} from '../scripts/patch-feishu-agent-proposal-router.mjs';

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
    async def send_exec_approval(
        self,
    ) -> SendResult:
        pass
    def _on_card_action_trigger(self, data: Any) -> Any:
        if hermes_action:
            return self._handle_approval_card_action(event=event, action_value=action_value, loop=loop)
    async def _handle_card_action_event(self, data: Any) -> None:
        event = getattr(data, "event", None)
        token = str(getattr(event, "token", "") or "")
        context = getattr(event, "context", None)
        action_tag = "button"
        action_value = {}
        synthetic_text = f"/card {action_tag}"
        if action_value:
            try:
                synthetic_text += f" {json.dumps(action_value, ensure_ascii=False)}"
            except Exception:
                pass
        synthetic_event = MessageEvent(
            text=synthetic_text,
            message_id=token or str(uuid.uuid4()),
        )
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
  assert.match(patched, /AGENT_ARMY_FEISHU_SLASH_CONFIRM_V1/);
  assert.match(patched, /async def send_slash_confirm/);
  assert.match(patched, /开始新会话/);
  assert.match(patched, /以后不再询问/);
  assert.match(patched, /hermes_slash_confirm_action/);
  assert.match(patched, /_resolve_slash_confirm_card/);
  assert.match(patched, /AGENT_ARMY_FEISHU_BUSY_QUICK_ACTIONS_V2/);
  assert.match(patched, /send_busy_quick_actions/);
  assert.match(patched, /agent_army_busy_action/);
  assert.match(patched, /_handle_agent_army_busy_card_action/);
  assert.match(patched, /open_message_id/);
  assert.match(patched, /if action_value and not busy_action/);
  assert.match(patched, /已选择：/);
  assert.ok(patched.includes('synthetic_text = "/stop"'));
  assert.equal(applyPatch(patched), patched);
});

test('旧版运行中按钮补丁会升级，且命令参数不再被按钮 JSON 污染', () => {
  const current = applyPatch(fixture);
  const callbackStart = current.indexOf('    def _handle_agent_army_busy_card_action(');
  const approvalStart = current.indexOf('    def _handle_approval_card_action', callbackStart);
  const withoutCallback = `${current.slice(0, callbackStart)}${current.slice(approvalStart)}`;
  const legacy = withoutCallback
    .replaceAll('AGENT_ARMY_FEISHU_BUSY_QUICK_ACTIONS_V2', 'AGENT_ARMY_FEISHU_BUSY_QUICK_ACTIONS_V1')
    .replace(/        busy_action = action_value\.get\("agent_army_busy_action"\)[\s\S]*?        ajun_approval_action =/, '        ajun_approval_action =')
    .replace('        if action_value and not busy_action:\n', '        if action_value:\n')
    .replace('            message_id=str(getattr(context, "open_message_id", "") or "") or None,\n', '            message_id=token or str(uuid.uuid4()),\n');
  const upgraded = applyPatch(legacy);
  assert.match(upgraded, /AGENT_ARMY_FEISHU_BUSY_QUICK_ACTIONS_V2/);
  assert.match(upgraded, /_handle_agent_army_busy_card_action/);
  assert.match(upgraded, /if action_value and not busy_action/);
  assert.match(upgraded, /message_id=str\(getattr\(context, "open_message_id"/);
  assert.equal(applyPatch(upgraded), upgraded);
});

test('飞书输出按移动端宽度调整长表格、正文密度并保持短表格', () => {
  const adapterFixture = `${fixture}
_MARKDOWN_HINT_RE = re.compile(
    r"table"
)
    async def send(
        self,
    ) -> SendResult:
        formatted = self.format_message(content)
    async def edit_message(
        self,
    ) -> SendResult:
        content = self.format_message(content)
        try:
            msg_type, payload = self._build_outbound_payload(content)
`;
  const patched = applyPatch(adapterFixture);
  assert.match(patched, /AGENT_ARMY_FEISHU_MOBILE_FORMAT_V4/);
  assert.match(patched, /def _agent_army_format_feishu_message/);
  assert.match(patched, /_agent_army_should_stack_table/);
  assert.match(patched, /_agent_army_expand_inline_numbered_items/);
  assert.match(patched, /_agent_army_breathe_long_lists/);
  assert.match(patched, /_agent_army_breathe_sections/);
  assert.match(patched, /len\(compact\) <= 220/);
  assert.match(patched, /content = _agent_army_format_feishu_message\(content\)/);
  assert.equal(applyPatch(patched), patched);
});

test('飞书会拆开模型压成一行的长编号列表，并保持短编号列表紧凑', () => {
  const adapterFixture = `${fixture}
_MARKDOWN_HINT_RE = re.compile(
    r"table"
)
    async def send(
        self,
    ) -> SendResult:
        formatted = self.format_message(content)
    async def edit_message(
        self,
    ) -> SendResult:
        content = self.format_message(content)
        try:
            msg_type, payload = self._build_outbound_payload(content)
`;
  const patched = applyPatch(adapterFixture);
  const helperStart = patched.indexOf('# AGENT_ARMY_FEISHU_MOBILE_FORMAT_V4:');
  const helperEnd = patched.indexOf('\n_MARKDOWN_HINT_RE = re.compile(', helperStart);
  const helpers = patched.slice(helperStart, helperEnd);
  const dense = '已按任务重新核对。1) **文本模型 Provider：** 已调用 DeepSeek，input 3,043/output 8,809 tokens。2) **受控视觉 Provider：** 未调用，visualMode=off。3) **费用：** 估算 0.0028986328 USD，账本未显示支付记录。4) **外部写入证据：** 无独立外写回执，不能据此断言次数为零。单独说明：本机完成同步不是外部平台发布。';
  const python = [
    'import re',
    'from typing import List',
    helpers,
    `dense = ${JSON.stringify(dense)}`,
    'print(_agent_army_format_feishu_message(dense))',
    'print("---SHORT---")',
    'print(_agent_army_format_feishu_message("1) 是 2) 否"))',
  ].join('\n');
  const result = spawnSync('python3', ['-c', python], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const [longOutput, shortOutput] = result.stdout.trim().split('\n---SHORT---\n');
  assert.match(longOutput, /已按任务重新核对。\n\n1\. \*\*文本模型 Provider：\*\*/);
  assert.match(longOutput, /tokens。\n\n2\. \*\*受控视觉 Provider：\*\*/);
  assert.match(longOutput, /支付记录。\n\n4\. \*\*外部写入证据：\*\*/);
  assert.match(longOutput, /次数为零。\n\n\*\*单独说明\*\*\n\n本机完成同步/);
  assert.equal(shortOutput, '1. 是\n2. 否');
});

test('飞书收到消息后只显示一个即时处理状态，并在快速分流完成时清除', () => {
  const adapterFixture = `${fixture}
    async def on_processing_start(self, event: MessageEvent) -> None:
        pass
    async def _enqueue_text_event(self, event: MessageEvent) -> None:
        key = self._text_batch_key(event)
        chunk_len = len(event.text or "")
        existing = self._pending_text_batches.get(key)
        if existing is None:
            return
        existing_count = 1
        next_count = existing_count + 1
        next_text = event.text or ""
        existing.text = next_text
        existing._last_chunk_len = chunk_len  # type: ignore[attr-defined]
        existing.timestamp = event.timestamp
        if event.message_id:
            existing.message_id = event.message_id
`;
  const patched = applyPatch(adapterFixture);
  assert.match(patched, /AGENT_ARMY_FEISHU_IMMEDIATE_STATUS_V1/);
  assert.match(patched, /await self\.on_processing_start\(event\)/);
  assert.match(patched, /await self\.on_processing_complete\(event, ProcessingOutcome\.SUCCESS\)/);
  assert.match(patched, /remove it from the earlier chunk and retain the already-created badge/);
  assert.equal(applyPatch(patched), patched);
});

test('飞书处理图标保留兼容请求体，失败时留下脱敏可见诊断', () => {
  const reactionFixture = `
    async def _add_reaction(self, message_id: str, emoji_type: str) -> Optional[str]:
        try:
            from lark_oapi.api.im.v1 import (
                CreateMessageReactionRequest,
                CreateMessageReactionRequestBody,
            )
            body = (
                CreateMessageReactionRequestBody.builder()
                .reaction_type({"emoji_type": emoji_type})
                .build()
            )
            response = await self._run_blocking(self._client.im.v1.message_reaction.create, request)
            if response and getattr(response, "success", lambda: False)():
                return "reaction-id"
            logger.debug(
                "[Feishu] Add reaction %s on %s rejected: code=%s msg=%s",
                emoji_type,
                message_id,
                getattr(response, "code", None),
                getattr(response, "msg", None),
            )
        except Exception:
            return None

    async def _remove_reaction(self, message_id: str, reaction_id: str) -> bool:
        response = await self._run_blocking(self._client.im.v1.message_reaction.delete, request)
        if response and getattr(response, "success", lambda: False)():
            return True
        logger.debug(
            "[Feishu] Remove reaction %s on %s rejected: code=%s msg=%s",
            reaction_id,
            message_id,
            getattr(response, "code", None),
            getattr(response, "msg", None),
        )
        return False
`;

  const patched = upgradeFeishuReactionReliabilityPatch(reactionFixture);
  assert.match(patched, /AGENT_ARMY_FEISHU_REACTION_RELIABILITY_V5/);
  assert.equal((patched.match(/AGENT_ARMY_FEISHU_REACTION_RELIABILITY_V5/g) || []).length, 1);
  assert.match(patched, /\.reaction_type\(\{"emoji_type": emoji_type\}\)/);
  assert.doesNotMatch(patched, /Emoji\.builder/);
  assert.match(patched, /logger\.warning\(/);
  assert.match(patched, /code=%s reason=%s/);
  assert.match(patched, /99991663, 99991672/);
  assert.match(patched, /Remove reaction rejected: code=%s reason=%s/);
  assert.doesNotMatch(patched, /on %s rejected/);
  assert.doesNotMatch(patched, /getattr\(response, "msg", None\)/);
  assert.equal(upgradeFeishuReactionReliabilityPatch(patched), patched);

  const previousV2 = patched
    .replaceAll('AGENT_ARMY_FEISHU_REACTION_RELIABILITY_V5', 'AGENT_ARMY_FEISHU_REACTION_RELIABILITY_V2')
    .replaceAll('99991663, 99991672', '99991663');
  const upgradedV2 = upgradeFeishuReactionReliabilityPatch(previousV2);
  assert.match(upgradedV2, /AGENT_ARMY_FEISHU_REACTION_RELIABILITY_V5/);
  assert.equal((upgradedV2.match(/AGENT_ARMY_FEISHU_REACTION_RELIABILITY_V5/g) || []).length, 1);
  assert.match(upgradedV2, /99991663, 99991672/);
  assert.doesNotMatch(upgradedV2, /AGENT_ARMY_FEISHU_REACTION_RELIABILITY_V2/);
});

test('飞书新增消息权限后仍用 open_id 做授权与会话主身份', () => {
  const senderFixture = `
        open_id = getattr(sender_id, "open_id", None) or None
        user_id = getattr(sender_id, "user_id", None) or None
        union_id = getattr(sender_id, "union_id", None) or None
        # Prefer tenant-scoped user_id; fall back to app-scoped open_id.
        primary_id = user_id or open_id
        # bot/v3/bots/basic_batch only accepts open_id.
        name_lookup_id = open_id if is_bot else (primary_id or union_id)
`;
  const patched = upgradeFeishuSenderIdentityPatch(senderFixture);
  assert.match(patched, /AGENT_ARMY_FEISHU_OPEN_ID_AUTH_V1/);
  assert.match(patched, /primary_id = open_id or user_id/);
  assert.doesNotMatch(patched, /primary_id = user_id or open_id/);
  assert.equal(upgradeFeishuSenderIdentityPatch(patched), patched);
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

test('A君动态任务卡默认关闭，开启后只维护一个消息锚点和一个有界 supervisor', () => {
  const patched = applyPatch(fixture);
  assert.match(patched, /AGENT_ARMY_FEISHU_DYNAMIC_TASK_CARD_V1/);
  assert.match(patched, /AJUN_FEISHU_DYNAMIC_TASK_CARD/);
  assert.match(patched, /\.strip\(\)\.lower\(\) != "true"/);
  assert.match(patched, /self\._ajun_task_card_supervisor_task/);
  assert.match(patched, /asyncio\.Semaphore\(3\)/);
  assert.match(patched, /poll_interval_seconds\(age_seconds=age\)/);
  assert.match(patched, /if self\._ajun_dynamic_task_cards_enabled\(\):\n\s+self\._start_ajun_task_card_supervisor\(\)\n\s+else:\n\s+self\._restore_ajun_task_completion_notifications\(\)/);
  const supervisorStart = patched.indexOf('    async def _supervise_ajun_task_cards(');
  const supervisorEnd = patched.indexOf('\n    async def _send_ajun_approval_card(', supervisorStart);
  const supervisor = patched.slice(supervisorStart, supervisorEnd);
  assert.doesNotMatch(supervisor, /range\(900\)|did not reach a final state/);
  assert.match(patched, /and not dynamic_task_card_enabled/);
  assert.match(patched, /delivery_state": "sending"/);
  assert.match(patched, /delivery_state": "anchor_uncertain"/);
  assert.match(patched, /duplicate fallback suppressed/);
  assert.match(patched, /delivery_state": "not_started"/);
  assert.match(patched, /except FileNotFoundError/);
  assert.match(patched, /ledger is unreadable; refusing duplicate delivery/);
  assert.match(patched, /ledger unreadable; fallback suppressed/);
  assert.match(patched, /ledger write failed; delivery stopped/);
  assert.match(patched, /intent was not persisted; send skipped/);
  assert.match(patched, /provider call completed but ledger update failed/);
  assert.match(patched, /provider call completed but ledger became unreadable/);
  assert.match(patched, /ingress_url\.split\("\/api\/feishu\/commander", 1\)\[0\]/);
  assert.match(patched, /PatchMessageRequest/);
  assert.match(patched, /self\._client\.im\.v1\.message\.patch/);
  const syntaxSource = patched.replace('    def __init__(self):', 'class Adapter:\n    def __init__(self):');
  const syntax = spawnSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: syntaxSource, encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.equal(applyPatch(patched), patched);
});

test('动态任务卡按钮使用原消息锚点，权威决定成功后才返回决定态卡', () => {
  const patched = applyPatch(fixture);
  const start = patched.indexOf('    def _handle_ajun_task_card_action(');
  const end = patched.indexOf('\n    def _handle_ajun_approval_card_action(', start);
  const callback = patched.slice(start, end);
  assert.match(callback, /agent_army_task_card_action/);
  assert.match(callback, /\{"approve", "reject", "pause", "resume", "refresh"\}/);
  assert.match(callback, /getattr\(context, "open_message_id"/);
  assert.doesNotMatch(callback, /event\.token|getattr\(event, "token"/);
  assert.match(callback, /api\/feishu\/task-card-actions/);
  assert.match(callback, /api\/feishu\/task-status/);
  assert.match(callback, /sourceRevision/);
  assert.match(callback, /contentHash/);
  assert.match(callback, /CallBackToast/);
  assert.match(callback, /toast\.type = "error"/);
  assert.ok(callback.indexOf('with urlopen(request') < callback.indexOf('decided_card = render_task_card(projection)'));
  assert.ok(callback.indexOf('decided_card = render_task_card(projection)') < callback.indexOf('response.card = card'));
  assert.doesNotMatch(callback, /last_source_revision": projection\.get/);
  assert.match(callback, /record\["next_poll_at"\] = 0/);
  assert.match(callback, /self\._wake_ajun_task_card_supervisor\(\)/);
  assert.doesNotMatch(callback, /last_source_revision"\) == source_revision/);
  assert.match(callback, /无法确认这张卡片的来源，本次操作未生效/);
  assert.match(callback, /卡片记录暂时不可读取，本次操作未生效/);
  assert.match(callback, /操作未生效，请重试/);
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

test('飞书原生操作授权卡使用中文业务文案且不显示操作者内部标识', () => {
  const nativeApproval = `# AJUN_COMMANDER_INGRESS_PRECEDENCE_V1
_APPROVAL_LABEL_MAP: Dict[str, str] = {
    "once": "Approved once",
    "session": "Approved for session",
    "always": "Approved permanently",
    "deny": "Denied",
}
            actions = [_btn("✅ Allow Once", "approve_once", "primary")]
                actions.append(_btn("✅ Session", "approve_session"))
                    actions.append(_btn("✅ Always", "approve_always"))
            actions.append(_btn("❌ Deny", "deny", "danger"))
            scope_note = "\\n\\n**Smart DENY:** owner override applies to this one operation only." if smart_denied else ""
                    "title": {"content": "⚠️ Command Approval Required", "tag": "plain_text"},
                        "content": f"\\\`\\\`\\\`\\n{cmd_preview}\\n\\\`\\\`\\\`\\n**Reason:** {description}{scope_note}",
    @staticmethod
    def _build_resolved_approval_card(*, choice: str, user_name: str) -> Dict[str, Any]:
        """Build raw card JSON for a resolved approval action."""
        icon = "❌" if choice == "deny" else "✅"
        label = _APPROVAL_LABEL_MAP.get(choice, "Resolved")
        return {
            "config": {"wide_screen_mode": True},
            "header": {
                "title": {"content": f"{icon} {label}", "tag": "plain_text"},
                "template": "red" if choice == "deny" else "green",
            },
            "elements": [
                {
                    "tag": "markdown",
                    "content": f"{icon} **{label}** by {user_name}",
                },
            ],
        }
`;
  const upgraded = applyPatch(nativeApproval);
  assert.match(upgraded, /AGENT_ARMY_FEISHU_BUSINESS_UI_V1/);
  assert.match(upgraded, /已授权本次操作/);
  assert.match(upgraded, /仅允许本次/);
  assert.match(upgraded, /需要你确认一次操作/);
  assert.doesNotMatch(upgraded, /Approved once|Allow Once|Command Approval Required|by \{user_name\}/);
  assert.equal(applyPatch(upgraded), upgraded);
});

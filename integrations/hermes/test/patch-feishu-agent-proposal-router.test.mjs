import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPatch } from '../scripts/patch-feishu-agent-proposal-router.mjs';

const fixture = `_XIAOD_HTTP_URL_RE = re.compile(r"https?://[^\\s<>\\u3002\\uff0c\\uff01\\uff1f]+", re.IGNORECASE)
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
  assert.match(patched, /reply_to=event.message_id/);
  assert.match(patched, /def _route_ajun_agent_proposal_event/);
  assert.match(patched, /sourceEventRef/);
  assert.equal(applyPatch(patched), patched);
});

test('总管补丁可升级为 A君 local 审批卡与按钮回调', () => {
  const upgraded = applyPatch(applyPatch(fixture));
  assert.match(upgraded, /_send_ajun_approval_card/);
  assert.match(upgraded, /ajun_approval_action/);
  assert.match(upgraded, /_resolve_ajun_approval/);
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

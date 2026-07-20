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
`;

test('Hermes 飞书补丁把创建 Agent 文本路由到本机 A君入口，且可重复执行', () => {
  const patched = applyPatch(fixture);
  assert.match(patched, /_AJUN_AGENT_PROPOSAL_RE/);
  assert.match(patched, /def _route_ajun_agent_proposal_event/);
  assert.match(patched, /sourceEventRef/);
  assert.equal(applyPatch(patched), patched);
});

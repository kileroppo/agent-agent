import assert from 'node:assert/strict';
import test from 'node:test';
import { ContentAcquisitionCenter } from '../content-acquisition-center.js';
import { WeChatLocalVaultAdapter } from '../wechat-local-vault-adapter.js';

const approvalRef = 'approval_wechat_12345678';
const taskId = 'task-wechat-1';
const agentId = 'wechat-chat-retriever';
const scope = {
  approvalRef,
  status:'approved',
  requestingAgentId:agentId,
  taskId,
  chatSelector:'synthetic-single-chat',
  startTime:'2026-07-01T00:00:00.000Z',
  endTime:'2026-07-01T00:10:00.000Z',
  maxMessages:2,
  expiresAt:'2026-07-02T00:00:00.000Z'
};

function centerFor({ resolvedScope = scope, messages = null, healthStatus = 'healthy' } = {}) {
  const events = [];
  const adapter = new WeChatLocalVaultAdapter({
    scopeResolver:async () => resolvedScope,
    runVaultQuery:async () => ({
      messages:messages || [
        { timestamp:Date.parse('2026-07-01T00:01:00.000Z') / 1000, sender:'甲', type:'文本', content:'合成消息一' },
        { timestamp:Date.parse('2026-07-01T00:02:00.000Z') / 1000, sender:'乙', type:'文本', content:'合成消息二' }
      ]
    }),
    healthStatus,
    now:() => new Date('2026-07-01T12:00:00.000Z')
  });
  return {
    events,
    center:new ContentAcquisitionCenter({
      adapters:[adapter],
      connectionBroker:null,
      operations:{ async record(event) { events.push(event); } }
    })
  };
}

test('微信 Vault 健康检查未通过时不会进入私密读取适配器', async () => {
  const { center } = centerFor({ healthStatus:'degraded' });
  const result = await center.fetch({
    taskId,
    source:`wechat-vault://local/chat?approval=${approvalRef}`,
    requestedCapabilities:['wechat.local-vault.chat.read'],
    requestingAgentId:agentId,
    runtimeRequirement:'wechat_chat_read'
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'capability_not_available');
});

test('微信 Vault 适配器只读取当前 Agent 和任务获批的单会话时间片', async () => {
  const { center } = centerFor();
  const result = await center.fetch({
    requestId:'request-wechat-1',
    taskId,
    source:`wechat-vault://local/chat?approval=${approvalRef}`,
    requestedCapabilities:['wechat.local-vault.chat.read'],
    requestingAgentId:agentId,
    runtimeRequirement:'wechat_chat_read'
  });

  assert.equal(result.ok, true);
  assert.equal(result.contentPackage.sourceRef, 'wechat-vault://local/chat');
  assert.equal(result.contentPackage.contentItems.chat_slice.messageCount, 2);
  assert.equal(result.contentPackage.validation.perRequestApproval, true);
  assert.equal(result.contentPackage.validation.rawDatabaseExposed, false);
  assert.equal(JSON.stringify(result).includes('synthetic-single-chat'), false);
});

test('微信 Vault 适配器拒绝跨任务复用审批', async () => {
  const { center, events } = centerFor();
  const result = await center.fetch({
    taskId:'another-task',
    source:`wechat-vault://local/chat?approval=${approvalRef}`,
    requestedCapabilities:['wechat.local-vault.chat.read'],
    requestingAgentId:agentId,
    runtimeRequirement:'wechat_chat_read'
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'scope_not_granted');
  assert.equal(result.category, 'needs_input');
  assert.equal(events[0].safeMessage.includes('synthetic-single-chat'), false);
});

test('微信 Vault 适配器拒绝审批时间范围之外的返回消息', async () => {
  const { center } = centerFor({
    messages:[{ timestamp:Date.parse('2026-07-02T00:00:00.000Z') / 1000, sender:'甲', type:'文本', content:'越界消息' }]
  });
  const result = await center.fetch({
    taskId,
    source:`wechat-vault://local/chat?approval=${approvalRef}`,
    requestedCapabilities:['wechat.local-vault.chat.read'],
    requestingAgentId:agentId,
    runtimeRequirement:'wechat_chat_read'
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'scope_violation');
});

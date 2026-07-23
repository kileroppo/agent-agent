import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentFeishuChannelFleet, agentChannelOptions, feishuChannelStartupPlan } from '../src/agent-feishu-channel-fleet.js';

test('每个独立飞书智能体用自己的应用凭据和岗位身份连接，不共享 A君 身份', async () => {
  const created = [];
  const fleet = new AgentFeishuChannelFleet({
    store:{ async listApps() { return [{ agentId:'operator', appId:'cli-operator', allowedUserIds:['owner-open-id'], allowedGroupIds:[] }]; }, async getSecret() { return 'secret'; } },
    bridge:{}, createChannel:async () => ({}),
    runnerFactory:(input) => ({ async start() { created.push(input); return { status:'connected', message:'已连接。' }; }, async stop() {} })
  });
  const result = await fleet.start();
  assert.equal(created.length, 1);
  assert.equal(created[0].targetAgentId, 'operator');
  assert.equal(created[0].channelOptions.appId, 'cli-operator');
  assert.equal(created[0].channelOptions.transport, 'websocket');
  assert.deepEqual(result.operator, { status:'connected', message:'已连接。', agentId:'operator' });
});

test('飞书智能体只接收本应用允许人员的私聊，并在群聊要求 @', () => {
  const options = agentChannelOptions({ agentId:'architect', appId:'cli-architect', allowedUserIds:['owner-open-id'], allowedGroupIds:['chat-safe'] }, 'secret');
  assert.equal(options.policy.dmMode, 'allowlist');
  assert.deepEqual(options.policy.dmAllowlist, ['owner-open-id']);
  assert.equal(options.policy.requireMention, true);
  assert.equal(options.source, 'agent-army-architect');
});

test('A君已有独立智能体应用时，优先它而不是旧机器人入口', () => {
  assert.deepEqual(
    feishuChannelStartupPlan({ apps:[{ agentId:'ajun', enabled:true }], legacyAJunEnabled:true }),
    { startLegacyAJun:false, skipAgentIds:[] }
  );
  assert.deepEqual(
    feishuChannelStartupPlan({ apps:[], legacyAJunEnabled:true }),
    { startLegacyAJun:true, skipAgentIds:['ajun'] }
  );
});

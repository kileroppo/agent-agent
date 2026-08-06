import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentFeishuChannelFleet, agentChannelOptions, employeeFeishuChannelsEnabled, feishuChannelStartupPlan } from '../src/agent-feishu-channel-fleet.js';

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
    { startLegacyAJun:false, skipAgentIds:[], ajunOwner:'dedicated-app' }
  );
  assert.deepEqual(
    feishuChannelStartupPlan({ apps:[], legacyAJunEnabled:true }),
    { startLegacyAJun:true, skipAgentIds:['ajun'], ajunOwner:'legacy-channel' }
  );
});

test('Hermes 原生接管 A君时只跳过 A君应用，其他员工入口继续连接', () => {
  assert.deepEqual(
    feishuChannelStartupPlan({
      apps:[{ agentId:'ajun', enabled:true }, { agentId:'operator', enabled:true }],
      legacyAJunEnabled:true,
      hermesNativeAJunEnabled:true
    }),
    { startLegacyAJun:false, skipAgentIds:['ajun'], ajunOwner:'hermes-native' }
  );
});

test('员工更新本机应用资料时先关闭旧连接，再只启动一个新连接', async () => {
  let starts = 0;
  let stops = 0;
  const fleet = new AgentFeishuChannelFleet({
    store:{ async getSecret() { return 'secret'; } },
    bridge:{}, createChannel:async () => ({}),
    runnerFactory:() => ({
      async start() { starts += 1; return { status:'connected', message:'已连接。' }; },
      async stop() { stops += 1; }
    })
  });
  const app = { agentId:'office-assistant', appId:'cli-office', allowedUserIds:['owner-open-id'], allowedGroupIds:[] };
  await fleet.startApp(app);
  await fleet.startApp(app);
  assert.equal(starts, 2);
  assert.equal(stops, 1);
  assert.equal(fleet.snapshot()['office-assistant'].status, 'connected');
});

test('员工飞书入口只由指定运行环境接管，另一侧保持待命且不建立连接', async () => {
  let starts = 0;
  const fleet = new AgentFeishuChannelFleet({
    enabled:employeeFeishuChannelsEnabled({ deploymentMode:'cloud', owner:'local' }),
    store:{
      async listApps() {
        return [{ agentId:'intel-researcher', appId:'cli-researcher', allowedUserIds:['owner-open-id'], allowedGroupIds:[] }];
      },
      async getSecret() {
        throw new Error('待命环境不应读取员工应用密钥');
      }
    },
    runnerFactory:() => ({
      async start() { starts += 1; return { status:'connected', message:'已连接。' }; },
      async stop() {}
    })
  });

  const result = await fleet.start();

  assert.equal(starts, 0);
  assert.equal(result['intel-researcher'].status, 'standby');
  assert.equal(employeeFeishuChannelsEnabled({ deploymentMode:'local', owner:'local' }), true);
  assert.equal(employeeFeishuChannelsEnabled({ deploymentMode:'cloud', owner:'cloud' }), true);
  assert.equal(employeeFeishuChannelsEnabled({ deploymentMode:'cloud', owner:'invalid' }), false);
});

test('独立 Hermes Profile Gateway 接管的员工不会再启动官方 SDK 长连接', async () => {
  let starts = 0;
  const fleet = new AgentFeishuChannelFleet({
    externalAgentIds:['intel-researcher'],
    store:{
      async listApps() {
        return [{ agentId:'intel-researcher', appId:'cli-researcher', allowedUserIds:['owner-open-id'], allowedGroupIds:[] }];
      },
      async getSecret() {
        throw new Error('Hermes 接管后官方 SDK 不应读取密钥');
      }
    },
    runnerFactory:() => ({
      async start() { starts += 1; return { status:'connected', message:'已连接。' }; },
      async stop() {}
    })
  });

  const result = await fleet.start();

  assert.equal(starts, 0);
  assert.equal(result['intel-researcher'].status, 'external');
});

test('启动计划只跳过由 Hermes 接管的员工，其他员工官方入口继续运行', () => {
  assert.deepEqual(
    feishuChannelStartupPlan({
      apps:[{ agentId:'operator', enabled:true }, { agentId:'intel-researcher', enabled:true }],
      hermesNativeEmployeeIds:['intel-researcher']
    }),
    { startLegacyAJun:false, skipAgentIds:['intel-researcher'], ajunOwner:'none' }
  );
});

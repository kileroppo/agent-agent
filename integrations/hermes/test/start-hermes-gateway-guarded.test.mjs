import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertHermesGatewayStartAllowed,
  parseGuardedGatewayArgs,
  startGuardedHermesGateway
} from '../scripts/start-hermes-gateway-guarded.mjs';

test('Gateway 只在技能白名单 clean 且已关闭自动技能注入时启动', async () => {
  let started = 0;
  const result = await startGuardedHermesGateway({
    agentId:'xiaod',
    reconcile:async () => [{
      agentId:'xiaod',
      status:'clean',
      profileHome:'/profiles/xiaod',
      bundledSkillSeedingOptOut:true
    }],
    runGateway:async (policy) => {
      started += 1;
      assert.equal(policy.profileHome, '/profiles/xiaod');
      return { code:0 };
    }
  });
  assert.equal(started, 1);
  assert.deepEqual(result, { code:0 });
});

test('存在未声明 enabled 技能、声明缺失或未关闭自动注入时，Gateway fail-closed', async () => {
  let started = 0;
  for (const result of [
    { status:'drift', bundledSkillSeedingOptOut:true },
    { status:'clean', bundledSkillSeedingOptOut:false },
    { status:'inspection-error', bundledSkillSeedingOptOut:false }
  ]) {
    await assert.rejects(
      () => startGuardedHermesGateway({
        agentId:'xiaod',
        reconcile:async () => [{ agentId:'xiaod', profileHome:'/profiles/xiaod', ...result }],
        runGateway:async () => { started += 1; }
      }),
      /拒绝启动 Gateway/
    );
  }
  assert.equal(started, 0);
});

test('启动参数必须显式绑定一个岗位，不能透传任意 Hermes 子命令', () => {
  assert.deepEqual(parseGuardedGatewayArgs(['--agent', 'xiaod']), { agentId:'xiaod' });
  assert.throws(() => parseGuardedGatewayArgs([]), /需要合法/);
  assert.throws(() => parseGuardedGatewayArgs(['--agent', 'xiaod', 'gateway']), /未知参数/);
});

test('门禁只信任指定 agent 的单一检查结果', async () => {
  await assert.rejects(
    () => assertHermesGatewayStartAllowed({
      agentId:'xiaod',
      reconcile:async () => [{
        agentId:'operator', status:'clean', bundledSkillSeedingOptOut:true, profileHome:'/profiles/operator'
      }]
    }),
    /拒绝启动 Gateway/
  );
});

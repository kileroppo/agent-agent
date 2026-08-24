import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { StepFunModelPolicyError, StepFunModelPolicyService } from '../src/stepfun-model-policy-service.ts';

function manifest(agentId, reasoningEffort = 'medium') {
  return {
    agentId,
    name:agentId,
    role:`${agentId} role`,
    status:'active',
    interaction:{ runtime:'hermes-profile' },
    executionOwner:'paperclip-hermes',
    autonomyBudgetPolicy:{ reasoningEffort },
    runtimeCapabilities:{ modelSelection:{ provider:'stepfun', model:'step-3.7-flash' } },
  };
}

class FakeConfigClient {
  values = new Map();
  writes = [];
  failAt = 0;
  async get(home, key) { return this.values.get(`${home}:${key}`) || ''; }
  async set(home, key, value) {
    this.writes.push({ home, key, value });
    if (this.failAt && this.writes.length === this.failAt) throw new Error('simulated write failure');
    this.values.set(`${home}:${key}`, value);
  }
  async unset(home, key) { this.values.delete(`${home}:${key}`); }
}

test('首次打开时生成最新旗舰默认与岗位强度建议，不写入凭据', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stepfun-policy-'));
  t.after(() => fs.rm(directory, { recursive:true, force:true }));
  const service = await StepFunModelPolicyService.open({
    dataDir:directory,
    profileRoot:path.join(directory, 'profiles'),
    configClient:new FakeConfigClient(),
  });
  const snapshot = service.snapshot([manifest('architect', 'medium'), manifest('operator', 'none')]);
  assert.equal(snapshot.policy.default.model, 'step-3.7-flash');
  assert.equal(snapshot.employees.find((item) => item.agentId === 'architect').reasoningEffort, 'high');
  assert.equal(snapshot.employees.find((item) => item.agentId === 'operator').reasoningEffort, 'low');
  assert.ok(snapshot.catalog.capabilities.some((item) => item.id === 'step-image-edit-2'));
  assert.deepEqual(snapshot.policy.capabilities.asr, { provider:'stepfun', model:'stepaudio-2.5-asr' });
  assert.deepEqual(snapshot.policy.capabilities.vision, { provider:'stepfun', model:'step-3.7-flash' });
  assert.equal(JSON.stringify(snapshot).includes('api_key'), false);
});

test('显式刷新只接收 Hermes 返回的模型 ID，并标记官方分类可用性', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stepfun-policy-'));
  t.after(() => fs.rm(directory, { recursive:true, force:true }));
  const service = await StepFunModelPolicyService.open({
    dataDir:directory,
    profileRoot:path.join(directory, 'profiles'),
    configClient:new FakeConfigClient(),
    catalogClient:{
      async list(home) {
        assert.equal(home, path.join(directory, 'profiles', 'ajun'));
        return ['step-3.7-flash', 'stepaudio-2.5-asr', 'step-future-reasoning'];
      },
    },
    clock:() => new Date('2026-08-14T13:00:00.000Z'),
  });
  const snapshot = await service.refreshCatalog([manifest('architect')]);
  assert.equal(snapshot.catalog.reasoning.find((item) => item.id === 'step-3.7-flash').available, true);
  assert.equal(snapshot.catalog.reasoning.find((item) => item.id === 'step-3.5-flash').available, false);
  assert.equal(snapshot.catalog.capabilities.find((item) => item.id === 'stepaudio-2.5-asr').available, true);
  assert.deepEqual(snapshot.catalog.account.unknown, ['step-future-reasoning']);
  assert.equal(snapshot.catalog.account.refreshedAt, '2026-08-14T13:00:00.000Z');
});

test('一次保存会更新默认 Profile、全部员工 Profile，并让 Paperclip Manifest 使用同一模型', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stepfun-policy-'));
  t.after(() => fs.rm(directory, { recursive:true, force:true }));
  const configClient = new FakeConfigClient();
  const service = await StepFunModelPolicyService.open({
    dataDir:directory,
    profileRoot:path.join(directory, 'profiles'),
    configClient,
    clock:() => new Date('2026-08-14T12:00:00.000Z'),
  });
  const manifests = [manifest('architect'), manifest('operator', 'none')];
  const result = await service.update({
    default:{ model:'step-3.7-flash', reasoningEffort:'high' },
    overrides:{ operator:{ model:'step-3.5-flash-2603', reasoningEffort:'low' } },
  }, manifests);
  assert.equal(result.policy.updatedAt, '2026-08-14T12:00:00.000Z');
  assert.equal(configClient.values.get(`${directory}:model.default`), 'step-3.7-flash');
  assert.equal(configClient.values.get(`${directory}/profiles/operator:model.default`), 'step-3.5-flash-2603');
  assert.equal(configClient.values.get(`${directory}/profiles/architect:agent.reasoning_effort`), 'high');
  assert.equal(configClient.values.get(`${directory}:agent.max_turns`), '4');
  assert.equal(configClient.values.get(`${directory}/profiles/operator:agent.max_turns`), '6');
  assert.equal(configClient.values.get(`${directory}/profiles/operator:session_reset.idle_minutes`), '60');
  assert.equal(service.applyToManifest(manifests[1]).runtimeCapabilities.modelSelection.model, 'step-3.5-flash-2603');
  assert.deepEqual(service.capabilitySelection('asr'), { provider:'stepfun', model:'stepaudio-2.5-asr' });
  const stored = JSON.parse(await fs.readFile(path.join(directory, 'stepfun-model-policy.json'), 'utf8'));
  assert.equal(stored.overrides.operator.model, 'step-3.5-flash-2603');
  assert.equal(stored.version, 3);
  assert.deepEqual(stored.runtime, { defaultMaxTurns:4, roleMaxTurns:6, idleMinutes:60 });
});

test('任一 Profile 写入失败时回滚此前修改且不落策略文件', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stepfun-policy-'));
  t.after(() => fs.rm(directory, { recursive:true, force:true }));
  const configClient = new FakeConfigClient();
  configClient.values.set(`${directory}:model.default`, 'old-model');
  configClient.failAt = 4;
  const service = await StepFunModelPolicyService.open({
    dataDir:directory,
    profileRoot:path.join(directory, 'profiles'),
    configClient,
  });
  await assert.rejects(() => service.update({
    default:{ model:'step-3.7-flash', reasoningEffort:'medium' },
    overrides:{},
  }, [manifest('architect')]), /已回滚/);
  assert.equal(configClient.values.get(`${directory}:model.default`), 'old-model');
  await assert.rejects(() => fs.access(path.join(directory, 'stepfun-model-policy.json')));
});

test('拒绝把语音/图片模型当主模型、拒绝未知员工和不受支持的推理强度', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stepfun-policy-'));
  t.after(() => fs.rm(directory, { recursive:true, force:true }));
  const service = await StepFunModelPolicyService.open({
    dataDir:directory,
    profileRoot:path.join(directory, 'profiles'),
    configClient:new FakeConfigClient(),
  });
  await assert.rejects(() => service.update({
    default:{ model:'stepaudio-2.5-tts', reasoningEffort:'medium' }, overrides:{},
  }, [manifest('architect')]), StepFunModelPolicyError);
  await assert.rejects(() => service.update({
    default:{ model:'step-3.5-flash-2603', reasoningEffort:'high' }, overrides:{},
  }, [manifest('architect')]), /不支持推理强度/);
  await assert.rejects(() => service.update({
    default:{ model:'step-3.7-flash', reasoningEffort:'medium' },
    overrides:{ outsider:{ model:'step-3.7-flash', reasoningEffort:'high' } },
  }, [manifest('architect')]), /未知员工/);
  await assert.rejects(() => service.update({
    default:{ model:'step-3.7-flash', reasoningEffort:'medium' },
    overrides:{},
    capabilities:{ asr:{ provider:'stepfun', model:'step-asr' } },
  }, [manifest('architect')]), /语音识别不支持/);
});

test('旧版策略读取时自动补齐能力模型，不改写凭据', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stepfun-policy-'));
  t.after(() => fs.rm(directory, { recursive:true, force:true }));
  await fs.writeFile(path.join(directory, 'stepfun-model-policy.json'), JSON.stringify({
    version:1,
    provider:'stepfun',
    default:{ model:'step-3.7-flash', reasoningEffort:'medium' },
    overrides:{},
    updatedAt:'2026-08-14T12:00:00.000Z',
  }));
  const service = await StepFunModelPolicyService.open({
    dataDir:directory,
    profileRoot:path.join(directory, 'profiles'),
    configClient:new FakeConfigClient(),
  });
  assert.equal(service.snapshot([]).policy.version, 3);
  assert.deepEqual(service.capabilitySelection('asr'), { provider:'stepfun', model:'stepaudio-2.5-asr' });
  assert.deepEqual(service.snapshot([]).policy.runtime, { defaultMaxTurns:4, roleMaxTurns:6, idleMinutes:60 });
});

test('拒绝超出范围的会话轮次和空闲时间', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stepfun-policy-'));
  t.after(() => fs.rm(directory, { recursive:true, force:true }));
  const service = await StepFunModelPolicyService.open({ dataDir:directory, profileRoot:path.join(directory, 'profiles'), configClient:new FakeConfigClient() });
  await assert.rejects(() => service.update({ default:{ model:'step-3.7-flash', reasoningEffort:'medium' }, overrides:{}, runtime:{ defaultMaxTurns:21, roleMaxTurns:6, idleMinutes:60 } }, [manifest('architect')]), /普通对话最大轮次/);
});

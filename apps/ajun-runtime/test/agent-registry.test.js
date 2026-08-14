import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentRegistry } from '../src/agent-registry.ts';

async function fixture({ manifest, profile }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-registry-'));
  const agentsDir = path.join(root, 'agents');
  await fs.mkdir(path.join(agentsDir, manifest.agentId), { recursive:true });
  await fs.mkdir(path.join(root, 'integrations/hermes/profiles'), { recursive:true });
  await fs.writeFile(path.join(agentsDir, manifest.agentId, 'manifest.json'), JSON.stringify(manifest));
  if (profile) await fs.writeFile(path.join(root, manifest.runtimeProfileRef), JSON.stringify(profile));
  return { root, agentsDir };
}

test('岗位名单如实说明独立员工还缺模型或飞书入口，不把岗位状态冒充成独立可用', async (t) => {
  const manifest = { agentId:'operator', name:'运维官', acceptedTaskTypes:['operations.health-review'], status:'active', runtimeProfileRef:'integrations/hermes/profiles/operator.profile.json' };
  const { root, agentsDir } = await fixture({ manifest, profile:{ localProfile:{ created:true, modelConfigured:false }, gateway:{ enabled:false } } });
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const [agent] = await new AgentRegistry({ agentsDir }).list();
  assert.equal(agent.status, 'active');
  assert.deepEqual(agent.independentRuntime, { state:'model_pending' });
});

test('已经真实验证独立接线的员工显示为独立可用', async (t) => {
  const manifest = { agentId:'xiaod', name:'小D', acceptedTaskTypes:['media.transcribe-and-refine'], status:'active', runtimeProfileRef:'integrations/hermes/profiles/xiaod.profile.json' };
  const { root, agentsDir } = await fixture({ manifest, profile:{ localProfile:{ created:true, credentialedTransportVerified:true, gatewayStarted:true }, gateway:{ platform:'feishu' } } });
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const [agent] = await new AgentRegistry({ agentsDir }).list();
  assert.deepEqual(agent.independentRuntime, { state:'ready' });
});

test('只选过模型但没有凭据调用证据时显示模型授权待完成，不提前说只差飞书', async (t) => {
  const manifest = { agentId:'intel-researcher', name:'小R', acceptedTaskTypes:['research.intel-report'], status:'active', runtimeProfileRef:'integrations/hermes/profiles/intel-researcher.profile.json' };
  const { root, agentsDir } = await fixture({ manifest, profile:{ localProfile:{ created:true, modelConfigured:true, credentialedTransportVerified:false }, gateway:{ enabled:false } } });
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const [agent] = await new AgentRegistry({ agentsDir }).list();
  assert.deepEqual(agent.independentRuntime, { state:'model_transport_pending' });
});

test('模型调用已验证但独立飞书入口未启用时才显示飞书待接通', async (t) => {
  const manifest = { agentId:'office-assistant', name:'办公执行助理', acceptedTaskTypes:['office.briefing-package'], status:'active', runtimeProfileRef:'integrations/hermes/profiles/office-assistant.profile.json' };
  const { root, agentsDir } = await fixture({ manifest, profile:{ localProfile:{ created:true, modelConfigured:true, credentialedTransportVerified:true }, gateway:{ enabled:false } } });
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const [agent] = await new AgentRegistry({ agentsDir }).list();
  assert.deepEqual(agent.independentRuntime, { state:'channel_pending' });
});

test('A君有自己的岗位资料，但不会被误显示成可被派活的普通员工', async (t) => {
  const manifest = { agentId:'ajun', name:'A君', kind:'manager', acceptedTaskTypes:[], status:'active', runtimeProfileRef:'integrations/hermes/profiles/ajun.profile.json' };
  const { root, agentsDir } = await fixture({ manifest, profile:{ localProfile:{ created:true, modelConfigured:false }, gateway:{ enabled:false } } });
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  assert.deepEqual(await new AgentRegistry({ agentsDir }).list(), []);
});

test('岗位清单复用短时快照，显式失效后重新读取磁盘', async (t) => {
  const manifest = { agentId:'operator', name:'运维官', acceptedTaskTypes:['operations.health-review'], status:'active' };
  const { root, agentsDir } = await fixture({ manifest });
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const registry = new AgentRegistry({ agentsDir });

  assert.equal((await registry.list())[0].name, '运维官');
  await fs.writeFile(path.join(agentsDir, manifest.agentId, 'manifest.json'), JSON.stringify({ ...manifest, name:'新运维官' }));
  assert.equal((await registry.list())[0].name, '运维官');

  registry.invalidate();
  assert.equal((await registry.list())[0].name, '新运维官');
});

test('删除快照缓存 Adapter 后岗位注册表仍可独立工作', async (t) => {
  const manifest = { agentId:'operator', name:'运维官', acceptedTaskTypes:['operations.health-review'], status:'active' };
  const { root, agentsDir } = await fixture({ manifest });
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const registry = new AgentRegistry({ agentsDir, snapshotCache:null });

  assert.equal((await registry.list())[0].name, '运维官');
  await fs.writeFile(path.join(agentsDir, manifest.agentId, 'manifest.json'), JSON.stringify({ ...manifest, name:'即时更新' }));
  assert.equal((await registry.list())[0].name, '即时更新');
});

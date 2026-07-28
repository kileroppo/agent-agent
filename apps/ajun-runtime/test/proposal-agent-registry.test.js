import assert from 'node:assert/strict';
import test from 'node:test';
import { ProposalAgentRegistry } from '../src/proposal-agent-registry.js';

test('正式 Manifest 是唯一派活名单，历史激活提案不能生成幽灵员工', async () => {
  const formal = [
    { agentId:'operator', name:'运维官', acceptedTaskTypes:['operations.health-review'], status:'active' },
    { agentId:'intel-researcher', name:'小R', acceptedTaskTypes:['report.public-material', 'research.github-search', 'research.intel-report'], status:'active' }
  ];
  const registry = new ProposalAgentRegistry({
    baseRegistry: {
      async list() { return formal; },
      async get(agentId) { return formal.find((item) => item.agentId === agentId) || null; }
    },
    store: { async listProposals() { return [
      { proposalId:'approved-1', status:'active', requestedCapabilities:['content.public.fetch'], candidateManifest:{ agentId:'public-reporter', name:'公开报告员', acceptedTaskTypes:['report.public-material'] } },
      { proposalId:'github-approved', status:'active', requestedCapabilities:['github.public.search', 'github.public.read'], candidateManifest:{ agentId:'github-scout', name:'小G', acceptedTaskTypes:['research.github-search'] } },
      { proposalId:'intel-approved', status:'active', requestedCapabilities:['content.public.fetch', 'github.public.search', 'github.public.read'], candidateManifest:{ agentId:'intel-researcher', name:'小R', acceptedTaskTypes:['research.intel-report'] } },
      { proposalId:'testing-1', status:'testing', requestedCapabilities:['content.public.fetch'], candidateManifest:{ agentId:'not-live', name:'试用员工', acceptedTaskTypes:['report.public-material'] } },
      { proposalId:'unsafe-1', status:'active', requestedCapabilities:[], candidateManifest:{ agentId:'no-fetch', name:'没有读取能力的员工', acceptedTaskTypes:['report.public-material'] } }
    ]; } }
  });
  const agents = await registry.list();
  assert.deepEqual(agents.map((agent) => agent.agentId).sort(), ['intel-researcher', 'operator']);
  assert.equal(await registry.get('public-reporter'), null);
});

test('仓库中已上岗岗位是当前真相，不被历史激活草案覆盖独立运行状态', async () => {
  const registry = new ProposalAgentRegistry({
    baseRegistry: { async list() { return [{
      agentId:'intel-researcher',
      name:'小R',
      role:'当前岗位定义',
      acceptedTaskTypes:['research.intel-report'],
      status:'active',
      independentRuntime:{ state:'channel_pending' }
    }]; }, async get() { return (await this.list())[0]; } },
    store: { async listProposals() { return [{
      proposalId:'historical-intel',
      status:'active',
      requestedCapabilities:['content.public.fetch', 'github.public.search', 'github.public.read'],
      candidateManifest:{
        agentId:'intel-researcher',
        name:'小R',
        role:'历史草案定义',
        acceptedTaskTypes:['research.intel-report']
      }
    }]; } }
  });

  const agent = await registry.get('intel-researcher');
  assert.equal(agent.role, '当前岗位定义');
  assert.deepEqual(agent.independentRuntime, { state:'channel_pending' });
  assert.equal(agent.source, undefined);
});

test('总任务候选查询保留 A君 manager，普通岗位列表仍不混入经理', async () => {
  const calls = [];
  const agents = [
    { agentId:'ajun', kind:'manager', status:'active', acceptedTaskTypes:['army.cross-agent-mission'] },
    { agentId:'operator', kind:'employee', status:'active', acceptedTaskTypes:['operations.health-review'] }
  ];
  const registry = new ProposalAgentRegistry({
    baseRegistry:{
      async list(options = {}) {
        calls.push(options);
        return options.includeManagers === true ? agents : agents.filter((agent) => agent.kind !== 'manager');
      },
      async get(agentId) { return agents.find((agent) => agent.agentId === agentId) || null; }
    }
  });

  assert.deepEqual((await registry.list()).map((agent) => agent.agentId), ['operator']);
  assert.deepEqual((await registry.candidates('army.cross-agent-mission')).map((agent) => agent.agentId), ['ajun']);
  assert.equal(calls.at(-1).includeManagers, true);
});

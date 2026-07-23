import assert from 'node:assert/strict';
import test from 'node:test';
import { ProposalAgentRegistry } from '../src/proposal-agent-registry.js';

test('只有通过受限验收且具备公开网页读取能力的新员工才会进入正式派活名单', async () => {
  const registry = new ProposalAgentRegistry({
    baseRegistry: { async list() { return [{ agentId:'operator', name:'运维官', acceptedTaskTypes:['operations.health-review'], status:'active' }]; } },
    store: { async listProposals() { return [
      { proposalId:'approved-1', status:'active', requestedCapabilities:['content.public.fetch'], candidateManifest:{ agentId:'public-reporter', name:'公开报告员', acceptedTaskTypes:['report.public-material'] } },
      { proposalId:'testing-1', status:'testing', requestedCapabilities:['content.public.fetch'], candidateManifest:{ agentId:'not-live', name:'试用员工', acceptedTaskTypes:['report.public-material'] } },
      { proposalId:'unsafe-1', status:'active', requestedCapabilities:[], candidateManifest:{ agentId:'no-fetch', name:'没有读取能力的员工', acceptedTaskTypes:['report.public-material'] } }
    ]; } }
  });
  const agents = await registry.list();
  assert.deepEqual(agents.map((agent) => agent.agentId).sort(), ['operator', 'public-reporter']);
  assert.equal((await registry.get('public-reporter')).runtime.kind, 'proposal-public-report');
});

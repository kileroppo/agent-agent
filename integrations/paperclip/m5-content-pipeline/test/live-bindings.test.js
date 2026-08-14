import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveLiveAgentBindings } from '../src/live-bindings.ts';

const definition = {
  stages:[
    { owner:'ajun' },
    { owner:'reviewer' },
    { owner:'ajun' },
  ],
};

test('live apply 按 agentArmyId 同时绑定主线和仅并行Routine使用的岗位', async () => {
  const adapter = {
    companyId:'company-1',
    async request(method, path) {
      assert.equal(method, 'GET');
      assert.equal(path, '/api/companies/company-1/agents');
      return [
        { id:'agent-ajun', status:'paused', metadata:{ agentArmyId:'ajun' } },
        { id:'agent-reviewer', status:'idle', metadata:{ agentArmyId:'reviewer' } },
        { id:'old-reviewer', status:'terminated', metadata:{ agentArmyId:'reviewer' } },
        { id:'agent-intel', status:'idle', metadata:{ agentArmyId:'intel-researcher' } },
        { id:'agent-xiaod', status:'idle', metadata:{ agentArmyId:'xiaod' } },
        { id:'agent-video-analysis', status:'idle', metadata:{ agentArmyId:'video-content-analyst' } },
        { id:'agent-content', status:'idle', metadata:{ agentArmyId:'content-creator' } },
      ];
    },
  };
  assert.deepEqual(await resolveLiveAgentBindings(adapter, definition), {
    agentIds:{
      ajun:'agent-ajun',
      reviewer:'agent-reviewer',
      'intel-researcher':'agent-intel',
      xiaod:'agent-xiaod',
      'video-content-analyst':'agent-video-analysis',
      'content-creator':'agent-content',
    },
  });
});

test('岗位缺失或重复时在任何 live write 前拒绝', async (t) => {
  for (const agents of [
    [{ id:'agent-ajun', status:'paused', metadata:{ agentArmyId:'ajun' } }],
    [
      { id:'agent-ajun', status:'paused', metadata:{ agentArmyId:'ajun' } },
      { id:'reviewer-a', status:'idle', metadata:{ agentArmyId:'reviewer' } },
      { id:'reviewer-b', status:'idle', metadata:{ agentArmyId:'reviewer' } },
    ],
  ]) {
    await t.test(String(agents.length), async () => {
      let reads = 0;
      const adapter = {
        companyId:'company-1',
        async request() {
          reads += 1;
          return agents;
        },
      };
      await assert.rejects(resolveLiveAgentBindings(adapter, definition), /必须且只能绑定一个/);
      assert.equal(reads, 1);
    });
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { consoleOverviewReadView } from '../src/console-overview-read-model.ts';
import { TaskOverview } from '../src/task-overview.ts';

test('首页读模型只保留当前状态、单份员工摘要、能力摘要和最近三项', () => {
  const huge = 'x'.repeat(200_000);
  const overview = {
    taskFocus:{
      total:928, inProgress:0, ownerActionable:1,
      actions:[{ taskId:'task-1', workflowId:'workflow-1', title:'请验收', status:'waiting_acceptance', action:'选择有用或需改进' }],
      next:{ taskId:'task-1', workflowId:'workflow-1', title:'请验收', status:'waiting_acceptance', action:'选择有用或需改进' },
    },
    agents:Array.from({ length:20 }, (_, index) => ({
      agentId:`agent-${index}`, name:`员工${index}`, role:huge, status:'active',
      acceptedTaskTypes:['research.open-investigation'],
      capabilityTruth:{ overall:'verified', verified:true },
    })),
    alwaysOnAgents:[{ secret:huge }],
    onDemandAgents:[{ secret:huge }],
    capabilities:Array.from({ length:12 }, (_, index) => ({ id:`cap-${index}`, name:`能力${index}`, status:'ready', detail:huge, truth:{ overall:'verified' } })),
    recentTasks:Array.from({ length:10 }, (_, index) => ({
      taskId:`task-${index}`, taskType:'research.open-investigation', status:'succeeded', updatedAt:'2026-08-17T00:00:00.000Z',
      input:{ title:`任务${index}`, context:{ raw:huge } }, artifactRefs:[{ data:huge }], presentation:{ raw:huge },
    })),
    usage:{ taskCount:928, trackedTaskCount:800, actualToolCalls:3000, tools:[{ raw:huge }], cost:{ reportedTaskCount:3, totals:[{ currency:'USD', amount:1.23 }] } },
    billing:{ entries:[{ raw:huge }] },
    workflows:[{ raw:huge }],
    skillReadiness:[{ raw:huge }],
    validationCampaign:{ raw:huge },
  };

  const compact = consoleOverviewReadView(overview);
  const serialized = JSON.stringify(compact);

  assert.equal(compact.schemaVersion, 'agent.army/console-overview/v2');
  assert.equal(compact.agents.length, 20);
  assert.equal(compact.recentTasks.length, 3);
  assert.equal(compact.taskFocus.next.workflowId, 'workflow-1');
  for (const omitted of ['billing', 'workflows', 'alwaysOnAgents', 'onDemandAgents', 'skillReadiness', 'validationCampaign']) {
    assert.equal(Object.hasOwn(compact, omitted), false);
  }
  assert.doesNotMatch(serialized, /artifactRefs|raw|secret/);
  assert.ok(Buffer.byteLength(serialized) < 50 * 1024);
});

test('TaskOverview 首页读取不再计算账单，日期账单接口仍独立保留', async () => {
  let billingCalls = 0;
  const overview = new TaskOverview({
    registry:{ list:async () => [], get:async () => null },
    store:{ list:async () => [], listApprovals:async () => [], listProposals:async () => [] },
    governance:{ health:async () => ({ status:'ready', version:'test' }) },
    skillExecutionRegistry:{ overview:async () => [] },
    capabilityCatalog:{ openTaskDelegates:() => ({}) },
    usageLedger:{ summarize:() => { billingCalls += 1; return {}; } },
  });

  const compact = await overview.readConsole();
  assert.equal(billingCalls, 0);
  assert.equal(Object.hasOwn(compact, 'billing'), false);

  await overview.usage();
  assert.equal(billingCalls, 1);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { consoleOverviewReadView } from '../src/console-overview-read-model.ts';
import { TaskOverview } from '../src/task-overview.ts';
import { buildTaskValidationOverview } from '../src/task-validation-overview.ts';

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
    manager:{ agentId:'ajun', name:'A君', role:'军团总管', status:'active', secret:huge, capabilityTruth:{ overall:'live' } },
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
  assert.equal(compact.health.reliability.status, 'unknown');
  assert.equal(compact.health.businessDebt.status, 'unknown');
  assert.equal(compact.manager.agentId, 'ajun');
  assert.equal(compact.agents.some((agent) => agent.agentId === 'ajun'), false);
  assert.equal(compact.agents.length, 20);
  assert.equal(compact.recentTasks.length, 3);
  assert.equal(compact.taskFocus.next.workflowId, 'workflow-1');
  for (const omitted of ['billing', 'workflows', 'alwaysOnAgents', 'onDemandAgents', 'skillReadiness', 'validationCampaign']) {
    assert.equal(Object.hasOwn(compact, omitted), false);
  }
  assert.doesNotMatch(serialized, /artifactRefs|raw|secret/);
  assert.ok(Buffer.byteLength(serialized) < 50 * 1024);
});

test('首页在任务账本未变更时复用精确快照，写入通知后才重算', async () => {
  let taskReads = 0;
  let approvalReads = 0;
  let proposalReads = 0;
  let acceptanceReads = 0;
  let notify = null;
  const task = {
    taskId:'historic-failure', taskType:'research.intel-report', status:'failed',
    updatedAt:'2026-08-17T00:00:00.000Z', createdAt:'2026-08-17T00:00:00.000Z',
    input:{ title:'待复验任务' }, source:{ channel:'feishu', targetAgentId:'operator' }, artifactRefs:[],
  };
  const overview = new TaskOverview({
    registry:{ list:async () => [{ agentId:'operator', name:'操作员', status:'active', acceptedTaskTypes:[] }], get:async () => null },
    store:{
      list:async () => { taskReads += 1; return [task]; },
      listApprovals:async () => { approvalReads += 1; return []; },
      listProposals:async () => { proposalReads += 1; return []; },
      listWorkflowAcceptances:async () => { acceptanceReads += 1; return []; },
      subscribe:(listener) => { notify = listener; return () => {}; },
    },
    governance:{ health:async () => ({ status:'ready', version:'test' }) },
    skillExecutionRegistry:{ overview:async () => [] },
    capabilityCatalog:{ openTaskDelegates:() => ({}) },
  });

  const first = await overview.readConsole();
  const second = await overview.readConsole();
  assert.equal(first.taskFocus.unresolvedFailures, 1);
  assert.equal(second.taskFocus.unresolvedFailures, 1);
  assert.deepEqual({ taskReads, approvalReads, proposalReads, acceptanceReads }, {
    taskReads:1, approvalReads:1, proposalReads:1, acceptanceReads:1,
  });

  notify({ kind:'mutation' });
  await overview.readConsole();
  assert.deepEqual({ taskReads, approvalReads, proposalReads, acceptanceReads }, {
    taskReads:2, approvalReads:2, proposalReads:2, acceptanceReads:2,
  });
});

test('首页冷快照和存活层并发时复用同一轮治理健康探测', async () => {
  let governanceCalls = 0;
  const overview = new TaskOverview({
    registry:{ list:async () => [], get:async () => null },
    store:{
      list:async () => [], listApprovals:async () => [], listProposals:async () => [], listWorkflowAcceptances:async () => [],
      subscribe:() => () => {},
    },
    governance:{ health:async () => {
      governanceCalls += 1;
      await new Promise((resolve) => setImmediate(resolve));
      return { status:'ready', version:'test' };
    } },
    skillExecutionRegistry:{ overview:async () => [] },
    capabilityCatalog:{ openTaskDelegates:() => ({}) },
  });

  await overview.readConsole();
  assert.equal(governanceCalls, 1);
});

test('首页只采信当前 git/release 对应的可靠性观测', async () => {
  const overview = new TaskOverview({
    registry:{ list:async () => [], get:async () => null },
    store:{ list:async () => [], listApprovals:async () => [], listProposals:async () => [], listWorkflowAcceptances:async () => [] },
    governance:{ health:async () => ({ status:'ready', version:'test' }) },
    skillExecutionRegistry:{ overview:async () => [] },
    capabilityCatalog:{ openTaskDelegates:() => ({}) },
    getRuntimeIdentity:async () => ({ gitHead:'source-current', releaseHash:'release-current' }),
    getReliabilitySnapshot:async () => ({
      status:'healthy', observedAt:'2026-08-17T01:00:00.000Z',
      runtimeIdentity:{ gitHead:'source-current', releaseHash:'release-old' },
    }),
  });

  const compact = await overview.readConsole();
  assert.equal(compact.health.reliability.status, 'unknown');
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

test('首页轻量读取跳过未消费的全量 validationCampaign 计算，完整总览仍保留它', async () => {
  let campaignCalls = 0;
  const input = {
    tasks:[{ taskId:'historic-failure', taskType:'research.intel-report', status:'failed' }],
    approvals:[],
    store:{
      listProposals:async () => [],
      listWorkflowAcceptances:async () => [],
    },
    capabilityCatalog:{ openTaskDelegates:() => ({}) },
    buildCampaign:() => {
      campaignCalls += 1;
      return { taskCount:1, groupCount:1, groups:[] };
    },
  };

  const compact = await buildTaskValidationOverview({ ...input, includeValidationCampaign:false });
  assert.equal(campaignCalls, 0);
  assert.equal(Object.hasOwn(compact, 'validationCampaign'), false);
  assert.equal(compact.taskFocus.failed, 1);

  const complete = await buildTaskValidationOverview(input);
  assert.equal(campaignCalls, 1);
  assert.equal(complete.validationCampaign.taskCount, 1);
});

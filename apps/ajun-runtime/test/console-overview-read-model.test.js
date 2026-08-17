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

test('首页每次读取易变运行态，只复用任务派生快照', async () => {
  let taskReads = 0;
  let approvalReads = 0;
  let proposalReads = 0;
  let acceptanceReads = 0;
  let registryReads = 0;
  let governanceReads = 0;
  let skillReads = 0;
  let localAiReads = 0;
  let executorReads = 0;
  let state = 'first';
  const overview = new TaskOverview({
    registry:{
      list:async () => { registryReads += 1; return [{ agentId:'operator', name:`操作员-${state}`, status:'active', acceptedTaskTypes:[] }]; },
      get:async () => null,
    },
    store:{
      list:async () => { taskReads += 1; return []; },
      listApprovals:async () => { approvalReads += 1; return []; },
      listProposals:async () => { proposalReads += 1; return []; },
      listWorkflowAcceptances:async () => { acceptanceReads += 1; return []; },
      subscribe:() => () => {},
    },
    governance:{ health:async () => { governanceReads += 1; return { status:state === 'first' ? 'ready' : 'unavailable', version:state }; } },
    skillExecutionRegistry:{ overview:async () => { skillReads += 1; return [{ slug:'open-kimi-ppt', status:state === 'first' ? 'ready' : 'unavailable' }]; } },
    localAiCapabilityStatus:async () => { localAiReads += 1; return { status:state === 'first' ? 'healthy' : 'degraded' }; },
    executors:{ operator:{ health:async () => { executorReads += 1; return { status:'healthy', checkedAt:state, requiredDatabases:{}, safeMessage:state }; } } },
    capabilityCatalog:{ openTaskDelegates:() => ({}) },
  });

  const first = await overview.readConsoleSnapshot();
  state = 'second';
  const second = await overview.readConsoleSnapshot();

  assert.equal(first.agents[0].name, '操作员-first');
  assert.equal(second.agents[0].name, '操作员-second');
  assert.equal(first.capabilities.find((capability) => capability.id === 'governance').status, 'ready');
  assert.equal(second.capabilities.find((capability) => capability.id === 'governance').status, 'unavailable');
  assert.deepEqual({ taskReads, approvalReads, proposalReads, acceptanceReads }, {
    taskReads:1, approvalReads:1, proposalReads:1, acceptanceReads:1,
  });
  assert.deepEqual({ registryReads, governanceReads, skillReads, localAiReads, executorReads }, {
    registryReads:2, governanceReads:2, skillReads:2, localAiReads:2, executorReads:2,
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

import assert from 'node:assert/strict';
import test from 'node:test';

import { preparePaperclipAssignmentContext } from '../src/paperclip-assignment-context.ts';
import * as assignmentContext from '../src/paperclip-assignment-context.ts';
import * as compatibilitySupport from '../src/task-service-m5-execution-context-support.ts';
import * as publicSupport from '../src/task-service-execution-support.ts';
import { ValidationError } from '../src/task-validation-error.ts';
import {
  hermesAgentFixture,
  paperclipIdentityFixture,
  setupTaskService,
} from './support/task-service-fixture.js';

test('旧五个指派上下文 export 保持同一函数、默认参数、this 和同步异常语义', async () => {
  for (const name of [
    'paperclipCaseContextFields',
    'm5PlanRevisionExecutionContext',
    'trustedRoleToolScope',
    'm5PipelineCaseChainIds',
    'm5RelatedTaskContext',
  ]) {
    assert.equal(compatibilitySupport[name], assignmentContext[name]);
    assert.equal(publicSupport[name], assignmentContext[name]);
  }
  assert.deepEqual(assignmentContext.paperclipCaseContextFields.call({ hidden:true }), {});
  assert.deepEqual(assignmentContext.m5RelatedTaskContext.call({ hidden:true }), {
    sourceTaskIds:[], sourceUrls:[],
  });
  const scope = assignmentContext.trustedRoleToolScope.call({ hidden:true });
  assert.equal(Object.isFrozen(scope), true);
  assert.equal(Object.isFrozen(scope.allowedTaskIds), true);
  assert.deepEqual(scope, {
    currentTaskId:null, currentAgentId:null, currentWorkflowId:null, currentStepId:null,
    allowedTaskIds:[], paperclipIssueId:null, paperclipRunId:null, pipelineCaseId:null,
  });
  assert.throws(
    () => assignmentContext.m5PlanRevisionExecutionContext.call({ hidden:true }),
    TypeError,
  );
  await assert.rejects(
    assignmentContext.m5PipelineCaseChainIds.call({ hidden:true }),
    TypeError,
  );
});

test('Paperclip 指派上下文集中解析 Case 链、前置任务、恢复修订和可信工具范围', async () => {
  const calls = [];
  const tasks = [
    relatedTask('source-parent', 'case-parent', '2026-08-13T00:00:00.000Z', 'https://example.com/parent'),
    relatedTask('source-day', 'other-case', '2026-08-13T01:00:00.000Z', 'https://example.com/day', {
      campaignId:'campaign-1', scheduledDate:'2026-08-13', contentVersion:'v2',
    }),
    { ...relatedTask('failed-source', 'case-current', '2026-08-13T02:00:00.000Z'), status:'failed' },
    { taskId:'sibling', parentTaskId:'mission-1' },
  ];
  const pipelineCase = {
    id:'case-current',
    parentCaseId:'case-parent',
    caseKey:'day:2026-08-13',
    title:'当日选题',
    stageKey:'script',
    fields:{
      campaignId:' campaign-1 ',
      scheduledDate:'2026-08-13',
      contentVersion:'v2',
      theme:'  Agent 架构  ',
      platform:' xiaohongshu ',
      ignored:'secret',
    },
  };
  const activePlanRevision = {
    schemaVersion:'agent.army/m5-plan-revision/v1',
    revisionId:'revision-2',
    revision:2,
    failedCaseId:'case-current',
    failureObservation:{ summary:'旧路线失败' },
    rejectedRoute:{ kind:'same-route', reason:'没有变化' },
    nextRoute:{
      kind:'alternative', stageKey:'script', preserveVerifiedWorkProducts:true,
      instruction:'更换素材和脚本角度。',
    },
  };

  const context = await preparePaperclipAssignmentContext({
    governance:{
      async getPipelineCase(caseId) {
        calls.push(caseId);
        return { id:caseId };
      },
    },
    tasks,
    assignmentTask:{ routineKey:'m5-script', pipelineCaseId:'case-current' },
    pipelineCase,
    activePlanRevision,
  });
  assert.deepEqual(calls, ['case-parent']);

  const input = context.createTaskInput({
    identity:{ issue:{ identifier:'ARMY-8', title:'生成脚本', description:'形成可审脚本。' } },
    assignmentProjectId:'project-1',
  });
  const assignmentFields = context.assignmentRecoveryFields();
  assert.notEqual(input.context.m5Recovery, assignmentFields.m5Recovery);
  assert.deepEqual(input, {
    title:'生成脚本',
    description:'形成可审脚本。',
    topic:'Agent 架构',
    contentGoal:'Agent 架构',
    platforms:['xiaohongshu'],
    sourceUrl:'https://example.com/parent',
    sourceUrls:['https://example.com/parent', 'https://example.com/day'],
    context:{
      paperclipIssueIdentifier:'ARMY-8',
      paperclipRoutineKey:'m5-script',
      pipelineCaseId:'case-current',
      paperclipProjectId:'project-1',
      m5Recovery:assignmentFields.m5Recovery,
      sourceTaskIds:['source-parent', 'source-day'],
      pipelineCase:{
        id:'case-current',
        parentCaseId:'case-parent',
        caseKey:'day:2026-08-13',
        title:'当日选题',
        stageKey:'script',
        fields:{
          campaignId:'campaign-1',
          scheduledDate:'2026-08-13',
          theme:'Agent 架构',
          platform:'xiaohongshu',
          contentVersion:'v2',
        },
      },
    },
  });

  const refreshed = context.refreshTaskInput({
    title:'旧标题', context:{ keep:'yes', paperclipProjectId:'old-project' },
  }, { assignmentProjectId:'project-1' });
  assert.equal(refreshed.title, '旧标题');
  assert.equal(refreshed.context.keep, 'yes');
  assert.equal(refreshed.context.paperclipProjectId, 'project-1');
  assert.deepEqual(refreshed.context.sourceTaskIds, ['source-parent', 'source-day']);
  assert.notEqual(refreshed.context.m5Recovery, input.context.m5Recovery);

  const grant = context.scopeRoleToolGrant({ grant:{ tool:'read' }, workspaceRoot:'/tmp/work' }, {
    task:{
      taskId:'current', parentTaskId:'mission-1', assigneeAgentId:'creator',
      currentStage:'paperclip_hermes_running', workflow:{ workflowId:'workflow-1' },
    },
    identity:{ issue:{ id:'issue-1' }, run:{ id:'run-1' } },
  });
  assert.equal(Object.isFrozen(grant), true);
  assert.deepEqual(grant.trustedScope, {
    currentTaskId:'current',
    currentAgentId:'creator',
    currentWorkflowId:'workflow-1',
    currentStepId:'paperclip_hermes_running',
    allowedTaskIds:['source-parent', 'source-day', 'sibling'],
    paperclipIssueId:'issue-1',
    paperclipRunId:'run-1',
    pipelineCaseId:'case-current',
  });
});

test('独立复核任务的可信只读范围包含它直接引用的原任务', async () => {
  const source = { taskId:'source-task', artifactRefs:[] };
  const context = await preparePaperclipAssignmentContext({
    tasks:[source, { taskId:'review-task', parentTaskId:'source-task' }],
    assignmentTask:{}, pipelineCase:null, activePlanRevision:null,
  });
  const grant = context.scopeRoleToolGrant({ grant:{ tool:'read' } }, {
    task:{ taskId:'review-task', parentTaskId:'source-task', assigneeAgentId:'reviewer' },
    identity:{ issue:{ id:'review-issue' }, run:{ id:'review-run' } },
  });
  assert.deepEqual(grant.trustedScope.allowedTaskIds, ['source-task']);
});

test('Paperclip 指派保留核验、读取、授权、父链和写信封的请求时序及 method override', async () => {
  const calls = [];
  const caseId = '11111111-1111-4111-8111-111111111111';
  const parentCaseId = '22222222-2222-4222-8222-222222222222';
  const identity = paperclipIdentityFixture('context-order', 'content-creator', '小创', {
    title:'M5 / 脚本',
    description:`[agent-army:m5:routine:m5-script] 当前 Case 为 ${caseId}。`,
  });
  const { service, store, registry } = setupTaskService({
    agents:[hermesAgentFixture('content-creator', '小创', ['content.video-script-package'])],
    governance:{
      async verifyHermesAssignment() { calls.push('verify'); return identity; },
      async getPipelineCase(id) {
        calls.push(`case:${id}`);
        return id === caseId ? { id, parentCaseId } : { id };
      },
      async assertCaseIssueLink() { calls.push('assert-link'); },
    },
  });
  const originalGet = registry.get.bind(registry);
  registry.get = async (...args) => { calls.push('registry'); return originalGet(...args); };
  const originalList = store.list.bind(store);
  store.list = async (...args) => { calls.push('list'); return originalList(...args); };
  const originalCreate = store.createTask.bind(store);
  store.createTask = async (...args) => { calls.push('create'); return originalCreate(...args); };
  service.compilePaperclipRoleToolGrant = async () => { calls.push('compile-grant-override'); return null; };

  await service.getPaperclipAssignment({});
  assert.deepEqual(calls, [
    'verify',
    'registry',
    'list',
    `case:${caseId}`,
    'assert-link',
    'compile-grant-override',
    `case:${parentCaseId}`,
    'create',
  ]);
});

test('无 M5 Case 的指派保持普通任务信封，并在刷新时显式清空旧恢复上下文', async () => {
  const context = await preparePaperclipAssignmentContext({
    tasks:[], assignmentTask:{}, pipelineCase:null, activePlanRevision:null,
  });
  const input = context.createTaskInput({ identity:{ issue:{} } });
  assert.deepEqual(input, {
    title:'Paperclip 指派任务', description:'', topic:null, contentGoal:null,
    platforms:[], sourceUrl:null, sourceUrls:[],
    context:{ paperclipIssueIdentifier:null },
  });
  assert.deepEqual(
    context.refreshTaskInput({ context:{
      m5Recovery:{ revisionId:'old' },
      paperclipProjectId:'old-project',
      sourceTaskIds:['old-source'],
      pipelineCase:{ id:'old-case' },
      keep:true,
    } }),
    { context:{
      m5Recovery:null,
      paperclipProjectId:'old-project',
      sourceTaskIds:['old-source'],
      pipelineCase:{ id:'old-case' },
      keep:true,
    } },
  );
  assert.deepEqual(context.assignmentRecoveryFields(), {});
  assert.equal(context.scopeRoleToolGrant(null, {}), null);
});

test('Paperclip 指派上下文保留 Case 父链错误类型和失败关闭语义', async () => {
  await assert.rejects(
    preparePaperclipAssignmentContext({
      governance:{ async getPipelineCase() { return { id:'case-current' }; } },
      tasks:[],
      assignmentTask:{ pipelineCaseId:'case-current' },
      pipelineCase:{ id:'case-current', parentCaseId:'case-current' },
    }),
    (error) => error instanceof ValidationError && /父子链无效或存在循环/.test(error.message),
  );
});

function relatedTask(taskId, pipelineCaseId, createdAt, source = null, fields = {}) {
  return {
    taskId,
    status:'succeeded',
    createdAt,
    governance:{ paperclipIssueId:`issue-${taskId}` },
    input:{ context:{ pipelineCaseId, pipelineCase:{ fields } } },
    artifactRefs:source ? [{
      validation:{ publicReadOnly:true },
      data:{ sources:[{ source }] },
    }] : [],
  };
}

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SQLiteTaskStore } from '../src/sqlite-task-store.ts';
import { TaskFeedback } from '../src/task-feedback.ts';
import { queryTaskRecordsInMemory } from '../src/task-record-query.ts';
import { TaskRecordService } from '../src/task-record-service.ts';
import { TaskStore } from '../src/task-store.ts';
import { WorkflowAcceptanceService } from '../src/workflow-acceptance-service.ts';
import { createWorkflowLink } from '../src/workflow/contracts.ts';
import { evaluateWorkflowTasks } from '../src/workflow/evaluation.ts';

for (const backend of ['json', 'sqlite']) {
  test(`${backend} 工作流验收单独持久化，并支持版本与幂等保护`, async () => {
    await withStore(backend, async (store) => {
      const mutations = [];
      const unsubscribe = store.subscribe((event) => mutations.push(event));
      store.subscribe(() => { throw new Error('监听器失败不能影响写入'); });
      const workflow = createWorkflowLink({
        taskType:'research.intel-report',
        idempotencyKey:`${backend}:research`,
      });
      const task = await persistVerifiedTask(store, verifiedTask(`task-${backend}`, workflow));
      assert.deepEqual(mutations.at(-1), { kind:'mutation' });
      const beforeAcceptance = mutations.length;
      const service = new WorkflowAcceptanceService({ store });
      const input = {
        decision:'accepted',
        note:'结论可以直接使用',
        source:'local_console',
        expectedRevision:0,
        idempotencyKey:`console:${backend}:1`,
      };
      const first = await service.record(workflow.workflowId, input);
      assert.equal(first.created, true);
      assert.equal(first.duplicate, false);
      assert.equal(first.acceptance.version, 1);
      assert.equal(mutations.length, beforeAcceptance + 1);
      assert.equal((await store.getTask(task.taskId)).status, 'succeeded');

      const replay = await service.record(workflow.workflowId, input);
      assert.equal(replay.duplicate, true);
      assert.equal((await store.listWorkflowAcceptances()).length, 1);
      await assert.rejects(
        store.recordWorkflowAcceptance({
          workflowId:workflow.workflowId,
          decision:'revision_required',
          note:'不同结论',
          source:'local_console',
          expectedVersion:1,
          idempotencyKey:input.idempotencyKey,
        }),
        (error) => error.code === 'workflow_acceptance_idempotency_conflict',
      );
      await assert.rejects(
        store.recordWorkflowAcceptance({
          workflowId:workflow.workflowId,
          decision:'accepted',
          note:'新操作',
          source:'local_console',
          expectedVersion:0,
          idempotencyKey:`console:${backend}:2`,
        }),
        (error) => error.code === 'workflow_acceptance_version_conflict',
      );

      const evaluation = evaluateWorkflowTasks(await store.list(), await store.listWorkflowAcceptances())[0];
      assert.equal(evaluation.status, 'succeeded');
      assert.equal(evaluation.acceptanceDecision, 'accepted');
      assert.equal(evaluation.ownerAction, null);
      unsubscribe();
    });
  });
}

test('飞书评价和运行台共用工作流验收事实，需改进不会改写机器结果', async () => {
  await withStore('json', async (store) => {
    const workflow = createWorkflowLink({ taskType:'office.presentation-package', idempotencyKey:'feishu:report' });
    const task = await persistVerifiedTask(store, verifiedTask('task-feishu', workflow, 'office.presentation-package'));
    const recorded = await new TaskFeedback({ store }).record(task.taskId, {
      sentiment:'needs_improvement',
      note:'请把结论再精简一些',
    });
    assert.equal(recorded.status, 'succeeded');
    assert.equal(recorded.workflowAcceptance.decision, 'revision_required');
    assert.equal(Object.hasOwn((await store.getTask(task.taskId)).evaluation || {}, 'humanAcceptance'), false);
    const evaluation = evaluateWorkflowTasks(await store.list(), await store.listWorkflowAcceptances())[0];
    assert.equal(evaluation.status, 'succeeded');
    assert.equal(evaluation.acceptanceDecision, 'revision_required');
    assert.equal(evaluation.humanAccepted, false);
    assert.equal(evaluation.ownerAction, null);
  });
});

test('负责人待办每个业务工作流只留一条，并排除历史验证和系统工作', () => {
  const workflow = createWorkflowLink({ taskType:'research.intel-report', idempotencyKey:'business:one' });
  const business = [
    verifiedTask('business-research', workflow),
    verifiedTask('business-report', { ...workflow, step:{ ...workflow.step, stepId:'step:report', key:'creation' } }, 'content.article-draft'),
  ];
  const validationWorkflow = createWorkflowLink({ taskType:'research.intel-report', idempotencyKey:'validation:one' });
  const validation = verifiedTask('validation-task', validationWorkflow);
  validation.source = { channel:'product-maturity-validation' };
  validation.input.context = { validationPurpose:'product_maturity_role_freshness' };
  const historicalValidationWorkflow = createWorkflowLink({ taskType:'research.intel-report', idempotencyKey:'historical-validation:one' });
  const historicalValidation = verifiedTask('historical-validation-task', historicalValidationWorkflow);
  historicalValidation.input.description = '修复后最终业务复验：只读公开来源并核对历史失败。';
  const systemWorkflow = createWorkflowLink({ taskType:'operations.health-review', idempotencyKey:'system:one' });
  const system = verifiedTask('system-task', systemWorkflow, 'operations.health-review');
  system.source = { channel:'paperclip' };
  const page = queryTaskRecordsInMemory([...business, validation, historicalValidation, system], {
    view:'all',
    backlogCategory:'owner_actionable',
  });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].taskId, 'business-research');
});

test('负责人详情投影可操作验收目标，局域网详情不泄露操作入口', async () => {
  const workflow = createWorkflowLink({ taskType:'research.intel-report', idempotencyKey:'detail:one' });
  const task = verifiedTask('detail-task', workflow);
  const store = {
    async getTask() { return task; },
    async listApprovals() { return []; },
    async listWorkflowTasks() { return [task]; },
    async getWorkflowAcceptance() { return null; },
  };
  const service = new TaskRecordService({ store });
  const owner = await service.detail(task.taskId, { audience:'local-owner' });
  assert.deepEqual(owner.acceptanceTarget, {
    schemaVersion:'agent.army/workflow-acceptance-target/v1',
    workflowId:workflow.workflowId,
    workKind:'business',
    status:'waiting_acceptance',
    decision:null,
    revision:0,
    actionable:true,
    targetTaskId:task.taskId,
    title:'业务报告',
    actions:[
      { decision:'accepted', label:'有用' },
      { decision:'revision_required', label:'需改进' },
    ],
  });
  const lan = await service.detail(task.taskId, { audience:'lan' });
  assert.equal(Object.hasOwn(lan, 'acceptanceTarget'), false);
});

function verifiedTask(taskId, workflow, taskType = 'research.intel-report') {
  return {
    taskId,
    taskType,
    status:'succeeded',
    workflow,
    input:{ title:'业务报告' },
    source:{ channel:'feishu' },
    artifactRefs:[{
      artifactId:`artifact:${taskId}`,
      type:'report',
      validation:{ exists:true, readable:true, nonEmpty:true },
    }],
    createdAt:'2026-08-17T00:00:00.000Z',
    updatedAt:'2026-08-17T00:01:00.000Z',
  };
}

async function withStore(backend, operation) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `workflow-acceptance-${backend}-`));
  const filePath = path.join(directory, backend === 'sqlite' ? 'runtime.sqlite' : 'runtime.json');
  const store = backend === 'sqlite' ? new SQLiteTaskStore(filePath) : new TaskStore(filePath);
  try {
    await operation(store);
  } finally {
    store.close?.();
    await fs.rm(directory, { recursive:true, force:true });
  }
}

async function persistVerifiedTask(store, task) {
  const created = await store.createTask({ ...task, status:'queued', artifactRefs:[] });
  await store.updateTask(created.taskId, { status:'running', currentStage:'executing' });
  return store.updateTask(created.taskId, {
    status:'succeeded',
    currentStage:'completed',
    artifactRefs:task.artifactRefs,
  });
}

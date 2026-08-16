import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DeliveryQualityRuntime,
  prepareDeliveryQualityResult,
} from '../src/workflow/delivery-quality-runtime.ts';
import { DeliveryQualityReconciler } from '../src/workflow/delivery-quality-reconciler.ts';

function researchTask(overrides = {}) {
  return {
    taskId:'research-1',
    taskType:'research.intel-report',
    assigneeAgentId:'intel-researcher',
    status:'running',
    currentStage:'executing',
    input:{ title:'研究真实 Plan B' },
    workflow:{ workflowId:'workflow-1', workflowType:'research' },
    artifactRefs:[],
    revisionRound:0,
    ...overrides,
  };
}

function report(id = 'report-v1') {
  return { artifactId:id, type:'intel_research_report', validation:{ exists:true, readable:true, nonEmpty:true } };
}

function readOnlyDiagnosisTask(overrides = {}) {
  const taskId = 'diagnosis-1';
  return {
    taskId,
    taskType:'operations.failure-recovery',
    parentTaskId:'failed-parent',
    requester:{ kind:'local-owner' },
    source:{ channel:'internal-recovery' },
    recovery:{ mode:'read_only_diagnosis' },
    status:'queued',
    currentStage:'queued_for_execution',
    input:{
      title:'只读诊断：检查系统状态',
      context:{
        failedTaskId:'failed-parent',
        parentPaperclipIssueId:'paperclip-issue-original',
        diagnosisOnly:true,
        prohibitedActions:['retry', 'code_write', 'permission_expansion', 'external_publish'],
      },
    },
    artifactRefs:[],
    ...overrides,
  };
}

function diagnosisArtifact(taskId = 'diagnosis-1') {
  return {
    artifactId:`recovery-decision:${taskId}`,
    type:'recovery_decision',
    validation:{ exists:true, readable:true, nonEmpty:true },
    data:{ diagnosis:{ conclusion:'结论', evidence:'依据', impact:'影响', nextAction:'下一步' } },
  };
}

function fixture(initial) {
  const tasks = new Map(initial.map((task) => [task.taskId, structuredClone(task)]));
  const created = [];
  const events = [];
  const store = {
    async getTask(id) { return tasks.get(id) || null; },
    async list() { return [...tasks.values()]; },
    async updateTask(id, patch) {
      const updated = { ...tasks.get(id), ...patch };
      tasks.set(id, updated);
      return updated;
    },
  };
  const runtime = new DeliveryQualityRuntime({
    store,
    async createTask(input) {
      const task = { taskId:`child-${created.length + 1}`, status:'running', input:{ ...input, context:input.context }, ...input };
      tasks.set(task.taskId, task);
      created.push(task);
      return task;
    },
    taskRunEvents:{ appendTaskRunEvent(event) { events.push(event); } },
  });
  return { runtime, store, tasks, created, events };
}

test('重要任务产出后先扣留并只创建一个独立复核任务', async () => {
  const original = researchTask();
  const held = prepareDeliveryQualityResult(original, {
    status:'succeeded', currentStage:'report_ready', artifactRefs:[report()],
  });
  assert.equal(held.status, 'running');
  assert.equal(held.currentStage, 'delivery_quality_review_pending');

  const state = fixture([{ ...original, ...held }]);
  const first = await state.runtime.continue(state.tasks.get(original.taskId));
  const replay = await state.runtime.continue(first);
  assert.equal(state.created.length, 1);
  assert.equal(state.created[0].taskType, 'governance.assurance-review');
  assert.equal(replay.deliveryQualityRuntime.reviewTaskId, state.created[0].taskId);
  assert.deepEqual(state.events.map((event) => event.eventType), ['workflow_state_changed', 'review_requested']);
});

test('受信任只读诊断直接完成，不再进入独立交付复核', () => {
  const task = readOnlyDiagnosisTask();
  const result = prepareDeliveryQualityResult(task, {
    status:'succeeded', currentStage:'recovery_decision_ready', artifactRefs:[diagnosisArtifact()],
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.currentStage, 'recovery_decision_ready');
  assert.equal(result.deliveryQuality, undefined);
});

test('旧规则已扣留的只读诊断自动完成并关闭误建复核', async () => {
  const reviewTask = {
    taskId:'diagnosis-review-1', taskType:'governance.assurance-review', status:'running',
    currentStage:'waiting_paperclip_heartbeat', execution:{ owner:'paperclip-hermes' },
  };
  const held = readOnlyDiagnosisTask({
    status:'running',
    currentStage:'delivery_quality_review_pending',
    artifactRefs:[diagnosisArtifact()],
    deliveryQuality:{ reviewTaskRequest:{ taskType:'governance.assurance-review' } },
    deliveryQualityRuntime:{ status:'review_pending', reviewTaskId:reviewTask.taskId },
    execution:{ executor:'operator', outcome:'delivery_quality_review_pending' },
  });
  const state = fixture([held, reviewTask]);

  const completed = await state.runtime.continue(held);

  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.currentStage, 'recovery_decision_ready');
  assert.equal(completed.deliveryQualityRuntime.status, 'bypassed_for_trusted_read_only_diagnosis');
  assert.equal(state.tasks.get(reviewTask.taskId).status, 'cancelled');
  assert.equal(state.created.length, 0);
});

test('复核通过才放行原任务，失败项只创建一轮定向返工', async () => {
  const original = researchTask({
    status:'running', currentStage:'delivery_quality_review_pending', artifactRefs:[report()],
  });
  const held = prepareDeliveryQualityResult(researchTask(), {
    status:'succeeded', artifactRefs:[report()],
  });
  Object.assign(original, held);
  const state = fixture([original]);
  const pending = await state.runtime.continue(state.tasks.get(original.taskId));
  const reviewTask = state.tasks.get(pending.deliveryQualityRuntime.reviewTaskId);

  const revised = await state.runtime.resolveReview(reviewTask, {
    status:'revise', failedCriteria:['claims_evidence_bound'], evidenceRefs:['artifact:report-v1'],
  });
  assert.equal(revised.status, 'running');
  assert.equal(revised.currentStage, 'delivery_quality_revision_scheduled');
  assert.equal(state.created.length, 2);
  const revisionTask = state.created[1];
  assert.equal(revisionTask.input.context.deliveryRevision.revisionRound, 1);
  assert.deepEqual(revisionTask.input.context.deliveryRevision.failedCriteria, ['claims_evidence_bound']);

  const revisionHeld = prepareDeliveryQualityResult(revisionTask, {
    status:'succeeded', artifactRefs:[report('report-v2')],
  });
  await state.store.updateTask(revisionTask.taskId, revisionHeld);
  const revisionPending = await state.runtime.continue(state.tasks.get(revisionTask.taskId));
  const secondReview = state.tasks.get(revisionPending.deliveryQualityRuntime.reviewTaskId);
  const accepted = await state.runtime.resolveReview(secondReview, {
    status:'passed', failedCriteria:[], evidenceRefs:['artifact:report-v2'],
  });
  assert.equal(accepted.status, 'succeeded');
  const root = state.tasks.get(original.taskId);
  assert.equal(root.status, 'succeeded');
  assert.deepEqual(root.artifactRefs.map((item) => item.artifactId), ['report-v1', 'report-v2']);
  assert.ok(state.events.some((event) => event.eventType === 'revision_started'));
  assert.ok(state.events.some((event) => event.eventType === 'review_completed'));
});

test('复核通过证据未绑定当前产物时阻断放行', async () => {
  const original = researchTask({
    status:'running', currentStage:'delivery_quality_review_pending', artifactRefs:[report()],
  });
  Object.assign(original, prepareDeliveryQualityResult(researchTask(), {
    status:'succeeded', artifactRefs:[report()],
  }));
  const state = fixture([original]);
  const pending = await state.runtime.continue(state.tasks.get(original.taskId));
  const reviewTask = state.tasks.get(pending.deliveryQualityRuntime.reviewTaskId);
  const stopped = await state.runtime.resolveReview(reviewTask, {
    status:'passed', failedCriteria:[], evidenceRefs:['artifact:not-current'],
  });
  assert.equal(stopped.status, 'waiting_test');
  assert.equal(stopped.currentStage, 'delivery_quality_stopped');
});

test('返工版本停止时根任务同步收敛为待测试', async () => {
  const root = researchTask({
    currentStage:'delivery_quality_revision_scheduled',
    deliveryQualityRuntime:{ status:'revision_pending', rootTaskId:'research-1' },
  });
  const revision = researchTask({
    taskId:'revision-1', revisionRound:1,
    input:{ context:{ deliveryRevision:{ rootTaskId:'research-1', revisionRound:1 } } },
    deliveryQualityRuntime:{ status:'review_pending', rootTaskId:'research-1' },
  });
  const state = fixture([root, revision]);
  const review = { taskId:'review-2' };
  await state.runtime.stop(revision, review, {
    status:'blocked', reason:'返工上限已到', profile:{ tier:'standard' },
  });
  assert.equal(state.tasks.get('revision-1').status, 'waiting_test');
  assert.equal(state.tasks.get('research-1').status, 'waiting_test');
  assert.equal(state.tasks.get('research-1').currentStage, 'delivery_quality_stopped');
  assert.equal(state.events.some((event) => event.taskId === 'research-1' && event.eventType === 'workflow_blocked'), true);
});

test('启动恢复幂等扫描未创建复核任务的pending父任务', async () => {
  const original = researchTask();
  const held = prepareDeliveryQualityResult(original, {
    status:'succeeded', artifactRefs:[report()],
  });
  const state = fixture([{ ...original, ...held }]);
  const reconciler = new DeliveryQualityReconciler({
    store:state.store,
    deliveryQuality:state.runtime,
  });
  const first = await reconciler.start();
  const replay = await reconciler.reconcile();
  assert.equal(first.status, 'reconciled');
  assert.deepEqual(first.resumedTaskIds, [original.taskId]);
  assert.equal(replay.status, 'reconciled');
  assert.equal(state.created.length, 1);
});

test('启动恢复会重试复核中状态同步且不重复创建复核任务', async () => {
  const original = researchTask();
  const held = prepareDeliveryQualityResult(original, {
    status:'succeeded', artifactRefs:[report()],
  });
  const tasks = new Map([[original.taskId, { ...original, ...held }]]);
  const created = [];
  let syncAttempts = 0;
  const store = {
    async getTask(id) { return tasks.get(id) || null; },
    async list() { return [...tasks.values()]; },
    async updateTask(id, patch) {
      const updated = { ...tasks.get(id), ...patch };
      tasks.set(id, updated);
      return updated;
    },
  };
  const runtime = new DeliveryQualityRuntime({
    store,
    async createTask(input) {
      const task = { ...input, taskId:'review-sync-1', status:'running' };
      created.push(task);
      return task;
    },
    async markReviewPending() {
      syncAttempts += 1;
      if (syncAttempts === 1) throw new Error('temporary Paperclip failure');
    },
  });
  const first = await runtime.continue(tasks.get(original.taskId));
  assert.equal(first.deliveryQualityRuntime.reviewSync.status, 'sync_pending');
  const reconciler = new DeliveryQualityReconciler({ store, deliveryQuality:runtime });
  const result = await reconciler.reconcile();
  assert.equal(result.status, 'reconciled');
  assert.equal(tasks.get(original.taskId).deliveryQualityRuntime.reviewSync.status, 'confirmed');
  assert.equal(created.length, 1);
  assert.equal(syncAttempts, 2);
});

test('启动恢复会把自身失败的复核任务收口为可安全重跑', async () => {
  const original = researchTask({
    status:'running',
    currentStage:'delivery_quality_review_pending',
    deliveryQuality:{ reviewTaskRequest:{ taskType:'governance.assurance-review' } },
    deliveryQualityRuntime:{ status:'review_pending', reviewTaskId:'review-failed-1' },
  });
  const failedReview = {
    taskId:'review-failed-1', taskType:'governance.assurance-review', status:'failed',
    error:{ userMessage:'复核执行器没有生成结论。' },
  };
  const state = fixture([original, failedReview]);
  const reconciler = new DeliveryQualityReconciler({
    store:state.store,
    deliveryQuality:state.runtime,
  });
  const result = await reconciler.reconcile();
  const stopped = state.tasks.get(original.taskId);
  assert.equal(result.status, 'reconciled');
  assert.equal(stopped.status, 'waiting_test');
  assert.equal(stopped.currentStage, 'delivery_quality_review_failed');
  assert.equal(stopped.deliveryQualityRuntime.status, 'review_failed');
  assert.equal(stopped.error.code, 'delivery_quality_review_failed');
  assert.equal(stopped.error.retryable, true);
  assert.equal(state.created.length, 0);
});

test('运行事件写入失败时仍如实保存质量复核启动失败', async () => {
  const original = researchTask({
    status:'running',
    currentStage:'delivery_quality_review_pending',
    deliveryQuality:{ reviewTaskRequest:{ taskType:'governance.assurance-review' } },
  });
  const tasks = new Map([[original.taskId, original]]);
  const runtime = new DeliveryQualityRuntime({
    store:{
      async getTask(id) { return tasks.get(id) || null; },
      async list() { return [...tasks.values()]; },
      async updateTask(id, patch) {
        const updated = { ...tasks.get(id), ...patch };
        tasks.set(id, updated);
        return updated;
      },
    },
    async createTask() { throw new Error('review runtime unavailable'); },
    taskRunEvents:{ appendTaskRunEvent() { throw new Error('event store unavailable'); } },
  });

  const stopped = await runtime.continue(original);
  assert.equal(stopped.status, 'waiting_test');
  assert.equal(stopped.error.code, 'delivery_quality_review_start_failed');
});

test('交付质量专用事件使用确定性 ID 去重', () => {
  const events = new Map();
  const runtime = new DeliveryQualityRuntime({
    store:{ async updateTask() {}, async list() { return []; } },
    async createTask() {},
    taskRunEvents:{ appendTaskRunEvent(event) {
      if (events.has(event.eventId)) throw Object.assign(new Error('duplicate'), { code:'task_run_event_exists' });
      events.set(event.eventId, event);
    } },
  });
  const task = researchTask({
    currentStage:'delivery_quality_review_pending',
    deliveryQualityRuntime:{ reviewTaskId:'review-1' },
  });

  runtime.record(task, 'review_requested', 'waiting', {});
  runtime.record(task, 'review_requested', 'waiting', {});
  assert.equal(events.size, 1);
  assert.match([...events.keys()][0], /^delivery-quality:/);
});

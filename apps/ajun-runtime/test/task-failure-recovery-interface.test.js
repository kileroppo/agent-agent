import assert from 'node:assert/strict';
import test from 'node:test';
import { setupTaskService } from './support/task-service-fixture.js';

const reporter = {
  agentId:'public-reporter',
  name:'公开资料报告员',
  status:'active',
  acceptedTaskTypes:['report.public-material'],
  runtime:{ kind:'proposal-public-report' },
};

test('TaskFailureRecoveryCoordinator 在普通任务失败后留下待恢复真相', async () => {
  const failures = [];
  const { service } = setupTaskService({ agents:[reporter], onTaskFailed:async (task) => { failures.push(task); } });
  service.fallbackExecutor = { supports() { return true; }, async execute() { throw new Error('公开网页暂时无法读取'); } };
  const task = await service.create({ title:'整理公开网页', taskType:'report.public-material', sourceUrl:'https://example.com/article' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(task.status, 'failed');
  assert.equal(task.error.code, 'executor_failed');
  assert.equal(task.recovery.coordination.status, 'pending');
  assert.equal((await service.notificationStatus(task.taskId)).status, 'recovery_pending');
  assert.deepEqual(failures.map((item) => item.taskId), [task.taskId]);
});

test('TaskFailureRecoveryCoordinator 首次启动失败时有界重试一次', async () => {
  let recoveryAttempts = 0;
  const { service } = setupTaskService({ agents:[reporter], onTaskFailed:async () => {
    recoveryAttempts += 1;
    if (recoveryAttempts === 1) throw new Error('恢复协调器瞬时启动失败');
  } });
  service.fallbackExecutor = { supports() { return true; }, async execute() { throw new Error('公开网页暂时无法读取'); } };
  await service.create({ title:'整理公开网页', taskType:'report.public-material', sourceUrl:'https://example.com/article' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(recoveryAttempts, 2);
});

test('TaskFailureRecoveryCoordinator 连续启动失败时落账为终态而不冒充诊断中', async () => {
  let recoveryAttempts = 0;
  const { service } = setupTaskService({ agents:[reporter], onTaskFailed:async () => {
    recoveryAttempts += 1;
    const error = new Error('恢复协调器不可用');
    error.code = 'recovery_coordinator_unavailable';
    throw error;
  } });
  service.fallbackExecutor = { supports() { return true; }, async execute() { throw new Error('公开网页暂时无法读取'); } };
  const task = await service.create({ title:'整理公开网页', taskType:'report.public-material', sourceUrl:'https://example.com/article' });
  await new Promise((resolve) => setImmediate(resolve));
  const stored = (await service.store.list()).find((item) => item.taskId === task.taskId);
  const notification = await service.notificationStatus(task.taskId);
  assert.equal(recoveryAttempts, 2);
  assert.equal(stored.recovery.coordination.status, 'start_failed');
  assert.equal(stored.recovery.coordination.errorCode, 'recovery_coordinator_unavailable');
  assert.equal(notification.status, 'recovery_start_failed');
  assert.equal(notification.terminal, true);
  assert.match(notification.message, /自动诊断也未能启动/);
  assert.doesNotMatch(notification.message, /正在诊断|正在交给/);
});

test('TaskFailureRecoveryCoordinator 保留可重试故障的结构化语义', async () => {
  const { service } = setupTaskService({ agents:[reporter], onTaskFailed:async () => {} });
  service.fallbackExecutor = { supports() { return true; }, async execute() {
    const error = new Error('受控瞬时故障');
    error.code = 'controlled_public_report_failure';
    error.category = 'transient';
    error.retryable = true;
    throw error;
  } };
  const task = await service.create({ title:'受控恢复验收', taskType:'report.public-material', sourceUrl:'https://example.com' });
  assert.equal(task.error.code, 'controlled_public_report_failure');
  assert.equal(task.error.category, 'transient');
  assert.equal(task.error.retryable, true);
});

test('TaskRecovery 在恢复前查读只读识图能力真相', async () => {
  let capabilityChecks = 0;
  const { service, records } = setupTaskService({
    localAiCapabilityStatus:async () => {
      capabilityChecks += 1;
      return { capabilities:[{ capability:'vision.analyze', configured:true, healthy:false, e2eVerified:false }] };
    },
  });
  records.tasks.push({
    taskId:'vision-failure',
    taskType:'content.video-benchmark-analysis',
    status:'failed',
    updatedAt:'2026-08-11T08:00:00.000Z',
    input:{ title:'视频拆解', visualMode:'auto', context:{ parentPaperclipIssueId:'paperclip-vision-1', sourceTaskIds:[] } },
    error:{ code:'controlled_vision_capability_unavailable', stage:'vision.analyze' },
  });
  const result = await service.requestRecovery('vision-failure', {
    actionKey:'retry_visual_analysis_after_recovery',
    expectedUpdatedAt:'2026-08-11T08:00:00.000Z',
    requestId:'vision-waiting-1',
  }, { kind:'local-owner', ref:'A君' });
  assert.equal(result.status, 'waiting_capability');
  assert.equal(result.capability.ready, false);
  assert.equal(capabilityChecks, 1);
  assert.equal(records.tasks.length, 1);
  assert.equal(records.tasks[0].recovery, undefined);
});

test('TaskFailureRecoveryCoordinator 不递归恢复运维诊断任务', async () => {
  const operator = { agentId:'operator', status:'active', acceptedTaskTypes:['operations.failure-recovery'] };
  const failures = [];
  const { service } = setupTaskService({ agents:[operator], onTaskFailed:async (task) => { failures.push(task); } });
  service.executors.operator = { async execute() { throw new Error('恢复检查本身失败'); } };
  const task = await service.create({ title:'处理任务故障', taskType:'operations.failure-recovery' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(task.status, 'failed');
  assert.deepEqual(failures, []);
});

test('任务受理保留恢复上下文和次数', async () => {
  const operator = { agentId:'operator', status:'active', acceptedTaskTypes:['operations.failure-recovery'] };
  const { service } = setupTaskService({ agents:[operator] });
  service.executors.operator = { async execute(task) {
    assert.equal(task.input.context.failedTaskId, 'failed-1');
    return { status:'succeeded', currentStage:'recovery_decision_ready', artifactRefs:[] };
  } };
  const task = await service.create({ title:'处理任务故障', taskType:'operations.failure-recovery', context:{ failedTaskId:'failed-1' }, recovery:{ rootTaskId:'failed-1', attempt:1 } });
  assert.deepEqual(task.input.context, { failedTaskId:'failed-1' });
  assert.deepEqual(task.recovery, { rootTaskId:'failed-1', attempt:1 });
});

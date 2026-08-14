import assert from 'node:assert/strict';
import test from 'node:test';
import { FailureRecoveryCoordinator } from '../src/failure-recovery-coordinator.ts';

test('可重试故障先交给运维官，并且只创建一次自动重试任务', async () => {
  const created = [];
  const tasks = {
    async create(input) {
      created.push(input);
      if (input.taskType === 'operations.failure-recovery') return { taskId: 'operator-task', artifactRefs: [{ type: 'recovery_decision', data: { action: 'retry_once', executionAuthorized:true } }] };
      return { taskId: 'retry-task', status: 'running' };
    }
  };
  let storedRecovery;
  const store = { async updateTask(_id, patch) { storedRecovery = patch.recovery; return patch; } };
  const coordinator = new FailureRecoveryCoordinator({ tasks, store });
  const result = await coordinator.handle(failedTask());
  assert.equal(result.status, 'retrying');
  assert.deepEqual(created.map((item) => item.taskType), ['operations.failure-recovery', 'media.transcribe-and-refine']);
  assert.equal(created[1].recovery.attempt, 1);
  assert.equal(created[1].idempotencyKey, 'recovery-retry:failed-task:1');
  assert.equal(storedRecovery.coordination.status, 'retrying');
});

test('自动重试用尽后升级给技术专家，不继续无限重试', async () => {
  const created = [];
  const tasks = {
    async create(input) {
      created.push(input);
      if (input.taskType === 'operations.failure-recovery') return { taskId: 'operator-task', artifactRefs: [{ type: 'recovery_decision', data: { action: 'escalate_technical_expert' } }] };
      return { taskId: 'technical-task', status: 'succeeded' };
    }
  };
  const coordinator = new FailureRecoveryCoordinator({ tasks, store: { async updateTask() {} } });
  const result = await coordinator.handle(failedTask({ recovery: { rootTaskId: 'failed-task', attempt: 1 } }));
  assert.equal(result.status, 'escalated');
  assert.deepEqual(created.map((item) => item.taskType), ['operations.failure-recovery', 'operations.technical-repair']);
  assert.equal(created.some((item) => item.idempotencyKey === 'recovery-retry:failed-task:2'), false);
  assert.equal(created[1].agentId, 'technical-expert');
});

test('升级技术专家前会先用只读诊断给出受控修复范围', async () => {
  const created = [];
  const tasks = { async create(input) { created.push(input); return input.taskType === 'operations.failure-recovery' ? { taskId:'operator-task', artifactRefs:[{ type:'recovery_decision', data:{ action:'escalate_technical_expert' } }] } : { taskId:'technical-task', status:'running' }; } };
  const diagnoser = { async diagnose(task, root) { assert.equal(root, '/workspace/project'); assert.equal(task.input.context.failure.code, 'xiaod_job_failed'); return { status:'ready', summary:'范围明确。', repairScope:{ files:['apps/a.js'], testCommand:'node --test apps/a.test.js', recoveryCheck:'确认恢复。' } }; } };
  const coordinator = new FailureRecoveryCoordinator({ tasks, store:{ async updateTask() {} }, diagnoser, projectRoot:'/workspace/project' });
  await coordinator.handle(failedTask({ recovery:{ rootTaskId:'failed-task', attempt:1 } }));
  assert.deepEqual(created[1].context.repairScope.files, ['apps/a.js']);
  assert.equal(created[1].context.diagnosis.status, 'ready');
});

test('运维恢复任务或技术修复任务自身失败时不再递归创建新修理单', async () => {
  const created = [];
  const coordinator = new FailureRecoveryCoordinator({ tasks:{ async create(input) { created.push(input); return {}; } }, store:{ async updateTask() {} } });
  const recovery = await coordinator.handle(failedTask({ taskType:'operations.failure-recovery' }));
  const technical = await coordinator.handle(failedTask({ taskType:'operations.technical-repair' }));
  assert.equal(recovery.status, 'ignored');
  assert.equal(technical.status, 'ignored');
  assert.deepEqual(created, []);
});

test('只读诊断不进入本机恢复协调器', async () => {
  const created = [];
  const coordinator = new FailureRecoveryCoordinator({
    tasks:{ async create(input) { created.push(input); return { taskId:'operator-task', artifactRefs:[] }; } },
    store:{ async updateTask() {} },
  });
  const result = await coordinator.handle(failedTask(), {
    actionKey:'request_read_only_diagnosis',
    requestId:'recovery-request-0004',
    requestedBy:{ kind:'local-owner', ref:'A君' },
  });
  assert.equal(result.status, 'ignored');
  assert.deepEqual(created, []);
});

test('Paperclip Hermes 原任务不进入本机安全恢复', async () => {
  const created = [];
  const coordinator = new FailureRecoveryCoordinator({
    tasks:{
      async create(input) {
        created.push(input);
        if (input.taskType === 'operations.failure-recovery') {
          return { taskId:'operator-task', artifactRefs:[{ type:'recovery_decision', data:{ action:'retry_once', executionAuthorized:true } }] };
        }
        return { taskId:'technical-task' };
      },
    },
    store:{ async updateTask() {} },
  });
  const result = await coordinator.handle(failedTask({
    execution:{ owner:'paperclip-hermes' },
    governance:{ paperclipIssueId:'paperclip-issue-original' },
  }), { actionKey:'request_safe_recovery' });
  assert.equal(result.status, 'requires_external');
  assert.deepEqual(created, []);
});

function failedTask(patch = {}) {
  return {
    taskId: 'failed-task',
    taskType: 'media.transcribe-and-refine',
    assigneeAgentId: 'xiaod',
    status: 'failed',
    currentStage: 'xiaod_failed',
    requester: { kind: 'local-owner', ref: 'A君' },
    source: { channel: 'feishu', chatRef: 'chat-1' },
    input: { title: '整理公开视频', description: '', sourceUrl: 'https://example.com/video' },
    error: { code: 'xiaod_job_failed', category: 'retryable', retryable: true, stage: 'xiaod_failed' },
    ...patch
  };
}

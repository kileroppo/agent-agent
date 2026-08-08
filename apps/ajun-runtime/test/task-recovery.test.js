import assert from 'node:assert/strict';
import test from 'node:test';

import { TaskRecovery, TaskRecoveryError, view } from '../src/task-recovery.js';

test('失败详情只向本机主人提供固定恢复动作和稳定核验视图', () => {
  const tasks = eligibleTasks();
  assert.deepEqual(view(tasks[0], { audience:'local-owner', relatedTasks:tasks }), {
    actions:[
      {
        actionKey:'use_confirmed_transcript_only',
        label:'仅用确认稿继续',
        emphasis:'primary',
        confirmation:'将关闭视觉分析，只使用已核验确认稿创建原 Paperclip 任务的子任务；不会重新抓取素材或调用视觉 Provider。',
      },
      {
        actionKey:'request_read_only_diagnosis',
        label:'只读诊断',
        emphasis:'secondary',
        confirmation:'只在原 Paperclip Issue 下创建诊断子任务；不修改代码、不重跑任务、不扩权。',
      },
    ],
    verification:null,
  });
  assert.deepEqual(view(tasks[0], { audience:'lan', relatedTasks:tasks }), { actions:[], verification:null });
});

test('仅用确认稿恢复会复核条件并创建原 Paperclip Issue 的文本子任务', async () => {
  const tasks = eligibleTasks();
  const store = memoryStore(tasks);
  const created = [];
  const recovery = new TaskRecovery({
    store,
    async createTask(input) {
      created.push(input);
      return { taskId:'retry-child', ...input };
    },
  });
  const input = {
    actionKey:'use_confirmed_transcript_only',
    requestId:'recovery-request-0001',
    expectedUpdatedAt:tasks[0].updatedAt,
  };
  const first = await recovery.request(tasks[0].taskId, input, { ref:'A君' });
  const duplicate = await recovery.request(tasks[0].taskId, input, { ref:'A君' });
  const duplicateWithNewTransportKey = await recovery.request(tasks[0].taskId, {
    ...input,
    requestId:'recovery-request-0009',
  }, { ref:'A君' });

  assert.equal(first.status, 'accepted');
  assert.equal(duplicate.status, 'existing');
  assert.equal(duplicateWithNewTransportKey.status, 'existing');
  assert.equal(created.length, 1);
  assert.equal(created[0].visualMode, 'off');
  assert.equal(created[0].context.parentPaperclipIssueId, 'paperclip-issue-original');
  assert.equal(created[0].context.confirmedTranscriptTaskId, 'transcript-task');
  assert.equal(created[0].idempotencyKey, `recovery-confirmed-transcript:${tasks[0].taskId}`);
  const stored = await store.getTask(tasks[0].taskId);
  assert.equal(stored.recovery.coordination.status, 'retrying');
  assert.deepEqual(stored.recovery.events.map((event) => event.event), ['requested', 'child_created']);
});

test('恢复请求要求 expectedUpdatedAt 并只将本机失败交给安全恢复协调器', async () => {
  const tasks = localFailureTasks();
  const store = memoryStore(tasks);
  const calls = [];
  const recovery = new TaskRecovery({ store, async recover(task, input) { calls.push([task.taskId, input.actionKey]); return { status:'diagnosed' }; } });

  await assert.rejects(
    recovery.request(tasks[0].taskId, {
      actionKey:'request_safe_recovery',
      requestId:'recovery-request-0002',
      expectedUpdatedAt:'stale-value',
    }),
    (error) => error instanceof TaskRecoveryError && error.code === 'task_recovery_stale' && error.httpStatus === 409,
  );
  await recovery.request(tasks[0].taskId, {
    actionKey:'request_safe_recovery',
    requestId:'recovery-request-0003',
    expectedUpdatedAt:tasks[0].updatedAt,
  });
  assert.deepEqual(calls, [[tasks[0].taskId, 'request_safe_recovery']]);
});

test('只读诊断创建原 Paperclip Issue 子任务，并显式禁止重试、写代码和扩权', async () => {
  const tasks = eligibleTasks();
  const store = memoryStore(tasks);
  const created = [];
  const recovery = new TaskRecovery({
    store,
    async createTask(input) { created.push(input); return { taskId:'diagnosis-child', ...input }; },
  });
  const result = await recovery.request(tasks[0].taskId, {
    actionKey:'request_read_only_diagnosis',
    requestId:'recovery-request-0005',
    expectedUpdatedAt:tasks[0].updatedAt,
  }, { ref:'A君' });
  assert.equal(result.status, 'accepted');
  assert.equal(created[0].context.parentPaperclipIssueId, 'paperclip-issue-original');
  assert.equal(created[0].context.diagnosisOnly, true);
  assert.deepEqual(created[0].context.prohibitedActions, ['retry', 'code_write', 'permission_expansion', 'external_publish']);
  assert.equal(created[0].idempotencyKey, `recovery-read-only-diagnosis:${tasks[0].taskId}`);
  assert.deepEqual((await recovery.view(tasks[0].taskId, { audience:'local-owner' })).actions, []);
});

test('Paperclip Hermes 失败请求本机安全恢复时只返回 requires_external', async () => {
  const tasks = eligibleTasks();
  const recovery = new TaskRecovery({ store:memoryStore(tasks) });
  const result = await recovery.request(tasks[0].taskId, {
    actionKey:'request_safe_recovery',
    requestId:'recovery-request-0010',
    expectedUpdatedAt:tasks[0].updatedAt,
  });
  assert.equal(result.status, 'requires_external');
  assert.equal(result.actionKey, 'request_safe_recovery');
});

function eligibleTasks() {
  return [
    {
      taskId:'11111111-1111-4111-a111-111111111111',
      taskType:'content.video-benchmark-analysis',
      status:'failed',
      updatedAt:'2026-08-08T08:00:00.000Z',
      assigneeAgentId:'video-content-analyst',
      requester:{ kind:'local-owner', ref:'A君' },
      source:{ channel:'feishu', chatRef:'chat-1' },
      execution:{ owner:'paperclip-hermes' },
      governance:{ paperclipIssueId:'paperclip-issue-original' },
      input:{
        title:'拆解公开视频',
        sourceUrl:'https://example.com/video',
        visualMode:'required',
        context:{ sourceTaskIds:['transcript-task'] },
      },
      error:{ code:'provider_http_402', retryable:false },
    },
    {
      taskId:'transcript-task',
      status:'succeeded',
      artifactRefs:[{
        artifactId:'confirmed-transcript-1',
        type:'confirmed_transcript',
        data:{ confirmationMode:'human' },
        validation:{ exists:true, readable:true, nonEmpty:true },
      }],
    },
  ];
}

function localFailureTasks() {
  return [{
    taskId:'22222222-2222-4222-a222-222222222222',
    taskType:'media.transcribe-and-refine',
    status:'failed',
    updatedAt:'2026-08-08T08:00:00.000Z',
    assigneeAgentId:'xiaod',
    execution:{ owner:'ajun-local' },
    input:{ title:'整理公开视频', sourceUrl:'https://example.com/video' },
    error:{ code:'xiaod_job_failed', retryable:true },
  }];
}

function memoryStore(initial) {
  let tasks = structuredClone(initial);
  let revision = 0;
  return {
    async list() { return structuredClone(tasks); },
    async getTask(taskId) { return structuredClone(tasks.find((task) => task.taskId === taskId) || null); },
    async updateTask(taskId, patch) {
      const index = tasks.findIndex((task) => task.taskId === taskId);
      tasks[index] = { ...tasks[index], ...structuredClone(patch), updatedAt:`2026-08-08T08:00:0${++revision}.000Z` };
      return structuredClone(tasks[index]);
    },
  };
}

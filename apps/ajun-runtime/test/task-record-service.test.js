import test from 'node:test';
import assert from 'node:assert/strict';

import { TaskRecordService } from '../src/task-record-service.ts';

const task = {
  taskId:'11111111-1111-4111-8111-111111111111',
  status:'succeeded',
  taskType:'office.presentation-package',
  assigneeAgentId:'office-assistant',
  input:{ title:'整理汇报', description:'列表不需要返回的长任务正文', context:{ token:'不能返回' } },
  routing:{ internalQueue:'不能返回' },
  source:{ chatRef:'不能返回' },
  governance:{ paperclipIssueId:'不能返回' },
  recovery:{ attempt:2, events:[{ payload:'不能返回' }] },
  error:{ code:'executor_failed', message:'内部堆栈不能返回', userMessage:'请检查输入。', retryable:false },
  artifactRefs:[{
    artifactId:'report-1',
    type:'report',
    title:'任务报告',
    location:'/private/raw/report.json',
    validation:{ exists:true, readable:true, internalReason:'不能返回' },
    data:{ body:'列表不需要返回的大体积产物' },
  }],
  recordView:'completed',
  currentStage:'completed',
  createdAt:'2026-08-07T10:00:00.000Z',
  updatedAt:'2026-08-07T10:10:00.000Z',
};

test('任务记录列表只返回行摘要，完整正文和产物按选中详情读取', async () => {
  const service = new TaskRecordService({
    store:{
      queryTasks:async () => ({ items:[task], total:1, counts:{ needs_action:0, active:0, completed:1, all:1 } }),
      getTask:async () => task,
      listApprovals:async () => [],
    },
  });

  const page = await service.list({ view:'completed' });
  assert.equal(page.items[0].recordSummary, true);
  assert.equal(page.items[0].input.title, '整理汇报');
  assert.equal(Object.hasOwn(page.items[0].input, 'description'), false);
  assert.equal(Object.hasOwn(page.items[0], 'artifactRefs'), false);

  const detail = await service.detail(task.taskId, { audience:'lan' });
  assert.equal(detail.title, '整理汇报');
  assert.deepEqual(detail.artifactRefs, [{
    artifactId:'report-1',
    type:'report',
    title:'任务报告',
    mimeType:null,
    accessScope:null,
    createdAt:null,
    validation:{ exists:true, readable:true },
  }]);
  for (const hidden of ['input', 'routing', 'source', 'governance', 'recovery', 'error']) {
    assert.equal(Object.hasOwn(detail, hidden), false, `LAN 不应返回 ${hidden}`);
  }
  assert.equal(Object.hasOwn(detail.artifactRefs[0], 'data'), false);
  assert.equal(Object.hasOwn(detail.artifactRefs[0], 'location'), false);
});

test('失败记录列表和详情共享稳定 attention 契约而不暴露列表原始产物', async () => {
  const recoveryCalls = [];
  const failed = {
    ...task,
    status:'failed',
    currentStage:'paperclip_hermes_failed',
    recordView:'needs_action',
    governance:{ completionSync:{ runId:'run-current' } },
    routing:{ provider:'internal-secret' },
    source:{ chatRef:'private-chat' },
    recovery:{
      rootTaskId:'root-1',
      attempt:3,
      mode:'safe_retry',
      coordination:{ status:'ready', reason:'可在恢复前再次核验。' },
      events:[{ payload:'raw-event-must-not-leak' }],
    },
    artifactRefs:[{
      type:'employee_role_report',
      data:{
        paperclipRunId:'run-current',
        summary:'审核证据不完整，本轮无法形成结论。',
        evidence:'缺少两项来源回读。',
        remainingRisks:'直接采用可能导致错误判断。',
      },
    }],
    error:{
      code:'paperclip_hermes_reported_failure',
      userMessage:'员工已如实回报任务失败，请查看结果摘要和剩余风险。',
      retryable:false,
    },
  };
  const service = new TaskRecordService({
    store:{
      queryTasks:async () => ({ items:[failed], total:1, counts:{ needs_action:1, active:0, completed:0, all:1 } }),
      getTask:async () => failed,
      listApprovals:async () => [],
    },
    taskRecovery:{
      async view(taskRecord, options) {
        recoveryCalls.push({ taskId:taskRecord.taskId, ...options });
        return {
          actions:options.audience === 'local-owner'
            ? [{ actionKey:'retry', label:'重新尝试', emphasis:'primary', confirmation:'确认依赖已恢复。', internal:'不能返回' }]
            : [],
          verification:{ state:'pending', taskId:'verify-1', detailPath:'/tasks/verify-1', internal:'不能返回' },
        };
      },
    },
  });

  const page = await service.list({ view:'needs_action' });
  assert.equal(Object.hasOwn(page.items[0], 'artifactRefs'), false);
  assert.equal(page.items[0].presentation.attention.kind, 'failed');
  assert.equal(page.items[0].presentation.attention.cause, '审核证据不完整，本轮无法形成结论。');
  assert.equal(page.items[0].presentation.attention.remainingRisks, '直接采用可能导致错误判断。');
  assert.deepEqual(page.items[0].presentation.attention.actions, []);
  assert.deepEqual(recoveryCalls, []);

  const detail = await service.detail(failed.taskId, { audience:'local-owner' });
  assert.equal(detail.artifactRefs[0].type, 'employee_role_report');
  assert.equal(Object.hasOwn(detail.artifactRefs[0], 'data'), false);
  assert.deepEqual(detail.presentation.attention.actions, [{
    actionKey:'retry',
    label:'重新尝试',
    emphasis:'primary',
    confirmation:'确认依赖已恢复。',
  }]);
  assert.deepEqual(detail.presentation.attention.verification, {
    state:'pending',
    taskId:'verify-1',
    detailPath:'/tasks/verify-1',
  });
  assert.equal(detail.input.title, '整理汇报');
  assert.equal(Object.hasOwn(detail.input, 'context'), false);
  assert.equal(Object.hasOwn(detail, 'routing'), false);
  assert.equal(Object.hasOwn(detail, 'source'), false);
  assert.equal(Object.hasOwn(detail, 'governance'), false);
  assert.equal(Object.hasOwn(detail.recovery, 'events'), false);
  assert.equal(Object.hasOwn(detail.error, 'message'), false);

  const lanDetail = await service.detail(failed.taskId, { audience:'lan' });
  assert.deepEqual(lanDetail.presentation.attention.actions, []);
  for (const ownerOnly of ['taskType', 'assigneeAgentId', 'currentStage', 'recordView', 'input', 'error', 'recovery']) {
    assert.equal(Object.hasOwn(lanDetail, ownerOnly), false, `LAN 不应返回 ${ownerOnly}`);
  }
  assert.deepEqual(recoveryCalls, [
    { taskId:failed.taskId, audience:'local-owner' },
    { taskId:failed.taskId, audience:'lan' },
  ]);
});

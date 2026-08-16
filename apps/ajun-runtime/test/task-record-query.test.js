import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeTaskRecordCursor,
  isRoutineHealthTask,
  isInternalDiagnosticTask,
  queryTaskRecordsInMemory,
  taskRecordView,
  taskRecordViewForTask,
} from '../src/task-record-query.ts';

const tasks = [
  task('needs-input', 'needs_input', '2026-08-07T10:00:00.000Z', { title:'补充演示材料', agentId:'office-assistant' }),
  task('active', 'running', '2026-08-07T09:00:00.000Z', { title:'生成演示稿', agentId:'office-assistant' }),
  task('done', 'succeeded', '2026-08-07T08:00:00.000Z', { title:'公开资料整理', agentId:'intel-researcher' }),
  task('routine', 'succeeded', '2026-08-07T07:00:00.000Z', { title:'A君定时本机巡检', taskType:'operations.health-review', channel:'paperclip' }),
  task('failed-routine', 'failed', '2026-08-07T06:00:00.000Z', { title:'A君定时本机巡检', taskType:'operations.health-review', channel:'paperclip' }),
  {
    ...task('diagnosis', 'succeeded', '2026-08-07T05:00:00.000Z', { title:'只读诊断：补充演示材料', taskType:'operations.failure-recovery', channel:'internal-recovery' }),
    recovery:{ mode:'read_only_diagnosis' },
    input:{ title:'只读诊断：补充演示材料', context:{ diagnosisOnly:true } },
  },
  {
    ...task('diagnosis-review', 'failed', '2026-08-07T04:00:00.000Z', { title:'交付质量复核：只读诊断', taskType:'governance.assurance-review', channel:'ajun-runtime' }),
    parentTaskId:'diagnosis',
  },
];

test('任务记录按用户意图分组，并只把正常例行巡检收进摘要', () => {
  assert.equal(taskRecordView('needs_input'), 'needs_action');
  assert.equal(taskRecordView('running'), 'active');
  assert.equal(taskRecordView('succeeded'), 'completed');
  assert.equal(taskRecordViewForTask({ status:'blocked' }), 'needs_action');
  assert.equal(isRoutineHealthTask(tasks[3]), true);
  assert.equal(isInternalDiagnosticTask(tasks[5], tasks), true);
  assert.equal(isInternalDiagnosticTask(tasks[6], tasks), true);

  const page = queryTaskRecordsInMemory(tasks, { view:'all' });
  assert.deepEqual(page.items.map((item) => item.taskId), ['needs-input', 'active', 'done']);
  assert.deepEqual(page.counts, { needs_action:1, active:1, completed:1, all:3 });
  assert.equal(page.routineSummary.hidden, 2);
  assert.equal(page.routineSummary.attention, 1);
  assert.equal(page.items.some((item) => item.taskId.startsWith('diagnosis')), false);
});

test('任务记录支持多词搜索、员工筛选和稳定游标分页', () => {
  const searched = queryTaskRecordsInMemory(tasks, { view:'all', q:'演示 office-assistant' });
  assert.deepEqual(searched.items.map((item) => item.taskId), ['needs-input', 'active']);

  const first = queryTaskRecordsInMemory(tasks, { view:'all', includeRoutine:true, limit:2 });
  assert.equal(first.items.length, 2);
  assert.ok(first.nextCursor);
  assert.deepEqual(decodeTaskRecordCursor(first.nextCursor), {
    updatedAt:'2026-08-07T09:00:00.000Z',
    taskId:'active',
  });
  const second = queryTaskRecordsInMemory(tasks, { view:'all', includeRoutine:true, limit:2, cursor:first.nextCursor });
  assert.deepEqual(second.items.map((item) => item.taskId), ['done', 'routine']);
});

test('批准后没有进入规划的多人任务归入需要处理', () => {
  const stalled = {
    ...task('approved-mission', 'queued', '2026-08-07T11:00:00.000Z', { title:'拆解爆款', agentId:'ajun', taskType:'army.cross-agent-mission' }),
    currentStage:'approval_approved',
    artifactRefs:[],
  };
  assert.equal(taskRecordViewForTask(stalled), 'needs_action');
  assert.equal(taskRecordViewForTask({ ...stalled, artifactRefs:[{ type:'cross_agent_mission_plan' }] }), 'active');
  assert.equal(taskRecordViewForTask({ ...stalled, currentStage:'queued' }), 'active');
});

test('爆款雷达发起的失败任务仍归入需要处理，不会被静默归档', () => {
  const failed = task('boom-failed', 'failed', '2026-08-16T04:41:42.355Z', {
    title:'获取并整理：晕肉了',
    agentId:'xiaod',
    taskType:'media.transcribe-and-refine',
    channel:'boom-monitor',
  });
  assert.equal(taskRecordViewForTask(failed, [failed]), 'needs_action');
});

function task(taskId, status, updatedAt, { title, agentId = 'ops', taskType = 'army.intake', channel = 'feishu' }) {
  return {
    taskId,
    status,
    taskType,
    assigneeAgentId:agentId,
    input:{ title },
    source:{ channel },
    createdAt:updatedAt,
    updatedAt,
  };
}

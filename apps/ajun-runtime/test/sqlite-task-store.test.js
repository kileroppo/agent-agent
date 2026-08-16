import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { SQLiteTaskStore } from '../src/sqlite-task-store.ts';

const executeFile = promisify(execFile);

test('SQLite Store 完整承接任务、审批、草案、测试实例和会话上下文', async () => {
  await withStore(async ({ store, filePath }) => {
    const task = await store.createTask({ idempotencyKey:'message:1', taskType:'army.intake', status:'queued', input:{ title:'测试任务' } });
    assert.equal((await store.createTask({ idempotencyKey:'message:1', taskType:'ignored' })).taskId, task.taskId);
    await store.updateTask(task.taskId, { status:'waiting_worker' });

    const approval = await store.createApproval({ taskId:task.taskId, reason:'需要审核' });
    assert.equal((await store.list())[0].status, 'waiting_approval');
    assert.deepEqual((await store.list())[0].approvalRefs, [approval.approvalId]);
    assert.equal((await store.updateApproval(approval.approvalId, {
      status:'approved',
      decisionBy:'A君',
      decisionReason:'测试夹具确认通过',
      decidedAt:'2026-08-02T00:00:00.000Z',
    })).status, 'approved');

    const proposal = await store.createProposal({ sourceEventRef:'event:1', title:'候选岗位' });
    assert.equal((await store.createProposal({ sourceEventRef:'event:1' })).proposalId, proposal.proposalId);
    assert.equal((await store.updateProposal(proposal.proposalId, { status:'approved' })).status, 'approved');

    const instance = await store.createTestInstance({ proposalId:proposal.proposalId, status:'running' });
    assert.equal((await store.updateTestInstance(instance.testInstanceId, { status:'stopped' })).status, 'stopped');
    assert.equal((await store.listApprovals()).length, 1);
    assert.equal((await store.listProposals()).length, 1);
    assert.equal((await store.listTestInstances()).length, 1);

    await store.setConversationContext(' chat-1 ', { kind:'usage_report', taskIds:[task.taskId] });
    assert.equal((await store.getConversationContext('chat-1')).kind, 'usage_report');
    assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
    for (const sidecar of [`${filePath}-wal`, `${filePath}-shm`]) assert.equal((await fs.stat(sidecar)).mode & 0o777, 0o600);
  });
});

test('SQLite Store 用事务串行抢占 Mac worker 租约并校验续租身份', async () => {
  await withStore(async ({ store }) => {
    const first = await store.createTask({ taskType:'army.media', status:'waiting_worker' });
    await store.createTask({ taskType:'army.media', status:'waiting_worker' });
    const claims = await Promise.all([
      store.claimWorkerTask({ workerId:'worker-a', taskTypes:['army.media'], now:1_000, leaseMs:500 }),
      store.claimWorkerTask({ workerId:'worker-b', taskTypes:['army.media'], now:1_000, leaseMs:500 })
    ]);
    assert.equal(new Set(claims.map((task) => task.taskId)).size, 2);
    const claimed = claims.find((task) => task.taskId === first.taskId);
    await assert.rejects(() => store.updateWorkerTask(first.taskId, { workerId:'other', leaseId:claimed.execution.worker.leaseId, patch:{} }), (error) => error.code === 'worker_lease_mismatch');
    const updated = await store.updateWorkerTask(first.taskId, { workerId:claimed.execution.worker.workerId, leaseId:claimed.execution.worker.leaseId, patch:{ currentStage:'processing' }, extendLease:true, now:1_100, leaseMs:500 });
    assert.equal(updated.currentStage, 'processing');
    assert.equal(updated.execution.worker.state, 'working');
    assert.equal(updated.execution.worker.leaseExpiresAt, new Date(1_600).toISOString());
  });
});

test('SQLite Store 在服务端完成任务筛选、计数、例行降噪和游标分页', async () => {
  await withStore(async ({ store }) => {
    const snapshot = {
      tasks:[
        fixtureTask('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'needs_input', '2026-08-07T10:00:00.000Z', '补充演示材料', 'office-assistant'),
        fixtureTask('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'running', '2026-08-07T09:00:00.000Z', '生成演示稿', 'office-assistant'),
        fixtureTask('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'succeeded', '2026-08-07T08:00:00.000Z', '公开资料整理', 'intel-researcher'),
        fixtureTask('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'succeeded', '2026-08-07T07:00:00.000Z', 'A君定时本机巡检', 'operations', true),
        fixtureTask('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'failed', '2026-08-07T06:00:00.000Z', 'A君定时本机巡检', 'operations', true),
        {
          ...fixtureTask('ffffffff-ffff-4fff-8fff-ffffffffffff', 'succeeded', '2026-08-07T05:00:00.000Z', '只读诊断：补充演示材料', 'operations'),
          taskType:'operations.failure-recovery',
          source:{ channel:'internal-recovery' },
          recovery:{ mode:'read_only_diagnosis' },
          input:{ title:'只读诊断：补充演示材料', context:{ diagnosisOnly:true } },
        },
        {
          ...fixtureTask('99999999-9999-4999-8999-999999999999', 'failed', '2026-08-07T04:00:00.000Z', '交付质量复核：只读诊断', 'reviewer'),
          taskType:'governance.assurance-review',
          parentTaskId:'ffffffff-ffff-4fff-8fff-ffffffffffff',
          source:{ channel:'ajun-runtime' },
        },
      ],
      approvals:[], proposals:[], testInstances:[], conversationContexts:{},
    };
    await store.importSnapshot(snapshot, { sourceDigest:'task-query-fixture' });

    const first = await store.queryTasks({ view:'all', limit:2 });
    assert.deepEqual(first.counts, { needs_action:1, active:1, completed:1, all:3 });
    assert.deepEqual(first.items.map((item) => item.taskId), snapshot.tasks.slice(0, 2).map((item) => item.taskId));
    assert.equal(first.routineSummary.hidden, 2);
    assert.equal(first.routineSummary.attention, 1);
    assert.equal(first.counts.all, 3);
    assert.ok(first.nextCursor);

    const next = await store.queryTasks({ view:'all', limit:2, cursor:first.nextCursor });
    assert.deepEqual(next.items.map((item) => item.taskId), [snapshot.tasks[2].taskId]);
    assert.equal((await store.getTask(snapshot.tasks[1].taskId)).input.title, '生成演示稿');

    const searched = await store.queryTasks({ view:'all', q:'演示', agentId:'office-assistant' });
    assert.deepEqual(searched.items.map((item) => item.taskId), snapshot.tasks.slice(0, 2).map((item) => item.taskId));
  });
});

test('SQLite 查询把批准后未规划的多人任务放入需要处理', async () => {
  await withStore(async ({ store }) => {
    const mission = await store.createTask({
      idempotencyKey:'approved-mission-stalled',
      taskType:'army.cross-agent-mission',
      status:'queued',
      currentStage:'approval_approved',
      input:{ title:'爆款候选拆解' },
      artifactRefs:[],
    });
    const page = await store.queryTasks({ view:'needs_action' });
    assert.deepEqual(page.items.map((item) => item.taskId), [mission.taskId]);
    assert.equal(page.items[0].recordView, 'needs_action');

    await store.updateTask(mission.taskId, { artifactRefs:[{ type:'cross_agent_mission_plan' }] });
    assert.equal((await store.queryTasks({ view:'needs_action' })).items.length, 0);
    assert.deepEqual((await store.queryTasks({ view:'active' })).items.map((item) => item.taskId), [mission.taskId]);
  });
});

test('SQLite 查询不会把爆款雷达失败静默归档', async () => {
  await withStore(async ({ store }) => {
    const created = await store.createTask({
      taskType:'media.transcribe-and-refine',
      status:'queued',
      source:{ channel:'army-mission', originChannel:'boom-monitor' },
      input:{ title:'获取并整理：晕肉了' },
    });
    const failed = await store.updateTask(created.taskId, { status:'failed', currentStage:'paperclip_hermes_failed' });
    const page = await store.queryTasks({ view:'needs_action', q:'晕肉了', includeRoutine:true });
    assert.deepEqual(page.items.map((item) => item.taskId), [failed.taskId]);
    assert.equal(page.items[0].recordView, 'needs_action');
  });
});

test('JSON 快照导入校验数量和关键 ID；相同源幂等，其他非空源拒绝覆盖', async () => {
  await withStore(async ({ store }) => {
    const snapshot = fixtureSnapshot();
    const first = await store.importSnapshot(snapshot, { sourceDigest:'fixture-a' });
    assert.equal(first.status, 'imported');
    assert.deepEqual(first.before, { tasks:0, approvals:0, proposals:0, testInstances:0, conversationContexts:0 });
    assert.deepEqual(first.after, { tasks:1, approvals:1, proposals:1, testInstances:1, conversationContexts:1 });
    assert.equal(Object.values(first.idChecks).every((digest) => /^[a-f0-9]{64}$/.test(digest)), true);
    assert.equal((await store.importSnapshot(snapshot, { sourceDigest:'fixture-a' })).status, 'already_imported');
    await assert.rejects(() => store.importSnapshot(fixtureSnapshot(), { sourceDigest:'fixture-b' }), (error) => error.code === 'sqlite_target_not_empty');
  });
});

test('迁移 CLI 只使用指定 fixture，创建 0600 备份并输出校验与回滚命令', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-sqlite-migrate-'));
  const source = path.join(directory, 'fixture.json');
  const target = path.join(directory, 'runtime.sqlite');
  try {
    await fs.writeFile(source, `${JSON.stringify(fixtureSnapshot(), null, 2)}\n`, { mode:0o600 });
    const script = fileURLToPath(new URL('../scripts/migrate-task-store-to-sqlite.mjs', import.meta.url));
    const first = await executeFile(process.execPath, [script, '--source', source, '--target', target], { env:{ ...process.env, NODE_NO_WARNINGS:'1' } });
    assert.match(first.stdout, /迁移状态: 已导入/);
    assert.match(first.stdout, /导入前数量: tasks=0/);
    assert.match(first.stdout, /导入后数量: tasks=1/);
    assert.match(first.stdout, /关键 ID 校验: 通过/);
    assert.match(first.stdout, /回滚命令/);
    const backup = (await fs.readdir(directory)).find((entry) => entry.endsWith('.pre-sqlite.bak'));
    assert.ok(backup);
    assert.equal((await fs.stat(path.join(directory, backup))).mode & 0o777, 0o600);
    const second = await executeFile(process.execPath, [script, '--source', source, '--target', target], { env:{ ...process.env, NODE_NO_WARNINGS:'1' } });
    assert.match(second.stdout, /相同源已导入/);
  } finally { await fs.rm(directory, { recursive:true, force:true }); }
});

async function withStore(operation) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-sqlite-store-'));
  const filePath = path.join(directory, 'runtime.sqlite');
  const store = new SQLiteTaskStore(filePath);
  try { await operation({ store, filePath, directory }); }
  finally { store.close(); await fs.rm(directory, { recursive:true, force:true }); }
}

function fixtureSnapshot() {
  return {
    tasks:[{ schemaVersion:'agent.army/task/v1', taskId:'task-fixture', taskType:'army.intake', status:'succeeded', approvalRefs:['approval-fixture'], artifactRefs:[], createdAt:'2026-01-01T00:00:00.000Z', updatedAt:'2026-01-01T01:00:00.000Z' }],
    approvals:[{ schemaVersion:'agent.army/approval/v1', approvalId:'approval-fixture', taskId:'task-fixture', status:'approved', createdAt:'2026-01-01T00:30:00.000Z' }],
    proposals:[{ schemaVersion:'agent.army/proposal/v1', proposalId:'proposal-fixture', status:'approved', createdAt:'2026-01-01T00:00:00.000Z', updatedAt:'2026-01-01T01:00:00.000Z' }],
    testInstances:[{ schemaVersion:'agent.army/test-instance/v1', testInstanceId:'test-fixture', proposalId:'proposal-fixture', status:'stopped', createdAt:'2026-01-01T00:00:00.000Z', updatedAt:'2026-01-01T01:00:00.000Z' }],
    conversationContexts:{ 'chat-fixture':{ schemaVersion:'agent.army/conversation-context/v1', kind:'usage_report', updatedAt:'2026-01-01T01:00:00.000Z' } }
  };
}

function fixtureTask(taskId, status, updatedAt, title, assigneeAgentId, routine = false) {
  return {
    schemaVersion:'agent.army/task/v1',
    taskId,
    taskType:routine ? 'operations.health-review' : 'office.presentation-package',
    status,
    assigneeAgentId,
    input:{ title, ...(routine ? { description:'agent-army:operations-health-v1' } : {}) },
    source:{ channel:routine ? 'paperclip' : 'feishu' },
    approvalRefs:[], artifactRefs:[], createdAt:updatedAt, updatedAt,
  };
}

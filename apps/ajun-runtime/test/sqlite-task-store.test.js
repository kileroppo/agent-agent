import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { SQLiteTaskStore } from '../src/sqlite-task-store.js';

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

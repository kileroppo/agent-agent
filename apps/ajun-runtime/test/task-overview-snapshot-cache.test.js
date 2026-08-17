import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SQLiteTaskStore } from '../src/sqlite-task-store.ts';
import { TaskOverviewSnapshotCache } from '../src/task-overview-snapshot-cache.ts';

test('任务派生快照在账本未变更时复用，Store mutation 通知会立即失效', async () => {
  let taskReads = 0;
  let approvalReads = 0;
  let proposalReads = 0;
  let acceptanceReads = 0;
  let notify = null;
  const task = {
    taskId:'historic-failure', taskType:'research.intel-report', status:'failed',
    updatedAt:'2026-08-17T00:00:00.000Z', createdAt:'2026-08-17T00:00:00.000Z',
    input:{ title:'待复验任务' }, source:{ channel:'feishu', targetAgentId:'operator' }, artifactRefs:[],
  };
  const cache = new TaskOverviewSnapshotCache({
    store:{
      list:async () => { taskReads += 1; return [task]; },
      listApprovals:async () => { approvalReads += 1; return []; },
      listProposals:async () => { proposalReads += 1; return []; },
      listWorkflowAcceptances:async () => { acceptanceReads += 1; return []; },
      subscribe:(listener) => { notify = listener; return () => {}; },
    },
    capabilityCatalog:{ openTaskDelegates:() => ({}) },
  });

  const first = await cache.read({ includeValidationCampaign:false, cache:true });
  const second = await cache.read({ includeValidationCampaign:false, cache:true });
  assert.equal(first.taskValidation.taskFocus.unresolvedFailures, 1);
  assert.equal(second.taskValidation.taskFocus.unresolvedFailures, 1);
  assert.deepEqual({ taskReads, approvalReads, proposalReads, acceptanceReads }, {
    taskReads:1, approvalReads:1, proposalReads:1, acceptanceReads:1,
  });

  notify({ kind:'mutation' });
  await cache.read({ includeValidationCampaign:false, cache:true });
  assert.deepEqual({ taskReads, approvalReads, proposalReads, acceptanceReads }, {
    taskReads:2, approvalReads:2, proposalReads:2, acceptanceReads:2,
  });
});

test('SQLite 跨 Store 实例写入用 data_version 失效任务快照，不重扫未变更账本', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-overview-cache-'));
  const filePath = path.join(directory, 'runtime.sqlite');
  const store = new SQLiteTaskStore(filePath);
  const externalStore = new SQLiteTaskStore(filePath);
  try {
    let taskReads = 0;
    const list = store.list.bind(store);
    store.list = async () => { taskReads += 1; return list(); };
    const cache = new TaskOverviewSnapshotCache({
      store,
      capabilityCatalog:{ openTaskDelegates:() => ({}) },
    });

    await cache.read({ includeValidationCampaign:false, cache:true });
    await cache.read({ includeValidationCampaign:false, cache:true });
    assert.equal(taskReads, 1);

    await externalStore.createTask({ taskType:'research.intel-report', status:'queued', input:{ title:'外部写入' } });
    const refreshed = await cache.read({ includeValidationCampaign:false, cache:true });
    assert.equal(taskReads, 2);
    assert.equal(refreshed.tasks[0].input.title, '外部写入');
  }
  finally {
    store.close();
    externalStore.close();
    await fs.rm(directory, { recursive:true, force:true });
  }
});

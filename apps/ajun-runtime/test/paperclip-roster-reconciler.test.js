import assert from 'node:assert/strict';
import test from 'node:test';
import { PaperclipRosterReconciler } from '../src/paperclip-roster-reconciler.ts';

test('岗位登记暂时失败后会在下一轮重新读取全员清单', async () => {
  let reads = 0;
  let attempts = 0;
  const options = [];
  const results = [];
  const reconciler = new PaperclipRosterReconciler({
    registry:{ async list(value) { reads += 1; options.push(value); return [{ agentId:'公开资料报告员', status:'active' }]; } },
    governance:{ async syncRoster() { attempts += 1; return attempts === 1 ? { status:'sync_pending' } : { status:'synced' }; } },
    onResult:(result) => results.push(result.status)
  });
  assert.equal((await reconciler.reconcile()).status, 'sync_pending');
  assert.equal((await reconciler.reconcile()).status, 'synced');
  assert.equal(reads, 2);
  assert.deepEqual(options, [{ includeManagers:true }, { includeManagers:true }]);
  assert.deepEqual(results, ['sync_pending', 'synced']);
});

test('岗位清单暂时读不到时不抛错，保留待补同步状态', async () => {
  const reconciler = new PaperclipRosterReconciler({
    registry:{ async list() { throw new Error('temporary unavailable'); } },
    governance:{ async syncRoster() { throw new Error('should not run'); } }
  });
  const result = await reconciler.reconcile();
  assert.equal(result.status, 'sync_pending');
  assert.equal(result.reason, '岗位清单暂时无法补同步。');
});

test('岗位清单没有变化时不重复同步，也不重复上报同一结果', async () => {
  let syncs = 0;
  const reported = [];
  const reconciler = new PaperclipRosterReconciler({
    registry:{ async list() { return [{ status:'active', agentId:'writer' }]; } },
    governance:{ async syncRoster() { syncs += 1; return { status:'synced' }; } },
    onResult:(result) => reported.push(result.status),
  });

  assert.equal((await reconciler.reconcile()).status, 'synced');
  assert.equal((await reconciler.reconcile()).status, 'unchanged');
  assert.equal((await reconciler.reconcile()).status, 'unchanged');
  assert.equal(syncs, 1);
  assert.deepEqual(reported, ['synced', 'unchanged']);
});

test('岗位同步失败会指数退避且同一错误不反复上报', async () => {
  const delays = [];
  const reported = [];
  const reconciler = new PaperclipRosterReconciler({
    registry:{ async list() { return [{ agentId:'writer' }]; } },
    governance:{ async syncRoster() { return { status:'sync_pending', reason:'Paperclip 暂不可用。' }; } },
    intervalMs:100,
    maxIntervalMs:400,
    onResult:(result) => reported.push(result.status),
    setTimer(callback, delay) { delays.push(delay); return { callback, unref() {} }; },
    clearTimer() {},
  });
  reconciler.started = true;

  await reconciler.tick();
  await reconciler.tick();
  reconciler.stop();

  assert.deepEqual(delays, [200, 400]);
  assert.deepEqual(reported, ['sync_pending']);
});

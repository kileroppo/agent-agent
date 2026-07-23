import assert from 'node:assert/strict';
import test from 'node:test';
import { PaperclipRosterReconciler } from '../src/paperclip-roster-reconciler.js';

test('岗位登记暂时失败后会在下一轮重新读取全员清单', async () => {
  let reads = 0;
  let attempts = 0;
  const results = [];
  const reconciler = new PaperclipRosterReconciler({
    registry:{ async list() { reads += 1; return [{ agentId:'公开资料报告员', status:'active' }]; } },
    governance:{ async syncRoster() { attempts += 1; return attempts === 1 ? { status:'sync_pending' } : { status:'synced' }; } },
    onResult:(result) => results.push(result.status)
  });
  assert.equal((await reconciler.reconcile()).status, 'sync_pending');
  assert.equal((await reconciler.reconcile()).status, 'synced');
  assert.equal(reads, 2);
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

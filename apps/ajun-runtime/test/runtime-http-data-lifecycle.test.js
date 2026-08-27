import assert from 'node:assert/strict';
import test from 'node:test';
import { routeDataLifecycleApi } from '../src/runtime-http-data-lifecycle.ts';

test('routeDataLifecycleApi 正确处理 GET 查询与 POST 本机触发清理', async () => {
  const fakeGovernance = {
    inspectStorageStatus: async () => ({
      inspectedAt: '2026-08-27T00:00:00.000Z',
      tasksCount: { tasks: 10 },
      eventsCount: { totalEvents: 50 },
    }),
    runFullClosedLoop: async ({ dryRun }) => ({
      status: 'reconciled',
      mode: dryRun ? 'dry-run' : 'apply',
      totalReclaimedItems: dryRun ? 5 : 5,
    }),
  };

  // 1. 非匹配路由返回 null
  assert.equal(await routeDataLifecycleApi({
    request: { method: 'GET', url: '/api/other' },
    dataLifecycleGovernance: fakeGovernance,
    local: true,
  }), null);

  // 2. GET /api/data-lifecycle
  const getRes = await routeDataLifecycleApi({
    request: { method: 'GET', url: '/api/data-lifecycle' },
    dataLifecycleGovernance: fakeGovernance,
    local: true,
  });
  assert.equal(getRes.status, 200);
  assert.equal(getRes.payload.ok, true);
  assert.equal(getRes.payload.dataLifecycle.tasksCount.tasks, 10);

  // 3. 非本机调用 POST /api/data-lifecycle/reconcile 被拒绝 (403)
  const nonLocalPost = await routeDataLifecycleApi({
    request: { method: 'POST', url: '/api/data-lifecycle/reconcile' },
    dataLifecycleGovernance: fakeGovernance,
    local: false,
  });
  assert.equal(nonLocalPost.status, 403);

  // 4. 本机调用 POST /api/data-lifecycle/reconcile?dryRun=true 成功
  const localDryRun = await routeDataLifecycleApi({
    request: { method: 'POST', url: '/api/data-lifecycle/reconcile?dryRun=true' },
    dataLifecycleGovernance: fakeGovernance,
    local: true,
  });
  assert.equal(localDryRun.status, 200);
  assert.equal(localDryRun.payload.ok, true);
  assert.equal(localDryRun.payload.result.mode, 'dry-run');

  // 5. 本机调用 POST /api/data-lifecycle/reconcile 真实 apply 成功
  const localApply = await routeDataLifecycleApi({
    request: { method: 'POST', url: '/api/data-lifecycle/reconcile' },
    dataLifecycleGovernance: fakeGovernance,
    local: true,
  });
  assert.equal(localApply.status, 200);
  assert.equal(localApply.payload.ok, true);
  assert.equal(localApply.payload.result.mode, 'apply');
});

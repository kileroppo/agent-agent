import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyOperationsHealthArchive,
  planOperationsHealthArchive,
} from '../scripts/archive-operations-health-issues.mjs';

test('巡检归档计划只选成功记录和已被连续成功取代的旧失败', async () => {
  const fixture = createFixture();
  const plan = await planOperationsHealthArchive({ fetchImpl:fixture.fetchImpl });
  assert.equal(plan.readOnly, true);
  assert.deepEqual(plan.items.map((item) => item.identifier), ['AGE-1', 'AGE-2', 'AGE-3', 'AGE-4']);
  assert.deepEqual(plan.summary, {
    visibleHealthIssues:5,
    archiveCount:4,
    completedSystemChecks:3,
    supersededFailures:1,
    retainedFailures:1,
  });
  assert.equal(fixture.mutations.length, 0);
});

test('巡检归档拒绝远程 Paperclip 和不匹配确认值', async () => {
  await assert.rejects(
    () => planOperationsHealthArchive({ apiBase:'https://paperclip.example.com' }),
    /loopback/,
  );
  const fixture = createFixture();
  await assert.rejects(
    () => applyOperationsHealthArchive({ fetchImpl:fixture.fetchImpl, confirmation:'wrong' }),
    /确认值/,
  );
  assert.equal(fixture.mutations.length, 0);
});

test('巡检归档只写 hiddenAt，返回逐条可恢复信息且不改状态', async () => {
  const fixture = createFixture();
  const plan = await planOperationsHealthArchive({ fetchImpl:fixture.fetchImpl });
  const result = await applyOperationsHealthArchive({
    fetchImpl:fixture.fetchImpl,
    confirmation:plan.requiredConfirmation,
    now:new Date('2026-08-02T12:00:00.000Z'),
  });
  assert.equal(result.appliedCount, 4);
  assert.equal(result.safety.statusChanges, 0);
  assert.equal(fixture.mutations.length, 4);
  for (const mutation of fixture.mutations) {
    assert.deepEqual(Object.keys(mutation.body), ['hiddenAt']);
    assert.equal(mutation.body.hiddenAt, '2026-08-02T12:00:00.000Z');
  }
  assert.deepEqual(result.applied[0].rollback.body, { hiddenAt:null });
});

function createFixture() {
  const companyId = '0d4ac7ac-3655-41f9-8957-2e36ef7ad751';
  const health = (id, identifier, status, hour) => ({
    id,
    identifier,
    title:'A君定时本机巡检',
    description:'agent-army:operations-health-v1\n只读检查',
    status,
    createdAt:`2026-08-01T${String(hour).padStart(2, '0')}:00:00.000Z`,
    updatedAt:`2026-08-01T${String(hour).padStart(2, '0')}:01:00.000Z`,
    hiddenAt:null,
  });
  const issues = [
    health('issue-1', 'AGE-1', 'blocked', 1),
    health('issue-2', 'AGE-2', 'done', 2),
    health('issue-3', 'AGE-3', 'done', 3),
    health('issue-4', 'AGE-4', 'done', 4),
    health('issue-5', 'AGE-5', 'blocked', 5),
    { ...health('other-1', 'AGE-6', 'done', 6), title:'真实业务任务' },
  ];
  const mutations = [];
  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    const method = options.method || 'GET';
    let payload;
    if (method === 'GET' && pathname === '/api/companies') {
      payload = [{ id:companyId, name:'Agent军团' }];
    } else if (method === 'GET' && pathname === `/api/companies/${companyId}/issues`) {
      const offset = Number(new URL(url).searchParams.get('offset') || 0);
      payload = offset === 0 ? issues : [];
    } else if (method === 'PATCH' && pathname.startsWith('/api/issues/')) {
      const body = JSON.parse(options.body);
      mutations.push({ pathname, body });
      payload = { ...issues.find((item) => pathname.endsWith(item.id)), ...body };
    } else {
      throw new Error(`unexpected ${method} ${pathname}`);
    }
    return { ok:true, status:200, async text(){ return JSON.stringify(payload); } };
  };
  return { fetchImpl, mutations };
}

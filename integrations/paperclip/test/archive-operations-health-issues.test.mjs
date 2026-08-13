import assert from 'node:assert/strict';
import test from 'node:test';

import { PaperclipHttpError } from '@agent-army/paperclip-client';

import {
  applyOperationsHealthArchive,
  planOperationsHealthArchive,
} from '../scripts/archive-operations-health-issues.mjs';
import {
  asPaperclipList,
  createPaperclipLoopbackClient,
} from '../scripts/support/paperclip-loopback-client.mjs';

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

test('共享 loopback client 禁止重定向、保留 HTTP 错误语义且只对成功响应严格解析 JSON', async () => {
  const requestOptions = [];
  const responses = [
    { ok:false, status:502, body:'{"message":"upstream failed"}' },
    { ok:false, status:503, body:'bad gateway' },
    { ok:true, status:200, body:'not json' },
  ];
  const client = createPaperclipLoopbackClient({
    apiBase:'http://127.0.0.1:3100',
    operation:'测试',
    fetchImpl:async (_url, options) => {
      requestOptions.push(options);
      const response = responses.shift();
      return {
        ok:response.ok,
        status:response.status,
        async text() { return response.body; },
      };
    },
  });

  await assert.rejects(
    client.request('GET', '/api/issues?status=blocked&limit=1'),
    (error) => {
      assert.equal(error instanceof PaperclipHttpError, true);
      assert.equal(error.code, 'paperclip_http_error');
      assert.equal(error.status, 502);
      assert.equal(error.method, 'GET');
      assert.equal(error.path, '/api/issues?status=blocked&limit=1');
      assert.equal(error.url, 'http://127.0.0.1:3100/api/issues?status=blocked&limit=1');
      assert.match(error.message, /upstream failed/);
      return true;
    },
  );
  await assert.rejects(
    client.request('GET', '/api/issues?status=blocked'),
    (error) => error instanceof PaperclipHttpError && error.status === 503,
  );
  await assert.rejects(
    client.request('GET', '/api/issues'),
    SyntaxError,
  );
  assert.equal(requestOptions.every((options) => options.redirect === 'error'), true);
  assert.deepEqual(asPaperclipList({ actions:[{ id:'not-an-issue-list' }] }), []);
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

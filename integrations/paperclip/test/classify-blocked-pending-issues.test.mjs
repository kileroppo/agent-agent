import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyHistoricalAcceptanceArchive,
  buildHistoricalAcceptanceArchivePlan,
  classifyBlockedPendingIssues,
  classifyIssue,
} from '../scripts/classify-blocked-pending-issues.mjs';

const NOW = new Date('2026-07-30T04:00:00.000Z');

function response(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async text() {
      return JSON.stringify(body);
    },
  };
}

test('把 blocked/pending issue 分成四类，并为每条给出负责人和唯一恢复动作', async () => {
  const calls = [];
  const issues = [
    {
      id: 'issue-historical',
      identifier: 'ARMY-100',
      title: '旧版验收演练',
      status: 'blocked',
      assigneeAgentId: 'agent-reviewer',
      updatedAt: '2026-07-28T00:00:00.000Z',
    },
    {
      id: 'issue-incident',
      identifier: 'ARMY-101',
      title: 'Publisher Gateway 故障恢复',
      status: 'blocked',
      assigneeAgentId: 'agent-operator',
      updatedAt: '2026-07-30T03:30:00.000Z',
      activeRecoveryAction: {
        ownerAgentId: 'agent-operator',
        status: 'active',
      },
    },
    {
      id: 'issue-decision',
      identifier: 'ARMY-102',
      title: '等待负责人审核发布权限',
      status: 'in_review',
      responsibleUserId: 'user-owner-123456789',
      updatedAt: '2026-07-30T03:00:00.000Z',
    },
    {
      id: 'issue-unresolved',
      identifier: 'ARMY-103',
      title: '补齐未知来源待办',
      status: 'todo',
      updatedAt: '2026-07-29T20:00:00.000Z',
    },
  ];

  const result = await classifyBlockedPendingIssues({
    now: NOW,
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url);
      calls.push({
        method: options.method ?? 'GET',
        path: parsed.pathname,
        search: parsed.search,
        body: options.body,
      });
      if (parsed.pathname === '/api/companies') {
        return response([{ id: 'company-1', name: 'Agent军团' }]);
      }
      if (parsed.pathname === '/api/companies/company-1/agents') {
        return response([
          { id: 'agent-reviewer', name: 'Reviewer' },
          { id: 'agent-operator', name: '运维官' },
        ]);
      }
      if (parsed.pathname === '/api/companies/company-1/issues') return response(issues);
      throw new Error(`unexpected GET ${parsed.pathname}`);
    },
  });

  assert.equal(result.mode, 'dry-run');
  assert.equal(result.readOnly, true);
  assert.equal(result.safety.writesToLivePaperclip, false);
  assert.equal(result.safety.mutationRequests, 0);
  assert.equal(result.safety.appliedActions, 0);
  assert.deepEqual(result.summary, {
    total: 4,
    possiblyTruncated: false,
    historical_acceptance: 1,
    active_incident: 1,
    decision_required: 1,
    unresolved: 1,
  });
  assert.deepEqual(
    result.items.map((item) => item.classification),
    ['historical_acceptance', 'active_incident', 'decision_required', 'unresolved'],
  );
  assert.equal(result.items[0].owner.label, 'Reviewer');
  assert.equal(result.items[1].owner.label, '运维官');
  assert.equal(result.items[2].owner.kind, 'user');
  assert.equal(result.items[3].owner.label, 'A君（待分派）');
  assert.equal(result.items.every((item) => item.recoveryAction.writesLive === false), true);
  assert.equal(result.items.every((item) => typeof item.recoveryAction.instruction === 'string'), true);
  assert.equal(calls.every((call) => call.method === 'GET' && call.body === undefined), true);
  assert.equal(calls.length, 3);
  assert.match(calls[2].search, /status=blocked%2Cin_review%2Ctodo%2Cbacklog/);
});

test('审批优先于故障，活动恢复优先于历史验收', () => {
  const decision = classifyIssue({
    id: 'decision-first',
    title: '生产故障等待决定',
    status: 'in_review',
    updatedAt: '2026-07-30T03:00:00.000Z',
    activeRecoveryAction: { ownerAgentId: 'operator' },
  }, { now: NOW });
  const incident = classifyIssue({
    id: 'incident-first',
    title: '历史验收演练故障恢复',
    status: 'blocked',
    updatedAt: '2026-07-27T03:00:00.000Z',
    activeRecoveryAction: { ownerAgentId: 'operator' },
  }, { now: NOW });

  assert.equal(decision.classification, 'decision_required');
  assert.equal(incident.classification, 'active_incident');
});

test('归档计划必须显式选中 historical_acceptance，且绑定当前快照摘要', async () => {
  const result = await classifyBlockedPendingIssues({
    now: NOW,
    fetchImpl: createArchiveFixture().fetchImpl,
  });
  const plan = buildHistoricalAcceptanceArchivePlan(result, {
    identifiers: ['ARMY-100'],
  });

  assert.equal(plan.mode, 'archive-plan');
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].identifier, 'ARMY-100');
  assert.equal(plan.items[0].expectedUpdatedAt, '2026-07-28T00:00:00.000Z');
  assert.match(plan.requiredConfirmation, /^ARCHIVE:[a-f0-9]{64}$/);
  assert.equal(plan.safety.deletesRecords, false);
  assert.throws(
    () => buildHistoricalAcceptanceArchivePlan(result, { identifiers:['ARMY-101'] }),
    /只允许归档 historical_acceptance/,
  );
  assert.throws(
    () => buildHistoricalAcceptanceArchivePlan(result, { identifiers:[] }),
    /必须显式提供/,
  );
});

test('apply 先完成全量漂移预检，再只 PATCH 明确选中的历史验收 Issue', async () => {
  const fixture = createArchiveFixture();
  const dryRun = await classifyBlockedPendingIssues({
    now: NOW,
    fetchImpl: fixture.fetchImpl,
  });
  const plan = buildHistoricalAcceptanceArchivePlan(dryRun, {
    identifiers:['ARMY-100'],
  });
  const result = await applyHistoricalAcceptanceArchive({
    now: NOW,
    identifiers:['ARMY-100'],
    confirmation:plan.requiredConfirmation,
    fetchImpl:fixture.fetchImpl,
  });

  assert.equal(result.mode, 'applied');
  assert.deepEqual(result.applied.map((item) => item.identifier), ['ARMY-100']);
  assert.equal(result.applied[0].previousStatus, 'blocked');
  assert.equal(result.applied[0].status, 'cancelled');
  assert.equal(result.applied[0].rollback.requiresSeparateReview, true);
  assert.equal(result.safety.mutationRequests, 1);
  assert.equal(result.safety.deleteRequests, 0);
  const patches = fixture.calls.filter((call) => call.method === 'PATCH');
  assert.equal(patches.length, 1);
  assert.equal(patches[0].path, '/api/issues/issue-historical');
  assert.deepEqual(Object.keys(patches[0].body).sort(), ['comment', 'status']);
  assert.equal(patches[0].body.status, 'cancelled');
  assert.equal(fixture.calls.some((call) => call.method === 'DELETE'), false);
});

test('错误确认值或 apply 前快照漂移时零写入', async () => {
  const fixture = createArchiveFixture();
  const dryRun = await classifyBlockedPendingIssues({
    now: NOW,
    fetchImpl:fixture.fetchImpl,
  });
  const plan = buildHistoricalAcceptanceArchivePlan(dryRun, {
    identifiers:['ARMY-100'],
  });

  await assert.rejects(
    applyHistoricalAcceptanceArchive({
      now: NOW,
      identifiers:['ARMY-100'],
      confirmation:'ARCHIVE:wrong',
      fetchImpl:fixture.fetchImpl,
    }),
    /确认值与当前快照不匹配/,
  );
  assert.equal(fixture.calls.some((call) => call.method === 'PATCH'), false);

  fixture.issue.updatedAt = '2026-07-28T01:00:00.000Z';
  await assert.rejects(
    applyHistoricalAcceptanceArchive({
      now: NOW,
      identifiers:['ARMY-100'],
      confirmation:plan.requiredConfirmation,
      fetchImpl:fixture.fetchImpl,
    }),
    /确认值与当前快照不匹配/,
  );
  assert.equal(fixture.calls.some((call) => call.method === 'PATCH'), false);
});

test('输出标题会脱敏，且不会输出 issue description', () => {
  const item = classifyIssue({
    id: 'secret-title',
    title: '修复 token=abc123 /Users/pengaro/private',
    description: '这里可能包含 cookie=do-not-output',
    status: 'todo',
    updatedAt: '2026-07-30T03:00:00.000Z',
  }, { now: NOW });

  assert.equal(item.title, '修复 token=[REDACTED] /Users/[REDACTED]/private');
  assert.equal('description' in item, false);
  assert.equal(JSON.stringify(item).includes('do-not-output'), false);
});

test('非 loopback 地址和非法 limit 在发请求前失败', async () => {
  let requested = false;
  const fetchImpl = async () => {
    requested = true;
    return response([]);
  };

  await assert.rejects(
    classifyBlockedPendingIssues({ apiBase: 'https://paperclip.example.com', fetchImpl }),
    /只允许连接 loopback/,
  );
  await assert.rejects(
    classifyBlockedPendingIssues({ limit: 0, fetchImpl }),
    /limit 必须是正整数/,
  );
  assert.equal(requested, false);
});

test('超过单页上限时只用 GET 分页读取，直到拿全待办', async () => {
  const calls = [];
  const issues = Array.from({ length: 201 }, (_, index) => ({
    id: `issue-${index}`,
    title: `普通待办 ${index}`,
    status: 'backlog',
    updatedAt: '2026-07-30T03:00:00.000Z',
  }));
  const result = await classifyBlockedPendingIssues({
    now: NOW,
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url);
      calls.push({ method: options.method ?? 'GET', path: parsed.pathname, search: parsed.search });
      if (parsed.pathname === '/api/companies') {
        return response([{ id: 'company-1', name: 'Agent军团' }]);
      }
      if (parsed.pathname === '/api/companies/company-1/agents') return response([]);
      if (parsed.pathname === '/api/companies/company-1/issues') {
        const offset = Number(parsed.searchParams.get('offset'));
        const limit = Number(parsed.searchParams.get('limit'));
        return response(issues.slice(offset, offset + limit));
      }
      throw new Error(`unexpected GET ${parsed.pathname}`);
    },
  });

  assert.equal(result.summary.total, 201);
  assert.equal(result.summary.possiblyTruncated, false);
  assert.equal(calls.filter((call) => call.path.endsWith('/issues')).length, 2);
  assert.equal(calls.every((call) => call.method === 'GET'), true);
});

function createArchiveFixture() {
  const calls = [];
  const issue = {
    id:'issue-historical',
    identifier:'ARMY-100',
    title:'旧版验收演练',
    status:'blocked',
    assigneeAgentId:'agent-reviewer',
    updatedAt:'2026-07-28T00:00:00.000Z',
  };
  const incident = {
    id:'issue-incident',
    identifier:'ARMY-101',
    title:'Publisher Gateway 故障恢复',
    status:'blocked',
    assigneeAgentId:'agent-operator',
    updatedAt:'2026-07-30T03:30:00.000Z',
    activeRecoveryAction:{
      ownerAgentId:'agent-operator',
      status:'active',
    },
  };
  return {
    issue,
    calls,
    fetchImpl:async (url, options = {}) => {
      const parsed = new URL(url);
      const method = options.method ?? 'GET';
      const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ method, path:parsed.pathname, search:parsed.search, body });
      if (parsed.pathname === '/api/companies' && method === 'GET') {
        return response([{ id:'company-1', name:'Agent军团' }]);
      }
      if (parsed.pathname === '/api/companies/company-1/agents' && method === 'GET') {
        return response([
          { id:'agent-reviewer', name:'Reviewer' },
          { id:'agent-operator', name:'运维官' },
        ]);
      }
      if (parsed.pathname === '/api/companies/company-1/issues' && method === 'GET') {
        return response([structuredClone(issue), structuredClone(incident)]);
      }
      if (parsed.pathname === '/api/issues/issue-historical' && method === 'GET') {
        return response(structuredClone(issue));
      }
      if (parsed.pathname === '/api/issues/issue-historical' && method === 'PATCH') {
        Object.assign(issue, { status:body.status });
        return response(structuredClone(issue));
      }
      throw new Error(`unexpected ${method} ${parsed.pathname}`);
    },
  };
}

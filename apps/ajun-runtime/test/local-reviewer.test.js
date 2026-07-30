import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalReviewer } from '../src/local-reviewer.js';

test('审核官只给出需要所有者决定的结论，不做最终授权或外部动作', async () => {
  const reviewer = new LocalReviewer({ now: () => new Date('2026-07-20T09:00:00.000Z') });
  const result = await reviewer.execute({ taskId: 'task-1', input: { title: '审核发布计划', description: '范围：一个内部草稿；有效期：今天。' }, execution: {} });
  const report = result.artifactRefs[0].data;
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(report.riskCategories, ['publish']);
  assert.equal(report.recommendation, 'human_owner_decision_required');
  assert.equal(report.finalDecisionMade, false);
  assert.equal(report.externalActionStarted, false);
});

test('审核官要求补齐范围，而不是把缺少说明的请求视为通过', async () => {
  const reviewer = new LocalReviewer();
  const result = await reviewer.execute({ taskId: 'task-2', input: { title: '审核外发', description: '' }, execution: {} });
  assert.equal(result.artifactRefs[0].data.recommendation, 'needs_scope_before_owner_decision');
});

test('审核官对范围、数据、工具、预算、有效期、副作用和能力审计做机器可验证交叉核验', async () => {
  const reviewer = new LocalReviewer({ now:() => new Date('2026-07-29T10:00:00.000Z') });
  const result = await reviewer.execute({
    taskId:'task-structured-review',
    input:{
      title:'审核发布草稿',
      description:'仅发布一份已批准草稿。',
      context:{
        scope:{ goal:'发布已批准草稿', boundary:'仅一个测试空间；不读取其他数据。' },
        dataScopes:[{ scope:'approved-draft', access:['read'], boundary:'只读当前任务引用草稿。' }],
        toolAllowlist:['content.draft.read'],
        budget:{ maxRuns:1, maxTokens:2000, externalSpendAllowed:false },
        validUntil:'2026-07-30T10:00:00.000Z',
        externalSideEffects:['publish'],
        capabilityAudit:[{ capabilityId:'content.draft.read', status:'passed' }],
        approvalPolicies:[{ action:'publish', decision:'human-owner-required' }]
      }
    },
    execution:{}
  });
  const report = result.artifactRefs[0].data;
  assert.equal(report.schemaVersion, 'agent.army/governance-review/v1');
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.needsEvidence, 0);
  assert.equal(report.recommendation, 'human_owner_decision_required');
  assert.equal(report.findings.every((item) => ['findingId', 'category', 'severity', 'status', 'field', 'message'].every((key) => key in item)), true);
  assert.equal(report.finalDecisionMade, false);
});

test('审核官阻断过期、未审计能力和未声明副作用，不把结论当最终批准', async () => {
  const reviewer = new LocalReviewer({ now:() => new Date('2026-07-29T10:00:00.000Z') });
  const report = (await reviewer.execute({
    taskId:'task-blocked-review',
    input:{
      title:'审核付款并外发',
      description:'操作客户数据。',
      context:{
        scope:{ goal:'完成付款', boundary:'仅当前订单。' },
        dataScopes:[{ scope:'customer-order', access:['read'] }],
        toolAllowlist:['payment.execute'],
        budget:{ maxRuns:1, externalSpendAllowed:false },
        validUntil:'2026-07-28T10:00:00.000Z',
        externalSideEffects:[],
        capabilityAudit:[],
        approvalPolicies:[]
      }
    },
    execution:{}
  })).artifactRefs[0].data;
  assert.equal(report.recommendation, 'needs_revision_before_owner_decision');
  assert.equal(report.summary.blockingFindingIds.includes('validity.not_expired'), true);
  assert.equal(report.summary.blockingFindingIds.includes('side_effects.declared'), true);
  assert.equal(report.findings.find((item) => item.findingId === 'capabilities.audited').status, 'needs_evidence');
  assert.equal(report.finalDecisionMade, false);
  assert.equal(report.externalActionStarted, false);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  APPLY_CONFIRMATION,
  migrateM5DraftZeroWake,
} from '../scripts/migrate-m5-draft-zero-wake.mjs';

const COMPANY_ID = '00000000-0000-4000-8000-000000000001';
const PIPELINE_ID = '00000000-0000-4000-8000-000000000002';
const PROJECT_ID = '00000000-0000-4000-8000-000000000003';
const CAMPAIGN_ID = 'm5-agent-practice-20260731';
const uuid = (value) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;

function createFixture({ issueCount = 22 } = {}) {
  const pipeline = {
    id:PIPELINE_ID,
    key:'m5-ai-agent-content',
    projectId:PROJECT_ID,
    stages:[
      { id:uuid(10), key:'draft', kind:'working', config:{} },
      { id:uuid(11), key:'topic', kind:'working', config:{ onEnter:{ routineId:uuid(400) } } },
      {
        id:uuid(12),
        key:'machine_review',
        kind:'review',
        config:{
          onEnter:{ routineId:uuid(401) },
          requireApproval:true,
          approver:{ kind:'agent', id:uuid(402) },
          approveToStageKey:'platform_adapt',
          requestChangesToStageKey:'script',
          rejectToStageKey:'script',
          automation:{
            routineId:uuid(401),
            latestRoutineRevisionId:uuid(403),
            latestRoutineRevisionNumber:1,
          },
        },
      },
      { id:uuid(13), key:'cancelled', kind:'cancelled', config:{} },
    ],
  };
  const parent = {
    id:uuid(100),
    companyId:COMPANY_ID,
    pipelineId:PIPELINE_ID,
    caseKey:CAMPAIGN_ID,
    title:'M5草案',
    stageKey:'topic',
    parentCaseId:null,
    version:1,
    terminalKind:null,
    fields:{
      campaignId:CAMPAIGN_ID,
      campaignGrant:{
        schemaVersion:'agent.army/campaign-grant/v1',
        status:'draft',
        approvedAt:null,
      },
    },
  };
  const days = Array.from({ length:7 }, (_, index) => {
    const date = `2026-08-${String(index + 1).padStart(2, '0')}`;
    return {
      id:uuid(110 + index),
      companyId:COMPANY_ID,
      pipelineId:PIPELINE_ID,
      caseKey:`${CAMPAIGN_ID}:${date}`,
      title:`第${index + 1}天`,
      stageKey:'topic',
      parentCaseId:parent.id,
      version:1,
      terminalKind:null,
      fields:{ campaignId:CAMPAIGN_ID, scheduledDate:date, theme:`主题${index + 1}` },
    };
  });
  const platforms = days.flatMap((day, dayIndex) =>
    ['douyin', 'xiaohongshu'].map((platform, platformIndex) => ({
      id:uuid(130 + dayIndex * 2 + platformIndex),
      companyId:COMPANY_ID,
      pipelineId:PIPELINE_ID,
      caseKey:`${day.caseKey}:${platform}:v1`,
      title:`${day.title}/${platform}`,
      stageKey:'machine_review',
      parentCaseId:day.id,
      version:1,
      terminalKind:null,
      fields:{
        ...day.fields,
        platform,
        contentVersion:'v1',
      },
    })),
  );
  const cases = [parent, ...days, ...platforms];
  const issues = cases.slice(0, issueCount).map((item, index) => ({
    id:uuid(200 + index),
    identifier:`AGE-${614 + index}`,
    title:index < 8 ? 'M5 / 选题' : 'M5 / 机器审核',
    description:`[agent-army:m5:routine:${index < 8 ? 'm5-topic' : 'm5-machine-review'}] 当前 Case 为 ${item.id}，版本为 1。`,
    originKind:'routine_execution',
    projectId:PROJECT_ID,
    status:index % 2 ? 'in_progress' : 'blocked',
    createdAt:'2026-07-30T04:00:00.000Z',
  }));
  issues.push({
    id:uuid(999),
    identifier:'AGE-999',
    description:`[agent-army:m5:routine:m5-topic] 当前 Case 为 ${parent.id}，版本为 1。`,
    originKind:'manual',
    projectId:PROJECT_ID,
    status:'blocked',
  });

  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const method = String(options.method || 'GET').toUpperCase();
    const body = options.body === undefined ? undefined : JSON.parse(options.body);
    calls.push({ method, path:parsed.pathname, body });

    if (method === 'GET' && parsed.pathname === '/api/companies') {
      return response([{ id:COMPANY_ID, name:'Agent军团' }]);
    }
    if (method === 'GET' && parsed.pathname === `/api/companies/${COMPANY_ID}/pipelines`) {
      return response([{ id:PIPELINE_ID, key:'m5-ai-agent-content', projectId:PROJECT_ID }]);
    }
    if (method === 'GET' && parsed.pathname === `/api/pipelines/${PIPELINE_ID}`) {
      return response(pipeline);
    }
    const stageMatch = parsed.pathname.match(new RegExp(`^/api/pipelines/${PIPELINE_ID}/stages/([^/]+)$`));
    if (method === 'PATCH' && stageMatch) {
      const stage = pipeline.stages.find((item) => item.id === stageMatch[1]);
      stage.config = structuredClone(body.config);
      if (stage.config.automation) {
        stage.config.automation.latestRoutineRevisionNumber += 1;
        stage.config.automation.latestRoutineRevisionId = uuid(
          403 + stage.config.automation.latestRoutineRevisionNumber,
        );
      }
      return response(stage);
    }
    if (method === 'GET' && parsed.pathname === `/api/pipelines/${PIPELINE_ID}/cases`) {
      return response(cases.map((item) => ({
        case:item,
        stage:{ key:item.stageKey, kind:item.stageKey === 'cancelled' ? 'cancelled' : 'working' },
      })));
    }
    if (method === 'GET' && parsed.pathname === `/api/companies/${COMPANY_ID}/routines`) {
      return response([{
        id:uuid(500),
        description:'[agent-army:m5:routine:m5-daily-campaign]',
        triggers:[{ id:uuid(501), kind:'schedule', enabled:false }],
      }]);
    }
    if (method === 'GET' && parsed.pathname === `/api/companies/${COMPANY_ID}/issues`) {
      const offset = Number(parsed.searchParams.get('offset') || 0);
      const limit = Number(parsed.searchParams.get('limit') || 200);
      return response(issues.slice(offset, offset + limit));
    }
    const caseMatch = parsed.pathname.match(/^\/api\/cases\/([^/]+)$/);
    if (method === 'GET' && caseMatch) {
      const item = cases.find((entry) => entry.id === caseMatch[1]);
      return response({ case:item, stage:{ key:item.stageKey } });
    }
    if (method === 'PATCH' && caseMatch) {
      const item = cases.find((entry) => entry.id === caseMatch[1]);
      assert.equal(body.expectedVersion, item.version);
      item.fields = structuredClone(body.fields);
      item.version += 1;
      return response({ case:item, stage:{ key:item.stageKey } });
    }
    const issueMatch = parsed.pathname.match(/^\/api\/issues\/([^/]+)$/);
    if (method === 'PATCH' && issueMatch) {
      const item = issues.find((entry) => entry.id === issueMatch[1]);
      item.status = body.status;
      item.migrationComment = body.comment;
      return response(item);
    }
    const transitionMatch = parsed.pathname.match(/^\/api\/cases\/([^/]+)\/transition$/);
    if (method === 'POST' && transitionMatch) {
      const item = cases.find((entry) => entry.id === transitionMatch[1]);
      assert.equal(body.expectedVersion, item.version);
      if (item.stageKey === 'machine_review') {
        assert.equal(
          pipeline.stages.find((stage) => stage.key === 'machine_review').config.requireApproval,
          false,
        );
      }
      item.stageKey = body.toStageKey;
      item.terminalKind = body.toStageKey === 'cancelled' ? 'cancelled' : null;
      item.version += 1;
      return response(item);
    }
    throw new Error(`unexpected ${method} ${parsed.pathname}`);
  };
  return { pipeline, parent, days, platforms, cases, issues, calls, fetchImpl };
}

test('dry-run精确命中22个Case和22条Routine Issue，且完全只读', async () => {
  const fixture = createFixture();
  const result = await migrateM5DraftZeroWake({
    campaignId:CAMPAIGN_ID,
    expectedCount:22,
    fetchImpl:fixture.fetchImpl,
    now:new Date('2026-07-30T06:00:00.000Z'),
  });

  assert.equal(result.mode, 'dry-run');
  assert.equal(result.campaign.caseCount, 22);
  assert.equal(result.issues.count, 22);
  assert.deepEqual(result.issues.identifiers, Array.from({ length:22 }, (_, index) => `AGE-${614 + index}`));
  assert.equal(result.safety.mutationCount, 0);
  assert.equal(result.reviewGate.restored, false);
  assert.equal(fixture.calls.every((call) => call.method === 'GET'), true);
});

test('expectedCount或实际Issue数量不为精确22时，写入前硬失败', async (t) => {
  await t.test('expectedCount必须显式为22', async () => {
    const fixture = createFixture();
    await assert.rejects(
      migrateM5DraftZeroWake({
        campaignId:CAMPAIGN_ID,
        expectedCount:21,
        apply:true,
        confirmation:APPLY_CONFIRMATION,
        fetchImpl:fixture.fetchImpl,
      }),
      /expectedCount.*22/,
    );
    assert.equal(fixture.calls.length, 0);
  });

  await t.test('实际只有21条精确Issue', async () => {
    const fixture = createFixture({ issueCount:21 });
    await assert.rejects(
      migrateM5DraftZeroWake({
        campaignId:CAMPAIGN_ID,
        expectedCount:22,
        apply:true,
        confirmation:APPLY_CONFIRMATION,
        fetchImpl:fixture.fetchImpl,
      }),
      /Routine Issue 数必须为 22，当前为 21/,
    );
    assert.equal(fixture.calls.every((call) => call.method === 'GET'), true);
  });
});

test('apply只取消精确22条Issue并迁移精确22个Case，不删除且保留审计', async () => {
  const fixture = createFixture();
  const result = await migrateM5DraftZeroWake({
    campaignId:CAMPAIGN_ID,
    expectedCount:22,
    apply:true,
    confirmation:APPLY_CONFIRMATION,
    fetchImpl:fixture.fetchImpl,
    now:new Date('2026-07-30T06:00:00.000Z'),
  });

  assert.equal(result.mode, 'applied');
  assert.equal(fixture.parent.stageKey, 'draft');
  assert.equal(fixture.days.every((item) => item.stageKey === 'cancelled'), true);
  assert.equal(fixture.platforms.every((item) => item.stageKey === 'cancelled'), true);
  assert.deepEqual(fixture.parent.fields.campaignPlan, {
    schemaVersion:'agent.army/campaign-plan/v1',
    startDate:'2026-08-01',
    themes:Array.from({ length:7 }, (_, index) => `主题${index + 1}`),
  });
  assert.equal(fixture.issues.slice(0, 22).every((item) =>
    item.status === 'cancelled' && item.migrationComment.includes('保留审计记录'),
  ), true);
  assert.equal(fixture.issues[22].status, 'blocked');
  assert.equal(
    fixture.pipeline.stages.find((stage) => stage.key === 'machine_review').config.requireApproval,
    true,
  );
  assert.notEqual(result.reviewGate.configHash, result.reviewGate.restoredConfigHash);
  assert.equal(
    result.reviewGate.governanceConfigHash,
    result.reviewGate.restoredGovernanceConfigHash,
  );
  assert.deepEqual(result.reviewGate.serverDerivedDriftPaths, [
    'automation.latestRoutineRevisionId',
    'automation.latestRoutineRevisionNumber',
  ]);
  assert.equal(result.reviewGate.restored, true);
  assert.equal(
    fixture.calls.filter((call) =>
      call.method === 'PATCH'
      && call.path === `/api/pipelines/${PIPELINE_ID}/stages/${uuid(12)}`,
    ).length,
    3,
  );
  assert.equal(fixture.calls.some((call) => call.method === 'DELETE'), false);
  assert.equal(
    fixture.calls.filter((call) => call.method === 'PATCH' && call.path.startsWith('/api/issues/')).length,
    22,
  );
  assert.equal(
    fixture.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/transition')).length,
    22,
  );
});

test('仅把迁移后父draft旧自动推进自产Issue纳入恢复，不扩大原22硬范围', async () => {
  const fixture = createFixture();
  fixture.parent.fields.draftMigration = {
    schemaVersion:'agent.army/draft-zero-wake-migration/v1',
    migratedAt:'2026-07-30T05:00:00.000Z',
    expectedIssueCount:22,
  };
  fixture.issues.push({
    id:uuid(998),
    identifier:'AGE-638',
    description:`[agent-army:m5:routine:m5-topic] 当前 Case 为 ${fixture.parent.id}，版本为 5。`,
    originKind:'routine_execution',
    projectId:PROJECT_ID,
    status:'in_progress',
    activeRunId:null,
    createdAt:'2026-07-30T05:01:00.000Z',
  });

  const dryRun = await migrateM5DraftZeroWake({
    campaignId:CAMPAIGN_ID,
    expectedCount:22,
    fetchImpl:fixture.fetchImpl,
  });
  assert.equal(dryRun.issues.count, 22);
  assert.equal(dryRun.issues.recoveryCount, 1);
  assert.deepEqual(dryRun.issues.recoveryIdentifiers, ['AGE-638']);

  await migrateM5DraftZeroWake({
    campaignId:CAMPAIGN_ID,
    expectedCount:22,
    apply:true,
    confirmation:APPLY_CONFIRMATION,
    fetchImpl:fixture.fetchImpl,
  });
  assert.equal(fixture.issues.find((item) => item.identifier === 'AGE-638').status, 'cancelled');
});

function response(body, status = 200) {
  return {
    ok:status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(body); },
  };
}

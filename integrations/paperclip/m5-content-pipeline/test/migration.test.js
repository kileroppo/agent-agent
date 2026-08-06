import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  M5_V2_CLONE_CUTOVER_CONFIRMATION,
  M5_V2_MIGRATION_CONFIRMATION,
  applyM5V2CloneCutover,
  assertM5V2CloneCutoverApplyAllowed,
  assertM5V2MigrationApplyAllowed,
  buildM5V2CloneDefinition,
  defaultDefinition,
  dryRunM5V2CloneCutover,
  inspectM5V2CloneCutover,
  inspectM5V2Migration,
  rollbackM5V2CloneDraft,
  verifyGzipBackupReference,
  FakePaperclipAdapter,
} from '../src/index.js';

function adapterFixture({ active = false, cron = false } = {}) {
  const pipelineId = '11111111-1111-4111-8111-111111111111';
  const campaignId = '22222222-2222-4222-8222-222222222222';
  return {
    pipelineId,
    adapter:{
      companyId:'33333333-3333-4333-8333-333333333333',
      async request(method, path) {
        assert.equal(method, 'GET');
        if (path === `/api/pipelines/${pipelineId}`) {
          return { id:pipelineId, stages:Array.from({ length:18 }, (_, i) => ({ key:`s${i}` })) };
        }
        if (path === `/api/pipelines/${pipelineId}/cases`) {
          return [{
            id:campaignId,
            parentCaseId:null,
            stageKey:'draft',
            fields:{ campaignGrant:{ status:active ? 'active' : 'draft' } },
          }];
        }
        if (path.includes('/routines') && !path.startsWith('/api/routines/')) {
          return [{
            id:'44444444-4444-4444-8444-444444444444',
            description:'[agent-army:m5:routine:m5-daily-campaign]',
          }];
        }
        if (path === '/api/routines/44444444-4444-4444-8444-444444444444') {
          return { triggers:[{ kind:'schedule', enabled:cron }] };
        }
        throw new Error(`unexpected ${path}`);
      },
    },
  };
}

test('Paperclip真实Case包装中的cancelled子Case不被误判为活动执行', async () => {
  const { adapter, pipelineId } = adapterFixture();
  const originalRequest = adapter.request;
  adapter.request = async (method, path) => {
    if (path === `/api/pipelines/${pipelineId}/cases`) {
      return [
        {
          case:{
            id:'22222222-2222-4222-8222-222222222222',
            parentCaseId:null,
            fields:{ campaignGrant:{ status:'draft' } },
          },
          stage:{ key:'draft' },
          activeWork:null,
          descendantActiveWorkCount:0,
        },
        {
          case:{
            id:'55555555-5555-4555-8555-555555555555',
            parentCaseId:'22222222-2222-4222-8222-222222222222',
            terminalKind:'cancelled',
            fields:{ platform:'douyin' },
          },
          stage:{ key:'cancelled' },
          activeWork:null,
          descendantActiveWorkCount:0,
        },
      ];
    }
    return originalRequest(method, path);
  };
  const audit = await inspectM5V2Migration({
    adapter,
    legacyPipelineId:pipelineId,
    definition:defaultDefinition,
    backup:{ healthy:true, reference:'paperclip-backup.sql.gz', verifiedAt:'2026-07-30T07:00:00Z' },
  });
  assert.equal(audit.checks.noActiveOrRunningCases, true);
  assert.equal(audit.preconditionsPassed, true);
});

test('v2迁移dry-run只在旧18阶段无活动Case、草案0/14、Cron off和备份健康时通过前置门禁', async () => {
  const { adapter, pipelineId } = adapterFixture();
  const audit = await inspectM5V2Migration({
    adapter,
    legacyPipelineId:pipelineId,
    definition:defaultDefinition,
    backup:{ healthy:true, reference:'paperclip-backup.sql.gz', verifiedAt:'2026-07-30T07:00:00Z' },
  });
  assert.equal(audit.preconditionsPassed, true);
  assert.equal(audit.target.stageCount, 16);
  assert.equal(audit.target.routineCount, 18);
  assert.equal(audit.target.controllerCount, 6);
  assert.equal(audit.writesToLivePaperclip, false);
  assert.equal(audit.applySupported, false);
  assert.throws(
    () => assertM5V2MigrationApplyAllowed(audit, M5_V2_MIGRATION_CONFIRMATION),
    /保持 dry-run/,
  );
});

test('active Campaign、Cron on或未核验备份任一存在都拒绝迁移', async () => {
  for (const [options, backup] of [
    [{ active:true }, { healthy:true, reference:'b', verifiedAt:'now' }],
    [{ cron:true }, { healthy:true, reference:'b', verifiedAt:'now' }],
    [{}, { healthy:false, reference:'b', verifiedAt:'now' }],
  ]) {
    const { adapter, pipelineId } = adapterFixture(options);
    const audit = await inspectM5V2Migration({
      adapter,
      legacyPipelineId:pipelineId,
      definition:defaultDefinition,
      backup,
    });
    assert.equal(audit.preconditionsPassed, false);
  }
});

test('备份检查完整解压显式.sql.gz文件，不只相信路径或调用方布尔值', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'm5-v2-backup-'));
  const validPath = join(directory, 'paperclip.sql.gz');
  const invalidPath = join(directory, 'broken.sql.gz');
  await writeFile(validPath, gzipSync('select 1;\n'));
  await writeFile(invalidPath, 'not-gzip');

  const verified = await verifyGzipBackupReference(validPath);
  assert.equal(verified.healthy, true);
  assert.equal(verified.reference, validPath);
  assert.ok(verified.compressedBytes > 0);
  assert.ok(verified.uncompressedBytes > 0);
  await assert.rejects(() => verifyGzipBackupReference(invalidPath));
  await assert.rejects(() => verifyGzipBackupReference('relative.sql.gz'), /绝对路径/);
});

test('clone cutover 审计确认独立v2身份、版本化Routine、显式运行时选择和supersedes契约', async () => {
  const { adapter, pipelineId } = adapterFixture();
  const target = buildM5V2CloneDefinition(defaultDefinition);
  assert.equal(target.key, `${defaultDefinition.key}-v2`);
  assert.equal(target.project.key, `${defaultDefinition.project.key}-v2`);
  assert.equal(target.stages.length, 16);

  const audit = await inspectM5V2CloneCutover({
    adapter,
    legacyPipelineId:pipelineId,
    definition:defaultDefinition,
    backup:{ healthy:true, reference:'paperclip-backup.sql.gz', verifiedAt:'2026-07-30T07:00:00Z' },
  });
  assert.equal(audit.legacyPreconditionsPassed, true);
  assert.deepEqual(audit.target, {
    pipelineKey:`${defaultDefinition.key}-v2`,
    projectKey:`${defaultDefinition.project.key}-v2`,
    stageCount:16,
    routineCount:18,
    controllerCount:6,
    campaignDraftProgress:'0/14',
    cronEnabled:false,
  });
  assert.equal(audit.checks.distinctPipelineKey, true);
  assert.equal(audit.checks.distinctProjectKey, true);
  assert.equal(audit.checks.targetCronOff, true);
  assert.equal(audit.checks.bootstrapRoutineIdentityVersioned, true);
  assert.equal(audit.checks.runtimeRoutineSelectionProjectScoped, true);
  assert.equal(audit.checks.runtimePipelineCutoverConfigured, true);
  assert.equal(audit.checks.campaignSupersedeLineageImplemented, true);
  assert.deepEqual(audit.blockers, []);
  assert.equal(audit.applySupported, true);
  assert.equal(audit.writesToLivePaperclip, false);
  assert.equal(
    assertM5V2CloneCutoverApplyAllowed(audit, M5_V2_CLONE_CUTOVER_CONFIRMATION),
    true,
  );
});

test('Fake clone cutover 幂等保留v1/22 Cases并创建v2未批准0/14草案，回滚只取消v2', async () => {
  const legacyPipelineId = 'legacy-pipeline';
  const legacyCampaignCaseId = 'legacy-campaign';
  const oldRoutines = Array.from({ length:17 }, (_, index) => ({
    id:`legacy-routine-${index}`,
    projectId:'legacy-project',
    description:`[agent-army:m5:routine:m5-${index}]`,
  }));
  const legacyChildren = Array.from({ length:21 }, (_, index) => ({
    id:`legacy-child-${index}`,
    pipelineId:legacyPipelineId,
    parentCaseId:legacyCampaignCaseId,
    caseKey:`legacy-child-${index}`,
    stageKey:'cancelled',
    version:1,
    fields:{},
  }));
  const adapter = new FakePaperclipAdapter({
    projects:[{ id:'legacy-project', key:defaultDefinition.project.key }],
    routines:oldRoutines,
    pipelines:[{
      id:legacyPipelineId,
      key:defaultDefinition.key,
      projectId:'legacy-project',
      stages:Array.from({ length:18 }, (_, index) => ({
        id:`legacy-stage-${index}`,
        key:`legacy-${index}`,
      })),
    }],
    cases:[{
      id:legacyCampaignCaseId,
      pipelineId:legacyPipelineId,
      parentCaseId:null,
      caseKey:'m5-week-01',
      stageKey:'draft',
      version:1,
      fields:{
        campaignId:'m5-week-01',
        campaignPlan:{
          schemaVersion:'agent.army/campaign-plan/v1',
          startDate:'2026-08-03',
          themes:['一', '二', '三', '四', '五', '六', '七'],
          assetRightsBasis:'repository_owned',
        },
        campaignGrant:{
          schemaVersion:'agent.army/campaign-grant/v1',
          status:'draft',
          approvedAt:null,
          accountRefs:{},
          budgetCents:625,
        },
      },
    }, ...legacyChildren],
  });

  const first = await dryRunM5V2CloneCutover({
    definition:defaultDefinition,
    adapter,
    legacyCampaignCaseId,
    now:() => new Date('2026-07-30T08:00:00Z'),
  });
  const second = await dryRunM5V2CloneCutover({
    definition:defaultDefinition,
    adapter,
    legacyCampaignCaseId,
    now:() => new Date('2026-07-30T08:01:00Z'),
  });

  assert.equal(adapter.state.pipelines.length, 2);
  assert.equal(adapter.state.pipelines.find((item) => item.id === legacyPipelineId).stages.length, 18);
  assert.equal(adapter.state.pipelines.find((item) => item.key.endsWith('-v2')).stages.length, 16);
  assert.equal(adapter.state.cases.filter((item) => item.pipelineId === legacyPipelineId).length, 22);
  assert.equal(adapter.state.cases.filter((item) => item.pipelineId === first.target.pipelineId).length, 1);
  assert.equal(first.target.campaignCaseId, second.target.campaignCaseId);
  assert.equal(first.target.grantStatus, 'draft');
  assert.equal(first.target.progress, '0/14');
  assert.equal(first.target.cronEnabled, false);
  assert.equal(second.legacy.grantStatus, 'superseded');
  assert.equal(second.legacy.stageKey, 'cancelled');
  assert.equal(second.legacy.restorable, false);
  assert.ok(adapter.state.routines.some((item) =>
    item.description?.includes(`[agent-army:m5:deployment:${defaultDefinition.key}-v2:routine:m5-topic]`),
  ));

  const rolledBack = await rollbackM5V2CloneDraft({
    adapter,
    v2CampaignCaseId:first.target.campaignCaseId,
    confirmation:M5_V2_CLONE_CUTOVER_CONFIRMATION,
    now:() => new Date('2026-07-30T08:02:00Z'),
  });
  assert.equal(rolledBack.legacyRestored, false);
  assert.equal(adapter.state.cases.find((item) => item.id === first.target.campaignCaseId).stageKey, 'cancelled');
  assert.equal(adapter.state.cases.find((item) => item.id === legacyCampaignCaseId).fields.campaignGrant.status, 'superseded');
});

test('clone cutover live apply 在精确确认前只有GET审计，拒绝任何写入', async () => {
  const { adapter, pipelineId } = adapterFixture();
  const calls = [];
  const request = adapter.request.bind(adapter);
  adapter.request = async (method, path, body) => {
    calls.push({ method, path, body });
    return request(method, path, body);
  };
  await assert.rejects(
    () => applyM5V2CloneCutover({
      definition:defaultDefinition,
      adapter,
      legacyPipelineId:pipelineId,
      legacyCampaignCaseId:'22222222-2222-4222-8222-222222222222',
      backup:{ healthy:true, reference:'backup.sql.gz', verifiedAt:'now' },
      bindings:{},
      budgetCents:625,
      confirmation:'wrong',
    }),
    /精确确认串/,
  );
  assert.equal(calls.every((item) => item.method === 'GET'), true);
});

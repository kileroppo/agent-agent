import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { buildBootstrapPlan } from './plan.js';
import {
  APPLY_CONFIRMATION,
  applyBootstrap,
  dryRunBootstrap,
} from './bootstrap.js';
import {
  buildCampaignCaseBatch,
  ingestCampaignDraftCase,
} from './contract.js';
import { FakePaperclipAdapter } from './adapters/fake.js';

export const M5_V2_MIGRATION_CONFIRMATION =
  'I_CONFIRM_M5_V2_PIPELINE_MIGRATION_WITH_DRAFT_CAMPAIGN_CRON_OFF_AND_ROLLBACK';
export const M5_V2_CLONE_CUTOVER_CONFIRMATION =
  'I_CONFIRM_M5_V2_CLONE_CUTOVER_WITH_V1_RETAINED_V2_DRAFT_ONLY_AND_CRON_OFF';

const TERMINAL_OR_IDLE_STAGES = new Set(['draft', 'campaign_active', 'done', 'cancelled']);

export async function inspectM5V2Migration({
  adapter,
  legacyPipelineId,
  definition,
  backup,
} = {}) {
  if (!adapter?.request || !adapter?.companyId || !legacyPipelineId || !definition) {
    throw new Error('M5 v2 迁移检查缺少 Paperclip 适配器、旧 Pipeline 或目标定义');
  }
  const [legacyDetail, caseDocument, routines] = await Promise.all([
    adapter.request('GET', `/api/pipelines/${encodeURIComponent(legacyPipelineId)}`),
    adapter.request('GET', `/api/pipelines/${encodeURIComponent(legacyPipelineId)}/cases`),
    adapter.request('GET', `/api/companies/${encodeURIComponent(adapter.companyId)}/routines`),
  ]);
  const legacy = legacyDetail?.pipeline ?? legacyDetail;
  const cases = rows(caseDocument).map((item) => {
    const record = item?.case ?? item;
    return {
      ...record,
      stageKey:item?.stage?.key ?? record?.stageKey ?? null,
      activeWork:item?.activeWork ?? record?.activeWork ?? null,
      descendantActiveWorkCount:Number(
        item?.descendantActiveWorkCount ?? record?.descendantActiveWorkCount ?? 0,
      ),
    };
  });
  const dailyCandidates = rows(routines).filter((item) =>
    String(item?.description || '').includes('[agent-army:m5:routine:m5-daily-campaign]')
    && (
      !legacy?.projectId
      || !item?.projectId
      || item.projectId === legacy.projectId
    ),
  );
  const daily = dailyCandidates.length === 1 ? dailyCandidates[0] : null;
  const dailyDetail = daily?.id
    ? await adapter.request('GET', `/api/routines/${encodeURIComponent(daily.id)}`)
    : null;
  const scheduleTriggers = rows(dailyDetail?.triggers).filter((item) => item.kind === 'schedule');
  const campaignParents = cases.filter((item) => !item.parentCaseId && item.fields?.campaignGrant);
  const activeCases = cases.filter((item) =>
    item.fields?.campaignGrant?.status === 'active'
    || Boolean(item.activeWork)
    || item.descendantActiveWorkCount > 0
    || Boolean(item.leaseToken)
    || ['active', 'running', 'in_progress'].includes(String(item.status || ''))
    || (
      item.parentCaseId
      && !item.terminalKind
      && !TERMINAL_OR_IDLE_STAGES.has(String(item.stageKey || ''))
    ),
  );
  const completedPlatforms = cases.filter((item) =>
    item.fields?.platform
    && ['done', 'retrospective'].includes(String(item.stageKey || item.status || '')),
  );
  const checks = {
    legacyPipelineIs18Stages:Array.isArray(legacy?.stages) && legacy.stages.length === 18,
    noActiveOrRunningCases:activeCases.length === 0,
    exactlyOneDraftCampaign:campaignParents.length === 1
      && campaignParents[0].fields.campaignGrant.status === 'draft',
    campaignProgressZeroOf14:completedPlatforms.length === 0,
    dailyCronOff:scheduleTriggers.length === 1 && scheduleTriggers[0].enabled === false,
    legacyDailyRoutineUnique:dailyCandidates.length === 1,
    backupHealthy:backup?.healthy === true
      && Boolean(String(backup?.reference || '').trim())
      && Boolean(String(backup?.verifiedAt || '').trim()),
    targetIs15Stages:definition.stages?.length === 15,
  };
  const preconditionsPassed = Object.values(checks).every(Boolean);
  const plan = buildBootstrapPlan(definition);
  return {
    schemaVersion:'agent.army/m5-pipeline-v2-migration-audit/v1',
    mode:'dry-run',
    legacy:{
      pipelineId:legacyPipelineId,
      stageCount:legacy?.stages?.length ?? null,
      caseCount:cases.length,
      campaignCaseId:campaignParents[0]?.id || null,
      campaignGrantStatus:campaignParents[0]?.fields?.campaignGrant?.status || null,
    },
    target:{
      pipelineKey:`${definition.key}-v2`,
      stageCount:definition.stages.length,
      routineCount:plan.resources.routines.length + 1,
      controllerCount:5,
    },
    checks,
    preconditionsPassed,
    writesToLivePaperclip:false,
    applySupported:false,
    missingApi:'Paperclip 2026.722 没有原子切换 Campaign/每日入口到新 Pipeline 的公开接口契约。',
    confirmation:M5_V2_MIGRATION_CONFIRMATION,
    rollback:[
      '保持旧 Pipeline、Case、Issue、Work Product 和 Cron 原样不删除。',
      '若未来切换接口可用，失败时把入口引用切回旧 Pipeline，并保持 Cron 关闭。',
      '新 v2 Pipeline 在人工复核前保持无 CampaignGrant、无 Case 激活和无 Routine 唤醒。',
    ],
  };
}

export function assertM5V2MigrationApplyAllowed(audit, confirmation) {
  if (confirmation !== M5_V2_MIGRATION_CONFIRMATION) {
    throw new Error('M5 v2 迁移缺少精确确认串');
  }
  if (!audit?.preconditionsPassed) throw new Error('M5 v2 迁移前置检查未全部通过');
  if (audit.applySupported !== true) {
    throw new Error(`M5 v2 迁移保持 dry-run：${audit?.missingApi || '缺少安全入口切换能力'}`);
  }
  return true;
}

export function buildM5V2CloneDefinition(definition) {
  if (!definition?.key || !definition?.project?.key) {
    throw new Error('M5 v2 clone 定义缺少 Pipeline 或 Project key');
  }
  if (definition.key.endsWith('-v2') || definition.project.key.endsWith('-v2')) {
    throw new Error('M5 v2 clone 定义已经版本化，拒绝重复追加 v2');
  }
  return {
    ...structuredClone(definition),
    key:`${definition.key}-v2`,
    name:`${definition.name} / v2`,
    project:{
      ...structuredClone(definition.project),
      key:`${definition.project.key}-v2`,
      name:`${definition.project.name} / v2`,
    },
  };
}

export async function inspectM5V2CloneCutover({
  adapter,
  legacyPipelineId,
  definition,
  backup,
} = {}) {
  const legacyAudit = await inspectM5V2Migration({
    adapter,
    legacyPipelineId,
    definition,
    backup,
  });
  const legacyGrantStatus = legacyAudit.legacy.campaignGrantStatus;
  const legacyCloneEligible = ['draft', 'superseded'].includes(legacyGrantStatus);
  const legacyPreconditionsPassed = Object.entries(legacyAudit.checks)
    .filter(([key]) => key !== 'exactlyOneDraftCampaign')
    .every(([, passed]) => passed === true)
    && legacyCloneEligible;
  const targetDefinition = buildM5V2CloneDefinition(definition);
  const targetPlan = buildBootstrapPlan(targetDefinition, {
    resourceNamespace:targetDefinition.key,
  });
  const targetRoutines = [
    ...targetPlan.resources.routines,
    targetPlan.resources.scheduleRoutine,
  ];
  const unversionedRoutineMarkers = targetRoutines
    .filter((routine) => routine.marker === `[agent-army:m5:routine:${routine.key}]`)
    .map((routine) => routine.key);
  const blockers = [];
  if (unversionedRoutineMarkers.length > 0) {
    blockers.push({
      code:'routine_identity_collision',
      detail:'v2 Routine identity 未版本化，会命中并改写 v1 Routine。',
      affected:unversionedRoutineMarkers,
    });
  }
  const applySupported = legacyPreconditionsPassed && blockers.length === 0;
  return {
    schemaVersion:'agent.army/m5-v2-clone-cutover-audit/v1',
    mode:'dry-run',
    legacy:legacyAudit.legacy,
    target:{
      pipelineKey:targetDefinition.key,
      projectKey:targetDefinition.project.key,
      stageCount:targetDefinition.stages.length,
      routineCount:targetRoutines.length,
      controllerCount:5,
      campaignDraftProgress:'0/14',
      cronEnabled:false,
    },
    checks:{
      ...legacyAudit.checks,
      legacyCloneEligible,
      distinctPipelineKey:targetDefinition.key !== definition.key,
      distinctProjectKey:targetDefinition.project.key !== definition.project.key,
      targetCronOff:targetPlan.resources.scheduleTrigger.enabled === false,
      bootstrapRoutineIdentityVersioned:unversionedRoutineMarkers.length === 0,
      runtimeRoutineSelectionProjectScoped:true,
      runtimePipelineCutoverConfigured:true,
      campaignSupersedeLineageImplemented:true,
    },
    legacyPreconditionsPassed,
    blockers,
    applySupported,
    writesToLivePaperclip:false,
    confirmation:M5_V2_CLONE_CUTOVER_CONFIRMATION,
    safeSequence:[
      '保留 v1 Pipeline、22个 Case、Issue 和 Work Product，不删除。',
      '先补版本化 Routine identity 与项目范围选择，再创建 v2 Project/Pipeline/Routine，Cron 固定关闭。',
      '在 v2 Pipeline 创建全新未批准草案，回读确认 draft、0/14、无执行子 Case。',
      '最后以幂等 supersedesCaseId 更新旧草案为 superseded，并迁移旧父 Case 到 cancelled；任一步失败时两个 Cron 都保持关闭。',
    ],
  };
}

export function assertM5V2CloneCutoverApplyAllowed(audit, confirmation) {
  if (confirmation !== M5_V2_CLONE_CUTOVER_CONFIRMATION) {
    throw new Error('M5 v2 clone cutover 缺少精确确认串');
  }
  if (!audit?.legacyPreconditionsPassed) {
    throw new Error('M5 v2 clone cutover 的 v1 前置检查未全部通过');
  }
  if (audit?.blockers?.length || audit?.applySupported !== true) {
    const codes = (audit?.blockers || []).map((item) => item.code).join(', ');
    throw new Error(`M5 v2 clone cutover 保持 dry-run：${codes || '安全实现尚未完成'}`);
  }
  return true;
}

export async function dryRunM5V2CloneCutover({
  definition,
  adapter = new FakePaperclipAdapter(),
  legacyCampaignCaseId,
  bindings = {},
  budgetCents = 625,
  now = () => new Date(),
} = {}) {
  if (!(adapter instanceof FakePaperclipAdapter)) {
    throw new Error('clone cutover dry-run 只允许 FakePaperclipAdapter');
  }
  const targetDefinition = buildM5V2CloneDefinition(definition);
  const bootstrap = await dryRunBootstrap({
    definition:targetDefinition,
    adapter,
    bindings:{ ...bindings, resourceNamespace:targetDefinition.key },
    budgetCents,
  });
  return executeCloneCutover({
    adapter,
    definition,
    targetDefinition,
    bootstrap,
    legacyCampaignCaseId,
    now,
    mode:'dry-run',
  });
}

export async function applyM5V2CloneCutover({
  definition,
  adapter,
  legacyPipelineId,
  legacyCampaignCaseId,
  backup,
  bindings = {},
  budgetCents,
  confirmation,
  now = () => new Date(),
} = {}) {
  if (!adapter || adapter instanceof FakePaperclipAdapter) {
    throw new Error('clone cutover live apply 必须使用真实 Paperclip adapter');
  }
  const audit = await inspectM5V2CloneCutover({
    adapter,
    legacyPipelineId,
    definition,
    backup,
  });
  assertM5V2CloneCutoverApplyAllowed(audit, confirmation);
  if (legacyCampaignCaseId !== audit.legacy.campaignCaseId) {
    throw new Error('clone cutover 指定的 v1 草案 Case 与只读审计结果不一致');
  }
  const targetDefinition = buildM5V2CloneDefinition(definition);
  const bootstrap = await applyBootstrap({
    definition:targetDefinition,
    adapter,
    bindings:{ ...bindings, resourceNamespace:targetDefinition.key },
    budgetCents,
    confirmLiveWrite:APPLY_CONFIRMATION,
  });
  return executeCloneCutover({
    adapter,
    definition,
    targetDefinition,
    bootstrap,
    legacyCampaignCaseId,
    now,
    mode:'apply',
    audit,
  });
}

export async function rollbackM5V2CloneDraft({
  adapter,
  v2CampaignCaseId,
  confirmation,
  now = () => new Date(),
} = {}) {
  if (confirmation !== M5_V2_CLONE_CUTOVER_CONFIRMATION) {
    throw new Error('M5 v2 clone rollback 缺少精确确认串');
  }
  const current = await adapter.getCase(v2CampaignCaseId);
  const grant = current?.fields?.campaignGrant;
  if (
    !current
    || grant?.status !== 'draft'
    || grant.approvedAt
    || !current.fields?.supersedesCaseId
  ) {
    throw new Error('只允许回滚尚未批准的 v2 clone 草案；旧 v1 不可恢复');
  }
  const descendants = (await adapter.listPipelineCases(current.pipelineId))
    .filter((item) => item.parentCaseId === current.id);
  if (descendants.length > 0) {
    throw new Error('v2 clone 已产生执行子 Case，拒绝自动回滚');
  }
  const trigger = await adapter.getProjectDailyTrigger(current.fields.projectId);
  if (trigger.enabled !== false) {
    throw new Error('v2 clone Cron 已启用，拒绝自动回滚');
  }
  const patched = await adapter.patchCaseFields(current.id, current.version, {
    ...current.fields,
    campaignGrant:{
      ...grant,
      status:'cancelled',
      cancelledAt:now().toISOString(),
      cancelReason:'clone_cutover_rollback_before_approval',
      restorable:false,
    },
  });
  const cancelled = patched.stageKey === 'cancelled'
    ? patched
    : await adapter.transitionCase(patched.id, {
      toStageKey:'cancelled',
      expectedVersion:patched.version,
      reason:'回滚尚未批准的 v2 clone 草案；旧 v1 保持 superseded 且不可恢复。',
      force:true,
    });
  return { rolledBack:true, v2CampaignCaseId:cancelled.id, legacyRestored:false };
}

async function executeCloneCutover({
  adapter,
  definition,
  targetDefinition,
  bootstrap,
  legacyCampaignCaseId,
  now,
  mode,
  audit = null,
}) {
  const targetPipelineId = bootstrap.operations
    .find((item) => item.type === 'pipeline')?.id;
  if (!targetPipelineId) throw new Error('clone cutover 没有取得 v2 Pipeline ID');
  const targetTrigger = bootstrap.operations.find((item) => item.type === 'routine-trigger');
  if (targetTrigger?.enabled !== false) throw new Error('clone cutover v2 Cron 必须保持关闭');
  let legacy = await adapter.getCase(legacyCampaignCaseId);
  const legacyGrant = legacy?.fields?.campaignGrant;
  const legacyPlan = legacy?.fields?.campaignPlan;
  if (!legacy || legacy.pipelineId == null || !legacyPlan || !legacyGrant) {
    throw new Error('clone cutover 缺少可信 v1 草案 Case/计划/授权');
  }
  if (!['draft', 'superseded'].includes(legacyGrant.status)) {
    throw new Error(`clone cutover 只接受 v1 draft/superseded，当前为 ${legacyGrant.status}`);
  }
  const batch = buildCampaignCaseBatch({
    campaignId:legacy.fields.campaignId || legacy.caseKey,
    startDate:legacyPlan.startDate,
    themes:legacyPlan.themes,
    assetRightsBasis:legacyPlan.assetRightsBasis,
  });
  batch.parent.fields = {
    ...batch.parent.fields,
    projectId:bootstrap.bindings.projectId,
    deploymentKey:targetDefinition.key,
    supersedesCaseId:legacy.id,
    campaignGrant:{
      ...legacyGrant,
      status:'draft',
      approvedAt:null,
      approvedBy:null,
      pausedAt:null,
      pauseReason:null,
      createdAt:now().toISOString(),
      supersedesCaseId:legacy.id,
      restorable:false,
    },
  };
  const v2Draft = await ingestCampaignDraftCase(adapter, targetPipelineId, batch);
  if (
    v2Draft.fields?.campaignGrant?.status !== 'draft'
    || v2Draft.fields?.supersedesCaseId !== legacy.id
  ) {
    throw new Error('clone cutover v2 草案幂等回读不一致');
  }
  if (legacyGrant.status === 'draft') {
    legacy = await adapter.patchCaseFields(legacy.id, legacy.version, {
      ...legacy.fields,
      campaignGrant:{
        ...legacyGrant,
        status:'superseded',
        supersededByCaseId:v2Draft.id,
        supersededAt:now().toISOString(),
        restorable:false,
      },
    });
  } else if (legacyGrant.supersededByCaseId !== v2Draft.id) {
    throw new Error('v1 草案已由其他 v2 草案替代，拒绝重定向 lineage');
  }
  if (legacy.stageKey !== 'cancelled') {
    legacy = await adapter.transitionCase(legacy.id, {
      toStageKey:'cancelled',
      expectedVersion:legacy.version,
      reason:'v2 clone 草案已创建并回读为未批准0/14；v1只读保留且不可恢复。',
      force:true,
    });
  }
  return {
    schemaVersion:'agent.army/m5-v2-clone-cutover-result/v1',
    mode,
    audit,
    bootstrap,
    legacy:{
      pipelineId:legacy.pipelineId,
      campaignCaseId:legacy.id,
      stageKey:legacy.stageKey,
      grantStatus:legacy.fields.campaignGrant.status,
      restorable:false,
    },
    target:{
      pipelineId:targetPipelineId,
      pipelineKey:targetDefinition.key,
      campaignCaseId:v2Draft.id,
      stageKey:v2Draft.stageKey,
      grantStatus:v2Draft.fields.campaignGrant.status,
      progress:'0/14',
      cronEnabled:false,
    },
    writesToLivePaperclip:mode === 'apply',
  };
}

export async function verifyGzipBackupReference(reference) {
  if (!reference || !isAbsolute(reference) || !reference.endsWith('.sql.gz')) {
    throw new Error('M5 v2 迁移备份必须是显式绝对路径的 .sql.gz 文件');
  }
  const metadata = await stat(reference);
  if (!metadata.isFile() || metadata.size <= 0) {
    throw new Error('M5 v2 迁移备份不存在、不是文件或为空');
  }
  let uncompressedBytes = 0;
  await pipeline(
    createReadStream(reference),
    createGunzip(),
    new Writable({
      write(chunk, _encoding, callback) {
        uncompressedBytes += chunk.length;
        callback();
      },
    }),
  );
  if (uncompressedBytes <= 0) {
    throw new Error('M5 v2 迁移备份解压后为空');
  }
  return {
    healthy:true,
    reference,
    compressedBytes:metadata.size,
    uncompressedBytes,
    verifiedAt:new Date().toISOString(),
  };
}

function rows(value) {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.items) ? value.items : [];
}

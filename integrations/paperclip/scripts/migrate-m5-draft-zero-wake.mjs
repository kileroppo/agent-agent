#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { HttpPaperclipAdapter } from '../m5-content-pipeline/src/adapters/http.js';

export const APPLY_CONFIRMATION = 'MIGRATE_M5_DRAFT_ZERO_WAKE';
const DEFAULT_API_BASE = 'http://127.0.0.1:3100';
const DEFAULT_COMPANY_NAME = 'Agent军团';
const PIPELINE_KEY = 'm5-ai-agent-content';
const DAILY_ROUTINE_MARKER = '[agent-army:m5:routine:m5-daily-campaign]';
const ROUTINE_MARKER = /\[agent-army:m5:routine:([a-z0-9_-]+)\]/;
const CASE_ID_MARKER = /当前 Case 为 ([0-9a-f]{8}-[0-9a-f-]{27,72})/i;
const PLAN_SCHEMA = 'agent.army/campaign-plan/v1';
const MIGRATION_SCHEMA = 'agent.army/draft-zero-wake-migration/v1';
const PAGE_SIZE = 200;

export async function migrateM5DraftZeroWake({
  apiBase = DEFAULT_API_BASE,
  companyName = DEFAULT_COMPANY_NAME,
  campaignId,
  expectedCount,
  apply = false,
  confirmation,
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  const origin = assertLoopbackApiBase(apiBase);
  const normalizedCampaignId = normalizeCampaignId(campaignId);
  const normalizedExpectedCount = normalizeExpectedCount(expectedCount);
  if (apply && confirmation !== APPLY_CONFIRMATION) {
    throw new Error(`apply 必须提供确认串 ${APPLY_CONFIRMATION}`);
  }

  const mutations = [];
  const request = createAuditedRequest({ origin, fetchImpl, allowWrites:apply, mutations });
  const companies = asList(await request('GET', '/api/companies'));
  const company = companies.find((item) => item.name === companyName);
  if (!company) throw new Error(`Paperclip 中未找到公司：${companyName}`);

  const adapter = new HttpPaperclipAdapter({
    apiBase:origin,
    companyId:company.id,
    fetchImpl:createAdapterFetch(origin, request),
  });
  const pipelines = asList(await request(
    'GET',
    `/api/companies/${encodeURIComponent(company.id)}/pipelines`,
  ));
  const pipeline = pipelines.find((item) => item.key === PIPELINE_KEY);
  if (!pipeline) throw new Error(`未找到 Pipeline：${PIPELINE_KEY}`);
  const pipelineDetail = await request('GET', `/api/pipelines/${encodeURIComponent(pipeline.id)}`);
  assertSafeDraftStage(pipelineDetail);

  const caseEnvelopes = asList(await request(
    'GET',
    `/api/pipelines/${encodeURIComponent(pipeline.id)}/cases`,
  ));
  const campaignCases = caseEnvelopes
    .map(unwrapCase)
    .filter((item) =>
      item.caseKey === normalizedCampaignId
      || item.caseKey?.startsWith(`${normalizedCampaignId}:`),
    );
  const scope = buildCampaignScope(campaignCases, normalizedCampaignId, normalizedExpectedCount);
  assertDraftGrant(scope.parent);

  const routines = asList(await request(
    'GET',
    `/api/companies/${encodeURIComponent(company.id)}/routines`,
  ));
  const dailyMatches = routines.filter((item) => String(item.description || '').includes(DAILY_ROUTINE_MARKER));
  if (dailyMatches.length !== 1) {
    throw new Error(`M5 每日入口 Routine 必须唯一，当前为 ${dailyMatches.length} 个`);
  }
  const dailyRoutine = dailyMatches[0].triggers
    ? dailyMatches[0]
    : await request('GET', `/api/routines/${encodeURIComponent(dailyMatches[0].id)}`);
  const scheduleTriggers = asList(dailyRoutine.triggers).filter((item) => item.kind === 'schedule');
  if (scheduleTriggers.length !== 1 || scheduleTriggers[0].enabled !== false) {
    throw new Error('M5 每日 Cron 必须唯一且保持关闭，拒绝迁移');
  }

  const issues = await listAllIssues(request, company.id);
  const issueScope = buildIssueScope({
    issues,
    caseIds:new Set(campaignCases.map((item) => item.id)),
    projectId:pipelineDetail.projectId,
    expectedCount:normalizedExpectedCount,
    parent:scope.parent,
  });
  const migrationPlan = campaignPlanFromCases(scope.days);
  const generatedAt = normalizeDate(now).toISOString();
  const reviewGate = inspectMachineReviewGate(pipelineDetail, scope.platformCases);

  if (!apply) {
    return resultView({
      mode:'dry-run',
      company,
      pipeline:pipelineDetail,
      campaignId:normalizedCampaignId,
      scope,
      issueScope,
      reviewGate,
      generatedAt,
      mutations,
    });
  }

  await normalizeMachineReviewGate(request, pipelineDetail.id, reviewGate);
  const parentBeforePatch = unwrapCase(await request(
    'GET',
    `/api/cases/${encodeURIComponent(scope.parent.id)}`,
  ));
  assertSameCase(parentBeforePatch, scope.parent);
  await request('PATCH', `/api/cases/${encodeURIComponent(parentBeforePatch.id)}`, {
    expectedVersion:parentBeforePatch.version,
    fields:{
      ...(parentBeforePatch.fields || {}),
      campaignPlan:migrationPlan,
      draftMigration:{
        schemaVersion:MIGRATION_SCHEMA,
        migratedAt:parentBeforePatch.fields?.draftMigration?.migratedAt || generatedAt,
        reason:'未批准草案曾误触发阶段 Routine；取消执行并恢复为零唤醒草案。',
        expectedIssueCount:normalizedExpectedCount,
      },
    },
  });

  for (const issue of issueScope.issues) {
    await request('PATCH', `/api/issues/${encodeURIComponent(issue.id)}`, {
      status:'cancelled',
      comment:`[agent-army:m5:draft-migration] ${normalizedCampaignId} 未获批准；该 Routine Issue 由旧草案入口误触发，现取消执行并保留审计记录。`,
    });
  }
  for (const issue of issueScope.recoveryIssues) {
    await request('PATCH', `/api/issues/${encodeURIComponent(issue.id)}`, {
      status:'cancelled',
      comment:`[agent-army:m5:draft-migration-recovery] ${normalizedCampaignId} 迁移时因draft旧自动推进规则产生；现取消并保留审计记录。`,
    });
  }

  let migrationError = null;
  let restoreError = null;
  await setMachineReviewApproval(request, pipelineDetail.id, reviewGate, false);
  try {
    const descendants = [...scope.platformCases, ...scope.days];
    for (const original of descendants) {
      const current = unwrapCase(await request('GET', `/api/cases/${encodeURIComponent(original.id)}`));
      assertSameCase(current, original);
      if (current.stageKey === 'cancelled' || current.terminalKind === 'cancelled') continue;
      await adapter.transitionCase(current.id, {
        toStageKey:'cancelled',
        expectedVersion:current.version,
        reason:'未批准草案误触发 Routine，迁移到 cancelled 保留审计；批准后可按原 caseKey 恢复。',
        force:true,
      });
    }

    const parentCurrent = unwrapCase(await request('GET', `/api/cases/${encodeURIComponent(scope.parent.id)}`));
    assertSameCase(parentCurrent, scope.parent);
    if (parentCurrent.stageKey !== 'draft') {
      await adapter.transitionCase(parentCurrent.id, {
        toStageKey:'draft',
        expectedVersion:parentCurrent.version,
        reason:'未批准活动恢复为无 onEnter Routine 的 Paperclip draft 真相。',
        force:true,
      });
    }
  } catch (error) {
    migrationError = error;
  } finally {
    try {
      await setMachineReviewApproval(request, pipelineDetail.id, reviewGate, true);
      const restoredPipeline = await request(
        'GET',
        `/api/pipelines/${encodeURIComponent(pipelineDetail.id)}`,
      );
      const restoredStage = asList(restoredPipeline.stages)
        .find((item) => item.id === reviewGate.stageId);
      const restoredHash = hashJson(restoredStage?.config);
      const restoredGovernanceHash = hashJson(withoutServerDerivedRoutineRevision(restoredStage?.config));
      const driftPaths = diffJsonPaths(reviewGate.originalConfig, restoredStage?.config);
      const allowedDerivedDrift = driftPaths.every((path) =>
        path === 'automation.latestRoutineRevisionId'
        || path === 'automation.latestRoutineRevisionNumber',
      );
      if (
        restoredGovernanceHash !== reviewGate.governanceConfigHash
        || !allowedDerivedDrift
      ) {
        throw new Error(`machine_review config哈希不一致：${restoredHash}；差异=${driftPaths.join(',')}`);
      }
      reviewGate.restoredConfigHash = restoredHash;
      reviewGate.restoredGovernanceConfigHash = restoredGovernanceHash;
      reviewGate.serverDerivedDriftPaths = driftPaths;
      reviewGate.restored = true;
    } catch (error) {
      restoreError = error;
    }
  }
  if (restoreError) {
    throw new Error(`machine_review 审核门禁恢复失败，立即停止：${restoreError.message}`);
  }
  if (migrationError) throw migrationError;

  const verificationCases = asList(await request(
    'GET',
    `/api/pipelines/${encodeURIComponent(pipeline.id)}/cases`,
  )).map(unwrapCase).filter((item) =>
    item.caseKey === normalizedCampaignId || item.caseKey?.startsWith(`${normalizedCampaignId}:`),
  );
  const verificationScope = buildCampaignScope(
    verificationCases,
    normalizedCampaignId,
    normalizedExpectedCount,
  );
  if (verificationScope.parent.stageKey !== 'draft') throw new Error('迁移后父 Case 未处于 draft');
  if (verificationScope.descendants.some((item) =>
    item.stageKey !== 'cancelled' && item.terminalKind !== 'cancelled',
  )) {
    throw new Error('迁移后仍有执行子 Case 未进入 cancelled');
  }
  const verificationIssues = await listAllIssues(request, company.id);
  const remainingActive = buildIssueScope({
    issues:verificationIssues,
    caseIds:new Set(verificationCases.map((item) => item.id)),
    projectId:pipelineDetail.projectId,
    expectedCount:normalizedExpectedCount,
    parent:verificationScope.parent,
  });
  const activeScopedIssues = [
    ...remainingActive.issues,
    ...remainingActive.recoveryIssues,
  ].filter((item) => item.status !== 'cancelled');
  if (activeScopedIssues.length > 0) {
    throw new Error(`迁移后仍有 ${activeScopedIssues.length} 条 Routine Issue 未取消`);
  }

  return resultView({
    mode:'applied',
    company,
    pipeline:pipelineDetail,
    campaignId:normalizedCampaignId,
    scope:verificationScope,
    issueScope:{ ...issueScope, issues:verificationIssues.filter((issue) =>
      issueScope.issues.some((scoped) => scoped.id === issue.id),
    ) },
    reviewGate,
    generatedAt,
    mutations,
  });
}

function buildCampaignScope(cases, campaignId, expectedCount) {
  if (cases.length !== expectedCount) {
    throw new Error(`campaign ${campaignId} 的 Case 数必须精确为 ${expectedCount}，当前为 ${cases.length}`);
  }
  const parentMatches = cases.filter((item) => item.caseKey === campaignId && !item.parentCaseId);
  if (parentMatches.length !== 1) throw new Error(`campaign 父 Case 必须唯一，当前为 ${parentMatches.length}`);
  const parent = parentMatches[0];
  const days = cases.filter((item) =>
    item.parentCaseId === parent.id
    && item.caseKey?.match(new RegExp(`^${escapeRegExp(campaignId)}:\\d{4}-\\d{2}-\\d{2}$`)),
  ).sort(compareScheduledDate);
  const dayIds = new Set(days.map((item) => item.id));
  const platformCases = cases.filter((item) =>
    dayIds.has(item.parentCaseId)
    && ['douyin', 'xiaohongshu'].includes(item.fields?.platform),
  );
  if (days.length !== 7 || platformCases.length !== 14) {
    throw new Error(`campaign Case 层级必须是1父+7日+14平台，当前为1+${days.length}+${platformCases.length}`);
  }
  for (const day of days) {
    const children = platformCases.filter((item) => item.parentCaseId === day.id);
    if (
      children.length !== 2
      || new Set(children.map((item) => item.fields?.platform)).size !== 2
    ) {
      throw new Error(`日期 ${day.fields?.scheduledDate || day.caseKey} 必须精确包含双平台 Case`);
    }
  }
  return { parent, days, platformCases, descendants:[...days, ...platformCases] };
}

function buildIssueScope({ issues, caseIds, projectId, expectedCount, parent }) {
  const scoped = [];
  for (const issue of issues) {
    if (issue.originKind !== 'routine_execution' || issue.projectId !== projectId) continue;
    const description = String(issue.description || '');
    const routineKey = description.match(ROUTINE_MARKER)?.[1] || null;
    if (!routineKey) continue;
    const caseId = description.match(CASE_ID_MARKER)?.[1] || null;
    if (!caseId || !caseIds.has(caseId)) continue;
    scoped.push({ ...issue, campaignCaseId:caseId, routineKey });
  }
  let originalIssues = scoped;
  let recoveryIssues = [];
  if (scoped.length !== expectedCount) {
    const migration = parent?.fields?.draftMigration;
    const migratedAt = Date.parse(migration?.migratedAt);
    if (
      migration?.schemaVersion !== MIGRATION_SCHEMA
      || migration.expectedIssueCount !== expectedCount
      || !Number.isFinite(migratedAt)
    ) {
      throw new Error(`精确 Routine Issue 数必须为 ${expectedCount}，当前为 ${scoped.length}`);
    }
    originalIssues = scoped.filter((item) => {
      const createdAt = Date.parse(item.createdAt);
      return Number.isFinite(createdAt) && createdAt < migratedAt;
    });
    recoveryIssues = scoped.filter((item) => !originalIssues.includes(item));
    if (recoveryIssues.some((item) =>
      item.campaignCaseId !== parent.id || item.routineKey !== 'm5-topic',
    )) {
      throw new Error('迁移后新增 Issue 不符合父draft旧自动推进恢复范围，拒绝扩大迁移');
    }
  }
  if (originalIssues.length !== expectedCount) {
    throw new Error(`原始 Routine Issue 数必须为 ${expectedCount}，当前为 ${originalIssues.length}`);
  }
  if (new Set(originalIssues.map((item) => item.campaignCaseId)).size !== expectedCount) {
    throw new Error('Routine Issue 必须与 campaign Case 一一对应，拒绝迁移');
  }
  return {
    issues:originalIssues.sort((a, b) => String(a.identifier).localeCompare(String(b.identifier))),
    recoveryIssues:recoveryIssues.sort((a, b) => String(a.identifier).localeCompare(String(b.identifier))),
  };
}

function campaignPlanFromCases(days) {
  return {
    schemaVersion:PLAN_SCHEMA,
    startDate:days[0].fields.scheduledDate,
    themes:days.map((item) => String(item.fields?.theme || '').trim()),
  };
}

function assertSafeDraftStage(pipeline) {
  const draft = asList(pipeline?.stages).find((item) => item.key === 'draft');
  if (!draft || draft.kind !== 'working' || draft.config?.onEnter) {
    throw new Error('live Pipeline 尚未安装无 onEnter Routine 的 draft 阶段');
  }
}

function inspectMachineReviewGate(pipeline, platformCases) {
  const stages = asList(pipeline?.stages);
  const matches = stages.filter((item) => item.key === 'machine_review');
  if (matches.length !== 1 || !matches[0].id) {
    throw new Error(`machine_review stage 必须唯一且有稳定ID，当前为 ${matches.length}`);
  }
  const stage = matches[0];
  if (
    stage.kind !== 'review'
    || stage.config?.requireApproval !== true
    || stage.config?.onEnter == null
    || stage.config?.approveToStageKey !== 'platform_adapt'
    || stage.config?.requestChangesToStageKey !== 'script'
    || stage.config?.rejectToStageKey !== 'script'
  ) {
    throw new Error('machine_review 审核门禁或路由不符合声明，拒绝临时迁移');
  }
  if (platformCases.some((item) =>
    item.stageKey !== 'machine_review'
    && item.stageKey !== 'cancelled'
    && item.terminalKind !== 'cancelled',
  )) {
    throw new Error('14个平台 Case 未全部位于 machine_review 或 cancelled，拒绝迁移');
  }
  const originalConfig = structuredClone(stage.config);
  return {
    stageId:stage.id,
    stageKey:stage.key,
    configHash:hashJson(originalConfig),
    governanceConfigHash:hashJson(withoutServerDerivedRoutineRevision(originalConfig)),
    originalConfig,
    restored:false,
    restoredConfigHash:null,
    restoredGovernanceConfigHash:null,
    serverDerivedDriftPaths:[],
    sourceConfigHash:null,
    normalized:false,
  };
}

async function normalizeMachineReviewGate(request, pipelineId, reviewGate) {
  const sourceConfig = structuredClone(reviewGate.originalConfig);
  const sourceConfigHash = reviewGate.configHash;
  await request(
    'PATCH',
    `/api/pipelines/${encodeURIComponent(pipelineId)}/stages/${encodeURIComponent(reviewGate.stageId)}`,
    { config:sourceConfig },
  );
  const normalizedPipeline = await request('GET', `/api/pipelines/${encodeURIComponent(pipelineId)}`);
  const normalizedStage = asList(normalizedPipeline.stages)
    .find((item) => item.id === reviewGate.stageId && item.key === reviewGate.stageKey);
  if (!normalizedStage) throw new Error('machine_review no-op规范化后找不到原stage');
  assertReviewSecurityFieldsEqual(sourceConfig, normalizedStage.config);
  reviewGate.sourceConfigHash = sourceConfigHash;
  reviewGate.originalConfig = structuredClone(normalizedStage.config);
  reviewGate.configHash = hashJson(reviewGate.originalConfig);
  reviewGate.governanceConfigHash = hashJson(withoutServerDerivedRoutineRevision(reviewGate.originalConfig));
  reviewGate.normalized = true;
}

function assertReviewSecurityFieldsEqual(expected, actual) {
  const pick = (config) => ({
    requireApproval:config?.requireApproval,
    approver:config?.approver,
    approveToStageKey:config?.approveToStageKey,
    requestChangesToStageKey:config?.requestChangesToStageKey,
    rejectToStageKey:config?.rejectToStageKey,
    onEnter:config?.onEnter,
  });
  if (hashJson(pick(expected)) !== hashJson(pick(actual))) {
    throw new Error('machine_review no-op规范化改变了审核人、审核路由或onEnter，拒绝迁移');
  }
}

async function setMachineReviewApproval(request, pipelineId, reviewGate, restore) {
  const config = restore
    ? structuredClone(reviewGate.originalConfig)
    : { ...structuredClone(reviewGate.originalConfig), requireApproval:false };
  if (!restore) {
    const changedKeys = Object.keys(config).filter((key) =>
      hashJson(config[key]) !== hashJson(reviewGate.originalConfig[key]),
    );
    if (changedKeys.length !== 1 || changedKeys[0] !== 'requireApproval') {
      throw new Error('临时门禁变更只能修改 requireApproval');
    }
  }
  await request(
    'PATCH',
    `/api/pipelines/${encodeURIComponent(pipelineId)}/stages/${encodeURIComponent(reviewGate.stageId)}`,
    { config },
  );
}

function assertDraftGrant(parent) {
  const grant = parent.fields?.campaignGrant;
  if (
    grant?.schemaVersion !== 'agent.army/campaign-grant/v1'
    || grant.status !== 'draft'
    || grant.approvedAt !== null
  ) {
    throw new Error('仅允许迁移未批准且状态为 draft 的 CampaignGrant');
  }
}

function assertSameCase(current, expected) {
  if (
    !current
    || current.id !== expected.id
    || current.pipelineId !== expected.pipelineId
    || current.caseKey !== expected.caseKey
  ) {
    throw new Error(`Case 身份漂移，拒绝写入：${expected.caseKey}`);
  }
}

async function listAllIssues(request, companyId) {
  const result = [];
  let offset = 0;
  while (true) {
    const page = asList(await request(
      'GET',
      `/api/companies/${encodeURIComponent(companyId)}/issues?limit=${PAGE_SIZE}&offset=${offset}&sortField=updated&sortDir=asc`,
    ));
    result.push(...page);
    if (page.length < PAGE_SIZE) return result;
    offset += page.length;
  }
}

function createAuditedRequest({ origin, fetchImpl, allowWrites, mutations }) {
  return async (method, path, body) => {
    const normalizedMethod = String(method).toUpperCase();
    if (normalizedMethod !== 'GET' && !allowWrites) {
      throw new Error(`dry-run 拒绝 Paperclip 写请求：${normalizedMethod}`);
    }
    if (normalizedMethod === 'DELETE') throw new Error('迁移禁止删除 Paperclip 记录');
    if (normalizedMethod !== 'GET') mutations.push({ method:normalizedMethod, path });
    const response = await fetchImpl(`${origin}${path}`, {
      method:normalizedMethod,
      headers:{
        accept:'application/json',
        ...(body === undefined ? {} : { 'content-type':'application/json' }),
      },
      ...(body === undefined ? {} : { body:JSON.stringify(body) }),
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!response.ok) throw new Error(`Paperclip ${normalizedMethod} ${path} 失败: HTTP ${response.status}`);
    return parsed;
  };
}

function createAdapterFetch(origin, request) {
  return async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.origin !== origin) throw new Error('适配器请求越出已核验 loopback Paperclip');
    const value = await request(
      options.method || 'GET',
      `${parsed.pathname}${parsed.search}`,
      options.body === undefined ? undefined : JSON.parse(options.body),
    );
    return {
      ok:true,
      status:200,
      async text() { return value == null ? '' : JSON.stringify(value); },
    };
  };
}

function resultView({
  mode,
  company,
  pipeline,
  campaignId,
  scope,
  issueScope,
  reviewGate,
  generatedAt,
  mutations,
}) {
  return {
    mode,
    generatedAt,
    company:{ id:company.id, name:company.name },
    pipeline:{ id:pipeline.id, key:pipeline.key, projectId:pipeline.projectId },
    campaign:{
      campaignId,
      parentCaseId:scope.parent.id,
      parentStage:scope.parent.stageKey,
      caseCount:1 + scope.descendants.length,
      dayCaseCount:scope.days.length,
      platformCaseCount:scope.platformCases.length,
    },
    issues:{
      count:issueScope.issues.length,
      identifiers:issueScope.issues.map((item) => item.identifier),
      statuses:Object.fromEntries([...new Set(issueScope.issues.map((item) => item.status))]
        .map((status) => [status, issueScope.issues.filter((item) => item.status === status).length])),
      recoveryCount:issueScope.recoveryIssues.length,
      recoveryIdentifiers:issueScope.recoveryIssues.map((item) => item.identifier),
    },
    reviewGate:{
      stageId:reviewGate.stageId,
      sourceConfigHash:reviewGate.sourceConfigHash,
      configHash:reviewGate.configHash,
      governanceConfigHash:reviewGate.governanceConfigHash,
      normalized:reviewGate.normalized,
      restored:reviewGate.restored,
      restoredConfigHash:reviewGate.restoredConfigHash,
      restoredGovernanceConfigHash:reviewGate.restoredGovernanceConfigHash,
      serverDerivedDriftPaths:reviewGate.serverDerivedDriftPaths,
    },
    safety:{
      deletedRecords:0,
      mutationCount:mutations.length,
      mutations,
    },
  };
}

function unwrapCase(value) {
  const item = value?.case ?? value;
  const stageKey = value?.stage?.key ?? item?.stageKey ?? null;
  return item && typeof item === 'object' ? { ...item, stageKey } : null;
}

function asList(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.cases)) return value.cases;
  return [];
}

function compareScheduledDate(a, b) {
  return String(a.fields?.scheduledDate).localeCompare(String(b.fields?.scheduledDate));
}

function assertLoopbackApiBase(apiBase) {
  const url = new URL(apiBase);
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error('草案迁移只允许连接 loopback Paperclip');
  }
  return url.origin;
}

function normalizeCampaignId(value) {
  const campaignId = String(value || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(campaignId)) throw new Error('campaignId 无效');
  return campaignId;
}

function normalizeExpectedCount(value) {
  const count = Number(value);
  if (count !== 22) throw new Error('expectedCount 必须明确且精确为22');
  return count;
}

function normalizeDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('now 必须是有效时间');
  return date;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hashJson(value) {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function withoutServerDerivedRoutineRevision(value) {
  const result = structuredClone(value);
  if (result?.automation && typeof result.automation === 'object') {
    delete result.automation.latestRoutineRevisionId;
    delete result.automation.latestRoutineRevisionNumber;
  }
  return result;
}

function diffJsonPaths(left, right, prefix = '') {
  if (stableJson(left) === stableJson(right)) return [];
  const leftObject = left && typeof left === 'object' && !Array.isArray(left);
  const rightObject = right && typeof right === 'object' && !Array.isArray(right);
  if (!leftObject || !rightObject) return [prefix || '$'];
  const paths = [];
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    paths.push(...diffJsonPaths(
      left[key],
      right[key],
      prefix ? `${prefix}.${key}` : key,
    ));
  }
  return paths;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--apply') values.apply = true;
    else if (token.startsWith('--')) values[token.slice(2)] = argv[++index];
  }
  return {
    apiBase:values.apiBase,
    companyName:values.companyName,
    campaignId:values.campaignId,
    expectedCount:values.expectedCount,
    apply:values.apply === true,
    confirmation:values.confirmation,
  };
}

async function main() {
  const result = await migrateM5DraftZeroWake(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node

import { createHash } from 'node:crypto';

import {
  asPaperclipList,
  createPaperclipLoopbackClient,
  validDate,
} from './support/paperclip-loopback-client.mjs';

const DEFAULT_API_BASE = 'http://127.0.0.1:3100';
const DEFAULT_COMPANY_NAME = 'Agent军团';
const DEFAULT_LIMIT = 5000;
const MAX_LIMIT = 5000;
const PAGE_SIZE = 200;
const PENDING_STATUSES = ['blocked', 'in_review', 'todo', 'backlog'];
const RULES_VERSION = 'paperclip-blocked-pending-v1';
const ARCHIVE_PLAN_VERSION = 'paperclip-historical-acceptance-archive-v1';
const ARCHIVE_CONFIRM_PREFIX = 'ARCHIVE:';
const MAX_ARCHIVE_ITEMS = 25;
const HISTORICAL_AFTER_MS = 24 * 60 * 60 * 1000;
const CLASSIFIER_LIST_ENVELOPES = ['items', 'actions'];

const ACCEPTANCE_PATTERN = /(?:验收|回归|测试|演练|沙箱|合成数据|acceptance|regression|test(?:ing)?|drill|sandbox|synthetic|dry[\s_-]?run|canary)/i;
const INCIDENT_PATTERN = /(?:故障|事故|失败|异常|崩溃|超时|不可用|恢复|incident|outage|failure|failed|error|crash|timeout|unavailable|recovery)/i;
const DECISION_PATTERN = /(?:待审批|待审核|待确认|需决定|需要决定|人工决定|approval|decision[\s_-]?required|human[\s_-]?review)/i;
const LIVE_EXECUTION_STATES = new Set(['queued', 'running', 'in_progress', 'active', 'retrying', 'recovering']);

export async function classifyBlockedPendingIssues({
  apiBase = DEFAULT_API_BASE,
  companyName = DEFAULT_COMPANY_NAME,
  limit = DEFAULT_LIMIT,
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  const boundedLimit = normalizeLimit(limit);
  const requestAudit = [];
  const guardedFetch = createReadOnlyFetch(fetchImpl, requestAudit);
  const client = createPaperclipLoopbackClient({
    apiBase,
    fetchImpl:guardedFetch,
    operation:'待办分类 dry-run',
  });
  const companies = asPaperclipList(
    await client.request('GET', '/api/companies'),
    CLASSIFIER_LIST_ENVELOPES,
  );
  const company = companies.find((item) => item.name === companyName);
  if (!company) throw new Error(`Paperclip 中未找到公司：${companyName}`);
  if (!company.id) throw new Error('companyId 必填');

  const [agentsPayload, issuesPayload] = await Promise.all([
    client.request('GET', `/api/companies/${encodeURIComponent(company.id)}/agents`),
    listPendingIssues(client, company.id, boundedLimit),
  ]);
  const agentsById = new Map(
    asPaperclipList(agentsPayload, CLASSIFIER_LIST_ENVELOPES)
      .map((agent) => [agent.id, agent]),
  );
  const nowDate = normalizeDate(now, 'now');
  const items = issuesPayload.items
    .map((issue) => classifyIssue(issue, { agentsById, now: nowDate }));
  const counts = Object.fromEntries(
    ['historical_acceptance', 'active_incident', 'decision_required', 'unresolved']
      .map((classification) => [
        classification,
        items.filter((item) => item.classification === classification).length,
      ]),
  );

  return {
    mode: 'dry-run',
    readOnly: true,
    rulesVersion: RULES_VERSION,
    generatedAt: nowDate.toISOString(),
    company: { id: company.id, name: company.name },
    queriedStatuses: [...PENDING_STATUSES],
    summary: {
      total: items.length,
      possiblyTruncated: issuesPayload.possiblyTruncated,
      ...counts,
    },
    items,
    safety: {
      writesToLivePaperclip: false,
      allowedMethods: ['GET'],
      readRequests: requestAudit.length,
      mutationRequests: 0,
      appliedActions: 0,
    },
  };
}

export function buildHistoricalAcceptanceArchivePlan(
  classificationResult,
  { identifiers } = {},
) {
  if (classificationResult?.mode !== 'dry-run' || classificationResult?.readOnly !== true) {
    throw new Error('归档计划只能基于只读 dry-run 结果生成');
  }
  const selected = normalizeIdentifiers(identifiers);
  if (selected.length > MAX_ARCHIVE_ITEMS) {
    throw new Error(`单次归档最多 ${MAX_ARCHIVE_ITEMS} 条，拒绝扩大批量范围`);
  }
  const byIdentifier = new Map(
    classificationResult.items.map((item) => [item.identifier, item]),
  );
  const items = selected.map((identifier) => {
    const item = byIdentifier.get(identifier);
    if (!item) throw new Error(`待归档 Issue 不在当前 blocked/pending 快照中：${identifier}`);
    if (item.classification !== 'historical_acceptance') {
      throw new Error(`只允许归档 historical_acceptance：${identifier} 当前为 ${item.classification}`);
    }
    if (item.status === 'in_review' || item.evidence.includes('active_recovery_action')) {
      throw new Error(`待归档 Issue 仍有审批或恢复信号：${identifier}`);
    }
    return {
      issueId: item.issueId,
      identifier: item.identifier,
      expectedStatus: item.status,
      expectedUpdatedAt: item.updatedAt,
      classification: item.classification,
      action: 'cancel_and_hide_from_pending',
    };
  });
  const digest = digestArchivePlan({
    planVersion: ARCHIVE_PLAN_VERSION,
    rulesVersion: classificationResult.rulesVersion,
    companyId: classificationResult.company.id,
    items,
  });
  return {
    mode: 'archive-plan',
    planVersion: ARCHIVE_PLAN_VERSION,
    rulesVersion: classificationResult.rulesVersion,
    generatedAt: classificationResult.generatedAt,
    company: classificationResult.company,
    items,
    digest,
    requiredConfirmation: `${ARCHIVE_CONFIRM_PREFIX}${digest}`,
    safety: {
      explicitIdentifiersRequired: true,
      maxItems: MAX_ARCHIVE_ITEMS,
      deletesRecords: false,
      preservesCommentsAndIssueHistory: true,
      applyRequiresFreshSnapshotMatch: true,
    },
  };
}

export async function applyHistoricalAcceptanceArchive({
  apiBase = DEFAULT_API_BASE,
  companyName = DEFAULT_COMPANY_NAME,
  identifiers,
  confirmation,
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  const dryRun = await classifyBlockedPendingIssues({
    apiBase,
    companyName,
    fetchImpl,
    now,
  });
  const plan = buildHistoricalAcceptanceArchivePlan(dryRun, { identifiers });
  if (confirmation !== plan.requiredConfirmation) {
    throw new Error('归档确认值与当前快照不匹配；请重新执行 dry-run 并使用最新 requiredConfirmation');
  }

  const client = createPaperclipLoopbackClient({
    apiBase,
    fetchImpl,
    operation:'待办分类 dry-run',
  });
  const preflight = [];
  for (const item of plan.items) {
    const current = await client.request(
      'GET',
      `/api/issues/${encodeURIComponent(item.issueId)}`,
    );
    const classified = classifyIssue(current, { now });
    if (
      current.identifier !== item.identifier
      || current.status !== item.expectedStatus
      || current.updatedAt !== item.expectedUpdatedAt
      || classified.classification !== 'historical_acceptance'
    ) {
      throw new Error(`Issue ${item.identifier} 在 apply 前发生漂移，未执行任何归档`);
    }
    preflight.push(current);
  }

  const applied = [];
  for (const item of plan.items) {
    const response = await client.request(
      'PATCH',
      `/api/issues/${encodeURIComponent(item.issueId)}`,
      { body:{
        status: 'cancelled',
        comment: `[agent-army:m5:historical-acceptance-archive:v1] ${item.identifier} 已经人工选入历史验收归档；保留 Issue、评论和运行证据，不删除记录。`,
      } },
    );
    if (response?.status !== 'cancelled') {
      throw new Error(`Issue ${item.identifier} 未确认进入 cancelled，停止后续归档`);
    }
    applied.push({
      issueId: item.issueId,
      identifier: item.identifier,
      previousStatus: item.expectedStatus,
      status: response.status,
      rollback: {
        method: 'PATCH',
        path: `/api/issues/${item.issueId}`,
        status: item.expectedStatus,
        requiresSeparateReview: true,
      },
    });
  }

  return {
    mode: 'applied',
    planVersion: plan.planVersion,
    digest: plan.digest,
    company: plan.company,
    applied,
    safety: {
      preflightReads: preflight.length,
      mutationRequests: applied.length,
      deleteRequests: 0,
      recordsDeleted: 0,
      commentsAndIssueHistoryPreserved: true,
    },
  };
}

async function listPendingIssues(client, companyId, maxItems) {
  const items = [];
  let offset = 0;
  let possiblyTruncated = false;
  while (items.length < maxItems) {
    const pageSize = Math.min(PAGE_SIZE, maxItems - items.length);
    const page = asPaperclipList(
      await client.request(
        'GET',
        `/api/companies/${encodeURIComponent(companyId)}/issues?status=${encodeURIComponent(PENDING_STATUSES.join(','))}&limit=${pageSize}&offset=${offset}&sortField=updated&sortDir=desc`,
      ),
      CLASSIFIER_LIST_ENVELOPES,
    );
    items.push(...page);
    offset += page.length;
    if (page.length < pageSize) return { items, possiblyTruncated: false };
    if (page.length === 0) return { items, possiblyTruncated: false };
  }
  possiblyTruncated = true;
  return { items, possiblyTruncated };
}

export function classifyIssue(issue, { agentsById = new Map(), now = new Date() } = {}) {
  if (!issue?.id) throw new Error('issue.id 必填');
  const normalizedNow = normalizeDate(now, 'now');
  const titleText = stringifyForMatch(issue.title);
  const classificationText = [
    issue.title,
    issue.originKind,
  ].filter(Boolean).map(stringifyForMatch).join(' ');
  const pendingApproval = issue.status === 'in_review' || DECISION_PATTERN.test(titleText);
  const activeRecovery = issue.activeRecoveryAction ?? null;
  const liveExecution = hasLiveExecutionState(issue.executionState);
  const fresh = isFresh(issue.updatedAt ?? issue.createdAt, normalizedNow);
  const incidentSignal = Boolean(activeRecovery)
    || liveExecution
    || (issue.status === 'blocked' && fresh && INCIDENT_PATTERN.test(titleText));
  const historicalAcceptance = !incidentSignal
    && ACCEPTANCE_PATTERN.test(classificationText)
    && !isFresh(issue.updatedAt ?? issue.createdAt, normalizedNow);

  let classification = 'unresolved';
  const evidence = [];
  if (pendingApproval) {
    classification = 'decision_required';
    evidence.push(issue.status === 'in_review' ? 'status_in_review' : 'explicit_decision_signal');
  } else if (incidentSignal) {
    classification = 'active_incident';
    if (activeRecovery) evidence.push('active_recovery_action');
    if (liveExecution) evidence.push('live_execution_state');
    if (!activeRecovery && !liveExecution) evidence.push('fresh_incident_signal');
  } else if (historicalAcceptance) {
    classification = 'historical_acceptance';
    evidence.push('acceptance_signal', 'inactive_over_24h');
  } else {
    evidence.push('no_active_recovery_or_decision_evidence');
  }

  const owner = resolveOwner(issue, activeRecovery, agentsById);
  return {
    issueId: issue.id,
    identifier: issue.identifier ?? null,
    title: redactDisplayText(issue.title ?? '(无标题)'),
    status: issue.status ?? 'unknown',
    classification,
    owner,
    recoveryAction: buildRecoveryAction(classification, owner),
    evidence,
    updatedAt: issue.updatedAt ?? null,
  };
}

function resolveOwner(issue, activeRecovery, agentsById) {
  if (activeRecovery?.ownerAgentId) {
    return agentOwner(activeRecovery.ownerAgentId, agentsById, 'active_recovery_action');
  }
  if (activeRecovery?.ownerUserId) {
    return userOwner(activeRecovery.ownerUserId, 'active_recovery_action');
  }
  if (issue.responsibleUserId) {
    return userOwner(issue.responsibleUserId, 'responsible_user');
  }
  if (issue.assigneeUserId) {
    return userOwner(issue.assigneeUserId, 'assignee_user');
  }
  if (issue.assigneeAgentId) {
    return agentOwner(issue.assigneeAgentId, agentsById, 'assignee_agent');
  }
  return {
    kind: 'agent_role',
    id: 'ajun',
    label: 'A君（待分派）',
    source: 'triage_fallback',
  };
}

function buildRecoveryAction(classification, owner) {
  const ownerLabel = owner.label;
  const actions = {
    historical_acceptance: {
      code: 'review_historical_acceptance',
      instruction: `${ownerLabel} 对照原验收证据确认“已完成”或“需要重测”，只提交处置结论，不归档、不删除。`,
    },
    active_incident: {
      code: 'inspect_active_recovery',
      instruction: `${ownerLabel} 核对最新运行与恢复证据，只选择一次安全恢复或升级技术专家，不自动重试。`,
    },
    decision_required: {
      code: 'complete_pending_decision',
      instruction: `${ownerLabel} 完成当前审批或人工决定；决定前保持任务、权限和状态不变。`,
    },
    unresolved: {
      code: 'assign_owner_and_one_action',
      instruction: `${ownerLabel} 指定唯一执行负责人和一个可验证恢复动作；本次 dry-run 不改变状态。`,
    },
  };
  return { ...actions[classification], writesLive: false };
}

function agentOwner(agentId, agentsById, source) {
  const agent = agentsById.get(agentId);
  return {
    kind: 'agent',
    id: agentId,
    label: redactDisplayText(agent?.name ?? `Agent ${shortId(agentId)}`),
    source,
  };
}

function userOwner(userId, source) {
  return {
    kind: 'user',
    id: userId,
    label: `负责人 ${shortId(userId)}`,
    source,
  };
}

function createReadOnlyFetch(fetchImpl, requestAudit) {
  return async (url, options = {}) => {
    const method = String(options.method ?? 'GET').toUpperCase();
    if (method !== 'GET' || options.body !== undefined) {
      throw new Error(`只读 dry-run 拒绝 Paperclip 写请求：${method}`);
    }
    requestAudit.push({ method, path: new URL(url).pathname });
    return fetchImpl(url, { ...options, method: 'GET' });
  };
}

function normalizeLimit(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error('limit 必须是正整数');
  return Math.min(number, MAX_LIMIT);
}

function normalizeDate(value, field) {
  const result = validDate(value);
  if (!result) throw new Error(`${field} 必须是有效时间`);
  return result;
}

function isFresh(value, now) {
  if (!value) return false;
  const date = validDate(value);
  if (!date) return false;
  const age = now.getTime() - date.getTime();
  return age >= 0 && age < HISTORICAL_AFTER_MS;
}

function stringifyForMatch(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function hasLiveExecutionState(value) {
  if (!value) return false;
  if (typeof value === 'string') return LIVE_EXECUTION_STATES.has(value.trim().toLowerCase());
  if (typeof value !== 'object') return false;
  return [
    value.status,
    value.state,
    value.runStatus,
    value.executionStatus,
  ].some((state) => typeof state === 'string' && LIVE_EXECUTION_STATES.has(state.trim().toLowerCase()));
}

function redactDisplayText(value) {
  return String(value)
    .replace(/\b(authorization|token|secret|password|cookie|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\/Users\/[^/\s]+/g, '/Users/[REDACTED]');
}

function shortId(value) {
  const text = String(value);
  return text.length > 8 ? text.slice(0, 8) : text;
}

function normalizeIdentifiers(value) {
  const items = Array.isArray(value)
    ? value
    : String(value ?? '').split(',');
  const normalized = items.map((item) => String(item).trim()).filter(Boolean);
  if (normalized.length === 0) throw new Error('必须显式提供至少一个 Issue identifier');
  if (new Set(normalized).size !== normalized.length) throw new Error('Issue identifier 不得重复');
  if (normalized.some((item) => !/^[A-Za-z][A-Za-z0-9_-]*-\d+$/.test(item))) {
    throw new Error('Issue identifier 格式无效');
  }
  return normalized;
}

function digestArchivePlan(plan) {
  return createHash('sha256')
    .update(JSON.stringify(plan))
    .digest('hex');
}

function parseCliArgs(argv) {
  const values = {};
  let apply = false;
  for (const arg of argv) {
    if (arg === '--apply') {
      apply = true;
      continue;
    }
    const match = /^--(api-base|company|limit|identifiers|confirm)=(.+)$/.exec(arg);
    if (!match) throw new Error(`不支持的参数：${arg}`);
    values[match[1]] = match[2];
  }
  return {
    apiBase: values['api-base'] ?? DEFAULT_API_BASE,
    companyName: values.company ?? DEFAULT_COMPANY_NAME,
    limit: values.limit ?? DEFAULT_LIMIT,
    identifiers: values.identifiers,
    confirmation: values.confirm,
    apply,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseCliArgs(process.argv.slice(2));
  const operation = options.apply
    ? applyHistoricalAcceptanceArchive(options)
    : classifyBlockedPendingIssues(options).then((result) =>
      options.identifiers
        ? { ...result, archivePlan:buildHistoricalAcceptanceArchivePlan(result, options) }
        : result
    );
  operation
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

#!/usr/bin/env node

import {
  createPaperclipLoopbackClient,
  validDate,
} from './support/paperclip-loopback-client.mjs';
import { PaperclipOperationsHealthCatalog } from './support/paperclip-operations-health-catalog.mjs';

const DEFAULT_API_BASE = 'http://127.0.0.1:3100';
const DEFAULT_COMPANY_NAME = 'Agent军团';
const DEFAULT_LIMIT = 5000;
const CLASSIFIER_LIST_ENVELOPES = ['items', 'actions'];
const CATALOG = new PaperclipOperationsHealthCatalog();

export async function classifyBlockedPendingIssues({
  apiBase = DEFAULT_API_BASE,
  companyName = DEFAULT_COMPANY_NAME,
  limit = DEFAULT_LIMIT,
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  const boundedLimit = CATALOG.normalizePendingLimit(limit);
  const requestAudit = [];
  const guardedFetch = createReadOnlyFetch(fetchImpl, requestAudit);
  const client = createPaperclipLoopbackClient({
    apiBase,
    fetchImpl: guardedFetch,
    operation: '待办分类 dry-run',
  });
  const catalog = new PaperclipOperationsHealthCatalog({ client, companyName });
  const company = await catalog.requireCompany(CLASSIFIER_LIST_ENVELOPES);

  const [agentsPayload, issuesPayload] = await Promise.all([
    client.request('GET', `/api/companies/${encodeURIComponent(company.id)}/agents`),
    catalog.listIssues({
      companyId: company.id,
      statuses: catalog.pendingStatuses,
      maxItems: boundedLimit,
      sortField: 'updated',
      sortDir: 'desc',
      envelopeKeys: CLASSIFIER_LIST_ENVELOPES,
    }),
  ]);
  const agentsById = new Map(
    catalog.list(agentsPayload, CLASSIFIER_LIST_ENVELOPES)
      .map((agent) => [agent.id, agent]),
  );
  const nowDate = normalizeDate(now, 'now');
  const items = issuesPayload.items
    .map((issue) => catalog.classifyIssue(issue, { agentsById, now:nowDate }));
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
    rulesVersion: catalog.rulesVersion,
    generatedAt: nowDate.toISOString(),
    company: { id:company.id, name:company.name },
    queriedStatuses: catalog.pendingStatuses,
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

export function buildHistoricalAcceptanceArchivePlan(classificationResult, options) {
  return CATALOG.buildHistoricalAcceptanceArchivePlan(classificationResult, options);
}

export function classifyIssue(issue, options) {
  return CATALOG.classifyIssue(issue, options);
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
  const plan = CATALOG.buildHistoricalAcceptanceArchivePlan(dryRun, { identifiers });
  if (confirmation !== plan.requiredConfirmation) {
    throw new Error('归档确认值与当前快照不匹配；请重新执行 dry-run 并使用最新 requiredConfirmation');
  }

  const client = createPaperclipLoopbackClient({
    apiBase,
    fetchImpl,
    operation: '待办分类 dry-run',
  });
  const preflight = [];
  for (const item of plan.items) {
    const current = await client.request(
      'GET',
      `/api/issues/${encodeURIComponent(item.issueId)}`,
    );
    const classified = CATALOG.classifyIssue(current, { now });
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
      { body: {
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

function createReadOnlyFetch(fetchImpl, requestAudit) {
  return async (url, options = {}) => {
    const method = String(options.method ?? 'GET').toUpperCase();
    if (method !== 'GET' || options.body !== undefined) {
      throw new Error(`只读 dry-run 拒绝 Paperclip 写请求：${method}`);
    }
    requestAudit.push({ method, path:new URL(url).pathname });
    return fetchImpl(url, { ...options, method:'GET' });
  };
}

function normalizeDate(value, field) {
  const result = validDate(value);
  if (!result) throw new Error(`${field} 必须是有效时间`);
  return result;
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

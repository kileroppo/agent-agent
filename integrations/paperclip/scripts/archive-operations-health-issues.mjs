#!/usr/bin/env node

import { createHash } from 'node:crypto';

const DEFAULT_API_BASE = 'http://127.0.0.1:3100';
const DEFAULT_COMPANY_NAME = 'Agent军团';
const ROUTINE_TITLE = 'A君定时本机巡检';
const ROUTINE_MARKER = 'agent-army:operations-health-v1';
const PAGE_SIZE = 200;
const MIN_SUCCESSORS = 3;
const CONFIRM_PREFIX = 'ARCHIVE_OPERATIONS_HEALTH:';

export async function planOperationsHealthArchive({
  apiBase = DEFAULT_API_BASE,
  companyName = DEFAULT_COMPANY_NAME,
  fetchImpl = fetch,
  minSuccessors = MIN_SUCCESSORS,
} = {}) {
  const origin = assertLoopbackApiBase(apiBase);
  const companies = asList(await requestJson(fetchImpl, `${origin}/api/companies`));
  const company = companies.find((item) => item.name === companyName);
  if (!company) throw new Error(`Paperclip 中未找到公司：${companyName}`);
  const issues = await listIssues(fetchImpl, origin, company.id);
  const health = issues
    .filter(isOperationsHealthIssue)
    .filter((issue) => !issue.hiddenAt)
    .sort((left, right) => timestamp(left.createdAt) - timestamp(right.createdAt));
  const items = health.flatMap((issue, index) => {
    if (issue.status === 'done') return [archiveItem(issue, 'completed_system_check')];
    if (issue.status !== 'blocked') return [];
    const laterSuccesses = health.slice(index + 1).filter((candidate) => candidate.status === 'done').length;
    return laterSuccesses >= minSuccessors
      ? [archiveItem(issue, 'superseded_failure', { laterSuccesses })]
      : [];
  });
  const digest = createHash('sha256').update(JSON.stringify({
    schemaVersion:1,
    companyId:company.id,
    minSuccessors,
    items,
  })).digest('hex');
  return {
    mode:'plan',
    readOnly:true,
    company:{ id:company.id, name:company.name },
    routine:{ title:ROUTINE_TITLE, marker:ROUTINE_MARKER },
    minSuccessors,
    summary:{
      visibleHealthIssues:health.length,
      archiveCount:items.length,
      completedSystemChecks:items.filter((item) => item.reason === 'completed_system_check').length,
      supersededFailures:items.filter((item) => item.reason === 'superseded_failure').length,
      retainedFailures:health.filter((item) => item.status === 'blocked').length
        - items.filter((item) => item.reason === 'superseded_failure').length,
    },
    items,
    digest,
    requiredConfirmation:`${CONFIRM_PREFIX}${digest}`,
    safety:{
      deletesRecords:false,
      changesIssueStatus:false,
      resolvesRecoveryActions:false,
      reversibleWithHiddenAtNull:true,
      failedOrRecentChecksRemainVisible:true,
    },
  };
}

export async function applyOperationsHealthArchive({ confirmation, now = new Date(), ...options } = {}) {
  const plan = await planOperationsHealthArchive(options);
  if (confirmation !== plan.requiredConfirmation) {
    throw new Error('归档确认值与当前只读计划不匹配；请重新生成计划');
  }
  const archivedAt = normalizeDate(now).toISOString();
  const origin = assertLoopbackApiBase(options.apiBase ?? DEFAULT_API_BASE);
  const applied = [];
  for (const item of plan.items) {
    const updated = await requestJson(
      options.fetchImpl ?? fetch,
      `${origin}/api/issues/${encodeURIComponent(item.issueId)}`,
      { method:'PATCH', body:{ hiddenAt:archivedAt } },
    );
    if (!updated?.hiddenAt) throw new Error(`Paperclip 未确认归档 ${item.identifier}`);
    applied.push({
      issueId:item.issueId,
      identifier:item.identifier,
      reason:item.reason,
      hiddenAt:updated.hiddenAt,
      rollback:{ method:'PATCH', path:`/api/issues/${item.issueId}`, body:{ hiddenAt:null } },
    });
  }
  return {
    mode:'applied',
    company:plan.company,
    digest:plan.digest,
    archivedAt,
    appliedCount:applied.length,
    applied,
    safety:{
      deleteRequests:0,
      statusChanges:0,
      recoveryActionsResolved:0,
      recordsPreserved:true,
    },
  };
}

async function listIssues(fetchImpl, origin, companyId) {
  const items = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = asList(await requestJson(
      fetchImpl,
      `${origin}/api/companies/${encodeURIComponent(companyId)}/issues?status=done%2Cblocked&limit=${PAGE_SIZE}&offset=${offset}&sortField=updated&sortDir=asc`,
    ));
    items.push(...page);
    if (page.length < PAGE_SIZE) return items;
  }
}

function archiveItem(issue, reason, extra = {}) {
  return {
    issueId:String(issue.id),
    identifier:String(issue.identifier || ''),
    status:String(issue.status),
    expectedUpdatedAt:String(issue.updatedAt || ''),
    reason,
    ...extra,
  };
}

function isOperationsHealthIssue(issue) {
  return issue?.title === ROUTINE_TITLE
    && String(issue.description || '').includes(ROUTINE_MARKER);
}

async function requestJson(fetchImpl, url, { method = 'GET', body } = {}) {
  const response = await fetchImpl(url, {
    method,
    headers:body ? { accept:'application/json', 'content-type':'application/json' } : { accept:'application/json' },
    body:body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`Paperclip ${method} ${new URL(url).pathname} 失败: HTTP ${response.status}`);
  return parsed;
}

function assertLoopbackApiBase(apiBase) {
  const url = new URL(apiBase);
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error('巡检归档只允许连接 loopback Paperclip');
  }
  return url.origin;
}

function asList(value) {
  return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
}

function timestamp(value) {
  const result = new Date(value).getTime();
  if (!Number.isFinite(result)) throw new Error('Paperclip Issue 时间无效');
  return result;
}

function normalizeDate(value) {
  const result = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(result.getTime())) throw new Error('now 必须是有效时间');
  return result;
}

function parseCliArgs(argv) {
  const values = {};
  let apply = false;
  for (const arg of argv) {
    if (arg === '--apply') { apply = true; continue; }
    const match = /^--(api-base|company|confirm)=(.+)$/.exec(arg);
    if (!match) throw new Error(`不支持的参数：${arg}`);
    values[match[1]] = match[2];
  }
  return {
    apiBase:values['api-base'] ?? DEFAULT_API_BASE,
    companyName:values.company ?? DEFAULT_COMPANY_NAME,
    confirmation:values.confirm,
    apply,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseCliArgs(process.argv.slice(2));
  const operation = options.apply
    ? applyOperationsHealthArchive(options)
    : planOperationsHealthArchive(options);
  operation
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

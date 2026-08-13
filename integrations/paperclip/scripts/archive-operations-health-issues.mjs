#!/usr/bin/env node

import {
  createPaperclipLoopbackClient,
  validDate,
} from './support/paperclip-loopback-client.mjs';
import { PaperclipOperationsHealthCatalog } from './support/paperclip-operations-health-catalog.mjs';

const DEFAULT_API_BASE = 'http://127.0.0.1:3100';
const DEFAULT_COMPANY_NAME = 'Agent军团';
const MIN_SUCCESSORS = 3;

export async function planOperationsHealthArchive({
  apiBase = DEFAULT_API_BASE,
  companyName = DEFAULT_COMPANY_NAME,
  fetchImpl = fetch,
  minSuccessors = MIN_SUCCESSORS,
} = {}) {
  const client = createPaperclipLoopbackClient({
    apiBase,
    fetchImpl,
    operation:'巡检归档',
  });
  const catalog = new PaperclipOperationsHealthCatalog({ client, companyName });
  const company = await catalog.requireCompany();
  const { items:issues } = await catalog.listIssues({
    companyId: company.id,
    statuses: ['done', 'blocked'],
    sortField: 'updated',
    sortDir: 'asc',
  });
  return catalog.buildOperationsHealthArchivePlan({ company, issues, minSuccessors });
}

export async function applyOperationsHealthArchive({ confirmation, now = new Date(), ...options } = {}) {
  const plan = await planOperationsHealthArchive(options);
  if (confirmation !== plan.requiredConfirmation) {
    throw new Error('归档确认值与当前只读计划不匹配；请重新生成计划');
  }
  const archivedAt = normalizeDate(now).toISOString();
  const client = createPaperclipLoopbackClient({
    apiBase:options.apiBase ?? DEFAULT_API_BASE,
    fetchImpl:options.fetchImpl ?? fetch,
    operation:'巡检归档',
  });
  const applied = [];
  for (const item of plan.items) {
    const updated = await client.request(
      'PATCH',
      `/api/issues/${encodeURIComponent(item.issueId)}`,
      { body:{ hiddenAt:archivedAt } },
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

function normalizeDate(value) {
  const result = validDate(value);
  if (!result) throw new Error('now 必须是有效时间');
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

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PROFILE_ID = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_LEDGER_ENTRIES = 1_000;

export class HermesUsageLedger {
  constructor({ profileRoot, clock = () => new Date() } = {}) {
    this.profileRoot = path.resolve(String(profileRoot || '.'));
    this.clock = clock;
  }

  summarize({ since, agentIds = [] } = {}) {
    const startedAt = validDate(since) || startOfToday(this.clock());
    const until = validDate(this.clock()) || new Date();
    const ids = [...new Set((Array.isArray(agentIds) ? agentIds : [])
      .map((value) => String(value || '').trim())
      .filter((value) => PROFILE_ID.test(value)))];
    const entries = [];
    const unavailableProfiles = [];

    for (const agentId of ids) {
      const databasePath = path.join(this.profileRoot, agentId, 'state.db');
      if (!fs.existsSync(databasePath)) {
        unavailableProfiles.push(agentId);
        continue;
      }
      let database;
      try {
        database = new DatabaseSync(databasePath, { readOnly:true });
        database.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 1000;');
        const rows = database.prepare(`
          SELECT
            s.id AS session_id,
            s.source AS session_source,
            s.started_at AS session_started_at,
            u.task AS usage_task,
            u.model AS model,
            u.billing_provider AS billing_provider,
            u.billing_mode AS billing_mode,
            u.api_call_count AS api_call_count,
            u.input_tokens AS input_tokens,
            u.output_tokens AS output_tokens,
            u.cache_read_tokens AS cache_read_tokens,
            u.cache_write_tokens AS cache_write_tokens,
            u.reasoning_tokens AS reasoning_tokens,
            u.estimated_cost_usd AS estimated_cost_usd,
            u.actual_cost_usd AS actual_cost_usd,
            u.cost_status AS cost_status,
            u.cost_source AS cost_source,
            COALESCE(u.last_seen, u.first_seen, s.started_at) AS occurred_at
          FROM session_model_usage u
          JOIN sessions s ON s.id = u.session_id
          WHERE s.started_at >= ?
          ORDER BY occurred_at DESC
        `).all(startedAt.getTime() / 1000);
        for (const row of rows) entries.push(normalizeEntry(agentId, row));
      } catch {
        unavailableProfiles.push(agentId);
      } finally {
        database?.close();
      }
    }

    entries.sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt));
    const profiles = summarizeProfiles(entries, ids);
    const status = !ids.length || unavailableProfiles.length === ids.length
      ? 'unavailable'
      : unavailableProfiles.length ? 'partial' : 'ready';
    return {
      schemaVersion:'agent.army/hermes-usage-ledger/v1',
      status,
      period:{ since:startedAt.toISOString(), until:until.toISOString() },
      totals:summarizeEntries(entries),
      profiles,
      entries:entries.slice(0, MAX_LEDGER_ENTRIES),
      truncatedEntryCount:Math.max(0, entries.length - MAX_LEDGER_ENTRIES),
      unavailableProfiles,
      limitations:[
        '金额优先采用 Provider 实际费用；没有实际费用时仅展示 Hermes 标记的估算费用。',
        '不会读取会话正文、Prompt、密钥、Base URL 或聊天标题。',
      ],
    };
  }
}

function normalizeEntry(agentId, row) {
  const occurredAt = new Date(Number(row.occurred_at || row.session_started_at || 0) * 1000);
  const costStatus = normalizeCostStatus(row.cost_status);
  const actualUsd = nonNegativeNumber(row.actual_cost_usd);
  const estimatedUsd = nonNegativeNumber(row.estimated_cost_usd);
  const amountUsd = costStatus === 'actual' && actualUsd > 0
    ? actualUsd
    : costStatus === 'included' ? 0 : estimatedUsd;
  return {
    ledgerRef:`hermes:${agentId}:${String(row.session_id || '')}:${String(row.model || '')}:${String(row.usage_task || '')}`,
    agentId,
    sessionId:String(row.session_id || '').slice(0, 120),
    source:String(row.session_source || 'unknown').slice(0, 40),
    occurredAt:Number.isNaN(occurredAt.getTime()) ? new Date(0).toISOString() : occurredAt.toISOString(),
    provider:String(row.billing_provider || '').trim().slice(0, 80) || null,
    model:String(row.model || '').trim().slice(0, 120) || 'unknown',
    usageClass:String(row.usage_task || '').trim().slice(0, 80) || 'main',
    billingMode:String(row.billing_mode || '').trim().slice(0, 40) || null,
    apiCalls:nonNegativeInteger(row.api_call_count),
    tokens:{
      input:nonNegativeInteger(row.input_tokens),
      output:nonNegativeInteger(row.output_tokens),
      cacheRead:nonNegativeInteger(row.cache_read_tokens),
      cacheWrite:nonNegativeInteger(row.cache_write_tokens),
      reasoning:nonNegativeInteger(row.reasoning_tokens),
    },
    cost:{
      status:costStatus,
      amountUsd,
      actualUsd,
      estimatedUsd,
      source:String(row.cost_source || '').trim().slice(0, 80) || null,
    },
  };
}

function summarizeProfiles(entries, agentIds) {
  return agentIds.map((agentId) => {
    const selected = entries.filter((entry) => entry.agentId === agentId);
    return { agentId, ...summarizeEntries(selected) };
  }).filter((profile) => profile.entryCount > 0)
    .sort((left, right) => right.cost.knownUsd - left.cost.knownUsd || right.tokens.total - left.tokens.total);
}

function summarizeEntries(entries) {
  const sessionIds = new Set();
  const totals = {
    entryCount:entries.length,
    sessionCount:0,
    apiCalls:0,
    tokens:{ input:0, output:0, cacheRead:0, cacheWrite:0, reasoning:0, total:0 },
    cost:{ actualUsd:0, estimatedUsd:0, knownUsd:0, actualEntryCount:0, estimatedEntryCount:0, includedEntryCount:0, unknownEntryCount:0 },
  };
  for (const entry of entries) {
    sessionIds.add(`${entry.agentId}:${entry.sessionId}`);
    totals.apiCalls += entry.apiCalls;
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']) {
      totals.tokens[field] += entry.tokens[field];
    }
    if (entry.cost.status === 'actual') {
      totals.cost.actualUsd += entry.cost.amountUsd;
      totals.cost.actualEntryCount += 1;
    } else if (entry.cost.status === 'estimated') {
      totals.cost.estimatedUsd += entry.cost.amountUsd;
      totals.cost.estimatedEntryCount += 1;
    } else if (entry.cost.status === 'included') totals.cost.includedEntryCount += 1;
    else totals.cost.unknownEntryCount += 1;
  }
  totals.sessionCount = sessionIds.size;
  totals.tokens.total = totals.tokens.input + totals.tokens.output + totals.tokens.cacheRead + totals.tokens.cacheWrite;
  totals.cost.actualUsd = roundUsd(totals.cost.actualUsd);
  totals.cost.estimatedUsd = roundUsd(totals.cost.estimatedUsd);
  totals.cost.knownUsd = roundUsd(totals.cost.actualUsd + totals.cost.estimatedUsd);
  return totals;
}

function normalizeCostStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (['actual', 'reported', 'provider_reported', 'reconciled'].includes(status)) return 'actual';
  if (['estimated', 'estimate'].includes(status)) return 'estimated';
  if (['included', 'subscription_included', 'free'].includes(status)) return 'included';
  return 'unknown';
}

function startOfToday(clock) {
  const date = validDate(clock()) || new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function validDate(value) {
  const date = value instanceof Date ? new Date(value) : new Date(value || 0);
  return Number.isNaN(date.getTime()) || date.getTime() === 0 ? null : date;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function roundUsd(value) {
  return Math.round(Number(value || 0) * 1_000_000_000) / 1_000_000_000;
}

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const PROFILE_ID: any = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_LEDGER_ENTRIES: any = 1000;
export class HermesUsageLedger {
    clock: any;
    profileRoot: any;
    constructor({ profileRoot, clock = (): any => new Date() }: any = {}) {
        this.profileRoot = path.resolve(String(profileRoot || '.'));
        this.clock = clock;
    }
    summarize({ since, until: requestedUntil, agentIds = [] }: any = {}): any {
        const startedAt: any = validDate(since) || startOfToday(this.clock());
        const now: any = validDate(this.clock()) || new Date();
        const upperBound: any = validDate(requestedUntil) || now;
        const until: any = upperBound < now ? upperBound : now;
        const ids: any[] = [...new Set((Array.isArray(agentIds) ? agentIds : [])
                .map((value: any): any => String(value || '').trim())
                .filter((value: any): any => PROFILE_ID.test(value)))];
        const entries: any[] = [];
        const unavailableProfiles: any[] = [];
        for (const agentId of ids) {
            const databasePath: any = path.join(this.profileRoot, agentId, 'state.db');
            if (!fs.existsSync(databasePath)) {
                unavailableProfiles.push(agentId);
                continue;
            }
            let database: any;
            try {
                database = new DatabaseSync(databasePath, { readOnly: true });
                database.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 1000;');
                const rows: any = database.prepare(`
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
          WHERE CAST(COALESCE(u.last_seen, u.first_seen, s.started_at) AS REAL) >= ?
            AND CAST(COALESCE(u.last_seen, u.first_seen, s.started_at) AS REAL) < ?
          ORDER BY occurred_at DESC
        `).all(startedAt.getTime() / 1000, upperBound.getTime() / 1000);
                for (const row of rows)
                    entries.push(normalizeEntry(agentId, row));
            }
            catch {
                unavailableProfiles.push(agentId);
            }
            finally {
                database?.close();
            }
        }
        entries.sort((left: any, right: any): any => Date.parse(right.occurredAt) - Date.parse(left.occurredAt));
        const profiles: any = summarizeProfiles(entries, ids);
        const status: any = !ids.length || unavailableProfiles.length === ids.length
            ? 'unavailable'
            : unavailableProfiles.length ? 'partial' : 'ready';
        return {
            schemaVersion: 'agent.army/hermes-usage-ledger/v1',
            status,
            period: { since: startedAt.toISOString(), until: until.toISOString() },
            totals: summarizeEntries(entries),
            profiles,
            entries: entries.slice(0, MAX_LEDGER_ENTRIES),
            truncatedEntryCount: Math.max(0, entries.length - MAX_LEDGER_ENTRIES),
            unavailableProfiles,
            limitations: [
                '金额优先采用 Provider 实际费用；没有实际费用时仅展示 Hermes 标记的估算费用。',
                'Hermes 按会话累计用量；日期筛选按会话最后活动时间归档，不能拆分同一会话跨日产生的调用。',
                '不会读取会话正文、Prompt、密钥、Base URL 或聊天标题。',
            ],
        };
    }
}
function normalizeEntry(agentId: any, row: any): any {
    const occurredAt: any = new Date(Number(row.occurred_at || row.session_started_at || 0) * 1000);
    const costStatus: any = normalizeCostStatus(row.cost_status);
    const actualUsd: any = nonNegativeNumber(row.actual_cost_usd);
    const estimatedUsd: any = nonNegativeNumber(row.estimated_cost_usd);
    const amountUsd: any = costStatus === 'actual' && actualUsd > 0
        ? actualUsd
        : costStatus === 'included' ? 0 : estimatedUsd;
    return {
        ledgerRef: `hermes:${agentId}:${String(row.session_id || '')}:${String(row.model || '')}:${String(row.usage_task || '')}`,
        agentId,
        sessionId: String(row.session_id || '').slice(0, 120),
        source: String(row.session_source || 'unknown').slice(0, 40),
        occurredAt: Number.isNaN(occurredAt.getTime()) ? new Date(0).toISOString() : occurredAt.toISOString(),
        provider: String(row.billing_provider || '').trim().slice(0, 80) || null,
        model: String(row.model || '').trim().slice(0, 120) || 'unknown',
        usageClass: String(row.usage_task || '').trim().slice(0, 80) || 'main',
        billingMode: String(row.billing_mode || '').trim().slice(0, 40) || null,
        apiCalls: nonNegativeInteger(row.api_call_count),
        tokens: {
            input: nonNegativeInteger(row.input_tokens),
            output: nonNegativeInteger(row.output_tokens),
            cacheRead: nonNegativeInteger(row.cache_read_tokens),
            cacheWrite: nonNegativeInteger(row.cache_write_tokens),
            reasoning: nonNegativeInteger(row.reasoning_tokens),
        },
        cost: {
            status: costStatus,
            amountUsd,
            actualUsd,
            estimatedUsd,
            source: String(row.cost_source || '').trim().slice(0, 80) || null,
        },
    };
}
function summarizeProfiles(entries: any, agentIds: any): any {
    return agentIds.map((agentId: any): any => {
        const selected: any = entries.filter((entry: any): any => entry.agentId === agentId);
        return { agentId, ...summarizeEntries(selected) };
    }).filter((profile: any): any => profile.entryCount > 0)
        .sort((left: any, right: any): any => right.cost.knownUsd - left.cost.knownUsd || right.tokens.total - left.tokens.total);
}
function summarizeEntries(entries: any): any {
    const sessionIds: any = new Set();
    const totals: Record<string, any> = {
        entryCount: entries.length,
        sessionCount: 0,
        apiCalls: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 },
        cost: { actualUsd: 0, estimatedUsd: 0, knownUsd: 0, actualEntryCount: 0, estimatedEntryCount: 0, includedEntryCount: 0, unknownEntryCount: 0 },
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
        }
        else if (entry.cost.status === 'estimated') {
            totals.cost.estimatedUsd += entry.cost.amountUsd;
            totals.cost.estimatedEntryCount += 1;
        }
        else if (entry.cost.status === 'included')
            totals.cost.includedEntryCount += 1;
        else
            totals.cost.unknownEntryCount += 1;
    }
    totals.sessionCount = sessionIds.size;
    totals.tokens.total = totals.tokens.input + totals.tokens.output + totals.tokens.cacheRead + totals.tokens.cacheWrite;
    totals.cost.actualUsd = roundUsd(totals.cost.actualUsd);
    totals.cost.estimatedUsd = roundUsd(totals.cost.estimatedUsd);
    totals.cost.knownUsd = roundUsd(totals.cost.actualUsd + totals.cost.estimatedUsd);
    return totals;
}
function normalizeCostStatus(value: any): any {
    const status: any = String(value || '').trim().toLowerCase();
    if (['actual', 'reported', 'provider_reported', 'reconciled'].includes(status))
        return 'actual';
    if (['estimated', 'estimate'].includes(status))
        return 'estimated';
    if (['included', 'subscription_included', 'free'].includes(status))
        return 'included';
    return 'unknown';
}
function startOfToday(clock: any): any {
    const date: any = validDate(clock()) || new Date();
    date.setHours(0, 0, 0, 0);
    return date;
}
function validDate(value: any): any {
    const date: any = value instanceof Date ? new Date(value) : new Date(value || 0);
    return Number.isNaN(date.getTime()) || date.getTime() === 0 ? null : date;
}
function nonNegativeInteger(value: any): any {
    const number: any = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}
function nonNegativeNumber(value: any): any {
    const number: any = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : 0;
}
function roundUsd(value: any): any {
    return Math.round(Number(value || 0) * 1000000000) / 1000000000;
}

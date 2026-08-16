import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TASK_RUN_EVENT_FIELDS, encodeTaskRunEventCursor, normalizeTaskRunEvent, normalizeTaskRunEventQuery, } from './task-run-event-contract.ts';
import { buildTaskRunIncidentSummary } from './task-run-incident-summary.ts';
const EVENT_COLUMNS: any = Object.freeze({
    eventId: 'event_id', traceId: 'trace_id', spanId: 'span_id', parentSpanId: 'parent_span_id', taskId: 'task_id',
    workflowId: 'workflow_id', stepId: 'step_id', agentId: 'agent_id', eventType: 'event_type', capabilityId: 'capability_id',
    routeId: 'route_id', provider: 'provider', model: 'model', attempt: 'attempt', status: 'status', startedAt: 'started_at',
    finishedAt: 'finished_at', durationMs: 'duration_ms', policyDecisionId: 'policy_decision_id', receiptId: 'receipt_id',
    checkpointRef: 'checkpoint_ref', inputHash: 'input_hash', outputHash: 'output_hash', artifactRefs: 'artifact_refs_json',
    errorCode: 'error_code', safeSummary: 'safe_summary', costAmount: 'cost_amount', costCurrency: 'cost_currency',
    apiCalls: 'api_calls', inputTokens: 'input_tokens', outputTokens: 'output_tokens', cacheReadTokens: 'cache_read_tokens',
    cacheWriteTokens: 'cache_write_tokens', reasoningTokens: 'reasoning_tokens', providerAttempts: 'provider_attempts',
    rateLimitRejections: 'rate_limit_rejections', credentialAlias: 'credential_alias', requestClass: 'request_class',
    retentionClass: 'retention_class',
});
const ADDITIVE_EVENT_COLUMNS: any = Object.freeze({
    apiCalls: 'INTEGER', inputTokens: 'INTEGER', outputTokens: 'INTEGER', cacheReadTokens: 'INTEGER',
    cacheWriteTokens: 'INTEGER', reasoningTokens: 'INTEGER', providerAttempts: 'INTEGER',
    rateLimitRejections: 'INTEGER', credentialAlias: 'TEXT', requestClass: 'TEXT',
});
const RETENTION_CLASSES_WITH_EXPIRY: any = Object.freeze(['transient', 'detail', 'audit']);
const DEFAULT_RETENTION_DAYS: any = Object.freeze({ transient: 7, detail: 30, audit: 365 });
export class TaskRunEventStore {
    clock: any;
    database: any;
    filePath: any;
    ownsDatabase: any;
    constructor(input: any, { clock = (): any => new Date().toISOString() }: any = {}) {
        this.clock = clock;
        if (input && typeof input.prepare === 'function') {
            this.database = input;
            this.ownsDatabase = false;
        }
        else {
            this.filePath = path.resolve(String(input));
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            this.database = new DatabaseSync(this.filePath);
            this.ownsDatabase = true;
            this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
        }
        this.#migrateSchema();
        this.#secureFiles();
    }
    appendTaskRunEvent(input: any): any {
        const event: any = normalizeTaskRunEvent(input, { now: this.clock() });
        const columns: any = TASK_RUN_EVENT_FIELDS.map((field: any): any => EVENT_COLUMNS[field]);
        const placeholders: any = columns.map((): any => '?').join(', ');
        const values: any = TASK_RUN_EVENT_FIELDS.map((field: any): any => field === 'artifactRefs'
            ? JSON.stringify(event.artifactRefs)
            : event[field]);
        try {
            this.database.prepare(`INSERT INTO task_run_events (${columns.join(', ')}) VALUES (${placeholders})`).run(...values);
        }
        catch (error: any) {
            if (String(error?.message || '').includes('UNIQUE constraint failed')) {
                throw Object.assign(new Error('运行事件 ID 已存在，追加写存储不允许覆盖。'), { code: 'task_run_event_exists' });
            }
            throw error;
        }
        this.#secureFiles();
        return structuredClone(event);
    }
    queryTaskRunEvents(input: any = {}): any {
        const query: any = normalizeTaskRunEventQuery(input);
        const clauses: any[] = ['task_id = ?'];
        const params: any[] = [query.taskId];
        if (query.cursor) {
            clauses.push('(started_at > ? OR (started_at = ? AND event_id > ?))');
            params.push(query.cursor.startedAt, query.cursor.startedAt, query.cursor.eventId);
        }
        addListClause(clauses, params, 'event_type', query.filters.eventTypes);
        addListClause(clauses, params, 'status', query.filters.statuses);
        addListClause(clauses, params, 'capability_id', query.filters.capabilityIds);
        addFlagClauses(clauses, query.filters.flags);
        const rows: any = this.database.prepare(`
      SELECT ${selectColumns()} FROM task_run_events
      WHERE ${clauses.join(' AND ')}
      ORDER BY started_at ASC, event_id ASC LIMIT ?
    `).all(...params, query.limit + 1);
        const parsed: any = rows.map(parseEventRow);
        const hasMore: any = parsed.length > query.limit;
        const items: any = hasMore ? parsed.slice(0, query.limit) : parsed;
        return { items, nextCursor: hasMore ? encodeTaskRunEventCursor(items.at(-1)) : null };
    }
    createIncidentSummary(taskId: any, { generatedAt = this.clock(), events = null, mergeExisting = false, }: any = {}): any {
        const selectedEvents: any = Array.isArray(events) ? events : this.#allTaskEvents(taskId);
        const summary: any = buildTaskRunIncidentSummary(String(taskId || ''), selectedEvents, { now: generatedAt });
        if (!summary)
            return null;
        const previous: any = mergeExisting ? this.#incidentSummary(taskId) : null;
        const persisted: any = previous ? mergeIncidentSummaries(previous, summary) : summary;
        this.database.prepare(`
      INSERT INTO task_run_incident_summaries
        (incident_id, task_id, first_occurred_at, last_occurred_at, generated_at, data_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        first_occurred_at=excluded.first_occurred_at,
        last_occurred_at=excluded.last_occurred_at,
        generated_at=excluded.generated_at,
        data_json=excluded.data_json
    `).run(persisted.incidentId, persisted.taskId, persisted.firstOccurredAt, persisted.lastOccurredAt, persisted.generatedAt, JSON.stringify(persisted));
        return structuredClone(persisted);
    }
    queryIncidentSummaries({ taskId = '', limit = 50 }: any = {}): any {
        const normalizedLimit: any = Math.max(1, Math.min(Number.parseInt(limit, 10) || 50, 200));
        const rows: any = taskId
            ? this.database.prepare('SELECT data_json FROM task_run_incident_summaries WHERE task_id = ? LIMIT 1').all(String(taskId))
            : this.database.prepare('SELECT data_json FROM task_run_incident_summaries ORDER BY last_occurred_at DESC, incident_id DESC LIMIT ?').all(normalizedLimit);
        return rows.map((row: any): any => JSON.parse(row.data_json));
    }
    previewExpiredEvents({ now = this.clock(), retentionDays, retentionDaysByClass }: any = {}): any {
        const normalizedNow: any = new Date(now).toISOString();
        const cutoffs: any = retentionCutoffs(normalizedNow, { retentionDays, retentionDaysByClass });
        const counts: Record<string, any> = {};
        for (const retentionClass of RETENTION_CLASSES_WITH_EXPIRY) {
            counts[retentionClass] = Number(this.database.prepare(`
        SELECT COUNT(*) AS count FROM task_run_events
        WHERE retention_class = ? AND started_at < ?
      `).get(retentionClass, cutoffs[retentionClass])?.count || 0);
        }
        return {
            mode: 'dry-run',
            cutoffs,
            expiringByClass: counts,
            expiringEvents: Object.values(counts).reduce((sum: any, count: any): any => sum + count, 0),
            deletedEvents: 0,
            incidentSummariesCreated: 0,
        };
    }
    cleanupExpiredDetails({ now = this.clock(), retentionDays, retentionDaysByClass }: any = {}): any {
        const normalizedNow: any = new Date(now).toISOString();
        const cutoffs: any = retentionCutoffs(normalizedNow, { retentionDays, retentionDaysByClass });
        return this.#transaction((): any => {
            const expiringClause: any = retentionExpiryClause(cutoffs);
            const incidentTasks: any = this.database.prepare(`
        SELECT DISTINCT task_id FROM task_run_events
        WHERE (${expiringClause.sql})
          AND (event_type IN ('capability_call_failed', 'capability_result_ambiguous', 'workflow_blocked')
            OR status IN ('failed', 'ambiguous', 'blocked', 'error') OR error_code IS NOT NULL)
      `).all(...expiringClause.params).map((row: any): any => row.task_id);
            let summariesCreated: any = 0;
            for (const taskId of incidentTasks) {
                const expiringEvents: any = this.#expiringTaskEvents(taskId, cutoffs);
                if (this.createIncidentSummary(taskId, {
                    generatedAt: normalizedNow,
                    events: expiringEvents,
                    mergeExisting: true,
                }))
                    summariesCreated += 1;
            }
            const deletedByClass: Record<string, any> = {};
            let deletedEvents: any = 0;
            for (const retentionClass of RETENTION_CLASSES_WITH_EXPIRY) {
                const result: any = this.database.prepare(`
          DELETE FROM task_run_events WHERE retention_class = ? AND started_at < ?
        `).run(retentionClass, cutoffs[retentionClass]);
                deletedByClass[retentionClass] = Number(result.changes || 0);
                deletedEvents += deletedByClass[retentionClass];
            }
            return {
                mode: 'apply',
                cutoffs,
                cutoff: cutoffs.detail,
                deletedByClass,
                deletedEvents,
                incidentSummariesCreated: summariesCreated,
            };
        });
    }
    close(): any {
        if (this.ownsDatabase)
            this.database.close();
    }
    #allTaskEvents(taskId: any): any {
        return this.database.prepare(`
      SELECT ${selectColumns()} FROM task_run_events WHERE task_id = ? ORDER BY started_at ASC, event_id ASC
    `).all(String(taskId || '')).map(parseEventRow);
    }
    #expiringTaskEvents(taskId: any, cutoffs: any): any {
        const clause: any = retentionExpiryClause(cutoffs);
        return this.database.prepare(`
      SELECT ${selectColumns()} FROM task_run_events
      WHERE task_id = ? AND (${clause.sql})
      ORDER BY started_at ASC, event_id ASC
    `).all(String(taskId || ''), ...clause.params).map(parseEventRow);
    }
    #incidentSummary(taskId: any): any {
        const row: any = this.database.prepare('SELECT data_json FROM task_run_incident_summaries WHERE task_id = ? LIMIT 1').get(String(taskId || ''));
        if (!row)
            return null;
        try {
            return JSON.parse(row.data_json);
        }
        catch {
            return null;
        }
    }
    #migrateSchema(): any {
        this.database.exec(eventTableSql());
        const currentSql: any = String(this.database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'task_run_events'
        `).get()?.sql || '');
        if (!currentSql.includes("'transient'") || !currentSql.includes("'audit'")) {
            this.#transaction((): any => {
                const legacyColumns: any = tableColumns(this.database, 'task_run_events');
                this.database.exec('ALTER TABLE task_run_events RENAME TO task_run_events_legacy_retention;');
                this.database.exec(eventTableSql());
                const columns: any = TASK_RUN_EVENT_FIELDS
                    .map((field: any): any => EVENT_COLUMNS[field])
                    .filter((column: any): any => legacyColumns.has(column))
                    .join(', ');
                this.database.exec(`
          INSERT INTO task_run_events (${columns})
          SELECT ${columns} FROM task_run_events_legacy_retention;
          DROP TABLE task_run_events_legacy_retention;
        `);
            });
        }
        this.#ensureUsageColumns();
        this.database.exec(`
      CREATE INDEX IF NOT EXISTS task_run_events_task_time_idx
        ON task_run_events(task_id, started_at, event_id);
      CREATE INDEX IF NOT EXISTS task_run_events_retention_idx
        ON task_run_events(retention_class, started_at);
      CREATE TABLE IF NOT EXISTS task_run_incident_summaries (
        incident_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE,
        first_occurred_at TEXT NOT NULL,
        last_occurred_at TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_run_incidents_time_idx
        ON task_run_incident_summaries(last_occurred_at DESC, incident_id DESC);
    `);
    }
    #ensureUsageColumns(): any {
        const existing: any = tableColumns(this.database, 'task_run_events');
        for (const [field, definition] of Object.entries(ADDITIVE_EVENT_COLUMNS)) {
            const column: any = EVENT_COLUMNS[field];
            if (!existing.has(column))
                this.database.exec(`ALTER TABLE task_run_events ADD COLUMN ${column} ${definition};`);
        }
    }
    #transaction(operation: any): any {
        this.database.exec('BEGIN IMMEDIATE');
        try {
            const result: any = operation();
            this.database.exec('COMMIT');
            return result;
        }
        catch (error: any) {
            this.database.exec('ROLLBACK');
            throw error;
        }
    }
    #secureFiles(): any {
        if (!this.ownsDatabase || !this.filePath)
            return;
        for (const file of [this.filePath, `${this.filePath}-wal`, `${this.filePath}-shm`]) {
            try {
                fs.chmodSync(file, 0o600);
            }
            catch (error: any) {
                if (error.code !== 'ENOENT')
                    throw error;
            }
        }
    }
}
function mergeIncidentSummaries(previous: any, current: any): any {
    const currentIsLater: any = String(current.lastOccurredAt || '') >= String(previous.lastOccurredAt || '');
    return Object.freeze({
        ...current,
        incidentId: previous.incidentId || current.incidentId,
        firstOccurredAt: [previous.firstOccurredAt, current.firstOccurredAt].filter(Boolean).sort()[0],
        lastOccurredAt: [previous.lastOccurredAt, current.lastOccurredAt].filter(Boolean).sort().at(-1),
        errorCodes: unique([...(previous.errorCodes || []), ...(current.errorCodes || [])]),
        capabilityIds: unique([...(previous.capabilityIds || []), ...(current.capabilityIds || [])]),
        routePath: dedupeAdjacent([...(previous.routePath || []), ...(current.routePath || [])]),
        finalStatus: currentIsLater ? current.finalStatus : previous.finalStatus,
        finalEventType: currentIsLater ? current.finalEventType : previous.finalEventType,
        artifactRefs: unique([...(previous.artifactRefs || []), ...(current.artifactRefs || [])]),
        eventCount: nonNegativeInteger(previous.eventCount) + nonNegativeInteger(current.eventCount),
        incidentEventCount: nonNegativeInteger(previous.incidentEventCount) + nonNegativeInteger(current.incidentEventCount),
    });
}
function eventTableSql(): any {
    return `
    CREATE TABLE IF NOT EXISTS task_run_events (
      event_id TEXT PRIMARY KEY,
      trace_id TEXT, span_id TEXT, parent_span_id TEXT,
      task_id TEXT NOT NULL, workflow_id TEXT, step_id TEXT, agent_id TEXT,
      event_type TEXT NOT NULL, capability_id TEXT, route_id TEXT, provider TEXT, model TEXT,
      attempt INTEGER, status TEXT, started_at TEXT NOT NULL, finished_at TEXT, duration_ms INTEGER,
      policy_decision_id TEXT, receipt_id TEXT, checkpoint_ref TEXT, input_hash TEXT, output_hash TEXT,
      artifact_refs_json TEXT NOT NULL DEFAULT '[]', error_code TEXT, safe_summary TEXT,
      cost_amount REAL, cost_currency TEXT,
      api_calls INTEGER, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
      cache_write_tokens INTEGER, reasoning_tokens INTEGER, provider_attempts INTEGER,
      rate_limit_rejections INTEGER, credential_alias TEXT, request_class TEXT,
      retention_class TEXT NOT NULL DEFAULT 'detail'
        CHECK (retention_class IN ('transient', 'detail', 'audit', 'permanent'))
    );
  `;
}
function tableColumns(database: any, table: any): any {
    return new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((column: any): any => column.name));
}
function retentionCutoffs(now: any, { retentionDays, retentionDaysByClass }: any = {}): any {
    const legacyDays: any = Number.isFinite(Number(retentionDays))
        ? boundedRetentionDays(retentionDays, 90)
        : null;
    const configured: any = retentionDaysByClass && typeof retentionDaysByClass === 'object'
        ? retentionDaysByClass
        : DEFAULT_RETENTION_DAYS;
    return Object.fromEntries(RETENTION_CLASSES_WITH_EXPIRY.map((retentionClass: any): any => {
        const days: any = legacyDays ?? boundedRetentionDays(configured[retentionClass], DEFAULT_RETENTION_DAYS[retentionClass]);
        return [retentionClass, new Date(Date.parse(now) - days * 86400000).toISOString()];
    }));
}
function boundedRetentionDays(value: any, fallback: any): any {
    return Math.max(1, Math.min(Number.parseInt(value, 10) || fallback, 3650));
}
function retentionExpiryClause(cutoffs: any): any {
    const clauses: any[] = [];
    const params: any[] = [];
    for (const retentionClass of RETENTION_CLASSES_WITH_EXPIRY) {
        clauses.push('(retention_class = ? AND started_at < ?)');
        params.push(retentionClass, cutoffs[retentionClass]);
    }
    return { sql: clauses.join(' OR '), params };
}
function unique(values: any): any {
    return [...new Set(values.filter(Boolean))];
}
function dedupeAdjacent(values: any): any {
    return values.filter((value: any, index: any): any => index === 0
        || JSON.stringify(value) !== JSON.stringify(values[index - 1]));
}
function nonNegativeInteger(value: any): any {
    const number: any = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}
function selectColumns(): any {
    return TASK_RUN_EVENT_FIELDS.map((field: any): any => `${EVENT_COLUMNS[field]} AS ${field}`).join(', ');
}
function parseEventRow(row: any): any {
    const event: Record<string, any> = {};
    for (const field of TASK_RUN_EVENT_FIELDS) {
        event[field] = field === 'artifactRefs' ? safeJsonArray(row[field]) : row[field];
    }
    return { schemaVersion: 'agent.army/task-run-event/v1', ...event };
}
function safeJsonArray(value: any): any {
    try {
        const parsed: any = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return [];
    }
}
function addListClause(clauses: any, params: any, column: any, values: any): any {
    if (values.length === 0)
        return;
    clauses.push(`${column} IN (${values.map((): any => '?').join(', ')})`);
    params.push(...values);
}
function addFlagClauses(clauses: any, flags: any): any {
    const flagClauses: any[] = [];
    for (const flag of flags) {
        if (flag === 'failure')
            flagClauses.push(`(status IN ('failed', 'ambiguous', 'blocked', 'error') OR error_code IS NOT NULL OR event_type IN ('capability_call_failed', 'capability_result_ambiguous', 'workflow_blocked'))`);
        if (flag === 'fallback')
            flagClauses.push(`event_type IN ('route_recovery_started', 'route_fallback_started', 'checkpoint_restored')`);
        if (flag === 'cost')
            flagClauses.push('cost_amount IS NOT NULL');
        if (flag === 'quality')
            flagClauses.push(`(event_type LIKE 'quality_%' OR event_type IN ('review_requested', 'review_completed', 'revision_started'))`);
    }
    if (flagClauses.length > 0)
        clauses.push(`(${flagClauses.join(' OR ')})`);
}

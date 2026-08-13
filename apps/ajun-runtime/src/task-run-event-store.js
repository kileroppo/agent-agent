import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  TASK_RUN_EVENT_FIELDS,
  encodeTaskRunEventCursor,
  normalizeTaskRunEvent,
  normalizeTaskRunEventQuery,
} from './task-run-event-contract.js';
import { buildTaskRunIncidentSummary } from './task-run-incident-summary.js';

const EVENT_COLUMNS = Object.freeze({
  eventId:'event_id', traceId:'trace_id', spanId:'span_id', parentSpanId:'parent_span_id', taskId:'task_id',
  workflowId:'workflow_id', stepId:'step_id', agentId:'agent_id', eventType:'event_type', capabilityId:'capability_id',
  routeId:'route_id', provider:'provider', model:'model', attempt:'attempt', status:'status', startedAt:'started_at',
  finishedAt:'finished_at', durationMs:'duration_ms', policyDecisionId:'policy_decision_id', receiptId:'receipt_id',
  checkpointRef:'checkpoint_ref', inputHash:'input_hash', outputHash:'output_hash', artifactRefs:'artifact_refs_json',
  errorCode:'error_code', safeSummary:'safe_summary', costAmount:'cost_amount', costCurrency:'cost_currency',
  retentionClass:'retention_class',
});

export class TaskRunEventStore {
  constructor(input, { clock = () => new Date().toISOString() } = {}) {
    this.clock = clock;
    if (input && typeof input.prepare === 'function') {
      this.database = input;
      this.ownsDatabase = false;
    } else {
      this.filePath = path.resolve(String(input));
      fs.mkdirSync(path.dirname(this.filePath), { recursive:true });
      this.database = new DatabaseSync(this.filePath);
      this.ownsDatabase = true;
      this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    }
    this.#migrateSchema();
    this.#secureFiles();
  }

  appendTaskRunEvent(input) {
    const event = normalizeTaskRunEvent(input, { now:this.clock() });
    const columns = TASK_RUN_EVENT_FIELDS.map((field) => EVENT_COLUMNS[field]);
    const placeholders = columns.map(() => '?').join(', ');
    const values = TASK_RUN_EVENT_FIELDS.map((field) => field === 'artifactRefs'
      ? JSON.stringify(event.artifactRefs)
      : event[field]);
    try {
      this.database.prepare(`INSERT INTO task_run_events (${columns.join(', ')}) VALUES (${placeholders})`).run(...values);
    } catch (error) {
      if (String(error?.message || '').includes('UNIQUE constraint failed')) {
        throw Object.assign(new Error('运行事件 ID 已存在，追加写存储不允许覆盖。'), { code:'task_run_event_exists' });
      }
      throw error;
    }
    this.#secureFiles();
    return structuredClone(event);
  }

  queryTaskRunEvents(input = {}) {
    const query = normalizeTaskRunEventQuery(input);
    const clauses = ['task_id = ?'];
    const params = [query.taskId];
    if (query.cursor) {
      clauses.push('(started_at > ? OR (started_at = ? AND event_id > ?))');
      params.push(query.cursor.startedAt, query.cursor.startedAt, query.cursor.eventId);
    }
    addListClause(clauses, params, 'event_type', query.filters.eventTypes);
    addListClause(clauses, params, 'status', query.filters.statuses);
    addListClause(clauses, params, 'capability_id', query.filters.capabilityIds);
    addFlagClauses(clauses, query.filters.flags);
    const rows = this.database.prepare(`
      SELECT ${selectColumns()} FROM task_run_events
      WHERE ${clauses.join(' AND ')}
      ORDER BY started_at ASC, event_id ASC LIMIT ?
    `).all(...params, query.limit + 1);
    const parsed = rows.map(parseEventRow);
    const hasMore = parsed.length > query.limit;
    const items = hasMore ? parsed.slice(0, query.limit) : parsed;
    return { items, nextCursor:hasMore ? encodeTaskRunEventCursor(items.at(-1)) : null };
  }

  createIncidentSummary(taskId, {
    generatedAt = this.clock(),
    events = null,
    mergeExisting = false,
  } = {}) {
    const selectedEvents = Array.isArray(events) ? events : this.#allTaskEvents(taskId);
    const summary = buildTaskRunIncidentSummary(String(taskId || ''), selectedEvents, { now:generatedAt });
    if (!summary) return null;
    const previous = mergeExisting ? this.#incidentSummary(taskId) : null;
    const persisted = previous ? mergeIncidentSummaries(previous, summary) : summary;
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

  queryIncidentSummaries({ taskId = '', limit = 50 } = {}) {
    const normalizedLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 50, 200));
    const rows = taskId
      ? this.database.prepare('SELECT data_json FROM task_run_incident_summaries WHERE task_id = ? LIMIT 1').all(String(taskId))
      : this.database.prepare('SELECT data_json FROM task_run_incident_summaries ORDER BY last_occurred_at DESC, incident_id DESC LIMIT ?').all(normalizedLimit);
    return rows.map((row) => JSON.parse(row.data_json));
  }

  cleanupExpiredDetails({ now = this.clock(), retentionDays = 90 } = {}) {
    const normalizedNow = new Date(now).toISOString();
    const days = Math.max(1, Math.min(Number.parseInt(retentionDays, 10) || 90, 3650));
    const cutoff = new Date(Date.parse(normalizedNow) - days * 86_400_000).toISOString();
    return this.#transaction(() => {
      const incidentTasks = this.database.prepare(`
        SELECT DISTINCT task_id FROM task_run_events
        WHERE retention_class = 'detail' AND started_at < ?
          AND (event_type IN ('capability_call_failed', 'capability_result_ambiguous', 'workflow_blocked')
            OR status IN ('failed', 'ambiguous', 'blocked', 'error') OR error_code IS NOT NULL)
      `).all(cutoff).map((row) => row.task_id);
      let summariesCreated = 0;
      for (const taskId of incidentTasks) {
        const expiringEvents = this.#expiringTaskEvents(taskId, cutoff);
        if (this.createIncidentSummary(taskId, {
          generatedAt:normalizedNow,
          events:expiringEvents,
          mergeExisting:true,
        })) summariesCreated += 1;
      }
      const result = this.database.prepare(`
        DELETE FROM task_run_events WHERE retention_class = 'detail' AND started_at < ?
      `).run(cutoff);
      return { cutoff, deletedEvents:Number(result.changes || 0), incidentSummariesCreated:summariesCreated };
    });
  }

  close() {
    if (this.ownsDatabase) this.database.close();
  }

  #allTaskEvents(taskId) {
    return this.database.prepare(`
      SELECT ${selectColumns()} FROM task_run_events WHERE task_id = ? ORDER BY started_at ASC, event_id ASC
    `).all(String(taskId || '')).map(parseEventRow);
  }

  #expiringTaskEvents(taskId, cutoff) {
    return this.database.prepare(`
      SELECT ${selectColumns()} FROM task_run_events
      WHERE task_id = ? AND retention_class = 'detail' AND started_at < ?
      ORDER BY started_at ASC, event_id ASC
    `).all(String(taskId || ''), cutoff).map(parseEventRow);
  }

  #incidentSummary(taskId) {
    const row = this.database.prepare(
      'SELECT data_json FROM task_run_incident_summaries WHERE task_id = ? LIMIT 1',
    ).get(String(taskId || ''));
    if (!row) return null;
    try { return JSON.parse(row.data_json); }
    catch { return null; }
  }

  #migrateSchema() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS task_run_events (
        event_id TEXT PRIMARY KEY,
        trace_id TEXT, span_id TEXT, parent_span_id TEXT,
        task_id TEXT NOT NULL, workflow_id TEXT, step_id TEXT, agent_id TEXT,
        event_type TEXT NOT NULL, capability_id TEXT, route_id TEXT, provider TEXT, model TEXT,
        attempt INTEGER, status TEXT, started_at TEXT NOT NULL, finished_at TEXT, duration_ms INTEGER,
        policy_decision_id TEXT, receipt_id TEXT, checkpoint_ref TEXT, input_hash TEXT, output_hash TEXT,
        artifact_refs_json TEXT NOT NULL DEFAULT '[]', error_code TEXT, safe_summary TEXT,
        cost_amount REAL, cost_currency TEXT, retention_class TEXT NOT NULL DEFAULT 'detail'
          CHECK (retention_class IN ('detail', 'permanent'))
      );
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

  #transaction(operation) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  #secureFiles() {
    if (!this.ownsDatabase || !this.filePath) return;
    for (const file of [this.filePath, `${this.filePath}-wal`, `${this.filePath}-shm`]) {
      try { fs.chmodSync(file, 0o600); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}

function mergeIncidentSummaries(previous, current) {
  const currentIsLater = String(current.lastOccurredAt || '') >= String(previous.lastOccurredAt || '');
  return Object.freeze({
    ...current,
    incidentId:previous.incidentId || current.incidentId,
    firstOccurredAt:[previous.firstOccurredAt, current.firstOccurredAt].filter(Boolean).sort()[0],
    lastOccurredAt:[previous.lastOccurredAt, current.lastOccurredAt].filter(Boolean).sort().at(-1),
    errorCodes:unique([...(previous.errorCodes || []), ...(current.errorCodes || [])]),
    capabilityIds:unique([...(previous.capabilityIds || []), ...(current.capabilityIds || [])]),
    routePath:dedupeAdjacent([...(previous.routePath || []), ...(current.routePath || [])]),
    finalStatus:currentIsLater ? current.finalStatus : previous.finalStatus,
    finalEventType:currentIsLater ? current.finalEventType : previous.finalEventType,
    artifactRefs:unique([...(previous.artifactRefs || []), ...(current.artifactRefs || [])]),
    eventCount:nonNegativeInteger(previous.eventCount) + nonNegativeInteger(current.eventCount),
    incidentEventCount:nonNegativeInteger(previous.incidentEventCount) + nonNegativeInteger(current.incidentEventCount),
  });
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function dedupeAdjacent(values) {
  return values.filter((value, index) => index === 0
    || JSON.stringify(value) !== JSON.stringify(values[index - 1]));
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function selectColumns() {
  return TASK_RUN_EVENT_FIELDS.map((field) => `${EVENT_COLUMNS[field]} AS ${field}`).join(', ');
}

function parseEventRow(row) {
  const event = {};
  for (const field of TASK_RUN_EVENT_FIELDS) {
    event[field] = field === 'artifactRefs' ? safeJsonArray(row[field]) : row[field];
  }
  return { schemaVersion:'agent.army/task-run-event/v1', ...event };
}

function safeJsonArray(value) {
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}

function addListClause(clauses, params, column, values) {
  if (values.length === 0) return;
  clauses.push(`${column} IN (${values.map(() => '?').join(', ')})`);
  params.push(...values);
}

function addFlagClauses(clauses, flags) {
  const flagClauses = [];
  for (const flag of flags) {
    if (flag === 'failure') flagClauses.push(`(status IN ('failed', 'ambiguous', 'blocked', 'error') OR error_code IS NOT NULL OR event_type IN ('capability_call_failed', 'capability_result_ambiguous', 'workflow_blocked'))`);
    if (flag === 'fallback') flagClauses.push(`event_type IN ('route_recovery_started', 'route_fallback_started', 'checkpoint_restored')`);
    if (flag === 'cost') flagClauses.push('cost_amount IS NOT NULL');
    if (flag === 'quality') flagClauses.push(`event_type IN ('quality_check_completed', 'review_requested', 'review_completed', 'revision_started')`);
  }
  if (flagClauses.length > 0) clauses.push(`(${flagClauses.join(' OR ')})`);
}

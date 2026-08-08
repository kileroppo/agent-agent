import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  encodeTaskRecordCursor,
  normalizeTaskRecordQuery,
  taskRecordStatusSets,
} from './task-record-query.js';
import {
  applyApprovalPatch,
  applyTaskStatusPatch,
  applyWorkerTaskPatch,
  assertTaskIdempotencyMatch,
  claimTaskForWorker,
  holdTaskForApproval,
  initializeApprovalRecord,
  initializeTaskRecord,
  interruptedTaskExecutionPatch,
  isWorkerTaskClaimable,
} from './task-lifecycle.js';

const SCHEMA_VERSION = 1;
const COLLECTIONS = Object.freeze([
  { key:'tasks', table:'tasks', id:'taskId', idColumn:'task_id', created:'createdAt', updated:'updatedAt' },
  { key:'approvals', table:'approvals', id:'approvalId', idColumn:'approval_id', created:'createdAt', updated:'createdAt' },
  { key:'proposals', table:'proposals', id:'proposalId', idColumn:'proposal_id', created:'createdAt', updated:'updatedAt' },
  { key:'testInstances', table:'test_instances', id:'testInstanceId', idColumn:'test_instance_id', created:'createdAt', updated:'updatedAt' }
]);

export class SQLiteTaskStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    fs.mkdirSync(path.dirname(this.filePath), { recursive:true });
    this.database = new DatabaseSync(this.filePath);
    this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    this.#migrateSchema();
    this.#secureFiles();
  }

  async list() { return this.#listRecords('tasks', 'updated_at DESC'); }
  async getTask(taskId) {
    const row = this.database.prepare(`SELECT data_json, ${taskViewSql()} AS record_view FROM tasks WHERE task_id = ?`).get(taskId);
    return row ? { ...parseRecord(row.data_json), recordView:row.record_view } : null;
  }
  async queryTasks(input = {}) {
    const query = normalizeTaskRecordQuery(input);
    const base = taskRecordBaseSql(query);
    const visible = [...base.clauses];
    const visibleParams = [...base.params];
    if (!query.includeRoutine) visible.push(`NOT (${routineTaskSql()})`);

    const countRow = this.database.prepare(`
      SELECT
        SUM(CASE WHEN record_view = 'needs_action' THEN 1 ELSE 0 END) AS needs_action,
        SUM(CASE WHEN record_view = 'active' THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN record_view = 'completed' THEN 1 ELSE 0 END) AS completed,
        COUNT(*) AS all_count
      FROM (SELECT ${taskViewSql()} AS record_view FROM tasks${whereSql(visible)})
    `).get(...visibleParams);
    const counts = {
      needs_action:Number(countRow.needs_action || 0),
      active:Number(countRow.active || 0),
      completed:Number(countRow.completed || 0),
      all:Number(countRow.all_count || 0),
    };

    const selected = [...visible];
    const selectedParams = [...visibleParams];
    if (query.view !== 'all') {
      selected.push(`${taskViewSql()} = ?`);
      selectedParams.push(query.view);
    }
    if (query.cursor) {
      selected.push('(updated_at < ? OR (updated_at = ? AND task_id < ?))');
      selectedParams.push(query.cursor.updatedAt, query.cursor.updatedAt, query.cursor.taskId);
    }
    const rows = this.database.prepare(`
      SELECT data_json, ${taskViewSql()} AS record_view FROM tasks${whereSql(selected)}
      ORDER BY updated_at DESC, task_id DESC LIMIT ?
    `).all(...selectedParams, query.limit + 1);
    const parsed = rows.map((row) => ({ ...parseRecord(row.data_json), recordView:row.record_view }));
    const hasMore = parsed.length > query.limit;
    const items = hasMore ? parsed.slice(0, query.limit) : parsed;

    const revisionClauses = [...visible];
    const revisionParams = [...visibleParams];
    if (query.view !== 'all') {
      revisionClauses.push(`${taskViewSql()} = ?`);
      revisionParams.push(query.view);
    }
    const revisionRow = this.database.prepare(`
      SELECT task_id, updated_at FROM tasks${whereSql(revisionClauses)}
      ORDER BY updated_at DESC, task_id DESC LIMIT 1
    `).get(...revisionParams);

    const routineClauses = [...base.clauses, routineTaskSql()];
    const routine = query.includeRoutine ? { hidden:0, today:0, attention:0, latestUpdatedAt:null } : this.database.prepare(`
      SELECT COUNT(*) AS hidden,
        SUM(CASE WHEN substr(updated_at, 1, 10) = ? THEN 1 ELSE 0 END) AS today,
        SUM(CASE WHEN json_extract(data_json, '$.status') IN ('failed', 'needs_input', 'pending_approval', 'waiting_approval', 'waiting_test', 'paused', 'blocked', 'error') THEN 1 ELSE 0 END) AS attention,
        MAX(updated_at) AS latest_updated_at
      FROM tasks${whereSql(routineClauses)}
    `).get(new Date().toISOString().slice(0, 10), ...base.params);

    return {
      items,
      total:counts[query.view],
      counts,
      nextCursor:hasMore ? encodeTaskRecordCursor(items.at(-1)) : null,
      revision:[revisionRow?.updated_at || '', revisionRow?.task_id || '', counts.all].join(':'),
      routineSummary:{
        hidden:Number(routine.hidden || 0),
        today:Number(routine.today || 0),
        attention:Number(routine.attention || 0),
        latestUpdatedAt:routine.latest_updated_at || null,
      },
      query:{ ...query, cursor:query.cursor ? input.cursor : null },
    };
  }
  async listApprovals() { return this.#listRecords('approvals', 'created_at DESC'); }
  async listProposals() { return this.#listRecords('proposals', 'updated_at DESC'); }
  async listTestInstances() { return this.#listRecords('test_instances', 'updated_at DESC'); }

  async getConversationContext(chatRef) {
    const row = this.database.prepare('SELECT data_json FROM conversation_contexts WHERE chat_ref = ?').get(String(chatRef || ''));
    return row ? parseRecord(row.data_json) : null;
  }

  async setConversationContext(chatRef, context) {
    const key = String(chatRef || '').trim().slice(0, 240);
    if (!key) return null;
    const record = { schemaVersion:'agent.army/conversation-context/v1', updatedAt:new Date().toISOString(), ...context };
    this.database.prepare(`
      INSERT INTO conversation_contexts (chat_ref, updated_at, data_json) VALUES (?, ?, ?)
      ON CONFLICT(chat_ref) DO UPDATE SET updated_at = excluded.updated_at, data_json = excluded.data_json
    `).run(key, record.updatedAt, encodeRecord(record));
    this.#secureFiles();
    return cloneRecord(record);
  }

  async createTask(task) {
    return (await this.createTaskOnce(task)).task;
  }

  async createTaskOnce(task) {
    return this.#transaction(() => {
      if (task.idempotencyKey) {
        const existing = this.database.prepare('SELECT data_json FROM tasks WHERE idempotency_key = ?').get(task.idempotencyKey);
        if (existing) {
          const record = parseRecord(existing.data_json);
          assertTaskIdempotencyMatch(record, task);
          return { task:record, created:false };
        }
      }
      const now = new Date().toISOString();
      const record = initializeTaskRecord(task, { taskId:crypto.randomUUID(), now });
      this.#insertRecord(COLLECTIONS[0], record);
      return { task:cloneRecord(record), created:true };
    });
  }

  async updateTask(taskId, patch) {
    return this.#transaction(() => {
      const task = this.#getRecord('tasks', 'task_id', taskId);
      if (!task) throw new Error('找不到要更新的任务。');
      Object.assign(task, applyTaskStatusPatch(task, patch, { approvals:this.#listRecords('approvals', 'created_at DESC') }), { updatedAt:new Date().toISOString() });
      this.#updateRecord(COLLECTIONS[0], task);
      return cloneRecord(task);
    });
  }

  async claimTaskExecution(taskId, patch = {}) {
    return this.#transaction(() => {
      const task = this.#getRecord('tasks', 'task_id', taskId);
      if (!task) throw new Error('找不到要执行的任务。');
      if (task.status !== 'queued') return { task:cloneRecord(task), claimed:false };
      Object.assign(task, applyTaskStatusPatch(task, { ...patch, status:'running' }, {
        approvals:this.#listRecords('approvals', 'created_at DESC'),
      }), { updatedAt:new Date().toISOString() });
      this.#updateRecord(COLLECTIONS[0], task);
      return { task:cloneRecord(task), claimed:true };
    });
  }

  async recoverInterruptedTaskExecution(taskId, { expectedStartedAt, expectedStage, interruptedAt } = {}) {
    return this.#transaction(() => {
      const task = this.#getRecord('tasks', 'task_id', taskId);
      if (!task) throw new Error('找不到要恢复的任务。');
      if (task.status !== 'running'
        || task.currentStage !== expectedStage
        || task.execution?.startedAt !== expectedStartedAt) {
        return { task:cloneRecord(task), recovered:false };
      }
      const detectedAt = interruptedAt || new Date().toISOString();
      Object.assign(task, applyTaskStatusPatch(task, interruptedTaskExecutionPatch(task, detectedAt), {
        approvals:this.#listRecords('approvals', 'created_at DESC'),
      }), { updatedAt:detectedAt });
      this.#updateRecord(COLLECTIONS[0], task);
      return { task:cloneRecord(task), recovered:true };
    });
  }

  async createApproval(approval) {
    return this.#transaction(() => {
      const now = new Date().toISOString();
      const record = initializeApprovalRecord(approval, { approvalId:crypto.randomUUID(), now });
      this.#insertRecord(COLLECTIONS[1], record);
      const task = this.#getRecord('tasks', 'task_id', approval.taskId);
      if (task) {
        Object.assign(task, holdTaskForApproval(task, record));
        task.updatedAt = now;
        this.#updateRecord(COLLECTIONS[0], task);
      }
      return cloneRecord(record);
    });
  }

  async updateApproval(approvalId, patch) {
    return this.#transaction(() => {
      const approval = this.#getRecord('approvals', 'approval_id', approvalId);
      if (!approval) throw new Error('找不到要更新的审批。');
      Object.assign(approval, applyApprovalPatch(approval, patch));
      this.#updateRecord(COLLECTIONS[1], approval);
      return cloneRecord(approval);
    });
  }

  async resolveApprovalAndUpdateTask(approvalId, approvalPatch, taskId, taskPatch) {
    return this.#transaction(() => {
      const approval = this.#getRecord('approvals', 'approval_id', approvalId);
      const task = this.#getRecord('tasks', 'task_id', taskId);
      if (!approval) throw new Error('找不到要更新的审批。');
      if (!task) throw new Error('找不到要更新的任务。');
      if (approval.taskId !== task.taskId) throw new Error('审批与任务不匹配。');
      Object.assign(approval, applyApprovalPatch(approval, approvalPatch));
      const resolvedTaskPatch = typeof taskPatch === 'function'
        ? taskPatch(task, approval)
        : taskPatch;
      Object.assign(task, applyTaskStatusPatch(task, resolvedTaskPatch, {
        approvals:this.#listRecords('approvals', 'created_at DESC').map((item) => (
          item.approvalId === approval.approvalId ? approval : item
        )),
      }), { updatedAt:new Date().toISOString() });
      this.#updateRecord(COLLECTIONS[1], approval);
      this.#updateRecord(COLLECTIONS[0], task);
      return { approval:cloneRecord(approval), task:cloneRecord(task) };
    });
  }

  async createProposal(proposal) {
    return this.#transaction(() => {
      if (proposal.sourceEventRef) {
        const existing = this.database.prepare('SELECT data_json FROM proposals WHERE source_event_ref = ?').get(proposal.sourceEventRef);
        if (existing) return parseRecord(existing.data_json);
      }
      const now = new Date().toISOString();
      const record = { schemaVersion:'agent.army/proposal/v1', proposalId:crypto.randomUUID(), version:1, reviewRefs:[], audit:[], createdAt:now, updatedAt:now, ...proposal };
      this.#insertRecord(COLLECTIONS[2], record);
      return cloneRecord(record);
    });
  }

  async updateProposal(proposalId, patch) {
    return this.#transaction(() => {
      const proposal = this.#getRecord('proposals', 'proposal_id', proposalId);
      if (!proposal) throw new Error('找不到 Agent 草案。');
      Object.assign(proposal, patch, { updatedAt:new Date().toISOString() });
      this.#updateRecord(COLLECTIONS[2], proposal);
      return cloneRecord(proposal);
    });
  }

  async createTestInstance(instance) {
    return this.#transaction(() => {
      const now = new Date().toISOString();
      const record = { schemaVersion:'agent.army/test-instance/v1', testInstanceId:crypto.randomUUID(), createdAt:now, updatedAt:now, ...instance };
      this.#insertRecord(COLLECTIONS[3], record);
      return cloneRecord(record);
    });
  }

  async updateTestInstance(testInstanceId, patch) {
    return this.#transaction(() => {
      const instance = this.#getRecord('test_instances', 'test_instance_id', testInstanceId);
      if (!instance) throw new Error('找不到受限测试实例。');
      Object.assign(instance, patch, { updatedAt:new Date().toISOString() });
      this.#updateRecord(COLLECTIONS[3], instance);
      return cloneRecord(instance);
    });
  }

  async claimWorkerTask({ workerId, taskTypes, leaseMs = 120_000, now = Date.now() }) {
    return this.#transaction(() => {
      const task = this.#listRecords('tasks', 'created_at ASC')
        .find((candidate) => isWorkerTaskClaimable(candidate, { taskTypes, now }));
      if (!task) return null;
      Object.assign(task, claimTaskForWorker(task, {
        workerId,
        leaseId:crypto.randomUUID(),
        leaseMs,
        now,
      }));
      this.#updateRecord(COLLECTIONS[0], task);
      return cloneRecord(task);
    });
  }

  async updateWorkerTask(taskId, { workerId, leaseId, patch, leaseMs = 120_000, now = Date.now(), extendLease = false }) {
    return this.#transaction(() => {
      const task = this.#getRecord('tasks', 'task_id', taskId);
      if (!task) throw new Error('找不到这条 Mac 工作间任务。');
      Object.assign(task, applyWorkerTaskPatch(task, {
        workerId,
        leaseId,
        patch,
        leaseMs,
        now,
        extendLease,
      }));
      this.#updateRecord(COLLECTIONS[0], task);
      return cloneRecord(task);
    });
  }

  async inspectCounts() {
    const counts = Object.fromEntries(COLLECTIONS.map(({ key, table }) => [key, Number(this.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count)]));
    counts.conversationContexts = Number(this.database.prepare('SELECT COUNT(*) AS count FROM conversation_contexts').get().count);
    return counts;
  }

  async importSnapshot(snapshot, { sourceDigest } = {}) {
    const normalized = normalizeSnapshot(snapshot);
    const digest = sourceDigest || snapshotDigest(normalized);
    const expected = snapshotEvidence(normalized);
    return this.#transaction(() => {
      const before = this.#countsSync();
      const existingDigest = this.#metadata('json_import_digest');
      if (sumCounts(before) > 0) {
        if (existingDigest === digest) {
          const actual = this.#databaseEvidence();
          assertEvidence(expected, actual);
          return { status:'already_imported', before, after:before, idChecks:actual.idChecks };
        }
        const error = new Error('SQLite 目标库非空，拒绝覆盖现有数据。');
        error.code = 'sqlite_target_not_empty';
        throw error;
      }
      for (const collection of COLLECTIONS) for (const record of normalized[collection.key]) this.#insertRecord(collection, record);
      for (const [chatRef, context] of Object.entries(normalized.conversationContexts)) {
        this.database.prepare('INSERT INTO conversation_contexts (chat_ref, updated_at, data_json) VALUES (?, ?, ?)').run(chatRef, context?.updatedAt || '', encodeRecord(context));
      }
      this.#setMetadata('json_import_digest', digest);
      this.#setMetadata('json_imported_at', new Date().toISOString());
      const after = this.#countsSync();
      const actual = this.#databaseEvidence();
      assertEvidence(expected, actual);
      return { status:'imported', before, after, idChecks:actual.idChecks };
    });
  }

  close() { this.database.close(); }

  #migrateSchema() {
    const currentVersion = Number(this.database.prepare('PRAGMA user_version').get().user_version);
    if (currentVersion > SCHEMA_VERSION) throw new Error(`SQLite schema v${currentVersion} 高于当前支持的 v${SCHEMA_VERSION}，拒绝用旧代码打开。`);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (task_id TEXT PRIMARY KEY, idempotency_key TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, data_json TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS tasks_idempotency_key ON tasks(idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS tasks_status_updated ON tasks(json_extract(data_json, '$.status'), updated_at DESC, task_id DESC);
      CREATE INDEX IF NOT EXISTS tasks_agent_updated ON tasks(json_extract(data_json, '$.assigneeAgentId'), updated_at DESC, task_id DESC);
      CREATE INDEX IF NOT EXISTS tasks_type_updated ON tasks(json_extract(data_json, '$.taskType'), updated_at DESC, task_id DESC);
      CREATE TABLE IF NOT EXISTS approvals (approval_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, data_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS proposals (proposal_id TEXT PRIMARY KEY, source_event_ref TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, data_json TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS proposals_source_event_ref ON proposals(source_event_ref) WHERE source_event_ref IS NOT NULL;
      CREATE TABLE IF NOT EXISTS test_instances (test_instance_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, data_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_contexts (chat_ref TEXT PRIMARY KEY, updated_at TEXT NOT NULL, data_json TEXT NOT NULL);
      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (${SCHEMA_VERSION}, datetime('now'));
    `);
    if (currentVersion < SCHEMA_VERSION) this.database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  #transaction(operation) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      this.#secureFiles();
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  #listRecords(table, orderBy) { return this.database.prepare(`SELECT data_json FROM ${table} ORDER BY ${orderBy}`).all().map((row) => parseRecord(row.data_json)); }
  #getRecord(table, idColumn, id) { const row = this.database.prepare(`SELECT data_json FROM ${table} WHERE ${idColumn} = ?`).get(id); return row ? parseRecord(row.data_json) : null; }

  #insertRecord(collection, record) {
    const common = [record[collection.id], record[collection.created] || '', record[collection.updated] || '', encodeRecord(record)];
    if (collection.table === 'tasks') this.database.prepare('INSERT INTO tasks (task_id, idempotency_key, created_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?)').run(record.taskId, record.idempotencyKey || null, common[1], common[2], common[3]);
    else if (collection.table === 'approvals') this.database.prepare('INSERT INTO approvals (approval_id, created_at, data_json) VALUES (?, ?, ?)').run(record.approvalId, common[1], common[3]);
    else if (collection.table === 'proposals') this.database.prepare('INSERT INTO proposals (proposal_id, source_event_ref, created_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?)').run(record.proposalId, record.sourceEventRef || null, common[1], common[2], common[3]);
    else this.database.prepare('INSERT INTO test_instances (test_instance_id, created_at, updated_at, data_json) VALUES (?, ?, ?, ?)').run(...common);
  }

  #updateRecord(collection, record) {
    if (collection.table === 'tasks') this.database.prepare('UPDATE tasks SET idempotency_key = ?, created_at = ?, updated_at = ?, data_json = ? WHERE task_id = ?').run(record.idempotencyKey || null, record.createdAt || '', record.updatedAt || '', encodeRecord(record), record.taskId);
    else if (collection.table === 'approvals') this.database.prepare('UPDATE approvals SET created_at = ?, data_json = ? WHERE approval_id = ?').run(record.createdAt || '', encodeRecord(record), record.approvalId);
    else if (collection.table === 'proposals') this.database.prepare('UPDATE proposals SET source_event_ref = ?, created_at = ?, updated_at = ?, data_json = ? WHERE proposal_id = ?').run(record.sourceEventRef || null, record.createdAt || '', record.updatedAt || '', encodeRecord(record), record.proposalId);
    else this.database.prepare('UPDATE test_instances SET created_at = ?, updated_at = ?, data_json = ? WHERE test_instance_id = ?').run(record.createdAt || '', record.updatedAt || '', encodeRecord(record), record.testInstanceId);
  }

  #countsSync() {
    const counts = Object.fromEntries(COLLECTIONS.map(({ key, table }) => [key, Number(this.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count)]));
    counts.conversationContexts = Number(this.database.prepare('SELECT COUNT(*) AS count FROM conversation_contexts').get().count);
    return counts;
  }

  #databaseEvidence() {
    const idChecks = {};
    for (const { key, table, idColumn } of COLLECTIONS) idChecks[key] = idDigest(this.database.prepare(`SELECT ${idColumn} AS id FROM ${table} ORDER BY ${idColumn}`).all().map((row) => row.id));
    idChecks.conversationContexts = idDigest(this.database.prepare('SELECT chat_ref AS id FROM conversation_contexts ORDER BY chat_ref').all().map((row) => row.id));
    return { counts:this.#countsSync(), idChecks };
  }

  #metadata(key) { return this.database.prepare('SELECT value FROM metadata WHERE key = ?').get(key)?.value || null; }
  #setMetadata(key, value) { this.database.prepare('INSERT INTO metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value); }
  #secureFiles() { for (const suffix of ['', '-wal', '-shm']) { try { fs.chmodSync(`${this.filePath}${suffix}`, 0o600); } catch (error) { if (error.code !== 'ENOENT') throw error; } } }
}

function taskRecordBaseSql(query) {
  const clauses = [];
  const params = [];
  if (query.agentId) {
    clauses.push(`json_extract(data_json, '$.assigneeAgentId') = ?`);
    params.push(query.agentId);
  }
  if (query.taskType) {
    clauses.push(`json_extract(data_json, '$.taskType') = ?`);
    params.push(query.taskType);
  }
  if (query.since) {
    clauses.push('updated_at >= ?');
    params.push(query.since);
  }
  if (query.until) {
    clauses.push('updated_at <= ?');
    params.push(query.until);
  }
  for (const term of query.q.split(/\s+/).filter(Boolean)) {
    const pattern = `%${escapeLike(term)}%`;
    clauses.push(`(
      lower(task_id) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(json_extract(data_json, '$.input.title'), '')) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(json_extract(data_json, '$.input.description'), '')) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(json_extract(data_json, '$.assigneeAgentId'), '')) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(json_extract(data_json, '$.taskType'), '')) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(json_extract(data_json, '$.status'), '')) LIKE ? ESCAPE '\\'
    )`);
    params.push(pattern, pattern, pattern, pattern, pattern, pattern);
  }
  return { clauses, params };
}

function taskViewSql() {
  const { completed } = taskRecordStatusSets();
  const values = (items) => items.map((item) => `'${item}'`).join(', ');
  const status = `json_extract(tasks.data_json, '$.status')`;
  const channel = `COALESCE(json_extract(tasks.data_json, '$.source.channel'), '')`;
  const origin = `COALESCE(json_extract(tasks.data_json, '$.source.originChannel'), '')`;
  const userFacing = (alias) => `(
    COALESCE(json_extract(${alias}.data_json, '$.source.channel'), '') IN ('feishu', 'local-ui', 'hermes-native')
    OR COALESCE(json_extract(${alias}.data_json, '$.source.originChannel'), '') IN ('feishu', 'local-ui', 'hermes-native')
  )`;
  return `CASE
    WHEN ${status} IN (${values(completed)}) THEN 'completed'
    WHEN ${status} IN ('pending_approval', 'waiting_approval', 'paused', 'blocked', 'error') THEN 'needs_action'
    WHEN ${status} IN ('failed', 'needs_input', 'waiting_test')
      AND (
        (${channel} = '' AND ${origin} = '')
        OR (
          (${channel} IN ('feishu', 'local-ui', 'hermes-native') OR ${origin} IN ('feishu', 'local-ui', 'hermes-native'))
          AND NOT EXISTS (
            SELECT 1 FROM tasks AS later
            WHERE later.updated_at > tasks.updated_at
              AND json_extract(later.data_json, '$.status') IN ('succeeded', 'cancelled')
              AND ${userFacing('later')}
          )
          AND NOT EXISTS (
            SELECT 1 FROM tasks AS superseding
            WHERE COALESCE(json_extract(tasks.data_json, '$.input.sourceUrl'), '') != ''
              AND superseding.updated_at > tasks.updated_at
              AND json_extract(superseding.data_json, '$.status') = 'succeeded'
              AND json_extract(superseding.data_json, '$.taskType') = json_extract(tasks.data_json, '$.taskType')
              AND json_extract(superseding.data_json, '$.input.sourceUrl') = json_extract(tasks.data_json, '$.input.sourceUrl')
          )
        )
      ) THEN 'needs_action'
    WHEN ${status} IN ('queued', 'running', 'pausing', 'waiting_worker', 'recovery_pending', 'technical_repair') THEN 'active'
    ELSE 'archived'
  END`;
}

function routineTaskSql() {
  return `(
    json_extract(data_json, '$.taskType') = 'operations.health-review'
    AND json_extract(data_json, '$.source.channel') = 'paperclip'
    AND (
      trim(COALESCE(json_extract(data_json, '$.input.title'), '')) = 'A君定时本机巡检'
      OR trim(COALESCE(json_extract(data_json, '$.input.description'), '')) LIKE 'agent-army:operations-health-v1%'
    )
  )`;
}

function whereSql(clauses) {
  return clauses.length ? ` WHERE ${clauses.map((clause) => `(${clause})`).join(' AND ')}` : '';
}

function escapeLike(value) {
  return String(value || '').replace(/[\\%_]/g, (match) => `\\${match}`);
}

function normalizeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new TypeError('JSON 状态必须是对象。');
  const normalized = {};
  for (const { key, id } of COLLECTIONS) {
    normalized[key] = snapshot[key] ?? [];
    if (!Array.isArray(normalized[key])) throw new TypeError(`${key} 必须是数组。`);
    const ids = normalized[key].map((record) => record?.[id]);
    if (ids.some((value) => !value || typeof value !== 'string') || new Set(ids).size !== ids.length) throw new TypeError(`${key} 包含缺失或重复的关键 ID。`);
  }
  normalized.conversationContexts = snapshot.conversationContexts ?? {};
  if (!normalized.conversationContexts || typeof normalized.conversationContexts !== 'object' || Array.isArray(normalized.conversationContexts)) throw new TypeError('conversationContexts 必须是对象。');
  return normalized;
}

function snapshotEvidence(snapshot) {
  const counts = Object.fromEntries(COLLECTIONS.map(({ key }) => [key, snapshot[key].length]));
  counts.conversationContexts = Object.keys(snapshot.conversationContexts).length;
  const idChecks = Object.fromEntries(COLLECTIONS.map(({ key, id }) => [key, idDigest(snapshot[key].map((record) => record[id]))]));
  idChecks.conversationContexts = idDigest(Object.keys(snapshot.conversationContexts));
  return { counts, idChecks };
}

function assertEvidence(expected, actual) {
  if (JSON.stringify(expected.counts) !== JSON.stringify(actual.counts) || JSON.stringify(expected.idChecks) !== JSON.stringify(actual.idChecks)) {
    const error = new Error('SQLite 导入后的数量或关键 ID 校验失败，事务已回滚。');
    error.code = 'sqlite_import_verification_failed';
    throw error;
  }
}

function snapshotDigest(snapshot) { return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'); }
function idDigest(ids) { return crypto.createHash('sha256').update([...ids].sort().join('\0')).digest('hex'); }
function sumCounts(counts) { return Object.values(counts).reduce((sum, count) => sum + count, 0); }
function encodeRecord(record) { return JSON.stringify(record); }
function parseRecord(value) { return JSON.parse(value); }
function cloneRecord(record) { return structuredClone(record); }

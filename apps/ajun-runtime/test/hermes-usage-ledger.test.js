import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { HermesUsageLedger } from '../src/hermes-usage-ledger.ts';

test('Hermes 用量账本只读汇总调用、Token 和费用，不暴露会话正文或 Base URL', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-usage-ledger-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const profile = path.join(root, 'video-content-analyst');
  await fs.mkdir(profile, { recursive:true });
  const database = new DatabaseSync(path.join(profile, 'state.db'));
  database.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      source TEXT,
      started_at REAL,
      title TEXT
    );
    CREATE TABLE session_model_usage (
      session_id TEXT,
      task TEXT,
      model TEXT,
      billing_provider TEXT,
      billing_base_url TEXT,
      billing_mode TEXT,
      api_call_count INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      reasoning_tokens INTEGER,
      estimated_cost_usd REAL,
      actual_cost_usd REAL,
      cost_status TEXT,
      cost_source TEXT,
      first_seen REAL,
      last_seen REAL
    );
  `);
  database.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run('session-1', 'cli', 1000, '不能出现在输出里的会话标题');
  database.prepare('INSERT INTO session_model_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'session-1', '', 'deepseek-v4-flash', 'deepseek', 'https://secret.invalid/v1', 'metered',
    1, 120, 80, 20, 0, 10, 0.0025, 0, 'estimated', 'official_docs_snapshot', 1000, 1001,
  );
  database.close();

  const ledger = new HermesUsageLedger({ profileRoot:root, clock:() => new Date(2_000_000) }).summarize({
    since:new Date(900_000),
    agentIds:['video-content-analyst', 'missing-profile'],
  });

  assert.equal(ledger.status, 'partial');
  assert.equal(ledger.totals.apiCalls, 1);
  assert.equal(ledger.totals.tokens.total, 220);
  assert.equal(ledger.totals.cost.estimatedUsd, 0.0025);
  assert.equal(ledger.entries[0].agentId, 'video-content-analyst');
  assert.equal(ledger.entries[0].cost.status, 'estimated');
  assert.deepEqual(ledger.unavailableProfiles, ['missing-profile']);
  const serialized = JSON.stringify(ledger);
  assert.doesNotMatch(serialized, /不能出现在输出里的会话标题/);
  assert.doesNotMatch(serialized, /secret\.invalid/);
});

test('Hermes 用量账本在 Profile 数据库不可用时安全降级', () => {
  const ledger = new HermesUsageLedger({ profileRoot:'/definitely/missing', clock:() => new Date('2026-08-08T08:00:00.000Z') }).summarize({
    since:new Date('2026-08-08T00:00:00.000Z'),
    agentIds:['ajun'],
  });
  assert.equal(ledger.status, 'unavailable');
  assert.equal(ledger.totals.entryCount, 0);
  assert.deepEqual(ledger.unavailableProfiles, ['ajun']);
});

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTaskStore } from '../src/create-task-store.ts';
import { SQLiteTaskStore } from '../src/sqlite-task-store.ts';
import { TaskStore } from '../src/task-store.ts';

test('任务存储默认保留 JSON，只有显式开关才切到 SQLite', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-store-factory-'));
  try {
    assert.ok(createTaskStore({ dataDir:directory, mode:'json' }) instanceof TaskStore);
    const sqlite = createTaskStore({ dataDir:directory, mode:'sqlite' });
    assert.ok(sqlite instanceof SQLiteTaskStore);
    sqlite.close();
    assert.throws(() => createTaskStore({ dataDir:directory, mode:'remote' }), /只支持 json 或 sqlite/);
  } finally {
    await fs.rm(directory, { recursive:true, force:true });
  }
});

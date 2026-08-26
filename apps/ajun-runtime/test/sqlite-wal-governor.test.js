import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkpointWal,
  isSqliteBusyError,
  SqliteWalGovernorReconciler,
  withBusyRetry,
} from '../src/sqlite-wal-governor.ts';

test('isSqliteBusyError 准确识别锁错误与繁忙异常', () => {
  assert.equal(isSqliteBusyError({ code: 'SQLITE_BUSY' }), true);
  assert.equal(isSqliteBusyError({ message: 'database is locked' }), true);
  assert.equal(isSqliteBusyError(new Error('database is busy')), true);
  assert.equal(isSqliteBusyError(new Error('no such table: tasks')), false);
});

test('withBusyRetry 在遇到锁冲突时微退避重试并成功', async () => {
  let attempts = 0;
  const delays = [];

  const result = await withBusyRetry(
    async () => {
      attempts += 1;
      if (attempts < 3) {
        const err = new Error('database is locked');
        err.code = 'SQLITE_BUSY';
        throw err;
      }
      return 'written_ok';
    },
    {
      maxAttempts: 5,
      initialDelayMs: 10,
      sleepFn: async (ms) => { delays.push(ms); },
    }
  );

  assert.equal(result, 'written_ok');
  assert.equal(attempts, 3);
  assert.equal(delays.length, 2);
});

test('checkpointWal 执行 PRAGMA 并返回统计', () => {
  const fakeDb = {
    prepare(sql) {
      assert.ok(sql.includes('wal_checkpoint'));
      return {
        get() {
          return { busy: 0, log: 15, checkpointed: 15 };
        },
      };
    },
  };

  const res = checkpointWal(fakeDb, { mode: 'PASSIVE' });
  assert.equal(res.status, 'ok');
  assert.equal(res.log, 15);
  assert.equal(res.checkpointed, 15);

  const reconciler = new SqliteWalGovernorReconciler({ database: fakeDb });
  assert.ok(reconciler);
});

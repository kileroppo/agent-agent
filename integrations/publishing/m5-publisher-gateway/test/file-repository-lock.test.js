import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FilePublisherRepository } from '../src/index.ts';

const NOW = new Date('2026-07-30T12:00:00.000Z');

async function temporaryLedger(context, prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  return path.join(root, 'ledger.json');
}

async function captureRejection(operation) {
  let rejection;
  await assert.rejects(operation, (error) => {
    rejection = error;
    return true;
  });
  return rejection;
}

test('同机进程已死且超过安全期的崩溃残锁会被隔离后恢复事务', async (context) => {
  const file = await temporaryLedger(context, 'm5-publisher-stale-lock-');
  const lockPath = `${file}.lock`;
  await fs.writeFile(lockPath, `${JSON.stringify({
    pid:999_999_999,
    host:os.hostname(),
    createdAt:'2026-07-30T11:59:00.000Z',
    nonce:'stale-owner',
  })}\n`, { mode:0o600 });

  const repository = new FilePublisherRepository(file, {
    clock:() => new Date(NOW),
    isProcessAlive:() => false,
    staleLockSafetyMs:1_000,
    retryIntervalMs:1,
    maxWaitMs:50,
  });

  await repository.update((draft) => {
    draft.receipts.recovered = { receiptId:'recovered' };
  });

  assert.equal((await repository.read()).receipts.recovered.receiptId, 'recovered');
  await assert.rejects(fs.access(lockPath), { code:'ENOENT' });
});

test('新锁以私有普通文件记录 pid、host、createdAt 和 nonce', async (context) => {
  const file = await temporaryLedger(context, 'm5-publisher-lock-owner-');
  const repository = new FilePublisherRepository(file, {
    clock:() => new Date(NOW),
    hostname:'publisher-host',
    pid:4242,
    nonceFactory:() => 'owner_nonce_1234',
  });
  let owner;
  let mode;

  await repository.update(async () => {
    owner = JSON.parse(await fs.readFile(`${file}.lock`, 'utf8'));
    mode = (await fs.lstat(`${file}.lock`)).mode & 0o777;
  });

  assert.deepEqual(owner, {
    pid:4242,
    host:'publisher-host',
    createdAt:NOW.toISOString(),
    nonce:'owner_nonce_1234',
  });
  assert.equal(mode, 0o600);
});

for (const scenario of [
  {
    name:'仍存活的同机锁',
    createdAt:'2026-07-30T11:00:00.000Z',
    isProcessAlive:() => true,
  },
  {
    name:'仍在安全期内的同机死进程锁',
    createdAt:'2026-07-30T11:59:59.999Z',
    isProcessAlive:() => false,
  },
]) {
  test(`${scenario.name}不可抢占且等待有界`, async (context) => {
    const file = await temporaryLedger(context, 'm5-publisher-lock-wait-');
    await fs.writeFile(`${file}.lock`, `${JSON.stringify({
      pid:7777,
      host:os.hostname(),
      createdAt:scenario.createdAt,
      nonce:'existing_owner',
    })}\n`, { mode:0o600 });
    const repository = new FilePublisherRepository(file, {
      clock:() => new Date(NOW),
      isProcessAlive:scenario.isProcessAlive,
      staleLockSafetyMs:5_000,
      retryIntervalMs:1,
      maxWaitMs:10,
    });
    const startedAt = performance.now();

    const error = await captureRejection(repository.update(() => undefined));

    assert.equal(error.code, 'publisher_ledger_lock_timeout');
    assert.equal(error.recoveryAction.action, 'inspect_and_isolate_publisher_ledger_lock');
    assert.deepEqual(Object.keys(error.recoveryAction).sort(), ['action', 'instruction', 'lockPath']);
    assert.ok(performance.now() - startedAt < 200);
    assert.equal(JSON.parse(await fs.readFile(`${file}.lock`, 'utf8')).nonce, 'existing_owner');
  });
}

for (const scenario of [
  {
    name:'其他主机所有权',
    prepare:async (lockPath) => fs.writeFile(lockPath, `${JSON.stringify({
      pid:7777,
      host:'another-host',
      createdAt:'2026-07-30T11:00:00.000Z',
      nonce:'unknown_owner',
    })}\n`, { mode:0o600 }),
    code:'publisher_ledger_lock_owner_unknown',
  },
  {
    name:'损坏内容',
    prepare:async (lockPath) => fs.writeFile(lockPath, '{not-json\n', { mode:0o600 }),
    code:'publisher_ledger_lock_corrupt',
  },
  {
    name:'符号链接',
    prepare:async (lockPath) => {
      const target = `${lockPath}.target`;
      await fs.writeFile(target, '{}\n', { mode:0o600 });
      await fs.symlink(target, lockPath);
    },
    code:'publisher_ledger_lock_unsafe_type',
  },
  {
    name:'权限过宽',
    prepare:async (lockPath) => {
      await fs.writeFile(lockPath, `${JSON.stringify({
        pid:7777,
        host:os.hostname(),
        createdAt:'2026-07-30T11:00:00.000Z',
        nonce:'unsafe_permissions',
      })}\n`, { mode:0o644 });
      await fs.chmod(lockPath, 0o644);
    },
    code:'publisher_ledger_lock_permissions_too_wide',
  },
]) {
  test(`${scenario.name}的锁一律硬停且保留原文件`, async (context) => {
    const file = await temporaryLedger(context, 'm5-publisher-lock-hard-stop-');
    const lockPath = `${file}.lock`;
    await scenario.prepare(lockPath);
    const repository = new FilePublisherRepository(file, {
      clock:() => new Date(NOW),
      maxWaitMs:10,
    });

    const error = await captureRejection(repository.update(() => undefined));

    assert.equal(error.code, scenario.code);
    assert.equal(error.recoveryAction.action, 'inspect_and_isolate_publisher_ledger_lock');
    await fs.lstat(lockPath);
  });
}

test('事务结束时锁 nonce 已变化则拒绝删除新所有者的锁', async (context) => {
  const file = await temporaryLedger(context, 'm5-publisher-lock-nonce-');
  const lockPath = `${file}.lock`;
  const repository = new FilePublisherRepository(file, {
    clock:() => new Date(NOW),
    hostname:'publisher-host',
    pid:4242,
    nonceFactory:() => 'original_owner_1234',
  });

  const error = await captureRejection(repository.update(async () => {
    await fs.writeFile(lockPath, `${JSON.stringify({
      pid:5252,
      host:'publisher-host',
      createdAt:NOW.toISOString(),
      nonce:'replacement_owner',
    })}\n`, { mode:0o600 });
  }));

  assert.equal(error.code, 'publisher_ledger_lock_ownership_lost');
  assert.equal(JSON.parse(await fs.readFile(lockPath, 'utf8')).nonce, 'replacement_owner');
});

test('恢复锁实现不改变既有 schemaVersion 2 账本格式和数据', async (context) => {
  const file = await temporaryLedger(context, 'm5-publisher-ledger-compat-');
  await fs.writeFile(file, `${JSON.stringify({
    schemaVersion:2,
    receipts:{ existing:{ receiptId:'existing' } },
    attempts:{ attempt:{ state:'published' } },
    metricSnapshots:[{ snapshotId:'metric-1' }],
    safetyLatch:{ active:false, reason:null, activatedAt:null },
  })}\n`, { mode:0o600 });
  const repository = new FilePublisherRepository(file);

  await repository.update((draft) => {
    draft.receipts.added = { receiptId:'added' };
  });
  const persisted = JSON.parse(await fs.readFile(file, 'utf8'));

  assert.equal(persisted.schemaVersion, 2);
  assert.equal(persisted.receipts.existing.receiptId, 'existing');
  assert.equal(persisted.receipts.added.receiptId, 'added');
  assert.equal(persisted.attempts.attempt.state, 'published');
  assert.deepEqual(persisted.metricSnapshots, [{ snapshotId:'metric-1' }]);
  assert.deepEqual(persisted.safetyLatch, { active:false, reason:null, activatedAt:null });
});

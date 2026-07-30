import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { performance } from 'node:perf_hooks';

const DEFAULT_LOCK_OPTIONS = Object.freeze({
  staleLockSafetyMs:5_000,
  retryIntervalMs:25,
  maxWaitMs:250,
});

const LOCK_RECOVERY_ACTION = '核对发布账本锁的所属进程和文件安全属性；确认无人发布后，由运维官隔离该锁再重试。';

function ledgerState(seed = {}) {
  return {
    schemaVersion:2,
    receipts:structuredClone(seed.receipts || {}),
    attempts:structuredClone(seed.attempts || {}),
    metricSnapshots:structuredClone(seed.metricSnapshots || []),
    costRecords:structuredClone(seed.costRecords || {}),
    safetyLatch:structuredClone(seed.safetyLatch || {
      active:false,
      reason:null,
      activatedAt:null,
    }),
  };
}

export class MemoryPublisherRepository {
  constructor(seed = {}) {
    this.data = ledgerState(seed);
    this.queue = Promise.resolve();
  }

  async read() {
    return ledgerState(this.data);
  }

  async write(data) {
    this.data = ledgerState(data);
  }

  async update(mutator) {
    const pending = this.queue.catch(() => undefined).then(async () => {
      const draft = ledgerState(this.data);
      const result = await mutator(draft);
      this.data = ledgerState(draft);
      return structuredClone(result);
    });
    this.queue = pending;
    return pending;
  }
}

export class FilePublisherRepository {
  constructor(filePath, {
    clock = () => new Date(),
    hostname = os.hostname(),
    pid = process.pid,
    isProcessAlive = processIsAlive,
    nonceFactory = () => crypto.randomUUID(),
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    staleLockSafetyMs = DEFAULT_LOCK_OPTIONS.staleLockSafetyMs,
    retryIntervalMs = DEFAULT_LOCK_OPTIONS.retryIntervalMs,
    maxWaitMs = DEFAULT_LOCK_OPTIONS.maxWaitMs,
  } = {}) {
    if (!path.isAbsolute(filePath)) throw new Error('发布账本必须使用明确的绝对路径。');
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('发布账本锁 PID 必须是正整数。');
    if (typeof hostname !== 'string' || !hostname.trim()) throw new Error('发布账本锁 host 不能为空。');
    for (const [name, value] of Object.entries({ staleLockSafetyMs, retryIntervalMs, maxWaitMs })) {
      if (!Number.isFinite(value) || value < 0) throw new Error(`${name} 必须是非负有限数字。`);
    }
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
    this.clock = clock;
    this.hostname = hostname;
    this.pid = pid;
    this.isProcessAlive = isProcessAlive;
    this.nonceFactory = nonceFactory;
    this.sleep = sleep;
    this.staleLockSafetyMs = staleLockSafetyMs;
    this.retryIntervalMs = retryIntervalMs;
    this.maxWaitMs = maxWaitMs;
  }

  async read() {
    try {
      return ledgerState(JSON.parse(await fs.readFile(this.filePath, 'utf8')));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      return ledgerState();
    }
  }

  async write(data) {
    await fs.mkdir(path.dirname(this.filePath), { recursive:true });
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(ledgerState(data), null, 2)}\n`, { mode:0o600 });
    await fs.rename(temporary, this.filePath);
  }

  async update(mutator) {
    await fs.mkdir(path.dirname(this.filePath), { recursive:true });
    const lock = await this.acquireLock();
    try {
      const draft = await this.read();
      const result = await mutator(draft);
      await this.write(draft);
      return result;
    } finally {
      await this.releaseLock(lock);
    }
  }

  async acquireLock() {
    const startedAt = performance.now();
    const owner = this.createLockOwner();
    while (true) {
      let created;
      try {
        created = await this.tryCreateLock(owner);
      } catch (error) {
        if (error?.code?.startsWith?.('publisher_ledger_lock_')) throw error;
        throw lockError('publisher_ledger_lock_create_failed', '无法安全创建发布账本锁，操作已停止。', this.lockPath, error);
      }
      if (created) return owner;
      const observed = await this.inspectLock();
      if (!observed) continue;
      const disposition = this.lockDisposition(observed.owner);
      if (disposition === 'recoverable') {
        await this.isolateStaleLock(observed);
        continue;
      }
      const elapsed = performance.now() - startedAt;
      if (elapsed >= this.maxWaitMs) {
        throw lockError(
          'publisher_ledger_lock_timeout',
          '发布账本仍被其他进程占用或锁处于安全期内；已在有界等待后停止，未抢占该锁。',
          this.lockPath,
        );
      }
      await this.sleep(Math.min(this.retryIntervalMs, Math.max(0, this.maxWaitMs - elapsed)));
    }
  }

  createLockOwner() {
    const createdAt = this.clock();
    const nonce = this.createNonce();
    if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) {
      throw lockError('publisher_ledger_lock_clock_invalid', '发布账本锁时钟无效，操作已停止。', this.lockPath);
    }
    return {
      pid:this.pid,
      host:this.hostname,
      createdAt:createdAt.toISOString(),
      nonce,
    };
  }

  createNonce() {
    const nonce = this.nonceFactory();
    if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(nonce)) {
      throw lockError('publisher_ledger_lock_nonce_invalid', '发布账本锁 nonce 无效，操作已停止。', this.lockPath);
    }
    return nonce;
  }

  async tryCreateLock(owner) {
    const temporary = `${this.lockPath}.candidate.${owner.nonce}`;
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await fs.link(temporary, this.lockPath);
        return true;
      } catch (error) {
        if (error?.code === 'EEXIST') return false;
        throw error;
      }
    } finally {
      await fs.unlink(temporary).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
      });
    }
  }

  async inspectLock(lockPath = this.lockPath) {
    let before;
    try {
      before = await fs.lstat(lockPath);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw lockError('publisher_ledger_lock_unreadable', '无法读取发布账本锁属性，操作已停止。', this.lockPath, error);
    }
    if (before.isSymbolicLink() || !before.isFile()) {
      throw lockError('publisher_ledger_lock_unsafe_type', '发布账本锁不是普通文件或为符号链接，操作已停止。', this.lockPath);
    }
    if ((before.mode & 0o077) !== 0) {
      throw lockError('publisher_ledger_lock_permissions_too_wide', '发布账本锁权限过宽，操作已停止。', this.lockPath);
    }

    let handle;
    try {
      handle = await fs.open(lockPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const during = await handle.stat();
      if (
        during.dev !== before.dev
        || during.ino !== before.ino
        || !during.isFile()
        || (during.mode & 0o077) !== 0
      ) {
        throw lockError('publisher_ledger_lock_changed', '发布账本锁在核验期间发生变化，操作已停止。', this.lockPath);
      }
      const raw = await handle.readFile('utf8');
      return {
        owner:parseLockOwner(raw, this.lockPath),
        dev:during.dev,
        ino:during.ino,
      };
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (error?.code?.startsWith?.('publisher_ledger_lock_')) throw error;
      throw lockError('publisher_ledger_lock_unreadable', '无法安全读取发布账本锁，操作已停止。', this.lockPath, error);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  lockDisposition(owner) {
    const now = this.clock();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw lockError('publisher_ledger_lock_clock_invalid', '发布账本锁时钟无效，操作已停止。', this.lockPath);
    }
    const createdAt = Date.parse(owner.createdAt);
    const age = now.getTime() - createdAt;
    if (age < 0) {
      throw lockError('publisher_ledger_lock_future_timestamp', '发布账本锁创建时间晚于当前时钟，所有权未知，操作已停止。', this.lockPath);
    }
    if (owner.host !== this.hostname) {
      throw lockError('publisher_ledger_lock_owner_unknown', '发布账本锁属于其他或未知主机，操作已停止。', this.lockPath);
    }
    let alive;
    try {
      alive = this.isProcessAlive(owner.pid);
    } catch (error) {
      throw lockError('publisher_ledger_lock_liveness_unknown', '无法核验发布账本锁所属进程，操作已停止。', this.lockPath, error);
    }
    if (alive || age < this.staleLockSafetyMs) return 'wait';
    return 'recoverable';
  }

  async isolateStaleLock(observed) {
    const quarantinePath = `${this.lockPath}.quarantine.${observed.owner.nonce}.${this.createNonce()}`;
    try {
      await fs.rename(this.lockPath, quarantinePath);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw lockError('publisher_ledger_lock_quarantine_failed', '无法原子隔离已确认的崩溃残锁，操作已停止。', this.lockPath, error);
    }
    let quarantined;
    try {
      quarantined = await this.inspectLock(quarantinePath);
      if (!sameObservedLock(observed, quarantined)) {
        await this.restoreMovedLock(quarantinePath);
        throw lockError('publisher_ledger_lock_changed', '发布账本锁在隔离期间发生变化，操作已停止。', this.lockPath);
      }
      await fs.unlink(quarantinePath);
    } catch (error) {
      if (error?.code?.startsWith?.('publisher_ledger_lock_')) throw error;
      throw lockError('publisher_ledger_lock_quarantine_failed', '隔离崩溃残锁后无法完成安全核验，操作已停止。', this.lockPath, error);
    }
  }

  async releaseLock(owner) {
    const observed = await this.inspectLock();
    if (!observed || observed.owner.nonce !== owner.nonce) {
      throw lockError('publisher_ledger_lock_ownership_lost', '发布账本锁所有权已变化；本进程未删除该锁并已停止。', this.lockPath);
    }
    const releasePath = `${this.lockPath}.release.${owner.nonce}.${this.createNonce()}`;
    try {
      await fs.rename(this.lockPath, releasePath);
    } catch (error) {
      throw lockError('publisher_ledger_lock_release_failed', '无法原子释放发布账本锁，操作已停止。', this.lockPath, error);
    }
    try {
      const released = await this.inspectLock(releasePath);
      if (!sameObservedLock(observed, released) || released.owner.nonce !== owner.nonce) {
        await this.restoreMovedLock(releasePath);
        throw lockError('publisher_ledger_lock_ownership_lost', '发布账本锁在释放期间发生变化；本进程未删除该锁并已停止。', this.lockPath);
      }
      await fs.unlink(releasePath);
    } catch (error) {
      if (error?.code?.startsWith?.('publisher_ledger_lock_')) throw error;
      throw lockError('publisher_ledger_lock_release_failed', '释放发布账本锁后无法完成安全核验，操作已停止。', this.lockPath, error);
    }
  }

  async restoreMovedLock(movedPath) {
    try {
      await fs.link(movedPath, this.lockPath);
      await fs.unlink(movedPath);
    } catch (error) {
      throw lockError(
        'publisher_ledger_lock_restore_failed',
        '锁竞争期间检测到所有权变化，无法安全还原被隔离文件，操作已硬停。',
        this.lockPath,
        error,
      );
    }
  }
}

function parseLockOwner(raw, lockPath) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw lockError('publisher_ledger_lock_corrupt', '发布账本锁内容损坏，操作已停止。', lockPath, error);
  }
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || !Number.isInteger(value.pid)
    || value.pid <= 0
    || typeof value.host !== 'string'
    || !value.host.trim()
    || typeof value.createdAt !== 'string'
    || !isCanonicalTimestamp(value.createdAt)
    || typeof value.nonce !== 'string'
    || !/^[A-Za-z0-9_-]{8,128}$/.test(value.nonce)
  ) {
    throw lockError('publisher_ledger_lock_corrupt', '发布账本锁字段损坏或不完整，操作已停止。', lockPath);
  }
  return {
    pid:value.pid,
    host:value.host,
    createdAt:value.createdAt,
    nonce:value.nonce,
  };
}

function isCanonicalTimestamp(value) {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function sameObservedLock(left, right) {
  return Boolean(
    left
    && right
    && left.dev === right.dev
    && left.ino === right.ino
    && left.owner.nonce === right.owner.nonce
    && left.owner.pid === right.owner.pid
    && left.owner.host === right.owner.host
    && left.owner.createdAt === right.owner.createdAt
  );
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

function lockError(code, message, lockPath, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  error.recoveryAction = {
    action:'inspect_and_isolate_publisher_ledger_lock',
    lockPath,
    instruction:LOCK_RECOVERY_ACTION,
  };
  return error;
}

export type SqliteBusyRetryOptions = {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
  onRetry?: (error: any, attempt: number, delayMs: number) => void;
};

export function isSqliteBusyError(error: any): boolean {
  if (!error) return false;
  const code = String(error?.code || error?.errcode || '').toUpperCase();
  if (code.includes('SQLITE_BUSY') || code.includes('SQLITE_LOCKED')) return true;
  const message = String(error?.message || '').toLowerCase();
  if (message.includes('database is locked') || message.includes('database is busy')) return true;
  return false;
}

export async function withBusyRetry<T>(
  operation: () => T | Promise<T>,
  options: SqliteBusyRetryOptions = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 5;
  const initialDelayMs = options.initialDelayMs ?? 15;
  const maxDelayMs = options.maxDelayMs ?? 150;
  const sleepFn = options.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  let attempt = 1;
  while (true) {
    try {
      return await operation();
    } catch (err: any) {
      if (attempt >= maxAttempts || !isSqliteBusyError(err)) {
        throw err;
      }
      // 随机微退避：[0.5, 1.5] * delay
      const baseDelay = Math.min(maxDelayMs, initialDelayMs * (2 ** (attempt - 1)));
      const jitterDelay = Math.floor(baseDelay * (0.5 + Math.random()));
      options.onRetry?.(err, attempt, jitterDelay);
      await sleepFn(jitterDelay);
      attempt += 1;
    }
  }
}

export function checkpointWal(
  database: any,
  { mode = 'PASSIVE' }: { mode?: 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE' } = {}
): { status: string; busy: number; log: number; checkpointed: number } {
  if (!database || typeof database.prepare !== 'function') {
    return { status: 'noop', busy: 0, log: 0, checkpointed: 0 };
  }

  try {
    const row = database.prepare(`PRAGMA wal_checkpoint(${mode})`).get();
    return {
      status: 'ok',
      busy: Number(row?.busy ?? 0),
      log: Number(row?.log ?? 0),
      checkpointed: Number(row?.checkpointed ?? 0),
    };
  } catch (err: any) {
    return {
      status: 'error',
      busy: 1,
      log: 0,
      checkpointed: 0,
    };
  }
}

export class SqliteWalGovernorReconciler {
  private database: any;
  private mode: 'PASSIVE' | 'TRUNCATE';

  constructor({ database, mode = 'PASSIVE' }: { database: any; mode?: 'PASSIVE' | 'TRUNCATE' }) {
    this.database = database;
    this.mode = mode;
  }

  async reconcile(): Promise<{ status: string; logFrames: number; checkpointedFrames: number }> {
    const res = checkpointWal(this.database, { mode: this.mode });
    return {
      status: res.status === 'ok' ? 'reconciled' : 'failed',
      logFrames: res.log,
      checkpointedFrames: res.checkpointed,
    };
  }
}

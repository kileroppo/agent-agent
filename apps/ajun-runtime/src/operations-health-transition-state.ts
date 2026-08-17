import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const SCHEMA_VERSION = 'agent.army/operations-health-transition/v1';

export class OperationsHealthTransitionState {
  filePath: string | null;
  currentStatus: 'unknown' | 'healthy' | 'degraded';
  pending: Promise<unknown>;

  constructor({ filePath = null }: { filePath?: string | null } = {}) {
    this.filePath = filePath ? path.resolve(filePath) : null;
    this.currentStatus = 'unknown';
    this.pending = Promise.resolve();
  }

  observe(input: { status: unknown; checkedAt?: unknown }) {
    const run = this.pending.then(() => this.#observe(input));
    this.pending = run.catch(() => undefined);
    return run;
  }

  async #observe({ status, checkedAt }: { status: unknown; checkedAt?: unknown }) {
    const next = normalizeStatus(status);
    const previous = this.filePath ? await readStatus(this.filePath) : this.currentStatus;
    const transition = Object.freeze({
      previous,
      current:next,
      changed:previous !== next,
      enteredDegraded:next === 'degraded' && previous !== 'degraded',
    });
    this.currentStatus = next;
    if (this.filePath) {
      await writeState(this.filePath, {
        schemaVersion:SCHEMA_VERSION,
        status:next,
        observedAt:validIsoTime(checkedAt) || new Date().toISOString(),
      });
    }
    return transition;
  }
}

export function operationsHealthTransitionPath(dataDir: unknown) {
  const directory = String(dataDir || '').trim();
  return directory ? path.join(path.resolve(directory), 'operations-health-transition.json') : null;
}

async function readStatus(filePath: string): Promise<'unknown' | 'healthy' | 'degraded'> {
  try {
    const metadata = await fs.lstat(filePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error('健康状态文件必须是普通文件。');
    const value = JSON.parse(await fs.readFile(filePath, 'utf8'));
    return value?.schemaVersion === SCHEMA_VERSION ? normalizeStoredStatus(value?.status) : 'unknown';
  }
  catch (error: any) {
    if (error?.code === 'ENOENT') return 'unknown';
    throw error;
  }
}

async function writeState(filePath: string, value: Readonly<Record<string, unknown>>) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive:true, mode:0o700 });
  await fs.chmod(directory, 0o700);
  try {
    const existing = await fs.lstat(filePath);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error('健康状态文件必须是普通文件。');
  }
  catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { flag:'wx', mode:0o600 });
    await fs.rename(temporary, filePath);
    await fs.chmod(filePath, 0o600);
  }
  finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

function normalizeStatus(value: unknown): 'healthy' | 'degraded' {
  return value === 'healthy' ? 'healthy' : 'degraded';
}

function normalizeStoredStatus(value: unknown): 'unknown' | 'healthy' | 'degraded' {
  return value === 'healthy' || value === 'degraded' ? value : 'unknown';
}

function validIsoTime(value: unknown) {
  const text = String(value || '').trim();
  return Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : null;
}

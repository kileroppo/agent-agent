import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ACTIVE_STATUSES } from './domain.ts';
import { interruptedByRestartFailure, knownLarkDeliveryRecoveryPatch, larkDeliveryUncertainFailure } from './recovery.ts';
import { isLarkDeliveryUncertain } from './lark-delivery.ts';

export type StoredJob = Record<string, unknown> & {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  log: Array<Record<string, unknown>>;
  ingress?: Readonly<{
    idempotencyKey?: string;
    platform?: string;
    messageId?: string;
    attachmentIndex?: number;
  }>;
  output?: Record<string, unknown>;
  failureHistory?: unknown[];
  error?: unknown;
  failure?: unknown;
  stageMessage?: string;
};

export class JobStore {
  private readonly file: string;
  private jobs: Map<string, StoredJob>;
  private pendingMutation: Promise<void>;

  constructor(workDir: string) {
    this.file = path.join(workDir, 'jobs.json');
    this.jobs = new Map();
    this.pendingMutation = Promise.resolve();
  }

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const jobs = JSON.parse(await fs.readFile(this.file, 'utf8')) as StoredJob[];
      for (const job of jobs) {
        if (ACTIVE_STATUSES.has(job.status)) {
          const knownDelivery = knownLarkDeliveryRecoveryPatch(job);
          if (knownDelivery) {
            Object.assign(job, knownDelivery);
            job.updatedAt = new Date().toISOString();
            job.log = [...(job.log || []), { at:job.updatedAt, stage:job.status, message:'已从持久化飞书交付凭据恢复任务状态' }];
          } else {
            const deliveryUncertain = isLarkDeliveryUncertain(job.output?.larkDelivery);
            const failure = deliveryUncertain ? larkDeliveryUncertainFailure() : interruptedByRestartFailure();
            job.status = 'failed';
            job.error = deliveryUncertain
              ? '服务在飞书交付结果确认前中断，已禁止自动重试。'
              : '服务重启导致任务中断，请重试。';
            job.failure = failure;
            job.stageMessage = deliveryUncertain ? '飞书交付结果待人工核对' : '任务已中断';
            job.updatedAt = new Date().toISOString();
            job.failureHistory = [...(job.failureHistory || []), { at: job.updatedAt, error: job.error, failure }];
            job.log = [...(job.log || []), { at: job.updatedAt, stage: 'failed', message: job.error }];
          }
        }
        this.jobs.set(job.id, job);
      }
      await this.persist();
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }

  list(): StoredJob[] { return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  get(id: string): StoredJob | null { return this.jobs.get(id) || null; }
  findByIngressKey(key: unknown): StoredJob | null {
    if (!key) return null;
    return this.list().find((job) => job.ingress?.idempotencyKey === key) || null;
  }

  async create(job: StoredJob): Promise<StoredJob> {
    return this.mutate(async () => {
      this.jobs.set(job.id, job);
      await this.persist();
      return job;
    });
  }

  async createOrGetByIngressKey(job: StoredJob): Promise<Readonly<{ job: StoredJob; created: boolean }>> {
    return this.mutate(async () => {
      const existing = this.findByIngressKey(job.ingress?.idempotencyKey);
      if (existing) {
        if (jobIntentFingerprint(existing) !== jobIntentFingerprint(job)) {
          throw new JobStoreConflictError('同一幂等标识对应了不同的小D任务输入。');
        }
        return { job: existing, created: false };
      }
      this.jobs.set(job.id, job);
      await this.persist();
      return { job, created: true };
    });
  }

  async update(
    id: string,
    patch: Record<string, unknown>,
    logEntry: Readonly<{ stage: string; message: string }> | null = null,
  ): Promise<StoredJob | null> {
    return this.mutate(async () => {
      const job = this.get(id);
      if (!job) return null;
      Object.assign(job, patch, { updatedAt: new Date().toISOString() });
      if (logEntry) job.log.push({ at: job.updatedAt, ...logEntry });
      await this.persist();
      return job;
    });
  }

  async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const execute = async () => {
      const snapshot: Array<[string, StoredJob]> = [...this.jobs.entries()]
        .map(([id, job]) => [id, structuredClone(job)]);
      try {
        return await operation();
      } catch (error) {
        this.jobs = new Map(snapshot);
        throw error;
      }
    };
    const run = this.pendingMutation.then(execute, execute);
    this.pendingMutation = run.then(() => undefined, () => undefined);
    return run;
  }

  async persist(): Promise<void> {
    const temporary = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(this.list(), null, 2)}\n`, { flag:'wx', mode:0o600 });
      await fs.rename(temporary, this.file);
      await fs.chmod(this.file, 0o600);
    } catch (error) {
      await fs.rm(temporary, { force:true }).catch(() => {});
      throw error;
    }
  }
}

export class JobStoreConflictError extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = 'JobStoreConflictError';
  }
}

function jobIntentFingerprint(job: StoredJob): string {
  const ingress = job.ingress || {};
  const intent = {
    sourceType:job?.sourceType || null,
    sourceUrl:job?.sourceUrl || null,
    originalName:job?.originalName || null,
    ingressPlatform:ingress.platform || null,
    ingressMessageId:ingress.messageId || null,
    ingressAttachmentIndex:ingress.attachmentIndex ?? null,
    connectionId:job?.connectionId || null,
    reviewPolicy:job?.reviewPolicy || null,
    visualMode:job?.visualMode || null,
    analysisDepth:job?.analysisDepth || null,
    deliveryMode:job?.deliveryMode || null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(intent)).digest('hex');
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error
    ? String(error.code || '')
    : '';
}

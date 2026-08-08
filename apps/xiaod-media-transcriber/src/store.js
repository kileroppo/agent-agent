import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ACTIVE_STATUSES } from './domain.js';
import { interruptedByRestartFailure, knownLarkDeliveryRecoveryPatch, larkDeliveryUncertainFailure } from './recovery.js';
import { isLarkDeliveryUncertain } from './lark-delivery.js';

export class JobStore {
  constructor(workDir) {
    this.file = path.join(workDir, 'jobs.json');
    this.jobs = new Map();
    this.pendingMutation = Promise.resolve();
  }

  async init() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const jobs = JSON.parse(await fs.readFile(this.file, 'utf8'));
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
      if (error.code !== 'ENOENT') throw error;
    }
  }

  list() { return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  get(id) { return this.jobs.get(id); }
  findByIngressKey(key) {
    if (!key) return null;
    return this.list().find((job) => job.ingress?.idempotencyKey === key) || null;
  }

  async create(job) {
    return this.mutate(async () => {
      this.jobs.set(job.id, job);
      await this.persist();
      return job;
    });
  }

  async createOrGetByIngressKey(job) {
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

  async update(id, patch, logEntry = null) {
    return this.mutate(async () => {
      const job = this.get(id);
      if (!job) return null;
      Object.assign(job, patch, { updatedAt: new Date().toISOString() });
      if (logEntry) job.log.push({ at: job.updatedAt, ...logEntry });
      await this.persist();
      return job;
    });
  }

  async mutate(operation) {
    const execute = async () => {
      const snapshot = [...this.jobs.entries()].map(([id, job]) => [id, structuredClone(job)]);
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

  async persist() {
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
  constructor(message) {
    super(message);
    this.name = 'JobStoreConflictError';
    this.status = 409;
  }
}

function jobIntentFingerprint(job) {
  const intent = {
    sourceType:job?.sourceType || null,
    sourceUrl:job?.sourceUrl || null,
    originalName:job?.originalName || null,
    ingressPlatform:job?.ingress?.platform || null,
    ingressMessageId:job?.ingress?.messageId || null,
    ingressAttachmentIndex:job?.ingress?.attachmentIndex ?? null,
    connectionId:job?.connectionId || null,
    reviewPolicy:job?.reviewPolicy || null,
    visualMode:job?.visualMode || null,
    analysisDepth:job?.analysisDepth || null,
    deliveryMode:job?.deliveryMode || null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(intent)).digest('hex');
}

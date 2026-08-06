import fs from 'node:fs/promises';
import path from 'node:path';
import { ACTIVE_STATUSES } from './domain.js';
import { interruptedByRestartFailure } from './recovery.js';

export class JobStore {
  constructor(workDir) {
    this.file = path.join(workDir, 'jobs.json');
    this.jobs = new Map();
  }

  async init() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const jobs = JSON.parse(await fs.readFile(this.file, 'utf8'));
      for (const job of jobs) {
        if (ACTIVE_STATUSES.has(job.status)) {
          const failure = interruptedByRestartFailure();
          job.status = 'failed';
          job.error = '服务重启导致任务中断，请重试。';
          job.failure = failure;
          job.stageMessage = '任务已中断';
          job.updatedAt = new Date().toISOString();
          job.failureHistory = [...(job.failureHistory || []), { at: job.updatedAt, error: job.error, failure }];
          job.log = [...(job.log || []), { at: job.updatedAt, stage: 'failed', message: job.error }];
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

  async create(job) { this.jobs.set(job.id, job); await this.persist(); return job; }

  async createOrGetByIngressKey(job) {
    const existing = this.findByIngressKey(job.ingress?.idempotencyKey);
    if (existing) return { job: existing, created: false };
    this.jobs.set(job.id, job);
    await this.persist();
    return { job, created: true };
  }

  async update(id, patch, logEntry = null) {
    const job = this.get(id);
    if (!job) return null;
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    if (logEntry) job.log.push({ at: job.updatedAt, ...logEntry });
    await this.persist();
    return job;
  }

  async persist() {
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.list(), null, 2));
    await fs.rename(tmp, this.file);
  }
}

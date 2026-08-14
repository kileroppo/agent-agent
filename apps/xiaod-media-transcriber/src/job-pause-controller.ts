const ACTIVE_JOB_STATUSES = new Set(['queued', 'preparing', 'acquiring', 'transcribing', 'distilling', 'delivering', 'pausing']);

type JobPause = Readonly<{
  requestedAt?: string;
  pausedAt?: string;
  safePoint?: string | null;
  resumedAt?: string;
}>;
type JobRecord = Record<string, unknown> & {
  id: string;
  status: string;
  pause?: JobPause;
};
type JobPatch = Record<string, unknown> & { status?: string; pause?: JobPause };
type JobStore = Readonly<{
  get(jobId: string): JobRecord | null;
  update(
    jobId: string,
    patch: JobPatch,
    log?: Readonly<{ stage: string; message: string }>,
  ): Promise<JobRecord | null>;
}>;

export class JobPauseController {
  private readonly store: JobStore;
  private readonly now: () => Date;

  constructor({ store, now = () => new Date() }: Readonly<{
    store: JobStore;
    now?: () => Date;
  }>) {
    this.store = store;
    this.now = now;
  }

  async request(jobId: string): Promise<JobRecord> {
    const job = this.store.get(jobId);
    if (!job) throw new JobPauseError('任务不存在。');
    if (job.status === 'paused') return job;
    if (!ACTIVE_JOB_STATUSES.has(job.status)) throw new JobPauseError('只有尚未完成的任务可以暂停。');
    const at = this.now().toISOString();
    if (job.status === 'queued') {
      return requireUpdated(await this.store.update(jobId, {
        status: 'paused', stageMessage: '已暂停，尚未开始处理',
        pause: { requestedAt: at, pausedAt: at, safePoint: 'queued' }
      }, { stage: 'paused', message: '已在开始前暂停' }));
    }
    return requireUpdated(await this.store.update(jobId, {
      status: 'pausing', stageMessage: '正在暂停：会先完成当前这一步，不再开始下一步',
      pause: { ...(job.pause || {}), requestedAt: at }
    }, { stage: 'pausing', message: '已请求暂停，等待安全位置' }));
  }

  async checkpoint(jobId: string, safePoint = 'checkpoint'): Promise<false> {
    const job = this.store.get(jobId);
    if (!job) throw new JobPauseError('任务不存在。');
    if (job.status === 'paused') throw new JobPausedError(jobId);
    if (job.status !== 'pausing' && !job.pause?.requestedAt) return false;
    const at = this.now().toISOString();
    await this.store.update(jobId, {
      status: 'paused', stageMessage: '已暂停，可在确认后继续处理',
      pause: { ...(job.pause || {}), pausedAt: at, safePoint }
    }, { stage: 'paused', message: `已在${safePoint}安全位置暂停` });
    throw new JobPausedError(jobId);
  }

  async resume(jobId: string): Promise<JobRecord> {
    const job = this.store.get(jobId);
    if (!job) throw new JobPauseError('任务不存在。');
    if (job.status !== 'paused') throw new JobPauseError('只有已暂停的任务可以继续。');
    const resumedAt = this.now().toISOString();
    return requireUpdated(await this.store.update(jobId, {
      status: 'queued', stageMessage: '已继续处理，会从已保存的安全位置重新检查素材',
      // `requestedAt` is intentionally cleared.  Keeping it would make the
      // next normal checkpoint interpret this resumed job as another pause.
      pause: { safePoint: job.pause?.safePoint || null, resumedAt }
    }, { stage: 'queued', message: '已请求继续处理' }));
  }
}

function requireUpdated(job: JobRecord | null): JobRecord {
  if (!job) throw new JobPauseError('任务不存在。');
  return job;
}

export class JobPauseError extends Error {}
export class JobPausedError extends Error {
  constructor(jobId: string) { super(`任务 ${jobId} 已暂停。`); this.name = 'JobPausedError'; }
}

export type ReconciliationJob = {
  name: string;
  reconcile: () => Promise<any> | any;
  intervalMs?: number;
  maxIntervalMs?: number;
};

type JobState = ReconciliationJob & {
  idleRuns: number;
  nextRunAt: number;
  wakeRequested: boolean;
  lastErrorSignature: string;
};

export class ReconciliationCoordinator {
  jobs = new Map<string, JobState>();
  mutationSource: any;
  now: () => number;
  onEvent: ((event: any) => void) | null;
  setTimer: any;
  clearTimer: any;
  timer: any = null;
  unsubscribe: (() => void) | null = null;
  started = false;
  running: Promise<any> | null = null;

  constructor({ jobs = [], mutationSource = null, now = () => Date.now(), onEvent = null, setTimer = setTimeout, clearTimer = clearTimeout }: any = {}) {
    this.mutationSource = mutationSource;
    this.now = now;
    this.onEvent = onEvent;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    for (const job of jobs) this.register(job);
  }

  register(job: ReconciliationJob) {
    const name = String(job?.name || '').trim();
    if (!name || typeof job?.reconcile !== 'function') throw new Error('协调任务必须提供 name 和 reconcile。');
    const intervalMs = positive(job.intervalMs, 3_000);
    this.jobs.set(name, {
      ...job,
      name,
      intervalMs,
      maxIntervalMs:Math.max(intervalMs, positive(job.maxIntervalMs, 60_000)),
      idleRuns:0,
      nextRunAt:this.now(),
      wakeRequested:false,
      lastErrorSignature:'',
    });
    if (this.started) this.schedule();
    return this;
  }

  start() {
    if (this.started) return;
    this.started = true;
    if (typeof this.mutationSource?.subscribe === 'function') {
      const unsubscribe = this.mutationSource.subscribe(() => this.wake());
      this.unsubscribe = typeof unsubscribe === 'function' ? unsubscribe : null;
    }
    this.wake();
  }

  stop() {
    this.started = false;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  wake(names: string | string[] | null = null) {
    const selected = names == null ? [...this.jobs.keys()] : Array.isArray(names) ? names : [names];
    for (const name of selected) {
      const job = this.jobs.get(name);
      if (!job) continue;
      job.nextRunAt = this.now();
      job.wakeRequested = Boolean(this.running);
      job.idleRuns = 0;
    }
    if (this.started) this.schedule(0);
  }

  async runDue({ force = false }: { force?: boolean } = {}) {
    if (this.running) return this.running;
    const startedAt = this.now();
    const due = [...this.jobs.values()].filter((job) => force || job.nextRunAt <= startedAt);
    this.running = Promise.all(due.map((job) => this.runJob(job, startedAt)))
      .finally(() => {
        this.running = null;
        if (this.started) this.schedule();
      });
    return this.running;
  }

  private async runJob(job: JobState, startedAt: number) {
    job.wakeRequested = false;
    try {
      const result = await job.reconcile();
      const workCount = reconciliationWorkCount(result);
      if (job.lastErrorSignature) this.onEvent?.({ type:'reconciliation_recovered', job:job.name });
      job.lastErrorSignature = '';
      job.idleRuns = workCount > 0 ? 0 : job.idleRuns + 1;
      const delay = workCount > 0
        ? job.intervalMs!
        : Math.min(job.maxIntervalMs!, job.intervalMs! * (2 ** job.idleRuns));
      job.nextRunAt = job.wakeRequested ? this.now() : startedAt + delay;
      return { name:job.name, workCount, result };
    }
    catch (error: any) {
      job.idleRuns += 1;
      const signature = safeErrorSignature(error);
      if (signature !== job.lastErrorSignature) {
        job.lastErrorSignature = signature;
        this.onEvent?.({ type:'reconciliation_failed', job:job.name, reason:signature });
      }
      const delay = Math.min(job.maxIntervalMs!, job.intervalMs! * (2 ** job.idleRuns));
      job.nextRunAt = job.wakeRequested ? this.now() : startedAt + delay;
      return { name:job.name, workCount:0, error:signature };
    }
  }

  private schedule(delayOverride?: number) {
    if (!this.started || this.running || this.jobs.size === 0) return;
    if (this.timer) this.clearTimer(this.timer);
    const nextRunAt = Math.min(...[...this.jobs.values()].map((job) => job.nextRunAt));
    const delay = delayOverride ?? Math.max(0, nextRunAt - this.now());
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.runDue();
    }, delay);
    this.timer.unref?.();
  }
}

export function reconciliationJob(name: string, reconciler: any, options: any = {}): ReconciliationJob {
  return {
    name,
    reconcile:() => reconciler.reconcile(),
    intervalMs:options.intervalMs || reconciler.intervalMs,
    maxIntervalMs:options.maxIntervalMs,
  };
}

function reconciliationWorkCount(result: any) {
  if (Number.isFinite(result)) return Math.max(0, Number(result));
  if (Number.isFinite(result?.workCount)) return Math.max(0, Number(result.workCount));
  if (Number.isFinite(result?.processed)) return Math.max(0, Number(result.processed));
  return result?.changed === true ? 1 : 0;
}

function safeErrorSignature(error: any) {
  const code = String(error?.code || error?.name || 'reconciliation_failed').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 80);
  const message = String(error?.message || '后台检查暂时失败。').replace(/(token|secret|cookie|authorization)\s*[:=]\s*\S+/gi, '$1=[已隐藏]').replace(/\s+/g, ' ').trim().slice(0, 180);
  return `${code}:${message}`;
}

function positive(value: any, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

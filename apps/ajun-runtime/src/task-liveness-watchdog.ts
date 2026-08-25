import { spawn } from 'node:child_process';

export type TaskLivenessWatchdogOptions = {
  store?: any;
  onTaskStalled?: (task: any) => Promise<void> | void;
  defaultLeaseMs?: number;
  typeLeaseOverrides?: Record<string, number>;
  now?: () => number;
  killProcess?: (pid: number, options?: { graceMs?: number; signal?: NodeJS.Signals }) => Promise<boolean>;
};

export type HeartbeatRecord = {
  lastHeartbeatAt: number;
  pid?: number;
  metadata?: Record<string, unknown>;
};

const DEFAULT_LEASE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_TYPE_OVERRIDES: Record<string, number> = {
  'media.transcribe': 15 * 60 * 1000,
  'content.video-benchmark-analysis': 20 * 60 * 1000,
  'report.intel-research': 10 * 60 * 1000,
  'content.campaign-render': 25 * 60 * 1000,
};

export async function abortProcessTree(
  pid: number,
  { graceMs = 1500, signal = 'SIGTERM' as NodeJS.Signals }: { graceMs?: number; signal?: NodeJS.Signals } = {}
): Promise<boolean> {
  if (!pid || pid <= 0 || pid === process.pid) return false;
  try {
    const childPids = await getChildPids(pid);
    const allPids = [...childPids, pid];
    for (const targetPid of allPids) {
      try { process.kill(targetPid, signal); } catch {}
    }
    if (graceMs > 0) await new Promise((resolve) => setTimeout(resolve, graceMs));
    for (const targetPid of allPids) {
      try {
        process.kill(targetPid, 0);
        process.kill(targetPid, 'SIGKILL');
      } catch {}
    }
    return true;
  } catch { return false; }
}

async function getChildPids(parentPid: number): Promise<number[]> {
  return new Promise((resolve) => {
    const pgrep = spawn('pgrep', ['-P', String(parentPid)]);
    let stdout = '';
    pgrep.stdout.on('data', (d) => { stdout += d.toString(); });
    pgrep.on('error', () => resolve([]));
    pgrep.on('close', () => {
      resolve(stdout.trim().split(/\s+/).map((s) => Number.parseInt(s, 10)).filter((n) => !Number.isNaN(n) && n > 0));
    });
  });
}

export class TaskLivenessWatchdog {
  private store: any;
  private onTaskStalled?: (task: any) => Promise<void> | void;
  private defaultLeaseMs: number;
  private typeLeaseOverrides: Record<string, number>;
  private now: () => number;
  private killProcess: (pid: number, options?: any) => Promise<boolean>;
  private heartbeats = new Map<string, HeartbeatRecord>();

  constructor(options: TaskLivenessWatchdogOptions = {}) {
    this.store = options.store;
    this.onTaskStalled = options.onTaskStalled;
    this.defaultLeaseMs = options.defaultLeaseMs ?? DEFAULT_LEASE_TIMEOUT_MS;
    this.typeLeaseOverrides = { ...DEFAULT_TYPE_OVERRIDES, ...options.typeLeaseOverrides };
    this.now = options.now ?? (() => Date.now());
    this.killProcess = options.killProcess ?? abortProcessTree;
  }

  recordHeartbeat(taskId: string, { pid, metadata, at = this.now() }: { pid?: number; metadata?: Record<string, unknown>; at?: number } = {}) {
    if (!taskId) return;
    this.heartbeats.set(taskId, { lastHeartbeatAt: at, pid, metadata });
  }

  clearHeartbeat(taskId: string) {
    this.heartbeats.delete(taskId);
  }

  getHeartbeat(taskId: string): HeartbeatRecord | undefined {
    return this.heartbeats.get(taskId);
  }

  getLeaseDuration(taskType?: string): number {
    return (taskType && this.typeLeaseOverrides[taskType]) || this.defaultLeaseMs;
  }

  async checkStalledTasks({ now = this.now() }: { now?: number } = {}): Promise<{ stalledCount: number; checkedCount: number; stalledTaskIds: string[] }> {
    if (!this.store || typeof this.store.list !== 'function') {
      return { stalledCount: 0, checkedCount: 0, stalledTaskIds: [] };
    }
    const allTasks = await this.store.list();
    const activeTasks = allTasks.filter((t: any) => ['running', 'planning', 'acquiring', 'analyzing'].includes(String(t?.status || '')));
    const stalledTaskIds: string[] = [];

    for (const task of activeTasks) {
      const leaseMs = this.getLeaseDuration(task.taskType || task.type);
      const heartbeat = this.heartbeats.get(task.taskId);
      const lastActivityAt = heartbeat?.lastHeartbeatAt
        || (task.updatedAt ? new Date(task.updatedAt).getTime() : 0)
        || (task.startedAt ? new Date(task.startedAt).getTime() : 0)
        || (task.createdAt ? new Date(task.createdAt).getTime() : 0);

      const elapsed = now - lastActivityAt;
      if (lastActivityAt > 0 && elapsed > leaseMs) {
        stalledTaskIds.push(task.taskId);
        const pidToKill = heartbeat?.pid || task.runtime?.pid || task.pid;
        if (pidToKill) await this.killProcess(pidToKill);

        const failedTask = {
          ...task,
          status: 'failed',
          updatedAt: new Date(now).toISOString(),
          error: {
            code: 'task_execution_stalled',
            category: 'runtime_stall',
            message: `任务已超过 ${Math.round(leaseMs / 1000)} 秒未上报心跳进展，已受控终止。`,
            stalledForSeconds: Math.round(elapsed / 1000),
          },
          recovery: { coordination: { status: 'pending', reason: 'task_stalled_auto_recovered', registeredAt: new Date(now).toISOString() } },
        };
        if (typeof this.store.save === 'function') await this.store.save(failedTask);
        this.clearHeartbeat(task.taskId);
        try { await this.onTaskStalled?.(failedTask); } catch {}
      }
    }
    return { stalledCount: stalledTaskIds.length, checkedCount: activeTasks.length, stalledTaskIds };
  }

  async reconcile(): Promise<{ status: string; stalledCount: number; checkedCount: number }> {
    const result = await this.checkStalledTasks();
    return { status: 'reconciled', stalledCount: result.stalledCount, checkedCount: result.checkedCount };
  }
}

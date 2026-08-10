export class TaskCreationCoordinator {
  create: (input: any) => any;
  runs: Map<string, { fingerprint: string; execution: Promise<any> }>;
  constructor(create: (input: any) => any) { this.create = create; this.runs = new Map(); }

  run(input: any = {}) {
    const key = String(input.idempotencyKey || '').trim();
    if (!key) return this.create(input);
    const fingerprint = taskIdempotencyFingerprint(input);
    const running = this.runs.get(key);
    if (running) {
      if (running.fingerprint !== fingerprint) throw idempotencyConflict();
      return running.execution;
    }
    const execution = Promise.resolve().then(() => this.create(input)).finally(() => {
      if (this.runs.get(key)?.execution === execution) this.runs.delete(key);
    });
    this.runs.set(key, { fingerprint, execution });
    return execution;
  }
}

export function taskIdempotencyFingerprint(input: any) {
  return JSON.stringify(normalize({ ...input, idempotencyKey:undefined }));
}

function normalize(value: any): any {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, normalize(value[key])]));
}

function idempotencyConflict() {
  const error: Error & { code?: string } = new Error('同一幂等键正在处理不同的任务内容；已拒绝串用结果。');
  error.code = 'task_idempotency_conflict';
  return error;
}

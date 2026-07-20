const DEFAULT_XIAOD_URL = 'http://127.0.0.1:4318';

export class XiaodDelegate {
  constructor({ baseUrl = process.env.XIAOD_RUNTIME_URL || DEFAULT_XIAOD_URL, fetchImpl = fetch, onStarted = () => {} } = {}) {
    this.baseUrl = loopbackUrl(baseUrl);
    this.fetch = fetchImpl;
    this.onStarted = onStarted;
  }

  async execute(task) {
    const sourceUrl = String(task.input.sourceUrl || '').trim();
    if (!sourceUrl) return {
      status: 'needs_input', currentStage: 'source_url_required',
      routing: { ...task.routing, reason: '请补充一个公开 HTTP(S) 素材链接后再交给小D。' }
    };
    const response = await this.fetch(`${this.baseUrl}/api/jobs`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: sourceUrl }), signal: AbortSignal.timeout(5000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.job?.id) throw new Error(payload.error || `小D返回 ${response.status}`);
    const job = payload.job;
    return {
      status: 'running', currentStage: 'delegated_to_xiaod',
      execution: { executor: 'xiaod', mode: 'local_media_delegate', startedAt: new Date().toISOString(), xiaodJobId: job.id, sourceUrl },
      artifactRefs: []
    };
  }

  observe(task) {
    const jobId = task.execution?.xiaodJobId;
    if (jobId) this.onStarted({ taskId: task.taskId, xiaodJobId: jobId });
  }

  async getJob(jobId) {
    const response = await this.fetch(`${this.baseUrl}/api/jobs/${encodeURIComponent(jobId)}`, { signal: AbortSignal.timeout(5000) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.job) throw new Error(payload.error || `小D任务读取失败 ${response.status}`);
    return payload.job;
  }
}

function loopbackUrl(value) {
  const parsed = new URL(value);
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) throw new Error('小D运行时只允许本机回环地址。');
  return parsed.toString().replace(/\/$/, '');
}

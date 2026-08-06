export class XiaodLocalClient {
  constructor({ baseUrl, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async create({ sourceUrl, idempotencyKey }) {
    const response = await this.fetch(`${this.baseUrl}/api/jobs`, {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ url:sourceUrl, idempotencyKey }),
      signal:AbortSignal.timeout(this.timeoutMs)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.job?.id) throw new Error(payload.error || `小D返回 ${response.status}`);
    return payload.job;
  }

  async get(jobId) {
    const response = await this.fetch(`${this.baseUrl}/api/jobs/${encodeURIComponent(jobId)}`, {
      signal:AbortSignal.timeout(this.timeoutMs)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.job) {
      const error = new Error(payload.error || `小D任务读取失败 ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload.job;
  }
}

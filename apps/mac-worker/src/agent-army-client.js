export class AgentArmyCloudClient {
  constructor({ baseUrl, token, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.token = token;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  lease(workerId) {
    return this.request('/api/worker/lease', {
      workerId,
      capabilities:['media.transcribe-and-refine']
    });
  }

  heartbeat(taskId, payload) {
    return this.request(`/api/worker/tasks/${encodeURIComponent(taskId)}/heartbeat`, payload);
  }

  complete(taskId, payload) {
    return this.request(`/api/worker/tasks/${encodeURIComponent(taskId)}/complete`, payload);
  }

  async request(path, body) {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method:'POST',
      headers:{ authorization:`Bearer ${this.token}`, 'content-type':'application/json' },
      body:JSON.stringify(body),
      signal:AbortSignal.timeout(this.timeoutMs)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new WorkerHttpError(payload.error || `云端办公室返回 ${response.status}`, response.status);
    return payload;
  }
}

export class WorkerHttpError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

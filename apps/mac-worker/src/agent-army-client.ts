export class AgentArmyCloudClient {
    readonly baseUrl: string;
    readonly token: string;
    readonly fetch: (...args: any[]) => Promise<any>;
    readonly timeoutMs: number;

    constructor({ baseUrl, token, fetchImpl = fetch, timeoutMs = 10000 }: any = {}) {
        this.baseUrl = String(baseUrl).replace(/\/$/, '');
        this.token = token;
        this.fetch = fetchImpl;
        this.timeoutMs = timeoutMs;
    }
    lease(workerId: any) {
        return this.request('/api/worker/lease', {
            workerId,
            capabilities: ['media.transcribe-and-refine']
        });
    }
    heartbeat(taskId: any, payload: any) {
        return this.request(`/api/worker/tasks/${encodeURIComponent(taskId)}/heartbeat`, payload);
    }
    complete(taskId: any, payload: any) {
        return this.request(`/api/worker/tasks/${encodeURIComponent(taskId)}/complete`, payload);
    }
    async request(path: any, body: any) {
        const response = await this.fetch(`${this.baseUrl}${path}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(this.timeoutMs)
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok)
            throw new WorkerHttpError(payload.error || `云端办公室返回 ${response.status}`, response.status);
        return payload;
    }
}
export class WorkerHttpError extends Error {
    readonly status: number;

    constructor(message: any, status: any) { super(message); this.status = status; }
}

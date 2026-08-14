const DEFAULT_XIAOD_URL: any = 'http://127.0.0.1:4318';
export class XiaodDelegate {
    baseUrl: any;
    fetch: any;
    onStarted: any;
    constructor({ baseUrl = process.env.XIAOD_RUNTIME_URL || DEFAULT_XIAOD_URL, fetchImpl = fetch, onStarted = (): any => { } }: any = {}) {
        this.baseUrl = loopbackUrl(baseUrl);
        this.fetch = fetchImpl;
        this.onStarted = onStarted;
    }
    async execute(task: any): Promise<any> {
        const sourceUrl: any = String(task.input.sourceUrl || '').trim();
        if (!sourceUrl)
            return {
                status: 'needs_input', currentStage: 'source_url_required',
                routing: { ...task.routing, reason: '请补充一个公开 HTTP(S) 素材链接后再交给小D。' }
            };
        const response: any = await this.fetch(`${this.baseUrl}/api/jobs`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
                url: sourceUrl,
                ...(task.input?.connectionId ? { connectionId: task.input.connectionId } : {}),
                reviewPolicy: task.input?.reviewPolicy === 'required' ? 'required' : 'optional',
                visualMode: task.input?.visualMode === 'auto' || task.input?.visualMode === 'required' ? task.input.visualMode : 'off',
                analysisDepth: task.input?.depth === 'full' ? 'full' : 'fast',
                deliveryMode: shouldDeliverToFeishu(task) ? 'feishu' : 'local_only',
                idempotencyKey: `agent-army:${task.taskId}`
            }), signal: AbortSignal.timeout(5000)
        });
        const payload: any = await response.json().catch((): any => ({}));
        if (!response.ok || !payload.job?.id)
            throw new Error(payload.error || `小D返回 ${response.status}`);
        const job: any = payload.job;
        return {
            status: 'running', currentStage: 'delegated_to_xiaod',
            execution: {
                executor: 'xiaod', mode: 'local_media_delegate', startedAt: new Date().toISOString(), xiaodJobId: job.id, sourceUrl,
                connectionBinding: job.connectionBinding || null,
                polling: { state: 'pending', consecutiveFailures: 0, nextPollAt: new Date().toISOString() }
            },
            usage: { tools: [{ id: 'xiaod-local-api', name: '小D本机处理', calls: 1 }] },
            artifactRefs: []
        };
    }
    observe(task: any): any {
        const jobId: any = task.execution?.xiaodJobId;
        if (jobId)
            this.onStarted({ taskId: task.taskId, xiaodJobId: jobId });
    }
    async getJob(jobId: any): Promise<any> {
        const response: any = await this.fetch(`${this.baseUrl}/api/jobs/${encodeURIComponent(jobId)}`, { signal: AbortSignal.timeout(5000) });
        const payload: any = await response.json().catch((): any => ({}));
        if (!response.ok || !payload.job)
            throw new Error(payload.error || `小D任务读取失败 ${response.status}`);
        return payload.job;
    }
    async getTranscriptRevision(task: any): Promise<any> {
        const jobId: any = xiaodJobIdFor(task, '读取字幕');
        const response: any = await this.fetch(`${this.baseUrl}/api/jobs/${encodeURIComponent(jobId)}/transcript-revision`, {
            signal: AbortSignal.timeout(5000)
        });
        const payload: any = await response.json().catch((): any => ({}));
        if (!response.ok || !payload.revision)
            throw downstreamError(payload, response, `小D字幕读取失败 ${response.status}`, 'xiaod_transcript_revision_read_failed');
        if (String(payload.revision.jobId || '') !== jobId)
            throw new Error('小D返回了不属于当前任务的字幕版本。');
        return payload.revision;
    }
    async reviseTranscript(task: any, { expectedVersion, correctedTranscript, correctionSummary = '', editorRef = 'local-owner', }: any = {}): Promise<any> {
        const jobId: any = xiaodJobIdFor(task, '补正字幕');
        const response: any = await this.fetch(`${this.baseUrl}/api/jobs/${encodeURIComponent(jobId)}/transcript-revisions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ expectedVersion, correctedTranscript, correctionSummary, editorRef }),
            signal: AbortSignal.timeout(30000)
        });
        const payload: any = await response.json().catch((): any => ({}));
        if (!response.ok || !payload.job || !payload.revision)
            throw downstreamError(payload, response, `小D字幕补正失败 ${response.status}`, 'xiaod_transcript_revision_failed');
        if (String(payload.job.id || '') !== jobId || String(payload.revision.jobId || '') !== jobId) {
            throw new Error('小D返回了不属于当前任务的字幕版本。');
        }
        return {
            job: payload.job,
            revision: payload.revision,
            duplicate: payload.duplicate === true,
        };
    }
    async collectMetrics({ url, connectionId = null, historyLimit = 20 }: any): Promise<any> {
        const response: any = await this.fetch(`${this.baseUrl}/api/metrics/collect`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                url,
                ...(connectionId ? { connectionId } : {}),
                historyLimit: Math.max(5, Math.min(Number(historyLimit) || 20, 20))
            }),
            signal: AbortSignal.timeout(60000)
        });
        const payload: any = await response.json().catch((): any => ({}));
        if (!response.ok || !payload.metrics?.schemaVersion) {
            const error: any = new Error(payload.error || `小D指标读取失败 ${response.status}`);
            error.code = payload.code || 'metrics_unavailable';
            error.status = response.status;
            error.recommendedAction = payload.recommendedAction || 'retry';
            throw error;
        }
        return payload.metrics;
    }
    async pause(task: any): Promise<any> { return this.control(task, 'pause'); }
    async resume(task: any): Promise<any> { return this.control(task, 'resume'); }
    async confirmTranscript(task: any, { reviewerRef = 'local-owner' }: any = {}): Promise<any> {
        const jobId: any = String(task.execution?.xiaodJobId || '').trim();
        if (!jobId)
            throw new Error('这条任务没有可确认的小D工作。');
        const response: any = await this.fetch(`${this.baseUrl}/api/jobs/${encodeURIComponent(jobId)}/transcript-review`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ decision: 'confirm', completeListen: true, reviewerRef }),
            signal: AbortSignal.timeout(90000)
        });
        const payload: any = await response.json().catch((): any => ({}));
        if (!response.ok || !payload.job)
            throw new Error(payload.error || `小D确认稿生成失败 ${response.status}`);
        return payload.job;
    }
    async redeliver(task: any): Promise<any> {
        const jobId: any = String(task.execution?.xiaodJobId || '').trim();
        if (!jobId)
            throw new Error('这条任务没有可继续交付的小D工作。');
        const response: any = await this.fetch(`${this.baseUrl}/api/jobs/${encodeURIComponent(jobId)}/redeliver`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
            signal: AbortSignal.timeout(90000)
        });
        const payload: any = await response.json().catch((): any => ({}));
        if (!response.ok || !payload.job) {
            const error: any = new Error(payload.error || `小D飞书交付失败 ${response.status}`);
            error.code = payload.code || 'xiaod_delivery_retry_failed';
            error.status = response.status;
            throw error;
        }
        return payload.job;
    }
    async rejectTranscript(task: any, { reviewerRef = 'local-owner' }: any = {}): Promise<any> {
        const jobId: any = String(task.execution?.xiaodJobId || '').trim();
        if (!jobId)
            throw new Error('这条任务没有可拒绝的小D工作。');
        const response: any = await this.fetch(`${this.baseUrl}/api/jobs/${encodeURIComponent(jobId)}/transcript-review`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ decision: 'reject', completeListen: true, reviewerRef }),
            signal: AbortSignal.timeout(5000)
        });
        const payload: any = await response.json().catch((): any => ({}));
        if (!response.ok || !payload.job)
            throw new Error(payload.error || `小D听审拒绝失败 ${response.status}`);
        return payload.job;
    }
    async control(task: any, action: any): Promise<any> {
        const jobId: any = String(task.execution?.xiaodJobId || '').trim();
        if (!jobId)
            throw new Error('这条任务没有可控制的小D工作。');
        const response: any = await this.fetch(`${this.baseUrl}/api/jobs/${encodeURIComponent(jobId)}/${action}`, { method: 'POST', signal: AbortSignal.timeout(5000) });
        const payload: any = await response.json().catch((): any => ({}));
        if (!response.ok || !payload.job)
            throw new Error(payload.error || `小D${action === 'pause' ? '暂停' : '继续'}请求失败 ${response.status}`);
        return payload.job;
    }
}
function shouldDeliverToFeishu(task: any): any {
    const channel: any = String(task?.source?.originChannel || task?.source?.channel || '').trim();
    return channel === 'feishu' || Boolean(String(task?.source?.chatRef || '').trim());
}
function xiaodJobIdFor(task: any, action: any): any {
    const jobId: any = String(task?.execution?.xiaodJobId || '').trim();
    if (!jobId)
        throw new Error(`这条任务没有可${action}的小D工作。`);
    return jobId;
}
function downstreamError(payload: any, response: any, fallback: any, fallbackCode: any): any {
    const error: any = new Error(payload.error || fallback);
    error.code = payload.code || fallbackCode;
    error.httpStatus = Number(response.status) || 502;
    return error;
}
function loopbackUrl(value: any): any {
    const parsed: any = new URL(value);
    if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname))
        throw new Error('小D运行时只允许本机回环地址。');
    return parsed.toString().replace(/\/$/, '');
}

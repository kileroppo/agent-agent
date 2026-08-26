import { WorkerHttpError } from './agent-army-client.ts';
export class MacWorker {
    readonly cloud: Record<string, any>;
    readonly xiaod: Record<string, any>;
    readonly stateStore: Record<string, any>;
    readonly workerId: string;
    readonly now: () => number;

    constructor({ cloud, xiaod, stateStore, workerId, now = () => Date.now() }: any = {}) {
        this.cloud = cloud;
        this.xiaod = xiaod;
        this.stateStore = stateStore;
        this.workerId = workerId;
        this.now = now;
    }
    async runOnce() {
        let state = await this.stateStore.read();
        if (!state.activeLease) {
            const leased = await this.cloud.lease(this.workerId);
            if (!leased.job)
                return { status: 'idle', nextPollAfterMs: leased.nextPollAfterMs || 5000 };
            state.activeLease = leased.job;
            await this.stateStore.save(state);
        }
        try {
            return await this.processActive(state);
        }
        catch (error) {
            if (error instanceof WorkerHttpError && error.status === 422) {
                state.activeLease = null;
                await this.stateStore.save(state);
                return { status: 'lease_lost', nextPollAfterMs: 5000 };
            }
            throw error;
        }
    }
    async processActive(state: any) {
        const job = state.activeLease;
        let mapping = state.jobs[job.taskId];
        if (!mapping) {
            const local = await this.xiaod.create({
                sourceUrl: job.input.sourceUrl,
                idempotencyKey: job.idempotencyKey
            });
            mapping = {
                xiaodJobId: local.id,
                createdAt: new Date(this.now()).toISOString(),
                updatedAt: new Date(this.now()).toISOString()
            };
            state.jobs[job.taskId] = mapping;
            await this.stateStore.save(state);
        }
        let local;
        try {
            local = await this.xiaod.get(mapping.xiaodJobId);
        }
        catch (error) {
            if ((error as any)?.status !== 404)
                throw error;
            delete state.jobs[job.taskId];
            await this.stateStore.save(state);
            return { status: 'local_job_missing', nextPollAfterMs: 1000 };
        }
        if (local.status === 'completed') {
            await this.cloud.complete(job.taskId, {
                workerId: this.workerId,
                leaseId: job.leaseId,
                result: {
                    status: 'succeeded',
                    xiaodJobId: local.id,
                    title: local.title,
                    larkUrl: local.output?.larkUrl || null,
                    larkPermissionGranted: local.output?.larkPermissionGranted === true,
                    validation: {
                        exists: true,
                        readable: Boolean(local.output?.markdownPath),
                        nonEmpty: Boolean(local.output?.markdownPath),
                        qualityPassed: local.quality?.passed === true
                    }
                }
            });
            state.activeLease = null;
            state.jobs[job.taskId] = { ...mapping, status: 'completed', updatedAt: new Date(this.now()).toISOString() };
            await this.stateStore.save(state);
            return { status: 'completed', taskId: job.taskId };
        }
        if (local.status === 'failed') {
            await this.cloud.complete(job.taskId, {
                workerId: this.workerId,
                leaseId: job.leaseId,
                result: {
                    status: 'failed',
                    xiaodJobId: local.id,
                    error: {
                        code: 'xiaod_job_failed',
                        message: String(local.error || '小D任务失败。').slice(0, 500),
                        userMessage: String(local.failure?.recovery || '小D未能完成素材处理。').slice(0, 500),
                        retryable: local.failure?.retryable === true
                    }
                }
            });
            state.activeLease = null;
            state.jobs[job.taskId] = { ...mapping, status: 'failed', updatedAt: new Date(this.now()).toISOString() };
            await this.stateStore.save(state);
            return { status: 'failed', taskId: job.taskId };
        }
        try {
            await this.cloud.heartbeat(job.taskId, {
                workerId: this.workerId,
                leaseId: job.leaseId,
                stage: String(local.status || 'working').slice(0, 120),
                progress: Number(local.progress || 0)
            });
        } catch (error) {
            if (error instanceof WorkerHttpError && error.status === 422) {
                state.activeLease = null;
                await this.stateStore.save(state);
                return { status: 'lease_lost', nextPollAfterMs: 5000 };
            }
            // 瞬时网络错误容忍并继续追踪本地任务
        }
        state.jobs[job.taskId] = { ...mapping, status: 'working', updatedAt: new Date(this.now()).toISOString() };
        await this.stateStore.save(state);
        return { status: 'working', taskId: job.taskId };
    }
}

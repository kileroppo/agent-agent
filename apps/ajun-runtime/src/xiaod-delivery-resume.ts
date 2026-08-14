import { ValidationError } from './task-validation-error.ts';
export class XiaodDeliveryResume {
    service: any;
    constructor(service: any) {
        this.service = service;
    }
    request(taskId: any, options: any = {}): any {
        const key: any = String(taskId || '').trim();
        const running: any = this.service.xiaodDeliveryRequestRuns.get(key);
        if (running)
            return running;
        const request: any = Promise.resolve().then((): any => this.#requestOnce(taskId, options)).finally((): any => {
            if (this.service.xiaodDeliveryRequestRuns.get(key) === request)
                this.service.xiaodDeliveryRequestRuns.delete(key);
        });
        this.service.xiaodDeliveryRequestRuns.set(key, request);
        return request;
    }
    async #requestOnce(taskId: any, { chatRef = '' }: any = {}): Promise<any> {
        const task: any = (await this.service.store.list()).find((item: any): any => item.taskId === taskId);
        if (!task)
            throw new ValidationError('找不到要继续交付的任务。');
        validateApprovalChat(task, chatRef);
        if (task.execution?.executor !== 'xiaod' || !task.execution?.xiaodJobId)
            throw new ValidationError('这条任务没有可继续交付的小D工作。');
        if (this.service.xiaodDeliveryRuns.has(task.taskId))
            return task;
        if (task.currentStage !== 'xiaod_awaiting_delivery' || task.status !== 'needs_input')
            throw new ValidationError('这条任务当前不在等待飞书交付阶段。');
        if (task.error?.code === 'xiaod_delivery_uncertain')
            throw new ValidationError(task.error.userMessage || '飞书交付结果不确定，必须先人工核对。');
        const executor: any = this.service.executors.xiaod;
        if (typeof executor?.redeliver !== 'function')
            throw new ValidationError('小D飞书交付能力当前不可用。');
        const requested: any = await this.service.store.updateTask(task.taskId, {
            // needs_input cannot jump directly to running. Re-enter through the queued
            // state so both JSON and SQLite stores enforce the same lifecycle contract.
            status: 'queued', currentStage: 'xiaod_delivery_retry_requested', error: undefined,
            execution: { ...(task.execution || {}), polling: { state: 'pending', consecutiveFailures: 0, nextPollAt: new Date().toISOString() } },
        });
        const run: any = Promise.resolve().then((): any => executor.redeliver(requested)).then(async (job: any): Promise<any> => {
            const pending: any = job.status === 'awaiting_delivery';
            const updated: any = await this.service.store.updateTask(task.taskId, {
                status: pending ? 'needs_input' : 'running', currentStage: `xiaod_${job.status || 'delivery_retrying'}`,
                error: pending ? deliveryError(job) : undefined,
                execution: { ...(requested.execution || {}), xiaodStatus: job.status, xiaodProgress: job.progress, updatedAt: new Date().toISOString(), polling: { state: pending ? 'settled' : 'pending', consecutiveFailures: 0, nextPollAt: pending ? null : new Date().toISOString() } },
            });
            if (!pending && typeof executor.observe === 'function')
                executor.observe(updated);
            return updated;
        }).catch(async (error: any): Promise<any> => this.service.store.updateTask(task.taskId, {
            status: 'needs_input', currentStage: 'xiaod_awaiting_delivery',
            error: { code: error?.code === 'lark_delivery_uncertain' ? 'xiaod_delivery_uncertain' : 'xiaod_delivery_retry_failed', userMessage: error?.code === 'lark_delivery_uncertain' ? '飞书交付结果不确定，请先在本机运行台核对并仲裁；确认前不要重试。' : '飞书交付仍未完成；本地确认稿已保留。请修复飞书配置或连接后再次回复“继续飞书交付”。' },
        })).finally((): any => this.service.xiaodDeliveryRuns.get(task.taskId) === run && this.service.xiaodDeliveryRuns.delete(task.taskId));
        this.service.xiaodDeliveryRuns.set(task.taskId, run);
        void run.catch((): any => undefined);
        return requested;
    }
}
function validateApprovalChat(task: any, chatRef: any): any {
    const expected: any = String(task.source?.chatRef || '').trim();
    const actual: any = String(chatRef || '').trim();
    if (actual && expected && actual !== expected)
        throw new ValidationError('审批卡会话与原任务不一致，未执行任务。');
}
function deliveryError(job: any): any {
    return { code: 'xiaod_delivery_pending', userMessage: job?.output?.larkDelivery?.state === 'uncertain' ? '飞书交付结果不确定，请先在本机运行台核对并仲裁；确认前不要重试。' : '本地确认稿已保留，但飞书交付尚未完成。' };
}

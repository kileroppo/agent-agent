import { taskById } from './task-recovery-policy.ts';
import { WECHAT_CHAT_TASK_TYPE } from './wechat-chat-defaults.ts';
export class TaskFailureRecoveryCoordinator {
    clock: any;
    recover: any;
    store: any;
    constructor({ store, recover = null, clock = (): any => new Date() }: any = {}) {
        this.store = store;
        this.recover = recover;
        this.clock = clock;
    }
    async markPending(task: any): Promise<any> {
        if (!this.#supports(task))
            return task;
        return this.store.updateTask(task.taskId, {
            recovery: {
                ...(task.recovery || {}),
                coordination: { status: 'pending', requestedAt: this.clock().toISOString(), reason: '任务执行出错，正在交给运维官判断安全恢复办法。' },
            },
        });
    }
    start(task: any): any {
        if (!this.#supports(task))
            return;
        // 原任务已经如实失败；恢复协调在后台有界重试，不能阻塞其他工作返回。
        void this.#run(task);
    }
    #supports(task: any): any {
        return typeof this.recover === 'function'
            && task?.status === 'failed'
            && !['operations.failure-recovery', 'operations.technical-repair', WECHAT_CHAT_TASK_TYPE].includes(task.taskType);
    }
    async #run(task: any): Promise<any> {
        let lastError: any = null;
        for (let attempt: any = 1; attempt <= 2; attempt += 1) {
            try {
                await this.recover(task);
                return;
            }
            catch (error: any) {
                lastError = error;
            }
        }
        await this.#recordStartFailure(task, lastError).catch((): any => undefined);
    }
    async #recordStartFailure(task: any, error: any): Promise<any> {
        const current: any = await taskById(this.store, task.taskId);
        const coordination: any = current?.recovery?.coordination || task.recovery?.coordination || {};
        return this.store.updateTask(task.taskId, {
            recovery: {
                ...(current?.recovery || task.recovery || {}),
                coordination: {
                    ...coordination,
                    status: 'start_failed',
                    attempts: 2,
                    failedAt: this.clock().toISOString(),
                    reason: '自动诊断连续两次未能启动，故障已经落账；不会继续显示为诊断中。',
                    errorCode: String(error?.code || 'failure_recovery_start_failed').slice(0, 120),
                },
            },
        });
    }
}

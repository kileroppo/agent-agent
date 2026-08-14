import { ValidationError } from './task-validation-error.ts';
import { isTaskExecutionClosedStatus } from './task-status-policy.ts';
export class TaskFeedback {
    store: any;
    constructor({ store }: any = {}) {
        this.store = store;
    }
    async record(taskId: any, { sentiment, note = '' }: any = {}): Promise<any> {
        const task: any = (await this.store.list()).find((item: any): any => item.taskId === taskId);
        if (!task)
            throw new ValidationError('找不到要评价的工作。');
        if (!isTaskExecutionClosedStatus(task.status)) {
            throw new ValidationError('这件工作还没有结束，暂时不能作为结果评价记录。');
        }
        const normalizedSentiment: any = ['useful', 'needs_improvement'].includes(sentiment) ? sentiment : null;
        if (!normalizedSentiment)
            throw new ValidationError('评价类型无效。');
        const receivedAt: any = new Date().toISOString();
        const normalizedNote: any = String(note || '').replace(/\s+/g, ' ').trim().slice(0, 300);
        return this.store.updateTask(task.taskId, {
            feedback: { sentiment: normalizedSentiment, note: normalizedNote, receivedAt },
            evaluation: {
                ...(task.evaluation || {}),
                humanAcceptance: {
                    status: normalizedSentiment === 'useful' ? 'accepted' : 'revision_required',
                    note: normalizedNote,
                    source: 'feishu_feedback',
                    decidedAt: receivedAt,
                },
            },
        });
    }
}

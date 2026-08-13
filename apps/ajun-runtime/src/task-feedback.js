import { ValidationError } from './task-validation-error.js';

import { isTaskExecutionClosedStatus } from './task-status-policy.js';

export class TaskFeedback {
  constructor({ store } = {}) {
    this.store = store;
  }

  async record(taskId, { sentiment, note = '' } = {}) {
    const task = (await this.store.list()).find((item) => item.taskId === taskId);
    if (!task) throw new ValidationError('找不到要评价的工作。');
    if (!isTaskExecutionClosedStatus(task.status)) {
      throw new ValidationError('这件工作还没有结束，暂时不能作为结果评价记录。');
    }
    const normalizedSentiment = ['useful', 'needs_improvement'].includes(sentiment) ? sentiment : null;
    if (!normalizedSentiment) throw new ValidationError('评价类型无效。');
    const receivedAt = new Date().toISOString();
    const normalizedNote = String(note || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    return this.store.updateTask(task.taskId, {
      feedback:{ sentiment:normalizedSentiment, note:normalizedNote, receivedAt },
      evaluation:{
        ...(task.evaluation || {}),
        humanAcceptance:{
          status:normalizedSentiment === 'useful' ? 'accepted' : 'revision_required',
          note:normalizedNote,
          source:'feishu_feedback',
          decidedAt:receivedAt,
        },
      },
    });
  }
}

import { ValidationError } from './task-validation-error.js';

export class TaskIntakeContinuation {
  constructor({ store, createTask } = {}) {
    this.store = store;
    this.createTask = createTask;
  }

  async continue(taskId) {
    const parent = (await this.store.list()).find((task) => task.taskId === taskId);
    if (!parent) throw new ValidationError('找不到这条原始任务。');
    const intake = parent.artifactRefs?.find((item) => item.type === 'task_intake_record')?.data;
    if (parent.status !== 'succeeded' || !intake?.recommendedTaskType || !intake?.recommendedAgentId) {
      throw new ValidationError('这条任务当前没有可继续执行的建议。');
    }
    const existing = (await this.store.list()).find((task) =>
      task.parentTaskId === parent.taskId
      && task.taskType === intake.recommendedTaskType
      && task.assigneeAgentId === intake.recommendedAgentId
    );
    if (existing) return existing;
    if (intake.recommendedTaskType === 'media.transcribe-and-refine' && !parent.input?.sourceUrl) {
      throw new ValidationError('小D需要公开素材链接。请在“指定岗位或任务类型”中选择小D并补上链接后提交。');
    }
    return this.createTask({
      title:parent.input.title,
      description:parent.input.description,
      sourceUrl:parent.input.sourceUrl,
      sourceUrls:parent.input.sourceUrls,
      requesterName:parent.requester?.ref,
      taskType:intake.recommendedTaskType,
      agentId:intake.recommendedAgentId,
      parentTaskId:parent.taskId,
      workflowId:parent.workflow?.workflowId,
      workflowType:parent.workflow?.workflowType,
      context:{
        ...(parent.input?.context || {}),
        ...(intake.advisor ? { intakeAdvisor:intake.advisor } : {}),
        ...(intake.autoContinue === true ? { autoCapabilityAssessment:true } : {}),
      },
      idempotencyKey:`intake-continuation:${parent.taskId}:${intake.recommendedTaskType}:${intake.recommendedAgentId}`,
    });
  }
}

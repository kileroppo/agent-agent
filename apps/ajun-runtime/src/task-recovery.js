import {
  confirmedTranscriptFor,
  confirmedTranscriptOnlyEligible,
  duplicateRecovery,
  existingResult,
  ineligibleResult,
  recoveryEvents,
  recoveryRelatedTasks,
  requestAttempt,
  safeText,
  taskById,
  uniqueStrings,
  view,
} from './task-recovery-policy.js';
import { retryVisualAnalysis, visionCapabilityReadiness } from './task-visual-recovery.js';
import { cleanActionKey, cleanActor, cleanRequestId, recoveryError } from './task-recovery-input.js';
export { TaskRecoveryError } from './task-recovery-input.js';
export { failureClassification, view } from './task-recovery-policy.js';

export class TaskRecovery {
  constructor({ store, recover = null, createTask = null, capabilityStatus = null, clock = () => new Date() } = {}) {
    this.store = store;
    this.recover = recover;
    this.createTask = createTask;
    this.capabilityStatus = capabilityStatus;
    this.clock = clock;
    this.requests = new Map();
  }

  async view(taskOrId, options = {}) {
    const task = typeof taskOrId === 'string'
      ? await taskById(this.store, taskOrId)
      : taskOrId;
    if (!task) throw recoveryError('找不到要处理的任务。', 'task_recovery_not_found', 404);
    const relatedTasks = options.relatedTasks || await recoveryRelatedTasks(this.store, task);
    return view(task, { ...options, relatedTasks });
  }

  request(taskId, input = {}, actor = {}) {
    const actionKey = cleanActionKey(input.actionKey);
    const requestId = cleanRequestId(input.requestId || input.idempotencyKey);
    const key = actionKey === 'retry_visual_analysis_after_recovery'
      ? `${String(taskId || '').trim()}:${actionKey}`
      : `${String(taskId || '').trim()}:${actionKey}:${requestId}`;
    const running = this.requests.get(key);
    if (running) return running;
    const execution = this.#requestOnce(taskId, { ...input, actionKey, requestId }, actor)
      .finally(() => this.requests.get(key) === execution && this.requests.delete(key));
    this.requests.set(key, execution);
    return execution;
  }

  async #requestOnce(taskId, input, actor) {
    let task = await taskById(this.store, taskId);
    if (!task) throw recoveryError('找不到要处理的任务。', 'task_recovery_not_found', 404);
    const attempt = requestAttempt(task);
    const duplicate = duplicateRecovery(task, input, attempt);
    if (duplicate) return existingResult(task, duplicate);
    const expectedUpdatedAt = String(input.expectedUpdatedAt || '').trim();
    if (!expectedUpdatedAt || expectedUpdatedAt !== String(task.updatedAt || '')) {
      throw recoveryError('任务状态已经变化，请刷新详情后再决定。', 'task_recovery_stale', 409);
    }
    const relatedTasks = await recoveryRelatedTasks(this.store, task);
    const recoveryView = view(task, { audience:'local-owner', relatedTasks });
    if (!recoveryView.actions.some((item) => item.actionKey === input.actionKey)) {
      return ineligibleResult(task, input.actionKey, recoveryView);
    }
    if (input.actionKey === 'retry_visual_analysis_after_recovery') {
      if (actor?.kind !== 'local-owner') {
        throw recoveryError('只有本机主人可以显式触发视觉恢复后重跑。', 'task_recovery_local_owner_required', 403);
      }
      const capability = await visionCapabilityReadiness(this.capabilityStatus, {
        failureCode:task.error?.code,
        failureAt:task.error?.occurredAt,
      });
      if (!capability.ready) {
        return {
          status:'waiting_capability',
          taskId:task.taskId,
          actionKey:input.actionKey,
          capability,
          message:capability.requiresBillingRecovery
            ? '识图余额或额度尚未出现晚于本次失败的新端到端验证；未创建重跑任务，也未消耗重跑次数。'
            : 'vision.analyze 尚未同时达到已配置、健康和端到端验证；未创建重跑任务，也未消耗重跑次数。',
          recovery:recoveryView,
        };
      }
    }
    const requestedAt = this.clock().toISOString();
    const requestedBy = cleanActor(actor);
    task = await this.#record(task.taskId, {
      status:'pending',
      actionKey:input.actionKey,
      requestId:input.requestId,
      attempt,
      requestedAt,
      requestedBy,
      reason:'本机主人从任务详情请求受控处理。',
    }, {
      event:'requested',
      actionKey:input.actionKey,
      requestId:input.requestId,
      attempt,
      actor:requestedBy,
      occurredAt:requestedAt,
    });

    try {
      const outcome = input.actionKey === 'use_confirmed_transcript_only'
        ? await this.#useConfirmedTranscriptOnly(task, relatedTasks, { requestId:input.requestId, requestedBy })
        : input.actionKey === 'request_read_only_diagnosis'
          ? await this.#requestReadOnlyDiagnosis(task, { requestId:input.requestId, requestedBy })
          : input.actionKey === 'retry_visual_analysis_after_recovery'
            ? await retryVisualAnalysis({
              task,
              requestId:input.requestId,
              requestedBy,
              createTask:this.createTask,
              record:(...args) => this.#record(...args),
              clock:this.clock,
              errorFactory:recoveryError,
            })
          : await this.#runCoordinator(task, { actionKey:input.actionKey, requestId:input.requestId, requestedBy });
      const current = await taskById(this.store, task.taskId);
      return {
        status:'accepted',
        taskId:task.taskId,
        actionKey:input.actionKey,
        operatorTaskId:outcome?.operatorTask?.taskId || outcome?.operatorTaskId || null,
        retryTaskId:outcome?.retryTask?.taskId || outcome?.retryTaskId || null,
        technicalTaskId:outcome?.technicalTask?.taskId || outcome?.technicalTaskId || null,
        recovery:view(current || task, { audience:'local-owner', relatedTasks:await recoveryRelatedTasks(this.store, current || task) }),
      };
    } catch (error) {
      const failedAt = this.clock().toISOString();
      await this.#record(task.taskId, {
        status:'failed',
        actionKey:input.actionKey,
        requestId:input.requestId,
        attempt,
        requestedAt,
        requestedBy,
        reason:safeText(error?.message || '恢复请求未能完成。', 300),
      }, {
        event:'failed',
        actionKey:input.actionKey,
        requestId:input.requestId,
        attempt,
        actor:requestedBy,
        occurredAt:failedAt,
        reason:safeText(error?.message || '恢复请求未能完成。', 300),
      });
      throw error;
    }
  }

  async #runCoordinator(task, input) {
    if (typeof this.recover !== 'function') {
      throw recoveryError('受控恢复暂不可用，未改变任务。', 'task_recovery_unavailable', 503);
    }
    return this.recover(task, input);
  }

  async #useConfirmedTranscriptOnly(task, tasks, { requestId, requestedBy }) {
    if (typeof this.createTask !== 'function') {
      throw recoveryError('确认稿恢复入口暂不可用，未创建子任务。', 'task_recovery_unavailable', 503);
    }
    const transcript = confirmedTranscriptFor(task, tasks);
    if (!transcript || !confirmedTranscriptOnlyEligible(task, tasks)) {
      throw recoveryError('没有找到可核验确认稿，或当前任务不允许关闭视觉后重试。', 'confirmed_transcript_recovery_not_allowed', 422);
    }
    const paperclipIssueId = String(task.governance?.paperclipIssueId || '').trim();
    if (!paperclipIssueId) {
      throw recoveryError('原 Paperclip 任务关联不存在，未创建无审计关联的重试。', 'paperclip_parent_issue_required', 503);
    }
    const sourceTaskIds = uniqueStrings([
      ...(task.input?.context?.sourceTaskIds || []),
      transcript.taskId,
    ]);
    const rootTaskId = task.recovery?.rootTaskId || task.taskId;
    const retryTask = await this.createTask({
      title:`${task.input?.title || '视频内容拆解'}（仅使用确认稿）`,
      description:'按本机主人明确选择，仅使用已核验确认稿完成文本拆解；关闭视觉分析，不读取图片、不调用视觉 Provider。',
      taskType:'content.video-benchmark-analysis',
      agentId:task.assigneeAgentId,
      requester:{ kind:'local-owner', ref:requestedBy.ref },
      source:{ channel:'internal-recovery', parentChannel:task.source?.channel || null, chatRef:task.source?.chatRef || null },
      parentTaskId:task.taskId,
      sourceUrl:task.input?.sourceUrl,
      sourceUrls:task.input?.sourceUrls,
      evidenceMode:'formal',
      analysisIntent:task.input?.analysisIntent,
      depth:task.input?.depth,
      focus:task.input?.focus,
      visualMode:'off',
      context:{
        ...(task.input?.context || {}),
        sourceTaskIds,
        parentPaperclipIssueId:paperclipIssueId,
        recoveryFromTaskId:task.taskId,
        confirmedTranscriptTaskId:transcript.taskId,
        confirmedTranscriptArtifactId:transcript.artifact.artifactId || null,
      },
      idempotencyKey:`recovery-confirmed-transcript:${task.taskId}`,
      recovery:{
        rootTaskId,
        attempt:Number(task.recovery?.attempt || 0) + 1,
        triggeredByTaskId:task.taskId,
        mode:'confirmed_transcript_only',
        requestId,
      },
    });
    await this.#record(task.taskId, {
      status:'retrying',
      actionKey:'use_confirmed_transcript_only',
      requestId,
      requestedBy,
      retryTaskId:retryTask.taskId,
      attempt:Number(task.recovery?.attempt || 0) + 1,
      reason:'已创建仅使用确认稿且 visualMode=off 的 Paperclip 子任务。',
    }, {
      event:'child_created',
      actionKey:'use_confirmed_transcript_only',
      requestId,
      attempt:Number(task.recovery?.attempt || 0) + 1,
      actor:requestedBy,
      taskId:retryTask.taskId,
      occurredAt:this.clock().toISOString(),
    });
    return { retryTask };
  }

  async #requestReadOnlyDiagnosis(task, { requestId, requestedBy }) {
    if (typeof this.createTask !== 'function') {
      throw recoveryError('只读诊断入口暂不可用，未创建子任务。', 'task_recovery_unavailable', 503);
    }
    const paperclipIssueId = String(task.governance?.paperclipIssueId || '').trim();
    if (task.execution?.owner !== 'paperclip-hermes' || !paperclipIssueId) {
      throw recoveryError('原 Paperclip 任务关联不完整，未创建无审计关联的诊断。', 'paperclip_parent_issue_required', 503);
    }
    const diagnosisTask = await this.createTask({
      title:`只读诊断：${task.input?.title || '未命名任务'}`,
      description:'只读分类原任务失败和缺失证据，输出恢复建议。禁止重跑原任务、修改代码、扩大权限或调用外部发布动作。',
      taskType:'operations.failure-recovery',
      agentId:'operator',
      requester:{ kind:'local-owner', ref:requestedBy.ref },
      source:{ channel:'internal-recovery', parentChannel:task.source?.channel || null, chatRef:task.source?.chatRef || null },
      parentTaskId:task.taskId,
      idempotencyKey:`recovery-read-only-diagnosis:${task.taskId}`,
      context:{
        parentPaperclipIssueId:paperclipIssueId,
        failedTaskId:task.taskId,
        diagnosisOnly:true,
        prohibitedActions:['retry', 'code_write', 'permission_expansion', 'external_publish'],
      },
      recovery:{
        rootTaskId:task.recovery?.rootTaskId || task.taskId,
        attempt:Number(task.recovery?.attempt || 0),
        triggeredByTaskId:task.taskId,
        mode:'read_only_diagnosis',
        requestId,
      },
    });
    await this.#record(task.taskId, {
      status:'diagnosed',
      actionKey:'request_read_only_diagnosis',
      requestId,
      requestedBy,
      operatorTaskId:diagnosisTask.taskId,
      attempt:Number(task.recovery?.attempt || 0) + 1,
      reason:'已创建原 Paperclip Issue 的只读诊断子任务。',
    }, {
      event:'diagnosed',
      actionKey:'request_read_only_diagnosis',
      requestId,
      attempt:Number(task.recovery?.attempt || 0) + 1,
      actor:requestedBy,
      taskId:diagnosisTask.taskId,
      occurredAt:this.clock().toISOString(),
    });
    return { operatorTask:diagnosisTask };
  }

  async #record(taskId, coordination, event) {
    const current = await taskById(this.store, taskId);
    if (!current) throw recoveryError('找不到要更新的恢复任务。', 'task_recovery_not_found', 404);
    const events = recoveryEvents(current);
    if (!events.some((item) => item.requestId === event.requestId && item.event === event.event)) events.push(event);
    return this.store.updateTask(taskId, {
      recovery:{ ...(current.recovery || {}), coordination, events:events.slice(-50) },
    });
  }
}

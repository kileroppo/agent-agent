import crypto from 'node:crypto';
import { TaskLifecycleEventRecorder } from '../task-lifecycle-event-recorder.ts';
import { taskOutcomePolicy } from '../task-status-policy.ts';
import { orchestrateDeliveryQuality } from './delivery-quality-orchestrator.ts';
import { verifiableQualityEvidenceRefs } from './quality-review.ts';
import {
  hasReadOnlyDiagnosisArtifact,
  isTrustedReadOnlyDiagnosisTask,
} from '../read-only-diagnosis-contract.ts';

type RuntimeTask = Record<string, any>;
type RuntimeStore = {
  updateTask(taskId: string, patch: RuntimeTask): Promise<RuntimeTask>;
  getTask?(taskId: string): Promise<RuntimeTask | null>;
  list(): Promise<RuntimeTask[]>;
};
type RuntimeEventStore = { appendTaskRunEvent(event: RuntimeTask): unknown };
type QualityOutcome = ReturnType<typeof orchestrateDeliveryQuality>;

export function prepareDeliveryQualityResult(task: RuntimeTask, result: RuntimeTask = {}) {
  if (result?.status !== 'succeeded' || task?.taskType === 'governance.assurance-review') return result;
  if (isTrustedReadOnlyDiagnosisTask(task)) return result;
  const completedTask = {
    ...task,
    ...result,
    artifactRefs:Array.isArray(result.artifactRefs) ? result.artifactRefs : task.artifactRefs || [],
  };
  const quality = orchestrateDeliveryQuality({ completedTask });
  if (quality.action !== 'request_review') {
    return { ...result, deliveryQuality:quality };
  }
  const outcome = taskOutcomePolicy('delivery_quality_review_pending');
  return {
    ...result,
    status:outcome.taskStatus,
    currentStage:'delivery_quality_review_pending',
    deliveryQuality:quality,
    execution:{
      ...(result.execution || task.execution || {}),
      outcome:outcome.executionOutcome,
      deliveryCompletedAt:result.execution?.finishedAt || new Date().toISOString(),
      finishedAt:undefined,
    },
  };
}

export class DeliveryQualityRuntime {
  store: RuntimeStore;
  createTask: (input: RuntimeTask) => Promise<RuntimeTask>;
  taskRunEvents: RuntimeEventStore | null;
  lifecycleEvents: {
    recordPersisted(task: RuntimeTask, input?: { previousTask?: RuntimeTask | null }): void;
  };
  syncTask: ((task: RuntimeTask) => Promise<RuntimeTask>) | null;

  constructor({ store, createTask, taskRunEvents = null, syncTask = null }: {
    store: RuntimeStore;
    createTask: (input: RuntimeTask) => Promise<RuntimeTask>;
    taskRunEvents?: RuntimeEventStore | null;
    syncTask?: ((task: RuntimeTask) => Promise<RuntimeTask>) | null;
  }) {
    this.store = store;
    this.createTask = createTask;
    this.taskRunEvents = taskRunEvents;
    this.lifecycleEvents = new TaskLifecycleEventRecorder({ eventStore:taskRunEvents });
    this.syncTask = syncTask;
  }

  async continue(task: RuntimeTask) {
    if (isHeldReadOnlyDiagnosis(task)) return this.completeHeldReadOnlyDiagnosis(task);
    const request = task?.deliveryQuality?.reviewTaskRequest;
    if (task?.status !== 'running' || task?.currentStage !== 'delivery_quality_review_pending' || !request) return task;
    const existingId = task.deliveryQualityRuntime?.reviewTaskId;
    if (existingId) return task;
    let reviewTask;
    try {
      reviewTask = await this.createTask(request);
    } catch (error: unknown) {
      const now = new Date().toISOString();
      const outcome = taskOutcomePolicy('delivery_quality_review_start_failed');
      const stopped = await this.store.updateTask(task.taskId, {
        status:outcome.taskStatus,
        currentStage:'delivery_quality_review_start_failed',
        deliveryQualityRuntime:{
          schemaVersion:'agent.army/delivery-quality-runtime/v1',
          status:'stopped', rootTaskId:qualityRootTaskId(task), updatedAt:now,
        },
        execution:{ ...(task.execution || {}), outcome:outcome.executionOutcome, finishedAt:now },
        error:{
          code:'delivery_quality_review_start_failed',
          message:String(error instanceof Error ? error.message : '独立质量复核未能启动。').slice(0, 500),
          userMessage:'产物已保留，但独立质量复核没有成功启动；系统已停止，不会把它冒充为完成。',
          category:'manual', stage:'delivery_quality', retryable:false, occurredAt:now,
        },
      });
      this.lifecycleEvents.recordPersisted(stopped, { previousTask:task });
      this.record(stopped, 'quality_review_start_failed', 'waiting_test', {
        errorCode:'delivery_quality_review_start_failed',
      });
      return stopped;
    }
    const updated = await this.store.updateTask(task.taskId, {
      deliveryQualityRuntime:{
        schemaVersion:'agent.army/delivery-quality-runtime/v1',
        status:'review_pending',
        reviewTaskId:reviewTask.taskId,
        rootTaskId:qualityRootTaskId(task),
        updatedAt:new Date().toISOString(),
      },
    });
    this.lifecycleEvents.recordPersisted(updated, { previousTask:task });
    this.record(updated, 'review_requested', 'waiting', {
      safeSummary:`${updated.qualityProfile?.tier || 'important'} quality review ${reviewTask.taskId}`,
    });
    return updated;
  }

  async completeHeldReadOnlyDiagnosis(task: RuntimeTask) {
    const now = new Date().toISOString();
    const reviewTaskId = String(task?.deliveryQualityRuntime?.reviewTaskId || '').trim();
    const reviewTask = reviewTaskId ? await this.get(reviewTaskId) : null;
    if (reviewTask && !['succeeded', 'failed', 'cancelled', 'rejected'].includes(String(reviewTask.status || ''))) {
      const closedReview = await this.store.updateTask(reviewTask.taskId, {
        status:'cancelled',
        currentStage:'superseded_read_only_diagnosis_review',
        execution:{ ...(reviewTask.execution || {}), outcome:'superseded', finishedAt:now },
        error:{
          code:'superseded_read_only_diagnosis_review',
          message:'确定性只读诊断不需要独立交付复核，旧复核任务已关闭。',
          userMessage:'这条复核由旧规则误建，已自动关闭；只读诊断结果不受影响。',
          category:'manual', stage:'delivery_quality', retryable:false, occurredAt:now,
        },
      });
      await this.sync(closedReview);
    }
    const completed = await this.sync(await this.store.updateTask(task.taskId, {
      status:'succeeded',
      currentStage:'recovery_decision_ready',
      deliveryQualityRuntime:{
        ...(task.deliveryQualityRuntime || {}),
        status:'bypassed_for_trusted_read_only_diagnosis',
        updatedAt:now,
      },
      execution:{ ...(task.execution || {}), outcome:'escalate_technical_expert', finishedAt:now },
      error:undefined,
    }));
    this.lifecycleEvents.recordPersisted(completed, { previousTask:task });
    return completed;
  }

  async resolveReview(reviewTask: RuntimeTask, reviewResult: unknown) {
    if (reviewTask?.taskType !== 'governance.assurance-review') return null;
    const sourceTaskId = String(reviewTask.input?.context?.sourceTaskId || '').trim();
    const source = sourceTaskId ? await this.get(sourceTaskId) : null;
    if (!source) throw new Error('质量复核缺少可追踪的原任务。');
    const evidenceBoundResult = bindReviewEvidence(reviewResult, source.artifactRefs);
    const boundReview = {
      reviewerAgentId:'reviewer',
      sourceTaskId,
      qualityReview:evidenceBoundResult,
    };
    const quality = orchestrateDeliveryQuality({
      completedTask:{ ...source, status:'succeeded' },
      reviewResult:boundReview,
      revisionRound:source.revisionRound,
    });
    if (quality.action === 'accept') return this.accept(source, reviewTask, quality);
    if (quality.action === 'revise') return this.revise(source, reviewTask, quality);
    return this.stop(source, reviewTask, quality);
  }

  async accept(source: RuntimeTask, reviewTask: RuntimeTask, quality: QualityOutcome) {
    const now = new Date().toISOString();
    const outcome = taskOutcomePolicy('delivery_quality_passed');
    const patch = {
      status:outcome.taskStatus,
      currentStage:'delivery_quality_passed',
      deliveryQuality:quality,
      deliveryQualityRuntime:{
        ...(source.deliveryQualityRuntime || {}),
        status:'passed',
        reviewTaskId:reviewTask.taskId,
        updatedAt:now,
      },
      execution:{ ...(source.execution || {}), outcome:outcome.executionOutcome, finishedAt:now },
      error:undefined,
    };
    const updated = await this.sync(await this.store.updateTask(source.taskId, patch));
    this.lifecycleEvents.recordPersisted(updated, { previousTask:source });
    const rootId = qualityRootTaskId(source);
    if (rootId !== source.taskId) await this.promoteRoot(rootId, updated, quality, now);
    this.record(updated, 'review_completed', 'succeeded', {
      safeSummary:`${quality.profile.tier} quality review passed`,
    });
    return updated;
  }

  async revise(source: RuntimeTask, reviewTask: RuntimeTask, quality: QualityOutcome) {
    const rootTaskId = qualityRootTaskId(source);
    const root = rootTaskId === source.taskId ? source : await this.get(rootTaskId);
    const directive = quality.revisionDirective;
    if (!root || !directive) return this.stop(source, reviewTask, quality);
    const revisionTask = await this.createTask(revisionTaskInput({ root, source, directive }));
    const now = new Date().toISOString();
    const updated = await this.sync(await this.store.updateTask(source.taskId, {
      currentStage:'delivery_quality_revision_scheduled',
      deliveryQuality:quality,
      deliveryQualityRuntime:{
        ...(source.deliveryQualityRuntime || {}),
        status:'revision_pending',
        reviewTaskId:reviewTask.taskId,
        revisionTaskId:revisionTask.taskId,
        rootTaskId,
        updatedAt:now,
      },
    }));
    this.lifecycleEvents.recordPersisted(updated, { previousTask:source });
    if (root.taskId !== source.taskId) {
      await this.store.updateTask(root.taskId, {
        currentStage:'delivery_quality_revision_scheduled',
        deliveryQualityRuntime:{
          ...(root.deliveryQualityRuntime || {}),
          status:'revision_pending', revisionTaskId:revisionTask.taskId, rootTaskId, updatedAt:now,
        },
      });
    }
    this.record(updated, 'revision_started', 'waiting', {
      safeSummary:`revision ${directive.revisionRound}; failed criteria: ${(quality.revisionDecision?.failedCriteria || []).join(', ')}`,
    });
    return updated;
  }

  async stop(source: RuntimeTask, reviewTask: RuntimeTask, quality: QualityOutcome) {
    const now = new Date().toISOString();
    const outcome = taskOutcomePolicy('delivery_quality_stopped', {
      hasUsableArtifact:quality?.workflowStatus === 'partial',
    });
    const updated = await this.sync(await this.store.updateTask(source.taskId, {
      status:outcome.taskStatus,
      currentStage:'delivery_quality_stopped',
      deliveryQuality:quality,
      deliveryQualityRuntime:{
        ...(source.deliveryQualityRuntime || {}),
        status:'stopped', reviewTaskId:reviewTask.taskId, updatedAt:now,
      },
      execution:{ ...(source.execution || {}), outcome:outcome.executionOutcome, finishedAt:now },
      error:{
        code:'delivery_quality_stopped',
        message:quality.reason,
        userMessage:'质量复核没有放行，系统已停止自动返工并保留当前最好版本。',
        category:'manual', stage:'delivery_quality', retryable:false, occurredAt:now,
      },
    }));
    this.lifecycleEvents.recordPersisted(updated, { previousTask:source });
    this.record(updated, 'quality_check_completed', 'waiting_test', {
      errorCode:'delivery_quality_stopped',
      safeSummary:quality.reason,
    });
    const rootTaskId = qualityRootTaskId(source);
    if (rootTaskId !== source.taskId) {
      const root = await this.get(rootTaskId);
      if (root && root.status === 'running') {
        const stoppedRoot = await this.sync(await this.store.updateTask(root.taskId, {
          status:outcome.taskStatus,
          currentStage:'delivery_quality_stopped',
          deliveryQuality:quality,
          deliveryQualityRuntime:{
            ...(root.deliveryQualityRuntime || {}),
            status:'stopped', reviewTaskId:reviewTask.taskId, rootTaskId, updatedAt:now,
          },
          execution:{ ...(root.execution || {}), outcome:outcome.executionOutcome, finishedAt:now },
          error:{ ...updated.error },
        }));
        this.lifecycleEvents.recordPersisted(stoppedRoot, { previousTask:root });
        this.record(stoppedRoot, 'quality_check_completed', 'waiting_test', {
          errorCode:'delivery_quality_stopped',
          safeSummary:quality.reason,
        });
      }
    }
    return updated;
  }

  async promoteRoot(rootTaskId: string, acceptedRevision: RuntimeTask, quality: QualityOutcome, now: string) {
    const root = await this.get(rootTaskId);
    if (!root || root.status !== 'running') return root;
    const artifacts = mergeArtifacts(root.artifactRefs, acceptedRevision.artifactRefs);
    const outcome = taskOutcomePolicy('delivery_quality_passed');
    const promoted = await this.sync(await this.store.updateTask(root.taskId, {
      status:outcome.taskStatus, currentStage:'delivery_quality_passed', artifactRefs:artifacts,
      deliveryQuality:quality,
      deliveryQualityRuntime:{ ...(root.deliveryQualityRuntime || {}), status:'passed', acceptedRevisionTaskId:acceptedRevision.taskId, updatedAt:now },
      execution:{ ...(root.execution || {}), outcome:outcome.executionOutcome, finishedAt:now }, error:undefined,
    }));
    this.lifecycleEvents.recordPersisted(promoted, { previousTask:root });
    return promoted;
  }

  async get(taskId: string) {
    if (typeof this.store.getTask === 'function') return this.store.getTask(taskId);
    return (await this.store.list()).find((item) => item.taskId === taskId) || null;
  }

  async sync(task: RuntimeTask) {
    if (!this.syncTask || !task?.governance?.paperclipIssueId) return task;
    try { return await this.syncTask(task); }
    catch { return task; }
  }

  record(task: RuntimeTask, eventType: string, status: string, extra: RuntimeTask) {
    try {
      this.taskRunEvents?.appendTaskRunEvent({
        eventId:deliveryQualityEventId(task, eventType),
        taskId:task.taskId, workflowId:task.workflow?.workflowId || null,
        eventType, status, safeSummary:task.currentStage, ...extra,
      });
    } catch { /* 可观测性失败不能改变业务结果。 */ }
  }
}

export function isHeldReadOnlyDiagnosis(task: RuntimeTask) {
  return task?.status === 'running'
    && task?.currentStage === 'delivery_quality_review_pending'
    && isTrustedReadOnlyDiagnosisTask(task)
    && hasReadOnlyDiagnosisArtifact(task);
}

function deliveryQualityEventId(task: RuntimeTask, eventType: string) {
  const identity = [
    task?.taskId,
    eventType,
    task?.deliveryQualityRuntime?.reviewTaskId,
    task?.deliveryQualityRuntime?.revisionTaskId,
    task?.currentStage,
  ].map((value) => String(value || '')).join('|');
  return `delivery-quality:${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
}

function bindReviewEvidence(reviewResult: unknown, artifactRefs: unknown) {
  const review = reviewResult && typeof reviewResult === 'object' && !Array.isArray(reviewResult)
    ? reviewResult as RuntimeTask
    : {};
  if (review.status !== 'passed') return reviewResult;
  const evidenceRefs = verifiableQualityEvidenceRefs(review.evidenceRefs, artifactRefs);
  if (evidenceRefs.length) return { ...review, evidenceRefs };
  return {
    ...review,
    status:'blocked',
    evidenceRefs:[],
    safeSummary:review.safeSummary || '复核通过结论没有绑定当前产物证据，已阻断放行。',
  };
}

function revisionTaskInput({ root, source, directive }: {
  root: RuntimeTask;
  source: RuntimeTask;
  directive: NonNullable<QualityOutcome['revisionDirective']>;
}) {
  const input = root.input || {};
  return {
    ...input,
    title:`第 ${directive.revisionRound} 轮定向返工：${input.title || root.taskType}`.slice(0, 500),
    description:`${input.description || ''}\n\n${directive.instruction}\n失败项：${directive.failedCriteria.join('；')}`.trim().slice(0, 2000),
    taskType:root.taskType,
    agentId:root.assigneeAgentId,
    parentTaskId:root.taskId,
    workflowId:root.workflow?.workflowId,
    workflowType:root.workflow?.workflowType,
    idempotencyKey:`delivery-revision:${root.taskId}:${directive.revisionRound}:${qualityKey(directive.failedCriteria)}`,
    context:{
      ...(input.context || {}),
      deliveryRevision:directive,
      qualityRootTaskId:root.taskId,
      previousRevisionTaskId:source.taskId === root.taskId ? null : source.taskId,
    },
  };
}

function qualityRootTaskId(task: RuntimeTask) {
  return String(task?.input?.context?.qualityRootTaskId || task?.deliveryQualityRuntime?.rootTaskId || task?.taskId || '').trim();
}

function qualityKey(values: readonly string[]) {
  return Buffer.from([...values].sort().join('|')).toString('base64url').slice(0, 32) || 'none';
}

function mergeArtifacts(left: RuntimeTask[] = [], right: RuntimeTask[] = []) {
  const byId = new Map<string, RuntimeTask>();
  for (const artifact of [...left, ...right]) if (artifact?.artifactId) byId.set(artifact.artifactId, artifact);
  return [...byId.values()];
}

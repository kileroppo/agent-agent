import { presentTask } from './task-presentation.js';
import { sanitizeFailureText } from './technical-failure-classifier.ts';

export class TaskRecordService {
  constructor({ store, taskDetailBaseUrl = '', taskRecovery = null }) {
    this.store = store;
    this.taskDetailBaseUrl = taskDetailBaseUrl;
    this.taskRecovery = taskRecovery;
  }

  async list(query = {}) {
    const [page, approvals] = await Promise.all([
      this.store.queryTasks(query),
      this.store.listApprovals(),
    ]);
    return {
      ...page,
      items:page.items.map((task) => presentRecordSummary(task, approvals, this.taskDetailBaseUrl)),
    };
  }

  async detail(taskId, { audience = 'lan' } = {}) {
    const [task, approvals] = await Promise.all([
      this.store.getTask(taskId),
      this.store.listApprovals(),
    ]);
    if (!task) return null;
    const recoveryView = typeof this.taskRecovery?.view === 'function'
      ? await this.taskRecovery.view(task, { audience })
      : null;
    return presentRecord(task, approvals, this.taskDetailBaseUrl, recoveryView, audience);
  }
}

function presentRecordSummary(task, approvals, detailBaseUrl) {
  return {
    taskId:task.taskId,
    status:task.status,
    taskType:task.taskType,
    assigneeAgentId:task.assigneeAgentId,
    input:{ title:task.input?.title || '' },
    createdAt:task.createdAt,
    updatedAt:task.updatedAt,
    currentStage:task.currentStage || '',
    recordView:task.recordView,
    recordSummary:true,
    presentation:presentTask(task, { approvals, detailBaseUrl }),
  };
}

function presentRecord(task, approvals, detailBaseUrl, recoveryView = null, audience = 'lan') {
  const pendingApproval = approvals.find((approval) =>
    approval?.status === 'pending' && (task.approvalRefs || []).includes(approval.approvalId)
  );
  const common = {
    taskId:cleanText(task.taskId, 120),
    title:safeText(task.input?.title || task.title, 300) || '未命名任务',
    status:cleanText(task.status, 80) || 'unknown',
    createdAt:safeDate(task.createdAt),
    updatedAt:safeDate(task.updatedAt),
    completedAt:safeDate(task.completedAt || task.execution?.finishedAt),
    artifactRefs:safeArtifactMetadata(task.artifactRefs),
    presentation:presentTask(task, { approvals, detailBaseUrl, recoveryView }),
    pendingApproval:safePendingApproval(pendingApproval),
  };
  if (audience !== 'local-owner') return common;
  return {
    ...common,
    taskType:cleanText(task.taskType, 120) || null,
    assigneeAgentId:cleanText(task.assigneeAgentId, 120) || null,
    parentTaskId:cleanText(task.parentTaskId, 120) || null,
    currentStage:cleanText(task.currentStage, 120) || null,
    recordView:cleanText(task.recordView, 80) || null,
    input:safeOwnerInput(task.input),
    error:safeOwnerError(task.error),
    recovery:safeOwnerRecovery(task.recovery),
  };
}

function safeArtifactMetadata(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((artifact) => {
    if (!artifact || typeof artifact !== 'object') return [];
    return [{
      artifactId:cleanText(artifact.artifactId, 240) || null,
      type:cleanText(artifact.type, 120) || null,
      title:safeText(artifact.title, 300) || null,
      mimeType:cleanText(artifact.mimeType, 120) || null,
      accessScope:cleanText(artifact.accessScope, 80) || null,
      createdAt:safeDate(artifact.createdAt),
      validation:safeArtifactValidation(artifact.validation),
    }];
  });
}

function safeArtifactValidation(value) {
  if (!value || typeof value !== 'object') return null;
  const projected = {};
  for (const key of ['exists', 'readable', 'nonEmpty', 'semanticValidationPassed', 'structuralQaPassed', 'testsPassed', 'recoveryVerified']) {
    if (typeof value[key] === 'boolean') projected[key] = value[key];
  }
  return Object.keys(projected).length ? projected : null;
}

function safePendingApproval(approval) {
  if (!approval) return null;
  const scope = safeApprovalScope(approval.requestedScope);
  return {
    approvalId:cleanText(approval.approvalId, 120) || null,
    reason:safeText(approval.reason, 500),
    requestedScope:scope,
  };
}

function safeApprovalScope(value) {
  if (!value || typeof value !== 'object') return null;
  const fields = {
    title:safeText(value.title, 300) || null,
    taskType:cleanText(value.taskType, 120) || null,
    assigneeAgentId:cleanText(value.assigneeAgentId, 120) || null,
    mode:cleanText(value.mode, 80) || null,
    targets:Array.isArray(value.targets)
      ? value.targets.map((item) => safeText(item, 200)).filter(Boolean).slice(0, 20)
      : null,
  };
  const projected = Object.fromEntries(Object.entries(fields).filter(([, item]) => item !== null));
  return Object.keys(projected).length ? projected : null;
}

function safeOwnerInput(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    title:safeText(value.title, 300),
    description:safeText(value.description, 2_000),
    sourceUrl:safeText(value.sourceUrl, 1_000) || null,
    sourceUrls:Array.isArray(value.sourceUrls)
      ? value.sourceUrls.map((item) => safeText(item, 1_000)).filter(Boolean).slice(0, 20)
      : [],
    evidenceMode:cleanText(value.evidenceMode, 80) || null,
    analysisIntent:cleanText(value.analysisIntent, 80) || null,
    depth:cleanText(value.depth, 80) || null,
    focus:safeText(value.focus, 500) || null,
    visualMode:cleanText(value.visualMode, 80) || null,
  };
}

function safeOwnerError(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    code:cleanText(value.code, 120) || null,
    userMessage:safeText(value.userMessage, 800) || null,
    category:cleanText(value.category, 80) || null,
    stage:cleanText(value.stage, 120) || null,
    retryable:typeof value.retryable === 'boolean' ? value.retryable : null,
    occurredAt:safeDate(value.occurredAt),
  };
}

function safeOwnerRecovery(value) {
  if (!value || typeof value !== 'object') return null;
  const coordination = value.coordination && typeof value.coordination === 'object'
    ? {
      status:cleanText(value.coordination.status, 80) || null,
      actionKey:cleanText(value.coordination.actionKey, 120) || null,
      retryTaskId:cleanText(value.coordination.retryTaskId, 120) || null,
      technicalTaskId:cleanText(value.coordination.technicalTaskId, 120) || null,
      operatorTaskId:cleanText(value.coordination.operatorTaskId, 120) || null,
      requestedAt:safeDate(value.coordination.requestedAt),
      reason:safeText(value.coordination.reason, 800) || null,
    }
    : null;
  return {
    rootTaskId:cleanText(value.rootTaskId, 120) || null,
    attempt:Number.isSafeInteger(value.attempt) && value.attempt >= 0 ? value.attempt : null,
    mode:cleanText(value.mode, 80) || null,
    coordination,
  };
}

function safeText(value, limit) {
  return sanitizeFailureText(value).slice(0, limit);
}

function cleanText(value, limit) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function safeDate(value) {
  const text = String(value || '').trim();
  return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : null;
}

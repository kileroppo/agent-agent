import {
  createM5RouteExecution,
  validM5RouteExecution,
} from '@agent-army/m5-kernel/route-execution';

import { ValidationError } from './task-validation-error.js';

export function paperclipCaseContextFields(fields) {
  const source = fields && typeof fields === 'object' ? fields : {};
  const allowed = [
    'campaignId',
    'scheduledDate',
    'theme',
    'platform',
    'contentVersion',
    'contentVersionId',
    'assetRightsBasis',
  ];
  return Object.fromEntries(allowed.flatMap((key) => {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return [[key, value.trim().slice(0, 500)]];
    if (Number.isInteger(value)) return [[key, value]];
    return [];
  }));
}

export function m5PlanRevisionExecutionContext(revision) {
  return {
    schemaVersion:revision.schemaVersion,
    revisionId:revision.revisionId,
    revision:revision.revision,
    failedCaseId:revision.failedCaseId,
    failureObservation:{
      issueId:revision.failureObservation?.issueId || null,
      runId:revision.failureObservation?.runId || null,
      stageKey:revision.failureObservation?.stageKey || null,
      summary:revision.failureObservation?.summary || '',
      summaryHash:revision.failureObservation?.summaryHash || null,
    },
    rejectedRoute:{
      kind:revision.rejectedRoute?.kind || null,
      reason:revision.rejectedRoute?.reason || '',
      routeFingerprint:revision.rejectedRoute?.routeFingerprint || null,
      execution:revision.rejectedRoute?.execution || null,
    },
    nextRoute:{
      kind:revision.nextRoute?.kind,
      stageKey:revision.nextRoute?.stageKey,
      preserveVerifiedWorkProducts:revision.nextRoute?.preserveVerifiedWorkProducts === true,
      instruction:revision.nextRoute?.instruction || '',
    },
  };
}

export function assertM5PlanRevisionConsumed({
  expected,
  actual,
  runId,
  allowUnchangedFailure = false,
  input,
} = {}) {
  if (!expected) return null;
  const revisionId = String(expected.revisionId || '').trim();
  const consumedRevisionId = String(input?.consumedRevisionId || '').trim();
  if (!revisionId || consumedRevisionId !== revisionId) {
    throw new ValidationError('当前 M5 Run 必须精确回报已消费的 PlanRevision ID。');
  }
  if (
    !validM5RouteExecution(actual)
    || actual.runId !== runId
    || actual.consumedRevisionId !== revisionId
    || actual.stageKey !== expected.nextRoute?.stageKey
  ) {
    throw new ValidationError('当前 M5 Run 没有执行器生成的 PlanRevision 消费回执。');
  }
  if (
    !allowUnchangedFailure
    && (actual.routeChanged !== true || actual.changedDimensions.length === 0)
  ) {
    throw new ValidationError(
      '执行器确认本次输入、工具和策略均未变化；拒绝把同一路线写成已恢复。',
    );
  }
  return {
    schemaVersion:'agent.army/m5-plan-revision-receipt/v1',
    consumedRevisionId,
    routeChanged:actual.routeChanged === true,
    changedDimensions:[...actual.changedDimensions],
    routeFingerprint:actual.routeFingerprint,
    routeSummary:actual.routeSummary,
    stageKey:expected.nextRoute?.stageKey || null,
    recordedAt:new Date().toISOString(),
  };
}

export function prepareM5ExecutorTask({ task, assignment, contract } = {}) {
  if (!contract || contract.executionMode !== 'hermes') {
    return { task, recovery:null, routeExecution:null };
  }
  const recovery = task?.input?.context?.m5Recovery || null;
  const strategy = recovery?.nextRoute?.kind
    || `default:${contract.executionTool?.id || 'hermes_executor'}`;
  const previousExecution = validM5RouteExecution(task?.execution?.m5RouteExecution)
    ? task.execution.m5RouteExecution
    : null;
  const routeExecution = createM5RouteExecution({
    runId:assignment.runId,
    stageKey:contract.stageKey,
    recovery,
    previousExecution,
    strategy,
    toolIds:[contract.executionTool?.id || 'hermes_executor'],
    inputs:m5BusinessExecutionInput(task?.input),
  });
  if (!recovery) return { task, recovery:null, routeExecution };
  return {
    recovery,
    routeExecution,
    task:{
      ...task,
      input:{
        ...(task.input || {}),
        context:{
          ...(task.input?.context || {}),
          m5AlternativeRoute:{
            revisionId:recovery.revisionId,
            strategy,
            instruction:recovery.nextRoute?.instruction || '',
            preserveVerifiedWorkProducts:
              recovery.nextRoute?.preserveVerifiedWorkProducts === true,
          },
        },
      },
    },
  };
}

export function assertM5ExecutorRouteReceipt({
  task,
  contract,
  result,
  allowUnchanged = false,
} = {}) {
  const recovery = task?.input?.context?.m5Recovery || null;
  if (!recovery && !validM5RouteExecution(result)) return null;
  if (
    !validM5RouteExecution(result)
    || result.runId !== task?.execution?.paperclipRunId
    || result.stageKey !== contract?.stageKey
  ) {
    throw new ValidationError('M5 阶段执行器缺少与当前 Run、阶段一致的真实路线回执。');
  }
  if (recovery) {
    if (result.consumedRevisionId !== recovery.revisionId) {
      throw new ValidationError('M5 阶段执行器消费的 PlanRevision 与当前指派不一致。');
    }
    if (!allowUnchanged && (result.routeChanged !== true || result.changedDimensions.length === 0)) {
      throw new ValidationError('M5 阶段执行器没有真实改变输入、工具或策略。');
    }
  }
  return result;
}

export function m5BusinessExecutionInput(input) {
  if (!input || typeof input !== 'object') return {};
  const context = input.context && typeof input.context === 'object'
    ? Object.fromEntries(
        Object.entries(input.context)
          .filter(([key]) => !['m5Recovery', 'm5AlternativeRoute'].includes(key)),
      )
    : {};
  return {
    ...input,
    context,
  };
}

export function trustedRoleToolScope({
  tasks,
  task,
  relatedTaskIds,
  paperclipIssueId = null,
  paperclipRunId = null,
  pipelineCaseId = null,
} = {}) {
  const relatedIds = new Set(
    (Array.isArray(relatedTaskIds) ? relatedTaskIds : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  );
  const parentTaskId = String(task?.parentTaskId || '').trim();
  const currentTaskId = String(task?.taskId || '').trim();
  const allowedTaskIds = (Array.isArray(tasks) ? tasks : []).filter((candidate) =>
    candidate?.taskId !== currentTaskId
    && (
      relatedIds.has(String(candidate?.taskId || ''))
      || (parentTaskId && candidate?.parentTaskId === parentTaskId)
    ),
  ).map((candidate) => candidate.taskId);
  return Object.freeze({
    currentTaskId:currentTaskId || null,
    currentAgentId:String(task?.assigneeAgentId || '').trim() || null,
    currentWorkflowId:String(task?.workflow?.workflowId || '').trim() || null,
    currentStepId:String(task?.workflow?.step?.stepId || task?.currentStage || '').trim() || null,
    allowedTaskIds:Object.freeze(allowedTaskIds),
    paperclipIssueId:String(paperclipIssueId || '').trim() || null,
    paperclipRunId:String(paperclipRunId || '').trim() || null,
    pipelineCaseId:String(pipelineCaseId || '').trim() || null,
  });
}

export async function m5PipelineCaseChainIds({ governance, pipelineCaseId, pipelineCase }) {
  const firstId = String(pipelineCaseId || '').trim();
  if (!firstId) return [];
  const caseIds = [];
  const visited = new Set();
  let current = pipelineCase?.case || pipelineCase || { id:firstId };
  for (let depth = 0; depth < 32; depth += 1) {
    const currentId = String(current?.id || (depth === 0 ? firstId : '')).trim();
    if (!currentId || visited.has(currentId)) {
      throw new ValidationError('M5 Pipeline Case 父子链无效或存在循环。');
    }
    caseIds.push(currentId);
    visited.add(currentId);
    const parentCaseId = String(current?.parentCaseId || '').trim();
    if (!parentCaseId) return caseIds;
    if (typeof governance?.getPipelineCase !== 'function') {
      throw new ValidationError('M5 Pipeline Case 缺少父级读取能力，无法绑定前置产物。');
    }
    const parent = await governance.getPipelineCase(parentCaseId);
    current = parent?.case || parent;
    if (!current) throw new ValidationError('M5 Pipeline Case 父级不存在，无法绑定前置产物。');
  }
  throw new ValidationError('M5 Pipeline Case 父子链超过安全深度。');
}

export function m5RelatedTaskContext(tasks, pipelineCaseIds, pipelineCase = null) {
  const allowedCaseIds = new Set(
    (Array.isArray(pipelineCaseIds) ? pipelineCaseIds : [pipelineCaseIds])
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  );
  if (!allowedCaseIds.size) return { sourceTaskIds:[], sourceUrls:[] };
  const currentFields = paperclipCaseContextFields(
    pipelineCase?.case?.fields || pipelineCase?.fields || {},
  );
  const sameContentDay = (candidate) => {
    const fields = candidate?.input?.context?.pipelineCase?.fields || {};
    return Boolean(
      currentFields.campaignId
      && currentFields.scheduledDate
      && fields.campaignId === currentFields.campaignId
      && fields.scheduledDate === currentFields.scheduledDate
      && String(fields.contentVersion || 'v1') === String(currentFields.contentVersion || 'v1'),
    );
  };
  const related = (Array.isArray(tasks) ? tasks : [])
    .filter((item) =>
      (
        allowedCaseIds.has(String(item?.input?.context?.pipelineCaseId || '').trim())
        || sameContentDay(item)
      )
      && item?.governance?.paperclipIssueId
      && !['failed', 'cancelled'].includes(item.status),
    )
    .sort((left, right) =>
      Date.parse(left.createdAt || left.updatedAt || 0) - Date.parse(right.createdAt || right.updatedAt || 0),
    );
  const sourceUrls = related.flatMap((item) => (item.artifactRefs || []).flatMap((artifact) => {
    if (artifact?.validation?.publicReadOnly !== true) return [];
    const sources = Array.isArray(artifact.data?.sources) ? artifact.data.sources : [];
    return sources.map((source) => String(source.source || source.url || '').trim())
      .filter((value) => /^https?:\/\//i.test(value));
  }));
  return {
    sourceTaskIds:[...new Set(related.map((item) => item.taskId).filter(Boolean))].slice(-20),
    sourceUrls:[...new Set(sourceUrls)].slice(0, 5),
  };
}

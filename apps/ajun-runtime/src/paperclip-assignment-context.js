import { ValidationError } from './task-validation-error.js';

export async function preparePaperclipAssignmentContext({
  governance,
  tasks,
  assignmentTask,
  pipelineCase,
  activePlanRevision,
} = {}) {
  const pipelineCaseId = assignmentTask?.pipelineCaseId;
  const relatedCaseIds = await m5PipelineCaseChainIds({
    governance,
    pipelineCaseId,
    pipelineCase,
  });
  const related = m5RelatedTaskContext(tasks, relatedCaseIds, pipelineCase);

  return {
    createTaskInput({ identity, assignmentProjectId } = {}) {
      const caseFields = normalizedCaseFields(pipelineCase);
      return {
        title:String(identity.issue.title || 'Paperclip 指派任务').slice(0, 500),
        description:String(identity.issue.description || '').slice(0, 4000),
        topic:caseFields.theme || null,
        contentGoal:caseFields.theme || null,
        platforms:caseFields.platform ? [caseFields.platform] : [],
        sourceUrl:related.sourceUrls[0] || null,
        sourceUrls:related.sourceUrls,
        context:{
          paperclipIssueIdentifier:identity.issue.identifier || null,
          ...(assignmentTask?.routineKey ? { paperclipRoutineKey:assignmentTask.routineKey } : {}),
          ...(pipelineCaseId ? { pipelineCaseId } : {}),
          ...(assignmentProjectId ? { paperclipProjectId:assignmentProjectId } : {}),
          ...(activePlanRevision ? {
            m5Recovery:m5PlanRevisionExecutionContext(activePlanRevision),
          } : {}),
          ...(related.sourceTaskIds.length ? { sourceTaskIds:related.sourceTaskIds } : {}),
          ...(pipelineCase ? { pipelineCase:pipelineCaseContext(pipelineCase, pipelineCaseId, caseFields) } : {}),
        },
      };
    },

    refreshTaskInput(input, { assignmentProjectId } = {}) {
      return {
        ...(input || {}),
        context:{
          ...(input?.context || {}),
          m5Recovery:activePlanRevision
            ? m5PlanRevisionExecutionContext(activePlanRevision)
            : null,
          ...(assignmentProjectId ? { paperclipProjectId:assignmentProjectId } : {}),
          ...(related.sourceTaskIds.length ? { sourceTaskIds:related.sourceTaskIds } : {}),
          ...(pipelineCase ? {
            pipelineCase:pipelineCaseContext(
              pipelineCase,
              pipelineCaseId,
              normalizedCaseFields(pipelineCase),
            ),
          } : {}),
        },
      };
    },

    scopeRoleToolGrant(baseRoleToolGrant, { task, identity } = {}) {
      if (!baseRoleToolGrant) return null;
      return Object.freeze({
        ...baseRoleToolGrant,
        trustedScope:trustedRoleToolScope({
          tasks,
          task,
          relatedTaskIds:related.sourceTaskIds,
          paperclipIssueId:identity.issue.id,
          paperclipRunId:identity.run.id,
          pipelineCaseId,
        }),
      });
    },

    assignmentRecoveryFields() {
      return activePlanRevision
        ? { m5Recovery:m5PlanRevisionExecutionContext(activePlanRevision) }
        : {};
    },
  };
}

function normalizedCaseFields(pipelineCase) {
  return paperclipCaseContextFields(
    pipelineCase?.case?.fields || pipelineCase?.fields || {},
  );
}

function pipelineCaseContext(pipelineCase, pipelineCaseId, fields) {
  return {
    id:pipelineCase.case?.id || pipelineCase.id || pipelineCaseId,
    parentCaseId:pipelineCase.case?.parentCaseId || pipelineCase.parentCaseId || null,
    caseKey:pipelineCase.case?.caseKey || pipelineCase.caseKey || null,
    title:pipelineCase.case?.title || pipelineCase.title || null,
    stageKey:pipelineCase.case?.stageKey || pipelineCase.stageKey || null,
    fields,
  };
}

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

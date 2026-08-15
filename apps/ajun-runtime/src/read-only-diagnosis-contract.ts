const REQUIRED_PROHIBITED_ACTIONS = Object.freeze([
  'retry',
  'code_write',
  'permission_expansion',
  'external_publish',
]);

export function isTrustedReadOnlyDiagnosisTask(task: any): boolean {
  const context = task?.input?.context;
  const prohibitedActions = Array.isArray(context?.prohibitedActions)
    ? [...new Set(context.prohibitedActions.map((value: any) => String(value || '').trim()).filter(Boolean))]
    : [];
  const parentTaskId = String(task?.parentTaskId || '').trim();

  return task?.taskType === 'operations.failure-recovery'
    && task?.requester?.kind === 'local-owner'
    && task?.source?.channel === 'internal-recovery'
    && task?.recovery?.mode === 'read_only_diagnosis'
    && context?.diagnosisOnly === true
    && Boolean(parentTaskId)
    && String(context?.failedTaskId || '').trim() === parentTaskId
    && Boolean(String(context?.parentPaperclipIssueId || '').trim())
    && prohibitedActions.length === REQUIRED_PROHIBITED_ACTIONS.length
    && REQUIRED_PROHIBITED_ACTIONS.every((action) => prohibitedActions.includes(action));
}

export function readOnlyDiagnosisProhibitedActions(): string[] {
  return [...REQUIRED_PROHIBITED_ACTIONS];
}

export function readOnlyDiagnosisContext(task: any, failureClassification: any): any {
  const artifacts: any[] = Array.isArray(task?.artifactRefs) ? task.artifactRefs : [];
  return {
    parentPaperclipIssueId:String(task?.governance?.paperclipIssueId || '').trim(),
    failedTaskId:task?.taskId,
    diagnosisOnly:true,
    prohibitedActions:readOnlyDiagnosisProhibitedActions(),
    failure:{
      code:cleanText(task?.error?.code, 120) || null,
      category:cleanText(task?.error?.category, 80) || null,
      stage:cleanText(task?.error?.stage, 120) || null,
      retryable:typeof task?.error?.retryable === 'boolean' ? task.error.retryable : null,
      occurredAt:cleanText(task?.error?.occurredAt, 80) || null,
      userMessage:cleanText(task?.error?.userMessage, 500) || null,
    },
    failureClassification,
    artifactSummary:{
      total:artifacts.length,
      verified:artifacts.filter(readableArtifact).length,
      types:[...new Set(artifacts.map((artifact: any) => String(artifact?.type || '').trim()).filter(Boolean))].slice(0, 20),
    },
    sourceUrl:task?.input?.sourceUrl || null,
    attempt:0,
    maxAutomaticRetries:0,
  };
}

export function hasVerifiedReadOnlyDiagnosis(task: any): boolean {
  return task?.status === 'succeeded' && hasReadOnlyDiagnosisArtifact(task);
}

export function hasReadOnlyDiagnosisArtifact(task: any): boolean {
  return (task?.artifactRefs || []).some((artifact: any) => artifact?.type === 'recovery_decision' && readableArtifact(artifact));
}

export async function closeSupersededReadOnlyDiagnosis({ store, task, replacementTaskId, decidedAt }: any): Promise<any> {
  if (typeof store?.listApprovals === 'function' && typeof store?.updateApproval === 'function') {
    const approvals: any[] = await store.listApprovals();
    for (const approval of approvals.filter((item: any) => item?.taskId === task.taskId && item?.status === 'pending')) {
      await store.updateApproval(approval.approvalId, {
        status:'rejected',
        decisionBy:'A君运行台',
        decisionReason:'旧版只读诊断误触二次审批，已由一次确认的新诊断替换。',
        decidedAt,
      });
    }
  }
  return store.updateTask(task.taskId, {
    status:'cancelled',
    currentStage:'superseded_read_only_diagnosis',
    error:{
      code:'superseded_read_only_diagnosis',
      message:`旧版只读诊断已由 ${cleanText(replacementTaskId, 120)} 替换。`,
      userMessage:'旧诊断误触了二次确认，现已由新的只读诊断替换并关闭。',
      category:'manual',
      stage:'approval',
      retryable:false,
      occurredAt:decidedAt,
    },
  });
}

function readableArtifact(artifact: any): boolean {
  return artifact?.validation?.exists === true
    && artifact?.validation?.readable === true
    && artifact?.validation?.nonEmpty === true;
}

function cleanText(value: any, limit: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

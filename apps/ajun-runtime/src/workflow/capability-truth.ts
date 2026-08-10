export type CapabilityTruthState = 'human_accepted' | 'verified' | 'live' | 'configured' | 'declared' | 'not_declared';
export type CapabilityEvidenceFreshness = 'later_than_latest_failure' | 'predates_latest_failure' | 'no_failure' | 'none';

export type AgentCapabilityTruth = Readonly<{
  declared: boolean;
  configured: boolean;
  live: boolean;
  verified: boolean;
  humanAccepted: boolean;
  overall: CapabilityTruthState;
  verifiedAt: string | null;
  evidenceTaskId: string | null;
  evidenceRef: string | null;
  freshness: CapabilityEvidenceFreshness;
  latestFailureAt: string | null;
  latestFailureTaskId: string | null;
}>;

export function agentCapabilityTruth({
  agent,
  tasks,
  runtimeHealth,
  channel,
}: {
  agent: any;
  tasks: readonly any[];
  runtimeHealth?: any;
  channel?: any;
}): AgentCapabilityTruth {
  const agentTasks = (tasks || []).filter((task) => task?.assigneeAgentId === agent?.agentId);
  const verifiedTask = [...agentTasks]
    .filter((task) => task?.status === 'succeeded'
      && hasVerifiedArtifact(task)
      && Boolean(cleanReference(task?.taskId))
      && Boolean(taskTime(task)))
    .sort((left, right) => Date.parse(right.updatedAt || right.createdAt || '') - Date.parse(left.updatedAt || left.createdAt || ''))[0];
  const acceptedTask = [...agentTasks]
    .filter(hasHumanAcceptance)
    .sort((left, right) => Date.parse(right.updatedAt || right.createdAt || '') - Date.parse(left.updatedAt || left.createdAt || ''))[0];
  const latestFailureTask = [...agentTasks]
    .filter((task) => ['failed', 'waiting_test'].includes(String(task?.status || '')))
    .sort((left, right) => taskTimestamp(right) - taskTimestamp(left))[0];
  const declared = agent?.status === 'active' || Array.isArray(agent?.acceptedTaskTypes);
  const configured = Boolean(agent?.runtimeCapabilities?.modelSelection?.model || agent?.executionOwner === 'local');
  const runtimeStatus = String(runtimeHealth?.status || '');
  const channelStatus = String(channel?.status || '');
  const live = ['healthy', 'ready'].includes(runtimeStatus)
    || ['connected', 'external', 'ready'].includes(channelStatus)
    || Boolean(verifiedTask);
  const verified = Boolean(verifiedTask);
  const humanAccepted = Boolean(acceptedTask);
  const verifiedAt = taskTime(verifiedTask);
  const latestFailureAt = taskTime(latestFailureTask);
  return Object.freeze({
    declared,
    configured,
    live,
    verified,
    humanAccepted,
    overall:overall({ declared, configured, live, verified, humanAccepted }),
    verifiedAt,
    evidenceTaskId:verifiedTask?.taskId || null,
    evidenceRef:verifiedTask?.taskId ? `task:${verifiedTask.taskId}` : null,
    freshness:evidenceFreshness(verifiedAt, latestFailureAt),
    latestFailureAt,
    latestFailureTaskId:latestFailureTask?.taskId || null,
  });
}

export function capabilityTruthState({
  declared = true,
  configured = false,
  live = false,
  verified = false,
  humanAccepted = false,
  verifiedAt = null,
  evidenceTaskId = null,
  evidenceRef = null,
  latestFailureAt = null,
  latestFailureTaskId = null,
}: Partial<AgentCapabilityTruth>): AgentCapabilityTruth {
  const safeVerifiedAt = validTime(verifiedAt);
  const safeFailureAt = validTime(latestFailureAt);
  const safeEvidenceTaskId = cleanReference(evidenceTaskId);
  const safeEvidenceRef = cleanReference(evidenceRef) || (safeEvidenceTaskId ? `task:${safeEvidenceTaskId}` : null);
  const evidenceVerified = verified && Boolean(safeVerifiedAt && safeEvidenceRef);
  const evidenceHumanAccepted = humanAccepted && evidenceVerified;
  return Object.freeze({
    declared,
    configured,
    live,
    verified:evidenceVerified,
    humanAccepted:evidenceHumanAccepted,
    overall:overall({ declared, configured, live, verified:evidenceVerified, humanAccepted:evidenceHumanAccepted }),
    verifiedAt:evidenceVerified ? safeVerifiedAt : null,
    evidenceTaskId:evidenceVerified ? safeEvidenceTaskId : null,
    evidenceRef:evidenceVerified ? safeEvidenceRef : null,
    freshness:evidenceVerified ? evidenceFreshness(safeVerifiedAt, safeFailureAt) : 'none',
    latestFailureAt:safeFailureAt,
    latestFailureTaskId:cleanReference(latestFailureTaskId),
  });
}

function overall(state: {
  declared: boolean;
  configured: boolean;
  live: boolean;
  verified: boolean;
  humanAccepted: boolean;
}): CapabilityTruthState {
  if (!state.declared) return 'not_declared';
  if (state.verified && state.humanAccepted) return 'human_accepted';
  if (state.verified) return 'verified';
  if (state.live) return 'live';
  if (state.configured) return 'configured';
  return 'declared';
}

function hasVerifiedArtifact(task: any): boolean {
  return (task?.artifactRefs || []).some((artifact: any) => (
    artifact?.validation?.exists === true
    && artifact?.validation?.readable === true
    && artifact?.validation?.nonEmpty !== false
  ));
}

function hasHumanAcceptance(task: any): boolean {
  return task?.evaluation?.humanAcceptance?.status === 'accepted'
    || (task?.artifactRefs || []).some((artifact: any) => (
      artifact?.validation?.humanAccepted === true
      || artifact?.validation?.ownerAccepted === true
      || Boolean(artifact?.validation?.humanAcceptedAt)
    ));
}

function taskTimestamp(task: any): number {
  return Date.parse(task?.updatedAt || task?.createdAt || '') || 0;
}

function taskTime(task: any): string | null {
  const value = String(task?.updatedAt || task?.createdAt || '').trim();
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function validTime(value: unknown): string | null {
  const text = String(value || '').trim();
  return Number.isFinite(Date.parse(text)) ? text : null;
}

function cleanReference(value: unknown): string | null {
  const text = String(value || '').replace(/[^A-Za-z0-9:._-]/g, '').slice(0, 200);
  return text || null;
}

function evidenceFreshness(verifiedAt: string | null, latestFailureAt: string | null): CapabilityEvidenceFreshness {
  if (!verifiedAt) return 'none';
  if (!latestFailureAt) return 'no_failure';
  return Date.parse(verifiedAt) > Date.parse(latestFailureAt)
    ? 'later_than_latest_failure'
    : 'predates_latest_failure';
}

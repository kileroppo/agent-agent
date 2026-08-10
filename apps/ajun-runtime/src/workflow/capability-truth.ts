export type CapabilityTruthState = 'human_accepted' | 'verified' | 'live' | 'configured' | 'declared' | 'not_declared';

export type AgentCapabilityTruth = Readonly<{
  declared: boolean;
  configured: boolean;
  live: boolean;
  verified: boolean;
  humanAccepted: boolean;
  overall: CapabilityTruthState;
  verifiedAt: string | null;
  evidenceTaskId: string | null;
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
    .filter((task) => task?.status === 'succeeded' && hasVerifiedArtifact(task))
    .sort((left, right) => Date.parse(right.updatedAt || right.createdAt || '') - Date.parse(left.updatedAt || left.createdAt || ''))[0];
  const acceptedTask = [...agentTasks]
    .filter(hasHumanAcceptance)
    .sort((left, right) => Date.parse(right.updatedAt || right.createdAt || '') - Date.parse(left.updatedAt || left.createdAt || ''))[0];
  const declared = agent?.status === 'active' || Array.isArray(agent?.acceptedTaskTypes);
  const configured = Boolean(agent?.runtimeCapabilities?.modelSelection?.model || agent?.executionOwner === 'local');
  const runtimeStatus = String(runtimeHealth?.status || '');
  const channelStatus = String(channel?.status || '');
  const live = ['healthy', 'ready'].includes(runtimeStatus)
    || ['connected', 'external', 'ready'].includes(channelStatus)
    || Boolean(verifiedTask);
  const verified = Boolean(verifiedTask);
  const humanAccepted = Boolean(acceptedTask);
  return Object.freeze({
    declared,
    configured,
    live,
    verified,
    humanAccepted,
    overall:overall({ declared, configured, live, verified, humanAccepted }),
    verifiedAt:verifiedTask?.updatedAt || verifiedTask?.createdAt || null,
    evidenceTaskId:verifiedTask?.taskId || null,
  });
}

export function capabilityTruthState({
  declared = true,
  configured = false,
  live = false,
  verified = false,
  humanAccepted = false,
}: Partial<AgentCapabilityTruth>): AgentCapabilityTruth {
  return Object.freeze({
    declared,
    configured,
    live,
    verified,
    humanAccepted,
    overall:overall({ declared, configured, live, verified, humanAccepted }),
    verifiedAt:null,
    evidenceTaskId:null,
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

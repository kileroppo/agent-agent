export function capabilityTruthView(value: any) {
  return Object.freeze({
    declared:value?.declared === true,
    configured:value?.configured === true,
    live:value?.live === true,
    verified:value?.verified === true,
    humanAccepted:value?.humanAccepted === true,
    overall:safeText(value?.overall, 40) || 'unknown',
    verifiedAt:safeText(value?.verifiedAt, 40) || null,
    evidenceTaskId:safeText(value?.evidenceTaskId, 200) || null,
    evidenceRef:safeText(value?.evidenceRef, 240) || null,
    freshness:safeText(value?.freshness, 50) || 'none',
    latestFailureAt:safeText(value?.latestFailureAt, 40) || null,
    latestFailureTaskId:safeText(value?.latestFailureTaskId, 200) || null,
  });
}

export function safeWorkflowViews(value: unknown) {
  return Object.freeze((Array.isArray(value) ? value : []).slice(0, 50).map((item) => Object.freeze({
    workflowId:safeText(item?.workflowId, 160),
    workflowType:safeText(item?.workflowType, 120),
    status:safeText(item?.status, 60),
    taskCount:Number(item?.taskCount || 0),
    verifiedArtifactCount:Number(item?.verifiedArtifactCount || 0),
    needsHumanAcceptance:item?.needsHumanAcceptance === true,
  })));
}

export function capabilitiesReadView(overview: any) {
  return Object.freeze({
    capabilities:Object.freeze((overview?.capabilities || []).map(capabilityView)),
    employees:Object.freeze((overview?.agents || []).filter((agent: any) => agent?.status === 'active').map(employeeCapabilityView)),
  });
}

export function armyStatusReadView(overview: any) {
  return Object.freeze({
    taskFocus:overview?.taskFocus || {},
    validationCampaign:overview?.validationCampaign || {},
    workflows:safeWorkflowViews(overview?.workflows),
    usage:overview?.usage || {},
    capabilities:Object.freeze((overview?.capabilities || []).map(capabilityView)),
    employees:Object.freeze((overview?.agents || []).map((agent: any) => Object.freeze({
      agentId:safeText(agent?.agentId, 100),
      name:safeText(agent?.name || agent?.agentId, 120),
      status:safeText(agent?.status, 40),
      capabilityTruth:capabilityTruthView(agent?.capabilityTruth),
      feishuChannel:safeChannel(agent?.feishuChannel),
    }))),
  });
}

function employeeCapabilityView(agent: any) {
  return Object.freeze({
    agentId:safeText(agent?.agentId, 100),
    name:safeText(agent?.name || agent?.agentId, 120),
    role:safeText(agent?.role, 240),
    capabilityTruth:capabilityTruthView(agent?.capabilityTruth),
    acceptedTaskTypes:safeStringList(agent?.acceptedTaskTypes, 20, 120),
  });
}

function capabilityView(capability: any) {
  return Object.freeze({
    id:safeText(capability?.id, 100),
    name:safeText(capability?.name, 120),
    status:safeText(capability?.status, 40),
    detail:safeText(capability?.detail, 500),
    truth:capabilityTruthView(capability?.truth),
  });
}

function safeChannel(channel: any) {
  if (!channel) return null;
  return Object.freeze({
    status:safeText(channel.status, 40),
    message:safeText(channel.message, 300),
    verified:channel.verified === true,
  });
}

function safeStringList(value: unknown, maxItems: number, maxChars: number): readonly string[] {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return Object.freeze([...new Set(values.map((item) => safeText(item, maxChars)).filter(Boolean))].slice(0, maxItems));
}

function safeText(value: unknown, limit: number): string {
  return String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

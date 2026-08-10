export function capabilityTruthView(value: any) {
  return Object.freeze({
    declared:value?.declared === true,
    configured:value?.configured === true,
    live:value?.live === true,
    verified:value?.verified === true,
    humanAccepted:value?.humanAccepted === true,
    overall:safeText(value?.overall, 40) || 'unknown',
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

function safeText(value: unknown, limit: number): string {
  return String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

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
    viewKind:'army_status',
    presentation:armyStatusPresentation(overview),
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

function armyStatusPresentation(overview: any) {
  const tasks = Array.isArray(overview?.tasks) ? overview.tasks : [];
  const focus = overview?.taskFocus || {};
  const recovery = tasks
    .filter((task: any) => activeRecovery(task, tasks))
    .sort(newestFirst)[0];

  if (recovery) {
    const title = safeText(recovery?.input?.title, 120) || '当前任务';
    const employee = employeeName(overview?.agents, recovery?.assigneeAgentId);
    const context = employee ? `${employee}处理“${title}”时出现异常` : `“${title}”执行时出现异常`;
    const status = recovery.recovery.coordination.status;
    const action = status === 'retrying'
      ? '已自动重试，正在复验'
      : status === 'escalated'
        ? '技术专家正在诊断修复'
        : '运维官正在诊断';
    return Object.freeze({
      status:'recovering',
      userActionRequired:false,
      summary:`${context}，${action}。暂时不用你处理。`,
    });
  }

  const waitingApproval = Math.max(0, Number(focus?.waitingApproval || 0));
  if (waitingApproval > 0) {
    const next = focus?.actions?.find((item: any) => item?.status === 'waiting_approval') || focus?.next;
    const title = safeText(next?.title, 120);
    const action = safeText(next?.action, 300) || '请确认后我再继续。';
    return Object.freeze({
      status:'needs_user_action',
      userActionRequired:true,
      summary:`有 ${waitingApproval} 项操作等你确认${title ? `，当前是“${title}”` : ''}。${action}`,
    });
  }

  const inProgress = Math.max(0, Number(focus?.inProgress || 0));
  return Object.freeze({
    status:'normal',
    userActionRequired:false,
    summary:inProgress > 0
      ? `军团正常，正在处理 ${inProgress} 项工作。暂时不用你处理。`
      : '军团正常，没有需要你处理的事。',
  });
}

function activeRecovery(task: any, tasks: readonly any[]) {
  const coordination = task?.recovery?.coordination;
  if (!['pending', 'retrying', 'escalated'].includes(coordination?.status)) return false;
  const linkedTaskId = coordination?.retryTaskId || coordination?.technicalTaskId;
  if (!linkedTaskId) return false;
  const linked = tasks.find((item: any) => item?.taskId === linkedTaskId);
  return Boolean(linked && ['queued', 'running', 'waiting_worker', 'pausing'].includes(linked.status));
}

function employeeName(agents: unknown, agentId: unknown) {
  const id = safeText(agentId, 100);
  if (!id || !Array.isArray(agents)) return '';
  const agent = agents.find((item: any) => safeText(item?.agentId, 100) === id);
  return safeText(agent?.name || agent?.agentId, 120);
}

function newestFirst(left: any, right: any) {
  return (Date.parse(right?.updatedAt || right?.createdAt || '') || 0)
    - (Date.parse(left?.updatedAt || left?.createdAt || '') || 0);
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

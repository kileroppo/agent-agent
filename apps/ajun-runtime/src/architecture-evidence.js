import crypto from 'node:crypto';

const MAX_TASK_EVIDENCE = 60;

export function buildArchitectureGroundTruth({ agents = [], tasks = [], generatedAt = new Date().toISOString() } = {}) {
  const agentEvidence = agents
    .filter((agent) => agent?.agentId)
    .map((agent) => ({
      ref:`agent:${agent.agentId}`,
      agentId:String(agent.agentId),
      name:String(agent.name || agent.agentId),
      status:String(agent.status || 'unknown'),
      acceptedTaskTypes:strings(agent.acceptedTaskTypes),
      toolAllowlist:strings(agent.toolAllowlist),
      repositoryRefs:[
        `agents/${agent.agentId}/manifest.json`,
        String(agent.promptRef || ''),
        String(agent.runtimeProfileRef || '')
      ].filter(Boolean)
    }))
    .sort((left, right) => left.agentId.localeCompare(right.agentId));
  const allowedAgentIds = new Set(agentEvidence.map((item) => item.agentId));
  const taskEvidence = [...tasks]
    .filter((task) => task?.taskId)
    .sort((left, right) => taskTime(right) - taskTime(left))
    .slice(0, MAX_TASK_EVIDENCE)
    .map((task) => ({
      ref:`task:${task.taskId}`,
      taskId:String(task.taskId),
      taskType:String(task.taskType || 'unknown'),
      assigneeAgentId:allowedAgentIds.has(task.assigneeAgentId) ? task.assigneeAgentId : null,
      status:String(task.status || 'unknown'),
      title:safeTitle(task.input?.title),
      updatedAt:String(task.updatedAt || task.createdAt || ''),
      artifactTypes:strings((task.artifactRefs || []).map((item) => item?.type))
    }));
  const byStatus = {};
  const byTaskType = {};
  for (const task of tasks) {
    const status = String(task?.status || 'unknown');
    const taskType = String(task?.taskType || 'unknown');
    byStatus[status] = (byStatus[status] || 0) + 1;
    byTaskType[taskType] = (byTaskType[taskType] || 0) + 1;
  }
  const taskTypes = [...new Set([
    ...agentEvidence.flatMap((agent) => agent.acceptedTaskTypes),
    ...Object.keys(byTaskType)
  ])].sort().map((taskType) => ({
    ref:`task-type:${taskType}`,
    taskType,
    agentIds:agentEvidence.filter((agent) => agent.acceptedTaskTypes.includes(taskType)).map((agent) => agent.agentId),
    taskCount:byTaskType[taskType] || 0
  }));
  const payload = {
    schemaVersion:'agent.army/architecture-ground-truth/v1',
    generatedAt,
    agents:agentEvidence,
    taskTypes,
    taskSummary:{ total:tasks.length, byStatus, byTaskType },
    taskEvidence,
    limitation:'这是 A君按当前注册表和脱敏任务账本生成的事实快照；未列出的文件、能力、任务类型和外部状态一律视为待验证。'
  };
  return {
    ...payload,
    snapshotId:crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  };
}

export function validateArchitectureEvidenceRefs(refs, groundTruth) {
  const allowed = new Set([
    ...(groundTruth?.agents || []).map((item) => item.ref),
    ...(groundTruth?.taskTypes || []).map((item) => item.ref),
    ...(groundTruth?.taskEvidence || []).map((item) => item.ref),
    ...(groundTruth?.agents || []).flatMap((item) => item.repositoryRefs || []).map((item) => `repo:${item}`)
  ]);
  const normalized = Array.isArray(refs) ? refs.slice(0, 30).map((item) => ({
    ref:String(item?.ref || '').trim().slice(0, 500),
    claim:String(item?.claim || '').replace(/\s+/g, ' ').trim().slice(0, 1000)
  })).filter((item) => item.ref && item.claim) : [];
  const invalidRefs = normalized.filter((item) => !allowed.has(item.ref)).map((item) => item.ref);
  return {
    valid:normalized.length > 0 && invalidRefs.length === 0,
    refs:normalized,
    invalidRefs,
    snapshotId:groundTruth?.snapshotId || null
  };
}

function strings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((item) => String(item || '').trim()).filter(Boolean))];
}

function safeTitle(value) {
  return String(value || '')
    .replace(/https?:\/\/\S+/gi, '[公开链接]')
    .replace(/\b(?:token|cookie|secret|password|authorization)=[^\s&]+/gi, '$1=[已脱敏]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function taskTime(task) {
  const value = Date.parse(task?.updatedAt || task?.createdAt || '');
  return Number.isFinite(value) ? value : 0;
}

export class LocalArchitect {
  constructor({ registry, store = null, now = () => new Date() } = {}) { this.registry = registry; this.store = store; this.now = now; }

  async execute(task) {
    const completedAt = this.now().toISOString();
    const agents = await this.registry.list();
    const tasks = this.store?.list ? await this.store.list() : [];
    const active = agents.filter((agent) => agent.status === 'active');
    const draft = agents.filter((agent) => agent.status !== 'active');
    const workEvidence = summarizeWork(tasks, agents);
    const roleOpportunities = findRoleOpportunities(workEvidence.frequentPatterns);
    const feedbackConcern = workEvidence.frequentPatterns.find((item) => item.negativeFeedback > 0);
    const intakeAdvisor = task.input?.context?.intakeAdvisor || null;
    const capabilityNextAction = nextActionForCapabilityGap(task, active, intakeAdvisor);
    const report = {
      reviewedAt: completedAt,
      request: { title: task.input.title, scopeStated: Boolean(task.input.description) },
      currentCapabilities: active.map((agent) => ({ agentId: agent.agentId, name: agent.name, taskTypes: agent.acceptedTaskTypes })),
      capabilityGaps: draft.map((agent) => ({ agentId: agent.agentId, name: agent.name, reason: '岗位尚未启用本地执行器。' })),
      ...(intakeAdvisor ? { understoodRequest:{ outcome:intakeAdvisor.understanding, deliverable:intakeAdvisor.deliverable, missing:Array.isArray(intakeAdvisor.missing) ? intakeAdvisor.missing : [] } } : {}),
      workEvidence, roleOpportunities,
      boundary: '本次只读评估岗位注册表和脱敏任务记录；没有创建岗位、连接、修改权限、调用外部账号或改变系统边界。',
      nextAction: capabilityNextAction || (feedbackConcern
        ? `优先复盘“${feedbackConcern.title}”：已经收到 ${feedbackConcern.negativeFeedback} 次需要改进的结果评价；先把现有做法改稳，不急着新建员工。`
        : roleOpportunities.length
        ? `先验证“${roleOpportunities[0].title}”是否连续出现，并为它设计一条真实验收任务；当前只形成草案建议，不自动招聘。`
        : workEvidence.frequentPatterns.length
          ? `优先加强“${workEvidence.frequentPatterns[0].ownerName || '现有岗位'}”处理反复出现工作的稳定性；暂无足够证据招聘新员工。`
          : draft.length ? `先为“${draft[0].name}”补一条可验证的本地执行路径，再评估是否需要扩展外部能力。` : '当前真实任务样本还不够；继续积累工作记录后再判断是否需要新岗位。'),
      externalActionStarted: false,
      architectureChanged: false
    };
    return {
      status: 'succeeded', currentStage: 'architecture_review_ready',
      execution: { executor: 'architect', mode: 'local_capability_review', startedAt: task.execution?.startedAt || completedAt, finishedAt: completedAt, outcome: 'reviewed' },
      artifactRefs: [{ artifactId: `architecture-review:${task.taskId}`, taskId: task.taskId, type: 'architecture_review', title: '岗位能力与边界评估', location: `runtime://${task.taskId}/architecture-review`, mimeType: 'application/json', accessScope: 'local-owner', validation: { exists: true, readable: true, nonEmpty: true }, createdAt: completedAt, data: report }]
    };
  }
}

function nextActionForCapabilityGap(task, active, advice) {
  if (task.input?.context?.autoCapabilityAssessment !== true || !advice?.deliverable) return null;
  const missing = Array.isArray(advice.missing) ? advice.missing.filter(Boolean).slice(0, 4) : [];
  const canReadPublicPages = active.some((agent) => agent.acceptedTaskTypes?.includes('report.public-material'));
  const text = `${task.input?.title || ''} ${advice.understanding || ''} ${advice.deliverable || ''}`;
  const publicResearch = /竞品|公开|网页|文章|资料|研究|对比/.test(text);
  const materialStep = missing.length ? `先补齐：${missing.join('、')}。` : '先补齐能公开读取的目标资料。';
  if (publicResearch && canReadPublicPages) return `你想要的是“${advice.deliverable}”。${materialStep} 收到公开网页链接后，可以先交给公开资料报告员逐条整理和对比；当前不新建员工、不登录、不外发。`;
  return `你想要的是“${advice.deliverable}”。${materialStep} 先用一条小范围真实任务验证现有员工能否承接；当前不新建员工、不登录、不外发。`;
}

function summarizeWork(tasks, agents) {
  const agentNames = Object.fromEntries(agents.map((agent) => [agent.agentId, agent.name]));
  const usable = tasks.filter((task) => meaningfulTitle(task.input?.title));
  const grouped = new Map();
  for (const task of usable) {
    const key = normalizeTitle(task.input?.title);
    const record = grouped.get(key) || { title:key, count:0, failures:0, needsInput:0, usefulFeedback:0, negativeFeedback:0, taskTypes:{}, assignees:{} };
    record.count += 1;
    if (task.status === 'failed') record.failures += 1;
    if (task.status === 'needs_input') record.needsInput += 1;
    if (task.feedback?.sentiment === 'useful') record.usefulFeedback += 1;
    if (task.feedback?.sentiment === 'needs_improvement') record.negativeFeedback += 1;
    record.taskTypes[task.taskType || 'unknown'] = (record.taskTypes[task.taskType || 'unknown'] || 0) + 1;
    const assignee = task.assigneeAgentId || 'unassigned';
    record.assignees[assignee] = (record.assignees[assignee] || 0) + 1;
    grouped.set(key, record);
  }
  const frequentPatterns = [...grouped.values()].filter((item) => item.count >= 2).sort((left, right) => right.count - left.count).map((item) => {
    const taskType = mostFrequent(item.taskTypes); const ownerAgentId = mostFrequent(item.assignees);
    return { title:item.title, count:item.count, failures:item.failures, needsInput:item.needsInput, usefulFeedback:item.usefulFeedback, negativeFeedback:item.negativeFeedback, taskType, ownerAgentId:ownerAgentId === 'unassigned' ? null : ownerAgentId, ownerName:ownerAgentId === 'unassigned' ? null : agentNames[ownerAgentId] || ownerAgentId };
  });
  const byStatus = {};
  for (const task of tasks) byStatus[task.status || 'unknown'] = (byStatus[task.status || 'unknown'] || 0) + 1;
  return { totalTasks:tasks.length, byStatus, frequentPatterns };
}

function findRoleOpportunities(patterns) {
  return patterns.filter((item) => item.count >= 3 && !item.ownerAgentId).map((item) => ({
    kind:'new_role_draft', title:`反复处理“${item.title}”的专员`, evidenceCount:item.count,
    reason:`该类工作已出现 ${item.count} 次，且没有明确承接员工。`,
    acceptanceTask:`用一条新的“${item.title}”请求验证能否独立完成并留下可检查结果。`,
    status:'draft_only'
  }));
}

function meaningfulTitle(value) {
  const title = normalizeTitle(value);
  return title.length >= 4 && !/^(需要|继续|可以|好的|任务进度如何|进度如何|检查系统状态)$/.test(title);
}
function normalizeTitle(value) { return String(value || '').replace(/https?:\/\/\S+/gi, '').replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '').replace(/\s+/g, ' ').trim().slice(0, 60); }
function mostFrequent(values) { return Object.entries(values).sort((left, right) => right[1] - left[1])[0]?.[0] || null; }

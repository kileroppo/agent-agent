import { buildArchitectureGroundTruth, validateArchitectureEvidenceRefs } from './architecture-evidence.js';

export class LocalArchitect {
  constructor({ registry, store = null, now = () => new Date() } = {}) { this.registry = registry; this.store = store; this.now = now; }

  async execute(task) {
    const completedAt = this.now().toISOString();
    const agents = await this.registry.list();
    const tasks = this.store?.list ? await this.store.list() : [];
    const active = agents.filter((agent) => agent.status === 'active');
    const draft = agents.filter((agent) => agent.status !== 'active');
    const groundTruth = buildArchitectureGroundTruth({ agents, tasks, generatedAt:completedAt });
    const workEvidence = summarizeWork(tasks, agents);
    const systemEvidence = summarizeSystemEvidence(tasks, groundTruth);
    const roleOpportunities = findRoleOpportunities(workEvidence.frequentPatterns);
    const feedbackConcern = workEvidence.frequentPatterns.find((item) => item.negativeFeedback > 0);
    const intakeAdvisor = task.input?.context?.intakeAdvisor || null;
    const capabilityNextAction = nextActionForCapabilityGap(task, active, intakeAdvisor);
    const legalTaskRefs = new Set(groundTruth.taskEvidence.map((item) => item.ref));
    const evidenceRefs = [
      ...groundTruth.agents.filter((agent) => active.some((item) => item.agentId === agent.agentId)).slice(0, 12).map((agent) => ({
        ref:agent.ref,
        claim:`岗位“${agent.name}”当前登记任务类型：${agent.acceptedTaskTypes.join('、') || '无'}。`
      })),
      ...workEvidence.frequentPatterns.flatMap((item) => (item.sampleTaskIds || []).slice(0, 2).map((taskId) => ({
        ref:`task:${taskId}`,
        claim:`“${item.title}”重复模式的任务样本。`
      })).filter((item) => legalTaskRefs.has(item.ref))),
      ...systemEvidence.evidenceRefs
    ].slice(0, 30);
    const evidenceValidation = validateArchitectureEvidenceRefs(evidenceRefs, groundTruth);
    const factClaims = evidenceRefs.map((item) => ({ claim:item.claim, evidenceRefs:[item.ref] }));
    const architectureJudgments = workEvidence.frequentPatterns.slice(0, 5).map((item) => ({
      judgment:item.ownerAgentId
        ? `“${item.title}”应优先优化现有岗位“${item.ownerName || item.ownerAgentId}”，而不是立即新增岗位。`
        : `“${item.title}”可能形成独立能力，但当前仍需验证能否稳定复用。`,
      basisRefs:(item.sampleTaskIds || []).slice(0, 3).map((taskId) => `task:${taskId}`),
      assumptions:['重复任务标题代表相近业务目标，后续仍需抽查真实输入和产物质量。'],
      confidence:item.count >= 3 ? 'medium' : 'low'
    }));
    const candidateProposals = roleOpportunities.slice(0, 5).map((item) => ({
      proposal:item.title,
      problem:item.reason,
      validationPlan:item.acceptanceTask,
      risks:['样本可能只是短期重复，过早独立成岗会增加维护成本。'],
      nonGoals:['不在本次评估中创建岗位、扩权或上线。']
    }));
    const candidateExperiments = buildCandidateExperiments(systemEvidence);
    for (const experiment of candidateExperiments) {
      architectureJudgments.push({
        judgment:experiment.hypothesis,
        basisRefs:experiment.evidenceRefs,
        assumptions:experiment.assumptions,
        confidence:experiment.confidence
      });
      candidateProposals.push({
        proposal:experiment.title,
        problem:experiment.problem,
        validationPlan:experiment.isolatedPlan,
        successMeasures:experiment.successMeasures,
        rollback:experiment.rollback,
        evidenceRefs:experiment.evidenceRefs,
        risks:['隔离样本可能不足以代表长期运行，实验结果不能直接授权生产变更。'],
        nonGoals:['不在架构评估中直接改代码、配置、权限或外部系统。']
      });
    }
    const report = {
      reviewedAt: completedAt,
      request: { title: task.input.title, scopeStated: Boolean(task.input.description) },
      currentCapabilities: active.map((agent) => ({ agentId: agent.agentId, name: agent.name, taskTypes: agent.acceptedTaskTypes })),
      capabilityGaps: draft.map((agent) => ({ agentId: agent.agentId, name: agent.name, reason: '岗位尚未启用本地执行器。' })),
      ...(intakeAdvisor ? { understoodRequest:{ outcome:intakeAdvisor.understanding, deliverable:intakeAdvisor.deliverable, missing:Array.isArray(intakeAdvisor.missing) ? intakeAdvisor.missing : [] } } : {}),
      workEvidence, systemEvidence, roleOpportunities,
      groundTruth:{
        snapshotId:groundTruth.snapshotId,
        generatedAt:groundTruth.generatedAt,
        agentCount:groundTruth.agents.length,
        taskCount:groundTruth.taskSummary.total,
        evidenceRefsValid:evidenceValidation.valid
      },
      evidenceRefs:evidenceValidation.refs,
      evidenceValidation,
      factClaims,
      architectureJudgments,
      candidateProposals,
      currentStateUnknowns:[
        ...(systemEvidence.artifacts.unverifiable > 0 ? [`${systemEvidence.artifacts.unverifiable} 个产物缺少完整 validation，质量状态待验证。`] : []),
        ...(systemEvidence.usage.tasksWithoutUsage > 0 ? [`${systemEvidence.usage.tasksWithoutUsage} 个任务没有 usage 记录，成本汇总不完整。`] : []),
        ...(roleOpportunities.length ? ['新岗位机会仍需新的真实验收任务证明可独立交付。'] : []),
        ...(intakeAdvisor ? ['用户补充材料后的可执行性尚未验证。'] : [])
      ],
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
    const record = grouped.get(key) || { title:key, count:0, failures:0, needsInput:0, usefulFeedback:0, negativeFeedback:0, taskTypes:{}, assignees:{}, taskIds:[] };
    record.count += 1;
    record.taskIds.push(task.taskId);
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
    return { title:item.title, count:item.count, failures:item.failures, needsInput:item.needsInput, usefulFeedback:item.usefulFeedback, negativeFeedback:item.negativeFeedback, taskType, ownerAgentId:ownerAgentId === 'unassigned' ? null : ownerAgentId, ownerName:ownerAgentId === 'unassigned' ? null : agentNames[ownerAgentId] || ownerAgentId, sampleTaskIds:item.taskIds.slice(-3) };
  });
  const byStatus = {};
  for (const task of tasks) byStatus[task.status || 'unknown'] = (byStatus[task.status || 'unknown'] || 0) + 1;
  return { totalTasks:tasks.length, byStatus, frequentPatterns };
}

function summarizeSystemEvidence(tasks, groundTruth) {
  const legalTaskIds = new Set((groundTruth.taskEvidence || []).map((item) => item.taskId));
  const related = { edges:[], roots:0, childTasks:0, recoveryTasks:0 };
  const failures = { total:0, byCategory:{}, byCode:{}, sampleTaskIds:[] };
  const usage = { modelCalls:0, toolCalls:0, costByCurrency:{}, tasksWithUsage:0, tasksWithoutUsage:0 };
  const artifacts = { total:0, validated:0, invalid:0, unverifiable:0, byType:{} };
  const feedback = { useful:0, needsImprovement:0, other:0, sampleTaskIds:[] };
  const evidenceRefs = [];
  for (const task of tasks) {
    const taskId = String(task?.taskId || '');
    if (task.parentTaskId) {
      related.childTasks += 1;
      related.edges.push({ fromTaskId:String(task.parentTaskId), toTaskId:taskId, relation:'parent_child' });
    } else related.roots += 1;
    if (task.recovery?.rootTaskId) {
      related.recoveryTasks += 1;
      related.edges.push({ fromTaskId:String(task.recovery.rootTaskId), toTaskId:taskId, relation:'recovery_attempt' });
    }

    const failure = task.input?.context?.failure || task.failure || {};
    const classification = task.input?.context?.failureClassification || task.execution?.failureClassification || {};
    if (task.status === 'failed' || failure.code || classification.failureClass) {
      const category = String(classification.failureClass || failure.category || 'unknown');
      const code = String(failure.code || task.execution?.errorCode || 'unknown_failure');
      failures.total += 1;
      failures.byCategory[category] = (failures.byCategory[category] || 0) + 1;
      failures.byCode[code] = (failures.byCode[code] || 0) + 1;
      failures.sampleTaskIds.push(taskId);
    }

    if (task.usage) {
      usage.tasksWithUsage += 1;
      usage.modelCalls += Number(task.usage.model?.apiCalls || 0);
      usage.toolCalls += array(task.usage.tools).reduce((total, item) => total + Number(item?.calls || 0), 0);
      const amount = Number(task.usage.model?.cost?.amount || 0);
      const currency = String(task.usage.model?.cost?.currency || 'unknown');
      if (Number.isFinite(amount)) usage.costByCurrency[currency] = round((usage.costByCurrency[currency] || 0) + amount);
    } else usage.tasksWithoutUsage += 1;

    for (const artifact of array(task.artifactRefs)) {
      artifacts.total += 1;
      const type = String(artifact?.type || 'unknown');
      artifacts.byType[type] = (artifacts.byType[type] || 0) + 1;
      const validation = artifact?.validation;
      if (!validation || !['exists', 'readable', 'nonEmpty'].every((key) => typeof validation[key] === 'boolean')) artifacts.unverifiable += 1;
      else if (validation.exists && validation.readable && validation.nonEmpty) artifacts.validated += 1;
      else artifacts.invalid += 1;
    }

    if (task.feedback?.sentiment === 'useful') {
      feedback.useful += 1;
      feedback.sampleTaskIds.push(taskId);
    } else if (task.feedback?.sentiment === 'needs_improvement') {
      feedback.needsImprovement += 1;
      feedback.sampleTaskIds.push(taskId);
    } else if (task.feedback) feedback.other += 1;
  }
  related.edges = related.edges.slice(-30);
  failures.sampleTaskIds = [...new Set(failures.sampleTaskIds)].slice(-10);
  feedback.sampleTaskIds = [...new Set(feedback.sampleTaskIds)].slice(-10);
  const evidenceCandidates = [
    ...failures.sampleTaskIds.map((taskId) => ({ ref:`task:${taskId}`, claim:'该任务为失败分类汇总提供样本。' })),
    ...feedback.sampleTaskIds.map((taskId) => ({ ref:`task:${taskId}`, claim:'该任务包含结果反馈样本。' })),
    ...tasks.filter((task) => task.usage || array(task.artifactRefs).length).slice(-8).map((task) => ({ ref:`task:${task.taskId}`, claim:'该任务为 usage、成本或产物验证汇总提供样本。' }))
  ];
  for (const item of evidenceCandidates) {
    if (!legalTaskIds.has(item.ref.slice(5))) continue;
    const existing = evidenceRefs.find((candidate) => candidate.ref === item.ref);
    if (existing && !existing.claim.includes(item.claim)) existing.claim = `${existing.claim} ${item.claim}`;
    else if (!existing) evidenceRefs.push(item);
  }
  return { relations:related, failures, usage, artifacts, feedback, evidenceRefs:evidenceRefs.slice(0, 12) };
}

function buildCandidateExperiments(evidence) {
  const experiments = [];
  const failureCategory = Object.entries(evidence.failures.byCategory).sort((left, right) => right[1] - left[1])[0];
  if (failureCategory?.[1] > 0) {
    experiments.push({
      title:`隔离验证主要失败类别：${failureCategory[0]}`,
      problem:`${failureCategory[1]} 个失败样本被归为 ${failureCategory[0]}。`,
      hypothesis:`主要失败类别“${failureCategory[0]}”可通过不触发外部副作用的隔离夹具稳定复现。`,
      isolatedPlan:'选取一个已脱敏失败样本，在隔离 TaskStore 和模拟依赖中重放；只记录复现条件和观测，不修改正式运行配置。',
      successMeasures:['相同输入连续两次得到相同失败分类', '复现过程外部副作用为 0'],
      rollback:'删除隔离夹具产生的临时状态；正式任务和配置保持不变。',
      evidenceRefs:evidence.evidenceRefs.filter((item) => item.claim.includes('失败')).slice(0, 3).map((item) => item.ref),
      assumptions:['现有失败分类字段足以代表故障主因。'],
      confidence:failureCategory[1] >= 3 ? 'medium' : 'low'
    });
  }
  if (evidence.artifacts.invalid > 0 || evidence.artifacts.unverifiable > 0) {
    experiments.push({
      title:'产物验证门禁对照实验',
      problem:`当前有 ${evidence.artifacts.invalid} 个无效产物、${evidence.artifacts.unverifiable} 个未完整验证产物。`,
      hypothesis:'在隔离任务中强制 validation 门禁可阻止未验证产物被标记为完整成功。',
      isolatedPlan:'复制一条脱敏任务为两个隔离分支：一支保留当前门禁，一支补齐验证；比较最终状态和可见结果。',
      successMeasures:['缺少验证的分支不能进入完整成功', '补齐验证的分支保留可检查证据'],
      rollback:'丢弃两个隔离任务，不改历史任务状态。',
      evidenceRefs:evidence.evidenceRefs.filter((item) => item.claim.includes('产物')).slice(0, 3).map((item) => item.ref),
      assumptions:['产物 validation 字段由受信执行器写入。'],
      confidence:'medium'
    });
  }
  return experiments.filter((item) => item.evidenceRefs.length > 0).slice(0, 3);
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
function array(value) { return Array.isArray(value) ? value : []; }
function round(value) { return Math.round(value * 1_000_000) / 1_000_000; }

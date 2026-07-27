import { canonicalizeBusinessAssignment } from './business-task-routing.js';

export class CrossAgentMissionService {
  constructor({ tasks, store, governance } = {}) { this.tasks = tasks; this.store = store; this.governance = governance; }

  async create({ title, requester, source, idempotencyKey }) {
    return this.createMission({ title, requester, source, idempotencyKey });
  }

  async createBusinessMission({ title, items, requester, source, idempotencyKey }) {
    const normalized = normalizeBusinessItems(items);
    const missionTitle = clean(title, 500);
    if (!missionTitle) throw new Error('请说明这组工作的总目标。');
    if (!normalized.length) throw new Error('请提供 1 到 3 项可执行的员工分工。');
    const description = normalized.map((item, index) => `${index + 1}. ${item.title}${item.description ? `：${item.description}` : ''}`).join('\n');
    return this.createMission({
      title:missionTitle,
      description,
      requester,
      source,
      idempotencyKey,
      context:{
        businessMissionItems:normalized,
        businessMissionSummary:missionTitle,
        missionSafeOnly:!containsHighRisk(`${missionTitle}\n${description}`)
      }
    });
  }

  async createMission({ title, description = '', requester, source, idempotencyKey, context } = {}) {
    let mission = await this.tasks.create({
      title,
      description,
      taskType:'army.cross-agent-mission',
      agentId:'task-coordinator',
      requester,
      source,
      idempotencyKey,
      context
    });
    if (mission.status === 'waiting_approval') {
      const approvalId = mission.approvalRefs?.[0];
      const approval = approvalId ? (await this.store.listApprovals()).find((item) => item.approvalId === approvalId && item.status === 'pending') : null;
      return {
        mission, children:[],
        reply:'这项多人工作包含公开发布、费用、权限或其他需要确认的组织级动作。我已经把它交给 Paperclip 等待你确认；在你同意前，不会安排员工开始，也不会执行目标动作。',
        ...(approval ? { approval:{ approvalId:approval.approvalId, governanceMode:approval.governanceMode, action:approval.action, riskLevel:approval.riskLevel, reason:approval.reason, requestedScope:approval.requestedScope, validUntil:approval.validUntil } } : {})
      };
    }
    return this.dispatch(mission);
  }

  async dispatch(missionOrId) {
    let mission = typeof missionOrId === 'string' ? (await this.store.list()).find((item) => item.taskId === missionOrId) : missionOrId;
    if (!mission) throw new Error('找不到要继续的多人协作任务。');
    const existing = mission.artifactRefs?.find((item) => item.type === 'cross_agent_mission_summary');
    if (mission.status === 'succeeded' || existing?.data?.completed === true) return { mission, children:[], reply:'这项多人工作已经完成汇总，不会重复安排员工。' };
    const plan = mission.artifactRefs?.find((item) => item.type === 'cross_agent_mission_plan')?.data;
    if (!plan) throw new Error('多人协作计划未生成，未创建分工。');
    const parentIssueId = mission.governance?.paperclipIssueId || null;
    const existingChildren = this.store?.list ? (await this.store.list()).filter((task) => task.parentTaskId === mission.taskId) : [];
    const children = [];
    const runSubtask = async (subtask) => {
      const idempotencyKey = `${mission.idempotencyKey || `mission:${mission.taskId}`}:${subtask.key}`;
      let child = existingChildren.find((task) => task.idempotencyKey === idempotencyKey) || null;
      if (!child) child = await this.tasks.create({
        title:subtask.title,
        description:[subtask.description, `来自多人协作分工。验收：${subtask.acceptance}`].filter(Boolean).join('\n'),
        taskType:subtask.taskType,
        agentId:subtask.agentId,
        sourceUrls:subtask.sourceUrls,
        requester:mission.requester,
        source:{ ...(mission.source || {}), channel:'army-mission', missionTaskId:mission.taskId },
        parentTaskId:mission.taskId,
        idempotencyKey,
        context:{ missionTaskId:mission.taskId, parentPaperclipIssueId:parentIssueId, missionSafeOnly:plan.safeOnly === true }
      });
      if (child.status === 'waiting_approval'
        && (plan.kind !== 'business' || (plan.safeOnly === true && mission.approvalRefs?.length))
        && typeof this.tasks.resumeApprovedMissionChild === 'function') {
        child = await this.tasks.resumeApprovedMissionChild(child.taskId);
      }
      return child;
    };
    let parallel = [];
    for (const subtask of plan.subtasks) {
      if (subtask.dependsOnPrevious === true) {
        if (parallel.length) {
          children.push(...await Promise.all(parallel));
          parallel = [];
        }
        if (children.some((item) => !isTerminal(item.status))) break;
        children.push(await runSubtask(subtask));
      } else {
        parallel.push(runSubtask(subtask));
      }
    }
    if (parallel.length) children.push(...await Promise.all(parallel));
    const state = missionState(children, plan.subtasks.length);
    const artifact = missionSummary(mission, plan, children, state);
    mission = await this.store.updateTask(mission.taskId, {
      status:state.status,
      currentStage:state.stage,
      artifactRefs:[...(mission.artifactRefs || []).filter((item) => item.type !== 'cross_agent_mission_summary'), artifact]
    });
    if (mission.governance?.paperclipIssueId) mission = await this.store.updateTask(mission.taskId, { governance:await this.governance.update(mission) });
    return { mission, children, reply:replyFor(mission, plan, children, state) };
  }
}

function missionSummary(mission, plan, children, state) {
  const at = new Date().toISOString();
  const statuses = plan.subtasks.map((subtask) => {
    const child = children.find((item) => item.idempotencyKey === `${mission.idempotencyKey || `mission:${mission.taskId}`}:${subtask.key}`)
      || children.find((item) => item.assigneeAgentId === subtask.agentId && item.taskType === subtask.taskType);
    return {
      key:subtask.key,
      title:subtask.title,
      employeeId:subtask.agentId,
      taskId:child?.taskId || null,
      status:child?.status || 'planned',
      artifactTypes:(child?.artifactRefs || []).filter(isVerifiedArtifact).map((item) => item.type)
    };
  });
  return {
    artifactId:`mission-summary:${mission.taskId}`,
    taskId:mission.taskId,
    type:'cross_agent_mission_summary',
    title:plan.kind === 'business' ? '老板任务协作汇总' : '多人协作汇总',
    location:`runtime://${mission.taskId}/mission-summary`,
    mimeType:'application/json',
    accessScope:'local-owner',
    validation:{
      exists:true,
      readable:true,
      nonEmpty:true,
      allSubtasksCompleted:state.allDone,
      allSubtasksTerminal:state.allTerminal
    },
    createdAt:at,
    data:{
      kind:plan.kind || 'army-review',
      summary:plan.summary,
      childTaskIds:children.map((item) => item.taskId),
      completed:state.allDone,
      terminal:state.allTerminal,
      employeeIds:plan.subtasks.map((item) => item.agentId),
      statuses,
      decision:plan.kind === 'business' ? businessDecision(statuses, children, state) : decisionFor(children, state.allDone)
    }
  };
}

function replyFor(mission, plan, children, state) {
  const names = { operator:'运维官', architect:'架构师', xiaod:'小D', 'intel-researcher':'小R', 'office-assistant':'办公执行助理' };
  const work = plan.subtasks.map((item) => names[item.agentId] || item.agentId).join('、');
  if (plan.kind === 'business') {
    const summary = mission.artifactRefs?.find((item) => item.type === 'cross_agent_mission_summary')?.data;
    if (!state.allTerminal) return `总任务已建立，已安排${work}处理。我会以这一个总任务持续跟进，不让你分别追问每个人。`;
    const done = summary?.statuses?.filter((item) => item.status === 'succeeded').length || 0;
    const open = summary?.statuses?.filter((item) => item.status !== 'succeeded') || [];
    if (!open.length) return `${plan.summary}已完成：${work}的 ${done} 项分工均已交付并进入统一汇总。`;
    return `${plan.summary}已完成阶段汇总：${done} 项已交付；${open.map((item) => `${names[item.employeeId] || item.employeeId}为${statusLabel(item.status)}`).join('，')}。未完成部分没有被冒充为成功。`;
  }
  if (!state.allDone) return `已安排${work}协同处理这次军团盘点。我会在结论出来后直接告诉你现在的情况和下一步。`;
  const decision = mission.artifactRefs?.find((item) => item.type === 'cross_agent_mission_summary')?.data?.decision;
  if (!decision) return `已安排${work}完成这次军团盘点。结论已保存；没有触发登录、外发、付费或扩权。`;
  const owner = decision.ownerAction ? `现在需要你处理的是：${decision.ownerAction}` : '现在没有必须由你决定的事情。';
  return `盘点完成：${decision.health}。下一步建议：${decision.nextAction}。${owner}`;
}

function decisionFor(children, allDone) {
  const health = children.find((item) => item.taskType === 'operations.health-review')?.artifactRefs?.find((item) => item.type === 'health_report')?.data;
  const architecture = children.find((item) => item.taskType === 'governance.architecture-review')?.artifactRefs?.find((item) => item.type === 'architecture_review')?.data;
  const unhealthy = (health?.components || []).filter((item) => item.status !== 'healthy').map((item) => item.name || '一项本机组件');
  const healthText = !health ? '本机检查结果还在整理' : health.overall === 'healthy' ? '本机运行正常' : `发现需要检查的部分：${unhealthy.length ? unhealthy.join('、') : '本机组件'}`;
  const nextAction = String(architecture?.nextAction || (allDone ? '继续按真实工作积累记录；有新的卡点我会主动说明。' : '等待员工完成当前分工。')).replace(/。$/, '');
  const ownerAction = health?.overall === 'healthy' ? null : '请在方便时查看本机运行状态；我不会自行重置、登录或扩大权限';
  return { health:healthText, nextAction, ownerAction };
}

function normalizeBusinessItems(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 3) return [];
  const seen = new Set();
  const normalized = items.map((item, index) => {
    const title = clean(item?.title, 500);
    const taskType = clean(item?.taskType, 120);
    const agentId = clean(item?.agentId, 80);
    if (!title || !taskType || !agentId) return null;
    let key = clean(item?.key, 80) || `work-${index + 1}`;
    while (seen.has(key)) key = `${key}-${index + 1}`;
    seen.add(key);
    return canonicalizeBusinessAssignment({
      key,
      title,
      taskType,
      agentId,
      description:clean(item?.description, 2000),
      acceptance:clean(item?.acceptance, 500) || '交付可验证结果；无法完成时明确说明卡点和下一步。',
      sourceUrls:Array.isArray(item?.sourceUrls) ? [...new Set(item.sourceUrls.map((url) => clean(url, 2000)).filter(Boolean))].slice(0, 5) : [],
      dependsOnPrevious:item?.dependsOnPrevious === true || agentId === 'office-assistant'
    }, { index });
  }).filter(Boolean);
  return normalized.length === items.length ? normalized : [];
}

function missionState(children, plannedCount) {
  const allCreated = children.length === plannedCount;
  const allDone = allCreated && children.every((item) => item.status === 'succeeded');
  const allTerminal = allCreated && children.every((item) => isTerminal(item.status));
  if (allDone) return { status:'succeeded', stage:'mission_delivered', allDone, allTerminal:true };
  if (!allTerminal) {
    const waitingApproval = children.some((item) => item.status === 'waiting_approval');
    const waitingWorker = children.some((item) => item.status === 'waiting_worker');
    return { status:'running', stage:waitingApproval ? 'mission_waiting_child_approval' : waitingWorker ? 'mission_waiting_mac_worker' : 'mission_in_progress', allDone:false, allTerminal:false };
  }
  if (children.some((item) => item.status === 'failed')) return { status:'failed', stage:'mission_partially_failed', allDone:false, allTerminal:true };
  if (children.some((item) => item.status === 'needs_input')) return { status:'needs_input', stage:'mission_needs_input', allDone:false, allTerminal:true };
  if (children.some((item) => item.status === 'cancelled')) return { status:'cancelled', stage:'mission_cancelled', allDone:false, allTerminal:true };
  if (children.some((item) => item.status === 'waiting_test')) return { status:'waiting_test', stage:'mission_waiting_test', allDone:false, allTerminal:true };
  return { status:'running', stage:'mission_in_progress', allDone:false, allTerminal:false };
}

function businessDecision(statuses, children, state) {
  const office = children.find((item) => item.assigneeAgentId === 'office-assistant')
    ?.artifactRefs?.find((item) => item.type === 'office_briefing_package' && isVerifiedArtifact(item))?.data;
  const open = statuses.filter((item) => item.status !== 'succeeded');
  return {
    outcome:state.allDone ? 'completed' : state.allTerminal ? 'partially_completed' : 'in_progress',
    completedCount:statuses.length - open.length,
    totalCount:statuses.length,
    openItems:open.map((item) => ({ employeeId:item.employeeId, title:item.title, status:item.status })),
    briefing:office ? {
      title:clean(office.title, 500),
      summary:clean(office.summary, 1000),
      openItems:Array.isArray(office.openItems) ? office.openItems.map((item) => clean(item, 500)).filter(Boolean).slice(0, 5) : [],
      nextAction:clean(office.nextAction, 500)
    } : null
  };
}

function isTerminal(status) {
  return ['succeeded', 'failed', 'cancelled', 'needs_input', 'waiting_test', 'paused'].includes(status);
}

function isVerifiedArtifact(artifact) {
  return artifact?.validation?.exists === true && artifact?.validation?.nonEmpty === true;
}

function containsHighRisk(value) {
  return /外发|发布|删除|付款|付费|扩权|敏感|账号|登录|连接|预算|暂停|终止/i.test(String(value || ''));
}

function statusLabel(status) {
  return ({ succeeded:'已完成', failed:'失败', needs_input:'等待补充信息', cancelled:'已取消', waiting_test:'等待验证', waiting_approval:'等待批准', waiting_worker:'等待 Mac工作间上线', running:'处理中', queued:'排队中', planned:'待开始' })[status] || status;
}

function clean(value, limit) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

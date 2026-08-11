import { canonicalizeBusinessAssignment } from './business-task-routing.ts';
import { normalizedProductMaturityContext } from './workflow/mission-child-policy.ts';
import {
  isExactLegacyMaturityContentBlock,
  isExactPlannedMaturityMissionRetry,
  isExactQueuedMaturityContentRetry,
  isExactQueuedMaturityMissionRetry,
  isExactRunningMaturityMissionRetry,
  isExactWaitingMaturityMissionRetry,
} from './maturity-legacy-content-retry.ts';

export class CrossAgentMissionService {
  constructor({ tasks, store, governance, missionChildPolicy = null } = {}) { this.tasks = tasks; this.store = store; this.governance = governance; this.missionChildPolicy = missionChildPolicy; }

  async create({ title, requester, source, idempotencyKey }) {
    return this.createMission({ title, requester, source, idempotencyKey });
  }

  async createBusinessMission({ title, items, requester, source, idempotencyKey, productMaturityBatchId = null }) {
    const normalized = normalizeBusinessItems(items);
    const missionTitle = clean(title, 500);
    if (!missionTitle) throw new Error('请说明这组工作的总目标。');
    if (!normalized.length) throw new Error('请提供 1 到 11 项可执行的员工分工；每个依赖必须引用同一总任务中的分工 key，且不能形成循环。');
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
        missionSafeOnly:!containsHighRisk(`${missionTitle}\n${description}`),
        ...(productMaturityBatchId ? { productMaturityBatchId:String(productMaturityBatchId) } : {})
      }
    });
  }

  async createMission({ title, description = '', requester, source, idempotencyKey, context } = {}) {
    let mission = await this.tasks.create({
      title,
      description,
      taskType:'army.cross-agent-mission',
      agentId:'ajun',
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
    const plan = mission.artifactRefs?.find((item) => item.type === 'cross_agent_mission_plan')?.data;
    if (!plan) {
      return {
        mission,
        children:[],
        reply:'总任务已经登记；受控执行器生成计划后会自动分派员工并继续跟进。',
      };
    }
    return this.dispatch(mission);
  }

  async dispatch(missionOrId) {
    let mission = typeof missionOrId === 'string'
      ? (await this.store.list()).find((item) => item.taskId === missionOrId)
      : missionOrId;
    if (mission?.input?.context?.productMaturityBatchId && typeof this.store?.list === 'function') {
      mission = (await this.store.list()).find((item) => item.taskId === mission.taskId) || mission;
    }
    if (!mission) throw new Error('找不到要继续的多人协作任务。');
    const existing = mission.artifactRefs?.find((item) => item.type === 'cross_agent_mission_summary');
    if (mission.status === 'succeeded' || existing?.data?.completed === true) return { mission, children:[], reply:'这项多人工作已经完成汇总，不会重复安排员工。' };
    const plan = mission.artifactRefs?.find((item) => item.type === 'cross_agent_mission_plan')?.data;
    if (!plan) throw new Error('多人协作计划未生成，未创建分工。');
    const parentIssueId = mission.governance?.paperclipIssueId || null;
    const existingChildren = this.store?.list ? (await this.store.list()).filter((task) => task.parentTaskId === mission.taskId) : [];
    const childByKey = new Map();
    for (const subtask of plan.subtasks) {
      const idempotencyKey = `${mission.idempotencyKey || `mission:${mission.taskId}`}:${subtask.key}`;
      const matches = existingChildren.filter((item) => item.idempotencyKey === idempotencyKey);
      if (mission?.input?.context?.productMaturityBatchId && matches.length > 1) {
        throw new Error('产品成熟度固定分工出现重复幂等任务，已停止恢复。');
      }
      const child = matches[0];
      if (child) childByKey.set(subtask.key, child);
    }
    await this.resumeQueuedMaturityChildren({ mission, plan, childByKey });
    const attemptedApprovalResume = new Set();
    const runSubtask = async (subtask) => {
      this.missionChildPolicy?.assertAuthorized({ mission, subtask });
      const idempotencyKey = `${mission.idempotencyKey || `mission:${mission.taskId}`}:${subtask.key}`;
      const dependencyKeys = dependenciesFor(plan.subtasks, subtask);
      const fixedSourceTaskIds = [...new Set(Array.isArray(subtask.context?.sourceTaskIds)
        ? subtask.context.sourceTaskIds.map((taskId) => clean(taskId, 200)).filter(Boolean)
        : [])];
      const dependencyTaskIds = [...new Set(dependencyKeys
        .map((key) => childByKey.get(key)?.taskId)
        .filter(Boolean))];
      const signedMaturityItem = subtask.context?.productMaturityAuthorization?.kind === 'product-maturity-validation';
      const sourceTaskIds = signedMaturityItem
        ? fixedSourceTaskIds
        : fixedSourceTaskIds.length ? fixedSourceTaskIds : dependencyTaskIds;
      let child = existingChildren.find((task) => task.idempotencyKey === idempotencyKey) || null;
      if (!child) child = await this.tasks.create({
        title:subtask.title,
        description:[subtask.description, `来自多人协作分工。验收：${subtask.acceptance}`].filter(Boolean).join('\n'),
        taskType:subtask.taskType,
        agentId:subtask.agentId,
        sourceUrls:subtask.sourceUrls,
        connectionId:subtask.connectionId,
        reviewPolicy:subtask.reviewPolicy,
        evidenceMode:subtask.evidenceMode,
        analysisIntent:subtask.analysisIntent,
        depth:subtask.depth,
        visualMode:subtask.visualMode,
        focus:subtask.focus,
        platforms:subtask.platforms,
        contentGoal:subtask.contentGoal,
        researchMode:subtask.researchMode,
        approvedForUse:subtask.approvedForUse,
        requester:mission.requester,
        source:{
          ...(mission.source || {}),
          originChannel:mission.source?.originChannel || mission.source?.channel || null,
          channel:'army-mission',
          missionTaskId:mission.taskId
        },
        parentTaskId:mission.taskId,
        workflowId:mission.workflow?.workflowId,
        workflowType:mission.workflow?.workflowType,
        stepKey:subtask.key,
        workflowStepRequired:subtask.required !== false,
        idempotencyKey,
        context:{
          ...(subtask.context || {}),
          missionTaskId:mission.taskId,
          parentPaperclipIssueId:parentIssueId,
          missionSafeOnly:plan.safeOnly === true,
          dependsOn:dependencyKeys,
          dependsOnPrevious:dependencyKeys.length > 0,
          ...(dependencyTaskIds.length ? { dependencyTaskIds } : {}),
          ...(sourceTaskIds.length ? { sourceTaskIds } : {}),
        }
      });
      if (child.status === 'waiting_approval'
        && (plan.kind !== 'business' || (plan.safeOnly === true && mission.approvalRefs?.length))
        && typeof this.tasks.resumeApprovedMissionChild === 'function') {
        child = await this.tasks.resumeApprovedMissionChild(child.taskId);
      }
      return child;
    };
    while (true) {
      const activeCount = [...childByKey.values()].filter((item) => isActivelyRunning(item.status)).length;
      const availableSlots = Math.max(0, 4 - activeCount);
      if (!availableSlots) break;
      const ready = plan.subtasks.filter((subtask) => {
        const child = childByKey.get(subtask.key);
        if (child && (child.status !== 'waiting_approval' || attemptedApprovalResume.has(subtask.key))) return false;
        return dependenciesFor(plan.subtasks, subtask).every((key) => {
          const dependency = childByKey.get(key);
          return dependency && dependencySatisfied(mission, dependency.status);
        });
      });
      if (!ready.length) break;
      const batch = ready.slice(0, availableSlots);
      batch.forEach((subtask) => {
        if (childByKey.get(subtask.key)?.status === 'waiting_approval') attemptedApprovalResume.add(subtask.key);
      });
      const created = await Promise.all(batch.map(runSubtask));
      batch.forEach((subtask, index) => childByKey.set(subtask.key, created[index]));
    }
    const children = [...childByKey.values()];
    const state = missionState(children, plan.subtasks.length);
    const artifact = missionSummary(mission, plan, children, state);
    const maturityMission = Boolean(mission?.input?.context?.productMaturityBatchId);
    if (maturityMission && mission.status === 'waiting_test' && state.status !== 'succeeded') {
      return { mission, children, reply:replyFor(mission, plan, children, state) };
    }
    if (maturityMission
      && state.status === 'succeeded'
      && (isExactWaitingMaturityMissionRetry(mission) || isExactQueuedMaturityMissionRetry(mission))) {
      if (typeof this.tasks?.resumeVerifiedMaturityMission !== 'function') {
        throw new Error('产品成熟度总任务缺少受控重汇总接缝，已停止。');
      }
      mission = await this.tasks.resumeVerifiedMaturityMission(mission.taskId);
    }
    if (maturityMission && state.status === 'succeeded' && mission.attempt === 2) {
      if (mission.status === 'succeeded') return { mission, children, reply:replyFor(mission, plan, children, state) };
      if (isExactQueuedMaturityMissionRetry(mission)
        || (isExactRunningMaturityMissionRetry(mission) && !isExactPlannedMaturityMissionRetry(mission))) {
        return { mission, children, reply:replyFor(mission, plan, children, state) };
      }
      if (!isExactPlannedMaturityMissionRetry(mission)) {
        throw new Error('产品成熟度总任务没有通过同任务本地计划重试，已停止汇总。');
      }
      const latestMission = (await this.store.list()).find((item) => item.taskId === mission.taskId);
      if (latestMission?.status === 'succeeded') {
        return { mission:latestMission, children, reply:replyFor(latestMission, plan, children, state) };
      }
      if (isExactQueuedMaturityMissionRetry(latestMission)
        || (isExactRunningMaturityMissionRetry(latestMission) && !isExactPlannedMaturityMissionRetry(latestMission))) {
        return { mission:latestMission, children, reply:replyFor(latestMission, plan, children, state) };
      }
      mission = latestMission || mission;
    }
    mission = await this.store.updateTask(mission.taskId, {
      status:state.status,
      currentStage:state.stage,
      artifactRefs:[...(mission.artifactRefs || []).filter((item) => item.type !== 'cross_agent_mission_summary'), artifact]
    });
    if (mission.governance?.paperclipIssueId) mission = await this.store.updateTask(mission.taskId, { governance:await this.governance.update(mission) });
    return { mission, children, reply:replyFor(mission, plan, children, state) };
  }

  async resumeQueuedMaturityChildren({ mission, plan, childByKey }) {
    if (!mission?.input?.context?.productMaturityBatchId) return;
    const recoverable = plan.subtasks.filter((subtask) => {
      const child = childByKey.get(subtask.key);
      return child?.status === 'queued'
        || isExactLegacyMaturityContentBlock(child)
        || isExactQueuedMaturityContentRetry(child);
    });
    if (!recoverable.length) return;
    if (typeof this.tasks?.resumeVerifiedQueuedMissionChild !== 'function') {
      throw new Error('产品成熟度排队任务缺少受控恢复接缝，已停止分派。');
    }
    if (typeof this.missionChildPolicy?.verifyMissionAuthorization !== 'function'
      || typeof this.missionChildPolicy?.assertAuthorized !== 'function') {
      throw new Error('产品成熟度排队任务缺少子任务验签策略，已停止分派。');
    }
    this.missionChildPolicy.verifyMissionAuthorization(mission);
    for (const subtask of recoverable) {
      const child = childByKey.get(subtask.key);
      if (child?.status !== 'queued'
        && !isExactLegacyMaturityContentBlock(child)
        && !isExactQueuedMaturityContentRetry(child)) continue;
      if (!dependenciesFor(plan.subtasks, subtask).every((key) => dependencySatisfied(mission, childByKey.get(key)?.status))) continue;
      this.missionChildPolicy.assertAuthorized({ mission, subtask });
      const idempotencyKey = `${mission.idempotencyKey || `mission:${mission.taskId}`}:${subtask.key}`;
      const resumed = await this.tasks.resumeVerifiedQueuedMissionChild({
        missionTaskId:mission.taskId,
        taskId:child.taskId,
        idempotencyKey,
      });
      childByKey.set(subtask.key, resumed);
    }
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
  if (!Array.isArray(items) || items.length < 1 || items.length > 11) return [];
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
      connectionId:normalizeConnectionId(item?.connectionId),
      reviewPolicy:item?.reviewPolicy === 'required' ? 'required' : 'optional',
      evidenceMode:item?.evidenceMode === 'preliminary' ? 'preliminary' : 'formal',
      analysisIntent:['digest', 'deep', 'template', 'style'].includes(item?.analysisIntent) ? item.analysisIntent : undefined,
      depth:item?.depth === 'full' ? 'full' : 'fast',
      visualMode:item?.visualMode === 'off' || item?.visualMode === 'required' ? item.visualMode : 'auto',
      focus:clean(item?.focus, 500),
      platforms:Array.isArray(item?.platforms) ? [...new Set(item.platforms.map((platform) => clean(platform, 40)).filter(Boolean))].slice(0, 3) : [],
      contentGoal:clean(item?.contentGoal, 500),
      researchMode:item?.researchMode === 'off' ? 'off' : 'auto',
      approvedForUse:item?.approvedForUse === true,
      proposalOnly:item?.proposalOnly === true,
      draftOnly:item?.draftOnly === true,
      deterministicAcceptanceRepair:item?.deterministicAcceptanceRepair === true,
      context:normalizeBusinessContext(item?.context),
      dependsOnPrevious:item?.dependsOnPrevious === true || agentId === 'office-assistant',
      dependsOn:Array.isArray(item?.dependsOn)
        ? [...new Set(item.dependsOn.map((value) => clean(value, 80)).filter(Boolean))].slice(0, 10)
        : []
    }, { index });
  }).filter(Boolean);
  if (normalized.length !== items.length) return [];
  const keys = new Set(normalized.map((item) => item.key));
  if (normalized.some((item) => item.dependsOn.some((key) => !keys.has(key) || key === item.key))) return [];
  return hasDependencyCycle(normalized) ? [] : normalized;
}

function normalizeBusinessContext(value) {
  const productMaturity = normalizedProductMaturityContext(value);
  if (productMaturity) return productMaturity;
  const signal = value?.boomSignal;
  if (!signal || typeof signal !== 'object' || Array.isArray(signal)) return undefined;
  const serialized = JSON.stringify(signal);
  if (serialized.length > 12_000) return undefined;
  return { boomSignal:JSON.parse(serialized) };
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

function isActivelyRunning(status) {
  return ['queued', 'running', 'waiting_worker'].includes(status);
}

function dependencySatisfied(mission, status) {
  return mission?.input?.context?.productMaturityBatchId
    ? status === 'succeeded'
    : isTerminal(status);
}

function dependenciesFor(subtasks, subtask) {
  const explicit = Array.isArray(subtask.dependsOn) ? subtask.dependsOn : [];
  if (explicit.length) return explicit;
  if (subtask.dependsOnPrevious !== true) return [];
  const index = subtasks.findIndex((item) => item.key === subtask.key);
  return index > 0 ? subtasks.slice(0, index).map((item) => item.key) : [];
}

function hasDependencyCycle(subtasks) {
  const visiting = new Set();
  const visited = new Set();
  const visit = (subtask) => {
    if (visiting.has(subtask.key)) return true;
    if (visited.has(subtask.key)) return false;
    visiting.add(subtask.key);
    for (const key of dependenciesFor(subtasks, subtask)) {
      const dependency = subtasks.find((item) => item.key === key);
      if (dependency && visit(dependency)) return true;
    }
    visiting.delete(subtask.key);
    visited.add(subtask.key);
    return false;
  };
  return subtasks.some(visit);
}

function isVerifiedArtifact(artifact) {
  return artifact?.validation?.exists === true
    && artifact.validation.readable === true
    && artifact.validation.nonEmpty === true;
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

function normalizeConnectionId(value) {
  const id = clean(value, 100);
  if (!id) return undefined;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('账号连接标识格式不正确。');
  }
  return id;
}

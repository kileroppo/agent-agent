import {
  M5_PLATFORMS,
} from '@agent-army/m5-contracts';
import { assertM5ControlPlane } from './control-plane.js';
import {
  campaignNextAction as nextAction,
  ContentCampaignError,
  normalizeCampaignDraft as normalizeDraft,
  safeCampaignGrantView as safeGrantView,
} from './campaign-domain.js';
export { ContentCampaignError } from './campaign-domain.js';
import { CampaignLifecycle } from './campaign-lifecycle.js';
import { M5ParallelWorkCoordinator } from './parallel-work-coordinator.js';
import { contentCampaignExecutionMethods } from './content-campaign-execution.js';
import { asList } from './content-campaign-primitives.js';

const PLATFORMS = M5_PLATFORMS;
export class ContentCampaignKernel {
  constructor({
    controlPlane,
    definition,
    publisher = null,
    toolExecutor = null,
    templateResolver = null,
    activePipelineId = null,
    activePipelineKey = null,
    contentWorkspaceRoot = null,
    allowLocalFixtureProvenance = false,
    now = () => new Date(),
  } = {}) {
    if (!controlPlane || !definition) throw new ContentCampaignError('M5 内容活动缺少 Control Plane 或 Pipeline 定义。');
    this.controlPlane = assertM5ControlPlane(controlPlane);
    this.definition = definition;
    this.publisher = publisher;
    this.toolExecutor = toolExecutor;
    this.templateResolver = templateResolver;
    this.activePipelineId = String(activePipelineId || '').trim() || null;
    this.activePipelineKey = String(activePipelineKey || definition.key).trim();
    this.contentWorkspaceRoot = String(contentWorkspaceRoot || '').trim() || null;
    this.allowLocalFixtureProvenance = allowLocalFixtureProvenance === true;
    this.now = now;
    this.lifecycle = new CampaignLifecycle({
      controlPlane:this.controlPlane,
      definition,
      activePipelineId:this.activePipelineId,
      activePipelineKey:this.activePipelineKey,
      now,
    });
  }

  async list() {
    const pipeline = await this.lifecycle.pipeline();
    const cases = await this.controlPlane.listPipelineCases(pipeline.id);
    const rows = caseRows(cases);
    const parents = rows.filter((item) => !item.parentCaseId && item.campaignGrant);
    return Promise.all(parents.map(async (item) => campaignView(item, {
      children:descendantCases(item.id, rows),
      approval:await this.lifecycle.approvalReadiness(item),
    }, this.definition)));
  }

  async createDraft(input = {}) {
    const draft = normalizeDraft(input, this.now());
    const pipeline = await this.lifecycle.pipeline();
    const parent = await this.controlPlane.ingestCampaignDraft(pipeline, draft);
    return this.get(parent.id);
  }

  async approve(caseId, input = {}) {
    return this.get(await this.lifecycle.approve(caseId, input));
  }

  async control(caseId, action, input = {}) {
    return this.get(await this.lifecycle.control(caseId, action, input));
  }

  async activateScheduledDay() {
    return this.lifecycle.activateScheduledDay();
  }

  async reconcileParallelWork(dayCaseId) {
    const pipeline = await this.lifecycle.pipeline();
    const coordinator = new M5ParallelWorkCoordinator({
      controlPlane:this.controlPlane,
      pipelineId:pipeline.id,
    });
    return coordinator.reconcile(dayCaseId);
  }

  async onM5WorkProductSynced({ pipelineCaseId, stageKey } = {}) {
    if (![
      'topic',
      'script',
      'evidence',
      'assets',
      'parallel_image_generation',
      'voice',
    ].includes(String(stageKey || ''))) {
      return { reconciled:false, reason:'stage_not_parallel_relevant' };
    }
    const chain = await this.caseChain(pipelineCaseId);
    const dayCase = chain.find((item) =>
      item?.scheduledDate
      && !item.platform
      && !item.workBranch
      && item.parentCaseId,
    );
    if (!dayCase) throw new ContentCampaignError('并行工作产物无法回溯到日期 Case。');
    return {
      reconciled:true,
      result:await this.reconcileParallelWork(dayCase.id),
    };
  }

  async get(caseId) {
    const item = await this.lifecycle.parentCase(caseId);
    const [children, events, outputs, approval] = await Promise.all([
      this.controlPlane.getCaseChildren(item.id).catch(() => []),
      this.controlPlane.listCaseEvents(item.id, { limit:100, order:'desc' }).catch(() => []),
      this.controlPlane.getCaseOutputs(item.id).catch(() => []),
      this.lifecycle.approvalReadiness(item),
    ]);
    return campaignView(item, {
      children:childNodesFromTree(children),
      events:asList(events),
      outputs:asList(outputs),
      approval,
    }, this.definition);
  }

  async approvalReadiness(item) {
    return this.lifecycle.approvalReadiness(item);
  }

  async requirePipeline() {
    return this.lifecycle.pipeline();
  }

  async getRawCase(caseId) {
    return this.lifecycle.parentCase(caseId);
  }

  async getAnyCase(caseId) {
    return this.lifecycle.case(caseId);
  }

  async assertCaseInActivePipeline(item) {
    await this.lifecycle.assertActivePipeline(item);
  }

  async transitionCase(item, toStageKey, reason) {
    return this.lifecycle.transition(item, toStageKey, reason);
  }

  async getDailyRoutineTrigger() {
    return this.lifecycle.dailyRoutine();
  }
}


Object.assign(ContentCampaignKernel.prototype, contentCampaignExecutionMethods);

function campaignView(item, related = {}, definition = {}) {
  const grant = item.campaignGrant || {};
  const descendants = flattenCases(related.children || []);
  const focus = campaignFocus(item, descendants, definition);
  const platformCases = descendants.filter((entry) => PLATFORMS.includes(
    entry.platform || platformFromCaseKey(entry.caseKey),
  ));
  const done = platformCases.filter((entry) =>
    entry.stage?.kind === 'done'
    || entry.terminalKind === 'done'
    || entry.stageKey === 'retrospective'
    || entry.status === 'done',
  ).length;
  return {
    campaignId:item.id,
    caseKey:item.caseKey || null,
    title:item.title || 'M5 内容活动',
    status:grant.status || 'unknown',
    currentStage:focus.stageName,
    currentOwner:focus.owner,
    grant:safeGrantView(grant),
    progress:{ completedPlatformCases:done, totalPlatformCases:14 },
    costs:item.costSummary || null,
    pauseReason:grant.pauseReason || null,
    nextAction:nextAction(grant.status),
    recoverFrom:focus.stageName,
    recoveryStep:focus.recoveryStep,
    approval:related.approval || {
      allowed:false,
      code:'approval_state_unknown',
      reason:'尚未完成活动启动前检查。',
    },
    events:(related.events || []).slice(0, 20),
    outputs:(related.outputs || []).slice(0, 50),
  };
}

function campaignFocus(parent, descendants, definition) {
  const active = descendants.filter((item) => item?.activeWork);
  const candidates = active.length ? active : [parent];
  const stageKeys = [...new Set(candidates.map((item) => item.stageKey).filter(Boolean))];
  const stages = stageKeys.map((key) =>
    definition?.stages?.find((stage) => stage.key === key) || { key, name:key, owner:null },
  );
  const stageName = stages.map((stage) => stage.name || stage.key).filter(Boolean).join('、')
    || parent.stage?.name
    || parent.stageKey
    || null;
  const owners = [...new Set(stages.map((stage) => stage.owner).filter(Boolean))];
  const owner = {
    agentIds:owners,
    label:owners.map(ownerLabel).join('、') || 'Paperclip 当前未指派',
  };
  const blockedRecovery = m5ContentRecoveryInstruction([parent, ...descendants]);
  const recoveryStep = blockedRecovery
    || (stageName ? `从“${stageName}”继续；已验证产物不会重新生成。` : '先核对 Paperclip Case 当前阶段。');
  return { stageName, owner, recoveryStep };
}

function m5ContentRecoveryInstruction(cases) {
  const recoveryStates = (Array.isArray(cases) ? cases : [])
    .map((item) => item?.contentRecovery)
    .filter((value) => value?.schemaVersion === 'agent.army/m5-content-recovery/v1')
    .sort((left, right) => Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0));
  for (const recovery of recoveryStates) {
    const blocked = Object.values(recovery.stageRecoveries || {})
      .filter((item) => item?.status === 'blocked')
      .sort((left, right) => Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0))
      .map((item) => item?.recoveryAction?.instruction)
      .find((value) => typeof value === 'string' && value.trim());
    if (blocked) return blocked;
  }
  const activeRevision = recoveryStates
    .map((recovery) => recovery.activePlanRevision)
    .find((revision) =>
      revision?.schemaVersion === 'agent.army/m5-plan-revision/v1'
      && ['same_stage_rebuild_inputs', 'system_controller_rederive_case_state']
        .includes(revision.nextRoute?.kind)
      && typeof revision.nextRoute?.instruction === 'string'
      && revision.nextRoute.instruction.trim()
    );
  return activeRevision?.nextRoute?.instruction || null;
}

function ownerLabel(owner) {
  return ({
    ajun:'A君',
    'intel-researcher':'小R',
    xiaod:'小D',
    'video-content-analyst':'小拆',
    'content-creator':'小创',
    reviewer:'审核官',
    operator:'运维官',
    'office-assistant':'小办',
  })[owner] || owner;
}

function flattenCases(items) {
  const result = [];
  const queue = [...asList(items)];
  while (queue.length) {
    const item = queue.shift();
    result.push(item);
    queue.push(...asList(item.children));
  }
  return result;
}

function descendantCases(parentId, rows) {
  const result = [];
  const queue = [parentId];
  while (queue.length) {
    const currentId = queue.shift();
    const children = rows.filter((item) => item.parentCaseId === currentId);
    result.push(...children);
    queue.push(...children.map((item) => item.id));
  }
  return result;
}

function childNodesFromTree(value) {
  return Array.isArray(value) ? value : [];
}

function caseRows(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function platformFromCaseKey(caseKey) {
  const match = String(caseKey || '').match(/:(douyin|xiaohongshu):v[1-9]\d*$/);
  return match?.[1] || null;
}

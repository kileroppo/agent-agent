import crypto from 'node:crypto';
import {
  M5_PLATFORMS,
  M5_SCHEMA_IDS,
  M5_STEPFUN_MODELS,
} from '@agent-army/m5-contracts';
import { assertM5ControlPlane } from './control-plane.js';
import {
  campaignNextAction as nextAction,
  ContentCampaignError,
  normalizeCampaignDraft as normalizeDraft,
  requireActiveCampaignGrant as requireActiveGrant,
  requireCampaignGrant as requireGrant,
  safeCampaignGrantView as safeGrantView,
  samePluginApproval,
} from './campaign-domain.js';
export { ContentCampaignError } from './campaign-domain.js';
import { M5ParallelWorkCoordinator } from './parallel-work-coordinator.js';
import { contentCampaignExecutionMethods } from './content-campaign-execution.js';
import { asList, safeId, safeOpaqueId, safeText } from './content-campaign-primitives.js';
import {
  assertM5RoutineExecutionContracts,
  getM5RoutineExecutionContract,
} from './routine-execution-contract.js';
import {
  buildM5PlatformCopy,
  deriveM5ContentVersionId,
} from './content-version.js';
import {
  healthyM5StageWorkProducts,
  m5StageWorkProductCandidates,
} from './stage-recovery-controller.js';
import {
  assertChangedM5RecoveryRoute,
  createM5RouteExecution,
  validM5RouteExecution,
} from './route-execution.js';
import {
  assertM5WorkspaceArtifact,
  M5WorkspaceArtifactError,
  validM5WorkProductArtifactHash,
} from './work-product-integrity.js';
import {
  M5ProductionTemplateResolutionError,
  defaultM5ProductionTemplateBinding,
  validM5ProductionTemplateBinding,
} from './production-template-binding.js';

const CASE_ID = /^[0-9a-f-]{8,80}$/i;
const RECEIPT_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const PLATFORMS = M5_PLATFORMS;
const CONTROL_ACTIONS = new Set(['pause', 'resume', 'stop']);
const CONTENT_AUTONOMY_PLUGIN_KEY = 'agent-army.content-autonomy';
const INVOKABLE_AGENT_STATUSES = new Set(['active', 'idle', 'running']);
const M5_PROVIDER_MODELS = M5_STEPFUN_MODELS;

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
    this.controlTail = Promise.resolve();
  }

  async list() {
    const pipeline = await this.requirePipeline();
    const cases = await this.controlPlane.listPipelineCases(pipeline.id);
    const rows = caseRows(cases);
    const parents = rows.filter((item) => !item.parentCaseId && item.campaignGrant);
    return Promise.all(parents.map(async (item) => campaignView(item, {
      children:descendantCases(item.id, rows),
      approval:await this.approvalReadiness(item),
    }, this.definition)));
  }

  async createDraft(input = {}) {
    const draft = normalizeDraft(input, this.now());
    const pipeline = await this.requirePipeline();
    const parent = await this.controlPlane.ingestCampaignDraft(pipeline, draft);
    return this.get(parent.id);
  }

  async approve(caseId, input = {}) {
    return this.serializeControl(() => this.approveLocked(caseId, input));
  }

  async approveLocked(caseId, input = {}) {
    if (input.confirmActivityGrant !== true) {
      throw new ContentCampaignError('必须明确确认本次活动授权，不能由 A君或岗位自行批准。');
    }
    const current = await this.getRawCase(caseId);
    const grant = requireGrant(current);
    if (Number(grant.budgetCents) > 500 && input.confirmHighBudget !== true) {
      throw new ContentCampaignError('活动预算超过 5 美元，必须单独明确确认高预算。');
    }
    if (grant.status !== 'draft') throw new ContentCampaignError(`当前活动不是草案，不能批准：${grant.status}。`);
    const now = this.now();
    if (Date.parse(grant.expiresAt) <= now.getTime()) throw new ContentCampaignError('活动授权已经过期，必须重新创建授权草案。');
    let updatedGrant = {
      ...grant,
      status:'active',
      approvedAt:now.toISOString(),
      approvedBy:'local-owner',
      pausedAt:null,
      pauseReason:null,
    };
    const pluginApproval = await this.assertActivationAllowed(current, updatedGrant);
    updatedGrant = { ...updatedGrant, pluginApproval };
    await this.activateApprovedCampaign(current, updatedGrant);
    return this.get(current.id);
  }

  async control(caseId, action, input = {}) {
    return this.serializeControl(() => this.controlLocked(caseId, action, input));
  }

  async activateScheduledDay() {
    return this.serializeControl(() => this.activateScheduledDayLocked());
  }

  async activateScheduledDayLocked() {
    const trigger = await this.getDailyRoutineTrigger();
    if (trigger.enabled !== true) {
      throw new ContentCampaignError('M5 每日入口 Cron 当前关闭，拒绝手工或漂移唤醒。');
    }
    const pipeline = await this.requirePipeline();
    const cases = caseRows(await this.controlPlane.listPipelineCases(pipeline.id));
    const activeParents = cases.filter((item) =>
      !item.parentCaseId
      && item.campaignGrant?.status === 'active',
    );
    if (activeParents.length !== 1) {
      throw new ContentCampaignError(`M5 每日入口要求恰好一个 active CampaignGrant，当前为 ${activeParents.length} 个。`);
    }
    const parent = activeParents[0];
    const grant = requireActiveGrant(parent, this.now());
    if (parent.stageKey !== 'campaign_active') {
      throw new ContentCampaignError(`活动父 Case 不在 campaign_active 控制阶段，当前为 ${parent.stageKey || 'unknown'}。`);
    }
    const scheduledDate = dateOnlyInTimeZone(
      this.now(),
      this.definition.executionPolicy?.schedule?.timezone || 'Asia/Shanghai',
    );
    const candidates = cases.filter((item) =>
      item.parentCaseId === parent.id
      && !item.platform
      && item.campaignId === parent.campaignId
      && item.scheduledDate === scheduledDate,
    );
    if (candidates.length !== 1) {
      throw new ContentCampaignError(`活动 ${parent.caseKey || parent.id} 在 ${scheduledDate} 必须恰好有一个日期 Case，当前为 ${candidates.length} 个。`);
    }
    const dayCase = candidates[0];
    if (dayCase.stageKey === 'draft') {
      const activated = await this.transitionCase(
        dayCase,
        'topic',
        `M5 每日入口只激活 Asia/Shanghai 日期 ${scheduledDate} 的唯一日期 Case。`,
      );
      return {
        campaignCaseId:parent.id,
        dayCaseId:dayCase.id,
        scheduledDate,
        activated:true,
        replayed:false,
        stageKey:activated.stageKey || 'topic',
        grantExpiresAt:grant.expiresAt,
      };
    }
    const businessStageKeys = this.definition.stages
      .filter((stage) => !['draft', 'campaign_active', 'cancelled'].includes(stage.key))
      .map((stage) => stage.key);
    if (businessStageKeys.includes(dayCase.stageKey)) {
      return {
        campaignCaseId:parent.id,
        dayCaseId:dayCase.id,
        scheduledDate,
        activated:false,
        replayed:true,
        stageKey:dayCase.stageKey,
        grantExpiresAt:grant.expiresAt,
      };
    }
    throw new ContentCampaignError(`当日 Case 处于不可激活阶段 ${dayCase.stageKey || 'unknown'}，拒绝强制推进。`);
  }

  async reconcileParallelWork(dayCaseId) {
    const pipeline = await this.requirePipeline();
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

  async controlLocked(caseId, action, input = {}) {
    if (!CONTROL_ACTIONS.has(action)) throw new ContentCampaignError('活动控制动作无效。');
    const current = await this.getRawCase(caseId);
    const grant = requireGrant(current);
    const now = this.now();
    if (action === 'resume') {
      if (grant.status !== 'paused') throw new ContentCampaignError('只有已暂停活动可以恢复。');
      if (Date.parse(grant.expiresAt) <= now.getTime()) throw new ContentCampaignError('活动授权已经过期，不能恢复。');
      const resumedGrant = { ...grant, status:'active', pausedAt:null, pauseReason:null, resumedAt:now.toISOString() };
      await this.assertActivationAllowed(current, resumedGrant);
      await this.activateApprovedCampaign(current, resumedGrant);
    } else {
      const status = action === 'stop' ? 'stopped' : 'paused';
      await this.updateGrantWithRoutine(
        current,
        {
          ...grant,
          status,
          pausedAt:now.toISOString(),
          pauseReason:safeText(input.reason, 500) || (action === 'stop' ? '本机负责人停止活动。' : '本机负责人暂停活动。'),
        },
        false,
      );
    }
    return this.get(current.id);
  }

  async get(caseId) {
    const item = await this.getRawCase(caseId);
    const [children, events, outputs, approval] = await Promise.all([
      this.controlPlane.getCaseChildren(item.id).catch(() => []),
      this.controlPlane.listCaseEvents(item.id, { limit:100, order:'desc' }).catch(() => []),
      this.controlPlane.getCaseOutputs(item.id).catch(() => []),
      this.approvalReadiness(item),
    ]);
    return campaignView(item, {
      children:childNodesFromTree(children),
      events:asList(events),
      outputs:asList(outputs),
      approval,
    }, this.definition);
  }

  async approvalReadiness(item) {
    const grant = item?.campaignGrant || {};
    if (grant.status !== 'draft') {
      return {
        allowed:false,
        code:'campaign_not_draft',
        reason:`当前活动状态为 ${grant.status || 'unknown'}，只有草案可以批准。`,
      };
    }
    if (Date.parse(grant.expiresAt) <= this.now().getTime()) {
      return {
        allowed:false,
        code:'campaign_expired',
        reason:'活动授权草案已经过期，必须重新创建。',
      };
    }
    try {
      await this.assertActivationAllowed(item, { ...grant, status:'active' });
      return {
        allowed:true,
        code:'ready',
        reason:'内容插件、岗位、Routine、Pipeline 和预算启动前检查均已通过。',
      };
    } catch (error) {
      return {
        allowed:false,
        code:'preflight_failed',
        reason:safeText(error?.message, 500) || 'M5 启动前检查未通过。',
      };
    }
  }

  async requirePipeline() {
    const pipeline = this.activePipelineId
      ? await this.controlPlane.getPipeline(this.activePipelineId)
      : await this.controlPlane.findPipelineByKey(this.definition.key);
    if (!pipeline) {
      throw new ContentCampaignError('M5 Paperclip Pipeline 尚未应用；先完成本地 dry-run、预算和岗位绑定审核。');
    }
    if (pipeline.key !== this.activePipelineKey) {
      throw new ContentCampaignError(
        `M5 activePipelineId 指向 ${pipeline.key || 'unknown'}，与声明 ${this.activePipelineKey} 不一致。`,
      );
    }
    return pipeline;
  }

  async getRawCase(caseId) {
    const id = safeId(caseId, '内容活动标识无效。');
    const item = await this.controlPlane.getCase(id);
    if (!item || item.parentCaseId || !item.campaignGrant) throw new ContentCampaignError('没有找到对应的活动父 Case。');
    await this.assertCaseInActivePipeline(item);
    return item;
  }

  async getAnyCase(caseId) {
    const id = safeId(caseId, 'Pipeline Case 标识无效。');
    const item = await this.controlPlane.getCase(id);
    if (!item) throw new ContentCampaignError('没有找到对应的 Pipeline Case。');
    await this.assertCaseInActivePipeline(item);
    return item;
  }

  async assertCaseInActivePipeline(item) {
    const pipeline = await this.requirePipeline();
    const casePipelineId = item.pipelineId || item.pipeline?.id;
    if (!casePipelineId || casePipelineId !== pipeline.id) {
      throw new ContentCampaignError('当前 Case 不属于显式 activePipelineId，拒绝跨 v1/v2 操作。');
    }
  }

  async updateGrant(item, campaignGrant) {
    return this.controlPlane.updateCampaignGrant(item.id, item.version, campaignGrant);
  }

  async activateApprovedCampaign(item, campaignGrant) {
    let grantActivated = false;
    try {
      await this.updateGrant(item, campaignGrant);
      grantActivated = true;

      const current = await this.getRawCase(item.id);
      const pipeline = await this.requirePipeline();
      const execution = await this.controlPlane.ingestCampaignExecution(pipeline, current);
      await this.restoreExecutionCasesToDraft(execution.days);
      await this.restoreExecutionCasesToDraft(execution.platformCases);

      const parent = await this.getRawCase(item.id);
      if (['draft', 'cancelled'].includes(parent.stageKey)) {
        await this.transitionCase(parent, 'campaign_active', '活动授权门禁已通过，启动父 Case。');
      }
      await this.setDailyRoutineEnabled(true);
    } catch (error) {
      if (grantActivated) {
        await this.setDailyRoutineEnabled(false).catch(() => undefined);
        await this.pauseIncompleteActivation(item.id, error).catch(() => undefined);
      }
      throw error;
    }
  }

  async restoreExecutionCasesToDraft(cases) {
    for (const item of cases) {
      if (!item || item.stageKey === 'draft') continue;
      if (item.stageKey !== 'cancelled') continue;
      await this.transitionCase(item, 'draft', '活动授权门禁已通过，恢复为待每日入口或上游阶段激活的草案 Case。');
    }
  }

  async transitionCase(item, toStageKey, reason) {
    if (!this.controlPlane?.transitionCase) {
      throw new ContentCampaignError('Paperclip 适配器缺少 Case 阶段迁移能力，活动保持暂停。');
    }
    return this.controlPlane.transitionCase(item.id, {
      toStageKey,
      expectedVersion:item.version,
      reason,
      force:true,
    });
  }

  async pauseIncompleteActivation(caseId, error) {
    const current = await this.getRawCase(caseId);
    const grant = requireGrant(current);
    if (grant.status !== 'active') return;
    await this.updateGrant(current, {
      ...grant,
      status:'paused',
      pausedAt:this.now().toISOString(),
      pauseReason:`activation_incomplete: ${safeText(error?.message, 420) || '审批后激活未完成'}`,
    });
  }

  async assertActivationAllowed(item, campaignGrant) {
    const pipeline = await this.requirePipeline();
    const cases = caseRows(await this.controlPlane.listPipelineCases(pipeline.id));
    const activeConflict = cases.find((entry) =>
      entry.id !== item.id
      && !entry.parentCaseId
      && entry.campaignGrant?.status === 'active',
    );
    if (activeConflict) {
      throw new ContentCampaignError(
        `共享 M5 Cron 已被活动 ${activeConflict.caseKey || activeConflict.id} 占用；先暂停或停止该活动。`,
      );
    }

    const companyId = safeOpaqueId(this.controlPlane.companyId);
    const projectId = safeOpaqueId(item.projectId || item.pipeline?.projectId || pipeline.projectId);
    if (!companyId || !projectId) {
      throw new ContentCampaignError('无法核验 Paperclip 公司或项目预算，活动保持未启动。');
    }
    const pluginApproval = await this.assertExecutionReady(pipeline, companyId);
    if (
      campaignGrant.pluginApproval
      && !samePluginApproval(campaignGrant.pluginApproval, pluginApproval)
    ) {
      throw new ContentCampaignError(
        '内容插件版本或配置已偏离原活动批准快照；不能自动恢复，必须重新签发活动授权。',
      );
    }
    const overview = await this.controlPlane.getBudgetOverview().catch(() => null);
    const policies = asList(overview?.policies);
    const policy = policies.find((entry) =>
      entry.scopeType === 'project'
      && entry.scopeId === projectId
      && entry.metric === 'billed_cents'
      && entry.active === true,
    );
    if (
      !policy
      || policy.hardStop !== true
      || !Number.isInteger(Number(policy.amount))
      || Number(policy.amount) !== Number(campaignGrant.budgetCents)
      || !['ok', 'warning'].includes(policy.status)
      || policy.paused === true
      || !Number.isFinite(Number(policy.remainingAmount))
      || Number(policy.remainingAmount) < 0
    ) {
      throw new ContentCampaignError(
        `Paperclip 项目预算必须可用、启用硬停，且与活动预算 ${campaignGrant.budgetCents} 美分完全一致。`,
      );
    }
    return pluginApproval;
  }

  async assertExecutionReady(pipeline, companyId) {
    const failures = [];
    let executionContracts = [];
    try {
      executionContracts = assertM5RoutineExecutionContracts(this.definition);
    } catch (error) {
      failures.push(`Pipeline 执行契约无效：${String(error?.message || error)}`);
    }
    const readiness = await this.controlPlane.inspectExecutionReadiness({ pipeline, executionContracts });
    const plugins = readiness.plugins;
    const routines = readiness.routines;
    const agents = readiness.agents;
    const pipelineDetail = readiness.pipeline;
    const contentPlugin = plugins.find((item) => item.key === CONTENT_AUTONOMY_PLUGIN_KEY);
    if (!contentPlugin || contentPlugin.status !== 'ready') {
      failures.push(`内容插件 ${CONTENT_AUTONOMY_PLUGIN_KEY} 未处于 ready`);
    } else {
      failures.push(...await this.controlPlane.inspectContentAutonomyReadiness({
        plugin:contentPlugin,
        agents,
      }));
    }
    const routineByKey = new Map();
    const routineSpecs = [
      ...executionContracts.map((contract) => ({
        key:contract.routineKey,
        stageKey:contract.stageKey,
        owner:contract.agentId || contract.systemController,
        contract,
      })),
      { key:'m5-daily-campaign', stageKey:null, owner:'ajun' },
    ];
    for (const spec of routineSpecs) {
      const marker = `[agent-army:m5:routine:${spec.key}]`;
      const matches = routines.filter((item) =>
        item.projectId === pipeline.projectId
        && String(item.description || '').includes(marker),
      );
      if (matches.length === 0) {
        failures.push(`Routine 不存在：${spec.key}`);
        continue;
      }
      if (matches.length > 1) {
        failures.push(`Routine ${spec.key} 必须唯一，当前为 ${matches.length} 个`);
        continue;
      }
      const routine = matches[0];
      routineByKey.set(spec.key, routine);
      if (routine.status !== 'active') {
        failures.push(`Routine ${spec.key} 当前状态为 ${routine.status || 'unknown'}，不是 active`);
      }
      const agent = agents.find((item) => item.id === routine.assigneeAgentId);
      const reason = agentInvocationBlockReason(agent);
      if (reason) {
        failures.push(`Routine ${spec.key} 的岗位 ${spec.owner} 不可调用：${reason}`);
        continue;
      }
      if (spec.contract?.executionMode === 'system_controller') {
        if (agent?.systemRole !== spec.contract.systemController) {
          failures.push(`Routine ${spec.key} 必须绑定系统控制器 ${spec.contract.systemController}`);
        }
      } else if (spec.contract?.executionMode === 'hermes') {
        failures.push(...hermesExecutionContractFailures(agent, spec.contract));
      }
    }

    const pipelineStages = asList(pipelineDetail?.stages);
    for (const stage of this.definition.stages.filter((item) => item.routineKey)) {
      const liveStage = pipelineStages.find((item) => item.key === stage.key);
      const routine = routineByKey.get(stage.routineKey);
      const contract = getM5RoutineExecutionContract(stage.routineKey);
      if (!liveStage) {
        failures.push(`Pipeline 缺少阶段 ${stage.key}`);
      } else if (routine && liveStage.routineId !== routine.id) {
        failures.push(`阶段 ${stage.key} 未绑定声明的 Routine ${stage.routineKey}`);
      } else if (!contract) {
        failures.push(`阶段 ${stage.key} 缺少唯一执行契约`);
      }
    }
    if (failures.length > 0) {
      throw new ContentCampaignError(`M5 启动前检查未通过：${failures.join('；')}。`);
    }
    try {
      return await this.controlPlane.readContentAutonomyApprovalSnapshot(contentPlugin);
    } catch (error) {
      throw new ContentCampaignError(
        `M5 无法锁定内容插件批准快照：${safeText(error?.message, 300) || 'unknown'}。`,
      );
    }
  }

  async updateGrantWithRoutine(item, campaignGrant, routineEnabled) {
    const routineState = await this.setDailyRoutineEnabled(routineEnabled);
    try {
      return await this.updateGrant(item, campaignGrant);
    } catch (error) {
      if (routineState.changed) {
        await this.setDailyRoutineEnabled(routineState.previousEnabled).catch(() => undefined);
      }
      throw error;
    }
  }

  async setDailyRoutineEnabled(enabled) {
    const trigger = await this.getDailyRoutineTrigger();
    if (typeof trigger.enabled !== 'boolean') {
      throw new ContentCampaignError('M5 每日入口触发器缺少明确 enabled 状态，活动保持未启动。');
    }
    const previousEnabled = trigger.enabled;
    if (previousEnabled === enabled) {
      return { triggerId:trigger.id, previousEnabled, enabled, changed:false };
    }
    await this.controlPlane.setDailyScheduleEnabled(trigger.id, enabled);
    return { triggerId:trigger.id, previousEnabled, enabled, changed:true };
  }

  async getDailyRoutineTrigger() {
    const pipeline = await this.requirePipeline();
    return this.controlPlane.getDailySchedule(pipeline);
  }

  async serializeControl(operation) {
    const previous = this.controlTail;
    let release;
    this.controlTail = new Promise((resolve) => { release = resolve; });
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }
}


Object.defineProperties(ContentCampaignKernel.prototype, Object.fromEntries(
  Object.entries(contentCampaignExecutionMethods).map(([name, method]) => [name, {
    value:method,
    configurable:true,
    writable:true,
  }]),
));

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

function agentInvocationBlockReason(agent) {
  if (!agent) return '找不到 assignee Agent';
  if (!INVOKABLE_AGENT_STATUSES.has(agent.status)) {
    return `Paperclip 状态为 ${agent.status || 'unknown'}`;
  }
  const adapterType = String(agent.adapterType || '').trim();
  if (!adapterType) return '缺少 adapterType';
  if (adapterType === 'http') {
    const url = String(agent.adapterConfig?.url || '').trim();
    if (!url) return 'HTTP adapter 缺少受控 url';
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) return 'HTTP adapter url 协议无效';
    } catch {
      return 'HTTP adapter url 无效';
    }
  }
  if (adapterType === 'hermes_local') {
    if (!String(agent.adapterConfig?.provider || '').trim()) return 'Hermes adapter 缺少 provider';
    if (!String(agent.adapterConfig?.model || '').trim()) return 'Hermes adapter 缺少 model';
  }
  return null;
}

function hermesExecutionContractFailures(agent, contract) {
  const failures = [];
  if (agent?.roleId !== contract.agentId) {
    failures.push(`Routine ${contract.routineKey} 必须绑定岗位 ${contract.agentId}`);
  }
  if (agent?.adapterType !== 'hermes_local') {
    failures.push(`Routine ${contract.routineKey} 的岗位必须使用 hermes_local`);
    return failures;
  }
  const acceptedTaskTypes = commaSeparated(agent.adapterConfig?.env?.AGENT_ARMY_ALLOWED_TASK_TYPES);
  if (!acceptedTaskTypes.includes(contract.taskType)) {
    failures.push(`岗位 ${contract.agentId} 的 manifest 未声明任务类型 ${contract.taskType}`);
  }
  const mcpTools = commaSeparated(agent.adapterConfig?.env?.AGENT_ARMY_ALLOWED_MCP_TOOLS);
  for (const tool of ['paperclip_assignment_get', contract.completionTool]) {
    if (tool && !mcpTools.includes(tool)) {
      failures.push(`岗位 ${contract.agentId} 的 MCP 工具契约缺少 ${tool}`);
    }
  }
  if (
    contract.executionTool?.kind === 'agent_army_mcp'
    && !mcpTools.includes(contract.executionTool.id)
  ) {
    failures.push(`岗位 ${contract.agentId} 的 MCP 工具契约缺少 ${contract.executionTool.id}`);
  }
  return failures;
}

function commaSeparated(value) {
  const resolved = value && typeof value === 'object' && value.type === 'plain'
    ? value.value
    : value;
  return [...new Set(String(resolved || '').split(',').map((item) => item.trim()).filter(Boolean))];
}

function safeDateOnly(value) {
  const date = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new ContentCampaignError('startDate 必须是有效的 YYYY-MM-DD 日期。');
  }
  return date;
}

function dateOnlyInTimeZone(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new ContentCampaignError('M5 每日入口当前时间无效。');
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year:'numeric',
      month:'2-digit',
      day:'2-digit',
    }).formatToParts(date);
  } catch {
    throw new ContentCampaignError(`M5 每日入口时区无效：${safeText(timeZone, 80)}。`);
  }
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

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

  async executeTool(input = {}, authentication = {}) {
    if (!this.toolExecutor?.execute) throw new ContentCampaignError('内容插件尚未通过安装门禁，工具调用保持关闭。');
    const caseItem = await this.getRawCase(input.campaignId);
    requireActiveGrant(caseItem, this.now());
    const {
      campaignId:_campaignId,
      campaignCaseId:_campaignCaseId,
      campaignCase:_campaignCase,
      campaignGrant:_campaignGrant,
      ...toolInput
    } = input;
    return this.toolExecutor.execute({
      ...toolInput,
      campaignCaseId:caseItem.id,
    }, authentication);
  }

  async executeHermesStage({ assignment, task } = {}) {
    const routineKey = String(task?.input?.context?.paperclipRoutineKey || '').trim();
    const contract = getM5RoutineExecutionContract(routineKey);
    if (!contract || contract.executionMode !== 'hermes') {
      throw new ContentCampaignError('当前 Paperclip 指派不是可由 Hermes 执行的 M5 阶段。');
    }
    if (contract.agentId !== assignment?.agentId || contract.taskType !== task?.taskType) {
      throw new ContentCampaignError('当前 Paperclip 身份与 M5 阶段执行契约不一致。');
    }
    if (
      contract.executionTool?.kind !== 'agent_army_mcp'
      || contract.executionTool.id !== 'm5_stage_execute'
      || (!contract.pluginEntryTool && !contract.deterministicEntry)
    ) {
      throw new ContentCampaignError(
        `M5 阶段 ${contract.stageKey} 必须调用 ${contract.executionTool?.id || '专用执行器'}，不能改走插件通用入口。`,
      );
    }
    const targetCaseId = safeId(
      task?.input?.context?.pipelineCaseId,
      '当前 M5 指派缺少可信 Pipeline Case。',
    );
    const chain = await this.caseChain(targetCaseId);
    const campaignCase = chain.at(-1);
    if (!campaignCase?.campaignGrant || campaignCase.parentCaseId) {
      throw new ContentCampaignError('当前 M5 子 Case 无法回溯到唯一活动授权父 Case。');
    }
    const outputs = [];
    let targetOutputs = [];
    for (const item of chain) {
      let itemOutputs;
      try {
        itemOutputs = await this.controlPlane.getCaseOutputs(item.id);
      } catch {
        throw new ContentCampaignError(
          `M5 ${contract.stageKey} 无法读取 Case ${item.id} 的 Work Product，已在工具调用前停止。`,
        );
      }
      if (item.id === targetCaseId) targetOutputs = itemOutputs;
      outputs.push(...itemOutputs);
    }
    const stageCandidates = m5StageWorkProductCandidates(targetOutputs, contract);
    const verifiedProducts = healthyM5StageWorkProducts(stageCandidates, contract);
    if (stageCandidates.length > 1) {
      throw new ContentCampaignError(
        `M5 ${contract.stageKey} 阶段存在多个 Work Product 候选或未解决漂移，拒绝重放时自动选择。`,
      );
    }
    if (stageCandidates.length === 1 && verifiedProducts.length !== 1) {
      throw m5WorkProductDrift(contract, '当前阶段 Work Product 候选结构、Provider 或状态无效');
    }
    if (verifiedProducts.length === 1) {
      await this.assertReplayableM5WorkProduct({
        contract,
        product:verifiedProducts[0],
        targetCaseId,
        projectId:(await this.requirePipeline()).projectId,
        assignment,
        task,
        outputs,
      });
      const routeExecution = m5HermesRouteExecution({
        assignment,
        task,
        contract,
        strategy:'verified_work_product_replay',
        toolIds:['agent-army.m5:verified-work-product-replay'],
        inputs:{
          workProductId:verifiedProducts[0].id || null,
          artifactHash:verifiedProducts[0].artifactHash || null,
        },
      });
      return {
        ...replayM5StageWorkProduct(contract, verifiedProducts[0]),
        routeExecution,
      };
    }
    if (contract.deterministicEntry === 'publish_receipt_verify') {
      const routeExecution = m5HermesRouteExecution({
        assignment,
        task,
        contract,
        strategy:m5HermesStrategy(task, contract),
        toolIds:['agent-army.m5:publish_receipt_verify'],
        inputs:{
          targetCase:routeCaseInput(chain[0]),
          outputHashes:routeOutputHashes(outputs),
        },
      });
      return {
        ...verifyPublishReceiptArtifact({
          contract,
          targetCase:chain[0],
          outputs,
        }),
        routeExecution,
      };
    }
    const parameters = await this.m5StageToolParameters({
      contract,
      campaignCase,
      targetCase:chain[0],
      outputs,
    });
    const routeExecution = m5HermesRouteExecution({
      assignment,
      task,
      contract,
      strategy:m5HermesStrategy(task, contract),
      toolIds:m5HermesStageToolIds(contract),
      inputs:parameters,
    });
    if (contract.stageKey === 'machine_review') {
      return executeM5Route(routeExecution, async () => ({
        ...await this.executeM5MachineReview({
          campaignCase,
          targetCase:chain[0],
          targetCaseId,
          outputs,
          parameters,
          sourceTaskId:task.taskId,
        }),
        routeExecution,
      }));
    }
    if (contract.stageKey === 'parallel_image_generation') {
      const receipt = await executeM5Route(routeExecution, () => this.executeTool({
          campaignId:campaignCase.id,
          caseId:targetCaseId,
          toolId:`${CONTENT_AUTONOMY_PLUGIN_KEY}:${contract.pluginEntryTool}`,
          parameters,
        }));
      const data = receipt?.data && typeof receipt.data === 'object' ? receipt.data : receipt;
      const providerReceipt = confirmedM5ProviderReceipt(data, 'image_generate');
      return {
        toolId:`${CONTENT_AUTONOMY_PLUGIN_KEY}:${contract.pluginEntryTool}`,
        pluginId:CONTENT_AUTONOMY_PLUGIN_KEY,
        content:'并行生图分支已生成一张受控竖屏补充画面。',
        artifact:{
          type:contract.expectedWorkProduct.artifactKinds[0],
          schemaVersion:contract.expectedWorkProduct.schemaVersion,
          data:{
            model:data?.model,
            seed:Number(data?.seed) || 0,
            relativePath:data?.relativePath,
            checksum:data?.checksum,
            bytes:Number(data?.bytes),
            providerReceipt,
          },
          validation:{ exists:true, readable:true, nonEmpty:true },
        },
        routeExecution,
      };
    }
    if (contract.stageKey === 'voice' && Array.isArray(parameters.voices)) {
      const receipts = await executeM5Route(routeExecution, () => Promise.all(
        parameters.voices.map(async (voiceParameters) => {
          const raw = await this.executeTool({
            campaignId:campaignCase.id,
            caseId:targetCaseId,
            toolId:`${CONTENT_AUTONOMY_PLUGIN_KEY}:${contract.pluginEntryTool}`,
            parameters:voiceParameters,
          });
          return confirmedM5VoiceVariant(raw, voiceParameters);
        }),
      ));
      const variants = Object.fromEntries(receipts.map((item) => [
        item.variantKey,
        item,
      ]));
      assertCompleteM5GrayVoiceVariants(variants);
      return {
        toolId:`${CONTENT_AUTONOMY_PLUGIN_KEY}:${contract.pluginEntryTool}`,
        pluginId:CONTENT_AUTONOMY_PLUGIN_KEY,
        content:'baseline 与 gray_douyin 两条受控旁白已分别生成并完成回执核验。',
        artifact:{
          type:contract.expectedWorkProduct.artifactKinds[0],
          schemaVersion:contract.expectedWorkProduct.schemaVersion,
          data:{
            ...variants.baseline,
            variantMode:'douyin_single_gray_v1',
            variants,
          },
          validation:{
            exists:true,
            readable:true,
            nonEmpty:true,
            variantLineageVerified:true,
          },
        },
        routeExecution,
      };
    }
    if (contract.stageKey === 'render') {
      const { receipts, socialCardPackage } = await executeM5Route(routeExecution, async () => {
        const receipts = await Promise.all(parameters.renders.map(async (render) => {
          const propsWrite = await this.executeTool({
            campaignId:campaignCase.id,
            caseId:targetCaseId,
            toolId:`${CONTENT_AUTONOMY_PLUGIN_KEY}:remotion-props-write`,
            parameters:{
              composition:render.composition,
              outputPath:render.propsPath,
              props:render.props,
            },
          });
          if (
            propsWrite?.propsPath !== render.propsPath
            || !/^sha256:[0-9a-f]{64}$/i.test(String(propsWrite?.checksum || ''))
          ) {
            throw new ContentCampaignError(
              `${render.composition} props 写入后没有返回同一路径和真实哈希，渲染未启动。`,
            );
          }
          const receipt = await this.executeTool({
            campaignId:campaignCase.id,
            caseId:targetCaseId,
            toolId:`${CONTENT_AUTONOMY_PLUGIN_KEY}:${contract.pluginEntryTool}`,
            parameters:{
              composition:render.composition,
              propsPath:render.propsPath,
              outputPath:render.outputPath,
            },
          });
          if (
            receipt?.composition !== render.composition
            || receipt?.propsPath !== render.propsPath
            || receipt?.outputPath !== render.outputPath
            || !/^sha256:[0-9a-f]{64}$/i.test(String(receipt?.checksum || ''))
            || !Number.isInteger(Number(receipt?.bytes))
            || Number(receipt.bytes) <= 0
          ) {
            throw new ContentCampaignError(`${render.composition} 没有返回匹配路径、真实哈希和字节数。`);
          }
          return {
            composition:receipt.composition,
            propsPath:receipt.propsPath,
            outputPath:receipt.outputPath,
            relativePath:receipt.outputPath,
            checksum:receipt.checksum,
            bytes:Number(receipt.bytes),
            ...(render.variantKey ? {
              variantKey:render.variantKey,
              scriptHash:render.scriptHash,
              audioHash:render.audioHash,
              templateBindingHash:render.templateBindingHash,
              voiceProviderActionId:render.voiceProviderActionId,
            } : {}),
            ...(Number.isFinite(Number(receipt.durationSeconds))
              ? { durationSeconds:Number(receipt.durationSeconds) }
              : {}),
          };
        }));
        const rawSocialCards = await this.executeTool({
          campaignId:campaignCase.id,
          caseId:targetCaseId,
          toolId:`${CONTENT_AUTONOMY_PLUGIN_KEY}:social-card-render`,
          parameters:parameters.socialCard,
        });
        const socialCardPackage = rawSocialCards?.data && typeof rawSocialCards.data === 'object'
          ? rawSocialCards.data
          : rawSocialCards;
        if (
          !validM5SocialCardPackageReceipt(socialCardPackage)
          || socialCardPackage.outputDir !== parameters.socialCard.outputDir
          || socialCardPackage.templateBindingHash
            !== parameters.socialCard.props.templateBinding.bindingHash
          || socialCardPackage.rightsBasis !== parameters.socialCard.props.rightsBasis
        ) {
          throw new ContentCampaignError('静态卡工具没有返回匹配的 1080×1440 PNG、哈希、模板与版权血缘。');
        }
        return { receipts, socialCardPackage };
      });
      const outputs = Object.fromEntries(receipts.map((receipt) => [
        renderPlatformKey(receipt.composition),
        receipt,
      ]));
      return {
        toolId:`${CONTENT_AUTONOMY_PLUGIN_KEY}:${contract.pluginEntryTool}`,
        pluginId:CONTENT_AUTONOMY_PLUGIN_KEY,
        content:'三份受控 M5 成片与小红书静态卡包已经生成并完成回执核验。',
        artifact:{
          type:contract.expectedWorkProduct.artifactKinds[0],
          schemaVersion:contract.expectedWorkProduct.schemaVersion,
          data:{
            outputs,
            socialCardPackage,
            ...outputs.master,
          },
          validation:{
            exists:true,
            readable:true,
            nonEmpty:true,
            fixedOutputsVerified:true,
            socialCardsVerified:true,
          },
        },
        routeExecution,
      };
    }
    return executeM5Route(routeExecution, async () => ({
      ...await this.executeTool({
        campaignId:campaignCase.id,
        caseId:targetCaseId,
        toolId:`${CONTENT_AUTONOMY_PLUGIN_KEY}:${contract.pluginEntryTool}`,
        parameters,
      }),
      routeExecution,
    }));
  }

  async caseChain(caseId) {
    const chain = [];
    const visited = new Set();
    let current = await this.getAnyCase(caseId);
    for (let depth = 0; depth < 32 && current?.id && !visited.has(current.id); depth += 1) {
      chain.push(current);
      visited.add(current.id);
      if (!current.parentCaseId) return chain;
      current = await this.getAnyCase(current.parentCaseId);
    }
    throw new ContentCampaignError('M5 Pipeline Case 父子链无效或存在循环。');
  }

  async assertReplayableM5WorkProduct({
    contract,
    product,
    targetCaseId,
    projectId,
    assignment,
    task,
    outputs = [],
    paperclipRuns = null,
  }) {
    const data = product?.artifact;
    const sourceRunId = String(product?.sourceRunId || '').trim();
    const sourceTaskId = String(product?.sourceTaskId || '').trim();
    const sourceIssueId = String(product?.sourceIssueId || '').trim();
    if (
      !product
      || !data
      || typeof data !== 'object'
      || Array.isArray(data)
      || product.pipelineCaseId !== targetCaseId
      || !String(projectId || '').trim()
      || product.projectId !== projectId
      || !sourceRunId
      || product?.createdByRunId !== sourceRunId
      || !sourceTaskId
      || sourceTaskId !== String(task?.taskId || '').trim()
      || !sourceIssueId
      || sourceIssueId !== String(assignment?.issueId || '').trim()
      || !validM5WorkProductArtifactHash(product)
    ) {
      throw m5WorkProductDrift(contract, 'Issue、Case、Project、source Run 或 artifactHash 不一致');
    }
    const sourceRuns = paperclipRuns == null
      ? await this.controlPlane.listIssueRuns(sourceIssueId).catch(() => [])
      : asList(paperclipRuns);
    const sourceRun = sourceRuns.find((run) =>
      String(run?.id || run?.runId || '').trim() === sourceRunId
    );
    if (!sourceRun || !['running', 'succeeded', 'completed'].includes(
      String(sourceRun.status || '').trim().toLowerCase(),
    )) {
      throw m5WorkProductDrift(contract, 'source Run 不属于同一 Issue 或状态不可复用');
    }
    const stageKey = contract.stageKey;
    if (stageKey === 'parallel_image_generation') {
      if (!verifiedM5GeneratedVisual(data)) {
        throw m5WorkProductDrift(contract, 'GeneratedImagePackage 字段无效');
      }
      await this.assertReplayProviderReceipt(data.providerReceipt, {
        operation:'image_generate',
        projectId,
        sourceRunId,
        sourceRun,
        contract,
      });
      await this.assertWorkspaceReplayFile(data.relativePath, data.checksum, data.bytes, contract);
    } else if (stageKey === 'voice') {
      if (
        data.model !== 'stepaudio-2.5-tts'
        || !safeWorkspaceRelativePath(data.relativePath)
        || !/^sha256:[0-9a-f]{64}$/i.test(String(data.checksum || ''))
      ) {
        throw m5WorkProductDrift(contract, 'VoicePackage 文件回执无效');
      }
      await this.assertReplayProviderReceipt(data.providerReceipt || data, {
        operation:'tts',
        projectId,
        sourceRunId,
        sourceRun,
        contract,
      });
      await this.assertWorkspaceReplayFile(data.relativePath, data.checksum, data.bytes, contract);
      if (data.variants != null) {
        const scriptPackage = artifactData(
          outputs.map(workProductArtifact).filter(Boolean),
          ['video_script_package', 'script_package'],
        );
        const scriptVariants = requireM5GrayScriptVariants(scriptPackage);
        assertCompleteM5GrayVoiceVariants(data.variants, scriptVariants);
        for (const variantKey of ['baseline', 'gray_douyin']) {
          const voiceVariant = data.variants[variantKey];
          await this.assertReplayProviderReceipt(voiceVariant.providerReceipt, {
            operation:'tts',
            projectId,
            sourceRunId,
            sourceRun,
            contract,
          });
          await this.assertWorkspaceReplayFile(
            voiceVariant.relativePath,
            voiceVariant.checksum,
            voiceVariant.bytes,
            contract,
          );
        }
      }
    } else if (stageKey === 'assets') {
      const assets = asList(data.assets);
      if (!assets.length) {
        throw m5WorkProductDrift(contract, 'AssetPackage 缺少可核验的真实资产');
      }
      for (const asset of assets) {
        await this.assertWorkspaceReplayFile(
          asset?.relativePath,
          asset?.checksum,
          asset?.bytes,
          contract,
        );
      }
    } else if (stageKey === 'visual_analysis') {
      await this.assertReplayProviderReceipt(data.providerReceipt, {
        operation:'vision',
        projectId,
        sourceRunId,
        sourceRun,
        contract,
      });
      await this.assertWorkspaceReplayFile(
        data.providerReceipt?.sourcePath,
        data.providerReceipt?.sourceChecksum,
        null,
        contract,
      );
    } else if (stageKey === 'render') {
      const artifacts = outputs.map(workProductArtifact).filter(Boolean);
      const scriptPackage = artifactData(
        artifacts,
        ['video_script_package', 'script_package'],
      );
      const voicePackage = artifactData(artifacts, ['voice_package']);
      const grayLineage = optionalM5GrayRenderLineage(scriptPackage, voicePackage);
      const baselineLineage = grayLineage
        ? null
        : optionalM5BaselineRenderLineage(scriptPackage, voicePackage);
      for (const platform of ['master', 'douyin', 'xiaohongshu']) {
        const output = data.outputs?.[platform];
        if (!output) throw m5WorkProductDrift(contract, `缺少 ${platform} 成片`);
        if (grayLineage) {
          assertM5RenderOutputLineage(output, grayLineage[platform], platform);
        } else if (hasM5VariantLineage(output)) {
          assertM5RenderOutputLineage(output, baselineLineage, platform);
        }
        await this.assertWorkspaceReplayFile(
          output.outputPath || output.relativePath,
          output.checksum,
          output.bytes,
          contract,
        );
      }
      if (data.socialCardPackage != null) {
        const socialCards = data.socialCardPackage;
        if (!validM5SocialCardPackageReceipt(socialCards)) {
          throw m5WorkProductDrift(contract, 'SocialCardPackage 字段无效');
        }
        await this.assertWorkspaceReplayFile(
          socialCards.propsPath,
          socialCards.propsChecksum,
          null,
          contract,
        );
        await this.assertWorkspaceReplayFile(
          socialCards.manifestPath,
          socialCards.manifestChecksum,
          null,
          contract,
        );
        for (const card of socialCards.cards) {
          await this.assertWorkspaceReplayFile(
            card.relativePath,
            card.checksum,
            card.bytes,
            contract,
          );
        }
      }
    } else if (stageKey === 'machine_review') {
      const review = data.reviewReport;
      const manifest = review?.evidence?.artifactPackage;
      if (review?.status !== 'passed' || asList(review?.failures).length) {
        throw m5WorkProductDrift(contract, 'MachineReview 未通过');
      }
      await this.assertWorkspaceReplayFile(
        manifest?.manifestPath,
        manifest?.manifestChecksum,
        null,
        contract,
      );
    } else if (stageKey === 'platform_adapt') {
      const version = data.contentVersion || data;
      await this.assertWorkspaceReplayFile(
        version.mediaPath,
        version.checksum,
        null,
        contract,
      );
    }
  }

  async assertWorkspaceReplayFile(relativePath, checksum, declaredBytes, contract) {
    try {
      return await assertM5WorkspaceArtifact({
        workspaceRoot:this.contentWorkspaceRoot,
        relativePath,
        checksum,
        declaredBytes,
      });
    } catch (error) {
      if (error instanceof M5WorkspaceArtifactError) {
        throw m5WorkProductDrift(contract, error.message);
      }
      throw error;
    }
  }

  async assertReplayProviderReceipt(value, {
    operation,
    projectId,
    sourceRunId,
    sourceRun,
    contract,
  }) {
    const receipt = assertReplayProviderReceipt(value, {
      operation,
      projectId,
      sourceRunId,
    });
    const expectedModel = M5_PROVIDER_MODELS[operation];
    const sourceAgentId = String(sourceRun?.agentId || '').trim();
    if (!expectedModel || !sourceAgentId || receipt.model !== expectedModel) {
      throw m5WorkProductDrift(contract, `StepFun ${operation} action 的固定模型或 source Agent 漂移`);
    }
    let verified;
    try {
      verified = await this.controlPlane.verifyProviderAction({
        actionId:receipt.actionId,
        costEventId:receipt.costCommit.costEventId,
        operation,
        runContext:{
          agentId:sourceAgentId,
          runId:sourceRunId,
          companyId:this.controlPlane.companyId,
          projectId,
        },
      });
    } catch {
      throw m5WorkProductDrift(
        contract,
        `StepFun ${operation} action 无法由内容插件原 Run 的只读 confirmed 状态证明`,
      );
    }
    const expectedCost = receipt.costCommit.costEvent.costCents;
    if (
      verified?.confirmed !== true
      || verified.actionId !== receipt.actionId
      || verified.costEventId !== receipt.costCommit.costEventId
      || verified.operation !== operation
      || verified.provider !== 'stepfun'
      || verified.model !== expectedModel
      || verified.projectId !== projectId
      || verified.heartbeatRunId !== sourceRunId
      || verified.costCents !== expectedCost
    ) {
      throw m5WorkProductDrift(
        contract,
        `StepFun ${operation} action 的权威 confirmed 回执不一致`,
      );
    }
    let activity;
    try {
      activity = await this.controlPlane.findCostActivity({
        costEventId:receipt.costCommit.costEventId,
      });
    } catch {
      throw m5WorkProductDrift(
        contract,
        `StepFun ${operation} action 无法从 Paperclip 核心费用活动反查`,
      );
    }
    if (
      !RECEIPT_ID.test(String(activity?.id || ''))
      || activity?.companyId !== this.controlPlane.companyId
      || !['user', 'agent'].includes(activity?.actorType)
      || !String(activity?.actorId || '').trim()
      || activity?.entityType !== 'cost_event'
      || activity?.entityId !== receipt.costCommit.costEventId
      || activity?.model !== expectedModel
      || Number(activity?.costCents) !== expectedCost
      || !Number.isFinite(Date.parse(String(activity?.createdAt || '')))
    ) {
      throw m5WorkProductDrift(
        contract,
        `StepFun ${operation} action 缺少唯一匹配的 Paperclip 核心费用事件`,
      );
    }
    return receipt;
  }

  async m5StageToolParameters({ contract, campaignCase, targetCase, outputs }) {
    const artifacts = outputs.map(workProductArtifact).filter(Boolean);
    if (contract.stageKey === 'parallel_image_generation') {
      const topic = artifactData(artifacts, ['topic_selection']);
      const theme = safeText(
        topic?.theme || topic?.title || targetCase?.theme || 'AI Agent 实战',
        120,
      );
      const core = safeText(topic?.coreConclusion || topic?.coreClaim || '', 220);
      if (!theme) {
        throw new ContentCampaignError('并行生图缺少可信 TopicSelection，未调用付费生图。');
      }
      return {
        actionId:`${targetCase.id}:image:v${positiveVersion(targetCase.version)}`,
        prompt:safeText(
          `竖屏视频补充画面，主题：${theme}。${core ? `核心表达：${core}。` : ''}简洁信息图风格，不含品牌、水印、真人和夸大数字。`,
          500,
        ),
        outputPath:`campaigns/${campaignCase.id}/${targetCase.id}/generated-visual.png`,
        seed:0,
        textMode:false,
      };
    }
    if (contract.stageKey === 'voice') {
      const script = artifactData(artifacts, ['video_script_package', 'script_package']);
      const scriptVariants = optionalM5GrayScriptVariants(script);
      if (scriptVariants) {
        assertM5GrayTargetBinding(scriptVariants.gray_douyin.templateBinding, targetCase);
        const voice = await this.firstOfficialTtsVoice();
        return {
          voices:['baseline', 'gray_douyin'].map((variantKey) => {
            const variant = scriptVariants[variantKey];
            return {
              variantKey,
              actionId:`${targetCase.id}:voice:${variantKey}:v${positiveVersion(targetCase.version)}`,
              text:variant.fullScript,
              scriptHash:variant.scriptHash,
              templateBinding:variant.templateBinding,
              voice,
              speed:1,
              outputPath:`campaigns/${campaignCase.id}/${targetCase.id}/voice-${variantKey.replaceAll('_', '-')}.mp3`,
            };
          }),
        };
      }
      const text = safeText(script?.fullScript || script?.script || script?.text, 1000);
      if (!text) throw new ContentCampaignError('配音阶段缺少可信 ScriptPackage.fullScript，未调用付费 TTS。');
      const voice = await this.firstOfficialTtsVoice();
      return {
        actionId:`${targetCase.id}:voice:v${positiveVersion(targetCase.version)}`,
        text,
        voice,
        speed:1,
        outputPath:`campaigns/${campaignCase.id}/${targetCase.id}/voice.mp3`,
      };
    }
    if (contract.stageKey === 'render') {
      const script = artifactData(artifacts, ['video_script_package', 'script_package']);
      const voice = artifactData(artifacts, ['voice_package']);
      const assetPackage = artifactData(artifacts, ['asset_package']);
      const generatedImage = artifactData(artifacts, ['generated_image_package']);
      const grayLineage = optionalM5GrayRenderLineage(script, voice);
      if (grayLineage) {
        assertM5GrayTargetBinding(
          grayLineage.douyin.templateBinding,
          targetCase,
        );
      }
      const voiceoverSrc = safeWorkspaceRelativePath(voice?.relativePath || voice?.outputPath);
      const generatedVisual = verifiedM5GeneratedVisual(generatedImage);
      const visualAssets = [
        generatedVisual,
        ...verifiedM5VisualAssets(assetPackage),
      ].filter(Boolean);
      if (
        !script?.fullScript
        || (!grayLineage && !voiceoverSrc)
        || (!grayLineage && !/^sha256:[0-9a-f]{64}$/i.test(String(voice?.checksum || '')))
        || !generatedVisual
        || visualAssets.length < 2
        || !String(assetPackage?.rightsBasis || '').trim()
      ) {
        throw new ContentCampaignError(
          '渲染阶段缺少可信 ScriptPackage、VoicePackage、GeneratedImagePackage 或带版权依据的真实 AssetPackage，拒绝白生成图片或用纯文字模板冒充混剪。',
        );
      }
      const baselineScript = grayLineage?.master?.script || script;
      const templateBinding = await resolveM5TemplateForRender({
        resolver:this.templateResolver,
        pipelineCaseId:targetCase.id,
        scriptBinding:grayLineage?.master?.templateBinding
          || script?.templateLifecycle?.templateBinding,
      });
      if (
        grayLineage
        && grayLineage.master.templateBinding.bindingHash !== templateBinding.bindingHash
      ) {
        throw new ContentCampaignError(
          'baseline 变体与当前生产模板决定不一致，拒绝以灰度模板覆盖 master 或小红书。',
        );
      }
      const baselineLineage = m5BaselineRenderLineage({
        script:baselineScript,
        voice:grayLineage ? voice.variants.baseline : voice,
        templateBinding,
      });
      return {
        socialCard:{
          outputDir:`campaigns/${campaignCase.id}/${targetCase.id}/social-cards`,
          props:buildM5SocialCardProps({
            script:baselineScript,
            visualAssets,
            templateBinding,
            rightsBasis:assetPackage.rightsBasis,
          }),
        },
        renders:[
          ['M5Master', 'master.mp4'],
          ['M5Douyin', 'douyin.mp4'],
          ['M5Xiaohongshu', 'xiaohongshu.mp4'],
        ].map(([composition, outputName]) => {
          const variant = m5RenderVariantDescriptor({
            composition,
            grayLineage,
            fallback:baselineLineage,
          });
          return {
            composition,
            propsPath:`campaigns/${campaignCase.id}/${targetCase.id}/${composition}.props.json`,
            outputPath:`campaigns/${campaignCase.id}/${targetCase.id}/${outputName}`,
            variantKey:variant.variantKey,
            scriptHash:variant.scriptHash,
            audioHash:variant.audioHash,
            templateBindingHash:variant.templateBinding?.bindingHash,
            voiceProviderActionId:variant.voiceProviderActionId,
            props:buildM5RenderProps({
              script:variant.script,
              voiceoverSrc:variant.voiceoverSrc,
              composition,
              visualAssets,
              templateBinding:variant.templateBinding,
              variantLineage:{
                variantKey:variant.variantKey,
                scriptHash:variant.scriptHash,
                audioHash:variant.audioHash,
                templateBindingHash:variant.templateBinding?.bindingHash,
                voiceProviderActionId:variant.voiceProviderActionId,
              },
            }),
          };
        }),
      };
    }
    if (contract.stageKey === 'machine_review') {
      const render = artifactData(artifacts, ['render_package']);
      const selectedRender = selectRenderOutput(
        render,
        String(targetCase?.platform || '').trim(),
      );
      const relativePath = safeWorkspaceRelativePath(
        selectedRender?.relativePath || selectedRender?.outputPath,
      );
      if (!relativePath) throw new ContentCampaignError('机器审核缺少可信 RenderPackage 相对路径。');
      return {
        relativePath,
        expectedDurationSeconds:boundedDurationSeconds(selectedRender?.durationSeconds),
      };
    }
    if (contract.stageKey === 'publish_approval') {
      const rawContentVersion = artifactData(artifacts, ['platform_content_draft', 'content_version']);
      const rawReviewReport = artifactData(artifacts, ['machine_review_report', 'machine_review']);
      const contentVersion = rawContentVersion?.contentVersion || rawContentVersion;
      const reviewReport = rawReviewReport?.reviewReport || rawReviewReport;
      if (!contentVersion || !reviewReport) {
        throw new ContentCampaignError('发布审批缺少可信 ContentVersion 或 MachineReview Work Product。');
      }
      return { contentVersion, reviewReport };
    }
    throw new ContentCampaignError(`M5 阶段 ${contract.stageKey} 没有受控插件参数生成器。`);
  }

  async executeM5MachineReview({
    campaignCase,
    targetCase,
    targetCaseId,
    outputs,
    parameters,
    sourceTaskId,
  }) {
    const artifacts = outputs.map(workProductArtifact).filter(Boolean);
    const renderPackage = artifactData(artifacts, ['render_package']);
    const scriptPackage = artifactData(artifacts, ['video_script_package', 'script_package']);
    const evidence = artifactData(artifacts, ['evidence_package']);
    const voicePackage = artifactData(artifacts, ['voice_package']);
    const assetPackage = artifactData(artifacts, ['asset_package']);
    const generatedImage = artifactData(artifacts, ['generated_image_package']);
    const visualAnalysis = artifactData(artifacts, ['visual_analysis_package']);
    const platform = String(targetCase?.platform || '').trim();
    const render = selectRenderOutput(renderPackage, platform);
    const grayLineage = optionalM5GrayRenderLineage(scriptPackage, voicePackage);
    const baselineLineage = grayLineage
      ? null
      : optionalM5BaselineRenderLineage(scriptPackage, voicePackage);
    const selectedLineage = grayLineage?.[platform]
      || (hasM5VariantLineage(render) ? baselineLineage : null);
    if (grayLineage) {
      assertM5RenderOutputLineage(render, selectedLineage, platform);
      if (
        platform === 'douyin'
        && (
          selectedLineage.templateBinding.grayTargetCaseId !== targetCaseId
          || selectedLineage.templateBinding.grayTargetDayCaseId !== targetCase?.parentCaseId
          || selectedLineage.templateBinding.grayTargetScheduledDate
            !== String(targetCase?.scheduledDate || '')
        )
      ) {
        throw new ContentCampaignError(
          '抖音灰度成片没有绑定当前平台 Case、日期父 Case和预约日期，机器审核已停止。',
        );
      }
    } else if (selectedLineage) {
      assertM5RenderOutputLineage(render, selectedLineage, platform);
    }
    const script = selectedLineage?.script || scriptPackage;
    const voice = selectedLineage
      ? voicePackage.variants[selectedLineage.variantKey]
      : voicePackage;
    const scheduledDate = String(targetCase?.scheduledDate || '').trim();
    const contentVersionId = deriveM5ContentVersionId({
      pipelineCaseId:targetCaseId,
      platform,
      mediaChecksum:render?.checksum,
    });
    const propsPath = safeWorkspaceRelativePath(render?.propsPath);
    if (
      !script?.fullScript
      || !evidence
      || !voice
      || !assetPackage
      || !generatedImage
      || !visualAnalysis
      || !contentVersionId
      || !propsPath
    ) {
      throw new ContentCampaignError(
        '机器审核缺少同一 Case 的 ScriptPackage、EvidencePackage、AssetPackage、GeneratedImagePackage、VisualAnalysisPackage、RenderPackage 哈希或 props，未生成审核产物。',
      );
    }
    const providerProvenance = m5ProviderProvenance({
      generatedImage,
      visualAnalysis,
      voice,
      allowLocalFixtureProvenance:this.allowLocalFixtureProvenance,
    });
    const media = await this.executeTool({
      campaignId:campaignCase.id,
      caseId:targetCaseId,
      toolId:`${CONTENT_AUTONOMY_PLUGIN_KEY}:media-validate`,
      parameters,
    });
    const subtitles = await this.executeTool({
      campaignId:campaignCase.id,
      caseId:targetCaseId,
      toolId:`${CONTENT_AUTONOMY_PLUGIN_KEY}:subtitle-layout-validate`,
      parameters:{ propsPath },
    });
    const checks = deterministicM5ReviewChecks({
      campaignCase,
      targetCase,
      render,
      script,
      evidence,
      voice,
      assetPackage,
      generatedImage,
      media,
      subtitles,
    });
    const failures = Object.entries(checks)
      .filter(([, passed]) => passed !== true)
      .map(([check]) => check);
    const reviewReport = {
      status:failures.length ? 'failed' : 'passed',
      contentVersionId,
      variantLineage:{
        variantKey:selectedLineage?.variantKey || 'baseline',
        scriptHash:selectedLineage?.scriptHash || m5ScriptHash(script.fullScript),
        templateBindingHash:selectedLineage?.templateBinding?.bindingHash
          || script?.templateLifecycle?.templateBinding?.bindingHash
          || script?.templateBinding?.bindingHash
          || null,
        renderChecksum:render.checksum,
      },
      checks,
      failures,
      checkedAt:this.now().toISOString(),
      evidence:{
        mediaValidation:{
          relativePath:media.relativePath || parameters.relativePath,
          errors:Array.isArray(media.errors) ? media.errors.slice(0, 20) : [],
        },
        subtitleLayout:{
          propsPath:subtitles.propsPath || propsPath,
          errors:Array.isArray(subtitles.errors) ? subtitles.errors.slice(0, 20) : [],
        },
        factBindingCount:Array.isArray(script.factBindings) ? script.factBindings.length : 0,
        sourceCount:Array.isArray(evidence.sources) ? evidence.sources.length : 0,
        renderPolicy:'m5-verified-assets-and-official-voice-v2',
      },
    };
    if (!failures.length) {
      const copies = {
        douyin:platform === 'douyin'
          ? buildM5PlatformCopy(script, 'douyin')
          : null,
        xiaohongshu:platform === 'xiaohongshu'
          ? buildM5PlatformCopy(script, 'xiaohongshu')
          : null,
      };
      const lineage = {
        schemaVersion:1,
        contentVersionId,
        sourceTaskId:String(sourceTaskId || targetCaseId),
        generatedBy:'reviewer',
        createdAt:this.now().toISOString(),
        parents:[],
      };
      const packageResult = await this.executeTool({
        campaignId:campaignCase.id,
        caseId:targetCaseId,
        toolId:`${CONTENT_AUTONOMY_PLUGIN_KEY}:artifact-package-write`,
        parameters:{
          outputDir:`campaigns/${campaignCase.id}/${targetCaseId}/package`,
          videos:m5ArtifactPackageVideos(renderPackage),
          copies,
          coverSourcePath:generatedImage.relativePath,
          sources:m5SourcesLedger({
            evidence,
            assetPackage,
            generatedImage,
            voice,
            fixtureProvenance:providerProvenance.fixtureProvenance,
          }),
          review:{
            schemaVersion:1,
            passed:true,
            failures:[],
            checks:{
              ...checks,
              subtitleLayout:{ passed:subtitles?.passed === true },
            },
          },
          lineage,
          ...(providerProvenance.actionRefs
            ? { providerActionRefs:providerProvenance.actionRefs }
            : {}),
        },
      });
      if (
        !safeWorkspaceRelativePath(packageResult?.manifestPath)
        || !/^sha256:[0-9a-f]{64}$/i.test(String(packageResult?.manifestChecksum || ''))
      ) {
        throw new ContentCampaignError('固定产物包没有返回可信 manifest 路径和哈希。');
      }
      const lineageValidation = await this.executeTool({
        campaignId:campaignCase.id,
        caseId:targetCaseId,
        toolId:`${CONTENT_AUTONOMY_PLUGIN_KEY}:artifact-lineage-validate`,
        parameters:{ manifestPath:packageResult.manifestPath },
      });
      if (lineageValidation?.passed !== true) {
        throw new ContentCampaignError(
          `固定产物清单或血缘校验失败：${asList(lineageValidation?.errors).join('；') || '未知错误'}。`,
        );
      }
      reviewReport.evidence.artifactPackage = {
        manifestPath:packageResult.manifestPath,
        manifestChecksum:packageResult.manifestChecksum,
        requiredArtifacts:asList(lineageValidation.requiredArtifacts),
      };
    }
    return {
      toolId:`${CONTENT_AUTONOMY_PLUGIN_KEY}:media-validate`,
      pluginId:CONTENT_AUTONOMY_PLUGIN_KEY,
      content:failures.length
        ? `机器审核未通过：${failures.join('、')}。`
        : '机器审核七项门禁全部通过。',
      artifact:{
        type:'machine_review_report',
        schemaVersion:'agent.army/machine-review/v1',
        data:{ reviewReport },
        validation:{
          exists:true,
          readable:true,
          nonEmpty:true,
          allChecksPassed:failures.length === 0,
        },
      },
    };
  }

  async firstOfficialTtsVoice() {
    const voice = safeText(await this.controlPlane.getOfficialTtsVoice().catch(() => null), 120);
    if (!voice || /clone|克隆|复刻/i.test(voice)) {
      throw new ContentCampaignError('内容插件没有登记可用的官方 TTS 音色。');
    }
    return voice;
  }

  async getPublishReceipt(receiptId) {
    if (!this.publisher?.getReceipt) throw new ContentCampaignError('Publisher Gateway 尚未启用，当前没有可读取的发布凭证。');
    return this.publisher.getReceipt(safeReceiptId(receiptId));
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

function asList(value) {
  return Array.isArray(value) ? value : [];
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

function safeId(value, message) {
  const id = String(value || '').trim();
  if (!CASE_ID.test(id)) throw new ContentCampaignError(message);
  return id;
}

function safeReceiptId(value) {
  const id = String(value || '').trim();
  if (!RECEIPT_ID.test(id)) throw new ContentCampaignError('发布凭证标识无效。');
  return id;
}

function safeOpaqueId(value) {
  const id = String(value || '').trim();
  return /^[a-z0-9][a-z0-9_-]{2,127}$/i.test(id) ? id : null;
}

function workProductArtifact(output) {
  const artifactHash = String(output?.artifactHash || '');
  const sourceTaskId = String(output?.sourceTaskId || '').trim();
  const sourceArtifactId = String(output?.sourceArtifactId || '').trim();
  if (
    output?.recordKind !== 'work_product'
    || output?.type !== 'artifact'
    || !['agent-army.ajun-runtime', 'agent-army.content-autonomy', 'agent-army.publisher-gateway']
      .includes(output?.provider)
    || output?.sourceTrust != null
    || output?.status !== 'active'
    || output?.healthStatus !== 'healthy'
    || !/^agent\.army\/[a-z0-9-]+\/v\d+$/i.test(String(output?.schemaVersion || ''))
    || sourceTaskId.length === 0
    || sourceTaskId.length > 240
    || sourceArtifactId.length === 0
    || sourceArtifactId.length > 240
    || !/^sha256:[0-9a-f]{64}$/i.test(artifactHash)
    || (output.externalId && output.externalId !== artifactHash)
  ) return null;
  const value = output?.artifact?.data || output?.artifact || output?.receipt;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return {
    kind:String(
      output.artifactKind
      || output.artifact?.type
      || snakeKind(output.kind),
    ).trim(),
    data:value,
  };
}

function replayM5StageWorkProduct(contract, product) {
  const artifactKind = contract.expectedWorkProduct.artifactKinds[0];
  const data = structuredClone(
    product?.artifact
      || product?.contentVersion
      || product?.reviewReport
      || {},
  );
  return {
    toolId:contract.deterministicEntry === 'publish_receipt_verify'
      ? 'agent-army.m5:publish_receipt_verify'
      : `${CONTENT_AUTONOMY_PLUGIN_KEY}:${contract.pluginEntryTool}`,
    pluginId:contract.deterministicEntry === 'publish_receipt_verify'
      ? 'agent-army.m5-deterministic'
      : CONTENT_AUTONOMY_PLUGIN_KEY,
    content:`已复用当前 Case 的已验证 ${contract.expectedWorkProduct.type}，未再次执行阶段工具。`,
    artifact:{
      type:artifactKind,
      schemaVersion:contract.expectedWorkProduct.schemaVersion,
      data,
      validation:{
        exists:true,
        readable:true,
        nonEmpty:true,
        paperclipWorkProductVerified:true,
      },
    },
    replayed:true,
  };
}

function artifactData(artifacts, kinds) {
  const accepted = new Set(kinds);
  return artifacts.find((artifact) => accepted.has(artifact.kind))?.data || null;
}

function verifyPublishReceiptArtifact({ contract, targetCase, outputs }) {
  const receipts = outputs
    .filter((output) =>
      output?.recordKind === 'work_product'
      && output?.type === 'artifact'
      && output?.provider === 'agent-army.publisher-gateway'
      && output?.sourceTrust == null
      && output?.status === 'active'
      && output?.healthStatus === 'healthy'
      && output?.schemaVersion === 'agent.army/publish-receipt/v1'
      && output?.kind === 'PublishReceipt',
    )
    .map((output) => output.receipt)
    .filter((receipt) => receipt && typeof receipt === 'object' && !Array.isArray(receipt));
  if (receipts.length !== 1) {
    throw new ContentCampaignError(`发布核验必须且只能读取一个可信 PublishReceipt，当前为 ${receipts.length} 个。`);
  }
  const receipt = receipts[0];
  const platform = String(targetCase?.platform || '').trim();
  const scheduledDate = String(targetCase?.scheduledDate || '').trim();
  if (
    !RECEIPT_ID.test(String(receipt.receiptId || ''))
    || receipt.platform !== platform
    || receipt.scheduledDate !== scheduledDate
    || !String(receipt.contentVersionId || '').trim()
    || !/^(?:sha256:)?[0-9a-f]{64}$/i.test(String(receipt.contentChecksum || ''))
    || !String(receipt.externalContentId || '').trim()
    || !String(receipt.evidence || '').trim()
    || !Number.isFinite(Date.parse(receipt.publishedAt))
  ) {
    throw new ContentCampaignError('PublishReceipt 与当前 Case 不一致或缺少平台内容ID、成功证据、版本血缘。');
  }
  const data = {
    status:'passed',
    receiptId:receipt.receiptId,
    platform,
    scheduledDate,
    contentVersionId:receipt.contentVersionId,
    contentChecksum:receipt.contentChecksum,
    externalContentId:receipt.externalContentId,
    evidence:receipt.evidence,
    publishedAt:receipt.publishedAt,
  };
  return {
    toolId:'agent-army.m5:publish_receipt_verify',
    pluginId:'agent-army.m5-deterministic',
    content:'发布凭证与当前 Case 已完成确定性核验。',
    artifact:{
      type:contract.expectedWorkProduct.artifactKinds[0],
      schemaVersion:contract.expectedWorkProduct.schemaVersion,
      data,
      validation:{ exists:true, readable:true, nonEmpty:true, receiptVerified:true },
    },
  };
}

function snakeKind(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-z0-9]+/gi, '_')
    .toLowerCase()
    .replace(/^_+|_+$/g, '');
}

function safeWorkspaceRelativePath(value) {
  const relative = String(value || '').trim().replaceAll('\\', '/');
  if (
    !relative
    || relative.startsWith('/')
    || relative.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) return null;
  return relative;
}

function positiveVersion(value) {
  const version = Number(value);
  return Number.isInteger(version) && version > 0 ? version : 1;
}

function boundedDurationSeconds(value) {
  const duration = Number(value);
  return Number.isFinite(duration) && duration >= 1 && duration <= 600 ? duration : 45;
}

function renderPlatformKey(composition) {
  if (composition === 'M5Master') return 'master';
  if (composition === 'M5Douyin') return 'douyin';
  if (composition === 'M5Xiaohongshu') return 'xiaohongshu';
  throw new ContentCampaignError('M5 RenderPackage 包含未知 Composition。');
}

function selectRenderOutput(renderPackage, platform) {
  const selected = renderPackage?.outputs?.[platform];
  return selected && typeof selected === 'object' && !Array.isArray(selected)
    ? selected
    : renderPackage;
}

function verifiedM5VisualAssets(assetPackage) {
  const assets = Array.isArray(assetPackage?.assets) ? assetPackage.assets : [];
  return assets.slice(0, 12).flatMap((asset) => {
    const relativePath = safeWorkspaceRelativePath(asset?.relativePath);
    const checksum = String(asset?.checksum || '').trim().toLowerCase();
    if (
      !relativePath
      || !/\.(?:jpe?g|png|webp)$/i.test(relativePath)
      || !/^sha256:[0-9a-f]{64}$/i.test(checksum)
      || !Number.isInteger(Number(asset?.bytes))
      || Number(asset.bytes) <= 0
    ) return [];
    return [{
      frameId:safeText(asset?.frameId, 80) || 'verified-frame',
      relativePath,
      checksum,
      bytes:Number(asset.bytes),
    }];
  });
}

function verifiedM5GeneratedVisual(generatedImage) {
  const relativePath = safeWorkspaceRelativePath(generatedImage?.relativePath);
  const checksum = String(generatedImage?.checksum || '').trim().toLowerCase();
  if (
    generatedImage?.model !== 'step-image-edit-2'
    || !relativePath
    || !/\.(?:jpe?g|png|webp)$/i.test(relativePath)
    || !/^sha256:[0-9a-f]{64}$/i.test(checksum)
    || !Number.isInteger(Number(generatedImage?.bytes))
    || Number(generatedImage.bytes) <= 0
  ) return null;
  return {
    frameId:'stepfun-generated-visual',
    relativePath,
    checksum,
    bytes:Number(generatedImage.bytes),
  };
}

function m5ArtifactPackageVideos(renderPackage) {
  const expected = ['master', 'douyin', 'xiaohongshu'];
  const videos = Object.fromEntries(expected.map((platform) => {
    const render = renderPackage?.outputs?.[platform];
    const relativePath = safeWorkspaceRelativePath(render?.relativePath || render?.outputPath);
    const checksum = String(render?.checksum || '').trim().toLowerCase();
    if (!relativePath || !/^sha256:[0-9a-f]{64}$/i.test(checksum)) {
      throw new ContentCampaignError(`固定产物包缺少可信 ${platform} 成片回执。`);
    }
    return [platform, { path:relativePath, checksum }];
  }));
  return videos;
}

function m5SourcesLedger({
  evidence,
  assetPackage,
  generatedImage,
  voice,
  fixtureProvenance = null,
}) {
  const sources = asList(evidence?.sources).slice(0, 50).map((source, index) => ({
    ref:safeText(
      source?.url || source?.source || source?.ref || source?.sourceId || `source-${index + 1}`,
      500,
    ),
    kind:safeText(source?.kind || source?.sourceType || 'verified_source', 80),
    fetchedAt:safeText(source?.fetchedAt, 120),
    contentHash:safeText(source?.contentHash, 80),
  })).filter((source) => source.ref && source.kind);
  if (
    sources.length < 2
    || sources.some((source) =>
      source.kind === 'github_metadata'
      || !Number.isFinite(Date.parse(source.fetchedAt))
      || !/^(?:sha256:)?[0-9a-f]{64}$/i.test(source.contentHash)
    )
  ) {
    throw new ContentCampaignError('固定产物来源账本至少需要两个可信来源。');
  }
  const sourceUrl = safeText(assetPackage?.sourceUrl, 500);
  const rightsBasis = safeText(assetPackage?.rightsBasis, 200);
  const generatedVisual = verifiedM5GeneratedVisual(generatedImage);
  const narrationPath = safeWorkspaceRelativePath(voice?.relativePath || voice?.outputPath);
  if (!generatedVisual || !narrationPath) {
    throw new ContentCampaignError('固定产物来源账本缺少可信生成图片或旁白路径。');
  }
  if (fixtureProvenance) {
    return {
      sources,
      thirdPartyMedia:sourceUrl
        ? [{ ref:sourceUrl, rightsBasis }]
        : [],
      aiGeneratedMedia:[],
      fixtureProvenance,
    };
  }
  return {
    sources,
    thirdPartyMedia:sourceUrl
      ? [{ ref:sourceUrl, rightsBasis }]
      : [],
    aiGeneratedMedia:[{
      ref:generatedVisual.relativePath,
      sourceChecksum:generatedVisual.checksum,
      model:generatedImage.model,
    }],
    narration:{
      provider:'StepFun',
      model:voice.model,
      checksum:String(voice.checksum || '').trim().toLowerCase(),
      ref:narrationPath,
    },
  };
}

function m5ProviderProvenance({
  generatedImage,
  visualAnalysis,
  voice,
  allowLocalFixtureProvenance,
}) {
  const stepFunDeclared = generatedImage?.model === 'step-image-edit-2'
    || voice?.model === 'stepaudio-2.5-tts'
    || asList(visualAnalysis?.insights).some((item) =>
      item?.evidenceKind === 'stepfun_vision_frame')
    || visualAnalysis?.providerReceipt?.model === 'step-1o-turbo-vision';
  if (!stepFunDeclared) return { actionRefs:null, fixtureProvenance:null };
  const fixtureEntries = [generatedImage, visualAnalysis, voice]
    .map((item) => item?.fixtureProvenance);
  if (
    allowLocalFixtureProvenance
    && fixtureEntries.every(validM5FixtureProvenance)
    && new Set(fixtureEntries.map((item) => item.fixtureId)).size === 1
  ) {
    return {
      actionRefs:null,
      fixtureProvenance:{
        kind:'local_fixture',
        fixtureId:fixtureEntries[0].fixtureId,
        externalSideEffects:0,
      },
    };
  }
  let image;
  let vision;
  let tts;
  try {
    image = confirmedM5ProviderReceipt(generatedImage?.providerReceipt, 'image_generate');
    vision = confirmedM5ProviderReceipt(visualAnalysis?.providerReceipt, 'vision');
    tts = confirmedM5ProviderReceipt(voice?.providerReceipt || voice, 'tts');
  } catch {
    throw new ContentCampaignError(
      '机器审核发现 StepFun 图片、视觉或配音，但缺少可由内容插件同 Project 状态反查的三条 confirmed action/cost 血缘；活动保持 blocked。',
    );
  }
  return {
    actionRefs:{
      image:image.actionId,
      vision:vision.actionId,
      tts:tts.actionId,
    },
    fixtureProvenance:null,
  };
}

function confirmedM5ProviderReceipt(value, expectedOperation) {
  const actionId = String(value?.actionId || '').trim();
  const operation = String(value?.operation || '').trim();
  const callRecord = value?.callRecord;
  const costCommit = value?.costCommit;
  const expectedModel = M5_PROVIDER_MODELS[expectedOperation];
  if (
    !expectedModel
    || !/^[A-Za-z0-9:_-]{8,160}$/.test(actionId)
    || operation !== expectedOperation
    || value?.model !== expectedModel
    || callRecord?.actionId !== actionId
    || callRecord?.operation !== expectedOperation
    || callRecord?.model !== expectedModel
    || !/^sha256:[0-9a-f]{64}$/i.test(String(callRecord?.promptChecksum || ''))
    || costCommit?.status !== 'confirmed'
    || !RECEIPT_ID.test(String(costCommit?.costEventId || ''))
    || costCommit?.costEvent?.provider !== 'stepfun'
    || !Number.isInteger(Number(costCommit?.costEvent?.costCents))
    || Number(costCommit.costEvent.costCents) <= 0
  ) {
    throw new ContentCampaignError(`StepFun ${expectedOperation} 回执尚未确认费用或血缘字段不完整。`);
  }
  return {
    actionId,
    operation,
    model:value.model,
    callRecord:{
      actionId,
      operation,
      model:value.model,
      promptChecksum:String(callRecord.promptChecksum).toLowerCase(),
      ...(callRecord.costEvent && typeof callRecord.costEvent === 'object' ? {
        costEvent:{
          provider:'stepfun',
          projectId:String(callRecord.costEvent.projectId || '').trim(),
          heartbeatRunId:String(callRecord.costEvent.heartbeatRunId || '').trim(),
          costCents:Number(callRecord.costEvent.costCents),
        },
      } : {}),
    },
    costCommit:{
      status:'confirmed',
      costEventId:String(costCommit.costEventId),
      costEvent:{
        provider:'stepfun',
        projectId:String(costCommit.costEvent.projectId || '').trim(),
        heartbeatRunId:String(costCommit.costEvent.heartbeatRunId || '').trim(),
        costCents:Number(costCommit.costEvent.costCents),
      },
    },
  };
}

function assertReplayProviderReceipt(value, { operation, projectId, sourceRunId }) {
  let receipt;
  try {
    receipt = confirmedM5ProviderReceipt(value, operation);
  } catch {
    throw m5WorkProductDrift(
      { stageKey:operation },
      `StepFun ${operation} action 不是 confirmed`,
    );
  }
  const callCost = receipt.callRecord?.costEvent;
  const commitCost = receipt.costCommit?.costEvent;
  if (
    callCost?.provider !== 'stepfun'
    || commitCost?.provider !== 'stepfun'
    || callCost.projectId !== projectId
    || commitCost.projectId !== projectId
    || callCost.heartbeatRunId !== sourceRunId
    || commitCost.heartbeatRunId !== sourceRunId
    || callCost.costCents !== commitCost.costCents
  ) {
    throw m5WorkProductDrift(
      { stageKey:operation },
      `StepFun ${operation} action 的 Project、source Run 或费用状态漂移`,
    );
  }
  return receipt;
}

function m5WorkProductDrift(contract, detail) {
  const error = new ContentCampaignError(
    `M5 ${contract?.stageKey || '阶段'} Work Product 漂移：${detail}；禁止重放或覆盖。`,
  );
  error.code = 'work_product_drift';
  error.retryable = false;
  return error;
}

function validM5FixtureProvenance(value) {
  return value?.kind === 'local_fixture'
    && /^[A-Za-z0-9:_-]{8,120}$/.test(String(value?.fixtureId || ''))
    && value?.externalSideEffects === 0;
}

function optionalM5GrayScriptVariants(scriptPackage) {
  const variants = scriptPackage?.variants;
  if (variants == null) return null;
  if (!variants || typeof variants !== 'object' || Array.isArray(variants)) {
    throw new ContentCampaignError('ScriptPackage variants 必须是受控对象。');
  }
  const keys = Object.keys(variants).sort();
  if (keys.length === 1 && keys[0] === 'baseline') return null;
  return requireM5GrayScriptVariants(scriptPackage);
}

function requireM5GrayScriptVariants(scriptPackage) {
  const variants = scriptPackage?.variants;
  if (
    !variants
    || typeof variants !== 'object'
    || Array.isArray(variants)
    || JSON.stringify(Object.keys(variants).sort())
      !== JSON.stringify(['baseline', 'gray_douyin'])
  ) {
    throw new ContentCampaignError(
      '灰度 ScriptPackage 必须且只能包含 baseline 与 gray_douyin 两条完整变体。',
    );
  }
  const baseline = validM5ScriptVariant(variants.baseline, 'baseline');
  const gray = validM5ScriptVariant(variants.gray_douyin, 'gray_douyin');
  const topLevelBinding = scriptPackage?.templateLifecycle?.templateBinding;
  if (
    scriptPackage.fullScript !== baseline.fullScript
    || !sameTemplateBinding(topLevelBinding, baseline.templateBinding)
    || baseline.templateBinding.source === 'approved_single_gray'
    || baseline.templateBinding.grayRelease === true
    || gray.templateBinding.source !== 'approved_single_gray'
    || gray.templateBinding.grayRelease !== true
    || gray.templateBinding.applicationScope !== 'full_content_variant'
    || baseline.scriptHash === gray.scriptHash
    || baseline.templateBinding.bindingHash === gray.templateBinding.bindingHash
  ) {
    throw new ContentCampaignError(
      '灰度 ScriptPackage 的 baseline 顶层兼容、模板范围或真实脚本差异不符合契约。',
    );
  }
  return { baseline, gray_douyin:gray };
}

function validM5ScriptVariant(value, expectedKey) {
  const fullScript = String(value?.fullScript || '');
  const expectedHash = m5ScriptHash(fullScript);
  if (
    value?.variantKey !== expectedKey
    || !safeText(fullScript, 1000)
    || value?.scriptHash !== expectedHash
    || !validM5ProductionTemplateBinding(value?.templateBinding)
  ) {
    throw new ContentCampaignError(`ScriptPackage ${expectedKey} 变体缺少可信脚本、哈希或模板绑定。`);
  }
  return value;
}

function m5ScriptHash(fullScript) {
  return `sha256:${crypto.createHash('sha256')
    .update(String(fullScript || ''))
    .digest('hex')}`;
}

function assertM5GrayTargetBinding(binding, targetCase) {
  if (
    binding?.source !== 'approved_single_gray'
    || binding?.grayRelease !== true
    || binding?.applicationScope !== 'full_content_variant'
    || binding?.grayTargetPlatform !== 'douyin'
    || binding?.grayTargetDayCaseId !== targetCase?.id
    || binding?.grayTargetScheduledDate !== String(targetCase?.scheduledDate || '')
    || !CASE_ID.test(String(binding?.grayTargetCaseId || ''))
  ) {
    throw new ContentCampaignError(
      'gray_douyin 模板没有同时绑定当前日期 Case、预约日期和抖音平台 Case。',
    );
  }
}

function confirmedM5VoiceVariant(value, expected) {
  const data = value?.data && typeof value.data === 'object' ? value.data : value;
  const providerReceipt = confirmedM5ProviderReceipt(data, 'tts');
  if (
    providerReceipt.actionId !== expected.actionId
    || data?.model !== 'stepaudio-2.5-tts'
    || data?.voice !== expected.voice
    || data?.relativePath !== expected.outputPath
    || !/^sha256:[0-9a-f]{64}$/i.test(String(data?.checksum || ''))
    || !Number.isInteger(Number(data?.bytes))
    || Number(data.bytes) <= 0
  ) {
    throw new ContentCampaignError(
      `${expected.variantKey} 配音没有返回匹配动作、官方音色、路径、哈希或字节数。`,
    );
  }
  return {
    variantKey:expected.variantKey,
    scriptHash:expected.scriptHash,
    templateBinding:expected.templateBinding,
    model:data.model,
    voice:data.voice,
    relativePath:data.relativePath,
    checksum:String(data.checksum).toLowerCase(),
    audioHash:String(data.checksum).toLowerCase(),
    bytes:Number(data.bytes),
    providerReceipt,
  };
}

function assertCompleteM5GrayVoiceVariants(variants, scriptVariants = null) {
  if (
    !variants
    || typeof variants !== 'object'
    || Array.isArray(variants)
    || JSON.stringify(Object.keys(variants).sort())
      !== JSON.stringify(['baseline', 'gray_douyin'])
  ) {
    throw new ContentCampaignError(
      '灰度 VoicePackage 必须且只能包含 baseline 与 gray_douyin 两条独立音频。',
    );
  }
  for (const variantKey of ['baseline', 'gray_douyin']) {
    const voice = variants[variantKey];
    const script = scriptVariants?.[variantKey];
    let providerReceipt = null;
    try {
      providerReceipt = confirmedM5ProviderReceipt(voice?.providerReceipt, 'tts');
    } catch {
      // 统一由下面的变体契约错误关闭，避免接受无Provider费用血缘的音频。
    }
    if (
      voice?.variantKey !== variantKey
      || !/^sha256:[0-9a-f]{64}$/i.test(String(voice?.scriptHash || ''))
      || !safeWorkspaceRelativePath(voice?.relativePath)
      || !/^sha256:[0-9a-f]{64}$/i.test(String(voice?.checksum || ''))
      || voice.audioHash !== voice.checksum
      || !Number.isInteger(Number(voice?.bytes))
      || Number(voice.bytes) <= 0
      || voice.model !== 'stepaudio-2.5-tts'
      || !String(voice.voice || '').trim()
      || !validM5ProductionTemplateBinding(voice.templateBinding)
      || providerReceipt?.actionId !== voice.providerReceipt?.actionId
      || (script && (
        voice.scriptHash !== script.scriptHash
        || !sameTemplateBinding(voice.templateBinding, script.templateBinding)
      ))
    ) {
      throw new ContentCampaignError(
        `VoicePackage ${variantKey} 无法回到同一脚本、模板、音频哈希和Provider回执。`,
      );
    }
  }
  if (
    variants.baseline.scriptHash === variants.gray_douyin.scriptHash
    || variants.baseline.audioHash === variants.gray_douyin.audioHash
    || variants.baseline.providerReceipt?.actionId
      === variants.gray_douyin.providerReceipt?.actionId
  ) {
    throw new ContentCampaignError('灰度 VoicePackage 两条变体没有独立脚本、音频或Provider动作。');
  }
  return variants;
}

function optionalM5GrayRenderLineage(scriptPackage, voicePackage) {
  const scriptVariants = optionalM5GrayScriptVariants(scriptPackage);
  const hasVoiceVariants = voicePackage?.variants != null;
  if (!scriptVariants && !hasVoiceVariants) return null;
  if (!scriptVariants || !hasVoiceVariants) {
    throw new ContentCampaignError(
      '灰度渲染要求 ScriptPackage 与 VoicePackage 同时包含完整双变体，禁止半包或跨接。',
    );
  }
  const voiceVariants = assertCompleteM5GrayVoiceVariants(
    voicePackage.variants,
    scriptVariants,
  );
  if (
    voicePackage.variantKey !== 'baseline'
    || voicePackage.scriptHash !== voiceVariants.baseline.scriptHash
    || voicePackage.audioHash !== voiceVariants.baseline.audioHash
    || voicePackage.checksum !== voiceVariants.baseline.checksum
  ) {
    throw new ContentCampaignError('VoicePackage 顶层必须精确镜像 baseline 以保持普通链兼容。');
  }
  const item = (variantKey) => ({
    variantKey,
    script:scriptVariants[variantKey],
    scriptHash:scriptVariants[variantKey].scriptHash,
    voiceoverSrc:voiceVariants[variantKey].relativePath,
    audioHash:voiceVariants[variantKey].audioHash,
    templateBinding:scriptVariants[variantKey].templateBinding,
    voiceProviderActionId:voiceVariants[variantKey].providerReceipt.actionId,
  });
  return {
    master:item('baseline'),
    xiaohongshu:item('baseline'),
    douyin:item('gray_douyin'),
  };
}

function optionalM5BaselineRenderLineage(scriptPackage, voicePackage) {
  if (!scriptPackage?.fullScript || !voicePackage) return null;
  const templateBinding = scriptPackage?.templateLifecycle?.templateBinding
    || scriptPackage?.templateBinding;
  if (!validM5ProductionTemplateBinding(templateBinding)) return null;
  return m5BaselineRenderLineage({
    script:scriptPackage,
    voice:voicePackage,
    templateBinding,
  });
}

function m5BaselineRenderLineage({ script, voice, templateBinding }) {
  const voiceoverSrc = safeWorkspaceRelativePath(voice?.relativePath || voice?.outputPath);
  const audioHash = String(voice?.audioHash || voice?.checksum || '').trim();
  const scriptHash = String(script?.scriptHash || '').trim() || m5ScriptHash(script?.fullScript);
  const voiceProviderActionId = String(
    voice?.providerReceipt?.actionId || voice?.actionId || '',
  ).trim() || null;
  if (
    !script?.fullScript
    || !voiceoverSrc
    || !/^sha256:[0-9a-f]{64}$/i.test(scriptHash)
    || !/^sha256:[0-9a-f]{64}$/i.test(audioHash)
    || !validM5ProductionTemplateBinding(templateBinding)
  ) {
    throw new ContentCampaignError(
      'baseline 渲染缺少脚本、音频或模板的稳定血缘。',
    );
  }
  return {
    variantKey:'baseline',
    script,
    scriptHash,
    voiceoverSrc,
    audioHash,
    templateBinding,
    voiceProviderActionId,
  };
}

function m5RenderVariantDescriptor({ composition, grayLineage, fallback }) {
  if (!grayLineage) return fallback;
  return grayLineage[renderPlatformKey(composition)];
}

function hasM5VariantLineage(value) {
  return [
    'variantKey',
    'scriptHash',
    'audioHash',
    'templateBindingHash',
    'voiceProviderActionId',
  ].some((key) => value?.[key] != null);
}

function assertM5RenderOutputLineage(output, expected, platform) {
  if (
    !expected
    || output?.variantKey !== expected.variantKey
    || output?.scriptHash !== expected.scriptHash
    || output?.audioHash !== expected.audioHash
    || output?.templateBindingHash !== expected.templateBinding.bindingHash
    || output?.voiceProviderActionId !== expected.voiceProviderActionId
  ) {
    throw m5WorkProductDrift(
      { stageKey:'render' },
      `${platform} 成片的脚本、音频或模板变体血缘发生跨接`,
    );
  }
}

function buildM5RenderProps({
  script,
  voiceoverSrc,
  composition,
  visualAssets,
  templateBinding,
  variantLineage = null,
}) {
  const platform = composition === 'M5Douyin'
    ? 'douyin'
    : composition === 'M5Xiaohongshu' ? 'xiaohongshu' : 'master';
  const sourceShots = Array.isArray(script?.shots) ? script.shots.slice(0, 12) : [];
  const fallbackText = safeText(script?.fullScript, 240);
  const normalizedShots = sourceShots.length
    ? sourceShots
    : [{ startSeconds:0, endSeconds:45, narration:fallbackText, visual:'受控本机口播画面' }];
  const scenes = normalizedShots.map((shot, index) => {
    const startFrame = Math.max(0, Math.min(1349, Math.round(Number(shot?.startSeconds || 0) * 30)));
    const requestedEnd = Math.round(Number(shot?.endSeconds || ((index + 1) * 45 / normalizedShots.length)) * 30);
    const endFrame = Math.max(startFrame + 1, Math.min(1350, requestedEnd));
    return {
      id:`scene-${index + 1}`,
      startFrame,
      durationInFrames:endFrame - startFrame,
      headline:safeText(index === 0 ? script?.hook || script?.headline : `要点 ${index + 1}`, 80) || `要点 ${index + 1}`,
      body:safeText(shot?.narration || fallbackText, 240) || '等待可信脚本内容。',
      imageSrc:visualAssets[index % visualAssets.length].relativePath,
      evidenceRef:visualAssets[index % visualAssets.length].frameId,
    };
  });
  const captions = scenes.map((scene) => ({
    startFrame:scene.startFrame,
    endFrame:scene.startFrame + scene.durationInFrames,
    text:captionSafeText(scene.body),
  }));
  return {
    platform,
    title:safeText(script?.headline || script?.topic || 'AI Agent 实战', 80) || 'AI Agent 实战',
    subtitle:safeText(script?.hook || '从目标到真实产物', 120) || '从目标到真实产物',
    sourceLabel:'公开来源与本机自产素材',
    voiceoverSrc,
    coverSrc:visualAssets[0].relativePath,
    assetLedger:visualAssets.map((asset) => ({
      relativePath:asset.relativePath,
      checksum:asset.checksum,
    })),
    templateBinding,
    ...(variantLineage ? { variantLineage } : {}),
    scenes,
    captions,
  };
}

function buildM5SocialCardProps({
  script,
  visualAssets,
  templateBinding,
  rightsBasis,
}) {
  const ledger = visualAssets.slice(0, 12).map((asset) => ({
    relativePath:asset.relativePath,
    checksum:asset.checksum,
  }));
  const shotBullets = asList(script?.shots)
    .map((shot) => safeText(shot?.narration || shot?.visual, 24))
    .filter(Boolean)
    .slice(0, 3);
  const keyPoints = shotBullets.length
    ? shotBullets
    : ['明确任务边界', '保留真实回执', '由人工决定发布'];
  return {
    platform:'xiaohongshu',
    title:safeText(script?.headline || script?.topic || 'AI Agent 实战', 40) || 'AI Agent 实战',
    subtitle:safeText(script?.hook || '从目标到真实产物', 120) || '从目标到真实产物',
    sourceLabel:'公开来源与本机自产素材',
    rightsBasis:safeText(rightsBasis, 500),
    templateBinding,
    assetLedger:ledger,
    cards:[
      {
        id:'cover',
        kind:'cover',
        headline:safeText(script?.headline || script?.topic || '别把运行当完成', 14) || '别把运行当完成',
        body:safeText(script?.hook || script?.fullScript || '完成必须落到可核验的真实产物。', 60),
        bullets:keyPoints,
      },
      {
        id:'evidence',
        kind:'evidence',
        headline:'证据进入同一条链',
        body:'素材、模板和输出都绑定到同一 Case，可按路径与哈希复核。',
        bullets:keyPoints,
        imageSrc:ledger[0].relativePath,
      },
      {
        id:'checklist',
        kind:'checklist',
        headline:'交付前逐项核对',
        body:'静态卡只是候选产物；审批、启用和发布仍是彼此独立的门禁。',
        bullets:['代码与测试已通过', '素材与版权依据可追溯', '输出尺寸和哈希已核验', '发布需要负责人批准'],
      },
    ],
  };
}

function validM5SocialCardPackageReceipt(value) {
  const outputDir = safeWorkspaceRelativePath(value?.outputDir);
  const cards = asList(value?.cards);
  const checks = value?.checks;
  return value?.schemaVersion === M5_SCHEMA_IDS.SOCIAL_CARD_PACKAGE
    && value?.platform === 'xiaohongshu'
    && outputDir
    && safeWorkspaceRelativePath(value?.propsPath)
    && String(value.propsPath).endsWith('/social-card.props.json')
    && validM5Sha256(value?.propsChecksum)
    && safeWorkspaceRelativePath(value?.manifestPath)
    && String(value.manifestPath).endsWith('/social-card-render-manifest.json')
    && validM5Sha256(value?.manifestChecksum)
    && validM5Sha256(value?.templateBindingHash)
    && safeText(value?.rightsBasis, 500)
    && value?.rightsBasisHash === m5TextHash(value.rightsBasis)
    && cards.length >= 3
    && cards.length <= 9
    && cards.every((card) =>
      /^[a-z0-9][a-z0-9-]{1,48}$/i.test(String(card?.id || ''))
      && safeWorkspaceRelativePath(card?.relativePath)
      && String(card.relativePath).startsWith(`${outputDir}/`)
      && String(card.relativePath).toLowerCase().endsWith('.png')
      && Number(card?.width) === 1080
      && Number(card?.height) === 1440
      && Number.isInteger(Number(card?.bytes))
      && Number(card.bytes) > 0
      && validM5Sha256(card?.checksum)
    )
    && checks?.dimensions === true
    && checks?.fileHashes === true
    && checks?.assetLineage === true
    && checks?.rightsBasis === true
    && checks?.externalNetworkUsed === false;
}

function validM5Sha256(value) {
  return /^sha256:[0-9a-f]{64}$/i.test(String(value || ''));
}

function m5TextHash(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex')}`;
}

async function resolveM5TemplateForRender({
  resolver,
  pipelineCaseId,
  scriptBinding,
}) {
  let resolved = defaultM5ProductionTemplateBinding('resolver_unavailable');
  if (typeof resolver?.resolve === 'function') {
    try {
      resolved = await resolver.resolve(pipelineCaseId);
    } catch (error) {
      if (error instanceof M5ProductionTemplateResolutionError
        || error?.code === 'm5_production_template_blocked') throw error;
      resolved = defaultM5ProductionTemplateBinding('resolver_read_failed');
    }
  }
  if (!scriptBinding) {
    if (resolved.source === 'built_in_default') return resolved;
    throw new ContentCampaignError(
      '渲染阶段发现已批准生产模板，但 ScriptPackage 没有模板绑定，必须从脚本阶段恢复。',
    );
  }
  if (!sameTemplateBinding(scriptBinding, resolved)) {
    throw new ContentCampaignError(
      'ScriptPackage 模板绑定与当前只读生产模板决定不一致，必须从脚本阶段恢复。',
    );
  }
  return resolved;
}

function sameTemplateBinding(left, right) {
  return validM5ProductionTemplateBinding(left)
    && validM5ProductionTemplateBinding(right)
    && left.bindingHash === right.bindingHash;
}

function captionSafeText(value) {
  const compact = String(value || '').replace(/\s+/g, '').trim().slice(0, 60);
  if (!compact) return '等待可信字幕';
  const lines = [];
  for (let index = 0; index < compact.length && lines.length < 3; index += 20) {
    lines.push(compact.slice(index, index + 20));
  }
  return lines.join('\n');
}

function deterministicM5ReviewChecks({
  campaignCase,
  targetCase,
  render,
  script,
  evidence,
  voice,
  assetPackage,
  generatedImage,
  media,
  subtitles,
}) {
  const sources = Array.isArray(evidence?.sources) ? evidence.sources : [];
  const sourceById = new Map(
    sources
      .filter(validM5ReviewSource)
      .map((source) => [String(source.sourceId), source]),
  );
  const bindings = Array.isArray(script?.factBindings) ? script.factBindings : [];
  const evidenceClaims = new Map(
    (Array.isArray(evidence?.claims) ? evidence.claims : [])
      .map((claim) => [String(claim?.claimId || ''), claim])
      .filter(([claimId]) => claimId),
  );
  const facts = evidence?.schemaVersion === 'agent.army/evidence-package/v2'
    && sources.length >= 2
    && sourceById.size === sources.length
    && bindings.length >= 1
    && bindings.every((binding) =>
      String(binding?.statement || '').trim()
      && String(script.fullScript || '').includes(String(binding.statement))
      && Array.isArray(binding.sourceIds)
      && binding.sourceIds.length >= 2
      && binding.sourceIds.every((sourceId) => sourceById.has(String(sourceId)))
      && bindingMatchesEvidenceClaim(binding, evidenceClaims.get(String(binding.claimId || ''))),
    );
  const privacy = !containsSensitiveM5Text([
    script?.headline,
    script?.hook,
    script?.fullScript,
  ].join('\n'));
  const rights = render?.composition
    && safeWorkspaceRelativePath(render?.propsPath)
    && voice?.model === 'stepaudio-2.5-tts'
    && String(voice?.voice || '').trim()
    && !/clone|克隆|复刻/i.test(String(voice.voice));
  const visualAssets = verifiedM5VisualAssets(assetPackage);
  const generatedVisual = verifiedM5GeneratedVisual(generatedImage);
  const claims = facts
    && !containsUnsupportedPromise(script?.fullScript)
    && (!Array.isArray(script?.qualityReview?.unresolved) || script.qualityReview.unresolved.length === 0);
  const grant = campaignCase?.campaignGrant;
  const platform = String(targetCase?.platform || '').trim();
  const scheduledDate = String(targetCase?.scheduledDate || '').trim();
  const grantScope = grant?.status === 'active'
    && Array.isArray(grant.platforms)
    && grant.platforms.includes(platform)
    && /^\d{4}-\d{2}-\d{2}$/.test(scheduledDate);
  const receipts = Array.isArray(grant?.receipts) ? grant.receipts : [];
  const duplicate = /^sha256:[0-9a-f]{64}$/i.test(String(render?.checksum || ''))
    && !receipts.some((receipt) =>
      receipt?.platform === platform
      && receipt?.contentChecksum === render.checksum,
    );
  return {
    facts,
    privacy,
    rights:Boolean(
      rights
      && generatedVisual
      && visualAssets.length
      && String(assetPackage?.rightsBasis || '').trim(),
    ),
    media:media?.passed === true && subtitles?.passed === true,
    claims,
    grantScope,
    duplicate,
  };
}

function validM5ReviewSource(source) {
  let url;
  try { url = new URL(String(source?.url || '')); } catch { return false; }
  return Boolean(
    String(source?.sourceId || '').trim()
    && ['http:', 'https:'].includes(url.protocol)
    && !url.username
    && !url.password
    && source?.kind !== 'github_metadata'
    && Number.isFinite(Date.parse(String(source?.fetchedAt || '')))
    && /^(?:sha256:)?[0-9a-f]{64}$/i.test(String(source?.contentHash || ''))
    && Array.isArray(source?.evidenceFragments)
    && source.evidenceFragments.some((fragment) =>
      String(fragment?.fragmentId || '').trim()
      && String(fragment?.text || '').trim()
    )
  );
}

function bindingMatchesEvidenceClaim(binding, claim) {
  if (
    !claim
    || String(binding?.statement || '').trim() !== String(claim?.text || '').trim()
    || !sameStringSet(binding?.sourceIds, claim?.sourceIds)
    || !Array.isArray(binding?.evidenceFragments)
    || !Array.isArray(claim?.evidenceFragments)
  ) return false;
  const claimFragments = new Set(claim.evidenceFragments.map(evidenceFragmentKey));
  const bindingFragments = new Set(binding.evidenceFragments.map(evidenceFragmentKey));
  if (!claimFragments.size || !sameStringSet([...bindingFragments], [...claimFragments])) return false;
  const fragmentSources = new Set(binding.evidenceFragments.map((fragment) => String(fragment?.sourceId || '')));
  return binding.sourceIds.every((sourceId) => fragmentSources.has(String(sourceId)));
}

function evidenceFragmentKey(fragment) {
  return [
    String(fragment?.sourceId || '').trim(),
    String(fragment?.fragmentId || '').trim(),
    String(fragment?.text || '').replace(/\s+/g, ' ').trim(),
  ].join('\u0000');
}

function sameStringSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  const a = new Set(left.map(String));
  const b = new Set(right.map(String));
  return a.size === b.size && [...a].every((item) => b.has(item));
}

function containsSensitiveM5Text(value) {
  const text = String(value || '');
  return /(?:\b(?:sk|api)[-_][A-Za-z0-9]{12,}\b|Bearer\s+[A-Za-z0-9._-]{12,}|(?:token|cookie|password|secret|api[_ -]?key)\s*[:=]\s*\S{6,}|file:\/\/|\/Users\/|[A-Za-z]:\\|聊天原文|客户数据|内部账号)/i.test(text);
}

function containsUnsupportedPromise(value) {
  return /(?:保证|必然|百分之百|100%|稳赚|无风险|一定能|立刻暴涨|播放量翻倍)/i.test(String(value || ''));
}

function m5HermesRouteExecution({
  assignment,
  task,
  contract,
  strategy,
  toolIds,
  inputs,
}) {
  const recovery = task?.input?.context?.m5Recovery || null;
  const previousExecution = validM5RouteExecution(task?.execution?.m5RouteExecution)
    ? task.execution.m5RouteExecution
    : null;
  const execution = createM5RouteExecution({
    runId:assignment?.runId || task?.execution?.paperclipRunId,
    stageKey:contract.stageKey,
    recovery,
    previousExecution,
    strategy,
    toolIds,
    inputs,
  });
  if (recovery) {
    try {
      assertChangedM5RecoveryRoute(execution, recovery);
    } catch (error) {
      if (error && typeof error === 'object') error.m5RouteExecution = execution;
      throw error;
    }
  }
  return execution;
}

function m5HermesStrategy(task, contract) {
  return task?.input?.context?.m5Recovery?.nextRoute?.kind
    || `default:${contract.pluginEntryTool || contract.deterministicEntry}`;
}

function m5HermesStageToolIds(contract) {
  if (contract.stageKey === 'render') {
    return [
      `${CONTENT_AUTONOMY_PLUGIN_KEY}:remotion-props-write`,
      `${CONTENT_AUTONOMY_PLUGIN_KEY}:remotion-render`,
      `${CONTENT_AUTONOMY_PLUGIN_KEY}:social-card-render`,
    ];
  }
  if (contract.stageKey === 'machine_review') {
    return [
      `${CONTENT_AUTONOMY_PLUGIN_KEY}:media-validate`,
      `${CONTENT_AUTONOMY_PLUGIN_KEY}:subtitle-layout-validate`,
      `${CONTENT_AUTONOMY_PLUGIN_KEY}:artifact-package-write`,
      `${CONTENT_AUTONOMY_PLUGIN_KEY}:artifact-lineage-validate`,
    ];
  }
  return [`${CONTENT_AUTONOMY_PLUGIN_KEY}:${contract.pluginEntryTool}`];
}

async function executeM5Route(routeExecution, operation) {
  try {
    return await operation();
  } catch (error) {
    if (error && typeof error === 'object') {
      error.m5RouteExecution = routeExecution;
    }
    throw error;
  }
}

function routeCaseInput(caseItem) {
  return {
    id:String(caseItem?.id || ''),
    version:Number(caseItem?.version) || 0,
    stageKey:String(caseItem?.stageKey || ''),
    campaignId:String(caseItem?.campaignId || ''),
    scheduledDate:String(caseItem?.scheduledDate || ''),
    platform:String(caseItem?.platform || ''),
  };
}

function routeOutputHashes(outputs) {
  return (Array.isArray(outputs) ? outputs : [])
    .map((item) => String(
      item?.artifactHash
      || item?.externalId
      || item?.id
      || '',
    ).trim())
    .filter(Boolean)
    .sort();
}

function safeText(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

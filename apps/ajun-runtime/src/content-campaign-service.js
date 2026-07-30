import {
  buildCampaignCaseBatch,
  ingestCampaignDraftCase,
  ingestCampaignExecutionCases,
} from '../../../integrations/paperclip/m5-content-pipeline/src/index.js';
import { M5ParallelWorkCoordinator } from './m5-parallel-work-coordinator.js';
import { inspectContentAutonomyPluginReadiness } from './content-autonomy-plugin-preflight.js';
import { readContentAutonomyApprovalSnapshot } from './content-autonomy-plugin-snapshot.js';
import {
  assertM5RoutineExecutionContracts,
  getM5RoutineExecutionContract,
} from './m5-routine-execution-contract.js';
import {
  buildM5PlatformCopy,
  deriveM5ContentVersionId,
} from './m5-content-version.js';
import {
  healthyM5StageWorkProducts,
  m5StageWorkProductCandidates,
} from './m5-stage-recovery-controller.js';
import {
  assertChangedM5RecoveryRoute,
  createM5RouteExecution,
  validM5RouteExecution,
} from './m5-route-execution.js';
import {
  assertM5WorkspaceArtifact,
  M5WorkspaceArtifactError,
  validM5WorkProductArtifactHash,
} from './m5-work-product-integrity.js';

const CAMPAIGN_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const CASE_ID = /^[0-9a-f-]{8,80}$/i;
const RECEIPT_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const ACCOUNT_REF = /^(?:connection:)?[a-z0-9][a-z0-9:_-]{5,159}$/i;
const PLATFORMS = Object.freeze(['douyin', 'xiaohongshu']);
const ALLOWED_ACTIONS = Object.freeze(['upload', 'fill_metadata', 'schedule_or_publish', 'read_own_metrics']);
const PROHIBITED_ACTIONS = Object.freeze(['direct_message', 'comment', 'follow', 'paid_promotion', 'payment', 'account_settings', 'delete_history']);
const CONTROL_ACTIONS = new Set(['pause', 'resume', 'stop']);
const CONTENT_AUTONOMY_PLUGIN_KEY = 'agent-army.content-autonomy';
const INVOKABLE_AGENT_STATUSES = new Set(['active', 'idle', 'running']);
const M5_PROVIDER_MODELS = Object.freeze({
  vision:'step-1o-turbo-vision',
  image_generate:'step-image-edit-2',
  image_edit:'step-image-edit-2',
  tts:'stepaudio-2.5-tts',
});

export class ContentCampaignService {
  constructor({
    adapter,
    definition,
    publisher = null,
    toolExecutor = null,
    activePipelineId = null,
    activePipelineKey = null,
    contentWorkspaceRoot = null,
    allowLocalFixtureProvenance = false,
    now = () => new Date(),
  } = {}) {
    if (!adapter || !definition) throw new ContentCampaignError('M5 内容活动缺少 Paperclip 适配器或 Pipeline 定义。');
    this.adapter = adapter;
    this.definition = definition;
    this.publisher = publisher;
    this.toolExecutor = toolExecutor;
    this.activePipelineId = String(activePipelineId || '').trim() || null;
    this.activePipelineKey = String(activePipelineKey || definition.key).trim();
    this.contentWorkspaceRoot = String(contentWorkspaceRoot || '').trim() || null;
    this.allowLocalFixtureProvenance = allowLocalFixtureProvenance === true;
    this.now = now;
    this.controlTail = Promise.resolve();
  }

  async list() {
    const pipeline = await this.requirePipeline();
    const cases = await this.adapter.request('GET', `/api/pipelines/${encodeURIComponent(pipeline.id)}/cases`);
    const rows = caseRows(cases);
    const parents = rows.filter((item) => !item.parentCaseId && item.fields?.campaignGrant);
    return Promise.all(parents.map(async (item) => campaignView(item, {
      children:descendantCases(item.id, rows),
      approval:await this.approvalReadiness(item),
    }, this.definition)));
  }

  async createDraft(input = {}) {
    const draft = normalizeDraft(input, this.now());
    const pipeline = await this.requirePipeline();
    const batch = buildCampaignCaseBatch({
      campaignId:draft.campaignId,
      startDate:draft.startDate,
      themes:draft.themes,
      assetRightsBasis:draft.assetRightsBasis,
    });
    batch.parent.fields = {
      ...batch.parent.fields,
      campaignGrant:draft.grant,
      projectId:pipeline.projectId || null,
    };
    const parent = await ingestCampaignDraftCase(this.adapter, pipeline.id, batch);
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
    const cases = caseRows(await this.adapter.request(
      'GET',
      `/api/pipelines/${encodeURIComponent(pipeline.id)}/cases`,
    ));
    const activeParents = cases.filter((item) =>
      !item.parentCaseId
      && item.fields?.campaignGrant?.status === 'active',
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
      && !item.fields?.platform
      && item.fields?.campaignId === parent.fields?.campaignId
      && item.fields?.scheduledDate === scheduledDate,
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
      adapter:this.adapter,
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
      item?.fields?.scheduledDate
      && !item.fields?.platform
      && !item.fields?.workBranch
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
      this.adapter.request('GET', `/api/cases/${encodeURIComponent(item.id)}/children/tree`).catch(() => []),
      this.adapter.request('GET', `/api/cases/${encodeURIComponent(item.id)}/events?limit=100&order=desc`).catch(() => []),
      this.adapter.request('GET', `/api/cases/${encodeURIComponent(item.id)}/outputs`).catch(() => []),
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
    const grant = item?.fields?.campaignGrant || {};
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
    if (!campaignCase?.fields?.campaignGrant || campaignCase.parentCaseId) {
      throw new ContentCampaignError('当前 M5 子 Case 无法回溯到唯一活动授权父 Case。');
    }
    const outputs = [];
    let targetOutputs = [];
    for (const item of chain) {
      let itemOutputs;
      try {
        const itemOutputResponse = await this.adapter.request(
          'GET',
          `/api/cases/${encodeURIComponent(item.id)}/outputs`,
        );
        if (!Array.isArray(itemOutputResponse)) {
          throw new Error('Case outputs 响应不是官方裸数组。');
        }
        itemOutputs = itemOutputResponse;
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
      });
      const routeExecution = m5HermesRouteExecution({
        assignment,
        task,
        contract,
        strategy:'verified_work_product_replay',
        toolIds:['agent-army.m5:verified-work-product-replay'],
        inputs:{
          workProductId:verifiedProducts[0].id || null,
          artifactHash:verifiedProducts[0].metadata?.artifactHash || null,
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
    if (contract.stageKey === 'render') {
      const receipts = await executeM5Route(routeExecution, () => Promise.all(
        parameters.renders.map(async (render) => {
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
          ...(Number.isFinite(Number(receipt.durationSeconds))
            ? { durationSeconds:Number(receipt.durationSeconds) }
            : {}),
        };
        }),
      ));
      const outputs = Object.fromEntries(receipts.map((receipt) => [
        renderPlatformKey(receipt.composition),
        receipt,
      ]));
      return {
        toolId:`${CONTENT_AUTONOMY_PLUGIN_KEY}:${contract.pluginEntryTool}`,
        pluginId:CONTENT_AUTONOMY_PLUGIN_KEY,
        content:'三份受控 M5 成片已经生成并完成回执核验。',
        artifact:{
          type:contract.expectedWorkProduct.artifactKinds[0],
          schemaVersion:contract.expectedWorkProduct.schemaVersion,
          data:{
            outputs,
            ...outputs.master,
          },
          validation:{
            exists:true,
            readable:true,
            nonEmpty:true,
            fixedOutputsVerified:true,
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
    paperclipRuns = null,
  }) {
    const metadata = product?.metadata;
    const data = metadata?.artifact;
    const sourceRunId = String(metadata?.sourceRunId || '').trim();
    const sourceTaskId = String(metadata?.sourceTaskId || '').trim();
    const sourceIssueId = String(metadata?.sourceIssueId || '').trim();
    if (
      !metadata
      || !data
      || typeof data !== 'object'
      || Array.isArray(data)
      || metadata.pipelineCaseId !== targetCaseId
      || !String(projectId || '').trim()
      || metadata.projectId !== projectId
      || !sourceRunId
      || product?.createdByRunId !== sourceRunId
      || !sourceTaskId
      || sourceTaskId !== String(task?.taskId || '').trim()
      || !sourceIssueId
      || sourceIssueId !== String(assignment?.issueId || '').trim()
      || !validM5WorkProductArtifactHash(metadata)
    ) {
      throw m5WorkProductDrift(contract, 'Issue、Case、Project、source Run 或 artifactHash 不一致');
    }
    const sourceRuns = paperclipRuns == null
      ? asList(await this.adapter.request(
          'GET',
          `/api/issues/${encodeURIComponent(sourceIssueId)}/runs`,
        ).catch(() => []))
      : asList(paperclipRuns);
    const sourceRun = sourceRuns.find((run) =>
      String(run?.id || run?.runId || '').trim() === sourceRunId
    );
    if (!sourceRun || !['running', 'succeeded', 'completed'].includes(
      String(sourceRun.status || sourceRun.state || '').trim().toLowerCase(),
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
      for (const platform of ['master', 'douyin', 'xiaohongshu']) {
        const output = data.outputs?.[platform];
        if (!output) throw m5WorkProductDrift(contract, `缺少 ${platform} 成片`);
        await this.assertWorkspaceReplayFile(
          output.outputPath || output.relativePath,
          output.checksum,
          output.bytes,
          contract,
        );
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
    let response;
    try {
      response = await this.adapter.request(
        'POST',
        `/api/plugins/${encodeURIComponent(CONTENT_AUTONOMY_PLUGIN_KEY)}/actions/provider-action-verify`,
        {
          companyId:this.adapter.companyId,
          params:{
            actionId:receipt.actionId,
            costEventId:receipt.costCommit.costEventId,
            operation,
            runContext:{
              agentId:sourceAgentId,
              runId:sourceRunId,
              companyId:this.adapter.companyId,
              projectId,
            },
          },
        },
      );
    } catch {
      throw m5WorkProductDrift(
        contract,
        `StepFun ${operation} action 无法由内容插件原 Run 的只读 confirmed 状态证明`,
      );
    }
    const verified = response?.data?.data;
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
    let activityRows;
    try {
      const query = new URLSearchParams({
        entityType:'cost_event',
        entityId:receipt.costCommit.costEventId,
        limit:'500',
      });
      const activityResponse = await this.adapter.request(
        'GET',
        `/api/companies/${encodeURIComponent(this.adapter.companyId)}/activity?${query}`,
      );
      if (!Array.isArray(activityResponse)) {
        throw new Error('Paperclip activity 响应不是官方裸数组。');
      }
      activityRows = activityResponse.filter((row) => row?.action === 'cost.reported');
    } catch {
      throw m5WorkProductDrift(
        contract,
        `StepFun ${operation} action 无法从 Paperclip 核心费用活动反查`,
      );
    }
    const activity = activityRows.length === 1 ? activityRows[0] : null;
    if (
      !RECEIPT_ID.test(String(activity?.id || ''))
      || activity?.companyId !== this.adapter.companyId
      || !['user', 'agent'].includes(activity?.actorType)
      || !String(activity?.actorId || '').trim()
      || activity?.entityType !== 'cost_event'
      || activity?.entityId !== receipt.costCommit.costEventId
      || activity?.details?.model !== expectedModel
      || Number(activity?.details?.costCents) !== expectedCost
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
        topic?.theme || topic?.title || targetCase?.fields?.theme || 'AI Agent 实战',
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
      const voiceoverSrc = safeWorkspaceRelativePath(voice?.relativePath || voice?.outputPath);
      const generatedVisual = verifiedM5GeneratedVisual(generatedImage);
      const visualAssets = [
        generatedVisual,
        ...verifiedM5VisualAssets(assetPackage),
      ].filter(Boolean);
      if (
        !script?.fullScript
        || !voiceoverSrc
        || !/^sha256:[0-9a-f]{64}$/i.test(String(voice?.checksum || ''))
        || !generatedVisual
        || visualAssets.length < 2
        || !String(assetPackage?.rightsBasis || '').trim()
      ) {
        throw new ContentCampaignError(
          '渲染阶段缺少可信 ScriptPackage、VoicePackage、GeneratedImagePackage 或带版权依据的真实 AssetPackage，拒绝白生成图片或用纯文字模板冒充混剪。',
        );
      }
      return {
        renders:[
          ['M5Master', 'master.mp4'],
          ['M5Douyin', 'douyin.mp4'],
          ['M5Xiaohongshu', 'xiaohongshu.mp4'],
        ].map(([composition, outputName]) => ({
          composition,
          propsPath:`campaigns/${campaignCase.id}/${targetCase.id}/${composition}.props.json`,
          outputPath:`campaigns/${campaignCase.id}/${targetCase.id}/${outputName}`,
          props:buildM5RenderProps({
            script,
            voiceoverSrc,
            composition,
            visualAssets,
          }),
        })),
      };
    }
    if (contract.stageKey === 'machine_review') {
      const render = artifactData(artifacts, ['render_package']);
      const selectedRender = selectRenderOutput(
        render,
        String(targetCase?.fields?.platform || '').trim(),
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
    const script = artifactData(artifacts, ['video_script_package', 'script_package']);
    const evidence = artifactData(artifacts, ['evidence_package']);
    const voice = artifactData(artifacts, ['voice_package']);
    const assetPackage = artifactData(artifacts, ['asset_package']);
    const generatedImage = artifactData(artifacts, ['generated_image_package']);
    const visualAnalysis = artifactData(artifacts, ['visual_analysis_package']);
    const platform = String(targetCase?.fields?.platform || '').trim();
    const render = selectRenderOutput(renderPackage, platform);
    const scheduledDate = String(targetCase?.fields?.scheduledDate || '').trim();
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
        douyin:buildM5PlatformCopy(script, 'douyin'),
        xiaohongshu:buildM5PlatformCopy(script, 'xiaohongshu'),
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
    const plugins = asList(await this.adapter.request('GET', '/api/plugins').catch(() => []));
    const plugin = plugins.find((item) =>
      [item.pluginKey, item.key, item.manifestJson?.id].includes(CONTENT_AUTONOMY_PLUGIN_KEY),
    );
    if (!plugin?.id) throw new ContentCampaignError('内容插件未安装，配音未执行。');
    const record = await this.adapter.request(
      'GET',
      `/api/plugins/${encodeURIComponent(plugin.id)}/config?companyId=${encodeURIComponent(this.adapter.companyId)}`,
    ).catch(() => null);
    const voice = safeText(record?.configJson?.officialTtsVoices?.[0], 120);
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
      ? await this.adapter.request(
        'GET',
        `/api/pipelines/${encodeURIComponent(this.activePipelineId)}`,
      )
      : await this.adapter.findByMarker('pipeline', this.definition.key);
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
    const item = unwrapCaseDetail(await this.adapter.request('GET', `/api/cases/${encodeURIComponent(id)}`));
    if (!item || item.parentCaseId || !item.fields?.campaignGrant) throw new ContentCampaignError('没有找到对应的活动父 Case。');
    await this.assertCaseInActivePipeline(item);
    return item;
  }

  async getAnyCase(caseId) {
    const id = safeId(caseId, 'Pipeline Case 标识无效。');
    const item = unwrapCaseDetail(await this.adapter.request('GET', `/api/cases/${encodeURIComponent(id)}`));
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
    return this.adapter.request('PATCH', `/api/cases/${encodeURIComponent(item.id)}`, {
      expectedVersion:item.version,
      fields:{ ...(item.fields || {}), campaignGrant },
    });
  }

  async activateApprovedCampaign(item, campaignGrant) {
    let grantActivated = false;
    try {
      await this.updateGrant(item, campaignGrant);
      grantActivated = true;

      const current = await this.getRawCase(item.id);
      const pipeline = await this.requirePipeline();
      const batch = buildBatchFromCampaignCase(current);
      const execution = await ingestCampaignExecutionCases(this.adapter, pipeline.id, batch, current);
      await this.restoreExecutionCasesToDraft(execution.days);
      await this.restoreExecutionCasesToDraft(execution.platformCases);

      const parent = await this.getRawCase(item.id);
      if (['draft', 'cancelled'].includes(parent.stageKey)) {
        await this.transitionCase(parent, batch.parent.activationStageKey, '活动授权门禁已通过，启动父 Case。');
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
    if (!this.adapter?.transitionCase) {
      throw new ContentCampaignError('Paperclip 适配器缺少 Case 阶段迁移能力，活动保持暂停。');
    }
    return this.adapter.transitionCase(item.id, {
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
    const cases = caseRows(await this.adapter.request(
      'GET',
      `/api/pipelines/${encodeURIComponent(pipeline.id)}/cases`,
    ));
    const activeConflict = cases.find((entry) =>
      entry.id !== item.id
      && !entry.parentCaseId
      && entry.fields?.campaignGrant?.status === 'active',
    );
    if (activeConflict) {
      throw new ContentCampaignError(
        `共享 M5 Cron 已被活动 ${activeConflict.caseKey || activeConflict.id} 占用；先暂停或停止该活动。`,
      );
    }

    const companyId = safeOpaqueId(this.adapter.companyId);
    const projectId = safeOpaqueId(item.fields?.projectId || item.pipeline?.projectId || pipeline.projectId);
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
    const overview = await this.adapter.request(
      'GET',
      `/api/companies/${encodeURIComponent(companyId)}/budgets/overview`,
    ).catch(() => null);
    const policies = asList(overview?.policies);
    const policy = policies.find((entry) =>
      entry.scopeType === 'project'
      && entry.scopeId === projectId
      && entry.metric === 'billed_cents'
      && entry.isActive !== false,
    );
    if (
      !policy
      || policy.hardStopEnabled !== true
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
    const [pluginsPayload, routinesPayload, agentsPayload, pipelineDetail] = await Promise.all([
      this.adapter.request('GET', '/api/plugins').catch(() => null),
      this.adapter.request(
        'GET',
        `/api/companies/${encodeURIComponent(companyId)}/routines`,
      ).catch(() => null),
      this.adapter.request(
        'GET',
        `/api/companies/${encodeURIComponent(companyId)}/agents`,
      ).catch(() => null),
      this.adapter.request(
        'GET',
        `/api/pipelines/${encodeURIComponent(pipeline.id)}`,
      ).catch(() => null),
    ]);
    const failures = [];
    let executionContracts = [];
    try {
      executionContracts = assertM5RoutineExecutionContracts(this.definition);
    } catch (error) {
      failures.push(`Pipeline 执行契约无效：${String(error?.message || error)}`);
    }
    const plugins = asList(pluginsPayload);
    const contentPlugin = plugins.find((item) =>
      [item.pluginKey, item.key, item.manifestJson?.id].includes(CONTENT_AUTONOMY_PLUGIN_KEY),
    );
    if (!contentPlugin || contentPlugin.status !== 'ready') {
      failures.push(`内容插件 ${CONTENT_AUTONOMY_PLUGIN_KEY} 未处于 ready`);
    } else {
      failures.push(...await inspectContentAutonomyPluginReadiness({
        adapter:this.adapter,
        companyId,
        plugin:contentPlugin,
        agents:asList(agentsPayload),
      }));
    }

    const routines = asList(routinesPayload);
    const agents = asList(agentsPayload);
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
        if (agent?.metadata?.agentArmySystemRole !== spec.contract.systemController) {
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
      } else if (routine && liveStage.config?.onEnter?.routineId !== routine.id) {
        failures.push(`阶段 ${stage.key} 未绑定声明的 Routine ${stage.routineKey}`);
      } else if (!contract) {
        failures.push(`阶段 ${stage.key} 缺少唯一执行契约`);
      }
    }
    if (failures.length > 0) {
      throw new ContentCampaignError(`M5 启动前检查未通过：${failures.join('；')}。`);
    }
    try {
      return await readContentAutonomyApprovalSnapshot({
        adapter:this.adapter,
        companyId,
        plugin:contentPlugin,
      });
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
    await this.adapter.request('PATCH', `/api/routine-triggers/${encodeURIComponent(trigger.id)}`, { enabled });
    return { triggerId:trigger.id, previousEnabled, enabled, changed:true };
  }

  async getDailyRoutineTrigger() {
    const marker = '[agent-army:m5:routine:m5-daily-campaign]';
    const pipeline = await this.requirePipeline();
    const routines = asList(await this.adapter.request(
      'GET',
      `/api/companies/${encodeURIComponent(this.adapter.companyId)}/routines`,
    ));
    const matches = routines.filter((item) =>
      item.projectId === pipeline.projectId
      && String(item.description || '').includes(marker),
    );
    if (matches.length !== 1) {
      throw new ContentCampaignError(
        `M5 每日入口在 active Pipeline Project 中必须唯一，当前为 ${matches.length} 个。`,
      );
    }
    const routine = matches[0];
    const detail = Array.isArray(routine.triggers)
      ? routine
      : await this.adapter.request('GET', `/api/routines/${encodeURIComponent(routine.id)}`);
    const triggers = asList(detail.triggers).filter((item) => item.kind === 'schedule');
    if (triggers.length !== 1) {
      throw new ContentCampaignError(`M5 每日入口必须恰好登记一个日程触发器，当前为 ${triggers.length} 个。`);
    }
    return triggers[0];
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

export class ContentCampaignError extends Error {}

function normalizeDraft(input, now) {
  rejectSecrets(input);
  const campaignId = safeText(input.campaignId, 64);
  if (!CAMPAIGN_ID.test(campaignId)) throw new ContentCampaignError('campaignId 只允许3到64位小写字母、数字和连字符。');
  const startDate = safeDateOnly(input.startDate);
  const themes = Array.isArray(input.themes) ? input.themes.map((item) => safeText(item, 160)) : [];
  if (themes.length !== 7 || themes.some((item) => !item)) throw new ContentCampaignError('必须提供连续7天的7个非空主题。');
  const accountRefs = {};
  for (const platform of PLATFORMS) {
    const ref = safeText(input.accountRefs?.[platform], 160);
    if (!ref) throw new ContentCampaignError(`缺少${platform}账号引用；只允许引用，不接收登录态或 Cookie。`);
    if (!ACCOUNT_REF.test(ref) || /(?:^|[:_-])(bearer|cookie|token|session|password|secret)(?:$|[:_-])/i.test(ref)) {
      throw new ContentCampaignError(`${platform}账号只能提交受控连接引用，不能提交 Bearer、Cookie、Token 或登录态。`);
    }
    accountRefs[platform] = ref;
  }
  const budgetCents = Math.round(Number(input.budgetUsd) * 100);
  if (!Number.isInteger(budgetCents) || budgetCents <= 0) throw new ContentCampaignError('活动预算必须是大于0的美元金额。');
  const createdAt = now.toISOString();
  const expiresAt = new Date(`${startDate}T23:59:59.999+08:00`);
  expiresAt.setDate(expiresAt.getDate() + 6);
  return {
    campaignId,
    startDate,
    themes,
    assetRightsBasis:safeText(input.assetRightsBasis, 200)
      || '活动声明：仅使用本机自产素材与活动授权生成素材。',
    grant:{
      schemaVersion:'agent.army/campaign-grant/v1',
      status:'draft',
      platforms:[...PLATFORMS],
      accountRefs,
      themeScope:safeText(input.themeScope, 160) || 'AI Agent 实战',
      startsAt:new Date(`${startDate}T00:00:00+08:00`).toISOString(),
      expiresAt:expiresAt.toISOString(),
      dailyPublishLimitPerPlatform:1,
      totalPublishLimit:14,
      allowedActions:[...ALLOWED_ACTIONS],
      prohibitedActions:[...PROHIBITED_ACTIONS],
      budgetCents,
      createdAt,
      approvedAt:null,
      approvedBy:null,
      pausedAt:null,
      pauseReason:null,
    },
  };
}

function buildBatchFromCampaignCase(item) {
  const plan = item.fields?.campaignPlan;
  const campaignId = String(item.fields?.campaignId || item.caseKey || '').trim();
  if (
    plan?.schemaVersion !== 'agent.army/campaign-plan/v1'
    || !campaignId
    || campaignId !== item.caseKey
  ) {
    throw new ContentCampaignError('活动父 Case 缺少有效 campaignPlan，不能生成执行 Case。');
  }
  try {
    return buildCampaignCaseBatch({
      campaignId,
      startDate:plan.startDate,
      themes:plan.themes,
      assetRightsBasis:plan.assetRightsBasis,
    });
  } catch (error) {
    throw new ContentCampaignError(`活动 campaignPlan 无效：${safeText(error?.message, 300) || '无法解析'}。`);
  }
}

function campaignView(item, related = {}, definition = {}) {
  const grant = item.fields?.campaignGrant || {};
  const descendants = flattenCases(related.children || []);
  const focus = campaignFocus(item, descendants, definition);
  const platformCases = descendants.filter((entry) => PLATFORMS.includes(
    entry.fields?.platform || platformFromCaseKey(entry.caseKey),
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
    .map((item) => item?.fields?.m5ContentRecovery)
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

function requireGrant(item) {
  const grant = item.fields?.campaignGrant;
  if (!grant || grant.schemaVersion !== 'agent.army/campaign-grant/v1') throw new ContentCampaignError('活动缺少有效 CampaignGrant。');
  return grant;
}

function requireActiveGrant(item, now) {
  const grant = requireGrant(item);
  if (grant.status !== 'active') throw new ContentCampaignError('活动未处于已授权运行状态。');
  const startsAt = Date.parse(grant.startsAt);
  const expiresAt = Date.parse(grant.expiresAt);
  if (!Number.isFinite(startsAt) || !Number.isFinite(expiresAt) || startsAt >= expiresAt) {
    throw new ContentCampaignError('活动授权期限无效。');
  }
  if (startsAt > now.getTime()) throw new ContentCampaignError('活动授权尚未开始。');
  if (expiresAt <= now.getTime()) throw new ContentCampaignError('活动授权已经过期。');
  return grant;
}

function safeGrantView(grant) {
  return {
    schemaVersion:grant.schemaVersion || null,
    status:grant.status || 'unknown',
    platforms:Array.isArray(grant.platforms) ? grant.platforms : [],
    accountRefs:grant.accountRefs || {},
    themeScope:grant.themeScope || null,
    startsAt:grant.startsAt || null,
    expiresAt:grant.expiresAt || null,
    dailyPublishLimitPerPlatform:Number(grant.dailyPublishLimitPerPlatform || 0),
    totalPublishLimit:Number(grant.totalPublishLimit || 0),
    allowedActions:Array.isArray(grant.allowedActions) ? grant.allowedActions : [],
    prohibitedActions:Array.isArray(grant.prohibitedActions) ? grant.prohibitedActions : [],
    budgetCents:Number(grant.budgetCents || 0),
    approvedAt:grant.approvedAt || null,
    pluginApproval:grant.pluginApproval || null,
  };
}

function samePluginApproval(left, right) {
  return [
    'schemaVersion',
    'pluginId',
    'pluginKey',
    'version',
    'manifestHash',
    'configHash',
  ].every((key) => left?.[key] === right?.[key]);
}

function nextAction(status) {
  if (status === 'draft') return '负责人确认账号、期限、14次上限和预算后批准活动。';
  if (status === 'paused') return '查看暂停原因；确认恢复位置后再恢复。';
  if (status === 'active') return 'Paperclip 从当前 Case 阶段继续，不重新生成已验证产物。';
  if (status === 'stopped') return '活动已停止；重新运行必须创建新的授权草案。';
  return '检查 Paperclip 活动记录。';
}

function rejectSecrets(input) {
  const queue = [input];
  const denied = /^(cookie|cookies|token|tokens|password|authorization|api[-_]?key|secret|secrets|credential|credentials|session|login[-_]?state)$/i;
  while (queue.length) {
    const value = queue.pop();
    if (!value || typeof value !== 'object') continue;
    for (const [key, child] of Object.entries(value)) {
      if (denied.test(key)) throw new ContentCampaignError('活动接口只接受账号引用，禁止提交 Cookie、Token、Key、密码或登录态。');
      if (child && typeof child === 'object') queue.push(child);
    }
  }
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
  if (Array.isArray(value)) return value;
  const root = value?.case;
  if (!root || typeof root !== 'object') return [];
  return flattenPaperclipChildGroups(root.childGroups);
}

function flattenPaperclipChildGroups(groups) {
  const result = [];
  for (const group of asList(groups)) {
    for (const item of asList(group.cases)) {
      result.push(item);
      result.push(...flattenPaperclipChildGroups(item.childGroups));
    }
  }
  return result;
}

function unwrapCaseDetail(value) {
  const raw = value?.case ?? value;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return {
    ...raw,
    ...(value?.stage ? { stage:value.stage } : {}),
    ...(value?.pipeline ? { pipeline:value.pipeline } : {}),
    ...(value?.activeWork ? { activeWork:value.activeWork } : {}),
    ...(Number.isInteger(value?.descendantActiveWorkCount)
      ? { descendantActiveWorkCount:value.descendantActiveWorkCount }
      : {}),
  };
}

function caseRows(value) {
  return asList(value).map(unwrapCaseDetail).filter(Boolean);
}

function platformFromCaseKey(caseKey) {
  const match = String(caseKey || '').match(/:(douyin|xiaohongshu):v[1-9]\d*$/);
  return match?.[1] || null;
}

function asList(value) {
  return Array.isArray(value)
    ? value
    : Array.isArray(value?.items)
      ? value.items
      : Array.isArray(value?.cases)
        ? value.cases
        : Array.isArray(value?.runs)
          ? value.runs
          : [];
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
  if (agent?.metadata?.agentArmyId !== contract.agentId) {
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
  const metadata = output?.metadata && typeof output.metadata === 'object'
    ? output.metadata
    : null;
  const artifactHash = String(metadata?.artifactHash || '');
  const sourceTaskId = String(metadata?.sourceTaskId || '').trim();
  const sourceArtifactId = String(metadata?.sourceArtifactId || '').trim();
  if (
    output?.kind !== 'work_product'
    || output?.type !== 'artifact'
    || !['agent-army.ajun-runtime', 'agent-army.content-autonomy', 'agent-army.publisher-gateway']
      .includes(output?.provider)
    || output?.sourceTrust != null
    || output?.status !== 'active'
    || output?.healthStatus !== 'healthy'
    || !/^agent\.army\/[a-z0-9-]+\/v\d+$/i.test(String(metadata?.schemaVersion || ''))
    || sourceTaskId.length === 0
    || sourceTaskId.length > 240
    || sourceArtifactId.length === 0
    || sourceArtifactId.length > 240
    || !/^sha256:[0-9a-f]{64}$/i.test(artifactHash)
    || (output.externalId && output.externalId !== artifactHash)
  ) return null;
  const value = metadata?.artifact?.data
    || metadata?.artifact
    || metadata?.receipt;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return {
    kind:String(
      metadata.artifactKind
      || metadata.artifact?.type
      || snakeKind(metadata.kind),
    ).trim(),
    data:value,
  };
}

function replayM5StageWorkProduct(contract, product) {
  const artifactKind = contract.expectedWorkProduct.artifactKinds[0];
  const data = structuredClone(
    product?.metadata?.artifact
      || product?.metadata?.contentVersion
      || product?.metadata?.reviewReport
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
      output?.kind === 'work_product'
      && output?.type === 'artifact'
      && output?.provider === 'agent-army.publisher-gateway'
      && output?.sourceTrust == null
      && output?.status === 'active'
      && output?.healthStatus === 'healthy'
      && output?.metadata?.schemaVersion === 'agent.army/publish-receipt/v1'
      && output?.metadata?.kind === 'PublishReceipt',
    )
    .map((output) => output.metadata?.receipt)
    .filter((receipt) => receipt && typeof receipt === 'object' && !Array.isArray(receipt));
  if (receipts.length !== 1) {
    throw new ContentCampaignError(`发布核验必须且只能读取一个可信 PublishReceipt，当前为 ${receipts.length} 个。`);
  }
  const receipt = receipts[0];
  const platform = String(targetCase?.fields?.platform || '').trim();
  const scheduledDate = String(targetCase?.fields?.scheduledDate || '').trim();
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

function buildM5RenderProps({ script, voiceoverSrc, composition, visualAssets }) {
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
    scenes,
    captions,
  };
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
  const grant = campaignCase?.fields?.campaignGrant;
  const platform = String(targetCase?.fields?.platform || '').trim();
  const scheduledDate = String(targetCase?.fields?.scheduledDate || '').trim();
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
    fields:caseItem?.fields || {},
  };
}

function routeOutputHashes(outputs) {
  return (Array.isArray(outputs) ? outputs : [])
    .map((item) => String(
      item?.metadata?.artifactHash
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

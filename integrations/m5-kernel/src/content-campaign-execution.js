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

import { asList, safeId, safeReceiptId, safeText } from './content-campaign-primitives.js';
import {
  workProductArtifact,
  replayM5StageWorkProduct,
  artifactData,
  verifyPublishReceiptArtifact,
  snakeKind,
  safeWorkspaceRelativePath,
  positiveVersion,
  boundedDurationSeconds,
  renderPlatformKey,
  selectRenderOutput,
  verifiedM5VisualAssets,
  verifiedM5GeneratedVisual,
  m5ArtifactPackageVideos,
  m5SourcesLedger,
  m5ProviderProvenance,
  confirmedM5ProviderReceipt,
  assertReplayProviderReceipt,
  m5WorkProductDrift,
  validM5FixtureProvenance,
  optionalM5GrayScriptVariants,
  requireM5GrayScriptVariants,
  validM5ScriptVariant,
  m5ScriptHash,
  assertM5GrayTargetBinding,
  confirmedM5VoiceVariant,
  assertCompleteM5GrayVoiceVariants,
  optionalM5GrayRenderLineage,
  optionalM5BaselineRenderLineage,
  m5BaselineRenderLineage,
  m5RenderVariantDescriptor,
  hasM5VariantLineage,
  assertM5RenderOutputLineage,
  buildM5RenderProps,
  buildM5SocialCardProps,
  validM5SocialCardPackageReceipt,
  validM5Sha256,
  m5TextHash,
  resolveM5TemplateForRender,
  sameTemplateBinding,
  captionSafeText,
  deterministicM5ReviewChecks,
  validM5ReviewSource,
  bindingMatchesEvidenceClaim,
  evidenceFragmentKey,
  sameStringSet,
  containsSensitiveM5Text,
  containsUnsupportedPromise,
  m5HermesRouteExecution,
  m5HermesStrategy,
  m5HermesStageToolIds,
  executeM5Route,
  routeCaseInput,
  routeOutputHashes,
} from './content-campaign-execution-support.js';

const CASE_ID = /^[0-9a-f-]{8,80}$/i;
const RECEIPT_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const PLATFORMS = M5_PLATFORMS;
const CONTROL_ACTIONS = new Set(['pause', 'resume', 'stop']);
const CONTENT_AUTONOMY_PLUGIN_KEY = 'agent-army.content-autonomy';
const INVOKABLE_AGENT_STATUSES = new Set(['active', 'idle', 'running']);
const M5_PROVIDER_MODELS = M5_STEPFUN_MODELS;

export const contentCampaignExecutionMethods = {
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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

  async firstOfficialTtsVoice() {
    const voice = safeText(await this.controlPlane.getOfficialTtsVoice().catch(() => null), 120);
    if (!voice || /clone|克隆|复刻/i.test(voice)) {
      throw new ContentCampaignError('内容插件没有登记可用的官方 TTS 音色。');
    }
    return voice;
  },

  async getPublishReceipt(receiptId) {
    if (!this.publisher?.getReceipt) throw new ContentCampaignError('Publisher Gateway 尚未启用，当前没有可读取的发布凭证。');
    return this.publisher.getReceipt(safeReceiptId(receiptId));
  }
};

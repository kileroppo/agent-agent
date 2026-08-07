import { ContentCampaignError } from './campaign-domain.js';
import { getM5RoutineExecutionContract } from './routine-execution-contract.js';
import {
  healthyM5StageWorkProducts,
  m5StageWorkProductCandidates,
} from './stage-recovery-controller.js';
import { safeId } from './content-campaign-primitives.js';
import {
  replayM5StageWorkProduct,
  verifyPublishReceiptArtifact,
  m5WorkProductDrift,
  renderPlatformKey,
  confirmedM5ProviderReceipt,
  confirmedM5VoiceVariant,
  assertCompleteM5GrayVoiceVariants,
  validM5SocialCardPackageReceipt,
  m5HermesRouteExecution,
  m5HermesStrategy,
  m5HermesStageToolIds,
  executeM5Route,
  routeCaseInput,
  routeOutputHashes,
} from './content-campaign-execution-support.js';

const CONTENT_AUTONOMY_PLUGIN_KEY = 'agent-army.content-autonomy';

export const campaignExecutionRouteMethods = {
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
};

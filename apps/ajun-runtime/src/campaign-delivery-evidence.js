import { getM5RoutineExecutionContract } from '@agent-army/m5-kernel/routine-execution-contract';
import {
  healthyM5StageWorkProducts,
  m5StageWorkProductCandidates,
} from './m5-stage-recovery-controller.js';
import { assertM5ExecutorRouteReceipt } from './task-service-m5-execution-context-support.js';
import {
  ValidationError,
  contentGrowthArtifactVerified,
  isTerminalTask,
  m5WorkProductMetadata,
  m5WorkProductProvider,
  outputItems,
  paperclipUuid,
  validatedM5StagePluginData,
  verifiedAssignmentArtifact,
} from './task-service-execution-support.js';

/**
 * Owns the replay-safe Campaign Stage Execution receipt and Campaign Delivery
 * Evidence writeback protocol. TaskService keeps its compatibility Interface;
 * Case, artifact, Provider and Work Product invariants stay local to this Module.
 */
export class CampaignDeliveryEvidence {
  constructor({
    store,
    governance,
    workProductValidator = null,
    observeWorkProduct = null,
  } = {}) {
    this.store = store;
    this.governance = governance;
    this.workProductValidator = workProductValidator;
    this.observeWorkProduct = observeWorkProduct;
  }

  async recordStageExecution(taskId, result = {}) {
    const task = (await this.store.list()).find((item) => item.taskId === taskId);
    if (!task || isTerminalTask(task)) throw new ValidationError('M5 阶段任务不存在或已经结束。');
    const routineKey = String(task.input?.context?.paperclipRoutineKey || '').trim();
    const contract = getM5RoutineExecutionContract(routineKey);
    if (
      !contract
      || contract.executionMode !== 'hermes'
      || contract.executionTool?.id !== 'm5_stage_execute'
      || (!contract.pluginEntryTool && !contract.deterministicEntry)
    ) {
      throw new ValidationError('当前任务不接受 M5 内容插件阶段结果。');
    }
    const expectedToolId = contract.deterministicEntry === 'publish_receipt_verify'
      ? 'agent-army.m5:publish_receipt_verify'
      : `agent-army.content-autonomy:${contract.pluginEntryTool}`;
    const expectedProvider = contract.deterministicEntry === 'publish_receipt_verify'
      ? 'agent-army.m5-deterministic'
      : 'agent-army.content-autonomy';
    if (result?.toolId !== expectedToolId || result?.pluginId !== expectedProvider) {
      throw new ValidationError('M5 内容插件回执与当前阶段固定工具不一致。');
    }
    const artifactKind = contract.expectedWorkProduct.artifactKinds[0];
    const data = validatedM5StagePluginData(
      contract.stageKey,
      artifactKind,
      result,
    );
    const routeExecution = assertM5ExecutorRouteReceipt({
      task,
      contract,
      result:result?.routeExecution,
    });
    const pipelineCaseId = String(task.input?.context?.pipelineCaseId || '').trim();
    const artifactId = `m5-stage:${pipelineCaseId}:${artifactKind}`;
    const existing = (task.artifactRefs || []).find((item) => item.artifactId === artifactId);
    if (existing) {
      const updated = await this.store.updateTask(task.taskId, {
        ...(routeExecution ? {
          execution:{
            ...(task.execution || {}),
            m5RouteExecution:routeExecution,
          },
        } : {}),
      });
      return { task:updated, artifact:existing, duplicate:true };
    }
    const createdAt = new Date().toISOString();
    const artifact = {
      artifactId,
      taskId:task.taskId,
      type:artifactKind,
      title:`M5 ${contract.stageKey} 阶段插件产物`,
      location:`runtime://${task.taskId}/${artifactKind}`,
      mimeType:'application/json',
      accessScope:'local-owner',
      validation:{
        exists:true,
        readable:true,
        nonEmpty:true,
        pluginReceiptVerified:true,
      },
      createdAt,
      data,
    };
    const updated = await this.store.updateTask(task.taskId, {
      currentStage:`${contract.stageKey}_tool_completed`,
      artifactRefs:[...(task.artifactRefs || []), artifact],
      ...(routeExecution ? {
        execution:{
          ...(task.execution || {}),
          m5RouteExecution:routeExecution,
        },
      } : {}),
    });
    return { task:updated, artifact, duplicate:false };
  }

  async recordStageFailure(taskId, routeExecution, error) {
    const task = (await this.store.list()).find((item) => item.taskId === taskId);
    if (!task || isTerminalTask(task)) return null;
    const contract = getM5RoutineExecutionContract(
      task.input?.context?.paperclipRoutineKey,
    );
    if (!contract || contract.executionTool?.id !== 'm5_stage_execute') return null;
    const receipt = assertM5ExecutorRouteReceipt({
      task,
      contract,
      result:routeExecution,
      allowUnchanged:true,
    });
    return this.store.updateTask(task.taskId, {
      currentStage:'m5_stage_executor_failed',
      execution:{
        ...(task.execution || {}),
        m5RouteExecution:receipt,
      },
      error:{
        code:String(error?.code || 'm5_stage_executor_failed').slice(0, 120),
        message:String(error?.message || 'M5 阶段执行失败。').slice(0, 500),
        userMessage:'M5 阶段执行失败，已保存真实路线回执供恢复控制器判断。',
        category:'retryable',
        stage:contract.stageKey,
        retryable:true,
        occurredAt:new Date().toISOString(),
      },
    });
  }

  async syncStageWorkProducts({ task, assignment, apiKey } = {}) {
    const contract = getM5RoutineExecutionContract(assignment?.routineKey);
    if (!contract || contract.executionMode !== 'hermes') return { synced:false, reason:'not_m5_hermes' };
    if (
      !assignment.pipelineCaseId
      || typeof this.governance?.getPipelineCaseOutputs !== 'function'
      || typeof this.governance?.createIssueWorkProduct !== 'function'
    ) {
      throw new ValidationError('M5 阶段缺少 Paperclip Case Work Product 写回能力。');
    }
    const expected = contract.expectedWorkProduct;
    const expectedVisualProjectId = contract.stageKey === 'visual_analysis'
      ? paperclipUuid(assignment.projectId)
      : null;
    if (contract.stageKey === 'visual_analysis' && !expectedVisualProjectId) {
      throw new ValidationError('M5 画面分析缺少可信 Paperclip Project，不能写入 Work Product。');
    }
    const currentOutputs = outputItems(await this.governance.getPipelineCaseOutputs(
      assignment.pipelineCaseId,
    ));
    let paperclipRunsPromise = null;
    const validatePersistedProduct = async (product) => {
      if (!this.workProductValidator) {
        throw new ValidationError(
          `M5 ${contract.stageKey} 已有 Work Product 但完整漂移校验器不可用，禁止重放或回读。`,
        );
      }
      try {
        if (!paperclipRunsPromise) {
          paperclipRunsPromise = typeof this.governance?.getPaperclipIssueRuns === 'function'
            ? this.governance.getPaperclipIssueRuns(assignment.issueId)
            : Promise.resolve([]);
        }
        await this.workProductValidator({
          contract,
          product,
          targetCaseId:assignment.pipelineCaseId,
          projectId:assignment.projectId,
          assignment,
          task,
          paperclipRuns:await paperclipRunsPromise,
        });
      } catch (error) {
        throw new ValidationError(
          `M5 ${contract.stageKey} Work Product 漂移：${error?.message || '完整校验失败'}。`,
        );
      }
      if (healthyM5StageWorkProducts([product], contract).length !== 1) {
        throw new ValidationError(
          `M5 ${contract.stageKey} Work Product 漂移：结构、Provider 或状态不符合阶段契约。`,
        );
      }
    };
    const existingStageCandidates = m5StageWorkProductCandidates(currentOutputs, contract);
    if (existingStageCandidates.length > 1) {
      throw new ValidationError(`M5 ${contract.stageKey} 阶段存在重复 Work Product 或未解决漂移，必须先核对。`);
    }
    if (existingStageCandidates.length === 1) {
      const existingStageProduct = existingStageCandidates[0];
      if (
        contract.stageKey === 'visual_analysis'
        && !contentGrowthArtifactVerified(task, {
          type:'visual_analysis_package',
          validation:{ exists:true, readable:true, nonEmpty:true },
          data:existingStageProduct?.metadata?.artifact,
        }, {
          expectedProjectId:expectedVisualProjectId,
        })
      ) {
        throw new ValidationError(
          'M5 画面分析已有 Work Product 的视觉回执、哈希或 Project 发生漂移，禁止重放或覆盖。',
        );
      }
      await validatePersistedProduct(existingStageProduct);
      return {
        synced:true,
        replayed:true,
        count:1,
        schemaVersion:expected.schemaVersion,
      };
    }
    const artifacts = (task?.artifactRefs || []).filter((artifact) =>
      expected.artifactKinds.includes(artifact?.type)
      && verifiedAssignmentArtifact(artifact)
      && (
        artifact?.type !== 'visual_analysis_package'
        || contentGrowthArtifactVerified(task, artifact, {
          expectedProjectId:expectedVisualProjectId,
        })
      )
    );
    if (artifacts.length < expected.minCount) {
      throw new ValidationError(
        `M5 ${contract.stageKey} 阶段缺少 ${expected.artifactKinds.join('/')} 专用产物，不能只凭普通回报完成。`,
      );
    }

    for (const artifact of artifacts.slice(0, expected.minCount)) {
      const outputs = outputItems(await this.governance.getPipelineCaseOutputs(
        assignment.pipelineCaseId,
      ));
      const stageCandidates = m5StageWorkProductCandidates(outputs, contract);
      if (stageCandidates.length > 1) {
        throw new ValidationError(`M5 ${contract.stageKey} 阶段存在重复 Work Product 或未解决漂移，必须先核对。`);
      }
      const existing = outputs.filter((item) =>
        item.kind === 'work_product'
        && item.type === 'artifact'
        && item.metadata?.sourceTaskId === task.taskId
        && item.metadata?.sourceArtifactId === artifact.artifactId,
      );
      if (
        stageCandidates.length === 1
        && (existing.length !== 1 || stageCandidates[0] !== existing[0])
      ) {
        throw new ValidationError(`M5 ${contract.stageKey} 阶段存在来源不一致的 Work Product 候选，禁止覆盖。`);
      }
      if (existing.length > 1) {
        throw new ValidationError(`M5 ${contract.stageKey} 阶段存在重复 Work Product，必须先核对漂移。`);
      }
      if (existing.length === 1) {
        await validatePersistedProduct(existing[0]);
        continue;
      }

      const metadata = m5WorkProductMetadata({ contract, task, artifact, assignment });
      await this.governance.createIssueWorkProduct(assignment.issueId, {
        type:'artifact',
        provider:m5WorkProductProvider(expected.type),
        externalId:metadata.artifactHash,
        title:`M5 ${contract.stageKey} / ${artifact.title || expected.type}`,
        status:'active',
        reviewState:'none',
        isPrimary:true,
        healthStatus:'healthy',
        summary:`${contract.stageKey} 阶段专用产物已由当前 Paperclip Run 写回。`,
        metadata,
        createdByRunId:assignment.runId,
      }, {
        runId:assignment.runId,
        apiKey,
      });
    }

    const finalOutputs = outputItems(await this.governance.getPipelineCaseOutputs(
      assignment.pipelineCaseId,
    ));
    const finalStageCandidates = m5StageWorkProductCandidates(finalOutputs, contract);
    if (finalStageCandidates.length > expected.minCount) {
      throw new ValidationError(`M5 ${contract.stageKey} 阶段写回后存在重复 Work Product 或未解决漂移。`);
    }
    const persisted = [];
    for (const artifact of artifacts.slice(0, expected.minCount)) {
      const candidates = finalOutputs.filter((item) =>
        item.kind === 'work_product'
        && item.type === 'artifact'
        && item.metadata?.sourceTaskId === task.taskId
        && item.metadata?.sourceArtifactId === artifact.artifactId,
      );
      if (candidates.length > 1) {
        throw new ValidationError(`M5 ${contract.stageKey} 阶段存在重复 Work Product，必须先核对漂移。`);
      }
      if (candidates.length === 1) {
        await validatePersistedProduct(candidates[0]);
        persisted.push(candidates[0]);
      }
    }
    if (persisted.length < expected.minCount) {
      throw new ValidationError(`M5 ${contract.stageKey} Work Product 写回后无法从同一 Case 回读。`);
    }
    if (typeof this.observeWorkProduct === 'function') {
      await this.observeWorkProduct({
        pipelineCaseId:assignment.pipelineCaseId,
        stageKey:contract.stageKey,
        routineKey:contract.routineKey,
        workProductType:expected.type,
      });
    }
    return { synced:true, count:persisted.length, schemaVersion:expected.schemaVersion };
  }
}

import { validateArchitectureEvidenceRefs } from './architecture-evidence.js';
import { getM5RoutineExecutionContract } from '@agent-army/m5-kernel/routine-execution-contract';
import {
  healthyM5StageWorkProducts,
  m5StageWorkProductCandidates,
  M5StageRecoveryController,
} from './m5-stage-recovery-controller.js';
import { taskPaperclipAssignmentMethods } from './task-paperclip-assignment.js';
import { taskRoleExecutionMethods } from './task-role-execution.js';
import { validateTaskCompletion } from './task-completion-contract.js';
import { taskIdempotencyFingerprint } from './task-idempotency.js';
import {
  isPaperclipCompletableTaskStatus,
  paperclipCompletionConfirmed,
  paperclipCompletionSync,
  paperclipIssueStatusForTask,
} from './paperclip-assignment-completion.js';

import {
  ValidationError,
  isTerminalTask,
  validatedM5StagePluginData,
  paperclipUuid,
  assertM5PlanRevisionConsumed,
  assertM5ExecutorRouteReceipt,
  m5WorkProductMetadata,
  m5WorkProductProvider,
  outputItems,
  verifiedAssignmentArtifact,
  contentGrowthArtifactVerified,
  normalizeArchitectureLayers,
} from './task-service-execution-support.js';

export const taskServiceExecutionMethods = {
  ...taskPaperclipAssignmentMethods,

  async recordM5StageExecution(taskId, result = {}) {
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
    if (
      result?.toolId !== expectedToolId
      || result?.pluginId !== expectedProvider
    ) {
      throw new ValidationError('M5 内容插件回执与当前阶段固定工具不一致。');
    }
    const artifactKind = contract.expectedWorkProduct.artifactKinds[0];
    const data = validatedM5StagePluginData(
      contract.stageKey,
      contract.expectedWorkProduct.artifactKinds[0],
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
  },

  async recordM5StageExecutionFailure(taskId, routeExecution, error) {
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
  },

  completePaperclipAssignment(input = {}) {
    const key = `${String(input.issueId || '').trim()}:${String(input.runId || '').trim()}`;
    const fingerprint = taskIdempotencyFingerprint(Object.fromEntries(Object.entries(input).filter(([name]) => name !== 'paperclipApiKey')));
    const running = this.paperclipAssignmentCompletionRuns.get(key);
    if (running) {
      if (running.fingerprint !== fingerprint) throw new ValidationError('同一 Paperclip Run 正在回报不同的完成结果；已拒绝覆盖。');
      return running.execution;
    }
    const execution = Promise.resolve().then(() => this.completePaperclipAssignmentOnce(input)).finally(() => {
      if (this.paperclipAssignmentCompletionRuns.get(key)?.execution === execution) this.paperclipAssignmentCompletionRuns.delete(key);
    });
    this.paperclipAssignmentCompletionRuns.set(key, { fingerprint, execution });
    return execution;
  },

  async completePaperclipAssignmentOnce(input = {}) {
    const { task, assignment } = await this.getPaperclipAssignment(input);
    if (isTerminalTask(task)) {
      const synchronized = await this.ensurePaperclipAssignmentCompletion({ task, assignment, paperclipAgentId:input.paperclipAgentId, apiKey:input.paperclipApiKey });
      return { task:synchronized, assignment, duplicate:true };
    }
    const requestedStatus = String(input.status || 'succeeded').trim();
    if (!['succeeded', 'failed', 'waiting_test'].includes(requestedStatus)) {
      throw new ValidationError('员工回报状态无效。');
    }
    const completedAt = new Date().toISOString();
    const summary = String(input.summary || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
    if (!summary) throw new ValidationError('员工必须提供可核对的结果摘要。');
    const m5Contract = getM5RoutineExecutionContract(assignment.routineKey);
    const m5PlanRevisionReceipt = m5Contract?.executionMode === 'hermes'
      ? assertM5PlanRevisionConsumed({
          expected:task.input?.context?.m5Recovery,
          actual:task.execution?.m5RouteExecution,
          runId:assignment.runId,
          allowUnchangedFailure:requestedStatus === 'failed',
          input,
        })
      : null;
    if (
      requestedStatus === 'succeeded'
      && m5Contract?.stageKey === 'visual_analysis'
    ) {
      const projectId = paperclipUuid(assignment.projectId);
      const verifiedVisual = projectId && (task.artifactRefs || []).some((artifact) =>
        artifact?.type === 'visual_analysis_package'
        && contentGrowthArtifactVerified(task, artifact, {
          expectedProjectId:projectId,
        })
      );
      if (!verifiedVisual) {
        throw new ValidationError(
          'M5 画面分析缺少与当前 Paperclip Project 一致的 confirmed 视觉回执，不能回报 succeeded。',
        );
      }
    }
    if (requestedStatus === 'failed' && m5Contract?.executionMode === 'hermes') {
      return this.handleM5ReportedFailure({
        task,
        assignment,
        contract:m5Contract,
        summary,
        completedAt,
        m5PlanRevisionReceipt,
      });
    }
    let architectureEvidence = null;
    let architectureLayers = null;
    if (assignment.agentId === 'architect') {
      const groundTruth = await this.architectureGroundTruth();
      architectureLayers = normalizeArchitectureLayers(input);
      const factEvidence = validateArchitectureEvidenceRefs(
        architectureLayers.factClaims.flatMap((item) => item.evidenceRefs.map((ref) => ({ ref, claim:item.claim }))),
        groundTruth
      );
      const judgmentEvidence = validateArchitectureEvidenceRefs(
        architectureLayers.architectureJudgments.flatMap((item) => item.basisRefs.map((ref) => ({ ref, claim:item.judgment }))),
        groundTruth
      );
      const invalidRefs = [...new Set([...factEvidence.invalidRefs, ...judgmentEvidence.invalidRefs])];
      architectureEvidence = {
        valid:factEvidence.valid && invalidRefs.length === 0,
        refs:[...factEvidence.refs, ...judgmentEvidence.refs],
        invalidRefs,
        snapshotId:groundTruth.snapshotId
      };
      if (invalidRefs.length) {
        throw new ValidationError(`架构报告引用了快照中不存在的对象：${invalidRefs.join('、')}。当前事实和判断依据必须使用真实引用。`);
      }
      if (requestedStatus === 'succeeded' && !factEvidence.valid) {
        const reason = factEvidence.invalidRefs.length
          ? `当前事实引用了快照中不存在的对象：${factEvidence.invalidRefs.join('、')}`
          : '架构报告至少需要一条带真实引用的当前事实；推理和候选方案不能替代现状基线。';
        throw new ValidationError(`${reason} 未写入成功结论。`);
      }
    }
    const artifact = {
      taskId:task.taskId,
      type:'employee_role_report',
      data:{
        agentId:assignment.agentId,
        summary,
        evidence:String(input.evidence || '').replace(/\s+/g, ' ').trim().slice(0, 4000),
        remainingRisks:String(input.remainingRisks || '').replace(/\s+/g, ' ').trim().slice(0, 2000),
        ...(architectureEvidence ? {
          evidenceRefs:architectureEvidence.refs,
          evidenceValidation:{
            valid:architectureEvidence.valid,
            invalidRefs:architectureEvidence.invalidRefs,
            snapshotId:architectureEvidence.snapshotId
          },
          factClaims:architectureLayers.factClaims,
          architectureJudgments:architectureLayers.architectureJudgments,
          candidateProposals:architectureLayers.candidateProposals,
          currentStateUnknowns:architectureLayers.currentStateUnknowns,
          // 兼容旧读取方；新写入统一使用 currentStateUnknowns。
          unverifiedClaims:architectureLayers.currentStateUnknowns
        } : {}),
        paperclipIssueId:assignment.issueId,
        paperclipRunId:assignment.runId,
        ...(m5PlanRevisionReceipt ? {
          m5PlanRevisionReceipt,
        } : {}),
      },
      validation:{ exists:true, readable:true, nonEmpty:true, checkedAt:completedAt }
    };
    const completionArtifacts = [...(task.artifactRefs || []), artifact];
    if (requestedStatus === 'succeeded') {
      const completion = validateTaskCompletion(task, completionArtifacts);
      if (!completion.valid) throw new ValidationError(`${completion.reason} Paperclip/Hermes 的文字回报不能替代专用业务产物。`);
    }
    let updated = await this.store.updateTask(task.taskId, {
      status:requestedStatus,
      currentStage:requestedStatus === 'succeeded' ? 'paperclip_hermes_completed' : requestedStatus === 'waiting_test' ? 'paperclip_hermes_waiting_test' : 'paperclip_hermes_failed',
      artifactRefs:completionArtifacts,
      execution:{
        ...(task.execution || {}),
        owner:'paperclip-hermes',
        finishedAt:completedAt,
        outcome:requestedStatus,
        ...(m5PlanRevisionReceipt ? {
          m5PlanRevisionReceipt,
        } : {}),
      },
      governance:{
        ...(task.governance || {}),
        completionSync:paperclipCompletionSync({ status:'pending', taskStatus:requestedStatus, issueId:assignment.issueId, runId:assignment.runId, now:completedAt }),
      },
      ...(requestedStatus === 'failed' ? {
        error:{
          code:'paperclip_hermes_reported_failure',
          message:summary,
          userMessage:'员工已如实回报任务失败，请查看结果摘要和剩余风险。',
          category:'manual',
          stage:'paperclip_hermes',
          retryable:false,
          occurredAt:completedAt
        }
      } : { error:undefined })
    });
    updated = await this.ensurePaperclipAssignmentCompletion({ task:updated, assignment, paperclipAgentId:input.paperclipAgentId, apiKey:input.paperclipApiKey });
    return { task:updated, assignment, duplicate:false };
  },

  async ensurePaperclipAssignmentCompletion({ task, assignment, paperclipAgentId, apiKey } = {}) {
    if (!isPaperclipCompletableTaskStatus(task?.status)) return task;
    if (task.status === 'succeeded') await this.syncM5StageWorkProducts({ task, assignment, apiKey });
    if (paperclipCompletionConfirmed(task, assignment)) return task;
    const expected = paperclipIssueStatusForTask(task.status);
    if (typeof this.governance?.getPaperclipIssue === 'function') {
      try {
        const issue = await this.governance.getPaperclipIssue(assignment.issueId);
        if (String(issue?.status || '').trim() === expected) return this.confirmPaperclipAssignmentCompletion(task, assignment);
      } catch {}
    }
    await this.governance.completePaperclipIssue(assignment.issueId, { runId:assignment.runId, agentId:paperclipAgentId, apiKey, result:task });
    return this.confirmPaperclipAssignmentCompletion(task, assignment);
  },

  async confirmPaperclipAssignmentCompletion(task, assignment) {
    const confirmedAt = new Date().toISOString();
    return this.store.updateTask(task.taskId, {
      governance:{ ...(task.governance || {}), status:'synced', syncedAt:confirmedAt, completionSync:paperclipCompletionSync({ status:'confirmed', taskStatus:task.status, issueId:assignment.issueId, runId:assignment.runId, now:confirmedAt }) },
    });
  },

  async handleM5ReportedFailure({
    task,
    assignment,
    contract,
    summary,
    completedAt,
    m5PlanRevisionReceipt = null,
  } = {}) {
    const controller = new M5StageRecoveryController({
      governance:this.governance,
      workProductValidator:this.m5WorkProductValidator,
    });
    const recovery = await controller.handleFailure({
      assignment,
      contract,
      task,
      summary,
      routeExecution:task.execution?.m5RouteExecution,
    });
    const failureArtifactId = `m5-stage-failure:${assignment.pipelineCaseId}:${assignment.runId}`;
    const failureArtifact = {
      artifactId:failureArtifactId,
      taskId:task.taskId,
      type:'employee_role_report',
      data:{
        agentId:assignment.agentId,
        summary,
        paperclipIssueId:assignment.issueId,
        paperclipRunId:assignment.runId,
        m5Recovery:{
          action:recovery.action,
          stageAttempt:recovery.stageAttempt,
          replanCount:recovery.replanCount,
          recoveryAction:recovery.recoveryAction || null,
        },
        ...(m5PlanRevisionReceipt ? {
          m5PlanRevisionReceipt,
        } : {}),
      },
      validation:{ exists:true, readable:true, nonEmpty:true, checkedAt:completedAt },
    };
    const retainedArtifacts = (task.artifactRefs || []).filter((artifact) =>
      artifact.artifactId !== failureArtifactId
      && !contract.expectedWorkProduct.artifactKinds.includes(artifact.type),
    );
    const verifiedReplay = recovery.action === 'verified_work_product';
    const blocked = recovery.action === 'blocked';
    const status = verifiedReplay ? 'succeeded' : blocked ? 'failed' : 'running';
    const currentStage = verifiedReplay
      ? 'm5_stage_work_product_replayed'
      : blocked
        ? 'm5_stage_recovery_blocked'
        : recovery.action === 'replan'
          ? 'm5_content_replan_scheduled'
          : 'm5_stage_retry_scheduled';
    const updated = await this.store.updateTask(task.taskId, {
      status,
      currentStage,
      artifactRefs:[...retainedArtifacts, failureArtifact],
      execution:{
        ...(task.execution || {}),
        owner:'paperclip-hermes',
        finishedAt:verifiedReplay || blocked ? completedAt : null,
        outcome:verifiedReplay
          ? 'verified_work_product_replayed'
          : blocked
            ? 'm5_stage_recovery_blocked'
            : recovery.action === 'replan'
              ? 'm5_content_replan_scheduled'
              : 'm5_stage_retry_scheduled',
        paperclipEmployee:null,
        m5Recovery:{
          action:recovery.action,
          stageAttempt:recovery.stageAttempt,
          replanCount:recovery.replanCount,
          runId:assignment.runId,
          replayed:recovery.replayed === true,
          recoveryAction:recovery.recoveryAction || null,
        },
        ...(m5PlanRevisionReceipt ? {
          m5PlanRevisionReceipt,
        } : {}),
      },
      governance:{
        ...(task.governance || {}),
        status:'synced',
        syncedAt:completedAt,
      },
      error:verifiedReplay ? undefined : {
        code:blocked ? 'm5_stage_recovery_limit_reached' : `m5_${recovery.action}_scheduled`,
        message:summary,
        userMessage:blocked
          ? recovery.recoveryAction?.instruction || 'M5 阶段恢复上限已达到，等待负责人恢复当前 Case。'
          : recovery.action === 'replan'
            ? `M5 ${contract.stageKey} 阶段重试已用尽，已安排受控内容重规划。`
            : `M5 ${contract.stageKey} 阶段已安排安全重试。`,
        category:blocked ? 'manual' : 'retryable',
        stage:contract.stageKey,
        retryable:!blocked,
        occurredAt:completedAt,
      },
    });
    return {
      task:updated,
      assignment,
      recovery,
      duplicate:recovery.replayed === true,
    };
  },

  async syncM5StageWorkProducts({ task, assignment, apiKey } = {}) {
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
      if (!this.m5WorkProductValidator) {
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
        await this.m5WorkProductValidator({
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
        && (
          existing.length !== 1
          || stageCandidates[0] !== existing[0]
        )
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
    if (typeof this.m5WorkProductObserver === 'function') {
      await this.m5WorkProductObserver({
        pipelineCaseId:assignment.pipelineCaseId,
        stageKey:contract.stageKey,
        routineKey:contract.routineKey,
        workProductType:expected.type,
      });
    }
    return { synced:true, count:persisted.length, schemaVersion:expected.schemaVersion };
  },

  ...taskRoleExecutionMethods,
};

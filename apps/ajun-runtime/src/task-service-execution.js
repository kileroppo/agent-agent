import crypto from 'node:crypto';
import path from 'node:path';
import { recordTaskUsage } from './task-usage.js';
import { formatPublicReportReply } from './public-report-presentation.js';
import { formatOfficeBriefingReply } from './local-office-assistant.js';
import { canonicalizeBusinessAssignment, githubRepositoryQuery } from './business-task-routing.js';
import { usesPaperclipHermesExecution } from './governance-hermes-runtime.js';
import { buildArchitectureGroundTruth, validateArchitectureEvidenceRefs } from './architecture-evidence.js';
import { presentTask } from './task-presentation.js';
import {
  executeIntelResearchOpenTaskStep,
  inspectOpenTaskManifestCapabilities,
  routeOpenTaskForExecutor,
  supportsOpenTask
} from './open-task-routing.js';
import { WECHAT_CHAT_TASK_TYPE, normalizeWechatChatRequest, wechatApprovalScope } from './wechat-chat-defaults.js';
import { SkillExecutionRegistry } from './skill-execution-registry.js';
import { TaskCapabilityCatalog } from './task-capability-catalog.js';
import { TaskExecutionCoordinator } from './task-execution-coordinator.js';
import { buildTaskFocus } from './task-overview-focus.js';
import { privateReadGrantStatus, revokePrivateReadGrant } from './private-read-grant.js';
import {
  assertPaperclipEmployeeExecutorAssignment,
  resolvePaperclipAssignmentTaskType,
} from './paperclip-employee-assignment.js';
import { getM5RoutineExecutionContract } from '@agent-army/m5-kernel/routine-execution-contract';
import {
  getActiveM5PlanRevision,
  healthyM5StageWorkProducts,
  m5StageWorkProductCandidates,
  M5StageRecoveryController,
} from './m5-stage-recovery-controller.js';
import {
  assertChangedM5RecoveryRoute,
  createM5RouteExecution,
  validM5RouteExecution,
} from '@agent-army/m5-kernel/route-execution';
import { m5WorkProductArtifactHash } from '@agent-army/m5-kernel/work-product-integrity';
import {
  M5_PLATFORMS,
  M5_SCHEMA_IDS,
  M5_STEPFUN_MODELS,
  normalizeM5Sha256,
} from '@agent-army/m5-contracts';
import {
  compileM5RoleToolGrant,
  createM5RoleToolExecutionContext,
  M5RoleToolGrantError,
} from './m5-role-tool-grant.js';

import { ValidationError } from './task-service-error.js';
import { isTerminalTask } from './task-service-state.js';

import {
  validatedM5StagePluginData,
  declaredM5StageArtifact,
  validM5RenderOutput,
  validM5SocialCardPackage,
  safeRelativeDirectory,
  sha256Text,
  findUnsafeM5PluginValue,
  safeRelativeArtifactPath,
  safeRelativeImageArtifactPath,
  safeM5VisionRelativePath,
  sha256Value,
  paperclipUuid,
  validConfirmedM5ProviderReceipt,
  taskExecutionView,
  paperclipCaseContextFields,
  m5PlanRevisionExecutionContext,
  assertM5PlanRevisionConsumed,
  prepareM5ExecutorTask,
  assertM5ExecutorRouteReceipt,
  m5BusinessExecutionInput,
  trustedRoleToolScope,
  m5PipelineCaseChainIds,
  m5RelatedTaskContext,
  m5WorkProductMetadata,
  m5WorkProductProvider,
  sanitizeM5ArtifactData,
  validM5ContentVersion,
  validM5MachineReview,
  validM5ArtifactPackage,
  validM5RelativePath,
  outputItems,
  canonicalOpenResearchExecutionPolicy,
  verifiedAssignmentArtifact,
  storedPaperclipEmployeeResult,
  artifactExecutionView,
  contentGrowthArtifactVerified,
  storedContentGrowthResult,
  settleWithin,
  normalizeArchitectureLayers,
  architectureText,
  architectureStrings,
} from './task-service-execution-support.js';

const ROLE_TOOL_GRANT = Symbol('m5RoleToolGrant');
const OPEN_RESEARCH_EXECUTION_POLICY = Symbol('openResearchExecutionPolicy');

export const taskServiceExecutionMethods = {
  async getPaperclipAssignment(input = {}) {
    if (!this.governance?.verifyHermesAssignment) throw new ValidationError('Paperclip 任务校验能力不可用。');
    const identity = await this.governance.verifyHermesAssignment(input);
    const agent = await this.registry.get(identity.agentArmyId);
    if (!usesPaperclipHermesExecution(agent)) throw new ValidationError('当前岗位未启用 Paperclip Hermes 执行。');
    let assignmentTask;
    try {
      assignmentTask = resolvePaperclipAssignmentTaskType({ agent, issue:identity.issue });
    } catch (error) {
      throw new ValidationError(error?.message || '当前 Paperclip 指派任务类型无法安全映射。');
    }
    const storedTasks = await this.store.list();
    let task = storedTasks.find((item) => item.governance?.paperclipIssueId === identity.issue.id);
    if (task && assignmentTask.routineKey && task.taskType !== assignmentTask.taskType) {
      throw new ValidationError(`当前任务信封类型与 M5 Routine ${assignmentTask.routineKey} 不一致。`);
    }
    const pipelineCase = assignmentTask.pipelineCaseId && typeof this.governance.getPipelineCase === 'function'
      ? await this.governance.getPipelineCase(assignmentTask.pipelineCaseId)
      : null;
    if (assignmentTask.pipelineCaseId) {
      if (typeof this.governance?.assertCaseIssueLink !== 'function') {
        throw new ValidationError('M5 Pipeline Case 缺少 Issue 绑定核验能力。');
      }
      await this.governance.assertCaseIssueLink(
        assignmentTask.pipelineCaseId,
        identity.issue.id,
      );
    }
    const assignmentProjectId = String(
      identity?.issue?.projectId
      || pipelineCase?.case?.projectId
      || pipelineCase?.projectId
      || '',
    ).trim() || null;
    const m5Contract = getM5RoutineExecutionContract(assignmentTask.routineKey);
    const activePlanRevision = m5Contract?.executionMode === 'hermes'
      ? await getActiveM5PlanRevision({
          governance:this.governance,
          pipelineCaseId:assignmentTask.pipelineCaseId,
          stageKey:m5Contract.stageKey,
          pipelineCase,
        })
      : null;
    const baseRoleToolGrant = await this.compilePaperclipRoleToolGrant({
      agent,
      identity,
      pipelineCase,
    });
    const relatedCaseIds = await m5PipelineCaseChainIds({
      governance:this.governance,
      pipelineCaseId:assignmentTask.pipelineCaseId,
      pipelineCase,
    });
    const related = m5RelatedTaskContext(storedTasks, relatedCaseIds, pipelineCase);
    if (!task) {
      const acceptedTaskType = assignmentTask.taskType;
      if (!acceptedTaskType) throw new ValidationError('当前岗位没有可映射的任务类型。');
      const caseFields = paperclipCaseContextFields(
        pipelineCase?.case?.fields || pipelineCase?.fields || {},
      );
      task = await this.store.createTask({
        taskType:acceptedTaskType,
        idempotencyKey:`paperclip:${identity.issue.id}`,
        requester:{ kind:'paperclip', ref:identity.issue.id },
        source:{ channel:'paperclip', paperclipIssueId:identity.issue.id, paperclipRunId:identity.run.id },
        assigneeAgentId:agent.agentId,
        parentTaskId:null,
        input:{
          title:String(identity.issue.title || 'Paperclip 指派任务').slice(0, 500),
          description:String(identity.issue.description || '').slice(0, 4000),
          topic:caseFields.theme || null,
          contentGoal:caseFields.theme || null,
          platforms:caseFields.platform ? [caseFields.platform] : [],
          sourceUrl:related.sourceUrls[0] || null,
          sourceUrls:related.sourceUrls,
          context:{
            paperclipIssueIdentifier:identity.issue.identifier || null,
            ...(assignmentTask.routineKey ? { paperclipRoutineKey:assignmentTask.routineKey } : {}),
            ...(assignmentTask.pipelineCaseId ? { pipelineCaseId:assignmentTask.pipelineCaseId } : {}),
            ...(assignmentProjectId ? { paperclipProjectId:assignmentProjectId } : {}),
            ...(activePlanRevision ? {
              m5Recovery:m5PlanRevisionExecutionContext(activePlanRevision),
            } : {}),
            ...(related.sourceTaskIds.length ? { sourceTaskIds:related.sourceTaskIds } : {}),
            ...(pipelineCase ? {
              pipelineCase:{
                id:pipelineCase.case?.id || pipelineCase.id || assignmentTask.pipelineCaseId,
                parentCaseId:pipelineCase.case?.parentCaseId || pipelineCase.parentCaseId || null,
                caseKey:pipelineCase.case?.caseKey || pipelineCase.caseKey || null,
                title:pipelineCase.case?.title || pipelineCase.title || null,
                stageKey:pipelineCase.case?.stageKey || pipelineCase.stageKey || null,
                fields:caseFields,
              },
            } : {}),
          }
        },
        status:'running',
        currentStage:'paperclip_hermes_running',
        routing:{ requestedAgentId:agent.agentId, candidateAgentIds:[agent.agentId], reason:'Paperclip 已把任务指派给该员工的 Hermes Profile。' },
        governance:{
          status:'synced',
          paperclipIssueId:identity.issue.id,
          paperclipIssueIdentifier:identity.issue.identifier || null,
          paperclipAssigneeAgentId:identity.paperclipAgent.id,
          paperclipAssigneeName:identity.paperclipAgent.name,
          syncedAt:new Date().toISOString()
        },
        execution:{
          owner:'paperclip-hermes',
          hermesProfileId:agent.agentId,
          paperclipRunId:identity.run.id,
          paperclipAgentId:identity.paperclipAgent.id,
          startedAt:new Date().toISOString()
        }
      });
    } else if (!isTerminalTask(task)) {
      task = await this.store.updateTask(task.taskId, {
        status:'running',
        currentStage:task.execution?.paperclipEmployee
          ? task.currentStage
          : 'paperclip_hermes_running',
        execution:{
          ...(task.execution || {}),
          owner:'paperclip-hermes',
          hermesProfileId:agent.agentId,
          paperclipRunId:identity.run.id,
          paperclipAgentId:identity.paperclipAgent.id,
          startedAt:task.execution?.startedAt || new Date().toISOString()
        },
        input:{
          ...(task.input || {}),
          context:{
            ...(task.input?.context || {}),
            m5Recovery:activePlanRevision
              ? m5PlanRevisionExecutionContext(activePlanRevision)
              : null,
            ...(assignmentProjectId ? { paperclipProjectId:assignmentProjectId } : {}),
            ...(related.sourceTaskIds.length ? { sourceTaskIds:related.sourceTaskIds } : {}),
            ...(pipelineCase ? {
              pipelineCase:{
                id:pipelineCase.case?.id || pipelineCase.id || assignmentTask.pipelineCaseId,
                parentCaseId:pipelineCase.case?.parentCaseId || pipelineCase.parentCaseId || null,
                caseKey:pipelineCase.case?.caseKey || pipelineCase.caseKey || null,
                title:pipelineCase.case?.title || pipelineCase.title || null,
                stageKey:pipelineCase.case?.stageKey || pipelineCase.stageKey || null,
                fields:paperclipCaseContextFields(
                  pipelineCase.case?.fields || pipelineCase.fields || {},
                ),
              },
            } : {}),
          },
        },
      });
    }
    const groundTruth = agent.agentId === 'architect' ? await this.architectureGroundTruth() : null;
    const roleToolGrant = baseRoleToolGrant
      ? Object.freeze({
          ...baseRoleToolGrant,
          trustedScope:trustedRoleToolScope({
            tasks:storedTasks,
            task,
            relatedTaskIds:related.sourceTaskIds,
            paperclipIssueId:identity.issue.id,
            paperclipRunId:identity.run.id,
            pipelineCaseId:assignmentTask.pipelineCaseId,
          }),
        })
      : null;
    const verified = {
      task,
      assignment:{
        issueId:identity.issue.id,
        identifier:identity.issue.identifier || null,
        title:identity.issue.title,
        description:identity.issue.description || '',
        agentId:agent.agentId,
        runId:identity.run.id,
        routineKey:assignmentTask.routineKey || null,
        pipelineCaseId:assignmentTask.pipelineCaseId || null,
        projectId:assignmentProjectId,
        ...(activePlanRevision ? {
          m5Recovery:m5PlanRevisionExecutionContext(activePlanRevision),
        } : {}),
        ...(groundTruth ? { groundTruth } : {})
      }
    };
    Object.defineProperty(verified, ROLE_TOOL_GRANT, {
      value:roleToolGrant,
      enumerable:false,
    });
    Object.defineProperty(verified, OPEN_RESEARCH_EXECUTION_POLICY, {
      value:canonicalOpenResearchExecutionPolicy(identity.issue),
      enumerable:false,
    });
    return verified;
  },

  async compilePaperclipRoleToolGrant({ agent, identity, pipelineCase } = {}) {
    if (!agent?.toolExecutionPolicy) return null;
    const profile = typeof this.registry?.runtimeProfile === 'function'
      ? await this.registry.runtimeProfile(agent)
      : agent.runtimeProfile || null;
    if (!profile) {
      throw new ValidationError('当前岗位缺少可核验的 Hermes Profile，工具执行已拒绝。');
    }
    const projectId = String(
      identity?.issue?.projectId
      || pipelineCase?.case?.projectId
      || pipelineCase?.projectId
      || '',
    ).trim();
    const executionWorkspaceId = String(
      identity?.run?.environmentLease?.executionWorkspaceId
      || identity?.run?.executionWorkspaceId
      || '',
    ).trim();
    try {
      const grant = compileM5RoleToolGrant({
        manifest:agent,
        profile,
        paperclipAgentId:identity?.paperclipAgent?.id,
        projectId,
        executionWorkspaceId,
        availableAdapters:this.roleToolAdapters,
      });
      if (typeof this.governance?.getExecutionWorkspace !== 'function') {
        throw new M5RoleToolGrantError(
          'Paperclip execution workspace 读取适配器不可用。',
          'workspace_adapter_unavailable',
        );
      }
      const executionWorkspace = await this.governance.getExecutionWorkspace(executionWorkspaceId);
      const workspaceRoot = String(executionWorkspace?.cwd || '').trim();
      if (!path.isAbsolute(workspaceRoot)) {
        throw new M5RoleToolGrantError(
          'Paperclip execution workspace 缺少可信绝对路径。',
          'workspace_scope_invalid',
        );
      }
      return Object.freeze({ grant, workspaceRoot });
    } catch (error) {
      if (error instanceof M5RoleToolGrantError) {
        throw new ValidationError(`岗位工具授权失败：${error.message}`);
      }
      throw error;
    }
  },

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

  async completePaperclipAssignment(input = {}) {
    const { task, assignment } = await this.getPaperclipAssignment(input);
    if (isTerminalTask(task)) {
      if (task.status === 'succeeded') {
        const sync = await this.syncM5StageWorkProducts({
          task,
          assignment,
          apiKey:input.paperclipApiKey,
        });
        if (sync.synced) {
          await this.governance.completePaperclipIssue(assignment.issueId, {
            runId:assignment.runId,
            agentId:input.paperclipAgentId,
            apiKey:input.paperclipApiKey,
            result:task,
          });
        }
      }
      return { task, assignment, duplicate:true };
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
    let updated = await this.store.updateTask(task.taskId, {
      status:requestedStatus,
      currentStage:requestedStatus === 'succeeded' ? 'paperclip_hermes_completed' : requestedStatus === 'waiting_test' ? 'paperclip_hermes_waiting_test' : 'paperclip_hermes_failed',
      artifactRefs:[
        ...(task.artifactRefs || []),
        artifact
      ],
      execution:{
        ...(task.execution || {}),
        owner:'paperclip-hermes',
        finishedAt:completedAt,
        outcome:requestedStatus,
        ...(m5PlanRevisionReceipt ? {
          m5PlanRevisionReceipt,
        } : {}),
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
    if (requestedStatus === 'succeeded') {
      await this.syncM5StageWorkProducts({
        task:updated,
        assignment,
        apiKey:input.paperclipApiKey,
      });
    }
    await this.governance.completePaperclipIssue(assignment.issueId, {
      runId:assignment.runId,
      agentId:input.paperclipAgentId,
      apiKey:input.paperclipApiKey,
      result:updated
    });
    updated = await this.store.updateTask(updated.taskId, {
      governance:{ ...(updated.governance || {}), status:'synced', syncedAt:new Date().toISOString() }
    });
    return { task:updated, assignment, duplicate:false };
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

  async executeAgentProposalAssignment(input = {}) {
    const { task, assignment } = await this.getPaperclipAssignment(input);
    if (assignment.agentId !== 'creator' || task.taskType !== 'governance.agent-proposal') {
      throw new ValidationError('当前指派不是创建官岗位草案任务。');
    }
    const existing = (task.artifactRefs || []).find((item) =>
      item.type === 'agent_proposal'
      && item.validation?.exists === true
      && item.validation?.readable === true
    );
    if (existing) {
      return {
        assignment,
        result:{
          status:'succeeded',
          verified:true,
          recommendedCompletionStatus:'succeeded',
          proposal:existing.data
        },
        task:{ taskId:task.taskId, status:task.status, currentStage:task.currentStage },
        duplicate:true
      };
    }
    const executor = this.executors.creator;
    if (!executor?.execute) throw new ValidationError('创建官草案执行器不可用。');
    const result = await executor.execute(task, {
      proposalInput:{
        requestedOutcome:String(input.requestedOutcome || assignment.title || '').trim(),
        candidateName:String(input.candidateName || '').trim(),
        agentId:String(input.agentId || '').trim(),
        department:String(input.department || '').trim(),
        responsibilities:input.responsibilities,
        nonResponsibilities:input.nonResponsibilities,
        acceptedTaskTypes:input.acceptedTaskTypes,
        desiredSkills:input.desiredSkills,
        requestedCapabilities:input.requestedCapabilities,
        acceptanceTitle:String(input.acceptanceTitle || '').trim()
      }
    });
    const artifact = (result.artifactRefs || []).find((item) =>
      item.type === 'agent_proposal'
      && item.validation?.exists === true
      && item.validation?.readable === true
    );
    if (!artifact) throw new ValidationError('创建官没有生成可读取的岗位草案。');
    const proposalStage = artifact.data?.reviewSubmission?.status === 'pending' || artifact.data?.status === 'draft'
      ? 'agent_proposal_drafted'
      : 'agent_proposal_submitted';
    const updated = await this.store.updateTask(task.taskId, {
      status:'running',
      currentStage:proposalStage,
      artifactRefs:[...(task.artifactRefs || []), artifact],
      execution:{
        ...(task.execution || {}),
        agentProposal:{
          executor:'creator',
          proposalId:artifact.data?.proposalId || null,
          status:artifact.data?.status || null,
          recordedAt:new Date().toISOString()
        }
      }
    });
    return {
      assignment,
      result:{
        status:'succeeded',
        verified:true,
        recommendedCompletionStatus:'succeeded',
        proposal:artifact.data
      },
      task:{ taskId:updated.taskId, status:updated.status, currentStage:updated.currentStage },
      duplicate:false
    };
  },

  async executeTechnicalRepairAssignment(input = {}) {
    const { task, assignment } = await this.getPaperclipAssignment(input);
    if (assignment.agentId !== 'technical-expert' || task.taskType !== 'operations.technical-repair') {
      throw new ValidationError('当前指派不是技术专家受控修复任务。');
    }
    const existing = (task.artifactRefs || []).find((item) => item.type === 'technical_repair_case');
    if (existing) {
      return {
        assignment,
        result:existing.data,
        currentStage:task.currentStage,
        duplicate:true
      };
    }
    const executor = this.executors['technical-expert'];
    if (!executor?.execute) throw new ValidationError('技术专家隔离修复执行器不可用。');
    const result = await executor.execute(task);
    const verified = result.execution?.outcome === 'promoted'
      && result.execution?.verification?.testsPassed === true
      && result.execution?.verification?.recoveryVerified === true;
    const updated = await this.store.updateTask(task.taskId, {
      status:'running',
      currentStage:result.currentStage || 'technical_repair_executed',
      artifactRefs:[...(task.artifactRefs || []), ...(result.artifactRefs || [])],
      execution:{
        ...(task.execution || {}),
        technicalRepair:result.execution || null
      }
    });
    return {
      assignment,
      result:{
        status:result.status,
        currentStage:result.currentStage,
        execution:result.execution,
        verified,
        recommendedCompletionStatus:verified ? 'succeeded' : 'waiting_test',
        artifacts:(result.artifactRefs || []).map((item) => ({
          type:item.type,
          validation:item.validation,
          data:item.data
        }))
      },
      task:{ taskId:updated.taskId, status:updated.status, currentStage:updated.currentStage },
      duplicate:false
    };
  },

  async executeOperationsHealthAssignment(input = {}) {
    const { task, assignment } = await this.getPaperclipAssignment(input);
    if (assignment.agentId !== 'operator' || task.taskType !== 'operations.health-review') {
      throw new ValidationError('当前指派不是运维官确定性健康检查任务。');
    }
    const existing = (task.artifactRefs || []).find((item) =>
      item.type === 'health_report'
      && item.validation?.exists === true
      && item.validation?.readable === true
      && item.validation?.nonEmpty === true
    );
    if (existing) {
      return {
        assignment,
        result:{
          status:'succeeded',
          currentStage:task.currentStage,
          verified:true,
          healthStatus:existing.data?.overall || 'unknown',
          recommendedCompletionStatus:'succeeded',
          artifacts:[artifactExecutionView(existing)]
        },
        task:{ taskId:task.taskId, status:task.status, currentStage:task.currentStage },
        duplicate:true
      };
    }
    const executor = this.executors.operator;
    if (!executor?.execute) throw new ValidationError('运维官确定性健康检查执行器不可用。');
    const result = await executor.execute(task);
    const artifacts = (result.artifactRefs || []).filter((item) => item.type === 'health_report');
    const verified = artifacts.some((item) =>
      item.validation?.exists === true
      && item.validation?.readable === true
      && item.validation?.nonEmpty === true
    );
    if (!verified) throw new ValidationError('运维官没有生成可核验的健康报告。');
    const updated = await this.store.updateTask(task.taskId, {
      status:'running',
      currentStage:result.currentStage || 'health_report_ready',
      artifactRefs:[...(task.artifactRefs || []), ...artifacts],
      execution:{
        ...(task.execution || {}),
        operationsHealth:result.execution || null
      },
      usage:result.usage || task.usage
    });
    return {
      assignment,
      result:{
        status:result.status || 'succeeded',
        currentStage:updated.currentStage,
        verified:true,
        healthStatus:artifacts[0]?.data?.overall || 'unknown',
        recommendedCompletionStatus:'succeeded',
        artifacts:artifacts.map(artifactExecutionView)
      },
      task:{ taskId:updated.taskId, status:updated.status, currentStage:updated.currentStage },
      duplicate:false
    };
  },

  async executeEmployeeAssignment(input = {}) {
    const verified = await this.getPaperclipAssignment(input);
    const { task, assignment } = verified;
    const roleToolGrant = verified[ROLE_TOOL_GRANT] || null;
    const openResearchExecutionPolicy = verified[OPEN_RESEARCH_EXECUTION_POLICY] || null;
    const agent = await this.registry.get(assignment.agentId);
    try {
      assertPaperclipEmployeeExecutorAssignment({ agent, task });
    } catch (error) {
      throw new ValidationError(error?.message || '当前员工指派不允许执行。');
    }
    const hasM5Recovery = Boolean(task.input?.context?.m5Recovery);
    const observationDrivenResearch = task.taskType === 'research.open-investigation';
    const observationDrivenResearchActive = observationDrivenResearch
      && task.execution?.paperclipEmployee?.state !== 'settled';
    const stored = hasM5Recovery || observationDrivenResearchActive
      ? null
      : storedPaperclipEmployeeResult(task);
    if (stored) return { assignment, result:stored, task:taskExecutionView(task), duplicate:true };

    let run = this.employeeAssignmentRuns.get(task.taskId);
    const joined = Boolean(run);
    if (!run) {
      const executor = this.capabilityCatalog.executor(assignment.agentId, this.executors);
      if (!observationDrivenResearch && !executor?.execute) {
        throw new ValidationError('当前岗位的受控本机执行器不可用。');
      }
      const promise = this.runEmployeeAssignment({
        task,
        assignment,
        agent,
        executor,
        roleToolGrant,
        openResearchExecutionPolicy,
      });
      run = { promise };
      this.employeeAssignmentRuns.set(task.taskId, run);
      void promise.finally(() => {
        if (this.employeeAssignmentRuns.get(task.taskId) === run) this.employeeAssignmentRuns.delete(task.taskId);
      }).catch(() => {});
    }
    const completed = await run.promise;
    return joined ? { ...completed, duplicate:true } : completed;
  },

  async runEmployeeAssignment({
    task,
    assignment,
    agent,
    executor,
    roleToolGrant = null,
    openResearchExecutionPolicy = null,
  }) {
    const executionStartedAt = new Date();
    const m5Contract = getM5RoutineExecutionContract(assignment?.routineKey);
    let result;
    let routeExecution = null;
    try {
      const roleToolContext = roleToolGrant
        ? createM5RoleToolExecutionContext(roleToolGrant.grant, {
            adapters:this.roleToolAdapters,
            workspaceRoot:roleToolGrant.workspaceRoot,
            trustedScope:roleToolGrant.trustedScope,
          })
        : null;
      const prepared = prepareM5ExecutorTask({
        task,
        assignment,
        contract:m5Contract,
      });
      routeExecution = prepared.routeExecution;
      if (prepared.recovery) {
        assertChangedM5RecoveryRoute(routeExecution, prepared.recovery);
      }
      const paperclipWorkProducts = task.taskType === 'research.open-investigation'
        ? await this.readOpenResearchWorkProducts(assignment)
        : null;
      result = task.taskType === 'research.open-investigation'
        ? await executeIntelResearchOpenTaskStep({
            task:prepared.task,
            agent,
            assignment,
            executionPolicy:openResearchExecutionPolicy,
            paperclipWorkProducts,
            roleToolContext,
            reportExecutor:executor,
            writeStepWorkProduct:async (product) => {
              if (typeof this.governance?.createIssueWorkProduct !== 'function') {
                throw new ValidationError(
                  '小R开放研究缺少 Paperclip Work Product 写回能力。',
                );
              }
              return this.governance.createIssueWorkProduct(
                assignment.issueId,
                product,
                { runId:assignment.runId },
              );
            },
            readWorkProducts:() => this.readOpenResearchWorkProducts(assignment),
          })
        : await executor.execute(
            prepared.task,
            roleToolContext
              ? { roleToolContext, m5Recovery:prepared.recovery }
              : prepared.recovery
                ? { m5Recovery:prepared.recovery }
                : undefined,
          );
      if (
        roleToolContext
        && roleToolContext.snapshot().length === 0
        && result?.openResearch?.reusedReport !== true
      ) {
        throw new M5RoleToolGrantError(
          '受控执行器没有经过岗位工具授权上下文。',
          'role_tool_not_enforced',
        );
      }
    } catch (error) {
      const occurredAt = new Date().toISOString();
      result = {
        status:m5Contract?.executionMode === 'hermes' ? 'failed' : 'waiting_test',
        currentStage:'paperclip_employee_execution_failed',
        artifactRefs:[],
        error:{
          code:String(error?.code || 'paperclip_employee_executor_failed').slice(0, 120),
          message:String(error?.message || '员工受控执行器失败。').slice(0, 500),
          userMessage:m5Contract?.executionMode === 'hermes'
            ? 'M5 阶段本次执行失败；请按 Paperclip 恢复策略回报 failed。'
            : '员工未完成当前指派，已保留真实失败原因。',
          category:m5Contract?.executionMode === 'hermes'
            ? 'retryable'
            : String(error?.category || 'manual').slice(0, 80),
          stage:'paperclip_employee_execution',
          retryable:m5Contract?.executionMode === 'hermes' || error?.retryable === true,
          occurredAt,
        },
      };
    }
    const artifacts = Array.isArray(result?.artifactRefs) ? result.artifactRefs : [];
    const verified = result?.status === 'succeeded' && artifacts.some(verifiedAssignmentArtifact);
    const recommendedCompletionStatus = result?.status === 'running'
      ? 'running'
      : verified
        ? 'succeeded'
        : result?.status === 'failed'
          ? 'failed'
          : 'waiting_test';
    const settled = recommendedCompletionStatus !== 'running';
    const latest = (await this.store.list()).find((item) => item.taskId === task.taskId) || task;
    const updated = await this.store.updateTask(task.taskId, {
      status:'running',
      currentStage:result?.currentStage || (settled ? 'paperclip_employee_executed' : 'paperclip_employee_running'),
      artifactRefs:[...(latest.artifactRefs || []), ...artifacts],
      execution:{
        ...(latest.execution || {}),
        ...(result?.execution || {}),
        owner:'paperclip-hermes',
        paperclipEmployee:{
          state:settled ? 'settled' : 'running',
          executor:assignment.agentId,
          status:String(result?.status || recommendedCompletionStatus),
          verified,
          recommendedCompletionStatus,
          startedAt:executionStartedAt.toISOString(),
          updatedAt:new Date().toISOString(),
        },
        ...(routeExecution ? { m5RouteExecution:routeExecution } : {}),
      },
      usage:recordTaskUsage({ task, result, startedAt:executionStartedAt }),
      ...(result?.error ? { error:result.error } : { error:undefined }),
    });
    if (!settled && typeof executor?.observe === 'function') executor.observe(updated);
    return {
      assignment,
      result:{
        status:String(result?.status || recommendedCompletionStatus),
        currentStage:updated.currentStage,
        verified,
        recommendedCompletionStatus,
        ...(recommendedCompletionStatus === 'running'
          ? {
              continuePolling:true,
              pollAfterSeconds:3,
              message:'当前岗位的本机工作仍在执行；请再次调用 employee_assignment_execute 获取真实状态。',
            }
          : {}),
        error:result?.error || null,
        artifacts:artifacts.map(artifactExecutionView),
        ...(result?.openResearch ? { openResearch:result.openResearch } : {}),
      },
      task:taskExecutionView(updated),
      duplicate:false,
    };
  },

  async readOpenResearchWorkProducts(assignment) {
    if (typeof this.governance?.getIssueWorkProducts !== 'function') {
      throw new ValidationError(
        '小R开放研究缺少 Paperclip Work Product 回读能力。',
      );
    }
    return this.governance.getIssueWorkProducts(
      assignment.issueId,
      { runId:assignment.runId },
    );
  },

  async executeContentGrowthAssignment(input = {}) {
    const { task, assignment } = await this.getPaperclipAssignment(input);
    const capability = this.capabilityCatalog.contentGrowthContract(task.taskType, assignment.agentId);
    if (!capability) throw new ValidationError('当前指派不是受控内容增长任务。');
    const expectedType = capability.artifactType;
    const hasM5Recovery = Boolean(task.input?.context?.m5Recovery);
    const existing = hasM5Recovery
      ? null
      : (task.artifactRefs || []).find((item) =>
          item.type === expectedType
          && item.validation?.exists === true
          && item.validation?.readable === true
        );
    if (existing) {
      const verified = contentGrowthArtifactVerified(task, existing);
      return {
        assignment,
        result:{
          status:verified ? 'succeeded' : 'waiting_test',
          currentStage:task.currentStage,
          verified,
          recommendedCompletionStatus:verified ? 'succeeded' : 'waiting_test',
          artifacts:[artifactExecutionView(existing)]
        },
        task:{ taskId:task.taskId, status:task.status, currentStage:task.currentStage },
        currentStage:task.currentStage,
        duplicate:true
      };
    }
    const settled = hasM5Recovery ? null : storedContentGrowthResult(task, expectedType);
    if (settled) {
      return {
        assignment,
        result:settled,
        task:{ taskId:task.taskId, status:task.status, currentStage:task.currentStage },
        duplicate:true
      };
    }
    const executor = this.capabilityCatalog.executor(assignment.agentId, this.executors);
    if (!executor?.execute) throw new ValidationError('内容增长受控执行器不可用。');
    let run = this.contentGrowthRuns.get(task.taskId);
    const joined = Boolean(run);
    if (!run) {
      const providerVision = task.taskType === 'content.campaign-visual-analysis'
        ? this.m5ProviderVisionCallback({
            assignment,
            paperclipApiKey:input.paperclipApiKey,
          })
        : null;
      const promise = this.runContentGrowthAssignment({
        task,
        assignment,
        expectedType,
        executor,
        providerVision,
      });
      run = { promise };
      this.contentGrowthRuns.set(task.taskId, run);
      void promise.finally(() => {
        if (this.contentGrowthRuns.get(task.taskId) === run) this.contentGrowthRuns.delete(task.taskId);
      }).catch(() => {});
    }
    const outcome = await settleWithin(run.promise, this.contentGrowthWaitMs);
    if (outcome.settled) return outcome.value;
    const latest = (await this.store.list()).find((item) => item.taskId === task.taskId) || task;
    return {
      assignment,
      result:{
        status:'running',
        currentStage:'content_growth_background_running',
        verified:false,
        recommendedCompletionStatus:'running',
        continuePolling:true,
        pollAfterSeconds:2,
        message:'同一项内容分析仍在 A君后台执行；请再次调用当前受控执行工具继续等待，不要回报任务完成。'
      },
      task:{ taskId:latest.taskId, status:latest.status, currentStage:latest.currentStage },
      duplicate:joined
    };
  },

  async runContentGrowthAssignment({
    task,
    assignment,
    expectedType,
    executor,
    providerVision = null,
  }) {
    const executionStartedAt = new Date();
    const m5Contract = getM5RoutineExecutionContract(assignment?.routineKey);
    const started = await this.store.updateTask(task.taskId, {
      status:'running',
      currentStage:'content_growth_background_running',
      execution:{
        ...(task.execution || {}),
        contentGrowth:{
          state:'running',
          executor:assignment.agentId,
          startedAt:executionStartedAt.toISOString()
        }
      },
      error:undefined
    });
    let result;
    let routeExecution = null;
    try {
      const prepared = prepareM5ExecutorTask({
        task:started,
        assignment,
        contract:m5Contract,
      });
      routeExecution = prepared.routeExecution;
      if (prepared.recovery) {
        assertChangedM5RecoveryRoute(routeExecution, prepared.recovery);
      }
      result = await executor.execute(
        prepared.task,
        {
          ...(prepared.recovery ? { m5Recovery:prepared.recovery } : {}),
          ...(providerVision ? { providerVision } : {}),
        },
      );
    } catch (error) {
      const completedAt = new Date().toISOString();
      result = {
        status:'waiting_test',
        currentStage:'content_growth_execution_failed',
        artifactRefs:[],
        execution:{
          executor:assignment.agentId,
          startedAt:executionStartedAt.toISOString(),
          finishedAt:completedAt,
          outcome:'failed'
        },
        error:{
          code:String(error?.code || 'content_growth_executor_failed').slice(0, 120),
          message:String(error?.message || '内容增长执行器失败。').slice(0, 500),
          userMessage:'内容分析未完成，已保留真实失败原因。',
          category:'manual',
          stage:'content_growth_execution',
          retryable:false,
          occurredAt:completedAt
        }
      };
    }
    const artifacts = Array.isArray(result.artifactRefs) ? result.artifactRefs : [];
    const verified = result.status === 'succeeded'
      && artifacts.some((item) => item.type === expectedType && contentGrowthArtifactVerified(task, item));
    const recommendedCompletionStatus = verified
      ? 'succeeded'
      : result.status === 'needs_input'
        ? 'failed'
        : 'waiting_test';
    const latest = (await this.store.list()).find((item) => item.taskId === task.taskId) || task;
    const preserveTerminal = isTerminalTask(latest);
    const updated = await this.store.updateTask(task.taskId, {
      status:preserveTerminal ? latest.status : 'running',
      currentStage:result.currentStage || 'content_growth_executed',
      artifactRefs:[...(latest.artifactRefs || []), ...artifacts],
      execution:{
        ...(latest.execution || {}),
        contentGrowth:{
          ...(result.execution || {}),
          state:'settled',
          status:result.status,
          verified,
          recommendedCompletionStatus,
          settledAt:new Date().toISOString()
        },
        ...(routeExecution ? { m5RouteExecution:routeExecution } : {}),
      },
      usage:recordTaskUsage({ task, result, startedAt:executionStartedAt }),
      ...(result.error ? { error:result.error } : preserveTerminal ? { error:latest.error } : {})
    });
    return {
      assignment,
      result:{
        status:result.status,
        currentStage:result.currentStage,
        verified,
        recommendedCompletionStatus,
        error:result.error || null,
        artifacts:artifacts.map(artifactExecutionView)
      },
      task:{ taskId:updated.taskId, status:updated.status, currentStage:updated.currentStage },
      duplicate:false
    };
  },

  m5ProviderVisionCallback({ assignment, paperclipApiKey }) {
    if (
      typeof this.m5ProviderVision !== 'function'
      || !assignment?.pipelineCaseId
      || !String(paperclipApiKey || '').trim()
    ) return null;
    const caseId = String(assignment.pipelineCaseId);
    const apiKey = String(paperclipApiKey);
    let used = false;
    return (parameters) => {
      if (used) {
        throw new ValidationError('当前 heartbeat 的 M5 视觉 Provider callback 已使用，禁止第二次付费调用。');
      }
      used = true;
      const keys = parameters && typeof parameters === 'object' && !Array.isArray(parameters)
        ? Object.keys(parameters).sort()
        : [];
      if (keys.join(',') !== 'actionId,prompt,relativePath') {
        throw new ValidationError('M5 视觉 Provider callback 只接受 actionId、relativePath、prompt。');
      }
      const actionId = String(parameters.actionId || '');
      const relativePath = String(parameters.relativePath || '').replaceAll('\\', '/');
      const prompt = parameters.prompt;
      const actionPrefix = `${caseId}:vision:`;
      if (
        !actionId.startsWith(actionPrefix)
        || !/^[0-9a-f]{16}$/i.test(actionId.slice(actionPrefix.length))
        || !safeM5VisionRelativePath(relativePath)
        || typeof prompt !== 'string'
        || !prompt.trim()
        || prompt.length > 1_000
      ) {
        throw new ValidationError('M5 视觉 Provider callback 参数不在当前 Case 的受控范围内。');
      }
      return this.m5ProviderVision({
        caseId,
        parameters:{ actionId, relativePath, prompt },
        authentication:{
          requireRunAuthentication:true,
          paperclipApiKey:apiKey,
        },
      });
    };
  }
};

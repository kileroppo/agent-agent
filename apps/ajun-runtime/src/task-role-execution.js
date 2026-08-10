import { recordTaskUsage } from './task-usage.js';
import { buildExecutionAudit } from './workflow/execution-audit.ts';
import { executeIntelResearchOpenTaskStep } from './open-task-routing.ts';
import { assertPaperclipEmployeeExecutorAssignment } from './paperclip-employee-assignment.js';
import { getM5RoutineExecutionContract } from '@agent-army/m5-kernel/routine-execution-contract';
import { assertChangedM5RecoveryRoute } from '@agent-army/m5-kernel/route-execution';
import {
  createM5RoleToolExecutionContext,
  M5RoleToolGrantError,
} from './m5-role-tool-grant.js';
import {
  ValidationError,
  isTerminalTask,
  safeM5VisionRelativePath,
  taskExecutionView,
  prepareM5ExecutorTask,
  verifiedAssignmentArtifact,
  storedPaperclipEmployeeResult,
  artifactExecutionView,
  contentGrowthArtifactVerified,
  storedContentGrowthResult,
  settleWithin,
} from './task-service-execution-support.js';

export const ROLE_TOOL_GRANT = Symbol('m5RoleToolGrant');
export const OPEN_RESEARCH_EXECUTION_POLICY = Symbol('openResearchExecutionPolicy');

export const taskRoleExecutionMethods = {
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
        && !(
          result?.openResearch
          && !String(result.openResearch.decision?.selectedToolId || '').trim()
        )
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
          artifacts:[artifactExecutionView(existing)],
          audit:buildExecutionAudit({ usage:task.usage, artifacts:[existing] }),
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
    const usage = recordTaskUsage({ task, result, startedAt:executionStartedAt });
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
      usage,
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
        artifacts:artifacts.map(artifactExecutionView),
        audit:buildExecutionAudit({ usage, artifacts }),
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

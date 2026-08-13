import path from 'node:path';
import { usesPaperclipHermesExecution } from './governance-hermes-runtime.js';
import { resolvePaperclipAssignmentTaskType } from './paperclip-employee-assignment.js';
import {
  getM5RoutineExecutionContract,
  INTEL_RESEARCH_OPEN_TASK_EXECUTION_CONTRACT,
} from '@agent-army/m5-kernel/routine-execution-contract';
import { getActiveM5PlanRevision } from './m5-stage-recovery-controller.js';
import {
  compileM5RoleToolGrant,
  M5RoleToolGrantError,
} from './m5-role-tool-grant.js';
import {
  OPEN_RESEARCH_EXECUTION_POLICY,
  ROLE_TOOL_GRANT,
} from './task-role-execution.js';
import {
  ValidationError,
  isTerminalTask,
  canonicalOpenResearchExecutionPolicy,
} from './task-service-execution-support.js';
import { preparePaperclipAssignmentContext } from './paperclip-assignment-context.js';
import { buildTaskContextCapsule } from './task-context-capsule.js';

export const taskPaperclipAssignmentMethods = {
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
      requireProjectId:Boolean(m5Contract),
      requireExecutionWorkspaceId:Boolean(m5Contract) || rolePolicyWritesWorkspace(agent),
    });
    const assignmentContext = await preparePaperclipAssignmentContext({
      governance:this.governance,
      tasks:storedTasks,
      assignmentTask,
      pipelineCase,
      activePlanRevision,
    });
    if (!task) {
      const acceptedTaskType = assignmentTask.taskType;
      if (!acceptedTaskType) throw new ValidationError('当前岗位没有可映射的任务类型。');
      task = await this.store.createTask({
        taskType:acceptedTaskType,
        idempotencyKey:`paperclip:${identity.issue.id}`,
        requester:{ kind:'paperclip', ref:identity.issue.id },
        source:{ channel:'paperclip', paperclipIssueId:identity.issue.id, paperclipRunId:identity.run.id },
        assigneeAgentId:agent.agentId,
        parentTaskId:null,
        input:assignmentContext.createTaskInput({ identity, assignmentProjectId }),
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
        input:assignmentContext.refreshTaskInput(task.input, { assignmentProjectId }),
      });
    }
    const groundTruth = agent.agentId === 'architect' ? await this.architectureGroundTruth() : null;
    const roleToolGrant = assignmentContext.scopeRoleToolGrant(baseRoleToolGrant, { task, identity });
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
        contextCapsule:buildTaskContextCapsule(task),
        ...assignmentContext.assignmentRecoveryFields(),
        ...(groundTruth ? { groundTruth } : {})
      }
    };
    Object.defineProperty(verified, ROLE_TOOL_GRANT, {
      value:roleToolGrant,
      enumerable:false,
    });
    Object.defineProperty(verified, OPEN_RESEARCH_EXECUTION_POLICY, {
      value:canonicalOpenResearchExecutionPolicy(identity.issue)
        || contractedOpenResearchExecutionPolicy(task),
      enumerable:false,
    });
    return verified;
  },

  async compilePaperclipRoleToolGrant({
    agent,
    identity,
    pipelineCase,
    requireProjectId = true,
    requireExecutionWorkspaceId = true,
  } = {}) {
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
        requireProjectId,
        requireExecutionWorkspaceId,
        availableAdapters:this.roleToolAdapters,
      });
      if (!executionWorkspaceId) {
        return Object.freeze({ grant, workspaceRoot:null });
      }
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
};

function contractedOpenResearchExecutionPolicy(task) {
  if (
    task?.taskType !== INTEL_RESEARCH_OPEN_TASK_EXECUTION_CONTRACT.taskType
    || task?.input?.context?.openTaskType !== INTEL_RESEARCH_OPEN_TASK_EXECUTION_CONTRACT.taskType
  ) return null;
  return Object.freeze({
    remainingUnits:INTEL_RESEARCH_OPEN_TASK_EXECUTION_CONTRACT.maxSteps,
    estimatedNextStepUnits:1,
  });
}

function rolePolicyWritesWorkspace(agent) {
  return Object.values(agent?.toolExecutionPolicy?.grants || {})
    .some((declaration) => declaration?.access === 'write');
}

import path from 'node:path';
import { usesPaperclipHermesExecution } from './governance-hermes-runtime.ts';
import { resolvePaperclipAssignmentTaskType } from './paperclip-employee-assignment.ts';
import { getM5RoutineExecutionContract, INTEL_RESEARCH_OPEN_TASK_EXECUTION_CONTRACT, } from '@agent-army/m5-kernel/routine-execution-contract';
import { getActiveM5PlanRevision } from './m5-stage-recovery-controller.ts';
import { compileM5RoleToolGrant, M5RoleToolGrantError, } from './m5-role-tool-grant.ts';
import { OPEN_RESEARCH_EXECUTION_POLICY, ROLE_TOOL_GRANT, } from './task-role-execution.ts';
import { ValidationError, isTerminalTask, canonicalOpenResearchExecutionPolicy, } from './task-service-execution-support.ts';
import { preparePaperclipAssignmentContext } from './paperclip-assignment-context.ts';
import { buildTaskContextCapsule } from './task-context-capsule.ts';
export const taskPaperclipAssignmentMethods: Record<string, any> = {
    async getPaperclipAssignment(input: any = {}): Promise<any> {
        if (!this.governance?.verifyHermesAssignment)
            throw new ValidationError('Paperclip 任务校验能力不可用。');
        const identity: any = await this.governance.verifyHermesAssignment(input);
        const agent: any = await this.registry.get(identity.agentArmyId);
        if (!usesPaperclipHermesExecution(agent))
            throw new ValidationError('当前岗位未启用 Paperclip Hermes 执行。');
        let assignmentTask: any;
        try {
            assignmentTask = resolvePaperclipAssignmentTaskType({ agent, issue: identity.issue });
        }
        catch (error: any) {
            throw new ValidationError(error?.message || '当前 Paperclip 指派任务类型无法安全映射。');
        }
        const storedTasks: any = await this.store.list();
        let task: any = storedTasks.find((item: any): any => item.governance?.paperclipIssueId === identity.issue.id);
        const storedPaperclipRunId: any = paperclipRunId(task);
        const currentPaperclipRunId: any = String(identity.run.id || '').trim();
        const newPaperclipRun: any = Boolean(task
            && storedPaperclipRunId
            && currentPaperclipRunId
            && storedPaperclipRunId !== currentPaperclipRunId);
        const retryingTerminalTask: any = Boolean(task && isTerminalTask(task) && newPaperclipRun);
        if (task && assignmentTask.routineKey && task.taskType !== assignmentTask.taskType && !retryingTerminalTask) {
            throw new ValidationError(`当前任务信封类型与 M5 Routine ${assignmentTask.routineKey} 不一致。`);
        }
        const pipelineCase: any = assignmentTask.pipelineCaseId && typeof this.governance.getPipelineCase === 'function'
            ? await this.governance.getPipelineCase(assignmentTask.pipelineCaseId)
            : null;
        if (assignmentTask.pipelineCaseId) {
            if (typeof this.governance?.assertCaseIssueLink !== 'function') {
                throw new ValidationError('M5 Pipeline Case 缺少 Issue 绑定核验能力。');
            }
            await this.governance.assertCaseIssueLink(assignmentTask.pipelineCaseId, identity.issue.id);
        }
        const assignmentProjectId: any = String(identity?.issue?.projectId
            || pipelineCase?.case?.projectId
            || pipelineCase?.projectId
            || '').trim() || null;
        const m5Contract: any = getM5RoutineExecutionContract(assignmentTask.routineKey);
        const activePlanRevision: any = m5Contract?.executionMode === 'hermes'
            ? await getActiveM5PlanRevision({
                governance: this.governance,
                pipelineCaseId: assignmentTask.pipelineCaseId,
                stageKey: m5Contract.stageKey,
                pipelineCase,
            })
            : null;
        const baseRoleToolGrant: any = await this.compilePaperclipRoleToolGrant({
            agent,
            identity,
            pipelineCase,
            requireProjectId: Boolean(m5Contract),
            requireExecutionWorkspaceId: Boolean(m5Contract) || rolePolicyWritesWorkspace(agent),
        });
        const assignmentContext: any = await preparePaperclipAssignmentContext({
            governance: this.governance,
            tasks: storedTasks,
            assignmentTask,
            pipelineCase,
            activePlanRevision,
        });
        if (!task) {
            const acceptedTaskType: any = assignmentTask.taskType;
            if (!acceptedTaskType)
                throw new ValidationError('当前岗位没有可映射的任务类型。');
            task = await this.store.createTask({
                taskType: acceptedTaskType,
                idempotencyKey: `paperclip:${identity.issue.id}`,
                requester: { kind: 'paperclip', ref: identity.issue.id },
                source: { channel: 'paperclip', paperclipIssueId: identity.issue.id, paperclipRunId: identity.run.id },
                assigneeAgentId: agent.agentId,
                parentTaskId: null,
                input: assignmentContext.createTaskInput({ identity, assignmentProjectId }),
                status: 'running',
                currentStage: 'paperclip_hermes_running',
                routing: { requestedAgentId: agent.agentId, candidateAgentIds: [agent.agentId], reason: 'Paperclip 已把任务指派给该员工的 Hermes Profile。' },
                governance: {
                    status: 'synced',
                    paperclipIssueId: identity.issue.id,
                    paperclipIssueIdentifier: identity.issue.identifier || null,
                    paperclipAssigneeAgentId: identity.paperclipAgent.id,
                    paperclipAssigneeName: identity.paperclipAgent.name,
                    syncedAt: new Date().toISOString()
                },
                execution: {
                    owner: 'paperclip-hermes',
                    hermesProfileId: agent.agentId,
                    paperclipRunId: identity.run.id,
                    paperclipAgentId: identity.paperclipAgent.id,
                    startedAt: new Date().toISOString()
                }
            });
        }
        else if (retryingTerminalTask) {
            const previousTask: any = task;
            const nextAttempt: any = Number.isSafeInteger(task.attempt) ? task.attempt + 1 : 2;
            const { completionSync: _completionSync, ...retainedGovernance } = task.governance || {};
            const {
                finishedAt: _finishedAt,
                outcome: _outcome,
                paperclipEmployee: _paperclipEmployee,
                ...retainedExecution
            } = task.execution || {};
            task = await this.store.updateTask(task.taskId, {
                status: 'queued',
                currentStage: 'paperclip_hermes_retry_queued',
                attempt: nextAttempt,
                taskType: assignmentTask.taskType,
                assigneeAgentId: agent.agentId,
                source: {
                    ...(task.source || {}),
                    channel: 'paperclip',
                    paperclipIssueId: identity.issue.id,
                    paperclipRunId: identity.run.id,
                },
                routing: {
                    requestedAgentId: agent.agentId,
                    candidateAgentIds: [agent.agentId],
                    reason: 'Paperclip 已为新的 Run 重新指派该任务。',
                },
                governance: {
                    ...retainedGovernance,
                    status: 'synced',
                    paperclipIssueId: identity.issue.id,
                    paperclipIssueIdentifier: identity.issue.identifier || null,
                    paperclipAssigneeAgentId: identity.paperclipAgent.id,
                    paperclipAssigneeName: identity.paperclipAgent.name,
                    syncedAt: new Date().toISOString(),
                },
                execution: {
                    ...retainedExecution,
                    owner: 'paperclip-hermes',
                    hermesProfileId: agent.agentId,
                    paperclipRunId: identity.run.id,
                    paperclipAgentId: identity.paperclipAgent.id,
                    startedAt: new Date().toISOString(),
                },
                input: assignmentContext.refreshTaskInput(task.input, { assignmentProjectId }),
                recovery: {
                    ...(task.recovery || {}),
                    attempt: nextAttempt,
                    reason: 'paperclip_new_run',
                    previousStatus: task.status,
                    previousPaperclipRunId: paperclipRunId(task),
                },
                error: undefined,
            });
            this.taskLifecycleEvents?.recordPersisted(task, { previousTask });
            const queuedTask: any = task;
            task = await this.store.updateTask(task.taskId, {
                status: 'running',
                currentStage: 'paperclip_hermes_running',
            });
            this.taskLifecycleEvents?.recordPersisted(task, { previousTask: queuedTask });
        }
        else if (!isTerminalTask(task)) {
            task = await this.store.updateTask(task.taskId, {
                status: 'running',
                currentStage: task.execution?.paperclipEmployee
                    ? task.currentStage
                    : 'paperclip_hermes_running',
                taskType: assignmentTask.taskType,
                assigneeAgentId: agent.agentId,
                source: {
                    ...(task.source || {}),
                    channel: 'paperclip',
                    paperclipIssueId: identity.issue.id,
                    paperclipRunId: identity.run.id,
                },
                routing: {
                    requestedAgentId: agent.agentId,
                    candidateAgentIds: [agent.agentId],
                    reason: 'Paperclip 已把任务指派给该员工的 Hermes Profile。',
                },
                governance: {
                    ...(task.governance || {}),
                    status: 'synced',
                    paperclipAssigneeAgentId: identity.paperclipAgent.id,
                    paperclipAssigneeName: identity.paperclipAgent.name,
                    syncedAt: new Date().toISOString(),
                },
                execution: {
                    ...(task.execution || {}),
                    owner: 'paperclip-hermes',
                    hermesProfileId: agent.agentId,
                    paperclipRunId: identity.run.id,
                    paperclipAgentId: identity.paperclipAgent.id,
                    startedAt: task.execution?.startedAt || new Date().toISOString()
                },
                input: assignmentContext.refreshTaskInput(task.input, { assignmentProjectId }),
            });
        }
        const groundTruth: any = agent.agentId === 'architect' ? await this.architectureGroundTruth() : null;
        const roleToolGrant: any = assignmentContext.scopeRoleToolGrant(baseRoleToolGrant, { task, identity });
        const verified: Record<string, any> = {
            task,
            assignment: {
                issueId: identity.issue.id,
                identifier: identity.issue.identifier || null,
                title: identity.issue.title,
                description: identity.issue.description || '',
                agentId: agent.agentId,
                runId: identity.run.id,
                routineKey: assignmentTask.routineKey || null,
                pipelineCaseId: assignmentTask.pipelineCaseId || null,
                projectId: assignmentProjectId,
                contextCapsule: buildTaskContextCapsule(task),
                ...assignmentContext.assignmentRecoveryFields(),
                ...(groundTruth ? { groundTruth } : {})
            }
        };
        Object.defineProperty(verified, ROLE_TOOL_GRANT, {
            value: roleToolGrant,
            enumerable: false,
        });
        Object.defineProperty(verified, OPEN_RESEARCH_EXECUTION_POLICY, {
            value: canonicalOpenResearchExecutionPolicy(identity.issue)
                || contractedOpenResearchExecutionPolicy(task),
            enumerable: false,
        });
        return verified;
    },
    async compilePaperclipRoleToolGrant({ agent, identity, pipelineCase, requireProjectId = true, requireExecutionWorkspaceId = true, }: any = {}): Promise<any> {
        if (!agent?.toolExecutionPolicy)
            return null;
        const profile: any = typeof this.registry?.runtimeProfile === 'function'
            ? await this.registry.runtimeProfile(agent)
            : agent.runtimeProfile || null;
        if (!profile) {
            throw new ValidationError('当前岗位缺少可核验的 Hermes Profile，工具执行已拒绝。');
        }
        const projectId: any = String(identity?.issue?.projectId
            || pipelineCase?.case?.projectId
            || pipelineCase?.projectId
            || '').trim();
        const executionWorkspaceId: any = String(identity?.run?.environmentLease?.executionWorkspaceId
            || identity?.run?.executionWorkspaceId
            || '').trim();
        try {
            const grant: any = compileM5RoleToolGrant({
                manifest: agent,
                profile,
                paperclipAgentId: identity?.paperclipAgent?.id,
                projectId,
                executionWorkspaceId,
                requireProjectId,
                requireExecutionWorkspaceId,
                availableAdapters: this.roleToolAdapters,
            });
            if (!executionWorkspaceId) {
                return Object.freeze({ grant, workspaceRoot: null });
            }
            if (typeof this.governance?.getExecutionWorkspace !== 'function') {
                throw new M5RoleToolGrantError('Paperclip execution workspace 读取适配器不可用。', 'workspace_adapter_unavailable');
            }
            const executionWorkspace: any = await this.governance.getExecutionWorkspace(executionWorkspaceId);
            const workspaceRoot: any = String(executionWorkspace?.cwd || '').trim();
            if (!path.isAbsolute(workspaceRoot)) {
                throw new M5RoleToolGrantError('Paperclip execution workspace 缺少可信绝对路径。', 'workspace_scope_invalid');
            }
            return Object.freeze({ grant, workspaceRoot });
        }
        catch (error: any) {
            if (error instanceof M5RoleToolGrantError) {
                throw new ValidationError(`岗位工具授权失败：${error.message}`);
            }
            throw error;
        }
    },
};
function contractedOpenResearchExecutionPolicy(task: any): any {
    if (task?.taskType !== INTEL_RESEARCH_OPEN_TASK_EXECUTION_CONTRACT.taskType
        || task?.input?.context?.openTaskType !== INTEL_RESEARCH_OPEN_TASK_EXECUTION_CONTRACT.taskType)
        return null;
    return Object.freeze({
        remainingUnits: INTEL_RESEARCH_OPEN_TASK_EXECUTION_CONTRACT.maxSteps,
        estimatedNextStepUnits: 1,
    });
}
function rolePolicyWritesWorkspace(agent: any): any {
    return Object.values(agent?.toolExecutionPolicy?.grants || {})
        .some((declaration: any): any => declaration?.access === 'write');
}
function paperclipRunId(task: any): any {
    return String(task?.execution?.paperclipRunId
        || task?.source?.paperclipRunId
        || task?.governance?.completionSync?.paperclipRunId
        || '').trim();
}

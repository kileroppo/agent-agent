import { recordTaskUsage } from './task-usage.ts';
import { buildExecutionAudit } from './workflow/execution-audit.ts';
import { executeIntelResearchOpenTaskStep } from './open-task-routing.ts';
import { assertPaperclipEmployeeExecutorAssignment } from './paperclip-employee-assignment.ts';
import { getM5RoutineExecutionContract } from '@agent-army/m5-kernel/routine-execution-contract';
import { assertChangedM5RecoveryRoute } from '@agent-army/m5-kernel/route-execution';
import { createM5RoleToolExecutionContext, M5RoleToolGrantError, } from './m5-role-tool-grant.ts';
import { ValidationError, isTerminalTask, safeM5VisionRelativePath, taskExecutionView, verifiedAssignmentArtifact, storedPaperclipEmployeeResult, artifactExecutionView, contentGrowthArtifactVerified, storedContentGrowthResult, settleWithin, } from './task-service-execution-support.ts';
import { prepareM5ExecutorTask } from './task-service-m5-execution-context-support.ts';
export const ROLE_TOOL_GRANT: any = Symbol('m5RoleToolGrant');
export const OPEN_RESEARCH_EXECUTION_POLICY: any = Symbol('openResearchExecutionPolicy');
export const taskRoleExecutionMethods: Record<string, any> = {
    async executeAgentProposalAssignment(input: any = {}): Promise<any> {
        const { task, assignment } = await this.getPaperclipAssignment(input);
        if (assignment.agentId !== 'creator' || task.taskType !== 'governance.agent-proposal') {
            throw new ValidationError('当前指派不是创建官岗位草案任务。');
        }
        if (this.maturityExecutionGuard)
            await this.maturityExecutionGuard.verifyOrBlock(task);
        const existing: any = (task.artifactRefs || []).find((item: any): any => item.type === 'agent_proposal'
            && item.validation?.exists === true
            && item.validation?.readable === true);
        if (existing) {
            return {
                assignment,
                result: {
                    status: 'succeeded',
                    verified: true,
                    recommendedCompletionStatus: 'succeeded',
                    proposal: existing.data
                },
                task: { taskId: task.taskId, status: task.status, currentStage: task.currentStage },
                duplicate: true
            };
        }
        const executor: any = this.executors.creator;
        if (!executor?.execute)
            throw new ValidationError('创建官草案执行器不可用。');
        const executionStartedAt: any = new Date();
        const proposalInput: Record<string, any> = {
            requestedOutcome: String(input.requestedOutcome || assignment.title || '').trim(),
            candidateName: String(input.candidateName || '').trim(),
            agentId: String(input.agentId || '').trim(),
            department: String(input.department || '').trim(),
            responsibilities: input.responsibilities,
            nonResponsibilities: input.nonResponsibilities,
            acceptedTaskTypes: input.acceptedTaskTypes,
            desiredSkills: input.desiredSkills,
            requestedCapabilities: input.requestedCapabilities,
            acceptanceTitle: String(input.acceptanceTitle || '').trim()
        };
        const result: any = this.maturityExecutionGuard
            ? await this.maturityExecutionGuard.execute(task, executor, { proposalInput })
            : await executor.execute(task, {
                proposalInput: {
                    ...proposalInput,
                }
            });
        const artifact: any = (result.artifactRefs || []).find((item: any): any => item.type === 'agent_proposal'
            && item.validation?.exists === true
            && item.validation?.readable === true);
        if (!artifact)
            throw new ValidationError('创建官没有生成可读取的岗位草案。');
        const proposalStage: any = artifact.data?.reviewSubmission?.status === 'pending' || artifact.data?.status === 'draft'
            ? 'agent_proposal_drafted'
            : 'agent_proposal_submitted';
        const updated: any = await this.store.updateTask(task.taskId, {
            status: 'running',
            currentStage: proposalStage,
            artifactRefs: [...(task.artifactRefs || []), artifact],
            execution: {
                ...(task.execution || {}),
                agentProposal: {
                    executor: 'creator',
                    proposalId: artifact.data?.proposalId || null,
                    status: artifact.data?.status || null,
                    recordedAt: new Date().toISOString()
                }
            },
            usage: recordTaskUsage({ task, result, startedAt: executionStartedAt }),
        });
        return {
            assignment,
            result: {
                status: 'succeeded',
                verified: true,
                recommendedCompletionStatus: 'succeeded',
                proposal: artifact.data
            },
            task: { taskId: updated.taskId, status: updated.status, currentStage: updated.currentStage },
            duplicate: false
        };
    },
    async executeTechnicalRepairAssignment(input: any = {}): Promise<any> {
        const { task, assignment } = await this.getPaperclipAssignment(input);
        if (assignment.agentId !== 'technical-expert' || task.taskType !== 'operations.technical-repair') {
            throw new ValidationError('当前指派不是技术专家受控修复任务。');
        }
        if (this.maturityExecutionGuard)
            await this.maturityExecutionGuard.verifyOrBlock(task);
        const existing: any = (task.artifactRefs || []).find((item: any): any => item.type === 'technical_repair_case');
        if (existing) {
            return {
                assignment,
                result: existing.data,
                currentStage: task.currentStage,
                duplicate: true
            };
        }
        const executor: any = this.executors['technical-expert'];
        if (!executor?.execute)
            throw new ValidationError('技术专家隔离修复执行器不可用。');
        const executionStartedAt: any = new Date();
        const result: any = this.maturityExecutionGuard
            ? await this.maturityExecutionGuard.execute(task, executor)
            : await executor.execute(task);
        const verified: any = ['promoted', 'acceptance_verified_in_isolated_workspace'].includes(result.execution?.outcome)
            && result.execution?.verification?.testsPassed === true
            && result.execution?.verification?.recoveryVerified === true;
        const updated: any = await this.store.updateTask(task.taskId, {
            status: 'running',
            currentStage: result.currentStage || 'technical_repair_executed',
            artifactRefs: [...(task.artifactRefs || []), ...(result.artifactRefs || [])],
            execution: {
                ...(task.execution || {}),
                technicalRepair: result.execution || null
            },
            usage: recordTaskUsage({ task, result, startedAt: executionStartedAt }),
        });
        return {
            assignment,
            result: {
                status: result.status,
                currentStage: result.currentStage,
                execution: result.execution,
                verified,
                recommendedCompletionStatus: verified ? 'succeeded' : 'waiting_test',
                artifacts: (result.artifactRefs || []).map((item: any): any => ({
                    type: item.type,
                    validation: item.validation,
                    data: item.data
                }))
            },
            task: { taskId: updated.taskId, status: updated.status, currentStage: updated.currentStage },
            duplicate: false
        };
    },
    async executeOperationsHealthAssignment(input: any = {}): Promise<any> {
        const { task, assignment } = await this.getPaperclipAssignment(input);
        if (assignment.agentId !== 'operator' || task.taskType !== 'operations.health-review') {
            throw new ValidationError('当前指派不是运维官确定性健康检查任务。');
        }
        const existing: any = (task.artifactRefs || []).find((item: any): any => item.type === 'health_report'
            && item.validation?.exists === true
            && item.validation?.readable === true
            && item.validation?.nonEmpty === true);
        if (existing) {
            return {
                assignment,
                result: {
                    status: 'succeeded',
                    currentStage: task.currentStage,
                    verified: true,
                    healthStatus: existing.data?.overall || 'unknown',
                    recommendedCompletionStatus: 'succeeded',
                    artifacts: [artifactExecutionView(existing)]
                },
                task: { taskId: task.taskId, status: task.status, currentStage: task.currentStage },
                duplicate: true
            };
        }
        const executor: any = this.executors.operator;
        if (!executor?.execute)
            throw new ValidationError('运维官确定性健康检查执行器不可用。');
        const result: any = await executor.execute(task);
        const artifacts: any = (result.artifactRefs || []).filter((item: any): any => item.type === 'health_report');
        const verified: any = artifacts.some((item: any): any => item.validation?.exists === true
            && item.validation?.readable === true
            && item.validation?.nonEmpty === true);
        if (!verified)
            throw new ValidationError('运维官没有生成可核验的健康报告。');
        const updated: any = await this.store.updateTask(task.taskId, {
            status: 'running',
            currentStage: result.currentStage || 'health_report_ready',
            artifactRefs: [...(task.artifactRefs || []), ...artifacts],
            execution: {
                ...(task.execution || {}),
                operationsHealth: result.execution || null
            },
            usage: result.usage || task.usage
        });
        return {
            assignment,
            result: {
                status: result.status || 'succeeded',
                currentStage: updated.currentStage,
                verified: true,
                healthStatus: artifacts[0]?.data?.overall || 'unknown',
                recommendedCompletionStatus: 'succeeded',
                artifacts: artifacts.map(artifactExecutionView)
            },
            task: { taskId: updated.taskId, status: updated.status, currentStage: updated.currentStage },
            duplicate: false
        };
    },
    async executeEmployeeAssignment(input: any = {}): Promise<any> {
        const verified: any = await this.getPaperclipAssignment(input);
        const { task, assignment } = verified;
        const roleToolGrant: any = verified[ROLE_TOOL_GRANT] || null;
        const openResearchExecutionPolicy: any = verified[OPEN_RESEARCH_EXECUTION_POLICY] || null;
        const agent: any = await this.registry.get(assignment.agentId);
        try {
            assertPaperclipEmployeeExecutorAssignment({ agent, task });
        }
        catch (error: any) {
            throw new ValidationError(error?.message || '当前员工指派不允许执行。');
        }
        const hasM5Recovery: any = Boolean(task.input?.context?.m5Recovery);
        const observationDrivenResearch: any = task.taskType === 'research.open-investigation';
        const observationDrivenResearchActive: any = observationDrivenResearch
            && task.execution?.paperclipEmployee?.state !== 'settled';
        const stored: any = hasM5Recovery || observationDrivenResearchActive
            ? null
            : storedPaperclipEmployeeResult(task);
        if (stored) {
            const settled: any = stored.continuePolling === true
                ? await this.waitForEmployeeAssignmentSettlement(task.taskId)
                : null;
            if (settled)
                return { assignment, ...settled, duplicate: true };
            return { assignment, result: stored, task: taskExecutionView(task), duplicate: true };
        }
        let run: any = this.employeeAssignmentRuns.get(task.taskId);
        const joined: any = Boolean(run);
        if (!run) {
            const executor: any = this.capabilityCatalog.executor(assignment.agentId, this.executors);
            if (!observationDrivenResearch && !executor?.execute) {
                throw new ValidationError('当前岗位的受控本机执行器不可用。');
            }
            const promise: any = this.runEmployeeAssignment({
                task,
                assignment,
                agent,
                executor,
                roleToolGrant,
                openResearchExecutionPolicy,
            });
            run = { promise };
            this.employeeAssignmentRuns.set(task.taskId, run);
            void promise.finally((): any => {
                if (this.employeeAssignmentRuns.get(task.taskId) === run)
                    this.employeeAssignmentRuns.delete(task.taskId);
            }).catch((): any => { });
        }
        const completed: any = await run.promise;
        if (completed.result?.continuePolling === true && !observationDrivenResearch) {
            const settled: any = await this.waitForEmployeeAssignmentSettlement(task.taskId);
            if (settled)
                return { assignment, ...settled, duplicate: joined };
        }
        return joined ? { ...completed, duplicate: true } : completed;
    },
    async waitForEmployeeAssignmentSettlement(taskId: any): Promise<any> {
        const waitMs: any = Number(this.employeeAssignmentWaitMs) || 0;
        if (waitMs <= 0)
            return null;
        const deadline: any = Date.now() + waitMs;
        while (Date.now() < deadline) {
            await delay(Math.min(1000, Math.max(1, deadline - Date.now())));
            const latest: any = (await this.store.list()).find((item: any): any => item.taskId === taskId);
            if (!latest)
                return null;
            const result: any = storedPaperclipEmployeeResult(latest);
            if (result && result.continuePolling !== true) {
                return { result, task: taskExecutionView(latest) };
            }
        }
        return null;
    },
    async runEmployeeAssignment({ task, assignment, agent, executor, roleToolGrant = null, openResearchExecutionPolicy = null, }: any): Promise<any> {
        const executionStartedAt: any = new Date();
        const m5Contract: any = getM5RoutineExecutionContract(assignment?.routineKey);
        let result: any;
        let routeExecution: any = null;
        try {
            const roleToolContext: any = roleToolGrant
                ? createM5RoleToolExecutionContext(roleToolGrant.grant, {
                    adapters: this.roleToolAdapters,
                    workspaceRoot: roleToolGrant.workspaceRoot,
                    trustedScope: roleToolGrant.trustedScope,
                })
                : null;
            const prepared: any = prepareM5ExecutorTask({
                task,
                assignment,
                contract: m5Contract,
            });
            routeExecution = prepared.routeExecution;
            if (prepared.recovery) {
                assertChangedM5RecoveryRoute(routeExecution, prepared.recovery);
            }
            const paperclipWorkProducts: any = task.taskType === 'research.open-investigation'
                ? await this.readOpenResearchWorkProducts(assignment)
                : null;
            result = task.taskType === 'research.open-investigation'
                ? await executeIntelResearchOpenTaskStep({
                    task: prepared.task,
                    agent,
                    assignment,
                    executionPolicy: openResearchExecutionPolicy,
                    paperclipWorkProducts,
                    roleToolContext,
                    reportExecutor: executor,
                    writeStepWorkProduct: async (product: any): Promise<any> => {
                        if (typeof this.governance?.createIssueWorkProduct !== 'function') {
                            throw new ValidationError('小R开放研究缺少 Paperclip Work Product 写回能力。');
                        }
                        return this.governance.createIssueWorkProduct(assignment.issueId, product, { runId: assignment.runId });
                    },
                    readWorkProducts: (): any => this.readOpenResearchWorkProducts(assignment),
                })
                : await executor.execute(prepared.task, roleToolContext
                    ? { roleToolContext, m5Recovery: prepared.recovery }
                    : prepared.recovery
                        ? { m5Recovery: prepared.recovery }
                        : undefined);
            if (roleToolContext
                && !(typeof roleToolContext.enforced === 'function'
                    ? roleToolContext.enforced()
                    : roleToolContext.snapshot().length > 0)
                && result?.openResearch?.reusedReport !== true
                && !(result?.openResearch
                    && !String(result.openResearch.decision?.selectedToolId || '').trim())) {
                throw new M5RoleToolGrantError('受控执行器没有经过岗位工具授权上下文。', 'role_tool_not_enforced');
            }
        }
        catch (error: any) {
            const occurredAt: any = new Date().toISOString();
            result = {
                status: m5Contract?.executionMode === 'hermes' ? 'failed' : 'waiting_test',
                currentStage: 'paperclip_employee_execution_failed',
                artifactRefs: [],
                error: {
                    code: String(error?.code || 'paperclip_employee_executor_failed').slice(0, 120),
                    message: String(error?.message || '员工受控执行器失败。').slice(0, 500),
                    userMessage: m5Contract?.executionMode === 'hermes'
                        ? 'M5 阶段本次执行失败；请按 Paperclip 恢复策略回报 failed。'
                        : '员工未完成当前指派，已保留真实失败原因。',
                    category: m5Contract?.executionMode === 'hermes'
                        ? 'retryable'
                        : String(error?.category || 'manual').slice(0, 80),
                    stage: 'paperclip_employee_execution',
                    retryable: m5Contract?.executionMode === 'hermes' || error?.retryable === true,
                    occurredAt,
                },
            };
        }
        const artifacts: any = Array.isArray(result?.artifactRefs) ? result.artifactRefs : [];
        const verified: any = result?.status === 'succeeded' && artifacts.some(verifiedAssignmentArtifact);
        const recommendedCompletionStatus: any = result?.status === 'running'
            ? 'running'
            : verified
                ? 'succeeded'
                : result?.status === 'failed'
                    ? 'failed'
                    : 'waiting_test';
        const settled: any = recommendedCompletionStatus !== 'running';
        const latest: any = (await this.store.list()).find((item: any): any => item.taskId === task.taskId) || task;
        const updated: any = await this.store.updateTask(task.taskId, {
            status: 'running',
            currentStage: result?.currentStage || (settled ? 'paperclip_employee_executed' : 'paperclip_employee_running'),
            artifactRefs: [...(latest.artifactRefs || []), ...artifacts],
            execution: {
                ...(latest.execution || {}),
                ...(result?.execution || {}),
                owner: 'paperclip-hermes',
                paperclipEmployee: {
                    state: settled ? 'settled' : 'running',
                    executor: assignment.agentId,
                    status: String(result?.status || recommendedCompletionStatus),
                    verified,
                    recommendedCompletionStatus,
                    startedAt: executionStartedAt.toISOString(),
                    updatedAt: new Date().toISOString(),
                },
                ...(routeExecution ? { m5RouteExecution: routeExecution } : {}),
            },
            usage: recordTaskUsage({ task, result, startedAt: executionStartedAt }),
            ...(result?.error ? { error: result.error } : { error: undefined }),
        });
        if (!settled && typeof executor?.observe === 'function')
            executor.observe(updated);
        return {
            assignment,
            result: {
                status: String(result?.status || recommendedCompletionStatus),
                currentStage: updated.currentStage,
                verified,
                recommendedCompletionStatus,
                ...(recommendedCompletionStatus === 'running'
                    ? {
                        continuePolling: true,
                        pollAfterSeconds: 30,
                        message: '当前岗位的本机工作仍在执行；服务端会先等待结果，超时后再查询即可。',
                    }
                    : {}),
                error: result?.error || null,
                artifacts: artifacts.map(artifactExecutionView),
                ...(result?.openResearch ? { openResearch: result.openResearch } : {}),
            },
            task: taskExecutionView(updated),
            duplicate: false,
        };
    },
    async readOpenResearchWorkProducts(assignment: any): Promise<any> {
        if (typeof this.governance?.getIssueWorkProducts !== 'function') {
            throw new ValidationError('小R开放研究缺少 Paperclip Work Product 回读能力。');
        }
        return this.governance.getIssueWorkProducts(assignment.issueId, { runId: assignment.runId });
    },
    async executeContentGrowthAssignment(input: any = {}): Promise<any> {
        const { task, assignment } = await this.getPaperclipAssignment(input);
        if (this.maturityExecutionGuard)
            await this.maturityExecutionGuard.verifyOrBlock(task);
        const capability: any = this.capabilityCatalog.contentGrowthContract(task.taskType, assignment.agentId);
        if (!capability)
            throw new ValidationError('当前指派不是受控内容增长任务。');
        const expectedType: any = capability.artifactType;
        const hasM5Recovery: any = Boolean(task.input?.context?.m5Recovery);
        const existing: any = hasM5Recovery
            ? null
            : (task.artifactRefs || []).find((item: any): any => item.type === expectedType
                && item.validation?.exists === true
                && item.validation?.readable === true);
        if (existing) {
            const verified: any = contentGrowthArtifactVerified(task, existing);
            return {
                assignment,
                result: {
                    status: verified ? 'succeeded' : 'waiting_test',
                    currentStage: task.currentStage,
                    verified,
                    recommendedCompletionStatus: verified ? 'succeeded' : 'waiting_test',
                    artifacts: [artifactExecutionView(existing)],
                    audit: buildExecutionAudit({ usage: task.usage, artifacts: [existing] }),
                },
                task: { taskId: task.taskId, status: task.status, currentStage: task.currentStage },
                currentStage: task.currentStage,
                duplicate: true
            };
        }
        const settled: any = hasM5Recovery ? null : storedContentGrowthResult(task);
        if (settled) {
            return {
                assignment,
                result: settled,
                task: { taskId: task.taskId, status: task.status, currentStage: task.currentStage },
                duplicate: true
            };
        }
        const executor: any = this.capabilityCatalog.executor(assignment.agentId, this.executors);
        if (!executor?.execute)
            throw new ValidationError('内容增长受控执行器不可用。');
        let run: any = this.contentGrowthRuns.get(task.taskId);
        const joined: any = Boolean(run);
        if (!run) {
            const providerVision: any = task.taskType === 'content.campaign-visual-analysis'
                ? this.m5ProviderVisionCallback({
                    assignment,
                    paperclipApiKey: input.paperclipApiKey,
                })
                : null;
            const promise: any = this.runContentGrowthAssignment({
                task,
                assignment,
                expectedType,
                executor,
                providerVision,
            });
            run = { promise };
            this.contentGrowthRuns.set(task.taskId, run);
            void promise.finally((): any => {
                if (this.contentGrowthRuns.get(task.taskId) === run)
                    this.contentGrowthRuns.delete(task.taskId);
            }).catch((): any => { });
        }
        const outcome: any = await settleWithin(run.promise, this.contentGrowthWaitMs);
        if (outcome.settled)
            return outcome.value;
        const latest: any = (await this.store.list()).find((item: any): any => item.taskId === task.taskId) || task;
        return {
            assignment,
            result: {
                status: 'running',
                currentStage: 'content_growth_background_running',
                verified: false,
                recommendedCompletionStatus: 'running',
                continuePolling: true,
                pollAfterSeconds: 30,
                message: '同一项内容分析仍在 A君后台执行；30 秒后再查询，不要回报任务完成。'
            },
            task: { taskId: latest.taskId, status: latest.status, currentStage: latest.currentStage },
            duplicate: joined
        };
    },
    async runContentGrowthAssignment({ task, assignment, expectedType, executor, providerVision = null, }: any): Promise<any> {
        const executionStartedAt: any = new Date();
        const m5Contract: any = getM5RoutineExecutionContract(assignment?.routineKey);
        const started: any = await this.store.updateTask(task.taskId, {
            status: 'running',
            currentStage: 'content_growth_background_running',
            execution: {
                ...(task.execution || {}),
                contentGrowth: {
                    state: 'running',
                    executor: assignment.agentId,
                    startedAt: executionStartedAt.toISOString()
                }
            },
            error: undefined
        });
        let result: any;
        let routeExecution: any = null;
        try {
            const prepared: any = prepareM5ExecutorTask({
                task: started,
                assignment,
                contract: m5Contract,
            });
            routeExecution = prepared.routeExecution;
            if (prepared.recovery) {
                assertChangedM5RecoveryRoute(routeExecution, prepared.recovery);
            }
            const executorOptions: Record<string, any> = {
                ...(prepared.recovery ? { m5Recovery: prepared.recovery } : {}),
                ...(providerVision ? { providerVision } : {}),
            };
            result = this.maturityExecutionGuard
                ? await this.maturityExecutionGuard.execute(prepared.task, executor, executorOptions)
                : await executor.execute(prepared.task, executorOptions);
        }
        catch (error: any) {
            if (error?.blockedTask)
                throw error;
            const completedAt: any = new Date().toISOString();
            result = {
                status: 'waiting_test',
                currentStage: 'content_growth_execution_failed',
                artifactRefs: [],
                execution: {
                    executor: assignment.agentId,
                    startedAt: executionStartedAt.toISOString(),
                    finishedAt: completedAt,
                    outcome: 'failed'
                },
                error: {
                    code: String(error?.code || 'content_growth_executor_failed').slice(0, 120),
                    message: String(error?.message || '内容增长执行器失败。').slice(0, 500),
                    userMessage: '内容分析未完成，已保留真实失败原因。',
                    category: 'manual',
                    stage: 'content_growth_execution',
                    retryable: false,
                    occurredAt: completedAt
                }
            };
        }
        const artifacts: any = Array.isArray(result.artifactRefs) ? result.artifactRefs : [];
        const verified: any = result.status === 'succeeded'
            && artifacts.some((item: any): any => item.type === expectedType && contentGrowthArtifactVerified(task, item));
        const recommendedCompletionStatus: any = verified
            ? 'succeeded'
            : result.status === 'needs_input'
                ? 'failed'
                : 'waiting_test';
        const latest: any = (await this.store.list()).find((item: any): any => item.taskId === task.taskId) || task;
        const preserveTerminal: any = isTerminalTask(latest);
        const usage: any = recordTaskUsage({ task, result, startedAt: executionStartedAt });
        const updated: any = await this.store.updateTask(task.taskId, {
            status: preserveTerminal ? latest.status : 'running',
            currentStage: result.currentStage || 'content_growth_executed',
            artifactRefs: [...(latest.artifactRefs || []), ...artifacts],
            execution: {
                ...(latest.execution || {}),
                contentGrowth: {
                    ...(result.execution || {}),
                    state: 'settled',
                    status: result.status,
                    verified,
                    recommendedCompletionStatus,
                    settledAt: new Date().toISOString()
                },
                ...(routeExecution ? { m5RouteExecution: routeExecution } : {}),
            },
            usage,
            ...(result.error ? { error: result.error } : preserveTerminal ? { error: latest.error } : {})
        });
        return {
            assignment,
            result: {
                status: result.status,
                currentStage: result.currentStage,
                verified,
                recommendedCompletionStatus,
                error: result.error || null,
                artifacts: artifacts.map(artifactExecutionView),
                audit: buildExecutionAudit({ usage, artifacts }),
            },
            task: { taskId: updated.taskId, status: updated.status, currentStage: updated.currentStage },
            duplicate: false
        };
    },
    m5ProviderVisionCallback({ assignment, paperclipApiKey }: any): any {
        if (typeof this.m5ProviderVision !== 'function'
            || !assignment?.pipelineCaseId
            || !String(paperclipApiKey || '').trim())
            return null;
        const caseId: any = String(assignment.pipelineCaseId);
        const apiKey: any = String(paperclipApiKey);
        let used: any = false;
        return (parameters: any): any => {
            if (used) {
                throw new ValidationError('当前 heartbeat 的 M5 视觉 Provider callback 已使用，禁止第二次付费调用。');
            }
            used = true;
            const keys: any = parameters && typeof parameters === 'object' && !Array.isArray(parameters)
                ? Object.keys(parameters).sort()
                : [];
            if (keys.join(',') !== 'actionId,prompt,relativePath') {
                throw new ValidationError('M5 视觉 Provider callback 只接受 actionId、relativePath、prompt。');
            }
            const actionId: any = String(parameters.actionId || '');
            const relativePath: any = String(parameters.relativePath || '').replaceAll('\\', '/');
            const prompt: any = parameters.prompt;
            const actionPrefix: any = `${caseId}:vision:`;
            if (!actionId.startsWith(actionPrefix)
                || !/^[0-9a-f]{16}$/i.test(actionId.slice(actionPrefix.length))
                || !safeM5VisionRelativePath(relativePath)
                || typeof prompt !== 'string'
                || !prompt.trim()
                || prompt.length > 1000) {
                throw new ValidationError('M5 视觉 Provider callback 参数不在当前 Case 的受控范围内。');
            }
            return this.m5ProviderVision({
                caseId,
                parameters: { actionId, relativePath, prompt },
                authentication: {
                    requireRunAuthentication: true,
                    paperclipApiKey: apiKey,
                },
            });
        };
    }
};
function delay(ms: any): any {
    return new Promise((resolve: any): any => setTimeout(resolve, ms));
}

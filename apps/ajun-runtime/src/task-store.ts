import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { queryTaskRecordsInMemory, taskRecordViewForTask } from './task-record-query.ts';
import { applyApprovalPatch, applyTaskStatusPatch, applyWorkerTaskPatch, assertTaskIdempotencyMatch, claimTaskForWorker, holdTaskForApproval, initializeApprovalRecord, initializeTaskRecord, interruptedTaskExecutionPatch, isWorkerTaskClaimable, } from './task-lifecycle.ts';
import { isExactLegacyMaturityContentBlock, isExactWaitingMaturityMissionRetry } from './maturity-legacy-content-retry.ts';
export class TaskStore {
    filePath: any;
    pendingMutation: any;
    constructor(filePath: any) { this.filePath = filePath; this.pendingMutation = Promise.resolve(); }
    async list(): Promise<any> { await this.pendingMutation; return (await this.read()).tasks.sort((a: any, b: any): any => b.updatedAt.localeCompare(a.updatedAt)); }
    async getTask(taskId: any): Promise<any> {
        await this.pendingMutation;
        const tasks: any = (await this.read()).tasks;
        const task: any = tasks.find((item: any): any => item.taskId === taskId);
        return task ? { ...task, recordView: taskRecordViewForTask(task, tasks) } : null;
    }
    async queryTasks(query: any = {}): Promise<any> { await this.pendingMutation; return queryTaskRecordsInMemory((await this.read()).tasks, query); }
    async listApprovals(): Promise<any> { await this.pendingMutation; return (await this.read()).approvals.sort((a: any, b: any): any => b.createdAt.localeCompare(a.createdAt)); }
    async listProposals(): Promise<any> { await this.pendingMutation; return (await this.read()).proposals.sort((a: any, b: any): any => b.updatedAt.localeCompare(a.updatedAt)); }
    async listTestInstances(): Promise<any> { await this.pendingMutation; return (await this.read()).testInstances.sort((a: any, b: any): any => b.updatedAt.localeCompare(a.updatedAt)); }
    async getConversationContext(chatRef: any): Promise<any> { await this.pendingMutation; return (await this.read()).conversationContexts[String(chatRef || '')] || null; }
    async setConversationContext(chatRef: any, context: any): Promise<any> {
        const key: any = String(chatRef || '').trim().slice(0, 240);
        if (!key)
            return null;
        return this.mutate(async (): Promise<any> => {
            const data: any = await this.read();
            data.conversationContexts[key] = { schemaVersion: 'agent.army/conversation-context/v1', updatedAt: new Date().toISOString(), ...context };
            await this.write(data);
            return data.conversationContexts[key];
        });
    }
    async createTask(task: any): Promise<any> {
        return (await this.createTaskOnce(task)).task;
    }
    async createTaskOnce(task: any): Promise<any> {
        return this.mutate(async (): Promise<any> => {
            const data: any = await this.read();
            const now: any = new Date().toISOString();
            if (task.idempotencyKey) {
                const existing: any = data.tasks.find((item: any): any => item.idempotencyKey === task.idempotencyKey);
                if (existing) {
                    assertTaskIdempotencyMatch(existing, task);
                    return { task: existing, created: false };
                }
            }
            const record: any = initializeTaskRecord(task, { taskId: crypto.randomUUID(), now });
            data.tasks.push(record);
            await this.write(data);
            return { task: record, created: true };
        });
    }
    async createApproval(approval: any): Promise<any> {
        return this.mutate(async (): Promise<any> => {
            const data: any = await this.read();
            const now: any = new Date().toISOString();
            const record: any = initializeApprovalRecord(approval, { approvalId: crypto.randomUUID(), now });
            data.approvals.push(record);
            const task: any = data.tasks.find((item: any): any => item.taskId === approval.taskId);
            if (task) {
                Object.assign(task, holdTaskForApproval(task, record));
                task.updatedAt = now;
            }
            await this.write(data);
            return record;
        });
    }
    async updateTask(taskId: any, patch: any): Promise<any> {
        return this.mutate(async (): Promise<any> => {
            const data: any = await this.read();
            const task: any = data.tasks.find((item: any): any => item.taskId === taskId);
            if (!task)
                throw new Error('找不到要更新的任务。');
            Object.assign(task, applyTaskStatusPatch(task, patch, { approvals: data.approvals }), { updatedAt: new Date().toISOString() });
            await this.write(data);
            return task;
        });
    }
    async compareAndSwapQueuedTaskContext(taskId: any, { expectedContext, nextContext }: any = {}): Promise<any> {
        return this.mutate(async (): Promise<any> => {
            const data: any = await this.read();
            const task: any = data.tasks.find((item: any): any => item.taskId === taskId);
            if (!task)
                throw new Error('找不到要更新的任务。');
            if (task.status !== 'queued'
                || JSON.stringify(task.input?.context || null) !== JSON.stringify(expectedContext || null)) {
                return { task, updated: false };
            }
            task.input = { ...(task.input || {}), context: nextContext };
            task.updatedAt = new Date().toISOString();
            await this.write(data);
            return { task, updated: true };
        });
    }
    async compareAndSwapLegacyMaturityContentRetry(taskId: any, { expectedTask }: any = {}): Promise<any> {
        return this.mutate(async (): Promise<any> => {
            const data: any = await this.read();
            const task: any = data.tasks.find((item: any): any => item.taskId === taskId);
            if (!task)
                throw new Error('找不到要重试的任务。');
            if (!isExactLegacyMaturityContentBlock(task)
                || JSON.stringify(task) !== JSON.stringify(expectedTask)) {
                return { task, retried: false };
            }
            Object.assign(task, applyTaskStatusPatch(task, {
                status: 'queued', attempt: task.attempt + 1, currentStage: 'queued_for_execution',
                execution: undefined, error: undefined,
            }, { approvals: data.approvals }), { updatedAt: new Date().toISOString() });
            await this.write(data);
            return { task, retried: true };
        });
    }
    async compareAndSwapMaturityMissionRetry(taskId: any, { expectedTask }: any = {}): Promise<any> {
        return this.mutate(async (): Promise<any> => {
            const data: any = await this.read();
            const task: any = data.tasks.find((item: any): any => item.taskId === taskId);
            if (!task)
                throw new Error('找不到要重试的总任务。');
            if (!isExactWaitingMaturityMissionRetry(task)
                || JSON.stringify(task) !== JSON.stringify(expectedTask)) {
                return { task, retried: false };
            }
            Object.assign(task, applyTaskStatusPatch(task, {
                status: 'queued', attempt: 2, currentStage: 'queued_for_execution', execution: undefined,
            }, { approvals: data.approvals }), { updatedAt: new Date().toISOString() });
            await this.write(data);
            return { task, retried: true };
        });
    }
    async claimTaskExecution(taskId: any, patch: any = {}): Promise<any> {
        return this.mutate(async (): Promise<any> => {
            const data: any = await this.read();
            const task: any = data.tasks.find((item: any): any => item.taskId === taskId);
            if (!task)
                throw new Error('找不到要执行的任务。');
            if (task.status !== 'queued')
                return { task, claimed: false };
            Object.assign(task, applyTaskStatusPatch(task, { ...patch, status: 'running' }, { approvals: data.approvals }), {
                updatedAt: new Date().toISOString(),
            });
            await this.write(data);
            return { task, claimed: true };
        });
    }
    async recoverInterruptedTaskExecution(taskId: any, { expectedStartedAt, expectedStage, interruptedAt }: any = {}): Promise<any> {
        return this.mutate(async (): Promise<any> => {
            const data: any = await this.read();
            const task: any = data.tasks.find((item: any): any => item.taskId === taskId);
            if (!task)
                throw new Error('找不到要恢复的任务。');
            if (task.status !== 'running'
                || task.currentStage !== expectedStage
                || task.execution?.startedAt !== expectedStartedAt) {
                return { task, recovered: false };
            }
            const detectedAt: any = interruptedAt || new Date().toISOString();
            Object.assign(task, applyTaskStatusPatch(task, interruptedTaskExecutionPatch(task, detectedAt), {
                approvals: data.approvals,
            }), { updatedAt: detectedAt });
            await this.write(data);
            return { task, recovered: true };
        });
    }
    async claimWorkerTask({ workerId, taskTypes, leaseMs = 120000, now = Date.now() }: any): Promise<any> {
        return this.mutate(async (): Promise<any> => {
            const data: any = await this.read();
            const candidates: any = data.tasks
                .filter((task: any): any => isWorkerTaskClaimable(task, { taskTypes, now }))
                .sort((a: any, b: any): any => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
            const task: any = candidates[0];
            if (!task)
                return null;
            Object.assign(task, claimTaskForWorker(task, {
                workerId,
                leaseId: crypto.randomUUID(),
                leaseMs,
                now,
            }));
            await this.write(data);
            return task;
        });
    }
    async updateWorkerTask(taskId: any, { workerId, leaseId, patch, leaseMs = 120000, now = Date.now(), extendLease = false }: any): Promise<any> {
        return this.mutate(async (): Promise<any> => {
            const data: any = await this.read();
            const task: any = data.tasks.find((item: any): any => item.taskId === taskId);
            if (!task)
                throw new Error('找不到这条 Mac 工作间任务。');
            Object.assign(task, applyWorkerTaskPatch(task, {
                workerId,
                leaseId,
                patch,
                leaseMs,
                now,
                extendLease,
            }));
            await this.write(data);
            return task;
        });
    }
    async updateApproval(approvalId: any, patch: any): Promise<any> {
        return this.mutate(async (): Promise<any> => {
            const data: any = await this.read();
            const approval: any = data.approvals.find((item: any): any => item.approvalId === approvalId);
            if (!approval)
                throw new Error('找不到要更新的审批。');
            Object.assign(approval, applyApprovalPatch(approval, patch));
            await this.write(data);
            return approval;
        });
    }
    async resolveApprovalAndUpdateTask(approvalId: any, approvalPatch: any, taskId: any, taskPatch: any): Promise<any> {
        return this.mutate(async (): Promise<any> => {
            const data: any = await this.read();
            const approval: any = data.approvals.find((item: any): any => item.approvalId === approvalId);
            const task: any = data.tasks.find((item: any): any => item.taskId === taskId);
            if (!approval)
                throw new Error('找不到要更新的审批。');
            if (!task)
                throw new Error('找不到要更新的任务。');
            if (approval.taskId !== task.taskId)
                throw new Error('审批与任务不匹配。');
            Object.assign(approval, applyApprovalPatch(approval, approvalPatch));
            const resolvedTaskPatch: any = typeof taskPatch === 'function'
                ? taskPatch(task, approval)
                : taskPatch;
            Object.assign(task, applyTaskStatusPatch(task, resolvedTaskPatch, { approvals: data.approvals }), {
                updatedAt: new Date().toISOString(),
            });
            await this.write(data);
            return { approval, task };
        });
    }
    async createProposal(proposal: any): Promise<any> {
        return this.mutate(async (): Promise<any> => {
            const data: any = await this.read();
            const now: any = new Date().toISOString();
            if (proposal.sourceEventRef) {
                const existing: any = data.proposals.find((item: any): any => item.sourceEventRef === proposal.sourceEventRef);
                if (existing)
                    return existing;
            }
            const record: Record<string, any> = { schemaVersion: 'agent.army/proposal/v1', proposalId: crypto.randomUUID(), version: 1, reviewRefs: [], audit: [], createdAt: now, updatedAt: now, ...proposal };
            data.proposals.push(record);
            await this.write(data);
            return record;
        });
    }
    async updateProposal(proposalId: any, patch: any): Promise<any> {
        return this.mutate(async (): Promise<any> => {
            const data: any = await this.read();
            const proposal: any = data.proposals.find((item: any): any => item.proposalId === proposalId);
            if (!proposal)
                throw new Error('找不到 Agent 草案。');
            Object.assign(proposal, patch, { updatedAt: new Date().toISOString() });
            await this.write(data);
            return proposal;
        });
    }
    async createTestInstance(instance: any): Promise<any> {
        return this.mutate(async (): Promise<any> => {
            const data: any = await this.read();
            const now: any = new Date().toISOString();
            const record: Record<string, any> = { schemaVersion: 'agent.army/test-instance/v1', testInstanceId: crypto.randomUUID(), createdAt: now, updatedAt: now, ...instance };
            data.testInstances.push(record);
            await this.write(data);
            return record;
        });
    }
    async updateTestInstance(testInstanceId: any, patch: any): Promise<any> {
        return this.mutate(async (): Promise<any> => {
            const data: any = await this.read();
            const instance: any = data.testInstances.find((item: any): any => item.testInstanceId === testInstanceId);
            if (!instance)
                throw new Error('找不到受限测试实例。');
            Object.assign(instance, patch, { updatedAt: new Date().toISOString() });
            await this.write(data);
            return instance;
        });
    }
    async mutate(operation: any): Promise<any> {
        const previous: any = this.pendingMutation;
        let release: any;
        this.pendingMutation = new Promise((resolve: any): any => { release = resolve; });
        await previous;
        try {
            return await operation();
        }
        finally {
            release();
        }
    }
    async read(): Promise<any> {
        try {
            const data: any = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
            return { tasks: [], approvals: [], proposals: [], testInstances: [], conversationContexts: {}, ...data };
        }
        catch (error: any) {
            if (error.code === 'ENOENT')
                return { tasks: [], approvals: [], proposals: [], testInstances: [], conversationContexts: {} };
            throw error;
        }
    }
    async write(data: any): Promise<any> {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        const temporary: any = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
        try {
            await fs.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
            await fs.rename(temporary, this.filePath);
            await fs.chmod(this.filePath, 0o600);
        }
        catch (error: any) {
            await fs.rm(temporary, { force: true }).catch((): any => { });
            throw error;
        }
    }
}

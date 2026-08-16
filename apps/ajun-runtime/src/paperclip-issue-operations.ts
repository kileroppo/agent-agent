import { paperclipIssueStatusForTaskStatus } from './task-status-policy.ts';
export const paperclipIssueMethods: Record<string, any> = {
    async update(task: any): Promise<any> {
        const projection: any = task.governance;
        if (!projection?.paperclipIssueId)
            return projection || { status: 'not_projected' };
        if (task.taskType === 'operations.technical-repair' && projection.paperclipAssigneeAgentId && task.status !== 'waiting_test') {
            return { ...projection, status: 'delegated', syncedAt: new Date().toISOString() };
        }
        try {
            await this.request(`/api/issues/${projection.paperclipIssueId}`, {
                method: 'PATCH', body: { status: paperclipIssueStatusForTaskStatus(task.status), comment: `A君状态更新：${task.status}${task.currentStage ? ` / ${task.currentStage}` : ''}` }
            });
            return { ...projection, status: 'synced', syncedAt: new Date().toISOString() };
        }
        catch (error: any) {
            return { ...projection, status: 'sync_pending', reason: safeError(error), syncedAt: new Date().toISOString() };
        }
    },
    async completePaperclipIssue(issueId: any, { runId, agentId, apiKey, result, hideFromDashboard = false, }: any): Promise<any> {
        const report: any = result.artifactRefs?.find((item: any): any => item.type === 'health_report')?.data;
        const employeeReport: any = result.artifactRefs?.find((item: any): any => item.type === 'employee_role_report')?.data;
        const outcome: any = report?.overall || employeeReport?.summary || result.execution?.outcome || 'unknown';
        const succeeded: any = result.status === 'succeeded';
        await this.request(`/api/issues/${encodeURIComponent(issueId)}`, {
            method: 'PATCH', runId, apiKey, body: {
                status: succeeded ? 'done' : 'blocked',
                ...(hideFromDashboard && succeeded ? { hiddenAt: new Date().toISOString() } : {}),
                comment: [
                    result.execution?.owner === 'paperclip-hermes'
                        ? '员工 Hermes Profile 执行回报。'
                        : 'A君本机执行回报（Paperclip HTTP Adapter）。',
                    `运行：${runId}`,
                    `岗位：${agentId}`,
                    `阶段：${result.currentStage || 'unknown'}`,
                    `结果：${outcome}`,
                    ...(hideFromDashboard && succeeded
                        ? ['系统巡检已归档：保留运行与任务证据，不进入老板大盘。']
                        : []),
                ].join('\n')
            }
        });
    },
    async markPaperclipIssueReviewPending(issueId: any, { runId, apiKey, result, reviewTaskId = null, }: any = {}): Promise<any> {
        return this.request(`/api/issues/${encodeURIComponent(issueId)}`, {
            method: 'PATCH', runId, apiKey, body: {
                status: 'in_review',
                comment: [
                    '员工已提交可读产物，A君已启动独立质量复核。',
                    `运行：${String(runId || 'unknown')}`,
                    `阶段：${String(result?.currentStage || 'delivery_quality_review_pending')}`,
                    ...(reviewTaskId ? [`复核任务：${String(reviewTaskId)}`] : []),
                    '复核完成后将自动回写最终状态；当前无需重复唤醒原员工。',
                ].join('\n'),
            },
        });
    },
    async getPaperclipIssue(issueId: any): Promise<any> {
        return this.request(`/api/issues/${encodeURIComponent(issueId)}`);
    },
    async getPaperclipIssueRuns(issueId: any): Promise<any> {
        return this.request(`/api/issues/${encodeURIComponent(issueId)}/runs`);
    },
    async getPaperclipIssueActiveRun(issueId: any): Promise<any> {
        return this.request(`/api/issues/${encodeURIComponent(issueId)}/active-run`);
    },
    async getPaperclipHeartbeatRun(runId: any): Promise<any> {
        return this.request(`/api/heartbeat-runs/${encodeURIComponent(runId)}`);
    },
    async getExecutionWorkspace(workspaceId: any): Promise<any> {
        return this.request(`/api/execution-workspaces/${encodeURIComponent(workspaceId)}`);
    },
    async getPaperclipAgent(agentId: any): Promise<any> {
        const company: any = await this.companyForRuntime();
        const agents: any = await this.request(`/api/companies/${company.id}/agents`);
        return agents.find((agent: any): any => agent.id === agentId) || null;
    },
    async updateIssueExecutionPolicy(issueId: any, { runId, executionPolicy }: any = {}): Promise<any> {
        return this.request(`/api/issues/${encodeURIComponent(issueId)}`, {
            method: 'PATCH',
            runId,
            body: { executionPolicy },
        });
    },
    async createIssueWorkProduct(issueId: any, product: any, { runId, apiKey }: any = {}): Promise<any> {
        return this.request(`/api/issues/${encodeURIComponent(issueId)}/work-products`, {
            method: 'POST',
            runId,
            apiKey,
            body: product,
        });
    },
    async getIssueWorkProducts(issueId: any, { runId }: any = {}): Promise<any> {
        return this.request(`/api/issues/${encodeURIComponent(issueId)}/work-products`, {
            runId,
        });
    },
    async completeMetricMonitorIssue(issueId: any, { runId, executionPolicy, comment, }: any = {}): Promise<any> {
        return this.request(`/api/issues/${encodeURIComponent(issueId)}`, {
            method: 'PATCH',
            runId,
            body: {
                status: 'done',
                executionPolicy,
                comment,
            },
        });
    },
    async completeRetrospectiveIssue(issueId: any, { runId, comment }: any = {}): Promise<any> {
        return this.request(`/api/issues/${encodeURIComponent(issueId)}`, {
            method: 'PATCH',
            runId,
            body: {
                status: 'done',
                comment,
            },
        });
    },
    async updateLearningIssue(issueId: any, { runId, status, comment, }: any = {}): Promise<any> {
        if (!['in_progress', 'in_review', 'done'].includes(status)) {
            throw new Error('M5 学习任务状态无效。');
        }
        return this.request(`/api/issues/${encodeURIComponent(issueId)}`, {
            method: 'PATCH',
            runId,
            body: { status, comment },
        });
    },
    async completePublisherIssue(issueId: any, { runId, comment, }: any = {}): Promise<any> {
        return this.request(`/api/issues/${encodeURIComponent(issueId)}`, {
            method: 'PATCH',
            runId,
            body: {
                status: 'done',
                comment,
            },
        });
    },
    async completeTechnicalRepairIssue(issueId: any, title: any): Promise<any> {
        return this.request(`/api/issues/${encodeURIComponent(issueId)}`, {
            method: 'PATCH', body: { status: 'done', comment: `A君已代为登记技术专家在受控工作区留下的修复证据：${String(title || '修复与验证证据')}。专家本身未被授予网络访问权限。` }
        });
    },
    async failPaperclipIssue(issueId: any, { runId, agentId, error }: any): Promise<any> {
        await this.request(`/api/issues/${encodeURIComponent(issueId)}`, {
            method: 'PATCH', body: {
                status: 'blocked',
                comment: [
                    'A君本机执行失败（Paperclip HTTP Adapter）。',
                    `运行：${runId}`,
                    `岗位：${agentId}`,
                    `原因：${safeError(error)}`
                ].join('\n')
            }
        });
    },
    async companyForRuntime(): Promise<any> {
        return this.taskProjector.companyForRuntime();
    },
    async managedAgent(agentArmyId: any, companyId: any = null): Promise<any> {
        return this.taskProjector.managedAgent(agentArmyId, companyId);
    }
};
function safeError(error: any): any { return String(error?.message || 'Paperclip 暂不可用。').slice(0, 240); }

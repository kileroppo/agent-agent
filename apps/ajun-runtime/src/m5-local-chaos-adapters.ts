import { LOCAL_CHAOS_FIXTURE } from './m5-local-chaos-fixtures.ts';
export class LocalChaosPaperclipGovernance {
    adapter: any;
    constructor(adapter: any) {
        this.adapter = adapter;
    }
    addIssue(issue: any): any {
        this.adapter.state.issues.push(structuredClone(issue));
    }
    startRun(run: any): any {
        this.adapter.state.runs.push(structuredClone(run));
    }
    setIssueStatus(issueId: any, status: any): any {
        this.issue(issueId).status = status;
    }
    async verifySystemAssignment({ issueId, runId, paperclipAgentId, systemRole }: any): Promise<any> {
        const issue: any = this.issue(issueId);
        const run: any = this.adapter.state.runs.find((item: any): any => item.issueId === issueId
            && item.runId === runId
            && item.agentId === paperclipAgentId
            && item.status === 'running');
        const agent: any = this.adapter.state.agents.find((item: any): any => item.id === paperclipAgentId);
        if (!run
            || issue.assigneeAgentId !== paperclipAgentId
            || agent?.metadata?.agentArmySystemRole !== systemRole) {
            throw new Error('本地 chaos Paperclip 系统身份链不一致。');
        }
        return {
            issue: structuredClone(issue),
            run: {
                id: run.runId,
                status: run.status,
                agentId: run.agentId,
                companyId: LOCAL_CHAOS_FIXTURE.companyId,
            },
            paperclipAgent: structuredClone(agent),
            systemRole,
        };
    }
    async assertCaseIssueLink(caseId: any, issueId: any): Promise<any> {
        if (this.issue(issueId).caseId !== caseId) {
            throw new Error('本地 chaos Issue 与 Case 未绑定。');
        }
        return { caseId, issueId };
    }
    async getPipelineCase(caseId: any): Promise<any> {
        const item: any = await this.adapter.getCase(caseId);
        if (!item)
            throw new Error(`本地 chaos Case 不存在：${caseId}`);
        return structuredClone(item);
    }
    async getPipelineCaseOutputs(caseId: any): Promise<any> {
        const item: any = await this.adapter.getCase(caseId);
        if (!item)
            throw new Error(`本地 chaos Case 不存在：${caseId}`);
        return { caseId, items: structuredClone(item.workProducts || []) };
    }
    async createIssueWorkProduct(issueId: any, product: any, _options: any = {}): Promise<any> {
        const issue: any = this.issue(issueId);
        const item: any = await this.adapter.getCase(issue.caseId);
        item.workProducts ??= [];
        const stored: Record<string, any> = {
            id: `work_product:${product.externalId}`,
            kind: 'work_product',
            sourceTrust: null,
            ...structuredClone(product),
        };
        item.workProducts.push(stored);
        return structuredClone(stored);
    }
    async completePublisherIssue(issueId: any, payload: any): Promise<any> {
        const issue: any = this.issue(issueId);
        issue.status = 'done';
        issue.completion = structuredClone(payload);
    }
    async updateIssueExecutionPolicy(issueId: any, { executionPolicy }: any): Promise<any> {
        this.issue(issueId).executionPolicy = structuredClone(executionPolicy);
    }
    async completeMetricMonitorIssue(issueId: any, { executionPolicy, ...payload }: any): Promise<any> {
        const issue: any = this.issue(issueId);
        issue.status = 'done';
        issue.executionPolicy = structuredClone(executionPolicy);
        issue.completion = structuredClone(payload);
    }
    async getPaperclipIssue(issueId: any): Promise<any> {
        return structuredClone(this.issue(issueId));
    }
    async getPaperclipIssueRuns(issueId: any): Promise<any> {
        return this.adapter.state.runs
            .filter((item: any): any => item.issueId === issueId)
            .map((item: any): any => ({ id: item.runId, status: item.status, agentId: item.agentId }));
    }
    async getPipelineCaseEvents(caseId: any): Promise<any> {
        return this.adapter.state.caseEvents
            .filter((item: any): any => item.caseId === caseId)
            .map((item: any): any => structuredClone(item.event));
    }
    async patchPipelineCaseFields(caseId: any, { expectedVersion, fields }: any): Promise<any> {
        const updated: any = await this.adapter.patchCaseFields(caseId, expectedVersion, fields);
        this.adapter.state.caseEvents.push({
            caseId,
            event: {
                payload: {
                    fields: {
                        m5StageRecovery: structuredClone(fields.m5StageRecovery),
                        m5ContentRecovery: structuredClone(fields.m5ContentRecovery),
                    },
                },
            },
        });
        return structuredClone(updated);
    }
    async reopenM5StageIssue(issueId: any, payload: any): Promise<any> {
        const issue: any = this.issue(issueId);
        issue.status = 'todo';
        issue.lastRecovery = structuredClone(payload);
    }
    async blockM5StageIssue(issueId: any, payload: any): Promise<any> {
        const issue: any = this.issue(issueId);
        issue.status = 'blocked';
        issue.lastRecovery = structuredClone(payload);
    }
    async completeM5RecoveredStageIssue(issueId: any, payload: any): Promise<any> {
        const issue: any = this.issue(issueId);
        issue.status = 'done';
        issue.completion = structuredClone(payload);
    }
    issue(issueId: any): any {
        const issue: any = this.adapter.state.issues.find((item: any): any => item.id === issueId);
        if (!issue)
            throw new Error(`本地 chaos Issue 不存在：${issueId}`);
        return issue;
    }
}
export class LocalChaosPublisherControl {
    adapter: any;
    campaignId: any;
    pauseCalls: any;
    resumeCount: any;
    constructor({ adapter, campaignId }: any) {
        this.adapter = adapter;
        this.campaignId = campaignId;
        this.pauseCalls = [];
        this.resumeCount = 0;
    }
    async assertPublishAllowed(input: any): Promise<any> {
        const campaign: any = await this.adapter.getCase(input.campaignId);
        if (!campaign || campaign.id !== this.campaignId) {
            throw new Error('本地 chaos CampaignGrant Case 身份漂移。');
        }
        return {
            campaignId: input.campaignId,
            grantStatus: campaign.fields?.campaignGrant?.status,
            currentStage: campaign.stageKey,
            canonicalGrant: structuredClone(campaign.fields?.campaignGrant),
        };
    }
    async pauseCampaignAndDisableCron(input: any): Promise<any> {
        if (input.campaignId !== this.campaignId) {
            throw new Error('本地 chaos 暂停目标 CampaignGrant 身份漂移。');
        }
        this.pauseCalls.push(structuredClone(input));
        const campaign: any = await this.adapter.getCase(this.campaignId);
        const pausedAt: any = String(input.requestedAt || LOCAL_CHAOS_FIXTURE.publishedAt);
        await this.adapter.patchCaseFields(campaign.id, campaign.version, {
            ...campaign.fields,
            campaignGrant: {
                ...campaign.fields.campaignGrant,
                status: 'paused',
                pausedAt,
                pauseReason: String(input.reason || 'unknown'),
            },
            dailyCronEnabled: false,
        });
        const confirmed: any = await this.adapter.getCase(this.campaignId);
        if (confirmed.fields?.campaignGrant?.status !== 'paused'
            || confirmed.fields?.dailyCronEnabled !== false) {
            throw new Error('本地 chaos 未回读确认 CampaignGrant 暂停和 Cron 关闭。');
        }
        return {
            campaignId: this.campaignId,
            grantStatus: 'paused',
            cronStatus: 'disabled',
            controlEventId: `local-chaos-pause-${this.pauseCalls.length}`,
        };
    }
    async resumeCampaignGrant(): Promise<any> {
        const campaign: any = await this.adapter.getCase(this.campaignId);
        if (campaign.fields?.campaignGrant?.status !== 'paused'
            || campaign.fields?.dailyCronEnabled !== false) {
            throw new Error('本地 chaos 只允许从已暂停 Grant 且 Cron 关闭的检查点恢复。');
        }
        await this.adapter.patchCaseFields(campaign.id, campaign.version, {
            ...campaign.fields,
            campaignGrant: {
                ...campaign.fields.campaignGrant,
                status: 'active',
                resumedAt: LOCAL_CHAOS_FIXTURE.publishedAt,
            },
            dailyCronEnabled: true,
        });
        this.resumeCount += 1;
        const confirmed: any = await this.adapter.getCase(this.campaignId);
        if (confirmed.fields?.campaignGrant?.status !== 'active'
            || confirmed.fields?.dailyCronEnabled !== true) {
            throw new Error('本地 chaos 未回读确认 CampaignGrant 恢复和 Cron 启用。');
        }
        return structuredClone(confirmed);
    }
}
export class ToggleBudgetCostRecorder {
    allowed: any;
    campaignId: any;
    checks: any;
    resumeCount: any;
    zeroCostRecords: any;
    constructor(campaignId: any) {
        this.campaignId = campaignId;
        this.allowed = false;
        this.resumeCount = 0;
        this.checks = [];
        this.zeroCostRecords = [];
    }
    async assertCampaignBudget(input: any): Promise<any> {
        this.checks.push(structuredClone(input));
        return {
            campaignId: this.campaignId,
            allowed: this.allowed,
            hardStopEnabled: true,
            remainingAmountUsd: this.allowed ? 6.25 : 0,
        };
    }
    async recordLocalZeroAttempt(input: any): Promise<any> {
        this.zeroCostRecords.push(structuredClone(input));
        return { replayed: false, amountUsd: 0 };
    }
    resume(): any {
        this.allowed = true;
        this.resumeCount += 1;
    }
}

import { LOCAL_CHAOS_FIXTURE } from './m5-local-chaos-fixtures.js';

export class LocalChaosPaperclipGovernance {
  constructor(adapter) {
    this.adapter = adapter;
  }

  addIssue(issue) {
    this.adapter.state.issues.push(structuredClone(issue));
  }

  startRun(run) {
    this.adapter.state.runs.push(structuredClone(run));
  }

  setIssueStatus(issueId, status) {
    this.issue(issueId).status = status;
  }

  async verifySystemAssignment({ issueId, runId, paperclipAgentId, systemRole }) {
    const issue = this.issue(issueId);
    const run = this.adapter.state.runs.find((item) =>
      item.issueId === issueId
      && item.runId === runId
      && item.agentId === paperclipAgentId
      && item.status === 'running',
    );
    const agent = this.adapter.state.agents.find((item) => item.id === paperclipAgentId);
    if (
      !run
      || issue.assigneeAgentId !== paperclipAgentId
      || agent?.metadata?.agentArmySystemRole !== systemRole
    ) {
      throw new Error('本地 chaos Paperclip 系统身份链不一致。');
    }
    return {
      issue:structuredClone(issue),
      run:{
        id:run.runId,
        status:run.status,
        agentId:run.agentId,
        companyId:LOCAL_CHAOS_FIXTURE.companyId,
      },
      paperclipAgent:structuredClone(agent),
      systemRole,
    };
  }

  async assertCaseIssueLink(caseId, issueId) {
    if (this.issue(issueId).caseId !== caseId) {
      throw new Error('本地 chaos Issue 与 Case 未绑定。');
    }
    return { caseId, issueId };
  }

  async getPipelineCase(caseId) {
    const item = await this.adapter.getCase(caseId);
    if (!item) throw new Error(`本地 chaos Case 不存在：${caseId}`);
    return structuredClone(item);
  }

  async getPipelineCaseOutputs(caseId) {
    const item = await this.adapter.getCase(caseId);
    if (!item) throw new Error(`本地 chaos Case 不存在：${caseId}`);
    return { caseId, items:structuredClone(item.workProducts || []) };
  }

  async createIssueWorkProduct(issueId, product, _options = {}) {
    const issue = this.issue(issueId);
    const item = await this.adapter.getCase(issue.caseId);
    item.workProducts ??= [];
    const stored = {
      id:`work_product:${product.externalId}`,
      kind:'work_product',
      sourceTrust:null,
      ...structuredClone(product),
    };
    item.workProducts.push(stored);
    return structuredClone(stored);
  }

  async completePublisherIssue(issueId, payload) {
    const issue = this.issue(issueId);
    issue.status = 'done';
    issue.completion = structuredClone(payload);
  }

  async updateIssueExecutionPolicy(issueId, { executionPolicy }) {
    this.issue(issueId).executionPolicy = structuredClone(executionPolicy);
  }

  async completeMetricMonitorIssue(issueId, { executionPolicy, ...payload }) {
    const issue = this.issue(issueId);
    issue.status = 'done';
    issue.executionPolicy = structuredClone(executionPolicy);
    issue.completion = structuredClone(payload);
  }

  async getPaperclipIssue(issueId) {
    return structuredClone(this.issue(issueId));
  }

  async getPaperclipIssueRuns(issueId) {
    return this.adapter.state.runs
      .filter((item) => item.issueId === issueId)
      .map((item) => ({ id:item.runId, status:item.status, agentId:item.agentId }));
  }

  async getPipelineCaseEvents(caseId) {
    return this.adapter.state.caseEvents
      .filter((item) => item.caseId === caseId)
      .map((item) => structuredClone(item.event));
  }

  async patchPipelineCaseFields(caseId, { expectedVersion, fields }) {
    const updated = await this.adapter.patchCaseFields(caseId, expectedVersion, fields);
    this.adapter.state.caseEvents.push({
      caseId,
      event:{
        payload:{
          fields:{
            m5StageRecovery:structuredClone(fields.m5StageRecovery),
            m5ContentRecovery:structuredClone(fields.m5ContentRecovery),
          },
        },
      },
    });
    return structuredClone(updated);
  }

  async reopenM5StageIssue(issueId, payload) {
    const issue = this.issue(issueId);
    issue.status = 'todo';
    issue.lastRecovery = structuredClone(payload);
  }

  async blockM5StageIssue(issueId, payload) {
    const issue = this.issue(issueId);
    issue.status = 'blocked';
    issue.lastRecovery = structuredClone(payload);
  }

  async completeM5RecoveredStageIssue(issueId, payload) {
    const issue = this.issue(issueId);
    issue.status = 'done';
    issue.completion = structuredClone(payload);
  }

  issue(issueId) {
    const issue = this.adapter.state.issues.find((item) => item.id === issueId);
    if (!issue) throw new Error(`本地 chaos Issue 不存在：${issueId}`);
    return issue;
  }
}

export class LocalChaosPublisherControl {
  constructor({ adapter, campaignId }) {
    this.adapter = adapter;
    this.campaignId = campaignId;
    this.pauseCalls = [];
    this.resumeCount = 0;
  }

  async assertPublishAllowed(input) {
    const campaign = await this.adapter.getCase(input.campaignId);
    if (!campaign || campaign.id !== this.campaignId) {
      throw new Error('本地 chaos CampaignGrant Case 身份漂移。');
    }
    return {
      campaignId:input.campaignId,
      grantStatus:campaign.fields?.campaignGrant?.status,
      currentStage:campaign.stageKey,
      canonicalGrant:structuredClone(campaign.fields?.campaignGrant),
    };
  }

  async pauseCampaignAndDisableCron(input) {
    if (input.campaignId !== this.campaignId) {
      throw new Error('本地 chaos 暂停目标 CampaignGrant 身份漂移。');
    }
    this.pauseCalls.push(structuredClone(input));
    const campaign = await this.adapter.getCase(this.campaignId);
    const pausedAt = String(input.requestedAt || LOCAL_CHAOS_FIXTURE.publishedAt);
    await this.adapter.patchCaseFields(campaign.id, campaign.version, {
      ...campaign.fields,
      campaignGrant:{
        ...campaign.fields.campaignGrant,
        status:'paused',
        pausedAt,
        pauseReason:String(input.reason || 'unknown'),
      },
      dailyCronEnabled:false,
    });
    const confirmed = await this.adapter.getCase(this.campaignId);
    if (
      confirmed.fields?.campaignGrant?.status !== 'paused'
      || confirmed.fields?.dailyCronEnabled !== false
    ) {
      throw new Error('本地 chaos 未回读确认 CampaignGrant 暂停和 Cron 关闭。');
    }
    return {
      campaignId:this.campaignId,
      grantStatus:'paused',
      cronStatus:'disabled',
      controlEventId:`local-chaos-pause-${this.pauseCalls.length}`,
    };
  }

  async resumeCampaignGrant() {
    const campaign = await this.adapter.getCase(this.campaignId);
    if (
      campaign.fields?.campaignGrant?.status !== 'paused'
      || campaign.fields?.dailyCronEnabled !== false
    ) {
      throw new Error('本地 chaos 只允许从已暂停 Grant 且 Cron 关闭的检查点恢复。');
    }
    await this.adapter.patchCaseFields(campaign.id, campaign.version, {
      ...campaign.fields,
      campaignGrant:{
        ...campaign.fields.campaignGrant,
        status:'active',
        resumedAt:LOCAL_CHAOS_FIXTURE.publishedAt,
      },
      dailyCronEnabled:true,
    });
    this.resumeCount += 1;
    const confirmed = await this.adapter.getCase(this.campaignId);
    if (
      confirmed.fields?.campaignGrant?.status !== 'active'
      || confirmed.fields?.dailyCronEnabled !== true
    ) {
      throw new Error('本地 chaos 未回读确认 CampaignGrant 恢复和 Cron 启用。');
    }
    return structuredClone(confirmed);
  }
}

export class ToggleBudgetCostRecorder {
  constructor(campaignId) {
    this.campaignId = campaignId;
    this.allowed = false;
    this.resumeCount = 0;
    this.checks = [];
    this.zeroCostRecords = [];
  }

  async assertCampaignBudget(input) {
    this.checks.push(structuredClone(input));
    return {
      campaignId:this.campaignId,
      allowed:this.allowed,
      hardStopEnabled:true,
      remainingAmountUsd:this.allowed ? 6.25 : 0,
    };
  }

  async recordLocalZeroAttempt(input) {
    this.zeroCostRecords.push(structuredClone(input));
    return { replayed:false, amountUsd:0 };
  }

  resume() {
    this.allowed = true;
    this.resumeCount += 1;
  }
}

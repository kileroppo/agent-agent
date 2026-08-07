import crypto from 'node:crypto';
import {
  UUID,
  PUBLISHER_APPROVAL_SCHEMA,
  PUBLISHER_AUTHORIZATION_SCHEMA,
  PUBLISHER_COST_RECORD_SCHEMA,
  PUBLISHER_ACTION_ROLES,
  PUBLISHER_ACTION_STAGES,
  PUBLISHER_SECRET_KEY,
  PUBLISHER_CONNECTOR_MODE,
  PUBLISHER_BUDGET_OPERATIONS,
  PUBLISHER_COST_OPERATIONS,
  m5CaseProjectId,
  normalizeM5Case,
  publisherIssueCaseId,
  assertPublisherAuthorizationId,
  normalizePublisherConnectorApproval,
  uniquePublisherApproval,
  parsePublisherCredential,
  publisherIdentity,
  samePublisherIdentity,
  publisherPlatform,
  publisherCapability,
  publisherReference,
  publisherAuthorizationRecord,
  samePublisherAuthorization,
  publisherCostRecord,
  samePublisherCost,
  boundedRecordMap,
  integerVersion,
  validClock,
  assertExactKeys,
  stableJson,
} from './paperclip-publisher-contract.js';

export const paperclipPublisherMethods = {
  async authorizePublisherRequest(input = {}) {
    const context = await this.publisherAuthorizationContext(input);
    const existing = publisherAuthorizationRecord(
      context.targetCase.fields?.m5PublisherAuthorizations?.[input.authorizationId],
    );
    const canonical = {
      schemaVersion:PUBLISHER_AUTHORIZATION_SCHEMA,
      action:input.action,
      authorizationId:input.authorizationId,
      runId:input.runId,
      issueId:input.issueId,
      agentId:input.agentId,
      campaignId:input.campaignId,
    };
    if (existing) {
      if (!samePublisherAuthorization(existing, canonical)) {
        throw new Error('Publisher 授权幂等标识与已有 Paperclip 记录冲突。');
      }
      return { ...canonical, authorized:true, replayed:true };
    }
    const expectedVersion = integerVersion(context.targetCase.version);
    const records = boundedRecordMap(
      context.targetCase.fields?.m5PublisherAuthorizations,
      input.authorizationId,
      {
        ...canonical,
        consumedAt:validClock(this.clock()).toISOString(),
      },
    );
    const updated = normalizeM5Case(await this.patchPipelineCaseFields(
      context.targetCase.id,
      {
        expectedVersion,
        runId:context.credential.runId,
        fields:{
          ...context.targetCase.fields,
          m5PublisherAuthorizations:records,
        },
      },
    ));
    const persisted = publisherAuthorizationRecord(
      updated.fields?.m5PublisherAuthorizations?.[input.authorizationId],
    );
    if (!persisted || !samePublisherAuthorization(persisted, canonical)) {
      throw new Error('Publisher 一次性授权没有在 Paperclip Case 中回读确认。');
    }
    return { ...canonical, authorized:true, replayed:false };
  },

  async getPublisherConnectorApprovalSnapshot(input = {}) {
    const context = await this.publisherAuthorizationContext(input);
    const approvals = await this.publisherConnectorApprovals(context);
    if (approvals.length === 0) {
      throw new Error('Paperclip 中没有当前 Campaign 可用的 Publisher connector 批准。');
    }
    const publicApprovals = approvals
      .map((approval) => ({
        status:'approved',
        approvalRef:`paperclip:approval:${approval.id}`,
        platform:approval.platform,
        capability:approval.capability,
        connectorKind:approval.connectorKind,
        expiresAt:approval.expiresAt,
      }))
      .sort((left, right) => (
        `${left.platform}:${left.capability}`.localeCompare(
          `${right.platform}:${right.capability}`,
        )
      ));
    const snapshotHash = crypto.createHash('sha256')
      .update(stableJson(publicApprovals))
      .digest('hex');
    return {
      schemaVersion:PUBLISHER_APPROVAL_SCHEMA,
      source:'paperclip',
      snapshotId:`paperclip:publisher-approvals:${snapshotHash}`,
      capturedAt:validClock(this.clock()).toISOString(),
      approvals:publicApprovals,
    };
  },

  async resolvePublisherCredentialReference(input = {}) {
    assertExactKeys(input, ['accountRef', 'platform', 'purpose'], 'Publisher 凭据请求');
    const platform = publisherPlatform(input.platform);
    const purpose = publisherCapability(input.purpose);
    const accountRef = publisherReference(input.accountRef, 'Publisher accountRef 无效。');
    const context = await this.publisherRunContextForConnector();
    if (purpose !== context.controllerCapability) {
      throw new Error('Publisher 当前控制器不能读取另一类 connector 凭据。');
    }
    const approval = uniquePublisherApproval(
      await this.publisherConnectorApprovals(context),
      { platform, capability:purpose, accountRef },
    );
    if (!PUBLISHER_SECRET_KEY.test(String(approval.secretKey || ''))) {
      throw new Error('Publisher connector 批准没有绑定可按 Run 读取的 Paperclip Secret key。');
    }
    let response;
    try {
      response = await this.request(
        `/api/agents/me/secrets/${encodeURIComponent(approval.secretKey)}/value`,
        {
          method:'POST',
          runId:context.credential.runId,
          apiKey:context.credential.apiKey,
        },
      );
    } catch {
      throw new Error('Paperclip 未向当前 Publisher Run 提供已批准的账号凭据。');
    }
    return parsePublisherCredential(response?.value);
  },

  async verifyPublisherAccountIdentity(input = {}) {
    assertExactKeys(
      input,
      ['platform', 'accountRef', 'providerIdentity'],
      'Publisher 账号身份核验请求',
    );
    const platform = publisherPlatform(input.platform);
    const accountRef = publisherReference(input.accountRef, 'Publisher accountRef 无效。');
    const identity = publisherIdentity(input.providerIdentity);
    const context = await this.publisherRunContextForConnector();
    const approvals = (await this.publisherConnectorApprovals(context)).filter(
      (approval) => (
        approval.platform === platform
        && approval.accountRef === accountRef
        && approval.capability === context.controllerCapability
      ),
    );
    if (approvals.length === 0 || approvals.some(
      (approval) => !samePublisherIdentity(approval.providerIdentity, identity),
    )) {
      throw new Error('Paperclip 无法确认 Publisher accountRef 与平台账号身份一致。');
    }
    return {
      verified:true,
      platform,
      accountRef,
      providerIdentity:identity,
      verificationRef:`paperclip:approval:${approvals[0].id}:account-identity`,
    };
  },

  async assertPublisherCampaignBudget(input = {}) {
    assertExactKeys(
      input,
      ['campaignId', 'connectorMode', 'operation', 'checkedAt'],
      'Publisher 预算请求',
    );
    const campaignId = publisherReference(input.campaignId, 'Publisher Campaign 标识无效。');
    const connectorMode = String(input.connectorMode || '');
    const operation = String(input.operation || '');
    if (
      !PUBLISHER_CONNECTOR_MODE.test(connectorMode)
      || !PUBLISHER_BUDGET_OPERATIONS.has(operation)
    ) {
      throw new Error('Publisher connector 模式或预算操作无效。');
    }
    validClock(input.checkedAt);
    const context = await this.publisherRunContextForConnector(campaignId);
    if (operation !== context.controllerCapability) {
      throw new Error('Publisher 预算操作与当前控制器能力不一致。');
    }
    const overview = await this.request(
      `/api/companies/${encodeURIComponent(context.credential.companyId)}/budgets/overview`,
      {
        runId:context.credential.runId,
        apiKey:context.credential.apiKey,
      },
    );
    const scopes = [
      ['company', context.credential.companyId],
      ['agent', context.credential.agentId],
      ['project', context.projectId],
    ];
    const policies = Array.isArray(overview?.policies) ? overview.policies : [];
    const matched = scopes.map(([scopeType, scopeId]) => {
      const rows = policies.filter((policy) => (
        policy?.scopeType === scopeType
        && policy?.scopeId === scopeId
        && policy?.metric === 'billed_cents'
        && policy?.isActive !== false
      ));
      if (rows.length !== 1 || rows[0]?.hardStopEnabled !== true) {
        throw new Error(`Paperclip ${scopeType} Publisher 预算没有唯一硬停策略。`);
      }
      const remainingAmount = Number(rows[0].remainingAmount);
      if (!Number.isFinite(remainingAmount) || remainingAmount < 0) {
        throw new Error(`Paperclip ${scopeType} Publisher 剩余预算无效。`);
      }
      return { ...rows[0], remainingAmount };
    });
    const projectPolicy = matched.find((policy) => policy.scopeType === 'project');
    if (
      !Number.isInteger(Number(projectPolicy?.amount))
      || Number(projectPolicy.amount) !== Number(context.campaignGrant.budgetCents)
    ) {
      throw new Error('Paperclip Project 预算与 CampaignGrant 不一致。');
    }
    const allowed = matched.every((policy) => (
      policy.paused !== true
      && ['ok', 'warning'].includes(policy.status)
      && policy.remainingAmount >= 1
    ));
    return {
      campaignId,
      allowed,
      hardStopEnabled:true,
      remainingAmountUsd:Math.min(...matched.map((policy) => policy.remainingAmount)) / 100,
    };
  },

  async recordPublisherConnectorAttempt(input = {}) {
    assertExactKeys(input, [
      'costRecordId',
      'campaignId',
      'connectorMode',
      'operation',
      'providerRequestId',
      'receiptRef',
      'amountUsd',
      'occurredAt',
    ], 'Publisher 费用记录');
    const costRecordId = publisherReference(input.costRecordId, 'Publisher 费用幂等标识无效。');
    const campaignId = publisherReference(input.campaignId, 'Publisher Campaign 标识无效。');
    const connectorMode = String(input.connectorMode || '');
    const operation = String(input.operation || '');
    const amountUsd = Number(input.amountUsd);
    const occurredAt = validClock(input.occurredAt).toISOString();
    if (
      !PUBLISHER_CONNECTOR_MODE.test(connectorMode)
      || !/^[a-z][a-z0-9_]{1,63}$/.test(operation)
      || !Number.isFinite(amountUsd)
      || amountUsd < 0
      || amountUsd > 10_000
      || (input.providerRequestId ? 1 : 0) + (input.receiptRef ? 1 : 0) !== 1
    ) {
      throw new Error('Publisher 费用来源、金额或唯一回执引用无效。');
    }
    const sourceRef = publisherReference(
      input.providerRequestId || input.receiptRef,
      'Publisher 费用来源引用无效。',
    );
    const context = await this.publisherRunContextForConnector(campaignId);
    if (!PUBLISHER_COST_OPERATIONS[context.controllerCapability]?.has(operation)) {
      throw new Error('Publisher 费用步骤与当前控制器能力不一致。');
    }
    const canonical = {
      schemaVersion:PUBLISHER_COST_RECORD_SCHEMA,
      costRecordId,
      campaignId,
      connectorMode,
      operation,
      sourceRef,
      amountUsd,
      occurredAt,
    };
    const existing = publisherCostRecord(
      context.targetCase.fields?.m5PublisherCostRecords?.[costRecordId],
    );
    if (existing) {
      if (!samePublisherCost(existing, canonical)) {
        throw new Error('Publisher 费用幂等标识与已有 Paperclip 记录冲突。');
      }
      if (existing.state !== 'reported' || !UUID.test(String(existing.costEventId || ''))) {
        throw new Error('Publisher 费用上报状态未决，禁止自动重试。');
      }
      return { reportRef:`paperclip:cost-event:${existing.costEventId}` };
    }
    let targetCase = await this.patchPublisherCostRecord(context, canonical, {
      state:'submitting',
      claimedAt:validClock(this.clock()).toISOString(),
    });
    let created;
    try {
      created = await this.request(
        `/api/companies/${encodeURIComponent(context.credential.companyId)}/cost-events`,
        {
          method:'POST',
          runId:context.credential.runId,
          apiKey:context.credential.apiKey,
          body:{
            agentId:context.credential.agentId,
            issueId:context.credential.issueId,
            projectId:context.projectId,
            heartbeatRunId:context.credential.runId,
            provider:connectorMode === 'real:douyin_official_api' ? 'douyin' : 'agent-army.local-cua',
            biller:connectorMode === 'real:douyin_official_api' ? 'douyin' : 'agent-army',
            billingType:connectorMode === 'real:douyin_official_api' ? 'metered_api' : 'fixed',
            billingCode:`m5:publisher:${operation}`,
            model:connectorMode,
            inputTokens:0,
            cachedInputTokens:0,
            outputTokens:0,
            costCents:Math.round(amountUsd * 100),
            occurredAt,
          },
        },
      );
    } catch {
      throw new Error('Publisher 费用提交结果未确认，Paperclip 记录保持 submitting。');
    }
    if (
      !UUID.test(String(created?.id || ''))
      || created.agentId !== context.credential.agentId
      || created.projectId !== context.projectId
      || created.heartbeatRunId !== context.credential.runId
      || created.costCents !== Math.round(amountUsd * 100)
    ) {
      throw new Error('Paperclip Publisher 费用回执与提交上下文不一致。');
    }
    targetCase = await this.patchPublisherCostRecord(
      { ...context, targetCase },
      canonical,
      {
        state:'reported',
        costEventId:created.id,
        reportedAt:validClock(this.clock()).toISOString(),
      },
    );
    const confirmed = publisherCostRecord(
      targetCase.fields?.m5PublisherCostRecords?.[costRecordId],
    );
    if (confirmed?.state !== 'reported' || confirmed.costEventId !== created.id) {
      throw new Error('Publisher 费用事件没有在 Paperclip Case 中回读确认。');
    }
    return { reportRef:`paperclip:cost-event:${created.id}` };
  },

  async patchPublisherCostRecord(context, canonical, patch) {
    const records = boundedRecordMap(
      context.targetCase.fields?.m5PublisherCostRecords,
      canonical.costRecordId,
      { ...canonical, ...patch },
    );
    return normalizeM5Case(await this.patchPipelineCaseFields(
      context.targetCase.id,
      {
        expectedVersion:integerVersion(context.targetCase.version),
        runId:context.credential.runId,
        fields:{
          ...context.targetCase.fields,
          m5PublisherCostRecords:records,
        },
      },
    ));
  },

  async publisherAuthorizationContext(input = {}) {
    assertExactKeys(
      input,
      ['action', 'runId', 'issueId', 'campaignId', 'agentId', 'authorizationId'],
      'Publisher 授权请求',
    );
    const action = String(input.action || '');
    const expectedRole = PUBLISHER_ACTION_ROLES[action];
    if (!expectedRole) throw new Error('Publisher action 不属于批准的系统控制器动作。');
    const credential = await this.currentPublisherRunCredential();
    for (const field of ['runId', 'issueId', 'agentId']) {
      if (input[field] !== credential[field]) {
        throw new Error('Publisher 请求与当前 Paperclip Run 身份不一致。');
      }
    }
    publisherReference(input.campaignId, 'Publisher Campaign 标识无效。');
    assertPublisherAuthorizationId(input, credential);
    const verified = await this.verifySystemAssignment({
      issueId:credential.issueId,
      runId:credential.runId,
      paperclipAgentId:credential.agentId,
      systemRole:expectedRole,
    });
    if (verified.issue.companyId !== credential.companyId) {
      throw new Error('Publisher 当前 Run 的公司身份与 Paperclip Issue 不一致。');
    }
    return this.publisherCampaignContext({
      credential,
      issue:verified.issue,
      campaignId:input.campaignId,
      expectedStage:PUBLISHER_ACTION_STAGES[action],
    });
  },

  async publisherRunContextForConnector(campaignId = null) {
    const credential = await this.currentPublisherRunCredential();
    const roles = Object.values(PUBLISHER_ACTION_ROLES);
    let verified = null;
    for (const systemRole of [...new Set(roles)]) {
      try {
        verified = await this.verifySystemAssignment({
          issueId:credential.issueId,
          runId:credential.runId,
          paperclipAgentId:credential.agentId,
          systemRole,
        });
        break;
      } catch {
        // 只接受两个固定 Publisher 系统控制器之一；都不匹配时统一失败。
      }
    }
    if (!verified || verified.issue.companyId !== credential.companyId) {
      throw new Error('当前 Paperclip Run 不属于 Publisher 或 Metrics 系统控制器。');
    }
    const expectedStage = verified.systemRole === 'm5-publisher-controller' ? 'publish' : 'metrics';
    const context = await this.publisherCampaignContext({
      credential,
      issue:verified.issue,
      campaignId,
      expectedStage,
    });
    return {
      ...context,
      controllerCapability:verified.systemRole === 'm5-publisher-controller'
        ? 'publish'
        : 'read_own_metrics',
    };
  },

  async publisherCampaignContext({ credential, issue, campaignId, expectedStage }) {
    const targetCaseId = publisherIssueCaseId(issue);
    await this.assertCaseIssueLink(targetCaseId, credential.issueId);
    const targetDetail = await this.getPipelineCase(targetCaseId);
    const targetCase = normalizeM5Case(targetDetail);
    if (targetCase.stageKey !== expectedStage || !targetCase.parentCaseId) {
      throw new Error(`Publisher 当前 Case 不在 ${expectedStage} 阶段。`);
    }
    const dayCase = normalizeM5Case(await this.getPipelineCase(targetCase.parentCaseId));
    if (!dayCase.parentCaseId) throw new Error('Publisher 日期 Case 缺少活动父 Case。');
    const campaignCase = normalizeM5Case(await this.getPipelineCase(dayCase.parentCaseId));
    const canonicalCampaignId = String(campaignCase.id || '');
    if (
      campaignCase.parentCaseId
      || campaignCase.stageKey !== 'campaign_active'
      || (campaignId && canonicalCampaignId !== campaignId)
      || targetCase.pipelineId !== dayCase.pipelineId
      || targetCase.pipelineId !== campaignCase.pipelineId
    ) {
      throw new Error('Publisher Case 不属于当前 active Campaign。');
    }
    const campaignGrant = campaignCase.fields?.campaignGrant;
    const now = validClock(this.clock()).getTime();
    const startsAt = Date.parse(campaignGrant?.startsAt);
    const expiresAt = Date.parse(campaignGrant?.expiresAt);
    if (
      campaignGrant?.status !== 'active'
      || !Number.isFinite(startsAt)
      || !Number.isFinite(expiresAt)
      || startsAt > now
      || expiresAt <= now
    ) {
      throw new Error('Publisher CampaignGrant 未激活或已经过期。');
    }
    const projectId = m5CaseProjectId(targetDetail, targetCase)
      || m5CaseProjectId({}, campaignCase);
    if (!UUID.test(projectId)) throw new Error('Publisher Campaign 缺少可信 Paperclip Project。');
    return {
      credential,
      issue,
      targetCase,
      dayCase,
      campaignCase,
      campaignGrant:structuredClone(campaignGrant),
      projectId,
    };
  },

  async publisherConnectorApprovals(context) {
    const payload = await this.request(
      `/api/companies/${encodeURIComponent(context.credential.companyId)}/approvals`,
      {
        runId:context.credential.runId,
        apiKey:context.credential.apiKey,
      },
    );
    const approvals = Array.isArray(payload) ? payload : Array.isArray(payload?.items) ? payload.items : [];
    const now = validClock(this.clock()).getTime();
    const grant = context.campaignGrant;
    return approvals
      .filter((approval) => approval?.status === 'approved')
      .map((approval) => normalizePublisherConnectorApproval(approval))
      .filter(Boolean)
      .filter((approval) => (
        approval.campaignId === context.campaignCase.id
        && Date.parse(approval.expiresAt) > now
        && approval.accountRef === grant.accountRefs?.[approval.platform]
        && grant.platforms?.includes(approval.platform)
        && (
          approval.capability === 'publish'
            ? grant.allowedActions?.includes('schedule_or_publish')
            : grant.allowedActions?.includes('read_own_metrics')
        )
      ));
  },

  async currentPublisherRunCredential() {
    if (typeof this.publisherRunCredentialProvider !== 'function') {
      throw new Error('Publisher 缺少当前 Paperclip Run 凭据提供器。');
    }
    let value;
    try {
      value = await this.publisherRunCredentialProvider();
    } catch {
      throw new Error('Publisher 当前 Paperclip Run 凭据不可用。');
    }
    const credential = value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : {};
    for (const field of ['runId', 'issueId', 'agentId', 'companyId']) {
      if (!UUID.test(String(credential[field] || ''))) {
        throw new Error('Publisher 当前 Paperclip Run 身份结构无效。');
      }
    }
    if (!String(credential.apiKey || '').trim()) {
      throw new Error('Publisher 当前 Paperclip Run JWT 缺失。');
    }
    return Object.freeze({
      apiKey:String(credential.apiKey).trim(),
      runId:credential.runId,
      issueId:credential.issueId,
      agentId:credential.agentId,
      companyId:credential.companyId,
      ...(UUID.test(String(credential.approvalId || ''))
        ? { approvalId:credential.approvalId }
        : {}),
    });
  }
};

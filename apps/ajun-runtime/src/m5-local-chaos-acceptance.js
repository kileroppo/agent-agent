import {
  FakePaperclipAdapter,
  assertReviewDecision,
  buildBootstrapPlan,
  buildCampaignCaseBatch,
  buildParallelWorkCaseBatch,
  defaultDefinition,
  ingestCampaignCaseBatch,
  ingestParallelWorkCaseBatch,
  validateDefinition,
} from '@agent-army/m5-content-pipeline';
import {
  FakePlatformConnector,
  MemoryPublisherRepository,
  PublisherGateway,
} from '@agent-army/m5-publisher-gateway';
import {
  PaperclipPublisherController,
  trustedPublishInputs,
} from './paperclip-publisher-controller.js';
import {
  PaperclipMetricMonitorHandler,
} from './paperclip-metric-monitor.js';
import {
  M5StageRecoveryController,
} from './m5-stage-recovery-controller.js';
import {
  getM5RoutineExecutionContract,
} from '@agent-army/m5-kernel/routine-execution-contract';

const PIPELINE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '12121212-1212-4121-8121-121212121212';
const COMPANY_ID = '22222222-2222-4222-8222-222222222222';
const PUBLISHER_AGENT_ID = '33333333-3333-4333-8333-333333333333';
const METRIC_AGENT_ID = '44444444-4444-4444-8444-444444444444';
const CREATOR_AGENT_ID = '55555555-5555-4555-8555-555555555555';
const RECOVERY_ISSUE_ID = '66666666-6666-4666-8666-666666666666';
const PUBLISH_ISSUE_ID = '77777777-7777-4777-8777-777777777777';
const METRIC_ISSUE_ID = '88888888-8888-4888-8888-888888888888';
const RECOVERY_RUN_ID = '99999999-9999-4999-8999-999999999999';
const RECOVERY_RESTART_RUN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PUBLISH_RUN_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const METRIC_RUN_IDS = Object.freeze([
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
]);
const CAMPAIGN_KEY = 'm5-local-chaos';
const SCHEDULED_DATE = '2026-07-30';
const PUBLISHED_AT = '2026-07-30T02:00:00.000Z';
const HOUR_MS = 3_600_000;
const CONTENT_CHECKSUM = `sha256:${'a'.repeat(64)}`;
const RENDER_HASH = `sha256:${'b'.repeat(64)}`;

export async function runM5LocalChaosAcceptance() {
  const definition = validateDefinition(defaultDefinition);
  const pipelinePlan = buildBootstrapPlan(definition);
  const declaredTransitions = pipelinePlan.resources.pipeline.transitions;
  const adapter = new FakePaperclipAdapter({
    pipelines:[{
      id:PIPELINE_ID,
      key:definition.key,
      ...structuredClone(pipelinePlan.resources.pipeline.payload),
      transitions:structuredClone(declaredTransitions),
    }],
    agents:[
      systemAgent(PUBLISHER_AGENT_ID, 'm5-publisher-controller'),
      systemAgent(METRIC_AGENT_ID, 'm5-metrics-controller'),
      {
        id:CREATOR_AGENT_ID,
        companyId:COMPANY_ID,
        status:'idle',
        metadata:{ agentArmyId:'content-creator' },
      },
    ],
  });
  adapter.state.issues = [];
  adapter.state.runs = [];
  adapter.state.caseEvents = [];

  const campaignBatch = buildCampaignCaseBatch({
    campaignId:CAMPAIGN_KEY,
    startDate:SCHEDULED_DATE,
    themes:[
      '本地 Agent 执行证据',
      '多岗位协作',
      '恢复与重试',
      '预算硬停',
      '内容审核',
      '发布幂等',
      '指标复盘',
    ],
  });
  const campaignCases = await ingestCampaignCaseBatch(adapter, PIPELINE_ID, campaignBatch);
  const campaignCase = campaignCases.parent;
  const dayCase = campaignCases.days[0];
  const platformCase = campaignCases.platformCases.find(
    (item) => item.fields.platform === 'douyin'
      && item.fields.scheduledDate === SCHEDULED_DATE,
  );
  if (!platformCase) throw new Error('本地 chaos 验收未生成目标平台 Case。');

  const grant = campaignGrant();
  await adapter.patchCaseFields(campaignCase.id, campaignCase.version, {
    ...campaignCase.fields,
    campaignGrant:grant,
    dailyCronEnabled:true,
  });
  await transitionByDeclaredPlan(
    adapter,
    campaignCase.id,
    'campaign_active',
    declaredTransitions,
  );

  const governance = new LocalChaosPaperclipGovernance(adapter);
  const caseJourney = [{
    sequence:1,
    caseId:platformCase.id,
    fromStage:null,
    toStage:'draft',
    reason:'ingested',
  }];
  const move = createJourneyMover(
    adapter,
    platformCase.id,
    caseJourney,
    declaredTransitions,
  );
  await move('campaign_active', 'campaign_grant_approved');
  await move('topic', 'topic_selected');
  await move('parallel_join_gate', 'parallel_work_opened');

  const parallelBatch = buildParallelWorkCaseBatch({
    campaignId:CAMPAIGN_KEY,
    scheduledDate:SCHEDULED_DATE,
  });
  const parallelCases = await ingestParallelWorkCaseBatch(
    adapter,
    PIPELINE_ID,
    parallelBatch,
    await adapter.getCase(dayCase.id),
  );
  const parallel = await executeParallelFixture(adapter, parallelCases);

  await move('script', 'parallel_inputs_ready');
  await move('parallel_join_gate', 'master_script_ready');
  await move('render', 'all_parallel_outputs_reverified');
  await move('machine_review', 'first_render_ready');
  const requestChangesTo = assertReviewDecision(
    definition,
    'machine_review',
    'request_changes',
  );
  await adapter.reviewCase(platformCase.id, {
    decision:'request_changes',
    reason:'本地 chaos：字幕证据需回到脚本修订。',
  });
  await move(requestChangesTo, 'request_changes');

  await move('parallel_join_gate', 'revised_script_requires_join_recheck');
  await move('render', 'join_reverified');
  const recovery = await exerciseSafeRetryAndRestart({
    adapter,
    governance,
    platformCaseId:platformCase.id,
  });

  await move('machine_review', 'recovered_render_verified');
  await adapter.reviewCase(platformCase.id, {
    decision:'approve',
    reason:'恢复后机器审核通过。',
  });
  const platformAdaptStage = assertReviewDecision(
    definition,
    'machine_review',
    'approve',
  );
  await move(platformAdaptStage, 'machine_review_approved');

  addWorkProduct(adapter, platformCase.id, contentVersionWorkProduct());
  addWorkProduct(adapter, platformCase.id, machineReviewWorkProduct());
  await move('publish_approval', 'platform_version_ready');
  await adapter.reviewCase(platformCase.id, {
    decision:'approve',
    reason:'本地 fake 发布范围与预算恢复动作已核验。',
  });
  const publishStage = assertReviewDecision(definition, 'publish_approval', 'approve');
  await move(publishStage, 'publish_approval_granted');

  let currentTime = new Date(PUBLISHED_AT);
  const clock = () => new Date(currentTime);
  const paperclipControl = new LocalChaosPublisherControl({
    adapter,
    campaignId:campaignCase.id,
  });
  const costRecorder = new ToggleBudgetCostRecorder(campaignCase.id);
  const repository = new MemoryPublisherRepository();
  const douyin = new FakePlatformConnector('douyin', [{
    type:'success',
    publishedAt:PUBLISHED_AT,
  }]);
  const gateway = new PublisherGateway({
    repository,
    connectors:{
      douyin,
      xiaohongshu:new FakePlatformConnector('xiaohongshu'),
    },
    artifactVerifier:{
      async verify(relativePath, checksum) {
        if (relativePath !== 'campaign/day/douyin.mp4' || checksum !== CONTENT_CHECKSUM) {
          throw new Error('本地 chaos 发布产物身份漂移。');
        }
        return { relativePath, checksum, bytes:1024 };
      },
    },
    paperclipControl,
    costRecorder,
    mode:'fake',
    clock,
  });
  const publisher = {
    publish:(request, _authorizationContext) => gateway.publish(request),
    collectMetricSnapshot:(input, authorizationContext) => gateway.collectMetricSnapshot({
      ...input,
      campaignId:authorizationContext.campaignId,
    }),
    getAttempt:(key) => gateway.getAttempt(key),
  };

  const publishInputs = trustedPublishInputs({
    outputs:await governance.getPipelineCaseOutputs(platformCase.id),
    targetCase:await governance.getPipelineCase(platformCase.id),
    campaignCase:await governance.getPipelineCase(campaignCase.id),
    grant,
    executionTime:currentTime,
  });
  let budgetErrorCode = null;
  try {
    await gateway.publish(publishInputs.request);
  } catch (error) {
    budgetErrorCode = String(error?.code || 'unknown');
  }
  const connectorCallsBeforeResume = douyin.publishCalls.length;
  costRecorder.resume();
  let resumeWithoutGrantErrorCode = null;
  try {
    await gateway.publish(publishInputs.request);
  } catch (error) {
    resumeWithoutGrantErrorCode = String(error?.code || 'unknown');
  }
  const connectorCallsBeforeGrantResume = douyin.publishCalls.length;
  const pausedCampaign = structuredClone(await adapter.getCase(campaignCase.id));
  await paperclipControl.resumeCampaignGrant();
  const resumedCampaign = structuredClone(await adapter.getCase(campaignCase.id));

  governance.addIssue({
    id:PUBLISH_ISSUE_ID,
    caseId:platformCase.id,
    status:'in_progress',
    assigneeAgentId:PUBLISHER_AGENT_ID,
    description:`[agent-army:m5:routine:m5-publish] 本地 chaos；当前 Case 为 ${platformCase.id}，版本为 1。`,
  });
  governance.startRun({
    issueId:PUBLISH_ISSUE_ID,
    runId:PUBLISH_RUN_ID,
    agentId:PUBLISHER_AGENT_ID,
    status:'running',
  });
  const publisherController = new PaperclipPublisherController({
    governance,
    publisher,
    now:clock,
  });
  const publishResult = await publisherController.handle({
    runId:PUBLISH_RUN_ID,
    agentId:PUBLISHER_AGENT_ID,
    context:{ taskId:PUBLISH_ISSUE_ID },
  });
  const controllerReplay = await publisherController.handle({
    runId:PUBLISH_RUN_ID,
    agentId:PUBLISHER_AGENT_ID,
    context:{ taskId:PUBLISH_ISSUE_ID },
  });
  const gatewayReplay = await gateway.publish(publishInputs.request);

  await move('verify', 'publish_receipt_verified');
  await move('metrics', 'published_content_verified');

  governance.addIssue({
    id:METRIC_ISSUE_ID,
    caseId:platformCase.id,
    status:'in_progress',
    assigneeAgentId:METRIC_AGENT_ID,
    description:`[agent-army:m5:routine:m5-metrics] 本地 chaos；当前 Case 为 ${platformCase.id}，版本为 1。`,
    executionPolicy:{ mode:'normal', commentRequired:true, stages:[] },
  });
  const metrics = await exerciseMetricCheckpoints({
    governance,
    publisher,
    connector:douyin,
    platformCaseId:platformCase.id,
    setTime:(value) => {
      currentTime = new Date(value);
    },
    clock,
  });

  await move('retrospective', 'three_metric_snapshots_persisted');
  await move('done', 'local_chaos_acceptance_complete');

  const declaredSuccessStages = definition.stages
    .filter((stage) => stage.kind !== 'cancelled' && stage.key !== 'learning')
    .map((stage) => stage.key);
  const traversedStages = new Set(caseJourney.map((item) => item.toStage));
  const assertions = [
    assertion('definition_16_stages', definition.stages.length === 16),
    assertion(
      'success_path_to_done',
      declaredSuccessStages.every((stage) => traversedStages.has(stage))
        && caseJourney.at(-1)?.toStage === 'done'
        && caseJourney.slice(1).every((item) => item.declaredTransition === true),
    ),
    assertion(
      'cancelled_is_alternative_only',
      definition.stages.some((stage) => stage.key === 'cancelled' && stage.kind === 'cancelled')
        && !traversedStages.has('cancelled'),
    ),
    assertion(
      'parallel_max_4',
      parallel.declaredMaxConcurrency === 4
        && parallel.observedMaxConcurrency === 4
        && parallel.observedMaxConcurrency <= 4
        && parallel.barrierEvidence.every((item) =>
          item.arrived === item.waveSize
          && item.completedBeforeRelease === 0,
        ),
    ),
    assertion(
      'single_safe_retry_and_restart_resume',
      recovery.safeRetryCount === 1
        && recovery.reusedVerifiedWorkProduct
        && recovery.workProductCountBeforeRestart === recovery.workProductCountAfterRestart,
    ),
    assertion('single_request_changes', caseJourney.filter(
      (item) => item.reason === 'request_changes',
    ).length === 1),
    assertion(
      'single_budget_hard_stop',
      budgetErrorCode === 'publisher_budget_exceeded'
        && paperclipControl.pauseCalls.length === 1
        && connectorCallsBeforeResume === 0
        && pausedCampaign.fields.campaignGrant.status === 'paused'
        && pausedCampaign.fields.dailyCronEnabled === false
        && resumeWithoutGrantErrorCode === 'campaign_not_active'
        && connectorCallsBeforeGrantResume === 0
        && resumedCampaign.fields.campaignGrant.status === 'active'
        && resumedCampaign.fields.dailyCronEnabled === true,
    ),
    assertion(
      'fake_publish_idempotent',
      publishResult.receipt.receiptId === gatewayReplay.receipt.receiptId
        && gatewayReplay.replayed === true
        && controllerReplay.replayed === true
        && douyin.publishCalls.length === 1,
    ),
    assertion(
      'three_metric_snapshots',
      metrics.snapshots.length === 3
        && metrics.connectorCalls === 3
        && metrics.duplicateCollections === 0,
    ),
  ];

  const ledger = {
    schemaVersion:'agent.army/m5-local-chaos-acceptance/v1',
    mode:'local_fake_only',
    externalEffects:false,
    paidCalls:0,
    generatedAt:clock().toISOString(),
    scope:{
      campaignCaseId:campaignCase.id,
      dayCaseId:dayCase.id,
      platformCaseId:platformCase.id,
      scheduledDate:SCHEDULED_DATE,
      platform:'douyin',
      contentVersionId:'content-v1',
    },
    definition:{
      declaredStageCount:definition.stages.length,
      stageKeys:definition.stages.map((stage) => stage.key),
      successfulPath:declaredSuccessStages,
      successTerminal:'done',
      alternativeTerminal:'cancelled',
      declaredTransitionCount:declaredTransitions.length,
      allJourneyEdgesDeclared:caseJourney.slice(1).every(
        (item) => item.declaredTransition === true,
      ),
    },
    caseJourney,
    parallel,
    recovery,
    review:{
      requestChanges:{
        fromStage:'machine_review',
        toStage:requestChangesTo,
        count:caseJourney.filter((item) => item.reason === 'request_changes').length,
      },
      finalApprovalPassed:true,
    },
    budget:{
      hardStopCount:paperclipControl.pauseCalls.length,
      errorCode:budgetErrorCode,
      connectorCallsBeforeResume,
      grantStatusAfterStop:pausedCampaign.fields.campaignGrant.status,
      cronEnabledAfterStop:pausedCampaign.fields.dailyCronEnabled,
      resumeWithoutGrantErrorCode,
      connectorCallsBeforeGrantResume,
      grantStatusAfterResume:resumedCampaign.fields.campaignGrant.status,
      cronEnabledAfterResume:resumedCampaign.fields.dailyCronEnabled,
      resumed:paperclipControl.resumeCount === 1 && costRecorder.resumeCount === 1,
    },
    publisher:{
      connectorMode:'fake',
      receiptId:publishResult.receipt.receiptId,
      externalContentId:publishResult.receipt.externalContentId,
      connectorCalls:douyin.publishCalls.length,
      controllerReplay:controllerReplay.replayed === true,
      replayed:gatewayReplay.replayed === true,
      sameReceipt:publishResult.receipt.receiptId === gatewayReplay.receipt.receiptId,
    },
    metrics,
    assertions,
    passed:assertions.every((item) => item.passed),
  };
  const security = inspectM5LocalLedgerSafety(ledger);
  if (!security.passed) {
    throw new Error(`M5 本地 chaos ledger 安全审计失败：${security.violations.join('；')}`);
  }
  return {
    ...ledger,
    security,
  };
}

class LocalChaosPaperclipGovernance {
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
      run:{ id:run.runId, status:run.status, agentId:run.agentId, companyId:COMPANY_ID },
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

class LocalChaosPublisherControl {
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
    const pausedAt = String(input.requestedAt || PUBLISHED_AT);
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
        resumedAt:PUBLISHED_AT,
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

class ToggleBudgetCostRecorder {
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

async function exerciseSafeRetryAndRestart({
  adapter,
  governance,
  platformCaseId,
}) {
  const contract = getM5RoutineExecutionContract('m5-render');
  governance.addIssue({
    id:RECOVERY_ISSUE_ID,
    caseId:platformCaseId,
    status:'in_progress',
    assigneeAgentId:CREATOR_AGENT_ID,
    description:'本地 chaos render 恢复任务。',
  });
  governance.startRun({
    issueId:RECOVERY_ISSUE_ID,
    runId:RECOVERY_RUN_ID,
    agentId:CREATOR_AGENT_ID,
    status:'failed',
  });
  const assignment = {
    issueId:RECOVERY_ISSUE_ID,
    runId:RECOVERY_RUN_ID,
    pipelineCaseId:platformCaseId,
    projectId:PROJECT_ID,
    routineKey:'m5-render',
    agentId:'content-creator',
  };
  const firstController = new M5StageRecoveryController({
    governance,
    workProductValidator:validateLocalChaosRenderWorkProduct,
    now:() => new Date(PUBLISHED_AT),
  });
  const first = await firstController.handleFailure({
    assignment,
    contract,
    summary:'本地 chaos：首次 render 校验失败。',
  });
  addWorkProduct(
    adapter,
    platformCaseId,
    buildM5LocalChaosRenderWorkProductFixture(contract, platformCaseId),
  );
  const beforeRestart = workProducts(adapter, platformCaseId)
    .filter((item) => item.metadata?.kind === contract.expectedWorkProduct.type).length;

  governance.setIssueStatus(RECOVERY_ISSUE_ID, 'in_progress');
  governance.startRun({
    issueId:RECOVERY_ISSUE_ID,
    runId:RECOVERY_RESTART_RUN_ID,
    agentId:CREATOR_AGENT_ID,
    status:'failed',
  });
  const restartedController = new M5StageRecoveryController({
    governance,
    workProductValidator:validateLocalChaosRenderWorkProduct,
    now:() => new Date(PUBLISHED_AT),
  });
  const resumed = await restartedController.handleFailure({
    assignment:{ ...assignment, runId:RECOVERY_RESTART_RUN_ID },
    contract,
    summary:'本地 chaos：进程重启后从 Paperclip 检查点恢复。',
  });
  const afterRestart = workProducts(adapter, platformCaseId)
    .filter((item) => item.metadata?.kind === contract.expectedWorkProduct.type).length;
  return {
    safeRetryCount:first.action === 'retry' ? 1 : 0,
    retryAction:first.action,
    restartCount:1,
    restartAction:resumed.action,
    reusedVerifiedWorkProduct:resumed.action === 'verified_work_product' && resumed.replayed === true,
    workProductCountBeforeRestart:beforeRestart,
    workProductCountAfterRestart:afterRestart,
  };
}

async function exerciseMetricCheckpoints({
  governance,
  publisher,
  connector,
  platformCaseId,
  setTime,
  clock,
}) {
  const checkpoints = [
    { label:'2h', offsetMs:2 * HOUR_MS, runId:METRIC_RUN_IDS[0] },
    { label:'24h', offsetMs:24 * HOUR_MS, runId:METRIC_RUN_IDS[1] },
    { label:'72h', offsetMs:72 * HOUR_MS, runId:METRIC_RUN_IDS[3] },
  ];
  let handler = null;
  for (const [index, checkpoint] of checkpoints.entries()) {
    setTime(new Date(Date.parse(PUBLISHED_AT) + checkpoint.offsetMs));
    governance.startRun({
      issueId:METRIC_ISSUE_ID,
      runId:checkpoint.runId,
      agentId:METRIC_AGENT_ID,
      status:'running',
    });
    if (index === 0 || index === 1) {
      handler = new PaperclipMetricMonitorHandler({ governance, publisher, now:clock });
    }
    await handler.handle({
      runId:checkpoint.runId,
      agentId:METRIC_AGENT_ID,
      context:{ taskId:METRIC_ISSUE_ID },
    });
    if (checkpoint.label === '24h') {
      governance.startRun({
        issueId:METRIC_ISSUE_ID,
        runId:METRIC_RUN_IDS[2],
        agentId:METRIC_AGENT_ID,
        status:'running',
      });
      await handler.handle({
        runId:METRIC_RUN_IDS[2],
        agentId:METRIC_AGENT_ID,
        context:{ taskId:METRIC_ISSUE_ID },
      });
    }
  }
  const snapshots = workProducts(governance.adapter, platformCaseId)
    .filter((item) => item.metadata?.schemaVersion === 'agent.army/metric-snapshot/v1')
    .map((item) => ({
      checkpoint:item.metadata.checkpoint,
      snapshotId:item.metadata.snapshot.snapshotId,
      collectedAt:item.metadata.snapshot.collectedAt,
      metrics:structuredClone(item.metadata.snapshot.metrics),
    }));
  return {
    snapshots,
    connectorCalls:connector.metricCalls.length,
    restartCount:1,
    duplicateCollections:connector.metricCalls.length - snapshots.length,
  };
}

async function executeParallelFixture(adapter, parallelCases) {
  let active = 0;
  let observedMaxConcurrency = 0;
  const waves = [];
  const barrierEvidence = [];
  const maxConcurrency = parallelCases.maxConcurrency;
  for (let index = 0; index < parallelCases.branches.length; index += maxConcurrency) {
    const wave = parallelCases.branches.slice(index, index + maxConcurrency);
    waves.push(wave.length);
    let completed = 0;
    const barrier = createArrivalBarrier(wave.length, () => completed);
    await Promise.all(wave.map(async (branch) => {
      active += 1;
      observedMaxConcurrency = Math.max(observedMaxConcurrency, active);
      try {
        await barrier.wait();
        const current = await adapter.getCase(branch.id);
        await adapter.patchCaseFields(branch.id, current.version, {
          ...current.fields,
          verifiedWorkProduct:{
            kind:current.fields.workBranch.requiredWorkProduct,
            verified:true,
          },
        });
        await transitionUntracked(adapter, branch.id, 'done');
        completed += 1;
      } finally {
        active -= 1;
      }
    }));
    barrierEvidence.push(barrier.evidence());
  }
  await transitionUntracked(adapter, parallelCases.join.id, 'done');
  return {
    branchCount:parallelCases.branches.length,
    declaredMaxConcurrency:maxConcurrency,
    observedMaxConcurrency,
    waves,
    barrierEvidence,
    allBranchesVerified:parallelCases.branches.every((branch) => {
      const stored = adapter.state.cases.find((item) => item.id === branch.id);
      return stored?.stageKey === 'done' && stored.fields?.verifiedWorkProduct?.verified === true;
    }),
  };
}

function createArrivalBarrier(expected, completedCount) {
  let arrived = 0;
  let completedBeforeRelease = null;
  let release;
  const released = new Promise((resolve) => {
    release = resolve;
  });
  return {
    async wait() {
      arrived += 1;
      if (arrived === expected) {
        completedBeforeRelease = completedCount();
        release();
      }
      await released;
    },
    evidence() {
      return {
        waveSize:expected,
        arrived,
        completedBeforeRelease,
      };
    },
  };
}

function createJourneyMover(adapter, caseId, journey, declaredTransitions) {
  return async (toStage, reason) => {
    const current = await adapter.getCase(caseId);
    const fromStage = current.stageKey;
    const edge = await transitionByDeclaredPlan(
      adapter,
      caseId,
      toStage,
      declaredTransitions,
      reason,
    );
    journey.push({
      sequence:journey.length + 1,
      caseId,
      fromStage,
      toStage,
      reason,
      declaredTransition:true,
      declarationLabel:edge.label,
    });
  };
}

async function transitionByDeclaredPlan(
  adapter,
  caseId,
  toStageKey,
  expectedTransitions,
  reason = null,
) {
  const current = await adapter.getCase(caseId);
  if (!current) throw new Error(`M5 本地 chaos Case 不存在：${caseId}`);
  const pipeline = adapter.state.pipelines.find((item) => item.id === current.pipelineId);
  if (!pipeline?.enforceTransitions) {
    throw new Error('M5 本地 chaos Pipeline 未启用 enforceTransitions。');
  }
  assertTransitionTablesEqual(pipeline.transitions, expectedTransitions);
  const edge = assertM5DeclaredTransition(
    pipeline.transitions,
    current.stageKey,
    toStageKey,
  );
  await adapter.transitionCase(caseId, {
    expectedVersion:current.version,
    toStageKey,
    reason,
  });
  return edge;
}

async function transitionUntracked(adapter, caseId, toStageKey) {
  const current = await adapter.getCase(caseId);
  return adapter.transitionCase(caseId, {
    expectedVersion:current.version,
    toStageKey,
    force:true,
  });
}

function addWorkProduct(adapter, caseId, product) {
  const item = adapter.state.cases.find((entry) => entry.id === caseId);
  if (!item) throw new Error(`本地 chaos Case 不存在：${caseId}`);
  item.workProducts ??= [];
  item.workProducts.push(structuredClone(product));
}

function workProducts(adapter, caseId) {
  return adapter.state.cases.find((item) => item.id === caseId)?.workProducts || [];
}

export function assertM5DeclaredTransition(transitions, fromStageKey, toStageKey) {
  if (!Array.isArray(transitions)) {
    throw new Error('M5 正式 Pipeline transition 表缺失。');
  }
  const edge = transitions.find((item) =>
    item?.fromStageKey === fromStageKey
    && item?.toStageKey === toStageKey,
  );
  if (!edge) {
    throw new Error(
      `M5 正式 Pipeline 未声明 transition：${fromStageKey}->${toStageKey}。`,
    );
  }
  return structuredClone(edge);
}

function assertTransitionTablesEqual(actual, expected) {
  const canonical = (items) => JSON.stringify((items || []).map((item) => ({
    fromStageKey:item.fromStageKey,
    toStageKey:item.toStageKey,
    label:item.label,
  })));
  if (canonical(actual) !== canonical(expected)) {
    throw new Error('M5 本地 chaos Pipeline transition 表与正式 Bootstrap plan 不一致。');
  }
}

export function inspectM5LocalLedgerSafety(value) {
  const violations = [];
  let checkedNodes = 0;
  const sensitiveKey = /(?:^|[_-])(?:authorization|cookie|token|secret|password|api[_-]?key)(?:$|[_-])/i;
  const credentialValue = /(?:bearer\s+[a-z0-9._~+/=-]+|(?:^|[^a-z0-9])sk-[a-z0-9_-]{8,})/i;
  const absolutePath = /(?:^|[\s"'=:])\/(?:Users|home|private|tmp|var|opt|etc)(?:\/|$)|(?:^|[\s"'=:])[a-z]:\\(?:Users|Windows|Program Files)(?:\\|$)/i;
  const visit = (item, path) => {
    checkedNodes += 1;
    if (typeof item === 'string') {
      if (credentialValue.test(item)) violations.push(`${path}:credential_value`);
      if (absolutePath.test(item)) violations.push(`${path}:absolute_path`);
      return;
    }
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      const childPath = `${path}.${key}`;
      if (sensitiveKey.test(key)) violations.push(`${childPath}:credential_field`);
      visit(child, childPath);
    }
  };
  visit(value, '$');
  return {
    passed:violations.length === 0,
    checkedNodes,
    credentialFields:violations.filter((item) => item.endsWith(':credential_field')).length,
    credentialValues:violations.filter((item) => item.endsWith(':credential_value')).length,
    absolutePaths:violations.filter((item) => item.endsWith(':absolute_path')).length,
    violations,
  };
}

export function buildM5LocalChaosRenderWorkProductFixture(contract, targetCaseId) {
  return {
    id:'work-product:render-package',
    kind:'work_product',
    type:'artifact',
    provider:'agent-army.ajun-runtime',
    externalId:RENDER_HASH,
    sourceTrust:null,
    status:'active',
    healthStatus:'healthy',
    metadata:{
      schemaVersion:contract.expectedWorkProduct.schemaVersion,
      kind:contract.expectedWorkProduct.type,
      stageKey:contract.stageKey,
      sourceTaskId:'local-chaos-render-task',
      sourceArtifactId:'local-chaos-render-artifact',
      artifactHash:RENDER_HASH,
      projectId:PROJECT_ID,
      targetCaseId,
      artifact:{
        relativePath:'campaign/day/master.mp4',
        checksum:RENDER_HASH,
        bytes:2048,
      },
    },
  };
}

export async function validateLocalChaosRenderWorkProduct({
  contract,
  product,
  targetCaseId,
  projectId,
  assignment,
  paperclipRuns,
} = {}) {
  const expected = buildM5LocalChaosRenderWorkProductFixture(contract, targetCaseId);
  const currentRun = Array.isArray(paperclipRuns)
    ? paperclipRuns.find((item) =>
      item?.id === assignment?.runId
      && item?.status === 'failed'
      && item?.agentId === CREATOR_AGENT_ID,
    )
    : null;
  const valid = contract?.routineKey === 'm5-render'
    && contract?.stageKey === 'render'
    && contract?.expectedWorkProduct?.type === 'RenderPackage'
    && targetCaseId
    && assignment?.issueId === RECOVERY_ISSUE_ID
    && assignment?.pipelineCaseId === targetCaseId
    && assignment?.projectId === PROJECT_ID
    && assignment?.routineKey === 'm5-render'
    && assignment?.agentId === 'content-creator'
    && projectId === PROJECT_ID
    && currentRun
    && JSON.stringify(product) === JSON.stringify(expected);
  if (!valid) {
    throw new Error('local_chaos_render_work_product_drift');
  }
  return {
    verified:true,
    workProductId:product.id,
    targetCaseId,
    projectId,
  };
}

function contentVersionWorkProduct() {
  return {
    id:'work-product:content-version',
    kind:'work_product',
    type:'artifact',
    provider:'agent-army.content-autonomy',
    sourceTrust:null,
    status:'active',
    healthStatus:'healthy',
    metadata:{
      schemaVersion:'agent.army/content-version/v1',
      kind:'ContentVersion',
      contentVersion:{
        platform:'douyin',
        contentVersionId:'content-v1',
        checksum:CONTENT_CHECKSUM,
        mediaPath:'campaign/day/douyin.mp4',
        title:'AI Agent 本地恢复实战',
        body:'只使用本地 Fake 控制面验证恢复、预算、发布与指标闭环。',
        tags:['AI Agent', '本地验收'],
      },
    },
  };
}

function machineReviewWorkProduct() {
  return {
    id:'work-product:machine-review',
    kind:'work_product',
    type:'artifact',
    provider:'agent-army.content-autonomy',
    sourceTrust:null,
    status:'approved',
    healthStatus:'healthy',
    metadata:{
      schemaVersion:'agent.army/machine-review/v1',
      kind:'MachineReview',
      reviewReport:{
        status:'passed',
        contentVersionId:'content-v1',
        checks:{
          facts:true,
          privacy:true,
          rights:true,
          media:true,
          claims:true,
          grantScope:true,
          duplicate:true,
        },
      },
    },
  };
}

function campaignGrant() {
  return {
    schemaVersion:'agent.army/campaign-grant/v1',
    status:'active',
    platforms:['douyin', 'xiaohongshu'],
    accountRefs:{
      douyin:'account:douyin:local-chaos',
      xiaohongshu:'account:xhs:local-chaos',
    },
    startsAt:'2026-07-29T00:00:00.000Z',
    expiresAt:'2026-08-06T00:00:00.000Z',
    themeScope:'AI Agent 实战',
    totalPublishLimit:14,
    dailyPublishLimitPerPlatform:1,
    allowedActions:['upload', 'fill_metadata', 'schedule_or_publish', 'read_own_metrics'],
    prohibitedActions:[
      'direct_message',
      'comment',
      'follow',
      'paid_promotion',
      'payment',
      'account_settings',
      'delete_history',
    ],
    budgetCents:625,
  };
}

function systemAgent(id, role) {
  return {
    id,
    companyId:COMPANY_ID,
    status:'idle',
    metadata:{ agentArmySystemRole:role },
  };
}

function assertion(id, passed) {
  return { id, passed:passed === true };
}

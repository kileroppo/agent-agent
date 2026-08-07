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
  LocalChaosPaperclipGovernance,
  LocalChaosPublisherControl,
  ToggleBudgetCostRecorder,
} from './m5-local-chaos-adapters.js';
import {
  LOCAL_CHAOS_FIXTURE,
  addWorkProduct,
  campaignGrant,
  contentVersionWorkProduct,
  machineReviewWorkProduct,
  systemAgent,
} from './m5-local-chaos-fixtures.js';
import {
  createJourneyMover,
  executeParallelFixture,
  exerciseMetricCheckpoints,
  exerciseSafeRetryAndRestart,
  transitionByDeclaredPlan,
} from './m5-local-chaos-journey.js';
import { buildM5LocalChaosLedger } from './m5-local-chaos-ledger.js';

export {
  buildM5LocalChaosRenderWorkProductFixture,
  validateLocalChaosRenderWorkProduct,
} from './m5-local-chaos-fixtures.js';
export { assertM5DeclaredTransition } from './m5-local-chaos-journey.js';
export { inspectM5LocalLedgerSafety } from './m5-local-chaos-ledger.js';

export async function runM5LocalChaosAcceptance() {
  const fixture = LOCAL_CHAOS_FIXTURE;
  const definition = validateDefinition(defaultDefinition);
  const pipelinePlan = buildBootstrapPlan(definition);
  const declaredTransitions = pipelinePlan.resources.pipeline.transitions;
  const adapter = new FakePaperclipAdapter({
    pipelines:[{
      id:fixture.pipelineId,
      key:definition.key,
      ...structuredClone(pipelinePlan.resources.pipeline.payload),
      transitions:structuredClone(declaredTransitions),
    }],
    agents:[
      systemAgent(fixture.publisherAgentId, 'm5-publisher-controller'),
      systemAgent(fixture.metricAgentId, 'm5-metrics-controller'),
      {
        id:fixture.creatorAgentId,
        companyId:fixture.companyId,
        status:'idle',
        metadata:{ agentArmyId:'content-creator' },
      },
    ],
  });
  adapter.state.issues = [];
  adapter.state.runs = [];
  adapter.state.caseEvents = [];

  const campaignBatch = buildCampaignCaseBatch({
    campaignId:fixture.campaignKey,
    startDate:fixture.scheduledDate,
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
  const campaignCases = await ingestCampaignCaseBatch(
    adapter,
    fixture.pipelineId,
    campaignBatch,
  );
  const campaignCase = campaignCases.parent;
  const dayCase = campaignCases.days[0];
  const platformCase = campaignCases.platformCases.find(
    (item) => item.fields.platform === 'douyin'
      && item.fields.scheduledDate === fixture.scheduledDate,
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
    campaignId:fixture.campaignKey,
    scheduledDate:fixture.scheduledDate,
  });
  const parallelCases = await ingestParallelWorkCaseBatch(
    adapter,
    fixture.pipelineId,
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

  let currentTime = new Date(fixture.publishedAt);
  const clock = () => new Date(currentTime);
  const paperclipControl = new LocalChaosPublisherControl({
    adapter,
    campaignId:campaignCase.id,
  });
  const costRecorder = new ToggleBudgetCostRecorder(campaignCase.id);
  const repository = new MemoryPublisherRepository();
  const douyin = new FakePlatformConnector('douyin', [{
    type:'success',
    publishedAt:fixture.publishedAt,
  }]);
  const gateway = new PublisherGateway({
    repository,
    connectors:{
      douyin,
      xiaohongshu:new FakePlatformConnector('xiaohongshu'),
    },
    artifactVerifier:{
      async verify(relativePath, checksum) {
        if (
          relativePath !== 'campaign/day/douyin.mp4'
          || checksum !== fixture.contentChecksum
        ) {
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
    id:fixture.publishIssueId,
    caseId:platformCase.id,
    status:'in_progress',
    assigneeAgentId:fixture.publisherAgentId,
    description:`[agent-army:m5:routine:m5-publish] 本地 chaos；当前 Case 为 ${platformCase.id}，版本为 1。`,
  });
  governance.startRun({
    issueId:fixture.publishIssueId,
    runId:fixture.publishRunId,
    agentId:fixture.publisherAgentId,
    status:'running',
  });
  const publisherController = new PaperclipPublisherController({
    governance,
    publisher,
    now:clock,
  });
  const publishResult = await publisherController.handle({
    runId:fixture.publishRunId,
    agentId:fixture.publisherAgentId,
    context:{ taskId:fixture.publishIssueId },
  });
  const controllerReplay = await publisherController.handle({
    runId:fixture.publishRunId,
    agentId:fixture.publisherAgentId,
    context:{ taskId:fixture.publishIssueId },
  });
  const gatewayReplay = await gateway.publish(publishInputs.request);

  await move('verify', 'publish_receipt_verified');
  await move('metrics', 'published_content_verified');

  governance.addIssue({
    id:fixture.metricIssueId,
    caseId:platformCase.id,
    status:'in_progress',
    assigneeAgentId:fixture.metricAgentId,
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

  return buildM5LocalChaosLedger({
    definition,
    declaredTransitions,
    campaignCase,
    dayCase,
    platformCase,
    caseJourney,
    requestChangesTo,
    parallel,
    recovery,
    paperclipControl,
    costRecorder,
    budgetErrorCode,
    connectorCallsBeforeResume,
    pausedCampaign,
    resumeWithoutGrantErrorCode,
    connectorCallsBeforeGrantResume,
    resumedCampaign,
    publishResult,
    controllerReplay,
    gatewayReplay,
    douyin,
    metrics,
    clock,
  });
}

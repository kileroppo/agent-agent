import { FakePaperclipAdapter, assertReviewDecision, buildBootstrapPlan, buildCampaignCaseBatch, buildParallelWorkCaseBatch, defaultDefinition, ingestCampaignCaseBatch, ingestParallelWorkCaseBatch, validateDefinition, } from '@agent-army/m5-content-pipeline';
import { FakePlatformConnector, MemoryPublisherRepository, PublisherGateway, } from '@agent-army/m5-publisher-gateway';
import { PaperclipPublisherController, trustedPublishInputs, } from './paperclip-publisher-controller.ts';
import { LocalChaosPaperclipGovernance, LocalChaosPublisherControl, ToggleBudgetCostRecorder, } from './m5-local-chaos-adapters.ts';
import { LOCAL_CHAOS_FIXTURE, addWorkProduct, campaignGrant, contentVersionWorkProduct, machineReviewWorkProduct, systemAgent, } from './m5-local-chaos-fixtures.ts';
import { createJourneyMover, executeParallelFixture, exerciseMetricCheckpoints, exerciseSafeRetryAndRestart, transitionByDeclaredPlan, } from './m5-local-chaos-journey.ts';
import { buildM5LocalChaosLedger } from './m5-local-chaos-ledger.ts';
export { buildM5LocalChaosRenderWorkProductFixture, validateLocalChaosRenderWorkProduct, } from './m5-local-chaos-fixtures.ts';
export { assertM5DeclaredTransition } from './m5-local-chaos-journey.ts';
export { inspectM5LocalLedgerSafety } from './m5-local-chaos-ledger.ts';
export async function runM5LocalChaosAcceptance(): Promise<any> {
    const fixture: any = LOCAL_CHAOS_FIXTURE;
    const definition: any = validateDefinition(defaultDefinition);
    const pipelinePlan: any = buildBootstrapPlan(definition);
    const declaredTransitions: any = pipelinePlan.resources.pipeline.transitions;
    const adapter: any = new FakePaperclipAdapter({
        pipelines: [{
                id: fixture.pipelineId,
                key: definition.key,
                ...structuredClone(pipelinePlan.resources.pipeline.payload),
                transitions: structuredClone(declaredTransitions),
            }],
        agents: [
            systemAgent(fixture.publisherAgentId, 'm5-publisher-controller'),
            systemAgent(fixture.metricAgentId, 'm5-metrics-controller'),
            {
                id: fixture.creatorAgentId,
                companyId: fixture.companyId,
                status: 'idle',
                metadata: { agentArmyId: 'content-creator' },
            },
        ],
    });
    adapter.state.issues = [];
    adapter.state.runs = [];
    adapter.state.caseEvents = [];
    const campaignBatch: any = buildCampaignCaseBatch({
        campaignId: fixture.campaignKey,
        startDate: fixture.scheduledDate,
        themes: [
            '本地 Agent 执行证据',
            '多岗位协作',
            '恢复与重试',
            '预算硬停',
            '内容审核',
            '发布幂等',
            '指标复盘',
        ],
    });
    const campaignCases: any = await ingestCampaignCaseBatch(adapter, fixture.pipelineId, campaignBatch);
    const campaignCase: any = campaignCases.parent;
    const dayCase: any = campaignCases.days[0];
    const platformCase: any = campaignCases.platformCases.find((item: any): any => item.fields.platform === 'douyin'
        && item.fields.scheduledDate === fixture.scheduledDate);
    if (!platformCase)
        throw new Error('本地 chaos 验收未生成目标平台 Case。');
    const grant: any = campaignGrant();
    await adapter.patchCaseFields(campaignCase.id, campaignCase.version, {
        ...campaignCase.fields,
        campaignGrant: grant,
        dailyCronEnabled: true,
    });
    await transitionByDeclaredPlan(adapter, campaignCase.id, 'campaign_active', declaredTransitions);
    const governance: any = new LocalChaosPaperclipGovernance(adapter);
    const caseJourney: any[] = [{
            sequence: 1,
            caseId: platformCase.id,
            fromStage: null,
            toStage: 'draft',
            reason: 'ingested',
        }];
    const move: any = createJourneyMover(adapter, platformCase.id, caseJourney, declaredTransitions);
    await move('campaign_active', 'campaign_grant_approved');
    await move('topic', 'topic_selected');
    await move('parallel_join_gate', 'parallel_work_opened');
    const parallelBatch: any = buildParallelWorkCaseBatch({
        campaignId: fixture.campaignKey,
        scheduledDate: fixture.scheduledDate,
    });
    const parallelCases: any = await ingestParallelWorkCaseBatch(adapter, fixture.pipelineId, parallelBatch, await adapter.getCase(dayCase.id));
    const parallel: any = await executeParallelFixture(adapter, parallelCases);
    await move('script', 'parallel_inputs_ready');
    await move('parallel_join_gate', 'master_script_ready');
    await move('render', 'all_parallel_outputs_reverified');
    await move('machine_review', 'first_render_ready');
    const requestChangesTo: any = assertReviewDecision(definition, 'machine_review', 'request_changes');
    await adapter.reviewCase(platformCase.id, {
        decision: 'request_changes',
        reason: '本地 chaos：字幕证据需回到脚本修订。',
    });
    await move(requestChangesTo, 'request_changes');
    await move('parallel_join_gate', 'revised_script_requires_join_recheck');
    await move('render', 'join_reverified');
    const recovery: any = await exerciseSafeRetryAndRestart({
        adapter,
        governance,
        platformCaseId: platformCase.id,
    });
    await move('machine_review', 'recovered_render_verified');
    await adapter.reviewCase(platformCase.id, {
        decision: 'approve',
        reason: '恢复后机器审核通过。',
    });
    const platformAdaptStage: any = assertReviewDecision(definition, 'machine_review', 'approve');
    await move(platformAdaptStage, 'machine_review_approved');
    addWorkProduct(adapter, platformCase.id, contentVersionWorkProduct());
    addWorkProduct(adapter, platformCase.id, machineReviewWorkProduct());
    await move('publish_approval', 'platform_version_ready');
    await adapter.reviewCase(platformCase.id, {
        decision: 'approve',
        reason: '本地 fake 发布范围与预算恢复动作已核验。',
    });
    const publishStage: any = assertReviewDecision(definition, 'publish_approval', 'approve');
    await move(publishStage, 'publish_approval_granted');
    let currentTime: any = new Date(fixture.publishedAt);
    const clock: any = (): any => new Date(currentTime);
    const paperclipControl: any = new LocalChaosPublisherControl({
        adapter,
        campaignId: campaignCase.id,
    });
    const costRecorder: any = new ToggleBudgetCostRecorder(campaignCase.id);
    const repository: any = new MemoryPublisherRepository();
    const douyin: any = new FakePlatformConnector('douyin', [{
            type: 'success',
            publishedAt: fixture.publishedAt,
        }]);
    const gateway: any = new PublisherGateway({
        repository,
        connectors: {
            douyin,
            xiaohongshu: new FakePlatformConnector('xiaohongshu'),
        },
        artifactVerifier: {
            async verify(relativePath: any, checksum: any): Promise<any> {
                if (relativePath !== 'campaign/day/douyin.mp4'
                    || checksum !== fixture.contentChecksum) {
                    throw new Error('本地 chaos 发布产物身份漂移。');
                }
                return { relativePath, checksum, bytes: 1024 };
            },
        },
        paperclipControl,
        costRecorder,
        mode: 'fake',
        clock,
    });
    const publisher: Record<string, any> = {
        publish: (request: any, _authorizationContext: any): any => gateway.publish(request),
        collectMetricSnapshot: (input: any, authorizationContext: any): any => gateway.collectMetricSnapshot({
            ...input,
            campaignId: authorizationContext.campaignId,
        }),
        getAttempt: (key: any): any => gateway.getAttempt(key),
    };
    const publishInputs: any = trustedPublishInputs({
        outputs: await governance.getPipelineCaseOutputs(platformCase.id),
        targetCase: await governance.getPipelineCase(platformCase.id),
        campaignCase: await governance.getPipelineCase(campaignCase.id),
        grant,
        executionTime: currentTime,
    });
    let budgetErrorCode: any = null;
    try {
        await gateway.publish(publishInputs.request);
    }
    catch (error: any) {
        budgetErrorCode = String(error?.code || 'unknown');
    }
    const connectorCallsBeforeResume: any = douyin.publishCalls.length;
    costRecorder.resume();
    let resumeWithoutGrantErrorCode: any = null;
    try {
        await gateway.publish(publishInputs.request);
    }
    catch (error: any) {
        resumeWithoutGrantErrorCode = String(error?.code || 'unknown');
    }
    const connectorCallsBeforeGrantResume: any = douyin.publishCalls.length;
    const pausedCampaign: any = structuredClone(await adapter.getCase(campaignCase.id));
    await paperclipControl.resumeCampaignGrant();
    const resumedCampaign: any = structuredClone(await adapter.getCase(campaignCase.id));
    governance.addIssue({
        id: fixture.publishIssueId,
        caseId: platformCase.id,
        status: 'in_progress',
        assigneeAgentId: fixture.publisherAgentId,
        description: `[agent-army:m5:routine:m5-publish] 本地 chaos；当前 Case 为 ${platformCase.id}，版本为 1。`,
    });
    governance.startRun({
        issueId: fixture.publishIssueId,
        runId: fixture.publishRunId,
        agentId: fixture.publisherAgentId,
        status: 'running',
    });
    const publisherController: any = new PaperclipPublisherController({
        governance,
        publisher,
        now: clock,
    });
    const publishResult: any = await publisherController.handle({
        runId: fixture.publishRunId,
        agentId: fixture.publisherAgentId,
        context: { taskId: fixture.publishIssueId },
    });
    const controllerReplay: any = await publisherController.handle({
        runId: fixture.publishRunId,
        agentId: fixture.publisherAgentId,
        context: { taskId: fixture.publishIssueId },
    });
    const gatewayReplay: any = await gateway.publish(publishInputs.request);
    await move('verify', 'publish_receipt_verified');
    await move('metrics', 'published_content_verified');
    governance.addIssue({
        id: fixture.metricIssueId,
        caseId: platformCase.id,
        status: 'in_progress',
        assigneeAgentId: fixture.metricAgentId,
        description: `[agent-army:m5:routine:m5-metrics] 本地 chaos；当前 Case 为 ${platformCase.id}，版本为 1。`,
        executionPolicy: { mode: 'normal', commentRequired: true, stages: [] },
    });
    const metrics: any = await exerciseMetricCheckpoints({
        governance,
        publisher,
        connector: douyin,
        platformCaseId: platformCase.id,
        setTime: (value: any): any => {
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

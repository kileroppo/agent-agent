export const LOCAL_CHAOS_FIXTURE: any = Object.freeze({
    pipelineId: '11111111-1111-4111-8111-111111111111',
    projectId: '12121212-1212-4121-8121-121212121212',
    companyId: '22222222-2222-4222-8222-222222222222',
    publisherAgentId: '33333333-3333-4333-8333-333333333333',
    metricAgentId: '44444444-4444-4444-8444-444444444444',
    creatorAgentId: '55555555-5555-4555-8555-555555555555',
    recoveryIssueId: '66666666-6666-4666-8666-666666666666',
    publishIssueId: '77777777-7777-4777-8777-777777777777',
    metricIssueId: '88888888-8888-4888-8888-888888888888',
    recoveryRunId: '99999999-9999-4999-8999-999999999999',
    recoveryRestartRunId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    publishRunId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    metricRunIds: Object.freeze([
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        'ffffffff-ffff-4fff-8fff-ffffffffffff',
    ]),
    campaignKey: 'm5-local-chaos',
    scheduledDate: '2026-07-30',
    publishedAt: '2026-07-30T02:00:00.000Z',
    contentChecksum: `sha256:${'a'.repeat(64)}`,
    renderHash: `sha256:${'b'.repeat(64)}`,
});
export function buildM5LocalChaosRenderWorkProductFixture(contract: any, targetCaseId: any): any {
    const fixture: any = LOCAL_CHAOS_FIXTURE;
    return {
        id: 'work-product:render-package',
        kind: 'work_product',
        type: 'artifact',
        provider: 'agent-army.ajun-runtime',
        externalId: fixture.renderHash,
        sourceTrust: null,
        status: 'active',
        healthStatus: 'healthy',
        metadata: {
            schemaVersion: contract.expectedWorkProduct.schemaVersion,
            kind: contract.expectedWorkProduct.type,
            stageKey: contract.stageKey,
            sourceTaskId: 'local-chaos-render-task',
            sourceArtifactId: 'local-chaos-render-artifact',
            artifactHash: fixture.renderHash,
            projectId: fixture.projectId,
            targetCaseId,
            artifact: {
                relativePath: 'campaign/day/master.mp4',
                checksum: fixture.renderHash,
                bytes: 2048,
            },
        },
    };
}
export async function validateLocalChaosRenderWorkProduct({ contract, product, targetCaseId, projectId, assignment, paperclipRuns, }: any = {}): Promise<any> {
    const fixture: any = LOCAL_CHAOS_FIXTURE;
    const expected: any = buildM5LocalChaosRenderWorkProductFixture(contract, targetCaseId);
    const currentRun: any = Array.isArray(paperclipRuns)
        ? paperclipRuns.find((item: any): any => item?.id === assignment?.runId
            && item?.status === 'failed'
            && item?.agentId === fixture.creatorAgentId)
        : null;
    const valid: any = contract?.routineKey === 'm5-render'
        && contract?.stageKey === 'render'
        && contract?.expectedWorkProduct?.type === 'RenderPackage'
        && targetCaseId
        && assignment?.issueId === fixture.recoveryIssueId
        && assignment?.pipelineCaseId === targetCaseId
        && assignment?.projectId === fixture.projectId
        && assignment?.routineKey === 'm5-render'
        && assignment?.agentId === 'content-creator'
        && projectId === fixture.projectId
        && currentRun
        && JSON.stringify(product) === JSON.stringify(expected);
    if (!valid)
        throw new Error('local_chaos_render_work_product_drift');
    return {
        verified: true,
        workProductId: product.id,
        targetCaseId,
        projectId,
    };
}
export function contentVersionWorkProduct(): any {
    return {
        id: 'work-product:content-version',
        kind: 'work_product',
        type: 'artifact',
        provider: 'agent-army.content-autonomy',
        sourceTrust: null,
        status: 'active',
        healthStatus: 'healthy',
        metadata: {
            schemaVersion: 'agent.army/content-version/v1',
            kind: 'ContentVersion',
            contentVersion: {
                platform: 'douyin',
                contentVersionId: 'content-v1',
                checksum: LOCAL_CHAOS_FIXTURE.contentChecksum,
                mediaPath: 'campaign/day/douyin.mp4',
                title: 'AI Agent 本地恢复实战',
                body: '只使用本地 Fake 控制面验证恢复、预算、发布与指标闭环。',
                tags: ['AI Agent', '本地验收'],
            },
        },
    };
}
export function machineReviewWorkProduct(): any {
    return {
        id: 'work-product:machine-review',
        kind: 'work_product',
        type: 'artifact',
        provider: 'agent-army.content-autonomy',
        sourceTrust: null,
        status: 'approved',
        healthStatus: 'healthy',
        metadata: {
            schemaVersion: 'agent.army/machine-review/v1',
            kind: 'MachineReview',
            reviewReport: {
                status: 'passed',
                contentVersionId: 'content-v1',
                checks: {
                    facts: true,
                    privacy: true,
                    rights: true,
                    media: true,
                    claims: true,
                    grantScope: true,
                    duplicate: true,
                },
            },
        },
    };
}
export function campaignGrant(): any {
    return {
        schemaVersion: 'agent.army/campaign-grant/v1',
        status: 'active',
        platforms: ['douyin', 'xiaohongshu'],
        accountRefs: {
            douyin: 'account:douyin:local-chaos',
            xiaohongshu: 'account:xhs:local-chaos',
        },
        startsAt: '2026-07-29T00:00:00.000Z',
        expiresAt: '2026-08-06T00:00:00.000Z',
        themeScope: 'AI Agent 实战',
        totalPublishLimit: 14,
        dailyPublishLimitPerPlatform: 1,
        allowedActions: ['upload', 'fill_metadata', 'schedule_or_publish', 'read_own_metrics'],
        prohibitedActions: [
            'direct_message',
            'comment',
            'follow',
            'paid_promotion',
            'payment',
            'account_settings',
            'delete_history',
        ],
        budgetCents: 625,
    };
}
export function systemAgent(id: any, role: any): any {
    return {
        id,
        companyId: LOCAL_CHAOS_FIXTURE.companyId,
        status: 'idle',
        metadata: { agentArmySystemRole: role },
    };
}
export function addWorkProduct(adapter: any, caseId: any, product: any): any {
    const item: any = adapter.state.cases.find((entry: any): any => entry.id === caseId);
    if (!item)
        throw new Error(`本地 chaos Case 不存在：${caseId}`);
    item.workProducts ??= [];
    item.workProducts.push(structuredClone(product));
}
export function workProducts(adapter: any, caseId: any): any {
    return adapter.state.cases.find((item: any): any => item.id === caseId)?.workProducts || [];
}

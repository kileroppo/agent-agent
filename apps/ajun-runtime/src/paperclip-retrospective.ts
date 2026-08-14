import crypto from 'node:crypto';
import { M5_PLATFORMS, M5_SCHEMA_IDS, summarizeComparableContentMetrics, } from '@agent-army/m5-contracts';
import { consumeM5SystemControllerPlanRevision, isRecoverableM5SystemControllerFailure, markM5SystemControllerFailure, recoverM5SystemControllerFailure, } from './m5-system-controller-recovery.ts';
import { CONTENT_PERFORMANCE_NEXT_ACTIONS, metricObservations, } from './local-content-growth.ts';
import { isValidM5WorkProductDate, trustedM5WorkProducts, uniqueTrustedM5WorkProduct, } from './m5-work-product-trust.ts';
const SYSTEM_ROLE: any = 'm5-retrospective-controller';
const ROUTINE_MARKER: any = '[agent-army:m5:routine:m5-retrospective]';
const METRIC_SCHEMA: any = M5_SCHEMA_IDS.METRIC_SNAPSHOT;
const RETROSPECTIVE_SCHEMA: any = M5_SCHEMA_IDS.RETROSPECTIVE;
const PUBLISHER_PROVIDER: any = 'agent-army.publisher-gateway';
const RETROSPECTIVE_PROVIDER: any = 'agent-army.m5-retrospective';
const MINIMUM_SAMPLE_COUNT: any = 5;
const FORBIDDEN_FIELDS: any = new Set([
    'caseId',
    'caseVersion',
    'platform',
    'sampleType',
    'metricSnapshotIds',
    'learningProposal',
    'templateVersion',
]);
export class PaperclipRetrospectiveHandler {
    governance: any;
    inFlightIssues: any;
    now: any;
    constructor({ governance, now = (): any => new Date() }: any = {}) {
        this.governance = governance;
        this.now = now;
        this.inFlightIssues = new Map();
    }
    async handle(payload: any): Promise<any> {
        assertNoRetrospectiveSelectionParameters(payload);
        const runId: any = String(payload?.runId || '').trim();
        const agentId: any = String(payload?.agentId || '').trim();
        const issueId: any = String(payload?.context?.taskId || '').trim();
        if (!runId || !agentId || !issueId) {
            throw new PaperclipRetrospectiveError('M5 复盘 heartbeat 缺少运行、控制器或任务标识。');
        }
        if (this.inFlightIssues.has(issueId))
            return this.inFlightIssues.get(issueId);
        const execution: any = this.executeIssue({ issueId, runId, agentId });
        this.inFlightIssues.set(issueId, execution);
        try {
            return await execution;
        }
        catch (error: any) {
            if (!isRecoverableM5SystemControllerFailure(error))
                throw error;
            try {
                return await recoverM5SystemControllerFailure({
                    governance: this.governance,
                    issueId,
                    runId,
                    agentId,
                    routineKey: 'm5-retrospective',
                    systemRole: SYSTEM_ROLE,
                    error,
                });
            }
            catch {
                throw error;
            }
        }
        finally {
            this.inFlightIssues.delete(issueId);
        }
    }
    async executeIssue({ issueId, runId, agentId }: any): Promise<any> {
        this.assertDependencies();
        const verified: any = await this.governance.verifySystemAssignment({
            issueId,
            runId,
            paperclipAgentId: agentId,
            systemRole: SYSTEM_ROLE,
        });
        const issue: any = verified.issue;
        if (issue.status === 'done') {
            return { accepted: true, skipped: true, issueId, reason: '复盘任务已完成。' };
        }
        if (!['in_progress', 'in_review'].includes(issue.status)) {
            throw new PaperclipRetrospectiveError('复盘任务必须处于 in_progress 或 in_review。');
        }
        if (!String(issue.description || '').includes(ROUTINE_MARKER)) {
            throw new PaperclipRetrospectiveError('HTTP 控制器只接受 M5 复盘 Routine 的固定任务。');
        }
        const { caseId, caseVersion } = retrospectiveCaseBinding(issue);
        await this.governance.assertCaseIssueLink(caseId, issueId);
        await consumeM5SystemControllerPlanRevision({
            governance: this.governance,
            pipelineCaseId: caseId,
            runId,
            routineKey: 'm5-retrospective',
            systemRole: SYSTEM_ROLE,
        });
        const currentCase: any = normalizeCase(await this.governance.getPipelineCase(caseId));
        const currentOutputs: any = await this.governance.getPipelineCaseOutputs(caseId);
        const existing: any = trustedRetrospectiveProduct(currentOutputs, caseId, caseVersion);
        if (existing) {
            const destination: any = retrospectiveDestination(existing.metadata.report.status);
            if (currentCase.stageKey === 'retrospective' && currentCase.version === caseVersion) {
                await this.governance.transitionPipelineCase(caseId, {
                    expectedVersion: caseVersion,
                    toStageKey: destination,
                }, { runId });
            }
            else if (currentCase.stageKey !== destination || currentCase.version !== caseVersion + 1) {
                throw new PaperclipRetrospectiveError('已有复盘版本与当前 Paperclip Case 状态不一致。');
            }
            await this.governance.completeRetrospectiveIssue(issueId, {
                runId,
                comment: `复用已写入的版本化复盘 Work Product ${existing.id}。`,
            });
            return {
                accepted: true,
                replayed: true,
                issueId,
                caseId,
                status: existing.metadata.report.status,
                sampleCount: Number(existing.metadata.report.sampleCount || 0),
                workProductId: existing.id,
            };
        }
        if (currentCase.id !== caseId
            || currentCase.stageKey !== 'retrospective'
            || currentCase.version !== caseVersion) {
            throw new PaperclipRetrospectiveError('复盘任务与当前 Paperclip Case 阶段或版本不一致。');
        }
        const platform: any = String(currentCase.fields?.platform || '').trim();
        if (!M5_PLATFORMS.includes(platform)) {
            throw new PaperclipRetrospectiveError('复盘 Case 缺少可信的平台类型。');
        }
        try {
            const outputs: any = await this.governance.getRetrospectiveMetricOutputs(caseId);
            const samples: any = trustedMetricSamples(outputs, platform);
            const report: any = buildRetrospectiveReport({ platform, samples });
            const generatedAt: any = validDate(this.now()).toISOString();
            const product: any = await this.governance.createIssueWorkProduct(issueId, {
                type: 'document',
                provider: RETROSPECTIVE_PROVIDER,
                externalId: retrospectiveExternalId(caseId, 1),
                title: 'M5 内容复盘 / v1',
                status: 'active',
                reviewState: 'none',
                isPrimary: true,
                healthStatus: 'healthy',
                summary: report.status === 'insufficient_sample'
                    ? `同类型真实内容样本 ${samples.length}/5，暂不生成改进建议。`
                    : `已基于 ${samples.length} 条同类型真实内容生成待审核建议。`,
                metadata: {
                    schemaVersion: RETROSPECTIVE_SCHEMA,
                    kind: 'Retrospective',
                    version: 1,
                    caseId,
                    sourceCaseVersion: caseVersion,
                    supersedesWorkProductId: null,
                    generatedAt,
                    report,
                },
                createdByRunId: runId,
            }, { runId });
            await this.governance.transitionPipelineCase(caseId, {
                expectedVersion: caseVersion,
                toStageKey: retrospectiveDestination(report.status),
            }, { runId });
            await this.governance.completeRetrospectiveIssue(issueId, {
                runId,
                comment: `已写入版本化复盘 Work Product ${product?.id || 'v1'}；状态 ${report.status}。`,
            });
            return {
                accepted: true,
                issueId,
                caseId,
                status: report.status,
                sampleCount: samples.length,
                workProductId: product?.id || null,
            };
        }
        catch (error: any) {
            throw markM5SystemControllerFailure(error);
        }
    }
    assertDependencies(): any {
        const required: any[] = [
            'verifySystemAssignment',
            'assertCaseIssueLink',
            'getPipelineCase',
            'getPipelineCaseOutputs',
            'getRetrospectiveMetricOutputs',
            'createIssueWorkProduct',
            'transitionPipelineCase',
            'completeRetrospectiveIssue',
        ];
        if (required.some((method: any): any => typeof this.governance?.[method] !== 'function')) {
            throw new PaperclipRetrospectiveError('M5 复盘控制器缺少 Paperclip Case/Issue/Run/Work Product 适配。');
        }
    }
}
export class PaperclipRetrospectiveError extends Error {
}
export function trustedMetricSamples(outputs: any, platform: any): any {
    const byContentVersion: any = new Map();
    for (const item of trustedM5WorkProducts(outputs, {
        type: 'artifact',
        provider: PUBLISHER_PROVIDER,
        schemaVersion: METRIC_SCHEMA,
        kind: 'MetricSnapshot',
        statuses: ['active'],
    })) {
        if (item?.metadata?.checkpoint !== '72h')
            continue;
        const snapshot: any = item.metadata.snapshot;
        if (!snapshot
            || snapshot.platform !== platform
            || !String(snapshot.snapshotId || '').trim()
            || !String(snapshot.contentVersionId || '').trim()
            || !isValidM5WorkProductDate(snapshot.collectedAt)
            || !snapshot.metrics
            || typeof snapshot.metrics !== 'object'
            || Array.isArray(snapshot.metrics))
            continue;
        const current: any = byContentVersion.get(snapshot.contentVersionId);
        if (!current || Date.parse(snapshot.collectedAt) > Date.parse(current.collectedAt)) {
            byContentVersion.set(snapshot.contentVersionId, structuredClone(snapshot));
        }
    }
    return [...byContentVersion.values()]
        .sort((left: any, right: any): any => left.collectedAt.localeCompare(right.collectedAt));
}
function buildRetrospectiveReport({ platform, samples }: any): any {
    const sampleType: any = `ai-agent-practice:${platform}`;
    const enoughSamples: any = samples.length >= MINIMUM_SAMPLE_COUNT;
    const observations: any = metricObservations(aggregateMetrics(samples));
    const comparableMetrics: any = summarizeComparableContentMetrics(samples.map((sample: any): any => sample.metrics));
    const metricSnapshotRefs: any = samples.map((item: any): any => item.snapshotId);
    return {
        status: enoughSamples ? 'proposal_ready' : 'insufficient_sample',
        sampleType,
        sampleCount: samples.length,
        minimumSampleCount: MINIMUM_SAMPLE_COUNT,
        metricSnapshotRefs,
        observations,
        comparisonScope: {
            platform,
            contentType: 'ai-agent-practice',
            checkpoint: '72h',
            comparableSampleCount: samples.length,
            statistics: ['median', 'p75'],
            crossPlatformRawRanking: false,
        },
        comparableMetrics,
        decision: enoughSamples ? 'repackage' : 'collect_more_samples',
        singleExperiment: enoughSamples ? {
            variable: '开场或第一屏结构',
            hypothesis: '保持主题和发布窗口不变，只调整开场证据顺序后，深度互动率可能高于同类中位数。',
            successCriterion: '同平台、同内容类型、同为72小时窗口的深度互动率高于本批样本中位数。',
            observationWindow: '发布后72小时',
        } : null,
        learningProposal: enoughSamples ? {
            schemaVersion: M5_SCHEMA_IDS.LEARNING_PROPOSAL,
            proposalId: `learning_${crypto.createHash('sha256').update(`${sampleType}:${metricSnapshotRefs.join(':')}`).digest('hex').slice(0, 24)}`,
            version: 1,
            status: 'proposed',
            sourceSampleType: sampleType,
            sourceSampleCount: samples.length,
            suggestedChanges: [...CONTENT_PERFORMANCE_NEXT_ACTIONS],
            singleExperimentRequired: true,
            templateLifecycle: {
                state: 'trial',
                reason: '达到五条同类型真实内容门槛；仍须离线回放、审核和单条灰度。',
            },
            offlineReplayRequired: true,
            reviewerApprovalRequired: true,
            grayReleaseLimit: 1,
            automaticProductionMutation: false,
        } : null,
        controls: {
            promptMutation: false,
            permissionExpansion: false,
            frequencyIncrease: false,
            paidPromotion: false,
        },
    };
}
function aggregateMetrics(samples: any): any {
    const values: any = new Map();
    for (const sample of samples) {
        for (const [key, value] of Object.entries(sample.metrics)) {
            const numeric: any = Number(value);
            if (!Number.isFinite(numeric))
                continue;
            const current: any = values.get(key) || [];
            current.push(numeric);
            values.set(key, current);
        }
    }
    return Object.fromEntries([...values.entries()].map(([key, entries]: any): any => [
        key,
        String(entries.reduce((total: any, value: any): any => total + value, 0) / entries.length),
    ]));
}
function retrospectiveCaseBinding(issue: any): any {
    const description: any = String(issue?.description || '');
    const caseId: any = description.match(/当前 Case 为 ([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/i)?.[1];
    const version: any = Number(description.match(/版本为 (\d+)/)?.[1]);
    if (!caseId || !Number.isInteger(version) || version <= 0) {
        throw new PaperclipRetrospectiveError('M5 复盘任务缺少固定 Case 与版本绑定。');
    }
    return { caseId, caseVersion: version };
}
function normalizeCase(value: any): any {
    const item: any = value?.case ?? value;
    return {
        ...item,
        stageKey: item?.stageKey ?? value?.stage?.key ?? item?.stage?.key ?? null,
    };
}
function trustedRetrospectiveProduct(outputs: any, caseId: any, caseVersion: any): any {
    return uniqueTrustedM5WorkProduct(outputs, {
        type: 'document',
        provider: RETROSPECTIVE_PROVIDER,
        schemaVersion: RETROSPECTIVE_SCHEMA,
        kind: 'Retrospective',
        statuses: ['active'],
    }, {
        matches: (item: any): any => item?.metadata?.version === 1
            && item?.metadata?.caseId === caseId
            && item?.metadata?.sourceCaseVersion === caseVersion
            && ['insufficient_sample', 'proposal_ready'].includes(item?.metadata?.report?.status),
        duplicateError: (): any => new PaperclipRetrospectiveError('当前 Case 存在多个同版本复盘 Work Product，拒绝猜测。'),
    });
}
function retrospectiveExternalId(caseId: any, version: any): any {
    return `retrospective_${crypto.createHash('sha256').update(`${caseId}:v${version}`).digest('hex').slice(0, 32)}`;
}
function retrospectiveDestination(status: any): any {
    return status === 'proposal_ready' ? 'learning' : 'done';
}
function validDate(value: any): any {
    const date: any = value instanceof Date ? new Date(value) : new Date(value);
    if (!Number.isFinite(date.getTime()))
        throw new PaperclipRetrospectiveError('复盘控制器时钟无效。');
    return date;
}
function assertNoRetrospectiveSelectionParameters(payload: any): any {
    const queue: any[] = [payload];
    while (queue.length) {
        const value: any = queue.pop();
        if (!value || typeof value !== 'object')
            continue;
        for (const [key, child] of Object.entries(value)) {
            if (FORBIDDEN_FIELDS.has(key)) {
                throw new PaperclipRetrospectiveError(`M5 复盘 heartbeat 不接受调用方指定 ${key}。`);
            }
            if (child && typeof child === 'object')
                queue.push(child);
        }
    }
}

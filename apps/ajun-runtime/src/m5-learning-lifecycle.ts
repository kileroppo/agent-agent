import crypto from 'node:crypto';
import { M5_PLATFORM_IDS, M5_SCHEMA_IDS, } from '@agent-army/m5-contracts';
import { validM5TemplateGuidance, } from './m5-production-template-resolver.ts';
import { m5WorkProductItems, uniqueTrustedM5WorkProduct, } from './m5-work-product-trust.ts';
import { M5LearningEvidence, M5LearningLifecycleError, } from './m5-learning-evidence.ts';
export { M5LearningLifecycleError } from './m5-learning-evidence.ts';
const PROVIDER: any = 'agent-army.m5-learning';
const RETROSPECTIVE_PROVIDER: any = 'agent-army.m5-retrospective';
const LEARNING_EVIDENCE: any = new M5LearningEvidence();
const SCHEMAS: any = Object.freeze({
    retrospective: M5_SCHEMA_IDS.RETROSPECTIVE,
    offlineReplay: M5_SCHEMA_IDS.OFFLINE_REPLAY,
    proposal: M5_SCHEMA_IDS.LEARNING_PROPOSAL,
    template: M5_SCHEMA_IDS.TEMPLATE_VERSION,
    grayRelease: M5_SCHEMA_IDS.TEMPLATE_GRAY_RELEASE,
    decision: M5_SCHEMA_IDS.TEMPLATE_DECISION,
});
const PRIMARY_METRIC_PRIORITY: any = Object.freeze([
    'completionRate',
    'saveRate',
    'engagementRate',
    'views',
    'likes',
]);
const UUID: any = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
/**
 * Deterministic M5 learning lifecycle.
 *
 * Every durable state is an Issue Work Product attached to the existing
 * Paperclip Case. The coordinator does not keep a local store and never
 * mutates prompts, permissions, cadence, promotion or account settings.
 */
export class M5LearningLifecycle {
    governance: any;
    now: any;
    constructor({ governance, now = (): any => new Date() }: any = {}) {
        this.governance = governance;
        this.now = now;
    }
    async advance({ caseId, issueId, runId }: any = {}): Promise<any> {
        this.assertDependencies();
        const context: Record<string, any> = {
            caseId: uuid(caseId, '学习生命周期 Case 标识无效。'),
            issueId: uuid(issueId, '学习生命周期 Issue 标识无效。'),
            runId: uuid(runId, '学习生命周期 Run 标识无效。'),
        };
        const [casePayload, pipelinePayload] = await Promise.all([
            this.governance.getPipelineCaseOutputs(context.caseId),
            this.governance.getRetrospectiveMetricOutputs(context.caseId),
        ]);
        const caseOutputs: any = m5WorkProductItems(casePayload);
        const pipelineOutputs: any = mergeOutputs(caseOutputs, m5WorkProductItems(pipelinePayload));
        const retrospective: any = uniqueTrustedM5WorkProduct(caseOutputs, {
            provider: RETROSPECTIVE_PROVIDER,
            schemaVersion: SCHEMAS.retrospective,
            kind: 'Retrospective',
        }, {
            matches: (item: any): any => item.metadata?.report?.status === 'proposal_ready',
            duplicateError: (): any => new M5LearningLifecycleError('当前 Case 存在多个 可信 Retrospective Work Product。'),
        });
        if (!retrospective) {
            throw new M5LearningLifecycleError('当前 Case 没有达到五条真实样本门槛的 Retrospective。');
        }
        const decision: any = lifecycleProduct(caseOutputs, SCHEMAS.decision, 'TemplateDecision');
        if (decision) {
            return {
                state: decision.metadata.decision.status,
                replayed: true,
                workProductId: decision.id,
            };
        }
        const offlineReplay: any = lifecycleProduct(caseOutputs, SCHEMAS.offlineReplay, 'OfflineReplay');
        if (!offlineReplay) {
            const replay: any = buildOfflineReplay(retrospective, pipelineOutputs, this.now());
            return this.write(context, {
                kind: 'OfflineReplay',
                schemaVersion: SCHEMAS.offlineReplay,
                type: 'document',
                title: 'M5 模板离线历史回放',
                summary: `已在 ${replay.sampleCount} 条历史内容上重放事实、隐私、版权和媒体门禁；不声称播放量提升。`,
                data: { replay },
            });
        }
        const proposalProduct: any = lifecycleProduct(caseOutputs, SCHEMAS.proposal, 'LearningProposal');
        if (!proposalProduct) {
            const proposal: any = materializeProposal(retrospective, offlineReplay);
            return this.write(context, {
                kind: 'LearningProposal',
                schemaVersion: SCHEMAS.proposal,
                type: 'document',
                status: 'ready_for_review',
                reviewState: 'needs_board_review',
                title: 'M5 模板改进提案',
                summary: '离线回放已通过，等待审核官在 Paperclip 审批；不会自动修改生产模板。',
                data: { proposal },
            });
        }
        if (proposalProduct.reviewState === 'changes_requested') {
            return this.writeDecision(context, {
                status: 'rejected',
                templateVersionId: null,
                previousTemplateVersionId: defaultTemplateVersionId(proposalProduct),
                grayContentVersionId: null,
                reasons: ['审核官要求修改，未创建新模板版本。'],
                automaticRollback: false,
            });
        }
        if (proposalProduct.reviewState !== 'approved') {
            return {
                state: 'waiting_reviewer_approval',
                replayed: true,
                workProductId: proposalProduct.id,
            };
        }
        const templateProduct: any = lifecycleProduct(caseOutputs, SCHEMAS.template, 'TemplateVersion');
        if (!templateProduct) {
            const grayTarget: any = await this.governance.getNextM5GrayTargetCase(context.caseId);
            if (!grayTarget?.caseId) {
                return {
                    state: 'waiting_gray_target_case',
                    replayed: true,
                    workProductId: proposalProduct.id,
                };
            }
            const templateVersion: any = approvedTemplateVersion(proposalProduct, offlineReplay, this.now(), grayTarget);
            return this.write(context, {
                kind: 'TemplateVersion',
                schemaVersion: SCHEMAS.template,
                type: 'document',
                title: `M5 模板版本 ${templateVersion.version}`,
                summary: '审核已通过；新版本只允许一条灰度内容，尚未成为生产默认版本。',
                data: { templateVersion },
            });
        }
        const templateVersion: any = templateProduct.metadata.templateVersion;
        if (!validLearningSuggestedChanges(templateVersion?.suggestedChanges)) {
            throw new M5LearningLifecycleError('TemplateVersion 包含空、重复或占位的模板改进建议。');
        }
        const grayContentVersion: any = LEARNING_EVIDENCE.selectSingleGrayContent({
            outputs: pipelineOutputs,
            templateVersion,
            templateWorkProductId: templateProduct.id,
        });
        if (!grayContentVersion) {
            return {
                state: 'waiting_single_gray_content',
                replayed: true,
                workProductId: templateProduct.id,
            };
        }
        const grayRelease: any = lifecycleProduct(caseOutputs, SCHEMAS.grayRelease, 'TemplateGrayRelease');
        if (!grayRelease) {
            return this.write(context, {
                kind: 'TemplateGrayRelease',
                schemaVersion: SCHEMAS.grayRelease,
                type: 'artifact',
                title: 'M5 单条模板灰度',
                summary: `模板 ${templateVersion.templateVersionId} 仅绑定内容 ${grayContentVersion.contentVersionId}。`,
                data: {
                    grayRelease: {
                        templateVersionId: templateVersion.templateVersionId,
                        contentVersionId: grayContentVersion.contentVersionId,
                        platform: grayContentVersion.platform,
                        maximumUses: 1,
                        usedUses: 1,
                        releasedAt: validDate(this.now()).toISOString(),
                        automaticProductionMutation: false,
                    },
                },
            });
        }
        if (grayRelease.metadata.grayRelease?.templateVersionId !== templateVersion.templateVersionId
            || grayRelease.metadata.grayRelease?.contentVersionId !== grayContentVersion.contentVersionId
            || grayRelease.metadata.grayRelease?.maximumUses !== 1
            || grayRelease.metadata.grayRelease?.usedUses !== 1) {
            throw new M5LearningLifecycleError('单条灰度 Work Product 与审核后的模板版本不一致。');
        }
        const outcome: any = LEARNING_EVIDENCE.evaluateGray({
            outputs: pipelineOutputs,
            offlineReplay: offlineReplay.metadata.replay,
            templateVersion,
            grayContentVersion,
        });
        if (!outcome) {
            return {
                state: 'waiting_gray_quality_and_72h_metric',
                replayed: true,
                workProductId: grayRelease.id,
            };
        }
        return this.writeDecision(context, outcome);
    }
    async writeDecision(context: any, decision: any): Promise<any> {
        return this.write(context, {
            kind: 'TemplateDecision',
            schemaVersion: SCHEMAS.decision,
            type: 'document',
            title: decision.status === 'rolled_back' ? 'M5 模板自动回退决定' : 'M5 模板灰度决定',
            summary: decision.status === 'rolled_back'
                ? `质量或指标下降，已决定回退到 ${decision.previousTemplateVersionId}。`
                : decision.status === 'validated'
                    ? '单条灰度质量与主指标未下降，模板版本通过灰度。'
                    : '模板提案未通过审核。',
            data: {
                decision: {
                    ...decision,
                    decidedAt: validDate(this.now()).toISOString(),
                    controls: productionControls(),
                },
            },
        });
    }
    async write(context: any, { kind, schemaVersion, type, title, summary, data, status = 'active', reviewState = 'none', }: any): Promise<any> {
        const product: any = await this.governance.createIssueWorkProduct(context.issueId, {
            type,
            provider: PROVIDER,
            externalId: externalId(context.caseId, kind),
            title,
            status,
            reviewState,
            isPrimary: false,
            healthStatus: 'healthy',
            summary,
            metadata: {
                schemaVersion,
                kind,
                caseId: context.caseId,
                ...data,
            },
            createdByRunId: context.runId,
        }, { runId: context.runId });
        return {
            state: stateForKind(kind, data),
            replayed: false,
            createdKind: kind,
            workProductId: product?.id || null,
        };
    }
    assertDependencies(): any {
        const required: any[] = [
            'getPipelineCaseOutputs',
            'getRetrospectiveMetricOutputs',
            'getNextM5GrayTargetCase',
            'createIssueWorkProduct',
        ];
        if (required.some((method: any): any => typeof this.governance?.[method] !== 'function')) {
            throw new M5LearningLifecycleError('M5 学习生命周期缺少 Paperclip Case/Work Product 适配。');
        }
    }
}
export function buildOfflineReplay(retrospectiveProduct: any, pipelineOutputs: any, now: any = new Date()): any {
    const report: any = retrospectiveProduct?.metadata?.report;
    const proposal: any = report?.learningProposal;
    if (proposal?.status !== 'proposed'
        || proposal.offlineReplayRequired !== true
        || proposal.reviewerApprovalRequired !== true
        || proposal.grayReleaseLimit !== 1
        || proposal.automaticProductionMutation !== false
        || !validLearningSuggestedChanges(proposal.suggestedChanges)
        || !safeProductionControls(report?.controls)) {
        throw new M5LearningLifecycleError('LearningProposal 未保持有效模板改进建议、离线回放、人工审核和单条灰度安全边界。');
    }
    const refs: any = new Set(Array.isArray(report.metricSnapshotRefs) ? report.metricSnapshotRefs : []);
    if (refs.size < 5 || Number(report.sampleCount) < 5) {
        throw new M5LearningLifecycleError('离线回放至少需要五条同类型真实 72h 指标。');
    }
    const { samples, reviews } = LEARNING_EVIDENCE.collectOfflineReplay({
        outputs: pipelineOutputs,
        snapshotRefs: refs,
    });
    const baselineMetrics: any = aggregateNumericMetrics(samples.map((item: any): any => item.snapshot.metrics));
    const primaryMetric: any = PRIMARY_METRIC_PRIORITY.find((key: any): any => Number.isFinite(Number(baselineMetrics[key])));
    if (!primaryMetric) {
        throw new M5LearningLifecycleError('离线回放没有可比较的主指标。');
    }
    return {
        replayId: `replay_${digest(`${proposal.proposalId}:${[...refs].sort().join(':')}`).slice(0, 24)}`,
        proposalId: proposal.proposalId,
        status: 'passed_for_review',
        sampleType: report.sampleType,
        sampleCount: samples.length,
        metricSnapshotRefs: [...refs].sort(),
        machineReviewRefs: reviews.map((item: any): any => item.id).sort(),
        baselineMetrics,
        primaryMetric,
        safetyReplay: {
            facts: true,
            privacy: true,
            rights: true,
            media: true,
            claims: true,
            grantScope: true,
            duplicate: true,
        },
        historicalOnly: true,
        estimatedLift: null,
        performanceClaimed: false,
        replayedAt: validDate(now).toISOString(),
        controls: productionControls(),
    };
}
function materializeProposal(retrospectiveProduct: any, offlineReplayProduct: any): any {
    const source: any = retrospectiveProduct.metadata.report.learningProposal;
    const replay: any = offlineReplayProduct.metadata.replay;
    if (replay.status !== 'passed_for_review'
        || replay.proposalId !== source.proposalId
        || replay.performanceClaimed !== false
        || !validLearningSuggestedChanges(source.suggestedChanges)) {
        throw new M5LearningLifecycleError('离线回放与 LearningProposal 或模板改进建议不一致。');
    }
    return {
        ...structuredClone(source),
        status: 'proposed',
        offlineReplayId: replay.replayId,
        baseTemplateVersionId: 'm5-template-default-v1',
        requestedChangeCount: 1,
        controls: productionControls(),
    };
}
function approvedTemplateVersion(proposalProduct: any, offlineReplayProduct: any, now: any, grayTarget: any): any {
    const proposal: any = proposalProduct.metadata.proposal;
    const replay: any = offlineReplayProduct.metadata.replay;
    if (proposal?.offlineReplayId !== replay?.replayId
        || proposal?.requestedChangeCount !== 1
        || !validLearningSuggestedChanges(proposal?.suggestedChanges)
        || !safeProductionControls(proposal?.controls)) {
        throw new M5LearningLifecycleError('审核后的提案与离线回放或单变量约束不一致。');
    }
    const previousTemplateVersionId: any = String(proposal.baseTemplateVersionId || 'm5-template-default-v1');
    return {
        templateVersionId: `template_${digest(`${proposal.proposalId}:v2`).slice(0, 24)}`,
        version: 2,
        previousTemplateVersionId,
        sourceProposalId: proposal.proposalId,
        sourceOfflineReplayId: replay.replayId,
        state: 'gray_ready',
        grayReleaseLimit: 1,
        productionDefault: false,
        grayTargetCaseId: uuid(grayTarget?.caseId, '单条灰度目标 Case 标识无效。'),
        grayTargetDayCaseId: uuid(grayTarget?.dayCaseId, '单条灰度目标日期 Case 标识无效。'),
        grayTargetScheduledDate: String(grayTarget?.scheduledDate || ''),
        grayTargetPlatform: M5_PLATFORM_IDS.DOUYIN,
        applicationScope: 'full_content_variant',
        suggestedChanges: structuredClone(proposal.suggestedChanges || []).slice(0, 1),
        approvedAt: validDate(now).toISOString(),
        controls: productionControls(),
    };
}
function validLearningSuggestedChanges(value: any): any {
    return Array.isArray(value)
        && value.length === 1
        && validM5TemplateGuidance(value);
}
function aggregateNumericMetrics(metricsList: any): any {
    const values: any = new Map();
    for (const metrics of metricsList) {
        for (const [key, value] of Object.entries(metrics || {})) {
            const numeric: any = Number(value);
            if (!Number.isFinite(numeric))
                continue;
            const entries: any = values.get(key) || [];
            entries.push(numeric);
            values.set(key, entries);
        }
    }
    return Object.fromEntries([...values.entries()].map(([key, entries]: any): any => [
        key,
        entries.reduce((total: any, value: any): any => total + value, 0) / entries.length,
    ]));
}
function lifecycleProduct(outputs: any, schemaVersion: any, kind: any): any {
    return uniqueTrustedM5WorkProduct(outputs, {
        provider: PROVIDER,
        schemaVersion,
        kind,
    }, {
        duplicateError: (): any => new M5LearningLifecycleError(`当前 Case 存在多个 ${kind} Work Product。`),
    });
}
function mergeOutputs(left: any, right: any): any {
    const rows: any = new Map();
    for (const item of [...left, ...right]) {
        const key: any = String(item?.id || `${item?.provider}:${item?.externalId}:${rows.size}`);
        if (!rows.has(key))
            rows.set(key, item);
    }
    return [...rows.values()];
}
function safeProductionControls(value: any): any {
    return value?.promptMutation === false
        && value?.permissionExpansion === false
        && value?.frequencyIncrease === false
        && value?.paidPromotion === false;
}
function productionControls(): any {
    return {
        promptMutation: false,
        permissionExpansion: false,
        frequencyIncrease: false,
        paidPromotion: false,
    };
}
function defaultTemplateVersionId(proposalProduct: any): any {
    return String(proposalProduct?.metadata?.proposal?.baseTemplateVersionId || 'm5-template-default-v1');
}
function stateForKind(kind: any, data: any): any {
    if (kind === 'OfflineReplay')
        return 'offline_replay_passed';
    if (kind === 'LearningProposal')
        return 'waiting_reviewer_approval';
    if (kind === 'TemplateVersion')
        return 'waiting_single_gray_content';
    if (kind === 'TemplateGrayRelease')
        return 'waiting_gray_quality_and_72h_metric';
    if (kind === 'TemplateDecision')
        return data.decision.status;
    return 'unknown';
}
function externalId(caseId: any, kind: any): any {
    return `m5_learning_${digest(`${caseId}:${kind}`).slice(0, 32)}`;
}
function digest(value: any): any {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}
function uuid(value: any, message: any): any {
    const id: any = String(value || '').trim();
    if (!UUID.test(id))
        throw new M5LearningLifecycleError(message);
    return id;
}
function validDate(value: any): any {
    const date: any = value instanceof Date ? new Date(value) : new Date(value);
    if (!Number.isFinite(date.getTime()))
        throw new M5LearningLifecycleError('学习生命周期时钟无效。');
    return date;
}

import { M5_PLATFORMS, M5_SCHEMA_IDS, } from '@agent-army/m5-contracts';
const PLATFORMS = M5_PLATFORMS;
const PARALLEL_WORK_BRANCHES = Object.freeze([
    Object.freeze({
        kind: 'research',
        title: '研究',
        owner: 'intel-researcher',
        activationStageKey: null,
        activationRoutineKey: 'm5-evidence',
        requiredWorkProduct: 'EvidencePackage',
    }),
    Object.freeze({
        kind: 'assets',
        title: '素材与关键帧',
        owner: 'xiaod',
        activationStageKey: 'assets',
        activationRoutineKey: 'm5-assets',
        requiredWorkProduct: 'AssetPackage',
    }),
    Object.freeze({
        kind: 'image_generation',
        title: '生图',
        owner: 'content-creator',
        activationStageKey: null,
        activationRoutineKey: 'm5-image-generation',
        requiredWorkProduct: 'GeneratedImagePackage',
    }),
    Object.freeze({
        kind: 'visual_analysis',
        title: '画面分析',
        owner: 'video-content-analyst',
        activationStageKey: 'visual_analysis',
        activationRoutineKey: 'm5-visual-analysis',
        requiredWorkProduct: 'VisualAnalysisPackage',
        requiredInputs: Object.freeze(['AssetPackage']),
    }),
    Object.freeze({
        kind: 'voice',
        title: '配音',
        owner: 'content-creator',
        activationStageKey: 'voice',
        activationRoutineKey: 'm5-voice',
        requiredWorkProduct: 'VoicePackage',
    }),
]);
function assertIsoDate(value: any) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
        throw new Error(`无效开始日期: ${value}`);
    }
}
function addDays(isoDate: any, offset: any) {
    const date = new Date(`${isoDate}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + offset);
    return date.toISOString().slice(0, 10);
}
export function platformCaseKey(campaignId: any, date: any, platform: any, contentVersion: any = 'v1') {
    if (!campaignId || campaignId.includes(':'))
        throw new Error('campaignId 必须非空且不能包含冒号');
    assertIsoDate(date);
    if (!PLATFORMS.includes(platform))
        throw new Error(`不支持的平台: ${platform}`);
    if (!/^v[1-9]\d*$/.test(contentVersion))
        throw new Error(`无效内容版本: ${contentVersion}`);
    return `${campaignId}:${date}:${platform}:${contentVersion}`;
}
export function buildParallelWorkCaseBatch({ campaignId, scheduledDate, contentVersion = 'v1', }: any) {
    if (!campaignId || campaignId.includes(':')) {
        throw new Error('campaignId 必须非空且不能包含冒号');
    }
    assertIsoDate(scheduledDate);
    if (!/^v[1-9]\d*$/.test(contentVersion))
        throw new Error(`无效内容版本: ${contentVersion}`);
    const dayLogicalId = `${campaignId}:${scheduledDate}`;
    const groupKey = `${dayLogicalId}:parallel:${contentVersion}`;
    const join: any = {
        logicalId: groupKey,
        caseKey: groupKey,
        requestKey: `parallel-join:${contentVersion}`,
        parentLogicalId: dayLogicalId,
        title: `${scheduledDate} / 并行工作汇聚 / ${contentVersion}`,
        stageKey: 'draft',
        fields: {
            campaignId,
            scheduledDate,
            contentVersion,
            parallelJoin: {
                schemaVersion: M5_SCHEMA_IDS.PARALLEL_JOIN,
                groupKey,
                maxConcurrency: 4,
                completionRule: 'all_branches_terminal_and_outputs_verified',
                appsActivationRequired: true,
            },
        },
    };
    const branches = PARALLEL_WORK_BRANCHES.map((branch: any) => {
        const caseKey = `${groupKey}:${branch.kind}`;
        return {
            logicalId: caseKey,
            caseKey,
            requestKey: `parallel-branch:${branch.kind}:${contentVersion}`,
            parentLogicalId: join.logicalId,
            title: `${scheduledDate} / ${branch.title} / ${contentVersion}`,
            stageKey: 'draft',
            fields: {
                campaignId,
                scheduledDate,
                contentVersion,
                workBranch: {
                    schemaVersion: M5_SCHEMA_IDS.PARALLEL_WORK_BRANCH,
                    groupKey,
                    kind: branch.kind,
                    owner: branch.owner,
                    activationStageKey: branch.activationStageKey,
                    activationRoutineKey: branch.activationRoutineKey,
                    requiredWorkProduct: branch.requiredWorkProduct,
                    requiredInputs: [...(branch.requiredInputs || [])],
                    appsActivationRequired: true,
                },
            },
        };
    });
    join.blockedByCaseKeys = branches.map((item: any) => item.caseKey);
    join.fields.parallelJoin.branchCaseKeys = [...join.blockedByCaseKeys];
    join.fields.parallelJoin.requiredWorkProducts = branches.map((item: any) => item.fields.workBranch.requiredWorkProduct);
    return {
        schemaVersion: M5_SCHEMA_IDS.PARALLEL_WORK_BATCH,
        maxConcurrency: 4,
        dayLogicalId,
        join,
        branches,
    };
}
export function buildCampaignCaseBatch({ campaignId, startDate, themes, assetRightsBasis = '活动声明：仅使用本机自产素材与活动授权生成素材。', }: any) {
    assertIsoDate(startDate);
    if (!Array.isArray(themes) || themes.length !== 7 || themes.some((theme: any) => !String(theme).trim())) {
        throw new Error('themes 必须包含7个非空主题');
    }
    const parentKey = campaignId;
    const parent = {
        logicalId: parentKey,
        caseKey: parentKey,
        title: `M5 7天内容活动：${campaignId}`,
        stageKey: 'draft',
        activationStageKey: 'campaign_active',
        fields: {
            campaignId,
            durationDays: 7,
            publishLimit: 14,
            maxConcurrency: 4,
            campaignPlan: {
                schemaVersion: M5_SCHEMA_IDS.CAMPAIGN_PLAN,
                startDate,
                themes: themes.map((theme: any) => String(theme).trim()),
                assetRightsBasis: String(assetRightsBasis).trim(),
            },
        },
    };
    const days = themes.map((theme: any, index: any) => {
        const date = addDays(startDate, index);
        return {
            logicalId: `${campaignId}:${date}`,
            caseKey: `${campaignId}:${date}`,
            parentLogicalId: parentKey,
            title: `第${index + 1}天：${String(theme).trim()}`,
            stageKey: 'topic',
            fields: {
                campaignId,
                scheduledDate: date,
                theme: String(theme).trim(),
                assetRightsBasis: String(assetRightsBasis).trim(),
            },
        };
    });
    const platformCases = days.flatMap((day: any) => PLATFORMS.map((platform: any) => ({
        logicalId: platformCaseKey(campaignId, day.fields.scheduledDate, platform),
        caseKey: platformCaseKey(campaignId, day.fields.scheduledDate, platform),
        parentLogicalId: day.logicalId,
        title: `${day.title} / ${platform}`,
        stageKey: 'machine_review',
        fields: {
            ...day.fields,
            platform,
            contentVersion: 'v1',
            publishIdempotencyKey: platformCaseKey(campaignId, day.fields.scheduledDate, platform),
        },
    })));
    return { parent, days, platformCases };
}
export function assertReviewDecision(definition: any, stageKey: any, decision: any) {
    const stage = definition.stages.find((item: any) => item.key === stageKey);
    if (!stage || stage.kind !== 'review')
        throw new Error(`不是 review 阶段: ${stageKey}`);
    const destinations = {
        approve: stage.review.approveTo,
        reject: stage.review.rejectTo,
        request_changes: stage.review.requestChangesTo,
    };
    if (!Object.hasOwn(destinations, decision))
        throw new Error(`不支持的审核决定: ${decision}`);
    return (destinations as Record<string, any>)[decision];
}
export async function ingestCampaignCaseBatch(adapter: any, pipelineId: any, batch: any) {
    const parent = await ingestCampaignDraftCase(adapter, pipelineId, batch);
    const execution = await ingestCampaignExecutionCases(adapter, pipelineId, batch, parent);
    return { parent, ...execution };
}
export async function ingestParallelWorkCaseBatch(adapter: any, pipelineId: any, batch: any, dayCase: any) {
    assertParallelWorkBatch(batch);
    if (!adapter?.ingestCase
        || !adapter?.replaceCaseBlockers
        || !pipelineId
        || !dayCase?.id) {
        throw new Error('adapter、pipelineId、日期 Case 和 blocker 写入能力必填');
    }
    if (dayCase.pipelineId && dayCase.pipelineId !== pipelineId) {
        throw new Error('日期 Case 不属于目标 Pipeline');
    }
    if (dayCase.caseKey !== batch.dayLogicalId) {
        throw new Error('日期 Case 与并行工作批次不匹配');
    }
    const join = await adapter.ingestCase(pipelineId, {
        caseKey: batch.join.caseKey,
        requestKey: batch.join.requestKey,
        title: batch.join.title,
        stageKey: 'draft',
        fields: batch.join.fields,
        parentCaseId: dayCase.id,
    });
    assertIngestedCase(join, batch.join.caseKey, dayCase.id);
    const branchPayloads = batch.branches.map((item: any) => ({
        caseKey: item.caseKey,
        requestKey: item.requestKey,
        title: item.title,
        stageKey: 'draft',
        fields: item.fields,
        parentCaseId: join.id,
    }));
    const branches = typeof adapter.ingestCases === 'function'
        ? await adapter.ingestCases(pipelineId, branchPayloads)
        : await Promise.all(branchPayloads.map((payload: any) => adapter.ingestCase(pipelineId, payload)));
    branches.forEach((item: any, index: any) => {
        assertIngestedCase(item, batch.branches[index].caseKey, join.id);
    });
    const blockedByCaseIds = branches.map((item: any) => item.id);
    await adapter.replaceCaseBlockers(join.id, blockedByCaseIds);
    return {
        join: { ...join, blockedByCaseIds: [...blockedByCaseIds] },
        branches,
        maxConcurrency: batch.maxConcurrency,
        activationRequired: true,
    };
}
export async function ingestCampaignDraftCase(adapter: any, pipelineId: any, batch: any) {
    if (!adapter?.ingestCase || !pipelineId)
        throw new Error('adapter 和 pipelineId 必填');
    return adapter.ingestCase(pipelineId, {
        caseKey: batch.parent.caseKey,
        title: batch.parent.title,
        stageKey: batch.parent.stageKey,
        fields: batch.parent.fields,
    });
}
export async function ingestCampaignExecutionCases(adapter: any, pipelineId: any, batch: any, parent: any) {
    if (!adapter?.ingestCase || !pipelineId || !parent?.id) {
        throw new Error('adapter、pipelineId 和父 Case 必填');
    }
    const createdByLogicalId = new Map();
    createdByLogicalId.set(batch.parent.logicalId, parent);
    for (const item of batch.days) {
        const parentCase = createdByLogicalId.get(item.parentLogicalId);
        const created = await adapter.ingestCase(pipelineId, {
            caseKey: item.caseKey,
            title: item.title,
            stageKey: 'draft',
            fields: item.fields,
            parentCaseId: parentCase.id,
        });
        createdByLogicalId.set(item.logicalId, created);
    }
    for (const item of batch.platformCases) {
        const parentCase = createdByLogicalId.get(item.parentLogicalId);
        const created = await adapter.ingestCase(pipelineId, {
            caseKey: item.caseKey,
            title: item.title,
            stageKey: 'draft',
            fields: item.fields,
            parentCaseId: parentCase.id,
        });
        createdByLogicalId.set(item.logicalId, created);
    }
    return {
        days: batch.days.map((item: any) => createdByLogicalId.get(item.logicalId)),
        platformCases: batch.platformCases.map((item: any) => createdByLogicalId.get(item.logicalId)),
    };
}
function assertParallelWorkBatch(batch: any) {
    if (batch?.schemaVersion !== M5_SCHEMA_IDS.PARALLEL_WORK_BATCH
        || batch.maxConcurrency !== 4
        || !Array.isArray(batch.branches)
        || batch.branches.length !== 5) {
        throw new Error('并行工作批次必须固定为5个分支且最大并发为4');
    }
    const caseKeys = batch.branches.map((item: any) => item.caseKey);
    if (new Set(caseKeys).size !== 5
        || !batch.branches.every((item: any) => (item.parentLogicalId === batch.join?.logicalId
            && item.stageKey === 'draft'
            && item.fields?.workBranch?.appsActivationRequired === true))) {
        throw new Error('并行工作分支 caseKey、父子关系或安全初始阶段无效');
    }
    if (batch.join?.parentLogicalId !== batch.dayLogicalId
        || batch.join.stageKey !== 'draft'
        || batch.join.fields?.parallelJoin?.appsActivationRequired !== true
        || JSON.stringify(batch.join.blockedByCaseKeys) !== JSON.stringify(caseKeys)) {
        throw new Error('并行工作汇聚 Case 的父级或依赖声明无效');
    }
}
function assertIngestedCase(item: any, expectedCaseKey: any, expectedParentCaseId: any) {
    if (!item?.id
        || item.caseKey !== expectedCaseKey
        || item.parentCaseId !== expectedParentCaseId) {
        throw new Error(`Paperclip 返回的并行工作 Case 身份漂移: ${expectedCaseKey}`);
    }
}

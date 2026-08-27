import { BoomSignalDedupGovernor } from './boom-signal-dedup-governor.ts';

const defaultGovernor = new BoomSignalDedupGovernor();

export function normalizeBoomSignal(input: any = {}) {
    const sourceUrl = publicHttpUrl(input.sourceUrl);
    const grade = String(input.grade || 'N0').toUpperCase().trim() || 'N0';
    const workId = clean(input.workId, 200);
    const platform = clean(input.platform, 40);
    if (!sourceUrl)
        throw new Error('爆款候选缺少可供小D读取的公开 HTTP(S) 来源。');
    if (!workId || !platform)
        throw new Error('爆款候选缺少平台或作品编号。');
    const observed = input.observedMetrics && typeof input.observedMetrics === 'object' ? input.observedMetrics : {};
    const baseline = input.baseline && typeof input.baseline === 'object' ? input.baseline : {};
    return {
        schemaVersion: 'boom-signal/v1',
        workRef: clean(input.workRef, 300) || `${platform}:${workId}`,
        workId,
        title: clean(input.title, 500) || workId,
        platform,
        creatorRef: clean(input.creatorRef, 200),
        creatorName: clean(input.creatorName, 200),
        sourceUrl,
        sourceRef: clean(input.sourceRef, 2000) || sourceUrl,
        evidenceKind: 'platform_observed',
        observedAt: isoDate(input.observedAt),
        grade,
        tier: clean(input.tier, 40),
        rValue: number(input.rValue),
        mValue: number(input.mValue),
        observedMetrics: {
            likes: nonNegativeInteger(observed.likes),
            favorites: nonNegativeInteger(observed.favorites),
            plays: nonNegativeInteger(observed.plays),
            followers: nonNegativeInteger(observed.followers),
        },
        baseline: {
            metricMedian: nullableNumber(baseline.metricMedian),
            sampleCount: nonNegativeInteger(baseline.sampleCount),
            followerSnapshot: nonNegativeInteger(baseline.followerSnapshot),
            frozenAt: isoDate(baseline.frozenAt),
            historyWindow: 20,
        },
        formulas: { R: 'platform_core_metric / frozen_history_median', M: 'likes / frozen_follower_snapshot' },
        depth: input.depth === 'full' || grade === 'T3' ? 'full' : 'fast',
    };
}
export async function dispatchBoomSignal(input: any, { missions, dedupGovernor = null }: any = {}) {
    if (!missions?.createBusinessMission)
        throw new Error('军团任务入口不可用。');
    const signal = normalizeBoomSignal(input);
    const decision = dedupGovernor?.evaluate(signal);
    if (decision && decision.action === 'suppress_duplicate') {
        return {
            status: 'suppressed_duplicate',
            reason: decision.reason,
            existingMissionId: decision.record?.missionId || null,
        };
    }
    const metricSummary = [
        `命中 ${signal.grade}，R=${signal.rValue.toFixed(4)}，M=${signal.mValue.toFixed(4)}`,
        `点赞=${signal.observedMetrics.likes}，收藏=${signal.observedMetrics.favorites}，播放=${signal.observedMetrics.plays}，粉丝快照=${signal.observedMetrics.followers}`,
        `基线为该作品之前最近 ${signal.baseline.sampleCount}/${signal.baseline.historyWindow} 条作品核心指标中位数 ${signal.baseline.metricMedian ?? '未提供'}`,
        `指标证据：${signal.evidenceKind}，来源 ${signal.sourceRef}，观察时间 ${signal.observedAt || '未提供'}`,
        '该评分只用于筛选和排序，不构成传播因果判断。',
    ].join('；');
    const result = await missions.createBusinessMission({
        title: `爆款候选拆解｜${signal.title}`,
        requester: { kind: 'local-owner', ref: 'A君' },
        source: { channel: 'boom-monitor', originChannel: 'boom-monitor', workRef: signal.workRef },
        idempotencyKey: `boom-monitor:${signal.platform}:${signal.workId}`,
        items: [
            {
                key: 'acquire-transcript',
                title: `获取并整理：${signal.title}`,
                taskType: 'media.transcribe-and-refine',
                agentId: 'xiaod',
                description: '通过内容获取中心获取公开或已授权素材，生成来源证据、质量报告、确认稿和可用的关键帧证据。',
                acceptance: '质量门禁通过时生成系统确认稿；异常时等待人工完整听审，不得把未确认机器稿作为正式分析证据。',
                sourceUrls: [signal.sourceUrl],
                reviewPolicy: 'optional',
                evidenceMode: 'formal',
                depth: signal.depth,
                visualMode: 'auto',
            },
            {
                key: 'analyze-video',
                title: `拆解爆款候选：${signal.title}`,
                taskType: 'content.video-benchmark-analysis',
                agentId: 'video-content-analyst',
                description: metricSummary,
                acceptance: '只在确认稿存在后生成证据化拆解；报告保留爆款筛选信号，并明确评分不代表因果。',
                dependsOnPrevious: true,
                dependsOn: ['acquire-transcript'],
                evidenceMode: 'formal',
                depth: signal.depth,
                visualMode: 'auto',
                focus: '解释开场钩子、内容结构、受众触发点、可复制要素和不可复制上下文。',
                context: { boomSignal: signal },
            },
        ],
    });
    dedupGovernor?.record(signal, { missionId: result?.mission?.taskId || result?.taskId });
    return result;
}
function publicHttpUrl(value: any) {
    try {
        const parsed = new URL(String(value || '').trim());
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
            return null;
        return parsed.toString();
    }
    catch {
        return null;
    }
}
function clean(value: any, limit: any) { return String(value || '').trim().replace(/\s+/g, ' ').slice(0, limit); }
function number(value: any) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function nullableNumber(value: any) { const parsed = Number(value); return value === null || value === undefined || !Number.isFinite(parsed) ? null : parsed; }
function nonNegativeInteger(value: any) { return Math.max(0, Math.floor(number(value))); }
function isoDate(value: any) { const parsed = Date.parse(String(value || '')); return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null; }

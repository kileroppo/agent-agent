import { normalizeContentChannel } from '@agent-army/m5-contracts';
export function buildMetricLearning(input: any, metrics: any): any {
    const platform: any = normalizeContentChannel(input?.platform);
    const contentType: any = clean(input?.contentType, 80) || null;
    const observationWindow: any = clean(input?.observationWindow, 120) || null;
    const declaredComparableSampleCount: any = Math.max(0, Number(input?.comparableSampleCount) || 0);
    const binding: Record<string, any> = {
        platform,
        platformContentId: clean(metrics.platformContentId || input?.platformContentId, 200) || null,
        publishedAt: clean(metrics.publishedAt || input?.publishedAt, 120) || null,
        contentVersionId: clean(metrics.contentVersionId || input?.contentVersionId, 200) || null,
    };
    const metricBindingComplete: any = Boolean(binding.platform && binding.platformContentId && binding.publishedAt && binding.contentVersionId);
    return {
        status: 'insufficient_sample',
        reason: !metricBindingComplete
            ? '指标缺少平台内容ID、发布时间、平台或内容版本绑定。'
            : declaredComparableSampleCount >= 5 && Boolean(contentType) && observationWindow === '72h'
                ? '调用方声明的样本数不能替代五条经 Paperclip 回读的可信 MetricSnapshot；学习提案只能由受控复盘链生成。'
                : '需要至少五条经 Paperclip 回读、同平台、同内容类型、统一72小时口径的可信 MetricSnapshot。',
        comparableSampleCount: 0,
        declaredComparableSampleCount,
        metricBindingComplete,
        binding,
        proposal: null,
        requiresHumanReview: true,
        productionMutationAllowed: false,
        governedLearningRoute: 'paperclip-retrospective',
    };
}
function clean(value: any, max: any): any { return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); }

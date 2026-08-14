import { M5_PLATFORMS } from '@agent-army/m5-contracts';
import { IMMEDIATE_PUBLISH_RECOVERY_ACTION, calendarDateInShanghai, } from '@agent-army/m5-publisher-gateway/policy';
import { assertContentVersionIdentity, trustedContentVersionProducts, trustedMachineReviewProducts, } from './trusted-publish-lineage.ts';
const REQUIRED_REVIEW_CHECKS: any = Object.freeze([
    'facts',
    'privacy',
    'rights',
    'media',
    'claims',
    'grantScope',
    'duplicate',
]);
export function derivePublishContext({ outputs, targetCase, campaignCase, grant, executionTime, }: any, { invalid = (message: any): any => new Error(message), }: any = {}): any {
    const contentItems: any = trustedContentVersionProducts(outputs);
    const reviewItems: any = trustedMachineReviewProducts(outputs);
    if (contentItems.length !== 1 || reviewItems.length !== 1) {
        throw invalid(`当前 Case 必须各有一个可信 ContentVersion 和 MachineReview，实际为 ${contentItems.length}/${reviewItems.length}。`);
    }
    const contentVersionCandidate: any = contentItems[0].metadata.contentVersion;
    const reviewReport: any = reviewItems[0].metadata.reviewReport;
    const platform: any = String(targetCase.fields?.platform || '').trim();
    const scheduledDate: any = String(targetCase.fields?.scheduledDate || '').trim();
    if (!M5_PLATFORMS.includes(platform) || !validCalendarDate(scheduledDate)) {
        throw invalid('发布 Case 缺少可信平台或发布日期。');
    }
    const executionDate: any = calendarDateInShanghai(executionTime);
    if (scheduledDate !== executionDate) {
        throw immediatePublishDateMismatch({ scheduledDate, executionDate, invalid });
    }
    const contentVersion: any = assertContentVersionIdentity(contentVersionCandidate, {
        invalid: (): any => invalid('ContentVersion 与当前平台 Case 不一致或缺少发布产物。'),
    });
    if (contentVersion.platform !== platform) {
        throw invalid('ContentVersion 与当前平台 Case 不一致或缺少发布产物。');
    }
    if (reviewReport?.status !== 'passed'
        || REQUIRED_REVIEW_CHECKS.some((check: any): any => reviewReport?.checks?.[check] !== true)
        || reviewReport.contentVersionId !== contentVersion.contentVersionId) {
        throw invalid('机器审核未完整通过或审核版本不匹配。');
    }
    if (!grant.platforms?.includes(platform)
        || !String(grant.accountRefs?.[platform] || '').trim()) {
        throw invalid('活动授权没有覆盖当前平台账号。');
    }
    const request: Record<string, any> = {
        campaignId: campaignCase.id,
        grant: structuredClone(grant),
        platform,
        contentVersionId: contentVersion.contentVersionId,
        contentChecksum: contentVersion.checksum,
        scheduledDate,
        mediaPath: contentVersion.mediaPath,
        title: String(contentVersion.title).trim(),
        body: String(contentVersion.body).trim(),
        tags: structuredClone(contentVersion.tags),
        reviewReport: structuredClone(reviewReport),
        idempotencyKey: [
            campaignCase.id,
            platform,
            contentVersion.contentVersionId,
            scheduledDate,
        ].join(':'),
    };
    return { request, contentVersion, reviewReport };
}
function validCalendarDate(value: any): any {
    const text: any = String(value || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text))
        return false;
    const date: any = new Date(`${text}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text;
}
function immediatePublishDateMismatch({ scheduledDate, executionDate, invalid }: any): any {
    const error: any = invalid(`当前连接器只允许即时发布；平台 Case 日期 ${scheduledDate} 与上海执行日 ${executionDate} 不一致。`);
    error.code = 'publisher_scheduled_date_mismatch';
    error.recoveryAction = Object.freeze({
        action: IMMEDIATE_PUBLISH_RECOVERY_ACTION,
        instruction: '将平台 Case 重排到当前上海日期后重新执行；禁止直接补发历史 Case 或提前发布未来 Case。',
        scheduledDate,
        executionDate,
        timeZone: 'Asia/Shanghai',
    });
    return error;
}

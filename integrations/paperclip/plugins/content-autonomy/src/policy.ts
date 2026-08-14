import crypto from 'node:crypto';
import { M5_ALLOWED_PUBLISH_ACTIONS, M5_PLATFORMS, M5_PROHIBITED_PUBLISH_ACTIONS, M5_SCHEMA_IDS, } from '@agent-army/m5-contracts';
import { validateExactAgentToolPolicy } from './role-tool-bundles.ts';
export const PLATFORMS = M5_PLATFORMS;
export const FORBIDDEN_ACTIONS = M5_PROHIBITED_PUBLISH_ACTIONS;
export const REQUIRED_ACTIONS = M5_ALLOWED_PUBLISH_ACTIONS;
export function campaignPreflight(campaign: any, now: any = new Date()) {
    const errors = [];
    if (campaign?.schemaVersion !== M5_SCHEMA_IDS.CAMPAIGN_GRANT)
        errors.push('CampaignGrant 版本无效。');
    if (campaign?.themeScope !== 'AI Agent 实战')
        errors.push('主题不在首版活动范围内。');
    if (!Array.isArray(campaign?.platforms) || campaign.platforms.some((item: any) => !PLATFORMS.includes(item))) {
        errors.push('平台范围无效。');
    }
    if (campaign?.dailyPublishLimitPerPlatform !== 1 || campaign?.totalPublishLimit !== 14) {
        errors.push('首版活动必须是 7 天、每平台每天 1 条、总计最多 14 次。');
    }
    if (!Number.isInteger(campaign?.budgetCents) || campaign.budgetCents <= 0)
        errors.push('活动预算无效。');
    const startsAt = Date.parse(campaign?.startsAt);
    const expiresAt = Date.parse(campaign?.expiresAt);
    if (!Number.isFinite(startsAt) || !Number.isFinite(expiresAt)
        || startsAt > now.getTime() || expiresAt <= now.getTime()) {
        errors.push('活动授权时间无效或已经过期。');
    }
    for (const platform of campaign?.platforms || []) {
        const accountRef = String(campaign?.accountRefs?.[platform] || '');
        if (!accountRef || accountRef.startsWith('pending-'))
            errors.push(`${platform} 没有可发布账号授权引用。`);
    }
    const forbidden = (campaign?.allowedActions || []).filter((item: any) => FORBIDDEN_ACTIONS.includes(item));
    if (forbidden.length)
        errors.push(`活动错误放行了禁止动作：${forbidden.join('、')}。`);
    if (REQUIRED_ACTIONS.some((action: any) => !campaign?.allowedActions?.includes(action)))
        errors.push('活动缺少首版必需动作授权。');
    if (FORBIDDEN_ACTIONS.some((action: any) => !campaign?.prohibitedActions?.includes(action)))
        errors.push('活动没有完整声明禁止动作。');
    return { passed: errors.length === 0, errors };
}
export function publishPreflight({ campaignId, campaign, contentVersion, reviewReport, platform, scheduledDate }: any, now: any = new Date()) {
    const base = campaignPreflight(campaign, now);
    const errors = [...base.errors];
    const finalCopy = [
        contentVersion?.title,
        contentVersion?.body,
        ...(Array.isArray(contentVersion?.tags) ? contentVersion.tags : []),
    ].join('\n');
    const requiredChecks = ['facts', 'privacy', 'rights', 'media', 'claims', 'grantScope', 'duplicate'];
    if (reviewReport?.status !== 'passed' || requiredChecks.some((key: any) => reviewReport?.checks?.[key] !== true)) {
        errors.push('机器审核没有全部通过。');
    }
    if (containsSensitiveContent(finalCopy))
        errors.push('最终平台文案包含敏感凭据、本机路径或内部数据。');
    if (containsUnsupportedPromise(finalCopy))
        errors.push('最终平台文案包含夸大或无法保证的承诺。');
    if (!campaign?.platforms?.includes(platform))
        errors.push('平台不在活动授权范围内。');
    if (contentVersion?.platform !== platform || !contentVersion?.contentVersionId || !contentVersion?.checksum) {
        errors.push('内容版本与平台不匹配或缺少血缘。');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(scheduledDate || '')))
        errors.push('发布日期格式无效。');
    const receipts = Array.isArray(campaign?.receipts) ? campaign.receipts : [];
    if (receipts.some((item: any) => item.platform === platform && item.contentChecksum === contentVersion?.checksum)) {
        errors.push('同平台已经发布过相同文件哈希。');
    }
    const idempotencyKey = [
        campaignId,
        platform,
        contentVersion?.contentVersionId,
        scheduledDate
    ].join(':');
    return { passed: errors.length === 0, errors, idempotencyKey };
}
function containsSensitiveContent(value: any) {
    return /(?:\b(?:sk|api)[-_][A-Za-z0-9]{12,}\b|Bearer\s+[A-Za-z0-9._-]{12,}|(?:token|cookie|password|secret|api[_ -]?key)\s*[:=]\s*\S{6,}|file:\/\/|\/Users\/|[A-Za-z]:\\|聊天原文|客户数据|内部账号)/i
        .test(String(value || ''));
}
function containsUnsupportedPromise(value: any) {
    return /(?:保证|必然|百分之百|100%|稳赚|无风险|一定能|立刻暴涨|播放量翻倍)/i
        .test(String(value || ''));
}
export function assertAgentToolGrant(config: any, agentId: any, toolName: any) {
    const policy = validateExactAgentToolPolicy(config);
    if (!policy.ok) {
        throw coded('agent_tool_policy_invalid', '岗位工具授权配置不符合 M5 最小岗位bundle，禁止执行。');
    }
    const grants = config?.agentToolGrants;
    const allowed = grants && Array.isArray(grants[agentId]) ? grants[agentId] : [];
    if (!allowed.includes(toolName))
        throw coded('agent_tool_denied', '当前岗位未获该工具权限。');
}
export function safeRelativePath(value: any) {
    const text = String(value || '').trim().replaceAll('\\', '/');
    if (!text || text.startsWith('/') || text.split('/').some((part: any) => !part || part === '.' || part === '..')) {
        throw coded('invalid_relative_path', '产物路径必须是受控工作区内的相对路径。');
    }
    return text;
}
export function sha256(buffer: any) {
    return `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
}
export function coded(code: any, message: any) {
    const error = new Error(message);
    (error as any).code = code;
    return error;
}

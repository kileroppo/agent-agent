import {
  M5_ALLOWED_PUBLISH_ACTIONS,
  M5_PLATFORMS,
  M5_PROHIBITED_PUBLISH_ACTIONS,
  M5_SCHEMA_IDS,
} from '@agent-army/m5-contracts';

const CAMPAIGN_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const ACCOUNT_REF = /^(?:connection:)?[a-z0-9][a-z0-9:_-]{5,159}$/i;

export class ContentCampaignError extends Error {}

export function normalizeCampaignDraft(input, now) {
  rejectSecrets(input);
  const campaignId = safeText(input.campaignId, 64);
  if (!CAMPAIGN_ID.test(campaignId)) throw new ContentCampaignError('campaignId 只允许3到64位小写字母、数字和连字符。');
  const startDate = safeDateOnly(input.startDate);
  const themes = Array.isArray(input.themes) ? input.themes.map((item) => safeText(item, 160)) : [];
  if (themes.length !== 7 || themes.some((item) => !item)) throw new ContentCampaignError('必须提供连续7天的7个非空主题。');
  const accountRefs = {};
  for (const platform of M5_PLATFORMS) {
    const ref = safeText(input.accountRefs?.[platform], 160);
    if (!ref) throw new ContentCampaignError(`缺少${platform}账号引用；只允许引用，不接收登录态或 Cookie。`);
    if (!ACCOUNT_REF.test(ref) || /(?:^|[:_-])(bearer|cookie|token|session|password|secret)(?:$|[:_-])/i.test(ref)) {
      throw new ContentCampaignError(`${platform}账号只能提交受控连接引用，不能提交 Bearer、Cookie、Token 或登录态。`);
    }
    accountRefs[platform] = ref;
  }
  const budgetCents = Math.round(Number(input.budgetUsd) * 100);
  if (!Number.isInteger(budgetCents) || budgetCents <= 0) throw new ContentCampaignError('活动预算必须是大于0的美元金额。');
  const createdAt = now.toISOString();
  const expiresAt = new Date(`${startDate}T23:59:59.999+08:00`);
  expiresAt.setDate(expiresAt.getDate() + 6);
  return {
    campaignId,
    startDate,
    themes,
    assetRightsBasis:safeText(input.assetRightsBasis, 200)
      || '活动声明：仅使用本机自产素材与活动授权生成素材。',
    grant:{
      schemaVersion:M5_SCHEMA_IDS.CAMPAIGN_GRANT,
      status:'draft',
      platforms:[...M5_PLATFORMS],
      accountRefs,
      themeScope:safeText(input.themeScope, 160) || 'AI Agent 实战',
      startsAt:new Date(`${startDate}T00:00:00+08:00`).toISOString(),
      expiresAt:expiresAt.toISOString(),
      dailyPublishLimitPerPlatform:1,
      totalPublishLimit:14,
      allowedActions:[...M5_ALLOWED_PUBLISH_ACTIONS],
      prohibitedActions:[...M5_PROHIBITED_PUBLISH_ACTIONS],
      budgetCents,
      createdAt,
      approvedAt:null,
      approvedBy:null,
      pausedAt:null,
      pauseReason:null,
    },
  };
}

export function requireCampaignGrant(item) {
  const grant = item.campaignGrant;
  if (!grant || grant.schemaVersion !== M5_SCHEMA_IDS.CAMPAIGN_GRANT) throw new ContentCampaignError('活动缺少有效 CampaignGrant。');
  return grant;
}

export function requireActiveCampaignGrant(item, now) {
  const grant = requireCampaignGrant(item);
  if (grant.status !== 'active') throw new ContentCampaignError('活动未处于已授权运行状态。');
  const startsAt = Date.parse(grant.startsAt);
  const expiresAt = Date.parse(grant.expiresAt);
  if (!Number.isFinite(startsAt) || !Number.isFinite(expiresAt) || startsAt >= expiresAt) throw new ContentCampaignError('活动授权期限无效。');
  if (startsAt > now.getTime()) throw new ContentCampaignError('活动授权尚未开始。');
  if (expiresAt <= now.getTime()) throw new ContentCampaignError('活动授权已经过期。');
  return grant;
}

export function safeCampaignGrantView(grant) {
  return {
    schemaVersion:grant.schemaVersion || null,
    status:grant.status || 'unknown',
    platforms:Array.isArray(grant.platforms) ? grant.platforms : [],
    accountRefs:grant.accountRefs || {},
    themeScope:grant.themeScope || null,
    startsAt:grant.startsAt || null,
    expiresAt:grant.expiresAt || null,
    dailyPublishLimitPerPlatform:Number(grant.dailyPublishLimitPerPlatform || 0),
    totalPublishLimit:Number(grant.totalPublishLimit || 0),
    allowedActions:Array.isArray(grant.allowedActions) ? grant.allowedActions : [],
    prohibitedActions:Array.isArray(grant.prohibitedActions) ? grant.prohibitedActions : [],
    budgetCents:Number(grant.budgetCents || 0),
    approvedAt:grant.approvedAt || null,
    pluginApproval:grant.pluginApproval || null,
  };
}

export function samePluginApproval(left, right) {
  return ['schemaVersion', 'pluginId', 'pluginKey', 'version', 'manifestHash', 'configHash']
    .every((key) => left?.[key] === right?.[key]);
}

export function campaignNextAction(status) {
  if (status === 'draft') return '负责人确认账号、期限、14次上限和预算后批准活动。';
  if (status === 'paused') return '查看暂停原因；确认恢复位置后再恢复。';
  if (status === 'active') return 'Paperclip 从当前 Case 阶段继续，不重新生成已验证产物。';
  if (status === 'stopped') return '活动已停止；重新运行必须创建新的授权草案。';
  return '检查 Paperclip 活动记录。';
}

function rejectSecrets(input) {
  const queue = [input];
  const denied = /^(cookie|cookies|token|tokens|password|authorization|api[-_]?key|secret|secrets|credential|credentials|session|login[-_]?state)$/i;
  while (queue.length) {
    const value = queue.pop();
    if (!value || typeof value !== 'object') continue;
    for (const [key, child] of Object.entries(value)) {
      if (denied.test(key)) throw new ContentCampaignError('活动接口只接受账号引用，禁止提交 Cookie、Token、Key、密码或登录态。');
      if (child && typeof child === 'object') queue.push(child);
    }
  }
}

function safeDateOnly(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00+08:00`))) {
    throw new ContentCampaignError('startDate 必须是有效的 YYYY-MM-DD 日期。');
  }
  return text;
}

function safeText(value, maxLength) {
  return String(value || '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, maxLength);
}

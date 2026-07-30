import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertAgentToolGrant,
  campaignPreflight,
  publishPreflight,
  safeRelativePath
} from '../src/policy.js';
import { M5_ROLE_TOOL_BUNDLES } from '../src/role-tool-bundles.js';

const now = new Date('2026-07-30T00:00:00.000Z');

function validCampaign() {
  return {
    schemaVersion:'agent.army/campaign-grant/v1',
    themeScope:'AI Agent 实战',
    platforms:['douyin', 'xiaohongshu'],
    dailyPublishLimitPerPlatform:1,
    totalPublishLimit:14,
    budgetCents:500,
    startsAt:'2026-07-30T00:00:00.000Z',
    expiresAt:'2026-08-06T00:00:00.000Z',
    accountRefs:{ douyin:'account:douyin:test', xiaohongshu:'account:xhs:test' },
    allowedActions:['upload', 'fill_metadata', 'schedule_or_publish', 'read_own_metrics'],
    prohibitedActions:['direct_message', 'comment', 'follow', 'paid_promotion', 'payment', 'account_settings', 'delete_history'],
    receipts:[]
  };
}

test('活动预检接受首版严格授权范围', () => {
  assert.deepEqual(campaignPreflight(validCampaign(), now), { passed:true, errors:[] });
});

test('CampaignGrant只接受content-campaign-service canonical字段', () => {
  const campaign = validCampaign();
  campaign.totalLimit = 14;
  delete campaign.totalPublishLimit;
  assert.equal(campaignPreflight(campaign, now).passed, false);
  delete campaign.totalLimit;
  campaign.totalPublishLimit = 14;
  assert.equal(campaignPreflight(campaign, now).passed, true);
});

test('发布门禁拒绝重复哈希和不完整审核', () => {
  const campaign = validCampaign();
  campaign.receipts.push({ platform:'douyin', contentChecksum:'sha256:same' });
  const result = publishPreflight({
    campaignId:'campaign-1',
    campaign,
    platform:'douyin',
    scheduledDate:'2026-07-30',
    contentVersion:{ contentVersionId:'v1', platform:'douyin', checksum:'sha256:same' },
    reviewReport:{ status:'passed', checks:{ facts:true } }
  }, now);
  assert.equal(result.passed, false);
  assert.match(result.errors.join('\n'), /机器审核|相同文件哈希/);
});

test('发布门禁重新检查最终平台文案的隐私和夸大承诺', () => {
  const reviewReport = {
    status:'passed',
    checks:{
      facts:true,
      privacy:true,
      rights:true,
      media:true,
      claims:true,
      grantScope:true,
      duplicate:true,
    },
  };
  const result = publishPreflight({
    campaignId:'campaign-1',
    campaign:validCampaign(),
    platform:'douyin',
    scheduledDate:'2026-07-30',
    contentVersion:{
      contentVersionId:'v1',
      platform:'douyin',
      checksum:'sha256:new',
      title:'保证播放量翻倍',
      body:'调试信息 file:///Users/operator/private.txt',
      tags:['AI Agent'],
    },
    reviewReport,
  }, now);
  assert.equal(result.passed, false);
  assert.match(result.errors.join('\n'), /最终平台文案包含敏感|最终平台文案包含夸大/);
});

test('岗位工具白名单默认拒绝且不能通配', () => {
  assert.throws(
    () => assertAgentToolGrant({ agentToolGrants:{} }, 'agent-1', 'stepfun-tts'),
    /最小岗位bundle/,
  );
  const agentRoleBindings = Object.fromEntries(
    Object.keys(M5_ROLE_TOOL_BUNDLES).map((role, index) => [role, `agent-${index}`]),
  );
  const agentToolGrants = Object.fromEntries(
    Object.entries(M5_ROLE_TOOL_BUNDLES).map(([role, tools]) => [
      agentRoleBindings[role],
      [...tools],
    ]),
  );
  assert.doesNotThrow(() => assertAgentToolGrant({
    agentRoleBindings,
    agentToolGrants,
  }, agentRoleBindings['content-creator'], 'stepfun-tts'));
});

test('受控工作区拒绝绝对路径和穿越', () => {
  assert.equal(safeRelativePath('day-1/master.mp4'), 'day-1/master.mp4');
  assert.throws(() => safeRelativePath('../secret'), /相对路径/);
  assert.throws(() => safeRelativePath('/tmp/file'), /相对路径/);
});

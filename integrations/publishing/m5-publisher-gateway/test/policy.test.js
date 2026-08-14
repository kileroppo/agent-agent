import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IMMEDIATE_PUBLISH_RECOVERY_ACTION,
  calendarDateInShanghai,
  publishIdempotencyKey,
  validatePublishRequest,
} from '../src/policy.ts';

const CHECKSUM = `sha256:${'a'.repeat(64)}`;

test('上海执行日跨 UTC 午夜切换，冬夏均固定使用 Asia/Shanghai 而非主机时区', () => {
  for (const month of ['01', '07']) {
    assert.equal(
      calendarDateInShanghai(new Date(`2026-${month}-15T15:59:59.999Z`)),
      `2026-${month}-15`,
    );
    assert.equal(
      calendarDateInShanghai(new Date(`2026-${month}-15T16:00:00.000Z`)),
      `2026-${month}-16`,
    );
  }
});

test('即时发布只接受上海当前日期，并保留 CampaignGrant 区间校验', () => {
  const now = new Date('2026-07-30T16:00:00.000Z');
  const current = publishRequest({ scheduledDate:'2026-07-31' });
  assert.deepEqual(validatePublishRequest(current, now), {
    passed:true,
    errors:[],
    idempotencyKey:current.idempotencyKey,
  });

  const startsAfterLocalMidnight = publishRequest({
    scheduledDate:'2026-07-31',
    grant:grant({ startsAt:'2026-07-31T01:00:00.000Z' }),
  });
  const result = validatePublishRequest(
    startsAfterLocalMidnight,
    new Date('2026-07-31T02:00:00.000Z'),
  );
  assert.equal(result.passed, false);
  assert.match(result.errors.join(' '), /超出活动授权期限/);
});

test('历史补跑和未来日期都给出唯一重排恢复动作', () => {
  for (const scheduledDate of ['2026-07-30', '2026-08-01']) {
    assert.throws(
      () => validatePublishRequest(
        publishRequest({ scheduledDate }),
        new Date('2026-07-31T04:00:00.000Z'),
      ),
      (error) => {
        assert.equal(error.code, 'publisher_scheduled_date_mismatch');
        assert.deepEqual(error.recoveryAction, {
          action:IMMEDIATE_PUBLISH_RECOVERY_ACTION,
          instruction:'将平台 Case 重排到当前上海日期后重新执行；禁止直接补发历史 Case 或提前发布未来 Case。',
          scheduledDate,
          executionDate:'2026-07-31',
          timeZone:'Asia/Shanghai',
        });
        return true;
      },
    );
  }
});

function grant(overrides = {}) {
  return {
    schemaVersion:'agent.army/campaign-grant/v1',
    status:'active',
    platforms:['douyin', 'xiaohongshu'],
    accountRefs:{
      douyin:'account:douyin:test',
      xiaohongshu:'account:xhs:test',
    },
    startsAt:'2026-07-29T00:00:00.000Z',
    expiresAt:'2026-08-06T00:00:00.000Z',
    themeScope:'AI Agent 实战',
    totalPublishLimit:14,
    dailyPublishLimitPerPlatform:1,
    allowedActions:['upload', 'fill_metadata', 'schedule_or_publish', 'read_own_metrics'],
    prohibitedActions:[
      'direct_message',
      'comment',
      'follow',
      'paid_promotion',
      'payment',
      'account_settings',
      'delete_history',
    ],
    budgetCents:625,
    ...overrides,
  };
}

function publishRequest(overrides = {}) {
  const value = {
    campaignId:'campaign-m5-policy',
    grant:grant(),
    platform:'douyin',
    contentVersionId:'content-v1',
    contentChecksum:CHECKSUM,
    scheduledDate:'2026-07-31',
    mediaPath:'douyin.mp4',
    title:'AI Agent 实战',
    body:'即时发布日期门禁',
    tags:['AI Agent'],
    reviewReport:{
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
    },
    ...overrides,
  };
  value.idempotencyKey = publishIdempotencyKey(value);
  return value;
}

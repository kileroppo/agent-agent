import assert from 'node:assert/strict';
import test from 'node:test';
import { CredentialDecayWarner } from '../src/credential-decay-warner.ts';

test('CredentialDecayWarner 提前识别临期凭据并触发预警', async () => {
  let now = 1700000000000;
  const triggeredAlerts = [];

  const warner = new CredentialDecayWarner({
    warningWindowMs: 48 * 3600 * 1000,
    onDecaying: (alert) => { triggeredAlerts.push(alert); },
    now: () => now,
  });

  // 1. 正常凭据 (5 天后过期)
  warner.register({
    connectionId: 'conn-safe',
    provider: 'bilibili',
    name: 'B站只读Cookie',
    expiresAt: new Date(now + 5 * 24 * 3600 * 1000).toISOString(),
  });

  // 2. 临期凭据 (12 小时后过期)
  warner.register({
    connectionId: 'conn-decaying',
    provider: 'xiaohongshu',
    name: '小红书创作者Cookie',
    expiresAt: new Date(now + 12 * 3600 * 1000).toISOString(),
  });

  const alerts = await warner.checkAll(now);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].connectionId, 'conn-decaying');
  assert.equal(alerts[0].status, 'decaying');
  assert.equal(alerts[0].remainingHours, 12);
  assert.equal(triggeredAlerts.length, 1);
});

test('CredentialDecayWarner 识别探针风控失效凭据', async () => {
  let now = 1700000000000;
  const warner = new CredentialDecayWarner({ now: () => now });

  warner.register({
    connectionId: 'conn-probe-fail',
    provider: 'douyin',
    name: '抖音开放平台',
    probeFn: async () => ({ ok: false, reason: '出现滑动验证码，需人工介入' }),
  });

  const alert = await warner.checkCredential('conn-probe-fail', now);
  assert.ok(alert);
  assert.equal(alert.status, 'probe_failed');
  assert.ok(alert.reason.includes('滑动验证码'));
});

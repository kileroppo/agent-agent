import assert from 'node:assert/strict';
import test from 'node:test';
import { ProactiveAnomalyAlerting } from '../src/proactive-anomaly-alerting.ts';

test('ProactiveAnomalyAlerting 正确识别内存超限与任务失败突刺', async () => {
  let now = 1700000000000;
  const recentTime = new Date(now - 60 * 1000).toISOString();

  const tasks = [
    { taskId: 'fail-1', status: 'failed', updatedAt: recentTime },
    { taskId: 'fail-2', status: 'failed', updatedAt: recentTime },
    { taskId: 'fail-3', status: 'failed', updatedAt: recentTime },
  ];

  const store = {
    async list() { return tasks; },
  };

  const sentCards = [];
  const alertSender = {
    async sendCard(card) {
      sentCards.push(card);
      return { success: true, messageId: 'alert-msg-1' };
    },
  };

  const alerting = new ProactiveAnomalyAlerting({
    store,
    alertSender,
    memoryRssThresholdBytes: 400 * 1024 * 1024,
    failureSpikeThreshold: 3,
    now: () => now,
  });

  const res = await alerting.evaluateAndAlert({
    now,
    rssBytes: 600 * 1024 * 1024, // 600MB > 400MB
    serviceStates: { 'xiaod': 'offline' },
  });

  assert.equal(res.status, 'reconciled');
  assert.equal(res.incidentsFound, 3); // mem, service_offline, task_failure_spike
  assert.equal(res.alertsSent, 3);
  assert.equal(sentCards.length, 3);

  // 验证卡片结构与脱敏
  const memCard = sentCards.find((c) => c.header.title.content.includes('内存'));
  assert.ok(memCard);
  assert.equal(memCard.header.template, 'orange');

  const svcCard = sentCards.find((c) => c.header.title.content.includes('离线'));
  assert.ok(svcCard);
  assert.equal(svcCard.header.template, 'red');
});

test('ProactiveAnomalyAlerting 遵守冷却防抖，不重复推送告警', async () => {
  let now = 1700000000000;
  const sentCards = [];
  const alertSender = {
    async sendCard(card) {
      sentCards.push(card);
      return { success: true };
    },
  };

  const alerting = new ProactiveAnomalyAlerting({
    alertSender,
    cooldownMs: 15 * 60 * 1000, // 15 min
    now: () => now,
  });

  // 第一次触发
  await alerting.evaluateAndAlert({
    now,
    rssBytes: 800 * 1024 * 1024,
  });
  assert.equal(sentCards.length, 1);

  // 5 分钟后再次探测 -> 处于冷却期，被抑制
  now += 5 * 60 * 1000;
  const res2 = await alerting.evaluateAndAlert({
    now,
    rssBytes: 800 * 1024 * 1024,
  });
  assert.equal(res2.alertsSuppressed, 1);
  assert.equal(sentCards.length, 1);

  // 16 分钟后再次探测 -> 冷却结束，重新告警
  now += 11 * 60 * 1000;
  const res3 = await alerting.evaluateAndAlert({
    now,
    rssBytes: 800 * 1024 * 1024,
  });
  assert.equal(res3.alertsSent, 1);
  assert.equal(sentCards.length, 2);
});

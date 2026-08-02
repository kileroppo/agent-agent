import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {
  XHS_OWN_METRIC_CONTEXT_SCHEMA,
  XHS_OWN_METRIC_OBSERVATION_SCHEMA,
  normalizeXhsOwnMetricObservation,
  xhsOwnMetricCollectionKey,
} from '../src/xhs-own-metrics-contract.js';

const RECEIPT_ID = '11111111-1111-4111-8111-111111111111';
const SELECTOR_CHECKSUM = `sha256:${'a'.repeat(64)}`;

test('本人指标观察被标准化为 receiptId+checkpoint 唯一身份和四项精确整数', () => {
  const input = fixture();
  const result = normalizeXhsOwnMetricObservation(input);

  assert.deepEqual(result, {
    collectionKey:`${RECEIPT_ID}:2h`,
    checkpoint:'2h',
    receiptId:RECEIPT_ID,
    platform:'xiaohongshu',
    accountRef:'account:xhs:primary',
    externalContentId:'note-owned-1',
    contentVersionId:'content-v1',
    collectedAt:'2026-07-30T10:00:00.000Z',
    metrics:{
      views:1234,
      likes:56,
      saves:7,
      comments:0,
    },
    source:{
      kind:'official_creator_ui',
      origin:'https://pro.xiaohongshu.com',
      pageKind:'own_note_detail',
      selectorBundleVersion:'1.0.0',
      selectorChecksum:SELECTOR_CHECKSUM,
      approvalRef:'paperclip:xhs-metrics-selector-v1',
      capturedAt:'2026-07-30T09:59:58.000Z',
      rawMetrics:{
        views:'1,234',
        likes:'56',
        saves:7,
        comments:0,
      },
    },
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.metrics), true);
  assert.equal(Object.isFrozen(result.source.rawMetrics), true);
});

test('collectionKey 只能由同一 receiptId 和固定检查点派生', () => {
  assert.equal(
    xhsOwnMetricCollectionKey(RECEIPT_ID, '72h'),
    `${RECEIPT_ID}:72h`,
  );
  for (const mutate of [
    (input) => { input.collectionKey = `${RECEIPT_ID}:24h`; },
    (input) => { input.checkpoint = '4h'; },
    (input) => { input.trustedReceipt.receiptId = 'caller-controlled'; },
  ]) {
    const input = fixture();
    mutate(input);
    assert.throws(
      () => normalizeXhsOwnMetricObservation(input),
      (error) => [
        'xhs_metric_collection_identity_invalid',
        'xhs_metric_receipt_invalid',
      ].includes(error.code),
    );
  }
});

test('origin、pageKind、账号、笔记、selector版本或哈希任一漂移都拒绝', () => {
  for (const [target, field, value] of [
    ['observation', 'origin', 'https://www.xiaohongshu.com'],
    ['observation', 'pageKind', 'public_note'],
    ['observation', 'accountRef', 'account:xhs:other'],
    ['observation', 'externalContentId', 'note-other'],
    ['observation', 'selectorBundleVersion', '1.0.1'],
    ['observation', 'selectorChecksum', `sha256:${'b'.repeat(64)}`],
    ['trustedContext', 'accountRef', 'account:xhs:other'],
    ['trustedContext', 'origin', 'https://evil.example'],
    ['trustedContext', 'selectorBundleVersion', 'latest'],
    ['trustedContext', 'selectorChecksum', 'sha256:invalid'],
    ['trustedContext', 'approvalRef', 'caller-controlled'],
  ]) {
    const input = fixture();
    input[target][field] = value;
    assert.throws(
      () => normalizeXhsOwnMetricObservation(input),
      (error) => [
        'xhs_metric_observation_invalid',
        'xhs_metric_observation_identity_mismatch',
        'xhs_metric_trusted_context_invalid',
      ].includes(error.code),
      `${target}.${field}`,
    );
  }
});

test('两个获批官方创作后台 origin 均可用，但观察时间必须在采集前五分钟内', () => {
  const creator = fixture();
  creator.trustedContext.origin = 'https://creator.xiaohongshu.com';
  creator.observation.origin = 'https://creator.xiaohongshu.com';
  assert.equal(
    normalizeXhsOwnMetricObservation(creator).source.origin,
    'https://creator.xiaohongshu.com',
  );

  const futureObservation = fixture();
  futureObservation.observation.capturedAt = '2026-07-30T10:00:01.000Z';
  assert.throws(
    () => normalizeXhsOwnMetricObservation(futureObservation),
    { code:'xhs_metric_observation_invalid' },
  );

  const staleObservation = fixture();
  staleObservation.observation.capturedAt = '2026-07-30T09:54:59.999Z';
  assert.throws(
    () => normalizeXhsOwnMetricObservation(staleObservation),
    { code:'xhs_metric_observation_invalid' },
  );
});

test('缩写、区间、小数、负数、空值和超出安全整数都不能伪装成精确指标', () => {
  for (const value of [
    '1.2万',
    '100-200',
    '12.0',
    '-1',
    '--',
    '',
    null,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    const input = fixture();
    input.observation.metrics.views = value;
    assert.throws(
      () => normalizeXhsOwnMetricObservation(input),
      { code:'xhs_metric_value_not_exact' },
    );
  }
});

test('观察与批准上下文拒绝额外字段，避免 Cookie、Token 或页面原文进入快照', () => {
  for (const target of ['trustedContext', 'observation']) {
    const input = fixture();
    input[target].cookie = 'must-not-enter-contract';
    assert.throws(
      () => normalizeXhsOwnMetricObservation(input),
      (error) => [
        'xhs_metric_observation_invalid',
        'xhs_metric_trusted_context_invalid',
      ].includes(error.code),
    );
  }
});

test('契约模块不导入浏览器、网络、进程或文件执行能力', async () => {
  const source = await fs.readFile(
    new URL('../src/xhs-own-metrics-contract.js', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /node:(?:child_process|fs|http|https|net)|fetch\s*\(|cua-driver|browser_/,
  );
  assert.match(
    source,
    /^import \{ M5_PLATFORM_IDS \} from '@agent-army\/m5-contracts';/,
  );
  assert.match(source, /import \{ coded \} from '\.\/policy\.js';/);
});

function fixture() {
  return {
    trustedReceipt:{
      receiptId:RECEIPT_ID,
      platform:'xiaohongshu',
      accountRef:'account:xhs:primary',
      externalContentId:'note-owned-1',
      contentVersionId:'content-v1',
    },
    checkpoint:'2h',
    collectionKey:`${RECEIPT_ID}:2h`,
    collectedAt:'2026-07-30T10:00:00.000Z',
    trustedContext:{
      schemaVersion:XHS_OWN_METRIC_CONTEXT_SCHEMA,
      source:'paperclip',
      approvalRef:'paperclip:xhs-metrics-selector-v1',
      origin:'https://pro.xiaohongshu.com',
      pageKind:'own_note_detail',
      accountRef:'account:xhs:primary',
      selectorBundleVersion:'1.0.0',
      selectorChecksum:SELECTOR_CHECKSUM,
    },
    observation:{
      schemaVersion:XHS_OWN_METRIC_OBSERVATION_SCHEMA,
      kind:'ok',
      origin:'https://pro.xiaohongshu.com',
      pageKind:'own_note_detail',
      accountRef:'account:xhs:primary',
      externalContentId:'note-owned-1',
      selectorBundleVersion:'1.0.0',
      selectorChecksum:SELECTOR_CHECKSUM,
      capturedAt:'2026-07-30T09:59:58.000Z',
      metrics:{
        views:'1,234',
        likes:'56',
        saves:7,
        comments:0,
      },
    },
  };
}

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertContentVersionIdentity,
  assertMetricSnapshotLineage,
  assertPublishReceiptIdentity,
  trustedContentVersionProducts,
  trustedPublishReceiptProducts,
} from '../src/trusted-publish-lineage.js';

const RECEIPT = Object.freeze({
  receiptId:'11111111-1111-4111-8111-111111111111',
  campaignId:'campaign-1',
  platform:'douyin',
  accountRef:'account:douyin:primary',
  connectorMode:'fake',
  contentVersionId:'content-v1',
  externalContentId:'content-external-1',
  evidence:'publisher:evidence:1',
  publishedAt:'2026-08-13T00:00:00.000Z',
});

test('可信发布来源链复用标准 M5 Work Product 信任并保持候选顺序', () => {
  const product = (id, sourceTrust = null) => ({
    id,
    kind:'work_product',
    type:'artifact',
    provider:'agent-army.publisher-gateway',
    sourceTrust,
    status:'active',
    healthStatus:'healthy',
    metadata:{
      schemaVersion:'agent.army/publish-receipt/v1',
      kind:'PublishReceipt',
      receipt:structuredClone(RECEIPT),
    },
  });
  const candidates = trustedPublishReceiptProducts({
    items:[product('first'), product('quarantined', {}), product('second')],
  });
  assert.deepEqual(candidates.map(({ id }) => id), ['first', 'second']);

  const legacyContent = product('content');
  delete legacyContent.type;
  legacyContent.provider = 'agent-army.content-autonomy';
  legacyContent.metadata = {
    schemaVersion:'agent.army/content-version/v1',
    kind:'ContentVersion',
    contentVersion:{},
  };
  assert.deepEqual(
    trustedContentVersionProducts([legacyContent]).map(({ id }) => id),
    ['content'],
  );
});

test('可信发布来源链集中核验 ContentVersion、PublishReceipt 和 MetricSnapshot 身份', () => {
  const content = assertContentVersionIdentity({
    platform:'douyin',
    contentVersionId:'content-v1',
    checksum:`sha256:${'a'.repeat(64)}`,
    mediaPath:'campaign/day/video.mp4',
    title:'标题',
    body:'正文',
    tags:['Agent'],
  });
  const receipt = assertPublishReceiptIdentity(RECEIPT, { requireMetricIdentity:true });
  const dueAt = new Date('2026-08-13T02:00:00.000Z');
  const snapshot = assertMetricSnapshotLineage({
    snapshot:{
      snapshotId:'snapshot-1',
      receiptId:receipt.receiptId,
      collectionKey:`${receipt.receiptId}:2h`,
      platform:receipt.platform,
      contentVersionId:content.contentVersionId,
      collectedAt:dueAt.toISOString(),
      metrics:{ views:1 },
    },
    receipt,
    expectedCollectionKey:`${receipt.receiptId}:2h`,
    dueAt,
  });
  assert.equal(snapshot.snapshotId, 'snapshot-1');

  assert.throws(() => assertMetricSnapshotLineage({
    snapshot:{ ...snapshot, receiptId:'other' },
    receipt,
    expectedCollectionKey:`${receipt.receiptId}:2h`,
    dueAt,
  }), /MetricSnapshot/);
});

test('身份核验保持错误工厂、日期强制转换、own identity 与克隆时机语义', () => {
  class LineageError extends Error {
    constructor(message, code) {
      super(message);
      this.code = code;
    }
  }
  assert.throws(
    () => assertPublishReceiptIdentity({}, {
      invalid:(message, code) => new LineageError(message, code),
    }),
    (error) => error instanceof LineageError
      && error.code === 'publish_receipt_identity_invalid',
  );

  const content = {
    platform:'douyin',
    contentVersionId:'content-v1',
    checksum:`sha256:${'a'.repeat(64)}`,
    mediaPath:'campaign/day/video.mp4',
    title:'标题',
    body:'正文',
    tags:['Agent'],
  };
  assert.equal(assertContentVersionIdentity(content), content);

  const receiptInput = { ...RECEIPT, publishedAt:new Date(RECEIPT.publishedAt) };
  const receipt = assertPublishReceiptIdentity(receiptInput, { requireMetricIdentity:true });
  assert.notEqual(receipt, receiptInput);
  assert.ok(receipt.publishedAt instanceof Date);

  const dueAt = new Date('2026-08-13T02:00:00.000Z');
  const inheritedIdentity = Object.create({ campaignId:'campaign-forged' });
  Object.assign(inheritedIdentity, {
    snapshotId:'snapshot-inherited',
    receiptId:receipt.receiptId,
    collectionKey:`${receipt.receiptId}:2h`,
    platform:receipt.platform,
    contentVersionId:receipt.contentVersionId,
    collectedAt:new Date(dueAt),
    metrics:{ views:1 },
  });
  const snapshot = assertMetricSnapshotLineage({
    snapshot:inheritedIdentity,
    receipt,
    expectedCollectionKey:`${receipt.receiptId}:2h`,
    dueAt,
  });
  assert.notEqual(snapshot, inheritedIdentity);
  assert.equal(Object.hasOwn(snapshot, 'campaignId'), false);
  assert.ok(snapshot.collectedAt instanceof Date);

  assert.throws(() => assertMetricSnapshotLineage({
    snapshot:{ ...inheritedIdentity, campaignId:'campaign-forged' },
    receipt,
    expectedCollectionKey:`${receipt.receiptId}:2h`,
    dueAt,
  }), /MetricSnapshot/);
});

test('小红书官方指标证据按键集合而非插入顺序核验，并拒绝额外键', () => {
  const receipt = {
    ...RECEIPT,
    platform:'xiaohongshu',
    accountRef:'account:xhs:primary',
    connectorMode:'real:xiaohongshu_own_metrics_cua',
  };
  const dueAt = new Date('2026-08-13T02:00:00.000Z');
  const source = {
    selectorChecksum:`sha256:${'a'.repeat(64)}`,
    rawMetrics:{ views:'10', saves:'2', likes:'3', comments:'0' },
    pageKind:'own_note_detail',
    origin:'https://pro.xiaohongshu.com',
    kind:'official_creator_ui',
    capturedAt:'2026-08-13T01:59:58.000Z',
    approvalRef:'paperclip:selector-v1',
    selectorBundleVersion:'1.0.0',
  };
  const input = {
    snapshotId:'snapshot-xhs',
    receiptId:receipt.receiptId,
    collectionKey:`${receipt.receiptId}:2h`,
    platform:receipt.platform,
    accountRef:receipt.accountRef,
    connectorMode:receipt.connectorMode,
    externalContentId:receipt.externalContentId,
    contentVersionId:receipt.contentVersionId,
    collectedAt:dueAt.toISOString(),
    metrics:{ views:10, saves:2, likes:3, comments:0 },
    source,
  };
  assert.equal(assertMetricSnapshotLineage({
    snapshot:input,
    receipt,
    expectedCollectionKey:input.collectionKey,
    dueAt,
  }).snapshotId, 'snapshot-xhs');

  assert.throws(() => assertMetricSnapshotLineage({
    snapshot:{ ...input, source:{ ...source, extra:'forged' } },
    receipt,
    expectedCollectionKey:input.collectionKey,
    dueAt,
  }), /MetricSnapshot/);
});

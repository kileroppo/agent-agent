// 切片 B · 运行时侧证据账本单测（任务 4.1）
//
// 覆盖：schema、0600/0700 权限、按日切分、保留期清理、越界路径拒写、
// assertNoSecretShaped、digestRef 稳定性与不可逆，以及固定种子的 secret 形态注入属性式测试。
//
// 原生 node --test，不引入 Jest / Vitest / fast-check（需求 3.9）。
//
// **Validates: Requirements 2.4, 2.5, 2.8, 2.11**

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  EVIDENCE_DIRECTORY_NAME,
  FEISHU_COMMANDER_CHAIN_EVIDENCE_SCHEMA,
  assertNoSecretShaped,
  createFeishuCommanderChainEvidenceLedger,
  digestRef,
  evidenceFileNameForDate,
  readCommanderChainEvidenceFiles,
} from '../src/feishu-commander-chain-evidence.ts';

// 固定种子：失败时随断言消息一起打印，保证反例可复现。
const PRNG_SEED = 20260818;

async function makeDataDir(context) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chain-evidence-'));
  context.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return dataDir;
}

function ledgerAt(dataDir, isoDate, options = {}) {
  return createFeishuCommanderChainEvidenceLedger({ dataDir, now: () => new Date(isoDate), ...options });
}

async function readLines(dataDir, isoDate) {
  const file = path.join(dataDir, EVIDENCE_DIRECTORY_NAME, evidenceFileNameForDate(new Date(isoDate)));
  const content = await fs.readFile(file, 'utf8');
  return content.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
}

test('4.1 record 落盘 schema/字段齐全，chatRef 与 requesterRef 只以摘要出现', async (context) => {
  const dataDir = await makeDataDir(context);
  const ledger = ledgerAt(dataDir, '2026-08-18T02:03:04.000Z');

  const record = await ledger.record({
    kind: 'ingress_rejected_non_local',
    sourceEventRef: 'feishu:om_evidence_1',
    chatRef: 'oc_chat_evidence_1',
    requesterRef: 'ou_user_evidence_1',
    httpStatus: 403,
    profileAgentId: 'ajun',
    truthLayer: 'reachable',
    nextStep: '在本机执行 npm run diagnose:feishu-chain 定位链路缺口。',
  });

  assert.ok(record);
  assert.equal(record.schemaVersion, FEISHU_COMMANDER_CHAIN_EVIDENCE_SCHEMA);
  assert.equal(record.side, 'ajun-runtime');
  assert.equal(record.recordedAt, '2026-08-18T02:03:04.000Z');
  assert.equal(record.sourceEventRef, 'feishu:om_evidence_1');
  assert.equal(record.httpStatus, 403);
  assert.equal(record.externalActionStarted, false);
  assert.match(record.chatRefDigest, /^sha256:[0-9a-f]{12}$/);
  assert.match(record.requesterRefDigest, /^sha256:[0-9a-f]{12}$/);
  assert.ok(record.outcome.length > 0);

  const serialized = JSON.stringify(record);
  assert.ok(!serialized.includes('oc_chat_evidence_1'), 'chatRef 原值被落盘。');
  assert.ok(!serialized.includes('ou_user_evidence_1'), 'requesterRef 原值被落盘。');

  const [persisted] = await readLines(dataDir, '2026-08-18T02:03:04.000Z');
  assert.deepEqual(persisted, record);
});

test('4.1 目录 0700、文件 0600，同日追加到同一文件、跨日切分新文件', async (context) => {
  const dataDir = await makeDataDir(context);
  await ledgerAt(dataDir, '2026-08-18T01:00:00.000Z').record({ kind: 'no_task_by_design', reason: 'explicit_direct_reply_without_task' });
  await ledgerAt(dataDir, '2026-08-18T09:00:00.000Z').record({ kind: 'no_task_by_design', reason: 'explicit_direct_reply_without_task' });
  await ledgerAt(dataDir, '2026-08-19T01:00:00.000Z').record({ kind: 'diagnosis_completed' });

  const directory = path.join(dataDir, EVIDENCE_DIRECTORY_NAME);
  assert.equal(((await fs.stat(directory)).mode & 0o777), 0o700);
  const day18 = path.join(directory, evidenceFileNameForDate(new Date('2026-08-18T00:00:00.000Z')));
  assert.equal(((await fs.stat(day18)).mode & 0o777), 0o600);
  assert.equal((await readLines(dataDir, '2026-08-18T00:00:00.000Z')).length, 2);
  assert.equal((await readLines(dataDir, '2026-08-19T00:00:00.000Z')).length, 1);
  assert.deepEqual(
    (await fs.readdir(directory)).sort(),
    ['runtime-evidence-2026-08-18.jsonl', 'runtime-evidence-2026-08-19.jsonl'],
  );
});

test('4.1 readRecent 只读最近窗口并按写入顺序返回，超限时取最近若干条', async (context) => {
  const dataDir = await makeDataDir(context);
  await ledgerAt(dataDir, '2026-08-10T01:00:00.000Z').record({ kind: 'no_task_by_design', sourceEventRef: 'feishu:old' });
  await ledgerAt(dataDir, '2026-08-17T01:00:00.000Z').record({ kind: 'no_task_by_design', sourceEventRef: 'feishu:yesterday' });
  await ledgerAt(dataDir, '2026-08-18T01:00:00.000Z').record({ kind: 'ingress_rejected_non_local', sourceEventRef: 'feishu:today-1' });
  await ledgerAt(dataDir, '2026-08-18T02:00:00.000Z').record({ kind: 'ingress_rejected_non_local', sourceEventRef: 'feishu:today-2' });

  const recent = await ledgerAt(dataDir, '2026-08-18T03:00:00.000Z').readRecent();
  assert.deepEqual(
    recent.map((item) => item.sourceEventRef),
    ['feishu:yesterday', 'feishu:today-1', 'feishu:today-2'],
  );

  const limited = await ledgerAt(dataDir, '2026-08-18T03:00:00.000Z').readRecent({ limit: 1 });
  assert.deepEqual(limited.map((item) => item.sourceEventRef), ['feishu:today-2']);

  const wide = await ledgerAt(dataDir, '2026-08-18T03:00:00.000Z').readRecent({ days: 30 });
  assert.equal(wide.length, 4);
});

test('4.1 record 顺带清理超过保留期的旧账本文件', async (context) => {
  const dataDir = await makeDataDir(context);
  await ledgerAt(dataDir, '2026-07-01T01:00:00.000Z').record({ kind: 'no_task_by_design' });
  await ledgerAt(dataDir, '2026-08-18T01:00:00.000Z', { retentionDays: 14 }).record({ kind: 'no_task_by_design' });

  const files = await fs.readdir(path.join(dataDir, EVIDENCE_DIRECTORY_NAME));
  assert.deepEqual(files, ['runtime-evidence-2026-08-18.jsonl'], '超过保留期的旧文件未被清理。');
});

test('4.1 写入失败绝不抛异常：dataDir 不可用时 record 返回 null', async (context) => {
  const blockedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'chain-evidence-blocked-'));
  context.after(() => fs.rm(blockedRoot, { recursive: true, force: true }));
  const blockingFile = path.join(blockedRoot, 'not-a-directory');
  await fs.writeFile(blockingFile, 'x', 'utf8');

  const unwritable = ledgerAt(path.join(blockingFile, 'nested'), '2026-08-18T01:00:00.000Z');
  assert.equal(await unwritable.record({ kind: 'no_task_by_design' }), null);
  assert.deepEqual(await unwritable.readRecent(), []);

  const missingDataDir = ledgerAt('', '2026-08-18T01:00:00.000Z');
  assert.equal(await missingDataDir.record({ kind: 'no_task_by_design' }), null);
  assert.deepEqual(await missingDataDir.readRecent(), []);
});

test('4.1 越界路径拒写：符号链接出去的证据目录不被写入', async (context) => {
  const dataDir = await makeDataDir(context);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'chain-evidence-outside-'));
  context.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.symlink(outside, path.join(dataDir, EVIDENCE_DIRECTORY_NAME));

  const ledger = ledgerAt(dataDir, '2026-08-18T01:00:00.000Z');
  assert.equal(await ledger.record({ kind: 'no_task_by_design' }), null);
  assert.deepEqual(await fs.readdir(outside), [], '越界符号链接目标被写入了证据。');
});

test('4.1 assertNoSecretShaped 拒绝 secret 形态，digestRef 稳定且不可逆', () => {
  assert.equal(digestRef('ou_same_value'), digestRef('ou_same_value'));
  assert.notEqual(digestRef('ou_a'), digestRef('ou_b'));
  assert.equal(digestRef(''), null);
  assert.equal(digestRef(null), null);
  assert.match(digestRef('ou_x'), /^sha256:[0-9a-f]{12}$/);
  assert.ok(!digestRef('ou_x').includes('ou_x'));

  assert.doesNotThrow(() => assertNoSecretShaped({ outcome: '总管入口拒绝了非本机调用。', sourceEventRef: 'feishu:om_1' }));
  for (const shaped of [
    'sk-livetokenvalue1234567890',
    'Bearer abcdefghijklmn',
    'https://open.feishu.cn/authorize?token=abcdefgh',
    'cookie: session=abc',
    'password = hunter2',
    'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5',
  ]) {
    assert.throws(
      () => assertNoSecretShaped({ outcome: shaped }),
      /secret 形态/,
      `未拦截 secret 形态：${shaped}`,
    );
  }
});

test('4.1 属性式（固定种子）：任意注入的 secret 形态都不会出现在落盘内容里', async (context) => {
  const dataDir = await makeDataDir(context);
  const random = createSeededRandom(PRNG_SEED);
  const ledger = ledgerAt(dataDir, '2026-08-18T01:00:00.000Z');

  for (let index = 0; index < 24; index += 1) {
    const secret = randomSecretShaped(random, index);
    const trace = `seed=${PRNG_SEED} index=${index} secret=${JSON.stringify(secret)}`;
    // 无论 secret 出现在哪个字段，落盘内容里都不得出现它的原文。
    await ledger.record({
      kind: 'no_task_by_design',
      sourceEventRef: `feishu:property-${index}`,
      chatRef: secret,
      requesterRef: secret,
      reason: secret,
      outcome: secret,
      nextStep: secret,
    });
    const content = await fs
      .readFile(path.join(dataDir, EVIDENCE_DIRECTORY_NAME, evidenceFileNameForDate(new Date('2026-08-18T01:00:00.000Z'))), 'utf8')
      .catch(() => '');
    assert.ok(!content.includes(secret), `secret 原文出现在账本里：${trace}`);
  }

  // 摘要字段长度恒定，不随输入长度变化（需求 2.11）。
  const digests = Array.from({ length: 8 }, (_unused, index) => digestRef('x'.repeat(index * 37 + 1)));
  assert.equal(new Set(digests.map((value) => value.length)).size, 1);
});

test('4.1 readCommanderChainEvidenceFiles 只读账本目录，缺失时返回空数组', async (context) => {
  const dataDir = await makeDataDir(context);
  assert.deepEqual(await readCommanderChainEvidenceFiles(path.join(dataDir, EVIDENCE_DIRECTORY_NAME)), []);
  await ledgerAt(dataDir, '2026-08-18T01:00:00.000Z').record({ kind: 'diagnosis_completed' });
  const records = await readCommanderChainEvidenceFiles(path.join(dataDir, EVIDENCE_DIRECTORY_NAME));
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, 'diagnosis_completed');
});

// --- 固定种子伪随机生成器（mulberry32；不引入 PBT 库） ---

function createSeededRandom(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function randomSecretShaped(random, index) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  // 长度下限 40：短随机串与普通文本不可区分，不属于「secret 形态」输入域。
  const blob = Array.from({ length: 40 + Math.floor(random() * 24) },
    () => alphabet[Math.floor(random() * alphabet.length)]).join('');
  const shapes = [
    `sk-${blob}`,
    `Bearer ${blob}`,
    `https://example.invalid/callback?token=${blob}`,
    `cookie: session=${blob}`,
    `password=${blob}`,
    `${blob}${'='.repeat(index % 3)}`,
    `${'超长'.repeat(80)}${blob}`,
  ];
  return shapes[index % shapes.length];
}

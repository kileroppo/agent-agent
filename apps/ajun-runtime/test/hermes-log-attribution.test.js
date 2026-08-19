// Hermes 日志子系统归属 · 单元测试
//
// 核心被测行为：把「异常类名总计数」升级为「先归属子系统再报签名」，
// 使无关平台插件的重试噪音不能再被报为飞书链路的原因。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attributeHermesLog,
  isFeishuChainRelated,
  renderAttributionVerdict,
  summarizeSignatures,
} from '../src/hermes-log-attribution.ts';
import { decideExitCode, parseArguments, readTail } from '../scripts/attribute-hermes-logs.mjs';
// 命名空间导入：阶段五的反例 E4 / E5 / E6 要探测「某导出是否存在」。
// 用具名导入会在链接期直接抛 SyntaxError 并让既有 13 项一起失败，那是工具噪音而不是反例证据。
import * as attributionModule from '../src/hermes-log-attribution.ts';
import * as cliModule from '../scripts/attribute-hermes-logs.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// 真机日志形态的最小复刻：Telegram 插件的 httpx 连接失败（含异常链）。
const TELEGRAM_TRACEBACK = [
  '2026-08-19 11:21:03 ERROR plugins.platforms.telegram polling failed',
  'Traceback (most recent call last):',
  '  File "/Users/x/.hermes/hermes-agent/.venv/lib/python3.11/site-packages/httpx/_transports/default.py", line 101, in map_httpcore_exceptions',
  '    yield',
  'httpcore.ConnectError: [Errno 60] Operation timed out',
  '',
  'During handling of the above exception, another exception occurred:',
  '',
  'Traceback (most recent call last):',
  '  File "/Users/x/.hermes/hermes-agent/plugins/platforms/telegram/networkloop.py", line 88, in _poll',
  '    response = await request.post("https://api.telegram.org/bot123:secret/getUpdates")',
  '  File "/Users/x/.hermes/hermes-agent/.venv/lib/python3.11/site-packages/telegram/request/_httpxrequest.py", line 55, in post',
  '    raise NetworkError(err)',
  'telegram.error.NetworkError: httpx.ConnectError: [Errno 60] 149.154.167.220',
].join('\n');

// 飞书适配器自身抛出的异常：这才是与本 bug 相关的签名。
const FEISHU_TRACEBACK = [
  '2026-08-19 11:20:55 ERROR plugins.platforms.feishu failed to send reply',
  'Traceback (most recent call last):',
  '  File "/Users/x/.hermes/hermes-agent/plugins/platforms/feishu/adapter.py", line 742, in handle_message',
  '    await self.send(chat_id, reply, reply_to=message_id)',
  '  File "/Users/x/.hermes/hermes-agent/plugins/platforms/feishu/adapter.py", line 918, in send',
  '    raise KeyError(open_id)',
  'KeyError: ou_9f8e7d6c5b4a3210',
].join('\n');

test('按子系统归属：Telegram 噪音与飞书签名被分开统计', () => {
  const attribution = attributeHermesLog(`${TELEGRAM_TRACEBACK}\n${TELEGRAM_TRACEBACK}\n${FEISHU_TRACEBACK}\n`);

  assert.equal(attribution.scanned.tracebackCount, 3, '链式异常的两个 Traceback 属于同一条记录，不得重复计数');
  const telegram = attribution.subsystems.find((item) => item.subsystem === 'telegram-platform');
  const feishu = attribution.subsystems.find((item) => item.subsystem === 'feishu-platform');
  assert.equal(telegram.tracebackCount, 2);
  assert.equal(feishu.tracebackCount, 1);
  // 主导子系统是 Telegram，但它必须被判为与飞书链路无关。
  assert.equal(attribution.subsystems[0].subsystem, 'telegram-platform');
  assert.equal(telegram.feishuChainRelated, false);
  assert.equal(feishu.feishuChainRelated, true);
});

test('实际传播的异常类名取异常链最后一个，且归属依据是最深的非第三方栈帧', () => {
  const attribution = attributeHermesLog(TELEGRAM_TRACEBACK);
  const [group] = attribution.feishuChainTracebacks.length ? [] : attribution.subsystems;
  assert.equal(group.subsystem, 'telegram-platform');
  assert.deepEqual(
    group.exceptionClassCounts.map((item) => item.exceptionClass),
    ['telegram.error.NetworkError'],
  );
  // 归属由 networkloop.py 决定，而不是由更深的 httpx/site-packages 帧决定。
  assert.deepEqual(group.ownedFrameCounts, [{ file: 'networkloop.py', line: 88, count: 1 }]);
});

test('飞书链路 traceback 逐条给出异常链与自有栈帧', () => {
  const attribution = attributeHermesLog(FEISHU_TRACEBACK);
  assert.equal(attribution.feishuChainTracebacks.length, 1);
  const [group] = attribution.feishuChainTracebacks;
  assert.equal(group.subsystem, 'feishu-platform');
  assert.equal(group.attributionBasis, 'owning_frame');
  assert.equal(group.exceptionClass, 'KeyError');
  assert.equal(group.timestamp, '2026-08-19 11:20:55');
  assert.deepEqual(group.ownedFrames.map((frame) => `${frame.file}:${frame.line}`),
    ['adapter.py:918', 'adapter.py:742']);
});

test('输出零凭据：不含消息正文、URL、IP、open_id 与绝对路径', () => {
  const attribution = attributeHermesLog(`${TELEGRAM_TRACEBACK}\n${FEISHU_TRACEBACK}\n`);
  const serialized = JSON.stringify(attribution);
  for (const forbidden of [
    'api.telegram.org', '149.154.167.220', 'ou_9f8e7d6c5b4a3210',
    '/Users/', 'secret', 'Operation timed out', 'Errno',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `输出泄露了 ${forbidden}`);
  }
});

test('主导签名与飞书链路无关时，结论必须明确说「无关」且禁止套用无回退说明', () => {
  const verdict = renderAttributionVerdict(attributeHermesLog(TELEGRAM_TRACEBACK));
  assert.match(verdict, /与「飞书消息无回复」无关/);
  assert.match(verdict, /不得据此推导飞书侧根因/);
  assert.match(verdict, /无回退链/);
});

test('没有任何飞书归属签名时，把「失败未被记录」本身报为证据缺口', () => {
  const verdict = renderAttributionVerdict(attributeHermesLog(TELEGRAM_TRACEBACK));
  assert.match(verdict, /没有任何.*归属到飞书链路/);
  assert.match(verdict, /「没有错误记录」不等于「飞书侧正常」/);
});

test('日志器名体量按子系统归属，无 traceback 的行也计入', () => {
  const attribution = attributeHermesLog([
    '2026-08-19 11:21:03 WARNING plugins.platforms.telegram retry scheduled',
    '2026-08-19 11:21:04 WARNING plugins.platforms.telegram retry scheduled',
    '2026-08-19 11:21:05 INFO gateway.platforms.base plugin ready',
  ].join('\n'));
  assert.deepEqual(attribution.loggerNameCounts, [
    { loggerName: 'plugins.platforms.telegram', subsystem: 'telegram-platform', count: 2 },
    { loggerName: 'gateway.platforms.base', subsystem: 'hermes-core', count: 1 },
  ]);
  assert.equal(attribution.scanned.tracebackCount, 0);
});

test('空日志与无 traceback 日志都不抛异常', () => {
  assert.equal(attributeHermesLog('').scanned.tracebackCount, 0);
  assert.equal(attributeHermesLog('普通一行日志\n').subsystems.length, 0);
  assert.match(renderAttributionVerdict(attributeHermesLog('')), /没有解析到任何 traceback/);
});

test('同一处代码反复抛同一异常时折叠为一个签名，并保留首次/最近时间与行范围', () => {
  const repeated = [
    FEISHU_TRACEBACK.replace('11:20:55', '11:20:01'),
    FEISHU_TRACEBACK.replace('11:20:55', '11:20:09'),
    FEISHU_TRACEBACK.replace('11:20:55', '11:20:05'),
  ].join('\n');
  const attribution = attributeHermesLog(repeated);
  assert.equal(attribution.feishuChainTracebacks.length, 3);

  const signatures = summarizeSignatures(attribution.feishuChainTracebacks);
  assert.equal(signatures.length, 1, '三条相同签名必须折叠为一个');
  assert.equal(signatures[0].count, 3);
  assert.equal(signatures[0].firstTimestamp, '2026-08-19 11:20:01');
  assert.equal(signatures[0].lastTimestamp, '2026-08-19 11:20:09');
  assert.equal(signatures[0].firstLine < signatures[0].lastLine, true);
});

test('栈帧位置不同即为不同签名，不得被折叠', () => {
  const signatures = summarizeSignatures(attributeHermesLog(
    `${FEISHU_TRACEBACK}\n${FEISHU_TRACEBACK.replace('line 918', 'line 999')}\n`,
  ).feishuChainTracebacks);
  assert.equal(signatures.length, 2);
  assert.deepEqual(signatures.map((item) => item.count), [1, 1]);
});

test('飞书链路子系统集合覆盖飞书插件、MCP、模型 provider 与核心，排除其他平台', () => {
  assert.equal(isFeishuChainRelated('feishu-platform'), true);
  assert.equal(isFeishuChainRelated('mcp'), true);
  assert.equal(isFeishuChainRelated('model-provider'), true);
  assert.equal(isFeishuChainRelated('hermes-core'), true);
  assert.equal(isFeishuChainRelated('telegram-platform'), false);
  assert.equal(isFeishuChainRelated('other-platform'), false);
});

test('尾部窗口只读文件末尾，并丢掉被截断的半行', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-log-attribution-'));
  const file = path.join(directory, 'gateway.error.log');
  await fs.writeFile(file, 'AAAA被截断的半行\nBBBB完整行\nCCCC完整行\n', 'utf8');
  try {
    const tail = await readTail(file, 24);
    assert.equal(tail.truncated, true);
    assert.equal(tail.text.includes('AAAA'), false, '被截断的半行必须丢掉');
    assert.equal(tail.text.includes('CCCC完整行'), true);
    const whole = await readTail(file, 1024 * 1024);
    assert.equal(whole.truncated, false);
    assert.equal(whole.text.includes('AAAA被截断的半行'), true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('CLI 参数解析与退出码语义', () => {
  assert.deepEqual(parseArguments(['--json', '--all']).json, true);
  assert.equal(parseArguments(['--tail-mb', '32']).tailBytes, 32 * 1024 * 1024);
  assert.equal(parseArguments(['--tail-mb=2']).tailBytes, 2 * 1024 * 1024);
  assert.deepEqual(parseArguments(['--file', 'a.log', '--file=b.log']).files, ['a.log', 'b.log']);
  assert.throws(() => parseArguments(['--nope']), /无法识别的参数/);
  assert.throws(() => parseArguments(['--tail-mb', '0']), /正数/);

  // 0 = 找到飞书归属签名；1 = 未找到（证据缺口）；2 = 日志读不出。
  assert.equal(decideExitCode({ ok: false, errorCode: 'log_directory_not_found', reports: [] }), 2);
  assert.equal(decideExitCode({
    ok: true,
    reports: [{ attribution: attributeHermesLog(TELEGRAM_TRACEBACK) }],
  }), 1);
  assert.equal(decideExitCode({
    ok: true,
    reports: [{ attribution: attributeHermesLog(FEISHU_TRACEBACK) }],
  }), 0);
});

// ===========================================================================
// 阶段五：非异常型拒绝记录的日志归属（1.34–1.36 / 2.43–2.45 / 3.24–3.27）
//
// 缺陷：日志归属工具只解析 traceback，把真机上「已被明确记录的准入拒绝」误报为
// 「失败根本没有被记录」，并返回退出码 1。缺陷恰好发生在为消除误导而建的工具上。
// ===========================================================================

// 夹具全部只用占位符。**严禁**写入任何真实姓名、open_id、账号标识及其片段。
// 真机准入拒绝是一条**不带 traceback 的结构化日志行**，这是缺陷成立的形态前提。
const ACCOUNT_PLACEHOLDER = '<account-placeholder>';
const NAME_PLACEHOLDER = '<name-placeholder>';
const ADMISSION_REJECTION_LINE = '2026-08-19 14:42:01 WARNING plugins.platforms.feishu '
  + `Unauthorized user: ${ACCOUNT_PLACEHOLDER} ${NAME_PLACEHOLDER} on feishu`;
// 0.19 时代的措辞，与当前版本形状不同且并存（1.36）。
const LEGACY_REJECTION_LINE = '2026-07-19 11:19:02 WARNING gateway.platforms.feishu dm_policy_rejected';
// 正向里程碑：用于区分「入站到达但被拒绝」与「入站根本没到」两个不同结论。
const POSITIVE_MILESTONE_LINES = Object.freeze([
  '2026-08-19 14:42:00 INFO plugins.platforms.feishu [Feishu] Inbound dm message received',
  '2026-08-19 14:42:00 INFO gateway.platforms.feishu inbound message: platform=feishu',
  '2026-08-19 14:42:02 INFO gateway.platforms.feishu response ready: platform=feishu',
  '2026-08-19 14:42:02 INFO plugins.platforms.feishu [Feishu] Sending response',
]);

// 真机形态复刻：46 万行被 Telegram 噪音主导，飞书证据只有一行。
const NOISY_WITH_REJECTION = `${TELEGRAM_TRACEBACK}\n${ADMISSION_REJECTION_LINE}`;

// --- E1：拒绝记录被完全漏掉（1.34） ---
//
// 未修复代码上的实测：`feishuChainRejections` 字段不存在（undefined），读 `.length` 抛
//   TypeError: Cannot read properties of undefined (reading 'length')
// 直接证明解析由 TRACEBACK_HEADER 门控，漏掉了这条不带 traceback 的记录。
test('E1 非 traceback 准入拒绝行必须被识别并归属到飞书链路', () => {
  const result = attributeHermesLog(NOISY_WITH_REJECTION, { hermesVersion: '0.20.1' });
  assert.equal(Array.isArray(result.feishuChainRejections), true,
    'feishuChainRejections 字段必须存在 —— 未修复代码上它是 undefined');
  assert.equal(result.feishuChainRejections.length, 1,
    '拒绝行紧跟 traceback 末行时也必须被识别（复核 F5：识别写在每行前置段）');
  assert.equal(result.feishuChainRejections[0].subsystem, 'feishu-platform');
  assert.equal(result.feishuChainRejections[0].signatureId, 'admission-unauthorized-user');
});

// --- E2：主动误导（1.35 / 2.44） ---
test('E2 存在飞书拒绝记录时，结论不得再说「失败根本没有被记录」', () => {
  const verdict = renderAttributionVerdict(
    attributeHermesLog(NOISY_WITH_REJECTION, { hermesVersion: '0.20.1' }),
  );
  assert.doesNotMatch(verdict, /失败根本没有被记录/,
    '证据存在却说「失败未被记录」，是主动误导排查者');
  assert.doesNotMatch(verdict, /没有任何.*归属到飞书链路/);
});

// --- E3：证据存在却报未找到（2.44） ---
test('E3 只含准入拒绝行时退出码必须为 0（找到飞书归属证据）', () => {
  const exitCode = decideExitCode({
    ok: true,
    reports: [{ attribution: attributeHermesLog(ADMISSION_REJECTION_LINE, { hermesVersion: '0.20.1' }) }],
  });
  assert.equal(exitCode, 0, '证据实际存在时返回「未找到」违反 2.44');
});

// --- E4：放大缺陷①，默认文件集漏掉 gateway.log ---
//
// 准入拒绝是 WARNING 级，最可能只在 gateway.log。不修这一项则解析修好也扫不到。
test('E4 默认日志文件集必须同时包含 gateway.error.log 与 gateway.log', () => {
  const names = cliModule.DEFAULT_LOG_NAMES;
  assert.equal(Array.isArray(names), true,
    'DEFAULT_LOG_NAMES 必须存在 —— 未修复代码上只有单值 DEFAULT_LOG_NAME');
  assert.deepEqual([...names], ['gateway.error.log', 'gateway.log']);
});

// --- E5：无措辞溯源（1.36 / 2.45） ---
test('E5 每条登记措辞都必须给出来源位置与适用版本', () => {
  const result = attributeHermesLog(ADMISSION_REJECTION_LINE, { hermesVersion: '0.20.1' });
  assert.equal(Array.isArray(result.signatureProvenance), true,
    'signatureProvenance 必须存在 —— 未修复代码上无任何措辞登记结构');
  assert.equal(result.signatureProvenance.length, 5, '五条登记措辞未命中也必须出现');
  for (const entry of result.signatureProvenance) {
    assert.equal(typeof entry.signatureId, 'string');
    assert.equal(typeof entry.source === 'string' && entry.source.length > 0, true,
      `${entry.signatureId} 缺少仓库内来源位置`);
    assert.equal('sourceHermesVersion' in entry, true);
    assert.equal(['current_version', 'other_version', 'unknown'].includes(entry.applicability), true);
    assert.equal(typeof entry.matchCount, 'number');
  }
});

// --- E6：无「不适用」表述通道（2.45） ---
test('E6 未命中的措辞必须表述为「不适用 / 适用性未知」，不得说「未发生该类拒绝」', () => {
  const verdict = renderAttributionVerdict(
    attributeHermesLog(ADMISSION_REJECTION_LINE, { hermesVersion: '0.20.1' }),
  );
  assert.match(verdict, /该措辞在当前版本不适用|适用性未知/,
    '未修复代码上无该表述通道');
  assert.doesNotMatch(verdict, /未发生该类拒绝/,
    '未命中不等于未发生 —— 不得把「窗口内没看到」表述为「没发生过」');
});


// ===========================================================================
// 阶段五 · 保持性基线（Property 4）—— observation-first
//
// 下面的基线常量是在**未修复代码**上实测 attributeHermesLog() / renderAttributionVerdict()
// 的完整返回值后逐字节落盘的，不是凭假设写的期望值。
// Bug_Condition 不成立的域 = 不含任何匹配 REJECTION_SIGNATURES 的行（含四条正向签名）：
// TELEGRAM_TRACEBACK 与 FEISHU_TRACEBACK 都不含，故基线选取成立。
// ===========================================================================

const BASELINE_TELEGRAM = {
  schemaVersion: 'agent.army/hermes-log-attribution/v1',
  scanned: { lineCount: 14, tailWindow: false, tracebackCount: 1 },
  subsystems: [{
    subsystem: 'telegram-platform',
    label: 'Telegram 平台插件',
    feishuChainRelated: false,
    tracebackCount: 1,
    exceptionClassCounts: [{ exceptionClass: 'telegram.error.NetworkError', count: 1 }],
    ownedFrameCounts: [{ file: 'networkloop.py', line: 88, count: 1 }],
    firstLine: 1,
    lastLine: 13,
    lastTimestamp: '2026-08-19 11:21:03',
  }],
  feishuChainTracebacks: [],
  loggerNameCounts: [{ loggerName: 'plugins.platforms.telegram', subsystem: 'telegram-platform', count: 1 }],
  redactedFieldCount: 0,
};

const BASELINE_FEISHU_GROUP = {
  subsystem: 'feishu-platform',
  attributionBasis: 'owning_frame',
  exceptionClass: 'KeyError',
  exceptionChain: ['KeyError'],
  ownedFrames: [
    { file: 'adapter.py', line: 918, func: 'send' },
    { file: 'adapter.py', line: 742, func: 'handle_message' },
  ],
  loggerName: 'plugins.platforms.feishu',
  timestamp: '2026-08-19 11:20:55',
  startLine: 1,
  endLine: 6,
};

const BASELINE_FEISHU = {
  schemaVersion: 'agent.army/hermes-log-attribution/v1',
  scanned: { lineCount: 7, tailWindow: false, tracebackCount: 1 },
  subsystems: [{
    subsystem: 'feishu-platform',
    label: '飞书平台插件',
    feishuChainRelated: true,
    tracebackCount: 1,
    exceptionClassCounts: [{ exceptionClass: 'KeyError', count: 1 }],
    ownedFrameCounts: [
      { file: 'adapter.py', line: 742, count: 1 },
      { file: 'adapter.py', line: 918, count: 1 },
    ],
    firstLine: 1,
    lastLine: 6,
    lastTimestamp: '2026-08-19 11:20:55',
  }],
  feishuChainTracebacks: [BASELINE_FEISHU_GROUP],
  loggerNameCounts: [{ loggerName: 'plugins.platforms.feishu', subsystem: 'feishu-platform', count: 1 }],
  redactedFieldCount: 0,
};

const BASELINE_BOTH = {
  schemaVersion: 'agent.army/hermes-log-attribution/v1',
  scanned: { lineCount: 21, tailWindow: false, tracebackCount: 2 },
  subsystems: [
    {
      subsystem: 'feishu-platform',
      label: '飞书平台插件',
      feishuChainRelated: true,
      tracebackCount: 1,
      exceptionClassCounts: [{ exceptionClass: 'KeyError', count: 1 }],
      ownedFrameCounts: [
        { file: 'adapter.py', line: 742, count: 1 },
        { file: 'adapter.py', line: 918, count: 1 },
      ],
      firstLine: 15,
      lastLine: 20,
      lastTimestamp: '2026-08-19 11:20:55',
    },
    {
      subsystem: 'telegram-platform',
      label: 'Telegram 平台插件',
      feishuChainRelated: false,
      tracebackCount: 1,
      exceptionClassCounts: [{ exceptionClass: 'telegram.error.NetworkError', count: 1 }],
      ownedFrameCounts: [{ file: 'networkloop.py', line: 88, count: 1 }],
      firstLine: 1,
      lastLine: 13,
      lastTimestamp: '2026-08-19 11:21:03',
    },
  ],
  feishuChainTracebacks: [{ ...BASELINE_FEISHU_GROUP, startLine: 15, endLine: 20 }],
  loggerNameCounts: [
    { loggerName: 'plugins.platforms.feishu', subsystem: 'feishu-platform', count: 1 },
    { loggerName: 'plugins.platforms.telegram', subsystem: 'telegram-platform', count: 1 },
  ],
  redactedFieldCount: 0,
};

// renderAttributionVerdict() 的完整文本，逐字节落为基线。
const BASELINE_VERDICT_TELEGRAM = '主导签名归属：Telegram 平台插件（1 条 traceback，最常见异常 telegram.error.NetworkError）。\n'
  + '**该主导签名与「飞书消息无回复」无关**：它由 Telegram 平台插件 发出，不在飞书链路上。'
  + '不得据此推导飞书侧根因，也不得据此套用「无回退链 → 必然静默」的说明。\n'
  + '扫描窗口内**没有任何**归属到飞书链路的 traceback。若飞书事件确实在到达，'
  + '则说明飞书侧的失败根本没有被记录到错误日志 ——「没有错误记录」不等于「飞书侧正常」，这本身是一个证据缺口。';

const BASELINE_VERDICT_FEISHU = '主导签名归属：飞书平台插件（1 条 traceback，最常见异常 KeyError）。\n'
  + '归属到飞书链路的 traceback 共 1 条：飞书平台插件 1 条（KeyError×1）\n'
  + '这些才是可用于判定飞书侧根因的签名，逐条明细见下。';

const BASELINE_CASES = Object.freeze([
  { name: 'telegram-only', text: TELEGRAM_TRACEBACK, baseline: BASELINE_TELEGRAM, verdict: BASELINE_VERDICT_TELEGRAM },
  { name: 'feishu-only', text: FEISHU_TRACEBACK, baseline: BASELINE_FEISHU, verdict: BASELINE_VERDICT_FEISHU },
  { name: 'telegram+feishu', text: `${TELEGRAM_TRACEBACK}\n${FEISHU_TRACEBACK}`, baseline: BASELINE_BOTH, verdict: BASELINE_VERDICT_FEISHU },
]);

/** 只投影修复前已存在的 SubsystemReport 字段；新增三字段不参与比对（本轮唯一允许的差异）。 */
function projectExistingFields(subsystems) {
  return subsystems.map((report) => ({
    subsystem: report.subsystem,
    label: report.label,
    feishuChainRelated: report.feishuChainRelated,
    tracebackCount: report.tracebackCount,
    exceptionClassCounts: report.exceptionClassCounts.map((item) => ({ ...item })),
    ownedFrameCounts: report.ownedFrameCounts.map((item) => ({ ...item })),
    firstLine: report.firstLine,
    lastLine: report.lastLine,
    lastTimestamp: report.lastTimestamp,
  }));
}

/** 固定种子伪随机（mulberry32）。种子写死，失败时打印，便于复现。 */
const P4_SEED = 0x5eed4a17;
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('P4-1 tracebackCount 保持 traceback-only，不得混入拒绝记录计数', () => {
  for (const { name, text, baseline } of BASELINE_CASES) {
    const after = attributeHermesLog(text);
    assert.equal(after.scanned.tracebackCount, baseline.scanned.tracebackCount, name);
    const projected = projectExistingFields(after.subsystems);
    assert.deepEqual(projected.map((item) => item.tracebackCount),
      baseline.subsystems.map((item) => item.tracebackCount), name);
  }
});

test('P4-2 feishuChainTracebacks 与基线深度相等，不改名不混入非 traceback 记录', () => {
  for (const { name, text, baseline } of BASELINE_CASES) {
    const after = attributeHermesLog(text);
    assert.deepEqual(JSON.parse(JSON.stringify(after.feishuChainTracebacks)),
      baseline.feishuChainTracebacks, name);
  }
});

test('P4-3 loggerNameCounts 与基线深度相等（既有测试用全量比对，严禁增删字段）', () => {
  for (const { name, text, baseline } of BASELINE_CASES) {
    const after = attributeHermesLog(text);
    assert.deepEqual(JSON.parse(JSON.stringify(after.loggerNameCounts)), baseline.loggerNameCounts, name);
    for (const item of after.loggerNameCounts) {
      assert.deepEqual(Object.keys(item).sort(), ['count', 'loggerName', 'subsystem'], name);
    }
  }
});

test('P4-4 redactedFieldCount 不因新增时间戳校验而对既有夹具多计', () => {
  for (const { name, text, baseline } of BASELINE_CASES) {
    assert.equal(attributeHermesLog(text).redactedFieldCount, baseline.redactedFieldCount, name);
  }
});

test('P4-5 subsystems 的既有字段投影与基线深度相等（新增三字段是唯一允许的差异）', () => {
  for (const { name, text, baseline } of BASELINE_CASES) {
    const projected = JSON.parse(JSON.stringify(projectExistingFields(attributeHermesLog(text).subsystems)));
    assert.deepEqual(projected, baseline.subsystems, name);
  }
});

test('P4-6 summarizeSignatures() 的签名、入参类型与返回形状不变', () => {
  assert.equal(summarizeSignatures.length, 1, 'summarizeSignatures 仍只接收一个入参');
  for (const { name, text } of BASELINE_CASES) {
    const after = attributeHermesLog(text);
    const summaries = summarizeSignatures(after.feishuChainTracebacks);
    assert.deepEqual(summaries.map((item) => Object.keys(item).sort()),
      summaries.map(() => ['count', 'exceptionChain', 'firstLine', 'firstTimestamp',
        'lastLine', 'lastTimestamp', 'ownedFrames', 'subsystem']), name);
  }
  // 折叠结果与基线一致（feishu-only：1 条 traceback → 1 个签名）。
  const feishuSummaries = summarizeSignatures(attributeHermesLog(FEISHU_TRACEBACK).feishuChainTracebacks);
  assert.equal(feishuSummaries.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(feishuSummaries[0])), {
    subsystem: 'feishu-platform',
    exceptionChain: ['KeyError'],
    ownedFrames: BASELINE_FEISHU_GROUP.ownedFrames,
    count: 1,
    firstTimestamp: '2026-08-19 11:20:55',
    lastTimestamp: '2026-08-19 11:20:55',
    firstLine: 1,
    lastLine: 6,
  });
});

test('P4-7 三份基线输入的结论文本逐字节不变，无关子系统主导签名继续判为与本 bug 无关', () => {
  for (const { name, text, verdict } of BASELINE_CASES) {
    assert.equal(renderAttributionVerdict(attributeHermesLog(text)), verdict, `${name} 结论文本发生了变化`);
  }
  // 三段被 3.25 点名的措辞逐字节存在。
  const telegramVerdict = renderAttributionVerdict(attributeHermesLog(TELEGRAM_TRACEBACK));
  for (const phrase of ['与「飞书消息无回复」无关', '不得据此推导飞书侧根因', '无回退链']) {
    assert.equal(telegramVerdict.includes(phrase), true, `措辞「${phrase}」必须逐字节保留`);
  }
});

test('P4-8 只含第三方栈帧 / 普通日志行 / 空行的随机输入：尾部窗口语义与 subsystems 空集不变', () => {
  const random = makeRandom(P4_SEED);
  const pick = (items) => items[Math.floor(random() * items.length)];
  const noiseLines = [
    '  File "/Users/x/.venv/lib/python3.11/site-packages/httpx/_client.py", line 12, in send',
    '  File "/opt/homebrew/lib/python3.11/asyncio/events.py", line 80, in _run',
    '普通一行日志',
    '2026-08-19 11:00:00 INFO 启动完成',
    '',
    '   ',
  ];
  for (let iteration = 0; iteration < 200; iteration += 1) {
    const count = 1 + Math.floor(random() * 12);
    const lines = Array.from({ length: count }, () => pick(noiseLines));
    const text = lines.join('\n');
    const result = attributeHermesLog(text, { tailWindow: true });
    const context = `seed=${P4_SEED} iteration=${iteration} lines=${JSON.stringify(lines)}`;
    assert.equal(result.subsystems.length, 0, `非匹配普通行不得生成 SubsystemReport 条目。${context}`);
    assert.equal(result.scanned.tracebackCount, 0, context);
    assert.equal(result.scanned.tailWindow, true, `尾部窗口语义必须原样透传。${context}`);
    assert.equal(result.feishuChainTracebacks.length, 0, context);
  }
  // readTail() 的窗口语义由既有用例 #12 钉住；此处确认 tailWindow 标记不被新增逻辑改写。
  assert.equal(attributeHermesLog('', { tailWindow: false }).scanned.tailWindow, false);
});

test('P4-9 纯解析零 I/O、零第三方依赖：模块 import 列表为空，CLI 只依赖内建与仓库内文件', async () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const moduleSource = await fs.readFile(path.join(here, '../src/hermes-log-attribution.ts'), 'utf8');
  const moduleImports = moduleSource.match(/^\s*import\s.+$/gm) ?? [];
  assert.deepEqual(moduleImports, [], '纯解析模块必须零 import（零 I/O、零第三方依赖）');
  for (const token of ['process.env', 'fetch(', 'node:fs']) {
    assert.equal(moduleSource.includes(token), false, `纯解析模块不得出现 ${token}`);
  }

  const cliSource = await fs.readFile(path.join(here, '../scripts/attribute-hermes-logs.mjs'), 'utf8');
  const cliImports = [...cliSource.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)].map((match) => match[1]);
  assert.equal(cliImports.length > 0, true);
  for (const specifier of cliImports) {
    assert.equal(specifier.startsWith('node:') || specifier.startsWith('.'), true,
      `CLI 引入了第三方依赖 ${specifier}`);
  }
  // 先剥掉注释：文件头注释里有「不读 .env」这类说明性文字，不能当成读取行为。
  const cliCode = cliSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // 只禁「读 .env 文件」这一行为：字符串字面量里出现 .env 文件名，或引入 dotenv。
  // 读 process.env.HERMES_HOME 是既有且必要的行为（探测日志目录），不在禁止范围内。
  assert.equal(/['"`][^'"`\n]*\.env['"`]/.test(cliCode), false, 'CLI 不得读取 .env 文件');
  assert.equal(/\bdotenv\b/.test(cliCode), false, 'CLI 不得引入 dotenv');
  assert.equal(/\bfetch\s*\(|node:https?\b/.test(cliCode), false, 'CLI 不得发起网络调用');
});

test('P4-10 本轮零改动的正向确认：诊断六项检查与准入安全语义未被触碰', async () => {
  const diagnosis = await import('../src/feishu-commander-chain-diagnosis.ts');
  assert.deepEqual([...diagnosis.CHAIN_CHECK_IDS], [
    'gateway-process', 'adapter-patch', 'required-env', 'runtime-ingress', 'profile-guard', 'feishu-admission',
  ], '六项检查的 id 与顺序不得变');
  assert.deepEqual({ ...diagnosis.TRUTH_LAYER_CEILINGS }, {
    'gateway-process': 'reachable',
    'adapter-patch': 'configured',
    'required-env': 'configured',
    'runtime-ingress': 'reachable',
    'profile-guard': 'configured',
    'feishu-admission': 'configured',
  }, 'truthLayerCeiling 不得变');

  const here = path.dirname(new URL(import.meta.url).pathname);
  const connectionSource = await fs.readFile(path.join(here, '../src/employee-feishu-connection-service.ts'), 'utf8');
  assert.equal(connectionSource.includes('/^ou_[a-zA-Z0-9_-]{8,}$/'), true, 'ou_ 前缀格式校验不得放宽');
  const appStoreSource = await fs.readFile(path.join(here, '../src/agent-feishu-app-store.ts'), 'utf8');
  assert.equal(appStoreSource.includes('0o600'), true, '密钥本地存储权限不得放宽');
  const fleetSource = await fs.readFile(path.join(here, '../src/agent-feishu-channel-fleet.ts'), 'utf8');
  assert.equal(fleetSource.includes("dmMode: 'allowlist'"), true, 'dmMode 默认拒绝语义不得放宽');
  // 未引入「允许全部用户」旁路。
  const attributionSource = await fs.readFile(path.join(here, '../src/hermes-log-attribution.ts'), 'utf8');
  for (const source of [attributionSource, fleetSource, connectionSource]) {
    assert.equal(/FEISHU_ALLOW_ALL_USERS\s*[:=]\s*true|allowAllUsers\s*[:=]\s*true/.test(source), false,
      '不得引入「允许全部用户」旁路');
  }
});

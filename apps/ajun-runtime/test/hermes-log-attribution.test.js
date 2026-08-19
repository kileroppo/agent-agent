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

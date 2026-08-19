#!/usr/bin/env node
// Hermes 日志子系统归属诊断（只读本机）
//
//   npm run diagnose:hermes-logs                       # 默认扫描 gateway.error.log + gateway.log 尾部 8 MiB
//   npm run diagnose:hermes-logs -- --json             # 机器可读 hermes-log-attribution/v1
//   npm run diagnose:hermes-logs -- --all              # 扫描日志目录内全部 *.log
//   npm run diagnose:hermes-logs -- --tail-mb 32       # 扩大扫描窗口
//   npm run diagnose:hermes-logs -- --log-dir <目录>   # 指定 Hermes 日志目录
//   npm run diagnose:hermes-logs -- --hermes-version 0.20.1   # 注入运行版本，判定措辞适用性
//
// 存在原因：46 万行错误日志被某一个平台插件的重试噪音主导，只看「异常类名总计数」会把该噪音
// 误报为飞书链路的根因。本工具先按**发出异常的子系统**归属，再报告签名。
//
// 同时覆盖**非异常型的结构化拒绝记录**：真机上用户准入拒绝是一条不带 traceback 的日志行，
// 只解析 traceback 会把「已被明确记录的失败」误报为「失败根本没有被记录」。该类记录是
// WARNING 级，通常只落在 gateway.log —— 这也是默认文件集必须含 gateway.log 的原因。
//
// 只读、零外部副作用、输出零凭据：不读 .env，不输出日志正文 / URL / IP / open_id /
// 账号标识 / 真实姓名 / 绝对路径。拒绝行只做 test() 判定，行文本永不进入任何输出。
// 零第三方 npm 依赖：依赖未安装、Gateway 未起、4321 未监听时同样可以跑完。
//
// 退出码：0 找到飞书链路归属证据（traceback 或非 traceback 拒绝记录）；
//        1 两类证据都为零（真正的证据缺口）；2 日志读不出，工具自身无法完成。

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  applicabilityLabel,
  attributeHermesLog,
  renderAttributionVerdict,
  summarizeRejectionSignatures,
  summarizeSignatures,
} from '../src/hermes-log-attribution.ts';

// 默认文件集必须含 gateway.log：用户准入拒绝是 **WARNING 级**，最可能只落在 gateway.log，
// 不在 gateway.error.log 里。只修解析而不改这一项，等于解析修好了也扫不到那一行。
export const DEFAULT_LOG_NAMES = Object.freeze(['gateway.error.log', 'gateway.log']);
const DEFAULT_TAIL_BYTES = 8 * 1024 * 1024;

export function parseArguments(argv) {
  const options = {
    json: false,
    all: false,
    help: false,
    logDir: null,
    files: [],
    tailBytes: DEFAULT_TAIL_BYTES,
    // 运行版本由调用方注入，纯解析模块不做任何版本探测 I/O。未提供时全部措辞报「适用性未知」。
    hermesVersion: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    const takeValue = (flag) => {
      const inline = argument.startsWith(`${flag}=`) ? argument.slice(flag.length + 1) : null;
      if (inline !== null) return inline;
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`${flag} 需要一个参数。`);
      index += 1;
      return next;
    };
    if (argument === '--json') { options.json = true; continue; }
    if (argument === '--all') { options.all = true; continue; }
    if (argument === '--help' || argument === '-h') { options.help = true; continue; }
    if (argument === '--log-dir' || argument.startsWith('--log-dir=')) { options.logDir = takeValue('--log-dir'); continue; }
    if (argument === '--file' || argument.startsWith('--file=')) { options.files.push(takeValue('--file')); continue; }
    if (argument === '--hermes-version' || argument.startsWith('--hermes-version=')) {
      options.hermesVersion = takeValue('--hermes-version');
      continue;
    }
    if (argument === '--tail-mb' || argument.startsWith('--tail-mb=')) {
      const megabytes = Number.parseFloat(takeValue('--tail-mb'));
      if (!Number.isFinite(megabytes) || megabytes <= 0) throw new Error('--tail-mb 需要一个正数。');
      options.tailBytes = Math.floor(megabytes * 1024 * 1024);
      continue;
    }
    throw new Error(`无法识别的参数：${argument}`);
  }
  return options;
}

export function renderUsage() {
  return [
    '用法：npm run diagnose:hermes-logs [-- --json] [-- --all] [-- --tail-mb <N>] [-- --log-dir <目录>]',
    '                                  [-- --hermes-version <x.y.z>]',
    '',
    '  --json                  输出 agent.army/hermes-log-attribution/v1',
    `  --all                   扫描日志目录内全部 *.log，而不只是 ${DEFAULT_LOG_NAMES.join(' 与 ')}`,
    '  --file <路径>           指定单个日志文件（可重复）',
    '  --tail-mb <N>           扫描窗口大小，默认 8（MiB，从文件尾部读取）',
    '  --log-dir <目录>        Hermes 日志目录，默认自动探测 $HERMES_HOME/logs',
    '  --hermes-version <版本> 本机运行的 Hermes 版本，用于判定各条拒绝措辞是否适用于当前版本。',
    '                          不提供时全部措辞报「适用性未知」（本工具不做版本探测 I/O）。',
    '',
    `默认扫描文件：${DEFAULT_LOG_NAMES.join('、')}。`,
    '  准入拒绝是 WARNING 级，通常只落在 gateway.log，不在 gateway.error.log 里。',
    '',
    '退出码：0 找到飞书链路归属证据（traceback 或非 traceback 拒绝记录）；',
    '        1 两类证据都为零（真正的证据缺口）；2 日志读不出，工具自身无法完成。',
  ].join('\n');
}

/** 自动探测 Hermes 日志目录：只读地试几个候选位置，全部落空就如实报不出。 */
export async function resolveLogDirectory(explicit, environment = process.env) {
  const candidates = [];
  const push = (value) => {
    const text = String(value || '').trim();
    if (text) candidates.push(text);
  };
  push(explicit);
  const hermesHome = String(environment.HERMES_HOME || '').trim() || path.join(os.homedir(), '.hermes');
  push(path.join(hermesHome, 'logs'));
  push(hermesHome);
  for (const candidate of candidates) {
    try {
      const entries = await fs.readdir(candidate);
      if (entries.some((entry) => entry.endsWith('.log'))) return candidate;
    } catch {
      // 继续试下一个候选，绝不因探测失败抛出。
    }
  }
  return null;
}

/** 只读文件尾部 tailBytes 字节，避免把 46 万行整体载入内存。丢掉首个可能被截断的半行。 */
export async function readTail(filePath, tailBytes) {
  const handle = await fs.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, Math.max(1, tailBytes));
    const start = size - length;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    let text = buffer.toString('utf8');
    if (start > 0) {
      const firstBreak = text.indexOf('\n');
      text = firstBreak >= 0 ? text.slice(firstBreak + 1) : '';
    }
    return { text, truncated: start > 0, totalBytes: size };
  } finally {
    await handle.close();
  }
}

async function selectFiles(options) {
  if (options.files.length > 0) return options.files.map((file) => path.resolve(file));
  const directory = await resolveLogDirectory(options.logDir);
  if (!directory) return null;
  // 单个文件缺失沿用既有 log_absent 逐文件报错，不影响 ok。
  if (!options.all) return DEFAULT_LOG_NAMES.map((name) => path.join(directory, name));
  const entries = await fs.readdir(directory);
  return entries.filter((entry) => entry.endsWith('.log')).sort().map((entry) => path.join(directory, entry));
}

export async function runAttribution(options) {
  const files = await selectFiles(options);
  if (!files || files.length === 0) {
    return { ok: false, errorCode: 'log_directory_not_found', reports: [] };
  }
  const reports = [];
  for (const file of files) {
    try {
      const tail = await readTail(file, options.tailBytes);
      reports.push({
        // 只输出基名：绝对路径含用户名与目录结构，不进入输出。
        logFile: path.basename(file),
        totalBytes: tail.totalBytes,
        scanTruncated: tail.truncated,
        attribution: attributeHermesLog(tail.text, {
          tailWindow: tail.truncated,
          hermesVersion: options.hermesVersion,
        }),
      });
    } catch (error) {
      reports.push({
        logFile: path.basename(file),
        errorCode: error?.code === 'ENOENT' ? 'log_absent' : 'log_unreadable',
      });
    }
  }
  return { ok: reports.some((report) => report.attribution), reports };
}

export function renderHumanReadable(result) {
  const lines = ['Hermes 日志子系统归属诊断', '范围：只读本机日志尾部，不启动服务、不修改配置、不产生任何外部副作用。', ''];
  if (!result.ok && result.errorCode === 'log_directory_not_found') {
    lines.push('判定不出：找不到 Hermes 日志目录。');
    lines.push('唯一下一步：用 --log-dir <目录> 指定 Hermes 日志目录（或先确认 HERMES_HOME 指向正确的 Profile）后重跑。');
    return lines.join('\n');
  }
  for (const report of result.reports) {
    lines.push(`日志文件：${report.logFile}`);
    if (!report.attribution) {
      lines.push(`  判定不出：${report.errorCode === 'log_absent' ? '该文件不存在' : '该文件读不出'}。`);
      lines.push('');
      continue;
    }
    const { attribution } = report;
    lines.push(`  文件总大小：${formatBytes(report.totalBytes)}`
      + `；本次扫描 ${attribution.scanned.lineCount} 行${report.scanTruncated ? '（尾部窗口，行号为窗口内相对行号）' : '（全文）'}`
      + `；解析到 ${attribution.scanned.tracebackCount} 条 traceback`
      + `、${attribution.scanned.rejectionRecordCount} 条非 traceback 拒绝/里程碑记录`);
    // 窗口覆盖时间：使「未命中」与「窗口未覆盖」可区分。
    lines.push(`  本次窗口覆盖时间：${attribution.scanned.windowFirstTimestamp ?? '未解析'}`
      + ` → ${attribution.scanned.windowLastTimestamp ?? '未解析'}`);
    lines.push('');
    lines.push('  按子系统归属：');
    for (const subsystem of attribution.subsystems) {
      const relation = subsystem.feishuChainRelated ? '与飞书链路相关' : '与飞书链路无关';
      lines.push(`    - ${subsystem.label}【${relation}】${subsystem.tracebackCount} 条`);
      lines.push(`      异常类名：${subsystem.exceptionClassCounts.slice(0, 5)
        .map((item) => `${item.exceptionClass}×${item.count}`).join('、') || '未解析'}`);
      lines.push(`      出错位置：${subsystem.ownedFrameCounts.slice(0, 5)
        .map((item) => `${item.file}:${item.line}×${item.count}`).join('、') || '无自有栈帧'}`);
      lines.push(`      覆盖行范围：${subsystem.firstLine}–${subsystem.lastLine}`
        + `；最近发生：${subsystem.lastTimestamp ?? '时间戳未解析'}`);
      if (subsystem.rejectionRecordCount > 0) {
        lines.push(`      非 traceback 记录：${subsystem.rejectionRecordCount} 条`
          + `（${subsystem.rejectionSignatureCounts.map((item) => `${item.signatureId}×${item.count}`).join('、')}）`
          + `；最近发生：${subsystem.lastRejectionTimestamp ?? '时间戳未解析'}`);
      }
    }
    lines.push('');
    lines.push('  结论：');
    for (const line of renderAttributionVerdict(attribution).split('\n')) lines.push(`    ${line}`);
    const signatures = summarizeSignatures(attribution.feishuChainTracebacks);
    if (signatures.length > 0) {
      lines.push('');
      lines.push(`  飞书链路签名明细（${attribution.feishuChainTracebacks.length} 条 traceback`
        + ` 折叠为 ${signatures.length} 个不同签名）：`);
      for (const signature of signatures) {
        lines.push(`    - ${signature.subsystem} ×${signature.count}`
          + ` 异常链：${signature.exceptionChain.join(' → ') || '未解析'}`);
        lines.push(`      出错位置：${signature.ownedFrames.map((frame) => `${frame.file}:${frame.line}`
          + `${frame.func ? `(${frame.func})` : ''}`).join(' ← ') || '无自有栈帧'}`);
        lines.push(`      首次 ${signature.firstTimestamp ?? '未解析'} → 最近 ${signature.lastTimestamp ?? '未解析'}`
          + `；覆盖行 ${signature.firstLine}–${signature.lastLine}`);
      }
    }
    // 飞书链路非 traceback 拒绝记录：只输出签名类型、计数、时间与行范围，**绝不输出行内容**。
    const rejectionSummaries = summarizeRejectionSignatures(attribution.feishuChainRejections);
    if (rejectionSummaries.length > 0) {
      lines.push('');
      lines.push(`  飞书链路非 traceback 拒绝记录（${attribution.feishuChainRejections.length} 条`
        + ` 折叠为 ${rejectionSummaries.length} 个签名）：`);
      for (const summary of rejectionSummaries) {
        lines.push(`    - ${summary.signatureId} ×${summary.count}（归属 ${summary.subsystem}`
          + `，${applicabilityLabel(summary.applicability)}）`);
        lines.push(`      首次 ${summary.firstTimestamp ?? '未解析'} → 最近 ${summary.lastTimestamp ?? '未解析'}`
          + `；覆盖行 ${summary.firstLine}–${summary.lastLine}`);
      }
    }
    // 措辞溯源：未命中的措辞照样打印，并标注「不适用 / 适用性未知」（2.45）。
    lines.push('');
    lines.push('  措辞溯源（未匹配到的措辞同样列出）：');
    lines.push('    未匹配到只说明窗口内没有出现该形状，不足以断定该类拒绝没有发生过。');
    for (const entry of attribution.signatureProvenance) {
      lines.push(`    - ${entry.signatureId}【${entry.kind === 'admission_rejection' ? '准入拒绝' : '正向里程碑'}】`
        + `${entry.matchCount > 0 ? `命中 ${entry.matchCount} 次` : '本窗口内未匹配到该形状'}`);
      lines.push(`      来源：${entry.source}`);
      lines.push(`      适用版本：${entry.sourceHermesVersion ?? '来源未登记'}`
        + `；${applicabilityLabel(entry.applicability)}`);
    }
    if (attribution.loggerNameCounts.length > 0) {
      lines.push('');
      lines.push('  日志器名体量（看清噪音归谁，不限于 traceback）：');
      for (const item of attribution.loggerNameCounts.slice(0, 10)) {
        lines.push(`    - ${item.loggerName} ×${item.count}（归属 ${item.subsystem}）`);
      }
    }
    if (attribution.redactedFieldCount > 0) {
      lines.push('');
      lines.push(`  注意：有 ${attribution.redactedFieldCount} 个字段形状不符合预期已被丢弃，`
        + '说明日志格式与解析假设有偏差，结论需谨慎对待。');
    }
    lines.push('');
  }
  lines.push('层级限制：本工具只证明「日志里记录了什么、由谁记录」，'
    + '不证明失败原因，也不证明飞书链路可用；仍需在飞书私聊发一条真实文本消息完成真机验证。');
  return lines.join('\n');
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '未知';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${bytes} B`;
}

// 仍是三个码，不新增码：0 的判定式从「找到飞书 traceback」扩为「找到飞书归属证据」
// （traceback ∪ 非 traceback 拒绝记录）。1 只留给两类都为零的**真正**证据缺口。
// 「0 覆盖两种情形」的信息损失由 evidenceClass 在 --json 输出里补齐，不靠新增退出码解决 ——
// 保持三码可避免调用方脚本改造。
export function decideExitCode(result) {
  if (!result.ok) return 2;
  const foundFeishuEvidence = result.reports.some(
    (report) => (report.attribution?.feishuChainTracebacks.length ?? 0) > 0
      || (report.attribution?.feishuChainRejections.length ?? 0) > 0,
  );
  return foundFeishuEvidence ? 0 : 1;
}

async function main(argv) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${renderUsage()}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${renderUsage()}\n`);
    return 0;
  }
  let result;
  try {
    result = await runAttribution(options);
  } catch (error) {
    process.stderr.write(`日志归属诊断自身无法完成：${String(error?.message || error)}\n`
      + '唯一下一步：用 --log-dir <目录> 指定可读的 Hermes 日志目录后重跑。\n');
    return 2;
  }
  process.stdout.write(options.json
    ? `${JSON.stringify(result, null, 2)}\n`
    : `${renderHumanReadable(result)}\n`);
  return decideExitCode(result);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}

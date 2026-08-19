// Hermes 日志子系统归属 · 纯解析模块（零 I/O）
//
// 存在原因：真机 `gateway.error.log` 已达 46 万行，且被某一个平台插件的重试噪音主导。
// 只统计「异常类名总计数」会得到该插件的噪音，并把它误报为飞书链路的根因 —— 这已实际发生过一次。
// 因此任何日志签名在被报告之前，必须先归属到**发出它的子系统**（platform / core / mcp / provider）。
//
// 硬性约束（与 feishu-commander-chain-observations.ts 同级）：
// - 纯函数，零 I/O。输入是调用方读进来的日志文本。
// - 只输出元数据：异常类名、栈帧文件**基名**与行号、计数、时间戳、行范围。
// - 绝不输出日志消息正文、URL、endpoint、IP、`open_id`、请求头、凭据或任何绝对路径。
//   输出前对每个字段做**白名单形状校验**，形状不符一律丢弃并计入 redactedFieldCount（失败关闭）。

export const HERMES_LOG_ATTRIBUTION_SCHEMA = 'agent.army/hermes-log-attribution/v1';

// --- 子系统分类 ---

export type SubsystemId =
  | 'feishu-platform'
  | 'telegram-platform'
  | 'other-platform'
  | 'mcp'
  | 'model-provider'
  | 'hermes-core'
  | 'unattributed';

export const FEISHU_CHAIN_SUBSYSTEMS: readonly SubsystemId[] = Object.freeze([
  'feishu-platform', 'mcp', 'model-provider', 'hermes-core',
]);

const SUBSYSTEM_LABELS: Readonly<Record<SubsystemId, string>> = Object.freeze({
  'feishu-platform': '飞书平台插件',
  'telegram-platform': 'Telegram 平台插件',
  'other-platform': '其他平台插件',
  mcp: 'MCP 通道',
  'model-provider': '模型 provider 调用',
  'hermes-core': 'Hermes 核心 / Gateway',
  unattributed: '无法归属（全部栈帧都在第三方库内）',
});

export function subsystemLabel(id: SubsystemId): string {
  return SUBSYSTEM_LABELS[id] ?? id;
}

/** 该子系统的签名是否可能与「飞书消息无回复」相关。用于阻止把无关噪音报为本 bug 的原因。 */
export function isFeishuChainRelated(id: SubsystemId): boolean {
  return FEISHU_CHAIN_SUBSYSTEMS.includes(id);
}

// --- 输出结构 ---

export type OwnedFrame = Readonly<{ file: string; line: number; func: string | null }>;

export type TracebackGroup = Readonly<{
  subsystem: SubsystemId;
  /** 归属依据：owning_frame = 最深的非第三方栈帧；logger_name = 日志器名；none = 无法归属。 */
  attributionBasis: 'owning_frame' | 'logger_name' | 'none';
  /** 实际传播出去的异常类名（Python 最后打印的那个）。 */
  exceptionClass: string | null;
  /** 异常链，按 Python 打印顺序（内层 → 外层）。 */
  exceptionChain: readonly string[];
  /** 归属该子系统的栈帧（基名 + 行号），最深在前。第三方库帧不含在内。 */
  ownedFrames: readonly OwnedFrame[];
  loggerName: string | null;
  timestamp: string | null;
  startLine: number;
  endLine: number;
}>;

export type SubsystemReport = Readonly<{
  subsystem: SubsystemId;
  label: string;
  feishuChainRelated: boolean;
  tracebackCount: number;
  /** 异常类名 → 计数，按计数降序。 */
  exceptionClassCounts: readonly Readonly<{ exceptionClass: string; count: number }>[];
  /** 归属该子系统的栈帧位置 → 计数，按计数降序。可直接定位到出错代码行。 */
  ownedFrameCounts: readonly Readonly<{ file: string; line: number; count: number }>[];
  firstLine: number;
  lastLine: number;
  lastTimestamp: string | null;
}>;

export type HermesLogAttribution = Readonly<{
  schemaVersion: typeof HERMES_LOG_ATTRIBUTION_SCHEMA;
  scanned: Readonly<{
    lineCount: number;
    /** 调用方是否只读了文件尾部；true 时行号是窗口内相对行号。 */
    tailWindow: boolean;
    tracebackCount: number;
  }>;
  subsystems: readonly SubsystemReport[];
  /** 与飞书链路相关的子系统的全部 traceback 明细（数量通常很少，值得逐条列出）。 */
  feishuChainTracebacks: readonly TracebackGroup[];
  /** 全文日志器名计数（不限于 traceback），用于看清噪音体量归谁。 */
  loggerNameCounts: readonly Readonly<{ loggerName: string; subsystem: SubsystemId; count: number }>[];
  /** 形状校验未通过、已被丢弃的字段数。>0 说明日志格式与预期不符，结论需谨慎。 */
  redactedFieldCount: number;
}>;

// --- 形状白名单（失败关闭：不符合形状的值一律丢弃，绝不原样输出） ---

const SAFE_CLASS_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const SAFE_PY_BASENAME = /^[A-Za-z0-9_.\-]{1,64}\.py$/;
const SAFE_FUNC_NAME = /^[A-Za-z_<][A-Za-z0-9_>]{0,63}$/;
const SAFE_LOGGER_NAME = /^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*){1,5}$/;
const TIMESTAMP = /\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/;

// --- 行形状 ---

const TRACEBACK_HEADER = /Traceback \(most recent call last\):\s*$/;
const FRAME_LINE = /^\s*File "([^"]+)", line (\d+)(?:, in (\S+))?/;
const CHAINING_NOTICE = /^\s*(?:During handling of the above exception|The above exception was the direct cause)/;
// 异常行：类名（可含点）后紧跟冒号或行尾。只取冒号**之前**的部分，消息正文永不进入输出。
const EXCEPTION_LINE = /^([A-Za-z_][A-Za-z0-9_.]*(?:Error|Exception|Timeout|TimeoutError|Interrupt|Exit|Warning|Failure|Failed))\s*(?::|$)/;
const LOGGER_TOKEN = /\b((?:plugins|gateway|hermes|integrations)\.[a-z_][a-z0-9_.]*)\b/g;

// 第三方库 / 标准库栈帧：这些帧不能决定归属。
const LIBRARY_FRAME = /(?:[\\/]site-packages[\\/]|[\\/]lib[\\/]python\d|[\\/]python3\.\d+[\\/]|[\\/]\.venv[\\/]|[\\/]dist-packages[\\/]|[\\/]asyncio[\\/]|[\\/]concurrent[\\/]futures[\\/])/;

function classifyOwningPath(rawPath: string): SubsystemId | null {
  const normalized = rawPath.replace(/\\/g, '/').toLowerCase();
  const platform = normalized.match(/\/plugins\/platforms\/([a-z0-9_]+)\//);
  if (platform) {
    if (platform[1] === 'feishu') return 'feishu-platform';
    if (platform[1] === 'telegram') return 'telegram-platform';
    return 'other-platform';
  }
  if (/\/mcp[\\/_]|\/mcp\.py$|mcp_server/.test(normalized)) return 'mcp';
  if (/\/(?:providers?|llm|models?|completions?)\//.test(normalized)) return 'model-provider';
  return 'hermes-core';
}

function classifyLoggerName(loggerName: string): SubsystemId | null {
  const platform = loggerName.match(/^(?:plugins|gateway)\.platforms\.([a-z0-9_]+)/);
  if (platform) {
    if (platform[1] === 'feishu') return 'feishu-platform';
    if (platform[1] === 'telegram') return 'telegram-platform';
    if (platform[1] === 'base') return 'hermes-core';
    return 'other-platform';
  }
  if (/(?:^|\.)mcp(?:\.|$)/.test(loggerName)) return 'mcp';
  if (/(?:^|\.)(?:providers?|llm|models?)(?:\.|$)/.test(loggerName)) return 'model-provider';
  if (/^(?:gateway|hermes)\./.test(loggerName)) return 'hermes-core';
  return null;
}

// --- 主解析 ---

type MutableGroup = {
  frames: { path: string; line: number; func: string | null }[];
  exceptionChain: string[];
  loggerName: string | null;
  timestamp: string | null;
  startLine: number;
  endLine: number;
  openForChaining: boolean;
};

export function attributeHermesLog(
  logText: string,
  options: Readonly<{ tailWindow?: boolean }> = {},
): HermesLogAttribution {
  const lines = String(logText ?? '').split(/\r?\n/);
  const rejected = { count: 0 };
  const groups: TracebackGroup[] = [];
  const loggerCounts = new Map<string, number>();

  let current: MutableGroup | null = null;
  // 记录最近一条「非 traceback」行，作为 traceback 所属日志记录的头部（取日志器名与时间戳）。
  let lastHeaderLine = '';

  const closeCurrent = (endLine: number): void => {
    if (!current) return;
    current.endLine = endLine;
    groups.push(sealGroup(current, rejected));
    current = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';

    for (const match of line.matchAll(LOGGER_TOKEN)) {
      const name = match[1] ?? '';
      if (!SAFE_LOGGER_NAME.test(name)) continue;
      loggerCounts.set(name, (loggerCounts.get(name) ?? 0) + 1);
    }

    if (TRACEBACK_HEADER.test(line)) {
      // 异常链（During handling of...）里的第二个 Traceback 属于同一条日志记录，不另开一组。
      if (current && current.openForChaining) {
        current.openForChaining = false;
        continue;
      }
      closeCurrent(index - 1);
      current = {
        frames: [],
        exceptionChain: [],
        loggerName: extractLoggerName(lastHeaderLine),
        timestamp: lastHeaderLine.match(TIMESTAMP)?.[0] ?? null,
        startLine: index,
        endLine: index,
        openForChaining: false,
      };
      continue;
    }

    if (!current) {
      if (line.trim()) lastHeaderLine = line;
      continue;
    }

    const frame = line.match(FRAME_LINE);
    if (frame) {
      current.frames.push({
        path: frame[1] ?? '',
        line: Number.parseInt(frame[2] ?? '', 10),
        func: frame[3] ?? null,
      });
      continue;
    }
    if (CHAINING_NOTICE.test(line)) {
      current.openForChaining = true;
      continue;
    }
    const exception = line.match(EXCEPTION_LINE);
    if (exception) {
      current.exceptionChain.push(exception[1] ?? '');
      continue;
    }
    // 缩进行是栈帧下的源码行，跳过；空行在链式异常之间出现，也跳过。
    if (!line.trim() || /^\s/.test(line)) continue;
    // 顶格且形状都不匹配 ⇒ 下一条日志记录开始。
    closeCurrent(index - 1);
    lastHeaderLine = line;
  }
  closeCurrent(lines.length - 1);

  return Object.freeze({
    schemaVersion: HERMES_LOG_ATTRIBUTION_SCHEMA,
    scanned: Object.freeze({
      // 尾随换行不算一行。
      lineCount: lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length,
      tailWindow: options.tailWindow === true,
      tracebackCount: groups.length,
    }),
    subsystems: summarizeSubsystems(groups),
    feishuChainTracebacks: Object.freeze(groups.filter((group) => isFeishuChainRelated(group.subsystem))),
    loggerNameCounts: Object.freeze([...loggerCounts.entries()]
      .map(([loggerName, count]) => Object.freeze({
        loggerName,
        subsystem: classifyLoggerName(loggerName) ?? 'unattributed' as SubsystemId,
        count,
      }))
      .sort((left, right) => right.count - left.count || left.loggerName.localeCompare(right.loggerName))),
    redactedFieldCount: rejected.count,
  });
}

function extractLoggerName(headerLine: string): string | null {
  for (const match of String(headerLine).matchAll(LOGGER_TOKEN)) {
    const name = match[1] ?? '';
    if (SAFE_LOGGER_NAME.test(name)) return name;
  }
  return null;
}

function sealGroup(group: MutableGroup, rejected: { count: number }): TracebackGroup {
  // 归属：从最深的栈帧往外走，第一个非第三方库帧决定子系统。
  const ownedFrames: OwnedFrame[] = [];
  let subsystem: SubsystemId | null = null;
  for (let index = group.frames.length - 1; index >= 0; index -= 1) {
    const frame = group.frames[index]!;
    if (LIBRARY_FRAME.test(frame.path.replace(/\\/g, '/'))) continue;
    const owned = safeFrame(frame, rejected);
    if (owned) ownedFrames.push(owned);
    if (!subsystem) subsystem = classifyOwningPath(frame.path);
  }
  let basis: TracebackGroup['attributionBasis'] = subsystem ? 'owning_frame' : 'none';
  if (!subsystem && group.loggerName) {
    subsystem = classifyLoggerName(group.loggerName);
    if (subsystem) basis = 'logger_name';
  }
  const chain = group.exceptionChain
    .map((name) => (SAFE_CLASS_NAME.test(name) ? name : (rejected.count += 1, null)))
    .filter((name): name is string => name !== null);
  return Object.freeze({
    subsystem: subsystem ?? 'unattributed',
    attributionBasis: basis,
    // Python 最后打印的异常才是真正传播出去的那个。
    exceptionClass: chain.length > 0 ? chain[chain.length - 1]! : null,
    exceptionChain: Object.freeze(chain),
    ownedFrames: Object.freeze(ownedFrames),
    loggerName: group.loggerName,
    timestamp: group.timestamp,
    startLine: group.startLine,
    endLine: Math.max(group.startLine, group.endLine),
  });
}

// 只输出基名与行号：绝不输出绝对路径（会泄露用户名与目录结构）。
function safeFrame(
  frame: Readonly<{ path: string; line: number; func: string | null }>,
  rejected: { count: number },
): OwnedFrame | null {
  const basename = frame.path.replace(/\\/g, '/').split('/').pop() ?? '';
  if (!SAFE_PY_BASENAME.test(basename) || !Number.isInteger(frame.line)) {
    rejected.count += 1;
    return null;
  }
  const func = frame.func && SAFE_FUNC_NAME.test(frame.func) ? frame.func : null;
  return Object.freeze({ file: basename, line: frame.line, func });
}

function summarizeSubsystems(groups: readonly TracebackGroup[]): readonly SubsystemReport[] {
  const bySubsystem = new Map<SubsystemId, TracebackGroup[]>();
  for (const group of groups) {
    const bucket = bySubsystem.get(group.subsystem);
    if (bucket) bucket.push(group);
    else bySubsystem.set(group.subsystem, [group]);
  }
  return Object.freeze([...bySubsystem.entries()]
    .map(([subsystem, bucket]) => Object.freeze({
      subsystem,
      label: subsystemLabel(subsystem),
      feishuChainRelated: isFeishuChainRelated(subsystem),
      tracebackCount: bucket.length,
      exceptionClassCounts: countBy(
        bucket.map((group) => group.exceptionClass).filter((name): name is string => Boolean(name)),
        (name) => name,
      ).map(([exceptionClass, count]) => Object.freeze({ exceptionClass, count })),
      ownedFrameCounts: countBy(
        bucket.flatMap((group) => group.ownedFrames),
        (frame) => `${frame.file}:${frame.line}`,
      ).map(([key, count]) => {
        const [file = '', line = '0'] = key.split(':');
        return Object.freeze({ file, line: Number.parseInt(line, 10), count });
      }),
      firstLine: Math.min(...bucket.map((group) => group.startLine)),
      lastLine: Math.max(...bucket.map((group) => group.endLine)),
      lastTimestamp: bucket.reduce<string | null>(
        (latest, group) => (group.timestamp && (!latest || group.timestamp > latest) ? group.timestamp : latest),
        null,
      ),
    }))
    .sort((left, right) => right.tracebackCount - left.tracebackCount
      || left.subsystem.localeCompare(right.subsystem)));
}

function countBy<T>(items: readonly T[], key: (item: T) => string): [string, number][] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const bucket = key(item);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}

// --- 签名去重：同一处代码反复抛同一异常时，逐条列出没有意义 ---

export type SignatureSummary = Readonly<{
  subsystem: SubsystemId;
  exceptionChain: readonly string[];
  ownedFrames: readonly OwnedFrame[];
  count: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  firstLine: number;
  lastLine: number;
}>;

/** 把 traceback 按「异常链 + 自有栈帧」折叠成不同签名，按出现次数降序。 */
export function summarizeSignatures(groups: readonly TracebackGroup[]): readonly SignatureSummary[] {
  const bySignature = new Map<string, SignatureSummary>();
  for (const group of groups) {
    const key = `${group.subsystem}|${group.exceptionChain.join('>')}`
      + `|${group.ownedFrames.map((frame) => `${frame.file}:${frame.line}`).join('<')}`;
    const existing = bySignature.get(key);
    if (!existing) {
      bySignature.set(key, Object.freeze({
        subsystem: group.subsystem,
        exceptionChain: group.exceptionChain,
        ownedFrames: group.ownedFrames,
        count: 1,
        firstTimestamp: group.timestamp,
        lastTimestamp: group.timestamp,
        firstLine: group.startLine,
        lastLine: group.endLine,
      }));
      continue;
    }
    bySignature.set(key, Object.freeze({
      ...existing,
      count: existing.count + 1,
      firstTimestamp: minTimestamp(existing.firstTimestamp, group.timestamp),
      lastTimestamp: maxTimestamp(existing.lastTimestamp, group.timestamp),
      firstLine: Math.min(existing.firstLine, group.startLine),
      lastLine: Math.max(existing.lastLine, group.endLine),
    }));
  }
  return Object.freeze([...bySignature.values()].sort((left, right) => right.count - left.count));
}

function minTimestamp(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return right < left ? right : left;
}

function maxTimestamp(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return right > left ? right : left;
}

// --- 结论渲染：把「归属」变成不可绕过的表述约束 ---

export function renderAttributionVerdict(attribution: HermesLogAttribution): string {
  const dominant = attribution.subsystems[0];
  if (!dominant) return '扫描窗口内没有解析到任何 traceback，因此没有可归属的日志签名。';
  const feishuRelated = attribution.subsystems.filter((report) => report.feishuChainRelated);
  const lines: string[] = [];
  lines.push(`主导签名归属：${dominant.label}（${dominant.tracebackCount} 条 traceback，`
    + `最常见异常 ${dominant.exceptionClassCounts[0]?.exceptionClass ?? '未解析'}）。`);
  if (!dominant.feishuChainRelated) {
    // 这是本模块存在的核心原因：无关子系统的噪音必须被明确判为无关。
    lines.push(`**该主导签名与「飞书消息无回复」无关**：它由 ${dominant.label} 发出，不在飞书链路上。`
      + '不得据此推导飞书侧根因，也不得据此套用「无回退链 → 必然静默」的说明。');
  }
  if (feishuRelated.length === 0) {
    lines.push('扫描窗口内**没有任何**归属到飞书链路的 traceback。'
      + '若飞书事件确实在到达，则说明飞书侧的失败根本没有被记录到错误日志 ——'
      + '「没有错误记录」不等于「飞书侧正常」，这本身是一个证据缺口。');
    return lines.join('\n');
  }
  lines.push(`归属到飞书链路的 traceback 共 ${feishuRelated.reduce((sum, r) => sum + r.tracebackCount, 0)} 条：`
    + feishuRelated.map((report) => `${report.label} ${report.tracebackCount} 条`
      + `（${report.exceptionClassCounts.slice(0, 3).map((item) => `${item.exceptionClass}×${item.count}`).join('、') || '异常类名未解析'}）`).join('；'));
  lines.push('这些才是可用于判定飞书侧根因的签名，逐条明细见下。');
  return lines.join('\n');
}

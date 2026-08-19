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

/**
 * 非 traceback 的结构化拒绝 / 里程碑记录。
 *
 * 只承载「签名类型 + 归属 + 时间 + 行号」，与既有 traceback 输出的字段粒度一致。
 * **没有任何字段承载日志行内容** —— 行本身只在识别函数内作为参数存在（2.43 PII 硬约束）。
 */
export type RejectionRecord = Readonly<{
  subsystem: SubsystemId;
  /** 归属依据。非 traceback 记录没有栈帧，因此不能用 owning_frame。 */
  attributionBasis: 'signature_platform' | 'logger_name' | 'none';
  /** 日志器名与签名自带平台线索冲突时为 true，不得静默吞掉。 */
  attributionConflict: boolean;
  signatureId: RejectionSignatureId;
  kind: RejectionSignatureSpec['kind'];
  applicability: SignatureApplicability;
  loggerName: string | null;
  timestamp: string | null;
  line: number;
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
  /** 本轮新增：非 traceback 拒绝 / 里程碑记录条数。`tracebackCount` 保持 traceback-only。 */
  rejectionRecordCount: number;
  /** 本轮新增：签名类型 → 计数，按计数降序。 */
  rejectionSignatureCounts: readonly Readonly<{ signatureId: RejectionSignatureId; count: number }>[];
  /** 本轮新增：该子系统内非 traceback 记录的最近时间。与既有 lastTimestamp 分开，避免改变既有字段语义。 */
  lastRejectionTimestamp: string | null;
}>;

export type HermesLogAttribution = Readonly<{
  schemaVersion: typeof HERMES_LOG_ATTRIBUTION_SCHEMA;
  scanned: Readonly<{
    lineCount: number;
    /** 调用方是否只读了文件尾部；true 时行号是窗口内相对行号。 */
    tailWindow: boolean;
    tracebackCount: number;
    /** 本轮新增：非 traceback 拒绝 / 里程碑记录总条数。 */
    rejectionRecordCount: number;
    /**
     * 本轮新增：窗口实际覆盖的时间范围，用于把「未命中」与「窗口未覆盖」区分开。
     * 没有这两个字段时，「窗口内没扫到」会被误读成「事情没发生」。
     */
    windowFirstTimestamp: string | null;
    windowLastTimestamp: string | null;
  }>;
  subsystems: readonly SubsystemReport[];
  /** 与飞书链路相关的子系统的全部 traceback 明细（数量通常很少，值得逐条列出）。 */
  feishuChainTracebacks: readonly TracebackGroup[];
  /** 本轮新增：归属到飞书链路的非 traceback 记录明细。与 feishuChainTracebacks 平行，互不混入。 */
  feishuChainRejections: readonly RejectionRecord[];
  /** 本轮新增：每条登记措辞的溯源与本次是否命中。**未命中也必须出现在这里**（2.45）。 */
  signatureProvenance: readonly Readonly<{
    signatureId: RejectionSignatureId;
    kind: RejectionSignatureSpec['kind'];
    source: string;
    sourceHermesVersion: string | null;
    applicability: SignatureApplicability;
    matchCount: number;
  }>[];
  /** 本轮新增：证据类别，使退出码 0 的两种情形在机器可读输出里可区分。 */
  evidenceClass: 'traceback' | 'rejection' | 'both' | 'none';
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
// 拒绝记录专用：先用更宽的 LOOSE_TIMESTAMP 提取候选，再用锚定的 SAFE_TIMESTAMP 全量校验。
// 两段分开是为了让「畸形时间戳 → 丢弃并计入 redactedFieldCount」这条失败关闭分支真正可达 ——
// 若直接用 TIMESTAMP 提取，取回的必然已符合 TIMESTAMP 正文，锚定复校永远通过，失败关闭形同虚设。
// 既有 TIMESTAMP 一字不改：traceback 路径仍复用它（3.25 保持项）。
const LOOSE_TIMESTAMP = /\d{2,4}-\d{1,2}-\d{1,2}[ T]\d{1,2}:\d{1,2}:\d{1,2}/;
const SAFE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/;

// --- 非异常型拒绝记录的措辞登记表（2.45：来源溯源 + 多版本容纳） ---
//
// 真机上飞书侧的失败是一条**不带 traceback 的结构化日志行**，只解析 traceback 会把
// 「已被明确记录的失败」误报为「失败根本没有被记录」。措辞表是识别该类记录的唯一来源。
//
// PII 硬约束（2.43，最高优先）：拒绝日志行本身含真实姓名与账号标识。
// 因此五条 pattern 全部**零捕获组**（只用 `(?:…)`），无反向引用，长度有界，且**只用于 test()**。
// `Unauthorized user:` 与 `on feishu` 之间的账号标识与姓名落在 `[^\n]{1,200}?` 内，
// 该片段既无捕获组也从不被读取 —— 识别与输出彻底解耦。

export type RejectionSignatureId =
  | 'admission-unauthorized-user'      // 当前版本（0.20.1）形状
  | 'admission-dm-policy-rejected'     // 0.19 时代形状
  | 'feishu-inbound-received'          // 正向签名（入站到达）
  | 'feishu-response-ready'            // 正向签名（回复就绪）
  | 'feishu-response-sending';         // 正向签名（出站发送）

export type SignatureApplicability = 'current_version' | 'other_version' | 'unknown';

export type RejectionSignatureSpec = Readonly<{
  id: RejectionSignatureId;
  kind: 'admission_rejection' | 'positive_milestone';
  /** 仓库内来源位置。用于 2.35 的溯源，不含任何真实取值。 */
  source: string;
  /** 来源登记的适用 Hermes 版本；null = 来源未登记版本 ⇒ 适用性只能是 'unknown'。 */
  sourceHermesVersion: string | null;
  /** 只判定是否匹配的形状正则。零捕获组，只用于 test()。 */
  pattern: RegExp;
  /** 签名自带的平台归属线索（措辞里含 feishu 时为 'feishu-platform'）。 */
  platformHint: SubsystemId | null;
}>;

export const REJECTION_SIGNATURES: readonly RejectionSignatureSpec[] = Object.freeze([
  Object.freeze({
    id: 'admission-unauthorized-user' as const,
    kind: 'admission_rejection' as const,
    source: '.kiro/specs/feishu-commander-no-reply-fix/bugfix.md《第四轮外部直连诊断实测》',
    sourceHermesVersion: '0.20.1',
    pattern: /Unauthorized user:[^\n]{1,200}?\bon\s+feishu\b/i,
    platformHint: 'feishu-platform' as const,
  }),
  Object.freeze({
    id: 'admission-dm-policy-rejected' as const,
    kind: 'admission_rejection' as const,
    source: 'docs/reviews/m1-xiaod-feishu-closure/acceptance.md（2026-07-19）',
    sourceHermesVersion: null,
    pattern: /\bdm_policy_rejected\b/,
    platformHint: null,
  }),
  Object.freeze({
    id: 'feishu-inbound-received' as const,
    kind: 'positive_milestone' as const,
    source: 'docs/guides/创建Hermes-Agent与飞书Bot接线教程.md、docs/archive/handoffs/av-transcriber-feishu-provisioning-handoff.md',
    sourceHermesVersion: null,
    pattern: /(?:\[Feishu\]\s+Inbound\s+(?:dm|group)\s+message\s+received|inbound\s+message:\s*platform=feishu)/i,
    platformHint: 'feishu-platform' as const,
  }),
  Object.freeze({
    id: 'feishu-response-ready' as const,
    kind: 'positive_milestone' as const,
    source: 'docs/guides/创建Hermes-Agent与飞书Bot接线教程.md',
    sourceHermesVersion: null,
    pattern: /response\s+ready:\s*platform=feishu/i,
    platformHint: 'feishu-platform' as const,
  }),
  Object.freeze({
    id: 'feishu-response-sending' as const,
    kind: 'positive_milestone' as const,
    source: 'docs/guides/创建Hermes-Agent与飞书Bot接线教程.md',
    sourceHermesVersion: null,
    pattern: /\[Feishu\]\s+Sending\s+response/i,
    platformHint: 'feishu-platform' as const,
  }),
]);

/**
 * 措辞适用性判定（2.45）。**未命中不等于未发生** —— 来源没登记版本、或调用方没注入运行版本时，
 * 只能报「适用性未知」，绝不能表述为「未发生该类拒绝」。
 * 运行版本由调用方注入，纯解析模块不做任何版本 I/O 探测。
 */
export function classifyApplicability(
  spec: RejectionSignatureSpec,
  runningHermesVersion: string | null,
): SignatureApplicability {
  if (spec.sourceHermesVersion === null || runningHermesVersion === null) return 'unknown';
  return spec.sourceHermesVersion === runningHermesVersion ? 'current_version' : 'other_version';
}

/** 适用性的固定表述（2.45）：未命中只能说「不适用 / 适用性未知」。 */
export function applicabilityLabel(applicability: SignatureApplicability): string {
  if (applicability === 'current_version') return '适用于当前版本';
  if (applicability === 'other_version') return '该措辞在当前版本不适用';
  return '适用性未知';
}

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

/**
 * 识别一行是否命中登记措辞，并归属到子系统。
 *
 * PII 硬约束（2.43）：**只允许 `spec.pattern.test(line)`**。
 * 禁止 match / exec / matchAll / 替换回调作用于拒绝行 —— 那会把姓名与账号标识取进来。
 * 返回值不含任何承载行内容的字符串字段。
 */
function matchRejectionLine(
  line: string,
  index: number,
  runningHermesVersion: string | null,
  rejected: { count: number },
): RejectionRecord | null {
  for (const spec of REJECTION_SIGNATURES) {
    // 只判定，不提取。
    if (!spec.pattern.test(line)) continue;

    const loggerName = extractLoggerName(line);
    const loggerSubsystem = loggerName ? classifyLoggerName(loggerName) : null;
    // 归属顺序：签名自带 platformHint 优先 → 否则日志器名 → 否则 unattributed。
    let subsystem: SubsystemId;
    let basis: RejectionRecord['attributionBasis'];
    if (spec.platformHint) {
      subsystem = spec.platformHint;
      basis = 'signature_platform';
    } else if (loggerSubsystem) {
      subsystem = loggerSubsystem;
      basis = 'logger_name';
    } else {
      subsystem = 'unattributed';
      basis = 'none';
    }
    // 两个线索都存在且不一致时取 platformHint，但**必须留痕**，不得静默吞掉。
    const attributionConflict = Boolean(spec.platformHint && loggerSubsystem
      && loggerSubsystem !== spec.platformHint);

    // 时间戳失败关闭：宽提取 → 锚定全量校验 → 不通过即丢弃并计入 redactedFieldCount。
    // 行内**没有**时间戳形状是正常情形（很多日志行不带时间戳），静默跳过，不计数。
    let timestamp: string | null = null;
    const loose = line.match(LOOSE_TIMESTAMP)?.[0] ?? null;
    if (loose !== null) {
      if (SAFE_TIMESTAMP.test(loose)) timestamp = loose;
      else rejected.count += 1;
    }

    return Object.freeze({
      subsystem,
      attributionBasis: basis,
      attributionConflict,
      signatureId: spec.id,
      kind: spec.kind,
      applicability: classifyApplicability(spec, runningHermesVersion),
      loggerName,
      timestamp,
      line: index,
    });
  }
  return null;
}

export function attributeHermesLog(
  logText: string,
  options: Readonly<{ tailWindow?: boolean; hermesVersion?: string | null }> = {},
): HermesLogAttribution {
  const lines = String(logText ?? '').split(/\r?\n/);
  const rejected = { count: 0 };
  const groups: TracebackGroup[] = [];
  const loggerCounts = new Map<string, number>();
  const runningHermesVersion = options.hermesVersion ?? null;
  const rejectionRecords: RejectionRecord[] = [];
  const signatureMatchCounts = new Map<RejectionSignatureId, number>();
  // 窗口覆盖时间：取窗口内首个与末个通过 SAFE_TIMESTAMP 校验的时间戳。
  let windowFirstTimestamp: string | null = null;
  let windowLastTimestamp: string | null = null;

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

    // 窗口覆盖时间：对**每一行**扫描，使「未命中」与「窗口未覆盖」可区分。
    // 行内没有时间戳形状是正常情形，静默跳过且**不计入 redactedFieldCount** ——
    // 否则既有夹具里大量无时间戳的栈帧行会让 redactedFieldCount 回归。
    const windowCandidate = line.match(LOOSE_TIMESTAMP)?.[0] ?? null;
    if (windowCandidate !== null && SAFE_TIMESTAMP.test(windowCandidate)) {
      if (windowFirstTimestamp === null) windowFirstTimestamp = windowCandidate;
      windowLastTimestamp = windowCandidate;
    }

    // 拒绝记录识别（复核 F5）：必须在**每行的前置段**无条件执行，与 current（是否处在
    // traceback 内）状态无关。写在 `if (!current)` 之后会让「拒绝行紧跟 traceback 末行」
    // 的真机形态漏识别 —— 那正是 E1 夹具的形状。
    const rejection = matchRejectionLine(line, index, runningHermesVersion, rejected);
    if (rejection) {
      rejectionRecords.push(rejection);
      signatureMatchCounts.set(rejection.signatureId,
        (signatureMatchCounts.get(rejection.signatureId) ?? 0) + 1);
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

  const feishuChainTracebacks = Object.freeze(groups.filter((group) => isFeishuChainRelated(group.subsystem)));
  const feishuChainRejections = Object.freeze(rejectionRecords
    .filter((record) => isFeishuChainRelated(record.subsystem)));

  return Object.freeze({
    schemaVersion: HERMES_LOG_ATTRIBUTION_SCHEMA,
    scanned: Object.freeze({
      // 尾随换行不算一行。
      lineCount: lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length,
      tailWindow: options.tailWindow === true,
      // traceback-only：拒绝记录**不得**混入这个计数（3.25）。
      tracebackCount: groups.length,
      rejectionRecordCount: rejectionRecords.length,
      windowFirstTimestamp,
      windowLastTimestamp,
    }),
    subsystems: summarizeSubsystems(groups, rejectionRecords),
    feishuChainTracebacks,
    feishuChainRejections,
    signatureProvenance: Object.freeze(REJECTION_SIGNATURES.map((spec) => Object.freeze({
      signatureId: spec.id,
      kind: spec.kind,
      source: spec.source,
      sourceHermesVersion: spec.sourceHermesVersion,
      applicability: classifyApplicability(spec, runningHermesVersion),
      // 未命中也照样出现在这里，计数为 0（2.45：未命中 ≠ 未发生）。
      matchCount: signatureMatchCounts.get(spec.id) ?? 0,
    }))),
    evidenceClass: classifyEvidence(feishuChainTracebacks.length, feishuChainRejections.length),
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

function classifyEvidence(
  tracebackCount: number,
  rejectionCount: number,
): HermesLogAttribution['evidenceClass'] {
  if (tracebackCount > 0 && rejectionCount > 0) return 'both';
  if (tracebackCount > 0) return 'traceback';
  if (rejectionCount > 0) return 'rejection';
  return 'none';
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

function summarizeSubsystems(
  groups: readonly TracebackGroup[],
  rejectionRecords: readonly RejectionRecord[] = [],
): readonly SubsystemReport[] {
  const bySubsystem = new Map<SubsystemId, TracebackGroup[]>();
  for (const group of groups) {
    const bucket = bySubsystem.get(group.subsystem);
    if (bucket) bucket.push(group);
    else bySubsystem.set(group.subsystem, [group]);
  }
  // 只有拒绝记录、无 traceback 的子系统**也要生成条目**（tracebackCount: 0），
  // 否则「一行准入拒绝」这种真机形态会连子系统条目都没有。
  const rejectionsBySubsystem = new Map<SubsystemId, RejectionRecord[]>();
  for (const record of rejectionRecords) {
    const bucket = rejectionsBySubsystem.get(record.subsystem);
    if (bucket) bucket.push(record);
    else rejectionsBySubsystem.set(record.subsystem, [record]);
    if (!bySubsystem.has(record.subsystem)) bySubsystem.set(record.subsystem, []);
  }
  return Object.freeze([...bySubsystem.entries()]
    .map(([subsystem, bucket]) => {
      const records = rejectionsBySubsystem.get(subsystem) ?? [];
      // 空集合守卫：Math.min(...[]) === Infinity。某子系统只有拒绝记录、
      // 或（理论上）只有 traceback 时，展开空数组会产出 Infinity / -Infinity。
      const startLines = [...bucket.map((group) => group.startLine), ...records.map((record) => record.line)];
      const endLines = [...bucket.map((group) => group.endLine), ...records.map((record) => record.line)];
      return Object.freeze({
        subsystem,
        label: subsystemLabel(subsystem),
        feishuChainRelated: isFeishuChainRelated(subsystem),
        // traceback-only：拒绝记录另计（3.25）。
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
        firstLine: startLines.length > 0 ? Math.min(...startLines) : 0,
        lastLine: endLines.length > 0 ? Math.max(...endLines) : 0,
        lastTimestamp: bucket.reduce<string | null>(
          (latest, group) => (group.timestamp && (!latest || group.timestamp > latest) ? group.timestamp : latest),
          null,
        ),
        rejectionRecordCount: records.length,
        rejectionSignatureCounts: countBy(records, (record) => record.signatureId)
          .map(([signatureId, count]) => Object.freeze({
            signatureId: signatureId as RejectionSignatureId,
            count,
          })),
        lastRejectionTimestamp: records.reduce<string | null>(
          (latest, record) => (record.timestamp && (!latest || record.timestamp > latest) ? record.timestamp : latest),
          null,
        ),
      });
    })
    // 排序键：traceback + 拒绝记录总数降序，tiebreak 仍为 subsystem.localeCompare。
    .sort((left, right) => (right.tracebackCount + right.rejectionRecordCount)
      - (left.tracebackCount + left.rejectionRecordCount)
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

// --- 非 traceback 记录的折叠：与 summarizeSignatures() 平行，互不改动 ---

export type RejectionSignatureSummary = Readonly<{
  subsystem: SubsystemId;
  signatureId: RejectionSignatureId;
  applicability: SignatureApplicability;
  count: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  firstLine: number;
  lastLine: number;
}>;

/**
 * 把非 traceback 记录按「子系统 + 签名类型」折叠。
 *
 * 折叠键**只由 subsystem + signatureId 组成**，不含任何来自日志行的取值 ——
 * 因此摘要在结构上不可能承载 PII（2.43）。
 */
export function summarizeRejectionSignatures(
  records: readonly RejectionRecord[],
): readonly RejectionSignatureSummary[] {
  const bySignature = new Map<string, RejectionSignatureSummary>();
  for (const record of records) {
    const key = `${record.subsystem}|${record.signatureId}`;
    const existing = bySignature.get(key);
    if (!existing) {
      bySignature.set(key, Object.freeze({
        subsystem: record.subsystem,
        signatureId: record.signatureId,
        applicability: record.applicability,
        count: 1,
        firstTimestamp: record.timestamp,
        lastTimestamp: record.timestamp,
        firstLine: record.line,
        lastLine: record.line,
      }));
      continue;
    }
    bySignature.set(key, Object.freeze({
      ...existing,
      count: existing.count + 1,
      firstTimestamp: minTimestamp(existing.firstTimestamp, record.timestamp),
      lastTimestamp: maxTimestamp(existing.lastTimestamp, record.timestamp),
      firstLine: Math.min(existing.firstLine, record.line),
      lastLine: Math.max(existing.lastLine, record.line),
    }));
  }
  return Object.freeze([...bySignature.values()].sort((left, right) => right.count - left.count
    || left.subsystem.localeCompare(right.subsystem)
    || left.signatureId.localeCompare(right.signatureId)));
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
  // 提前 return 分支（复核 F4）：条件从 `!dominant` 收紧为「无 subsystems **且**无拒绝记录」。
  // 子串「没有解析到任何 traceback」逐字节保留。
  if (!dominant && attribution.scanned.rejectionRecordCount === 0) {
    return '扫描窗口内没有解析到任何 traceback，非异常型拒绝记录同样为零，因此没有可归属的日志签名。'
      + `${renderWindowCoverage(attribution)}`
      + '\n唯一下一步：用 --tail-mb 扩大扫描窗口，或用 --all 覆盖 gateway.log 后重跑。';
  }
  const feishuRelated = attribution.subsystems.filter((report) => report.feishuChainRelated);
  const feishuTracebackCount = attribution.feishuChainTracebacks.length;
  const feishuRejections = attribution.feishuChainRejections;
  const lines: string[] = [];

  if (dominant) {
    // 首行渲染分支（复核 F3）：主导子系统可能 0 条 traceback（排序键含拒绝记录）。
    // 此时打印「最常见异常 未解析」会产出自相矛盾的首行，故改用记录口径。
    if (dominant.tracebackCount === 0 && dominant.rejectionRecordCount > 0) {
      lines.push(`主导记录归属：${dominant.label}（0 条 traceback，`
        + `${dominant.rejectionRecordCount} 条非 traceback 记录）。`);
    } else {
      lines.push(`主导签名归属：${dominant.label}（${dominant.tracebackCount} 条 traceback，`
        + `最常见异常 ${dominant.exceptionClassCounts[0]?.exceptionClass ?? '未解析'}）。`);
    }
    if (!dominant.feishuChainRelated) {
      // 这是本模块存在的核心原因：无关子系统的噪音必须被明确判为无关。
      lines.push(`**该主导签名与「飞书消息无回复」无关**：它由 ${dominant.label} 发出，不在飞书链路上。`
        + '不得据此推导飞书侧根因，也不得据此套用「无回退链 → 必然静默」的说明。');
    }
  }

  // 证据缺口分支（复核 F4 / 2.44 核心）：条件从 `feishuRelated.length === 0` 收紧为
  // 「飞书 traceback 数 === 0 **且**飞书拒绝记录数 === 0」。两段被断言的子串逐字节保留。
  if (feishuTracebackCount === 0 && feishuRejections.length === 0) {
    lines.push('扫描窗口内**没有任何**归属到飞书链路的 traceback。'
      + '若飞书事件确实在到达，则说明飞书侧的失败根本没有被记录到错误日志 ——'
      + '「没有错误记录」不等于「飞书侧正常」，这本身是一个证据缺口。');
    return lines.join('\n');
  }

  if (feishuTracebackCount > 0) {
    lines.push(`归属到飞书链路的 traceback 共 ${feishuRelated.reduce((sum, r) => sum + r.tracebackCount, 0)} 条：`
      + feishuRelated.filter((report) => report.tracebackCount > 0).map((report) => `${report.label} ${report.tracebackCount} 条`
        + `（${report.exceptionClassCounts.slice(0, 3).map((item) => `${item.exceptionClass}×${item.count}`).join('、') || '异常类名未解析'}）`).join('；'));
    lines.push('这些才是可用于判定飞书侧根因的签名，逐条明细见下。');
  }

  if (feishuRejections.length > 0) {
    lines.push(...renderRejectionEvidence(attribution, feishuRejections));
  }
  return lines.join('\n');
}

/** 窗口覆盖范围。使「未命中」与「窗口未覆盖」可区分，不得把「窗口外」表述为「未命中」。 */
function renderWindowCoverage(attribution: HermesLogAttribution): string {
  const { windowFirstTimestamp, windowLastTimestamp } = attribution.scanned;
  if (!windowFirstTimestamp && !windowLastTimestamp) {
    return '\n本次窗口覆盖时间：无法判定（窗口内没有可解析的时间戳）——'
      + '因此**不能**断定事发时间已被覆盖。';
  }
  return `\n本次窗口覆盖时间：${windowFirstTimestamp ?? '未解析'} → ${windowLastTimestamp ?? '未解析'}。`
    + '若事发时间不在此范围内，属**窗口未覆盖**，不得表述为「未命中」。';
}

/**
 * 飞书拒绝记录分支（按复核 F2 分叉）。
 *
 * 正向里程碑不是失败：把「回复已发出」渲染成「已定位的失败证据」会与本轮
 * 「不再误导排查者」的目的正好相反。因此文案按 kind 分叉。
 * 两种情形都**不输出任何取值**，只给签名类型、计数、时间、行范围与溯源。
 */
function renderRejectionEvidence(
  attribution: HermesLogAttribution,
  records: readonly RejectionRecord[],
): string[] {
  const lines: string[] = [];
  const admissions = records.filter((record) => record.kind === 'admission_rejection');
  const milestones = records.filter((record) => record.kind === 'positive_milestone');
  const summaries = summarizeRejectionSignatures(records);
  const describe = (kind: RejectionSignatureSpec['kind']): string => summaries
    .filter((item) => records.some((record) => record.signatureId === item.signatureId && record.kind === kind))
    .map((item) => `${item.signatureId}×${item.count}`
      + `（${item.firstTimestamp ?? '时间未解析'} → ${item.lastTimestamp ?? '时间未解析'}`
      + `，行 ${item.firstLine}–${item.lastLine}）`)
    .join('；');

  if (admissions.length > 0) {
    // 2.44：证据存在时**不得**再说「失败未被记录」，必须报为已定位的失败证据。
    lines.push(`归属到飞书链路的非 traceback 拒绝记录共 ${admissions.length} 条，`
      + '**这是已定位的失败证据**，不是证据缺口：' + describe('admission_rejection'));
    lines.push('唯一下一步：核对两套白名单（军团侧 store 与 Hermes Profile 环境文件）是否对齐，'
      + '对齐后重启 Gateway。');
  } else if (milestones.length > 0) {
    // 只有正向里程碑：入站到达 / 回复就绪被记录，但窗口内没有失败记录。
    lines.push(`窗口内找到 ${milestones.length} 条飞书链路正向里程碑记录：` + describe('positive_milestone'));
    lines.push('入站到达 / 回复就绪已被记录，但窗口内无飞书失败记录。'
      + '唯一下一步：确认事发时间是否落在本窗口内；若在窗口内，则失败不在 Hermes 日志侧，'
      + '改查模型侧回复能力。');
  }
  if (milestones.length > 0 && admissions.length > 0) {
    lines.push(`同时找到 ${milestones.length} 条正向里程碑记录：` + describe('positive_milestone')
      + '。正向里程碑不是失败证据，只用于区分「入站到达但被拒绝」与「入站根本没到」。');
  }
  const conflicts = records.filter((record) => record.attributionConflict);
  if (conflicts.length > 0) {
    lines.push(`注意：有 ${conflicts.length} 条记录的日志器名与签名自带平台线索不一致，`
      + '已按签名线索归属并留痕（attributionConflict），结论需人工复核。');
  }
  lines.push(renderWindowCoverage(attribution).trimStart());
  lines.push(renderProvenance(attribution));
  return lines;
}

/** 措辞溯源（2.45）。未命中的措辞照样列出，且只能说「不适用 / 适用性未知」。 */
function renderProvenance(attribution: HermesLogAttribution): string {
  const rows = attribution.signatureProvenance.map((entry) => {
    // 2.45：未命中只能报「不适用 / 适用性未知」，SHALL NOT 表述为该类拒绝没有发生过。
    // 措辞刻意绕开「未发生该类拒绝」这一表述本身：只陈述「窗口内没匹配到这个形状」这个事实。
    const hit = entry.matchCount > 0
      ? `命中 ${entry.matchCount} 次`
      : `本窗口内未匹配到该形状（${applicabilityLabel(entry.applicability)}）`;
    return `    - ${entry.signatureId}：${hit}；来源 ${entry.source}；`
      + `适用版本 ${entry.sourceHermesVersion ?? '来源未登记'}；${applicabilityLabel(entry.applicability)}`;
  });
  return ['措辞溯源（每条登记措辞的来源与适用版本，未匹配到的也列出）：',
    '  未匹配到只说明窗口内没有出现该形状，不足以断定该类拒绝没有发生过。', ...rows].join('\n');
}

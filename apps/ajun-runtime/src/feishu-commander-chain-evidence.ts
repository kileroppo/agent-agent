// 飞书军团总管链路证据账本 · A君运行时侧
//
// 目的：让「飞书里没有任何回复」变成可归因的事实。403 拒绝（需求 2.5）与
// `handled:false` 有意不建任务（需求 2.8）都在本机留下带 sourceEventRef 的
// 可判定证据，使「有意静默」与「链路故障」在事后能被区分。
//
// 硬性约束：
// - **写入失败绝不影响主流程**：`record` 捕获全部异常并返回 null。
// - 只写摘要：chatRef / requesterRef 只以 sha256 前 12 位出现；不写消息正文、
//   不写 `.env` 内容、不写 token / Cookie / 授权链接（需求 2.11）。
// - 目录 0700、文件 0600；路径经既有 prepareWorkspaceFile() 越界与符号链接守卫。
// - `externalActionStarted` 恒为 false：本模块只记录事实，从不启动外部动作。

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { prepareWorkspaceFile } from './workspace-path-guard.ts';
import type { TruthLayer } from './feishu-commander-chain-diagnosis.ts';

export const FEISHU_COMMANDER_CHAIN_EVIDENCE_SCHEMA = 'agent.army/feishu-commander-chain-evidence/v1';

export const EVIDENCE_DIRECTORY_NAME = 'feishu-commander-chain';
export const RUNTIME_EVIDENCE_FILE_PREFIX = 'runtime-evidence-';

export const COMMANDER_CHAIN_EVIDENCE_KINDS = Object.freeze([
  'ingress_rejected_non_local', // 需求 2.5：403 分支
  'no_task_by_design', // 需求 2.8：handled:false + reason
  'diagnosis_completed', // 诊断入口自身留痕
] as const);

export type CommanderChainEvidenceKind = (typeof COMMANDER_CHAIN_EVIDENCE_KINDS)[number];

export type CommanderChainEvidenceRecord = Readonly<{
  schemaVersion: typeof FEISHU_COMMANDER_CHAIN_EVIDENCE_SCHEMA;
  recordedAt: string;
  side: 'ajun-runtime' | 'hermes-gateway';
  kind: CommanderChainEvidenceKind | string;
  sourceEventRef: string | null;
  chatRefDigest: string | null;
  requesterRefDigest: string | null;
  profileAgentId: string | null;
  httpStatus: number | null;
  reason: string | null;
  outcome: string;
  truthLayer: TruthLayer;
  externalActionStarted: false;
  nextStep: string | null;
}>;

export type CommanderChainEvidenceInput = Readonly<{
  kind: CommanderChainEvidenceKind | string;
  sourceEventRef?: unknown;
  chatRef?: unknown;
  requesterRef?: unknown;
  profileAgentId?: unknown;
  httpStatus?: unknown;
  reason?: unknown;
  outcome?: unknown;
  truthLayer?: TruthLayer;
  nextStep?: unknown;
}>;

export type FeishuCommanderChainEvidenceLedger = Readonly<{
  record(input: CommanderChainEvidenceInput): Promise<CommanderChainEvidenceRecord | null>;
  readRecent(options?: Readonly<{ days?: number; limit?: number }>): Promise<readonly CommanderChainEvidenceRecord[]>;
}>;

const DEFAULT_RETENTION_DAYS = 14;
const DEFAULT_READ_DAYS = 3;
const DEFAULT_READ_LIMIT = 200;
const MAX_TEXT_LENGTH = 300;

// 中文一句话结论：无 outcome 时按 kind 给出可读默认值。
const DEFAULT_OUTCOMES: Readonly<Record<string, string>> = Object.freeze({
  ingress_rejected_non_local: '总管入口拒绝了非本机调用，未启动任何外部动作。',
  no_task_by_design: '这句话被判定为不该建任务，已交回 Hermes 普通聊天，未启动任何外部动作。',
  diagnosis_completed: '本机链路诊断已跑完，只读判定，未启动任何外部动作。',
});

// secret 形态一律拒写（宁可丢证据，也不让凭据落盘）。
const SECRET_SHAPED_PATTERNS: readonly RegExp[] = Object.freeze([
  /sk-[A-Za-z0-9_-]{8,}/,
  /bearer\s+\S+/i,
  /[?&](?:token|access_token|api_key|apikey|key|secret|password|passwd)=/i,
  /\b(?:authorization|cookie|set-cookie)\b\s*[:=]/i,
  /\b(?:token|secret|password|passwd|api[_-]?key)\b\s*[:=]\s*\S/i,
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/,
  /https?:\/\/\S*(?:token|code|auth|secret)=/i,
]);

export class CommanderChainEvidenceSecretShapeError extends Error {
  code = 'commander_chain_evidence_secret_shaped';

  constructor(field: string) {
    super(`链路证据字段「${field}」呈 secret 形态，拒绝落盘。`);
    this.name = 'CommanderChainEvidenceSecretShapeError';
  }
}

export function digestRef(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  return `sha256:${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
}

// 写入前的统一断言：任何字段的字符串取值都不得呈 secret 形态。
export function assertNoSecretShaped(record: Readonly<Record<string, unknown>>): void {
  for (const [field, value] of Object.entries(record)) {
    if (typeof value !== 'string' || !value) continue;
    // 摘要字段本身就是 sha256:<12hex>，不参与形态判定。
    if (field.endsWith('Digest')) continue;
    if (SECRET_SHAPED_PATTERNS.some((pattern) => pattern.test(value))) {
      throw new CommanderChainEvidenceSecretShapeError(field);
    }
  }
}

export function evidenceFileNameForDate(date: Date): string {
  return `${RUNTIME_EVIDENCE_FILE_PREFIX}${date.toISOString().slice(0, 10)}.jsonl`;
}

export function createFeishuCommanderChainEvidenceLedger(options: Readonly<{
  dataDir: string;
  now?: () => Date;
  retentionDays?: number;
}>): FeishuCommanderChainEvidenceLedger {
  const dataDir = String(options?.dataDir || '').trim();
  const now = options?.now ?? ((): Date => new Date());
  const retentionDays = Number.isInteger(options?.retentionDays) && Number(options?.retentionDays) > 0
    ? Number(options?.retentionDays)
    : DEFAULT_RETENTION_DAYS;

  return Object.freeze({
    async record(input: CommanderChainEvidenceInput): Promise<CommanderChainEvidenceRecord | null> {
      try {
        if (!dataDir) return null;
        return buildEvidenceRecord(input, now());
      } catch {
        return null;
      }
    },
    async readRecent(readOptions = {}): Promise<readonly CommanderChainEvidenceRecord[]> {
      try {
        if (!dataDir) return Object.freeze([]);
        const days = Number.isInteger(readOptions.days) && Number(readOptions.days) > 0
          ? Number(readOptions.days)
          : DEFAULT_READ_DAYS;
        const limit = Number.isInteger(readOptions.limit) && Number(readOptions.limit) > 0
          ? Number(readOptions.limit)
          : DEFAULT_READ_LIMIT;
        const records = await readEvidenceWindow(dataDir, now(), days);
        return Object.freeze(records.slice(-limit));
      } catch {
        return Object.freeze([]);
      }
    },
  });
}

// 每种证据的唯一下一步（需求 2.5 / 2.8：证据必须能指向下一步动作）。
const DEFAULT_NEXT_STEPS: Readonly<Record<string, string>> = Object.freeze({
  ingress_rejected_non_local: '在本机执行 npm run diagnose:feishu-chain 逐项判定链路，确认调用方是否为本机 Hermes 适配器。',
  no_task_by_design: '无需动作；若飞书会话内没有任何回复，执行 npm run diagnose:feishu-chain 判定 Hermes 模型侧是否异常。',
});

// HTTP 入口侧的落盘入口：**永不抛异常**，注入的账本抛错也不影响响应（需求 3.1 / 3.2 / 3.3）。
export async function recordCommanderChainEvidence(
  target: Readonly<{ ledger?: FeishuCommanderChainEvidenceLedger | null; dataDir?: string | null }>,
  payload: unknown,
  extra: Readonly<{ kind: CommanderChainEvidenceKind | string; httpStatus?: number; reason?: unknown }>,
): Promise<CommanderChainEvidenceRecord | null> {
  try {
    const dataDir = String(target?.dataDir || '').trim();
    const ledger = target?.ledger
      ?? (dataDir ? createFeishuCommanderChainEvidenceLedger({ dataDir }) : null);
    if (!ledger) return null;
    const body = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    return await ledger.record({
      sourceEventRef:body.sourceEventRef,
      chatRef:body.chatRef,
      requesterRef:body.requesterRef,
      profileAgentId:body.targetAgentId,
      nextStep:DEFAULT_NEXT_STEPS[String(extra?.kind || '')] ?? null,
      ...extra,
    });
  } catch {
    return null;
  }
}

// 读取任意目录下的运行时侧账本（诊断 CLI 复用；找不到时返回空数组）。
export async function readCommanderChainEvidenceFiles(
  directory: string,
  { filePrefix = RUNTIME_EVIDENCE_FILE_PREFIX, limit = DEFAULT_READ_LIMIT } = {},
): Promise<readonly CommanderChainEvidenceRecord[]> {
  const records: CommanderChainEvidenceRecord[] = [];
  let entries: string[];
  try {
    entries = (await fs.readdir(directory)).sort();
  } catch {
    return Object.freeze([]);
  }
  for (const entry of entries) {
    if (!entry.startsWith(filePrefix) || !entry.endsWith('.jsonl')) continue;
    records.push(...await readEvidenceFile(path.join(directory, entry)));
  }
  return Object.freeze(records.slice(-limit));
}

function buildEvidenceRecord(input: CommanderChainEvidenceInput, at: Date): CommanderChainEvidenceRecord {
  const kind = normalizeText(input?.kind) || 'unknown';
  return Object.freeze({
    schemaVersion: FEISHU_COMMANDER_CHAIN_EVIDENCE_SCHEMA,
    recordedAt: at.toISOString(),
    side: 'ajun-runtime' as const,
    kind,
    // 消息 ID 不是凭据，且需求 2.4 明确要求以它对齐某条飞书消息。
    sourceEventRef: normalizeText(input?.sourceEventRef).slice(0, MAX_TEXT_LENGTH) || null,
    chatRefDigest: digestRef(input?.chatRef),
    requesterRefDigest: digestRef(input?.requesterRef),
    profileAgentId: normalizeText(input?.profileAgentId).slice(0, 64) || null,
    httpStatus: Number.isInteger(input?.httpStatus) ? Number(input?.httpStatus) : null,
    reason: normalizeText(input?.reason).slice(0, MAX_TEXT_LENGTH) || null,
    outcome: normalizeText(input?.outcome).slice(0, MAX_TEXT_LENGTH)
      || DEFAULT_OUTCOMES[kind]
      || '本机记录了一次链路事实，未启动任何外部动作。',
    truthLayer: isTruthLayer(input?.truthLayer) ? input.truthLayer : 'reachable',
    externalActionStarted: false as const,
    nextStep: normalizeText(input?.nextStep).slice(0, MAX_TEXT_LENGTH) || null,
  });
}

async function appendEvidenceLine(
  dataDir: string, fileName: string, record: CommanderChainEvidenceRecord,
): Promise<void> {
  // dataDir 可能尚未创建；先建根目录，越界与符号链接由 prepareWorkspaceFile 守卫。
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const { parent, target } = await prepareWorkspaceFile(dataDir, `${EVIDENCE_DIRECTORY_NAME}/${fileName}`);
  await fs.chmod(parent, 0o700).catch(() => {});
  await fs.appendFile(target, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(target, 0o600).catch(() => {});
}

async function pruneExpiredEvidence(dataDir: string, at: Date, retentionDays: number): Promise<void> {
  const directory = path.join(dataDir, EVIDENCE_DIRECTORY_NAME);
  const oldestKept = new Date(at.getTime() - retentionDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  let entries: string[];
  try {
    entries = await fs.readdir(directory);
  } catch {
    return;
  }
  await Promise.all(entries.map(async (entry) => {
    const day = evidenceFileDay(entry);
    if (!day || day >= oldestKept) return;
    await fs.rm(path.join(directory, entry), { force: true }).catch(() => {});
  }));
}

function evidenceFileDay(fileName: string): string | null {
  const match = fileName.match(/^runtime-evidence-(\d{4}-\d{2}-\d{2})\.jsonl$/);
  return match?.[1] ?? null;
}

async function readEvidenceWindow(
  dataDir: string, at: Date, days: number,
): Promise<CommanderChainEvidenceRecord[]> {
  const directory = path.join(dataDir, EVIDENCE_DIRECTORY_NAME);
  const wanted = Array.from({ length: days }, (_unused, offset) => evidenceFileNameForDate(
    new Date(at.getTime() - offset * 24 * 60 * 60 * 1000),
  )).reverse();
  const records: CommanderChainEvidenceRecord[] = [];
  for (const fileName of wanted) {
    records.push(...await readEvidenceFile(path.join(directory, fileName)));
  }
  return records;
}

async function readEvidenceFile(filePath: string): Promise<CommanderChainEvidenceRecord[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch {
    return [];
  }
  const records: CommanderChainEvidenceRecord[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') records.push(Object.freeze(parsed));
    } catch {
      // 单行损坏不影响其余记录（只读诊断不得失败关闭）。
    }
  }
  return records;
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isTruthLayer(value: unknown): value is TruthLayer {
  return value === 'declared' || value === 'configured' || value === 'reachable';
}

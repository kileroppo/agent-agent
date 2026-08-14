import crypto from 'node:crypto';
import net from 'node:net';

export const STAGES = [
  ['queued', '等待处理'],
  ['preparing', '检查素材'],
  ['acquiring', '获取字幕或音频'],
  ['transcribing', '转录'],
  ['analyzing_visual', '提取关键帧'],
  ['distilling', '整理文稿'],
  ['awaiting_review', '等待人工完整听审'],
  ['delivering', '生成交付物'],
  ['awaiting_delivery', '等待飞书交付'],
  ['completed', '已完成']
] as const;

export const ACTIVE_STATUSES = new Set<string>([
  ...STAGES.map(([status]) => status)
    .filter((status) => !['awaiting_review', 'awaiting_delivery', 'completed'].includes(status)),
  'pausing',
]);

export type XiaodJob = Readonly<Record<string, unknown> & {
  id: string;
  sourceType: string;
  status: string;
  progress: number;
  createdAt: string;
  updatedAt: string;
  log: Array<Record<string, unknown>>;
}>;

type MakeJobInput = Readonly<{
  sourceType: string;
  sourceUrl?: string | null;
  originalName?: string | null;
  sourcePath?: string | null;
  ingress?: unknown;
  agentArmyTaskId?: unknown;
  connectionId?: unknown;
  connectionBinding?: unknown;
  reviewPolicy?: string;
  visualMode?: string;
  analysisDepth?: string;
  deliveryMode?: string;
}>;

export function makeJob({
  sourceType,
  sourceUrl = null,
  originalName = null,
  sourcePath = null,
  ingress = null,
  agentArmyTaskId = null,
  connectionId = null,
  connectionBinding = null,
  reviewPolicy = 'optional',
  visualMode = 'off',
  analysisDepth = 'fast',
  deliveryMode = 'feishu',
}: MakeJobInput): XiaodJob {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    sourceType,
    sourceUrl,
    originalName,
    sourcePath,
    ingress,
    agentArmyTaskId:normalizeAgentArmyTaskId(agentArmyTaskId),
    connectionId,
    connectionBinding,
    reviewPolicy: reviewPolicy === 'required' ? 'required' : 'optional',
    visualMode: visualMode === 'auto' || visualMode === 'required' ? visualMode : 'off',
    analysisDepth: analysisDepth === 'full' ? 'full' : 'fast',
    deliveryMode: deliveryMode === 'local_only' ? 'local_only' : 'feishu',
    title: originalName?.replace(/\.[^.]+$/, '') || sourceUrl || '未命名素材',
    status: 'queued',
    stageMessage: '已进入队列',
    progress: 0,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    error: null,
    failure: null,
    attempts: [],
    warnings: [],
    quality: null,
    output: null,
    log: [{ at: now, stage: 'queued', message: '任务已创建' }]
  };
}

function normalizeAgentArmyTaskId(value: unknown): string | null {
  const id = String(value || '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9:._-]{7,159}$/.test(id) ? id : null;
}

export function makeIngressKey({
  platform,
  messageId,
  attachmentIndex = 0,
}: Readonly<{
  platform?: unknown;
  messageId?: unknown;
  attachmentIndex?: number;
}>): string | null {
  if (!platform || !messageId) return null;
  return `${platform}:${messageId}:${attachmentIndex}`;
}

export function normalizeIdempotencyKey(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return null;
  const key = value.trim();
  return /^[a-zA-Z0-9:_-]{8,240}$/.test(key) ? key : null;
}

export function validatePublicHttpUrl(value: unknown):
  | Readonly<{ ok: true; url: string }>
  | Readonly<{ ok: false; reason: string }> {
  let parsed: URL;
  try {
    parsed = new URL(String(value || ''));
  } catch {
    return { ok: false, reason: '请输入完整的 HTTP(S) 链接。' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, reason: '只支持 HTTP(S) 链接。' };
  }
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, reason: '不接受本机或内网地址。' };
  }
  if (net.isIP(host) && isPrivateIp(host)) {
    return { ok: false, reason: '不接受私有网络地址。' };
  }
  return { ok: true, url: parsed.toString() };
}

function isPrivateIp(ip: string): boolean {
  if (ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80:')) return true;
  if (ip.includes(':')) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

export function cleanTranscript(input: string): string {
  const lines = input.replace(/\r/g, '').split('\n');
  const kept: string[] = [];
  for (let line of lines) {
    line = line.trim();
    if (!line || /^WEBVTT|^NOTE\b|^Kind:|^Language:/i.test(line)) continue;
    if (/^\d+$/.test(line) || /\d{1,2}:\d{2}(?::\d{2})?\.\d{3}\s+-->/.test(line)) continue;
    line = line.replace(/<[^>]+>/g, '').replace(/^\s*(?:\[[^\]]{1,32}\]|【[^】]{1,32}】|(?:说话人|Speaker)\s*\d*\s*[:：])\s*/i, '');
    line = line.replace(/\s+/g, ' ').trim();
    if (line && kept.at(-1) !== line) kept.push(line);
  }
  return kept.join('\n');
}

export function mechanicalDraft(title: string, transcript: string): string {
  const sentences = transcript
    .replace(/\n+/g, ' ')
    .split(/(?<=[。！？!?])\s*/)
    .map((text) => text.trim())
    .filter(Boolean);
  const paragraphs = [];
  for (let index = 0; index < sentences.length; index += 4) paragraphs.push(sentences.slice(index, index + 4).join(''));
  return `# ${title}\n\n> 此版本完成了时间轴、标签、重复行和明显格式噪音清理；未启用语义整理模型，建议在交付前校对术语与段落主题。\n\n## 整理正文\n\n${paragraphs.join('\n\n')}\n`;
}

export function composeDelivery(title: string, guide: string, transcript: string): string {
  const guideBody = guide
    .replace(/^\s*#\s+[^\n]+\n+/, '')
    .replace(/^\s*##\s+内容导览\s*\n+/m, '')
    .trim();
  const proofreadParagraphs = transcript.split('\n').filter(Boolean).reduce<string[]>((paragraphs, line, index) => {
    const bucket = Math.floor(index / 4);
    paragraphs[bucket] = `${paragraphs[bucket] || ''}${line}`;
    return paragraphs;
  }, []).join('\n\n');
  return `# ${title}\n\n## 内容导览\n\n${guideBody}\n\n---\n\n## 完整校对文本\n\n${proofreadParagraphs}\n`;
}

export function qualityCheck(
  markdown: string,
  { usedRefiner, refinerFallback = false }: Readonly<{
    usedRefiner: boolean;
    refinerFallback?: boolean;
  }>,
) {
  const issues = [];
  if (/\d{1,2}:\d{2}(?::\d{2})?/.test(markdown)) issues.push('仍检测到疑似时间戳');
  if (/(?:说话人|Speaker)\s*\d*\s*[:：]/i.test(markdown)) issues.push('仍检测到说话人标签');
  if (/其他有效观点|补充说明/.test(markdown)) issues.push('检测到不具体的标题');
  if (usedRefiner && !/^##\s+概述/m.test(markdown)) issues.push('内容导览缺少“概述”区块');
  if (usedRefiner && !/^##\s+主题详述/m.test(markdown)) issues.push('内容导览缺少“主题详述”区块');
  if (usedRefiner && !/^##\s+核心观点与洞察/m.test(markdown)) issues.push('内容导览缺少“核心观点与洞察”区块');
  if (markdown.replace(/[#>\s]/g, '').length < 120) issues.push('正文过短，可能是素材无声、字幕不完整或转录失败');
  if (!usedRefiner) issues.push(refinerFallback
    ? '语义整理未完成；本次交付待人工确认的内容导览和完整校对文本'
    : '未启用语义整理模型；本次仅完成机械清洗，需人工确认术语和主题结构');
  return { passed: issues.length === 0, usedRefiner, issues };
}

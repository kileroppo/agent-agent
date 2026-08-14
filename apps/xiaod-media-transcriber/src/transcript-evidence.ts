import crypto from 'node:crypto';
type DynamicRecord = Record<string, any>;
export type TranscriptSegment = Readonly<{
  startSeconds: number | null;
  endSeconds: number | null;
  timestamp: string | null;
  text: string;
  sequence: number;
}>;

export function sha256(value: unknown): string {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

export function parseTimedTranscript(raw: unknown, { kind = 'text' }: Readonly<{ kind?: string }> = {}): TranscriptSegment[] {
  const text = String(raw || '').replace(/\r/g, '');
  if (kind === 'subtitle' || /-->/m.test(text)) return parseSubtitle(text);
  return text.split('\n').map((line) => line.trim()).filter(Boolean).map((line, index) => ({
    startSeconds:null,
    endSeconds:null,
    timestamp:null,
    text:line,
    sequence:index + 1
  }));
}

export function timedTranscriptMarkdown(title: unknown, segments: readonly TranscriptSegment[]): string {
  const lines = (Array.isArray(segments) ? segments : []).map((segment) => {
    const timestamp = segment.timestamp || (Number.isFinite(segment.startSeconds) ? formatTimestamp(segment.startSeconds) : '时间点缺失');
    return `[${timestamp}] ${String(segment.text || '').trim()}`;
  }).filter((line) => !/\]\s*$/.test(line));
  return `# ${String(title || '未命名素材').trim()}\n\n${lines.join('\n\n')}\n`;
}

export function buildEvidenceRecords({
  sourceType,
  sourceUrl = null,
  contentPackage = null,
  rawTranscript,
  cleanTranscript,
  segments = [],
  mediaDurationSeconds = null,
  audioDurationSeconds = null,
  transcriptionQuality = null
}: Readonly<{
  sourceType?: string;
  sourceUrl?: string | null;
  contentPackage?: DynamicRecord | null;
  rawTranscript?: unknown;
  cleanTranscript?: unknown;
  segments?: readonly TranscriptSegment[];
  mediaDurationSeconds?: unknown;
  audioDurationSeconds?: unknown;
  transcriptionQuality?: DynamicRecord | null;
}> = {}) {
  const timed = segments.filter((segment): segment is TranscriptSegment & { startSeconds: number; endSeconds: number } => Number.isFinite(segment.startSeconds) && Number.isFinite(segment.endSeconds));
  const lastEnd = timed.length ? Math.max(...timed.map((segment) => segment.endSeconds)) : null;
  const mediaDuration = finite(mediaDurationSeconds);
  const audioDuration = finite(audioDurationSeconds);
  const duration = mediaDuration ?? audioDuration;
  const audioCoverageRatio = mediaDuration !== null && audioDuration !== null && mediaDuration > 0 && audioDuration > 0
    ? Math.min(audioDuration / mediaDuration, 1)
    : null;
  const tailGapSeconds = duration !== null && lastEnd !== null ? Math.max(0, duration - lastEnd) : null;
  const hardFailures: string[] = [];
  if (!String(cleanTranscript || '').trim()) hardFailures.push('transcript_empty');
  if (audioCoverageRatio !== null && audioCoverageRatio < 0.999) hardFailures.push('audio_coverage_below_99_9_percent');
  if (tailGapSeconds !== null && tailGapSeconds > 1) hardFailures.push('transcript_tail_gap_over_1_second');
  const anomalies = [...transcriptAnomalies(cleanTranscript), ...confidenceAnomalies(transcriptionQuality)];
  const sourceEvidence = {
    schemaVersion:'agent.army/source-evidence/v1',
    sourceType:sourceType || 'unknown',
    sourceRef:contentPackage?.sourceRef || safeSourceRef(sourceUrl),
    provider:contentPackage?.provider || (sourceType === 'upload' ? 'local_upload' : 'unknown'),
    packageId:contentPackage?.packageId || null,
    acquisitionPath:contentPackage?.acquisitionPath || (sourceType === 'upload' ? 'local_upload' : 'legacy'),
    adapterRef:contentPackage?.adapterRef || null,
    validation:contentPackage?.validation || { exists:true, readable:true, accessScope:sourceType === 'upload' ? 'task_input' : 'public_read' },
    sourceMetadata:sourceMetadata(contentPackage, { sourceType, sourceUrl, mediaDurationSeconds }),
    mediaDurationSeconds:finite(mediaDurationSeconds),
    audioDurationSeconds:finite(audioDurationSeconds),
    rawTranscriptChecksum:sha256(rawTranscript),
    createdAt:new Date().toISOString()
  };
  const qualityReport = {
    schemaVersion:'agent.army/transcript-quality/v1',
    transcriptChecksum:sha256(cleanTranscript),
    timedSegmentCount:timed.length,
    segmentCount:segments.length,
    timelineAvailable:timed.length > 0,
    mediaDurationSeconds:finite(mediaDurationSeconds),
    audioDurationSeconds:finite(audioDurationSeconds),
    audioCoverageRatio,
    tailGapSeconds,
    confidenceAvailable:Boolean(transcriptionQuality),
    confidence:transcriptionQuality || null,
    anomalies,
    hardFailures,
    passed:hardFailures.length === 0,
    evidenceLevel:timed.length ? 'timed_machine_transcript' : 'untimed_machine_transcript',
    createdAt:new Date().toISOString()
  };
  return { sourceEvidence, qualityReport };
}

function sourceMetadata(contentPackage: DynamicRecord | null, { sourceType, sourceUrl, mediaDurationSeconds }: Readonly<{
  sourceType?: string;
  sourceUrl?: string | null;
  mediaDurationSeconds?: unknown;
}>): Record<string, unknown> {
  const basic = contentPackage?.contentItems?.basic_content || {};
  const platform = contentPackage?.provider || (sourceType === 'upload' ? 'local_upload' : platformFromUrl(sourceUrl));
  const canonicalUrl = safeSourceRef(basic.sourceUrl) || contentPackage?.sourceRef || safeSourceRef(sourceUrl);
  const metadata: Record<string, unknown> = {
    title:cleanMetadata(basic.title, 500),
    author:cleanMetadata(basic.author, 300),
    platform:cleanMetadata(platform, 80) || 'unknown',
    durationSeconds:finite(basic.durationSeconds) ?? finite(mediaDurationSeconds),
    canonicalUrl:canonicalUrl || null
  };
  const publishedAt = cleanMetadata(basic.publishedAt || basic.publishTime, 120);
  const engagement = basic.engagement && typeof basic.engagement === 'object' && !Array.isArray(basic.engagement)
    ? Object.fromEntries(Object.entries(basic.engagement).filter(([, value]) => Number.isFinite(Number(value))).map(([key, value]) => [String(key).slice(0, 80), Number(value)]))
    : null;
  if (publishedAt) metadata.publishedAt = publishedAt;
  if (engagement && Object.keys(engagement).length) metadata.engagement = engagement;
  return metadata;
}

function cleanMetadata(value: unknown, limit: number): string | null {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, limit) : null;
}

function platformFromUrl(value: unknown): string {
  try {
    const host = new URL(String(value || '')).hostname.toLowerCase();
    if (host === 'youtu.be' || host.endsWith('.youtube.com')) return 'youtube';
    if (host === 'b23.tv' || host.endsWith('.bilibili.com')) return 'bili';
    if (host.endsWith('.douyin.com')) return 'dy';
    if (host.endsWith('.xiaohongshu.com') || host === 'xhslink.com') return 'xhs';
    return host || 'unknown';
  } catch {
    return 'unknown';
  }
}

export function automaticConfirmationDecision({ qualityReport = null, transcript }: Readonly<{ qualityReport?: DynamicRecord | null; transcript?: unknown }> = {}) {
  const hardFailures = Array.isArray(qualityReport?.hardFailures) ? qualityReport.hardFailures : [];
  const anomalies = Array.isArray(qualityReport?.anomalies) ? qualityReport.anomalies : [];
  const reasons: string[] = [];
  if (qualityReport?.passed !== true || hardFailures.length) reasons.push(...hardFailures, 'quality_gate_not_passed');
  if (anomalies.length) reasons.push(...anomalies.map((item) => `transcript_anomaly:${item}`));
  if (String(transcript || '').trim().length < 20) reasons.push('transcript_too_short');
  return {
    eligible:reasons.length === 0,
    reasons:[...new Set(reasons)],
    evidenceLevel:qualityReport?.evidenceLevel || 'unknown'
  };
}

export function confirmedTranscriptDocument({
  title,
  transcript,
  machineChecksum,
  confirmationMode = 'human',
  confirmerRef,
  confirmedAt,
  reviewerRef,
  reviewedAt,
  version = 1,
  correctionApplied = false,
  basedOnVersion = null
}: Readonly<{
  title?: unknown;
  transcript?: unknown;
  machineChecksum?: unknown;
  confirmationMode?: string;
  confirmerRef?: unknown;
  confirmedAt?: string;
  reviewerRef?: unknown;
  reviewedAt?: string;
  version?: number;
  correctionApplied?: boolean;
  basedOnVersion?: number | null;
}> = {}) {
  const body = String(transcript || '').trim();
  const checksum = sha256(body);
  const mode = confirmationMode === 'automatic' ? 'automatic' : 'human';
  const at = confirmedAt || reviewedAt || new Date().toISOString();
  const confirmer = confirmerRef || reviewerRef || (mode === 'automatic' ? 'xiaod-quality-gate' : 'local-owner');
  const completeListen = mode === 'human';
  return {
    markdown:[
      '---',
      'schemaVersion: agent.army/confirmed-transcript/v1',
      `version: ${version}`,
      `checksum: ${checksum}`,
      `machineTranscriptChecksum: ${machineChecksum}`,
      `confirmationMode: ${mode}`,
      `confirmedAt: ${at}`,
      `confirmerRef: ${safeIdentity(confirmer)}`,
      `completeListen: ${completeListen}`,
      `correctionApplied: ${Boolean(correctionApplied)}`,
      ...(typeof basedOnVersion === 'number' && Number.isSafeInteger(basedOnVersion) && basedOnVersion > 0 ? [`basedOnVersion: ${basedOnVersion}`] : []),
      '---',
      '',
      `# ${String(title || '未命名素材').trim()}｜${mode === 'human' ? '人工确认稿' : correctionApplied ? 'AI 初稿人工补正版' : '系统确认稿'}`,
      '',
      body,
      ''
    ].join('\n'),
    checksum,
    version
  };
}

function parseSubtitle(text: string): TranscriptSegment[] {
  const blocks = text.split(/\n{2,}/);
  const segments: TranscriptSegment[] = [];
  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex < 0) continue;
    const match = lines[timingIndex].match(/(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3})\s+-->\s+(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3})/);
    if (!match) continue;
    const content = lines.slice(timingIndex + 1).join(' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!content) continue;
    const startSeconds = parseTimestamp(match[1]);
    const endSeconds = parseTimestamp(match[2]);
    segments.push({
      startSeconds,
      endSeconds,
      timestamp:formatTimestamp(startSeconds),
      text:content,
      sequence:segments.length + 1
    });
  }
  return segments;
}

function parseTimestamp(value: string): number {
  const parts = String(value).replace(',', '.').split(':').map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function formatTimestamp(value: unknown): string {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function transcriptAnomalies(value: unknown): string[] {
  const text = String(value || '');
  const anomalies: string[] = [];
  if (text.includes('\uFFFD')) anomalies.push('replacement_character');
  if ((text.match(/[�□]/g) || []).length > 3) anomalies.push('suspicious_glyphs');
  if (/(.)\1{12,}/u.test(text)) anomalies.push('repeated_character_run');
  return anomalies;
}

function confidenceAnomalies(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const signals = value as Record<string, unknown>;
  const anomalies: string[] = [];
  if (typeof signals.meanWordProbability === 'number' && Number.isFinite(signals.meanWordProbability) && signals.meanWordProbability < 0.72) anomalies.push('low_mean_word_probability');
  if (typeof signals.meanAvgLogprob === 'number' && Number.isFinite(signals.meanAvgLogprob) && signals.meanAvgLogprob < -0.85) anomalies.push('low_mean_segment_logprob');
  if (typeof signals.highNoSpeechSegmentRatio === 'number' && Number.isFinite(signals.highNoSpeechSegmentRatio) && signals.highNoSpeechSegmentRatio > 0.35) anomalies.push('high_no_speech_segment_ratio');
  if (typeof signals.maxCompressionRatio === 'number' && Number.isFinite(signals.maxCompressionRatio) && signals.maxCompressionRatio > 2.4) anomalies.push('suspicious_compression_ratio');
  return anomalies;
}

function finite(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function safeSourceRef(value: unknown): string | null {
  try {
    const parsed = new URL(String(value || ''));
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return null;
  }
}

function safeIdentity(value: unknown): string {
  return String(value || 'local-owner').replace(/[\r\n]/g, '').trim().slice(0, 120) || 'local-owner';
}

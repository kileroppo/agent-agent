import crypto from 'node:crypto';

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

export function parseTimedTranscript(raw, { kind = 'text' } = {}) {
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

export function timedTranscriptMarkdown(title, segments) {
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
} = {}) {
  const timed = segments.filter((segment) => Number.isFinite(segment.startSeconds) && Number.isFinite(segment.endSeconds));
  const lastEnd = timed.length ? Math.max(...timed.map((segment) => segment.endSeconds)) : null;
  const duration = finite(mediaDurationSeconds) ?? finite(audioDurationSeconds);
  const audioCoverageRatio = finite(mediaDurationSeconds) && finite(audioDurationSeconds) && mediaDurationSeconds > 0
    ? Math.min(audioDurationSeconds / mediaDurationSeconds, 1)
    : null;
  const tailGapSeconds = duration !== null && lastEnd !== null ? Math.max(0, duration - lastEnd) : null;
  const hardFailures = [];
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

function sourceMetadata(contentPackage, { sourceType, sourceUrl, mediaDurationSeconds }) {
  const basic = contentPackage?.contentItems?.basic_content || {};
  const platform = contentPackage?.provider || (sourceType === 'upload' ? 'local_upload' : platformFromUrl(sourceUrl));
  const canonicalUrl = safeSourceRef(basic.sourceUrl) || contentPackage?.sourceRef || safeSourceRef(sourceUrl);
  const metadata = {
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

function cleanMetadata(value, limit) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, limit) : null;
}

function platformFromUrl(value) {
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

export function automaticConfirmationDecision({ qualityReport, transcript } = {}) {
  const hardFailures = Array.isArray(qualityReport?.hardFailures) ? qualityReport.hardFailures : [];
  const anomalies = Array.isArray(qualityReport?.anomalies) ? qualityReport.anomalies : [];
  const reasons = [];
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
  version = 1
} = {}) {
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
      '---',
      '',
      `# ${String(title || '未命名素材').trim()}｜${mode === 'human' ? '人工确认稿' : '系统确认稿'}`,
      '',
      body,
      ''
    ].join('\n'),
    checksum,
    version
  };
}

function parseSubtitle(text) {
  const blocks = text.split(/\n{2,}/);
  const segments = [];
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

function parseTimestamp(value) {
  const parts = String(value).replace(',', '.').split(':').map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function formatTimestamp(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function transcriptAnomalies(value) {
  const text = String(value || '');
  const anomalies = [];
  if (text.includes('\uFFFD')) anomalies.push('replacement_character');
  if ((text.match(/[�□]/g) || []).length > 3) anomalies.push('suspicious_glyphs');
  if (/(.)\1{12,}/u.test(text)) anomalies.push('repeated_character_run');
  return anomalies;
}

function confidenceAnomalies(value) {
  if (!value || typeof value !== 'object') return [];
  const anomalies = [];
  if (Number.isFinite(value.meanWordProbability) && value.meanWordProbability < 0.72) anomalies.push('low_mean_word_probability');
  if (Number.isFinite(value.meanAvgLogprob) && value.meanAvgLogprob < -0.85) anomalies.push('low_mean_segment_logprob');
  if (Number.isFinite(value.highNoSpeechSegmentRatio) && value.highNoSpeechSegmentRatio > 0.35) anomalies.push('high_no_speech_segment_ratio');
  if (Number.isFinite(value.maxCompressionRatio) && value.maxCompressionRatio > 2.4) anomalies.push('suspicious_compression_ratio');
  return anomalies;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function safeSourceRef(value) {
  try {
    const parsed = new URL(String(value || ''));
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return null;
  }
}

function safeIdentity(value) {
  return String(value || 'local-owner').replace(/[\r\n]/g, '').trim().slice(0, 120) || 'local-owner';
}

const DEFAULT_THRESHOLDS = Object.freeze({
  minLanguageProbability:0.8,
  minWordProbability:0.78,
  minSegmentLogprob:-0.65,
  maxHighNoSpeechRatio:0.2,
  maxCompressionRatio:2.2
});

type AsrJob = Readonly<{
  reviewPolicy?: string;
  analysisDepth?: string;
  visualMode?: string;
}>;
type AsrWord = Readonly<{ start?: unknown; end?: unknown; probability?: unknown; word?: unknown }>;
type AsrSegment = Readonly<{
  start?: unknown;
  end?: unknown;
  text?: unknown;
  words?: readonly AsrWord[];
  avg_logprob?: unknown;
  no_speech_prob?: unknown;
  compression_ratio?: unknown;
}>;
type AsrPayload = Readonly<{
  text?: unknown;
  segments?: readonly AsrSegment[];
  language?: unknown;
  languageProbability?: unknown;
  durationSeconds?: unknown;
  durationAfterVadSeconds?: unknown;
}>;
type AsrThresholds = typeof DEFAULT_THRESHOLDS;
type Interval = [number, number];

export function selectInitialAsrRoute({
  job = {},
  durationSeconds = null,
  fastRuntimeAvailable = false,
  progressiveFastEnabled = false,
  fastMinDurationSeconds = 60,
  fastMaxDurationSeconds = 1800
}: Readonly<{
  job?: AsrJob;
  durationSeconds?: number | null;
  fastRuntimeAvailable?: boolean;
  progressiveFastEnabled?: boolean;
  fastMinDurationSeconds?: number;
  fastMaxDurationSeconds?: number;
}> = {}) {
  if (!fastRuntimeAvailable) return { route:'quality_direct', reasons:['fast_runtime_unavailable'] };
  if (!progressiveFastEnabled) return { route:'quality_direct', reasons:['quality_provider_locally_faster'] };
  const reasons = [];
  if (job.reviewPolicy === 'required') reasons.push('human_review_requested');
  if (job.analysisDepth === 'full') reasons.push('full_analysis_requested');
  if (job.visualMode === 'required') reasons.push('formal_visual_evidence_requested');
  if (durationSeconds !== null && Number.isFinite(durationSeconds) && durationSeconds < fastMinDurationSeconds) reasons.push('quality_model_faster_for_short_audio');
  if (durationSeconds !== null && Number.isFinite(durationSeconds) && durationSeconds > fastMaxDurationSeconds) reasons.push('avoid_long_dual_pass');
  if (reasons.length) return { route:'quality_direct', reasons };
  return { route:'fast_candidate', reasons:['progressive_fast_candidate'] };
}

export function allowsFastFallback({
  job = {},
  durationSeconds = null,
  fastRuntimeAvailable = false,
  fastMaxDurationSeconds = 1800
}: Readonly<{
  job?: AsrJob;
  durationSeconds?: number | null;
  fastRuntimeAvailable?: boolean;
  fastMaxDurationSeconds?: number;
}> = {}) {
  if (!fastRuntimeAvailable) return false;
  if (job.reviewPolicy === 'required' || job.analysisDepth === 'full' || job.visualMode === 'required') return false;
  if (durationSeconds !== null && Number.isFinite(durationSeconds) && durationSeconds > fastMaxDurationSeconds) return false;
  return true;
}

export function evaluateFastTranscript(
  payload: AsrPayload = {},
  thresholds: AsrThresholds = DEFAULT_THRESHOLDS,
) {
  const text = String(payload.text || '').trim();
  const segments = Array.isArray(payload.segments) ? payload.segments : [];
  const qualitySignals = summarizeAsrQuality(segments);
  const reasons = [];
  if (text.length < 20) reasons.push('transcript_too_short');
  if (!segments.length) reasons.push('timed_segments_missing');
  if (!Number.isFinite(Number(payload.languageProbability)) || Number(payload.languageProbability) < thresholds.minLanguageProbability) {
    reasons.push('low_language_probability');
  }
  if (qualitySignals.meanWordProbability === null || qualitySignals.meanWordProbability < thresholds.minWordProbability) {
    reasons.push('low_word_probability');
  }
  if (qualitySignals.meanAvgLogprob === null || qualitySignals.meanAvgLogprob < thresholds.minSegmentLogprob) {
    reasons.push('low_segment_logprob');
  }
  if (qualitySignals.highNoSpeechSegmentRatio === null || qualitySignals.highNoSpeechSegmentRatio > thresholds.maxHighNoSpeechRatio) {
    reasons.push('high_no_speech_ratio');
  }
  if (qualitySignals.maxCompressionRatio === null || qualitySignals.maxCompressionRatio > thresholds.maxCompressionRatio) {
    reasons.push('high_compression_ratio');
  }
  if (text.includes('\uFFFD')) reasons.push('replacement_character');
  if (/(.)\1{12,}/u.test(text)) reasons.push('repeated_character_run');
  const invalidTimeline = segments.some((segment) => {
    const start = Number(segment?.start);
    const end = Number(segment?.end);
    return !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start;
  });
  if (invalidTimeline) reasons.push('invalid_timeline');
  return {
    accepted:reasons.length === 0,
    reasons:[...new Set(reasons)],
    qualitySignals,
    language:String(payload.language || '') || null,
    languageProbability:Number.isFinite(Number(payload.languageProbability)) ? Number(payload.languageProbability) : null,
    durationSeconds:finite(payload.durationSeconds),
    durationAfterVadSeconds:finite(payload.durationAfterVadSeconds)
  };
}

export function summarizeAsrQuality(segments: readonly AsrSegment[] = []) {
  const normalized = Array.isArray(segments) ? segments : [];
  const words = normalized.flatMap((segment) => Array.isArray(segment?.words) ? segment.words : []);
  const probabilities = words.map((word) => Number(word?.probability)).filter(finiteNumber);
  const avgLogprobs = normalized.map((segment) => Number(segment?.avg_logprob)).filter(finiteNumber);
  const suspiciousNoSpeech = normalized.filter((segment) => {
    const probability = Number(segment?.no_speech_prob);
    const logprob = Number(segment?.avg_logprob);
    return Number.isFinite(probability) && probability > 0.6 && Number.isFinite(logprob) && logprob < -0.85;
  });
  const noSpeechSignalCount = normalized.filter((segment) => Number.isFinite(Number(segment?.no_speech_prob))).length;
  const compression = normalized.map((segment) => Number(segment?.compression_ratio)).filter(finiteNumber);
  if (!probabilities.length && !avgLogprobs.length && !noSpeechSignalCount && !compression.length) return {
    segmentCount:normalized.length,
    wordCount:words.length,
    meanWordProbability:null,
    meanAvgLogprob:null,
    highNoSpeechSegmentRatio:null,
    maxCompressionRatio:null
  };
  return {
    segmentCount:normalized.length,
    wordCount:words.length,
    meanWordProbability:mean(probabilities),
    meanAvgLogprob:mean(avgLogprobs),
    highNoSpeechSegmentRatio:noSpeechSignalCount ? suspiciousNoSpeech.length / noSpeechSignalCount : null,
    maxCompressionRatio:compression.length ? Math.max(...compression) : null
  };
}

export function buildQualityProbeIntervals(durationSeconds: unknown, windowSeconds = 15): Interval[] {
  const duration = Number(durationSeconds);
  const window = Number(windowSeconds);
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(window) || window <= 0) return [];
  if (duration <= window) return [[0, duration]];
  const candidates: Interval[] = [
    [0, Math.min(window, duration)],
    [Math.max(0, duration / 2 - window / 2), Math.min(duration, duration / 2 + window / 2)],
    [Math.max(0, duration - window), duration]
  ];
  const merged: Interval[] = [];
  for (const [start, end] of candidates.sort((a, b) => a[0] - b[0])) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else merged.push([round(start), round(end)]);
  }
  return merged;
}

export function compareTranscriptProbe({
  fastSegments = [],
  probeText = '',
  intervals = [],
  threshold = 0.82,
}: Readonly<{
  fastSegments?: readonly AsrSegment[];
  probeText?: string;
  intervals?: readonly Interval[];
  threshold?: number;
}> = {}) {
  const normalizedSegments = Array.isArray(fastSegments) ? fastSegments : [];
  const selected = normalizedSegments.filter((segment) => {
    const start = Number(segment?.start);
    const end = Number(segment?.end);
    return Number.isFinite(start) && Number.isFinite(end)
      && intervals.some(([from, to]) => end > from && start < to);
  });
  const selectedWords = selected.flatMap((segment) => Array.isArray(segment?.words) ? segment.words : []).filter((word) => {
    const start = Number(word?.start);
    const end = Number(word?.end);
    return Number.isFinite(start) && Number.isFinite(end)
      && intervals.some(([from, to]) => end > from && start < to);
  });
  const fastText = normalizeComparisonText(selectedWords.length
    ? selectedWords.map((word) => word.word).join('')
    : selected.map((segment) => segment.text).join(''));
  const qualityText = normalizeComparisonText(probeText);
  const similarity = normalizedEditSimilarity(fastText, qualityText);
  const enoughEvidence = fastText.length >= 12 && qualityText.length >= 12;
  return {
    accepted:enoughEvidence && similarity >= threshold,
    similarity,
    threshold,
    fastSampleCharacters:fastText.length,
    qualityProbeCharacters:qualityText.length,
    intervals
  };
}

function mean(values: readonly number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function finite(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalizeComparisonText(value: unknown): string {
  return Array.from(String(value || '').toLowerCase()).filter((character) => /[\p{L}\p{N}]/u.test(character)).join('');
}

function normalizedEditSimilarity(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  let previous = Array.from({ length:b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function finiteNumber(value: number): boolean {
  return Number.isFinite(value);
}

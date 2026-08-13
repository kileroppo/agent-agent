import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import {
  allowsFastFallback,
  buildQualityProbeIntervals,
  compareTranscriptProbe,
  evaluateFastTranscript,
  selectInitialAsrRoute,
  summarizeAsrQuality
} from './asr-router.js';
import {
  asrRouteAttempt,
  attachAsrCapabilityResult,
  attachAsrFailureReceipt
} from './asr-capability-adapter.js';
import { createTaskRunEventBridge } from './task-run-event-bridge.js';

export class AdaptiveAsrRuntime {
  constructor({ settings = config, onRunEvent = null, runEventBridge = null } = {}) {
    this.settings = settings;
    this.runEvents = runEventBridge || createTaskRunEventBridge({ onRunEvent });
  }

  async transcribe(audioPath, jobDir, { job = {}, durationSeconds = null } = {}) {
    const startedAt = new Date().toISOString();
    const audioSha256 = await fileSha256OrNull(audioPath);
    const adaptive = this.settings.adaptiveAsr;
    const fastRuntime = adaptive.enabled ? await resolveFastRuntime(adaptive) : null;
    const initial = selectInitialAsrRoute({
      job,
      durationSeconds,
      fastRuntimeAvailable:Boolean(fastRuntime),
      progressiveFastEnabled:adaptive.progressiveFastEnabled,
      fastMinDurationSeconds:adaptive.fastMinDurationSeconds,
      fastMaxDurationSeconds:adaptive.fastMaxDurationSeconds
    });
    let fastEvaluation = null;
    let fastVerification = null;
    let fastFailure = null;
    let fallbackAttempted = false;
    let fallbackFailureCode = null;
    if (initial.route === 'fast_candidate' && fastRuntime) {
      try {
        const fastPayload = await this.transcribeFast(audioPath, jobDir, fastRuntime);
        fastEvaluation = evaluateFastTranscript(fastPayload);
        if (fastEvaluation.accepted) {
          const intervals = buildQualityProbeIntervals(durationSeconds, 15);
          const probeAudioPath = await createQualityProbeAudio(audioPath, jobDir, intervals);
          const qualityProbe = await this.transcribeQuality(probeAudioPath, jobDir, {
            outputName:'transcript-quality-probe',
            outputFormat:'json'
          });
          fastVerification = compareTranscriptProbe({ fastSegments:fastPayload.segments, probeText:qualityProbe.text, intervals });
          if (fastVerification.accepted) {
            await writeTranscriptArtifacts(jobDir, fastPayload);
            return this.#complete(fastPayload, adaptiveRoutingRecord({
              job,
              durationSeconds,
              initial,
              selectedProvider:'faster-whisper',
              selectedModel:adaptive.fastModelId,
              fastEvaluation,
              fastVerification,
              escalated:false
            }), { job, startedAt, input:{ audioSha256 } });
          }
        }
      } catch (error) {
        fastFailure = sanitizeRoutingFailure(error);
      }
    }

    try {
      const qualityPayload = await this.transcribeQuality(audioPath, jobDir);
      return this.#complete(qualityPayload, adaptiveRoutingRecord({
        job,
        durationSeconds,
        initial,
        selectedProvider:'mlx-whisper',
        selectedModel:this.settings.asrModel,
        fastEvaluation,
        fastVerification,
        fastFailure,
        escalated:initial.route === 'fast_candidate'
      }), { job, startedAt, input:{ audioSha256 } });
    } catch (qualityError) {
      if (initial.route === 'quality_direct' && allowsFastFallback({
        job,
        durationSeconds,
        fastRuntimeAvailable:Boolean(fastRuntime),
        fastMaxDurationSeconds:adaptive.fastMaxDurationSeconds
      })) {
        fallbackAttempted = true;
        try {
          const fallbackPayload = await this.transcribeFast(audioPath, jobDir, fastRuntime);
          const fallbackEvaluation = evaluateFastTranscript(fallbackPayload);
          if (fallbackEvaluation.accepted) {
            await writeTranscriptArtifacts(jobDir, fallbackPayload);
            return this.#complete(fallbackPayload, adaptiveRoutingRecord({
              job,
              durationSeconds,
              initial,
              selectedProvider:'faster-whisper',
              selectedModel:adaptive.fastModelId,
              fastEvaluation:fallbackEvaluation,
              fallbackFrom:'mlx-whisper',
              primaryFailureCode:failureCode(qualityError),
              requiresHumanReview:true,
              escalated:false
            }), { job, startedAt, input:{ audioSha256 } });
          }
        } catch (fallbackError) {
          fallbackFailureCode = failureCode(fallbackError);
          // Preserve the primary quality-provider failure below.
        }
      }
      const attempts = [asrRouteAttempt({
        provider:'mlx-whisper',
        outcome:'confirmed_failure',
        failureCode:failureCode(qualityError)
      })];
      if (fallbackAttempted) {
        attempts.push(asrRouteAttempt({
          provider:'faster-whisper',
          outcome:'confirmed_failure',
          failureCode:fallbackFailureCode || 'quality_failed'
        }));
      }
      const failure = attachAsrFailureReceipt(qualityError, {
        job,
        input:{ audioSha256 },
        startedAt,
        routing:{
          selectedProvider:'mlx-whisper',
          selectedModel:this.settings.asrModel,
          durationSeconds:Number.isFinite(durationSeconds) ? durationSeconds : null
        },
        routeAttempts:attempts
      });
      await this.runEvents.recordExecutionReceipt(failure.executionReceipt);
      throw failure;
    }
  }

  async #complete(payload, routing, context) {
    const result = transcriptionResult(payload, routing, context);
    await this.runEvents.recordExecutionReceipt(result.routing.executionReceipt, {
      qualityResult:result.routing.qualityResult
    });
    return result;
  }

  async transcribeFast(audioPath, jobDir, fastRuntime) {
    const outputPath = path.join(jobDir, 'transcript-fast-candidate.json');
    await run(fastRuntime.python, [
      fastRuntime.script,
      '--audio', audioPath,
      '--model', fastRuntime.model,
      '--output', outputPath,
      '--language', 'zh',
      '--compute-type', this.settings.adaptiveAsr.fastComputeType
    ]);
    const payload = JSON.parse(await fs.readFile(outputPath, 'utf8'));
    if (!Array.isArray(payload?.segments)) throw new Error('快速 ASR 未生成可核验的时间段。');
    return payload;
  }

  async transcribeQuality(audioPath, jobDir, { outputName = 'transcript', outputFormat = 'all' } = {}) {
    await run(this.settings.asrBin, [
      audioPath,
      '--model', this.settings.asrModel,
      '--output-dir', jobDir,
      '--output-name', outputName,
      '--output-format', outputFormat,
      '--word-timestamps', 'True',
      '--language', 'zh',
      '--verbose', 'False'
    ]);
    const transcriptPath = path.join(jobDir, `${outputName}.txt`);
    const vttPath = path.join(jobDir, `${outputName}.vtt`);
    const jsonPath = path.join(jobDir, `${outputName}.json`);
    let asrJson = null;
    try { asrJson = JSON.parse(await fs.readFile(jsonPath, 'utf8')); } catch { asrJson = null; }
    let text = String(asrJson?.text || '');
    try { text = await fs.readFile(transcriptPath, 'utf8'); } catch { /* JSON-only probes use payload text. */ }
    if (!text.trim()) throw new Error(`ASR 已运行但没有生成 ${outputName} 文本。`);
    let timed = null;
    try { timed = await fs.readFile(vttPath, 'utf8'); } catch { timed = jsonTranscriptToVtt(asrJson); }
    return {
      text,
      timed,
      language:asrJson?.language || null,
      segments:Array.isArray(asrJson?.segments) ? asrJson.segments : [],
      qualitySignals:summarizeAsrQuality(asrJson?.segments)
    };
  }
}

export function createSubtitleRoutingRecord(job) {
  return {
    schemaVersion:'agent.army/adaptive-asr-route/v1',
    strategy:'subtitle-first',
    selectedProvider:'source-subtitle',
    selectedModel:null,
    fallbackFrom:null,
    requiresHumanReview:false,
    escalated:false,
    reasons:['validated_source_subtitle_available'],
    taskSignals:taskSignals(job),
    durationSeconds:null,
    fastCandidate:{ attempted:false, accepted:false, evaluation:null, verification:null, failure:null },
    createdAt:new Date().toISOString()
  };
}

export function compactAsrRouting(routing) {
  return {
    strategy:routing.strategy,
    selectedProvider:routing.selectedProvider,
    selectedModel:routing.selectedModel,
    fallbackFrom:routing.fallbackFrom,
    requiresHumanReview:routing.requiresHumanReview === true,
    escalated:routing.escalated,
    reasons:routing.reasons,
    fastCandidateAttempted:routing.fastCandidate?.attempted === true,
    fastCandidateAccepted:routing.fastCandidate?.accepted === true,
    qualityProbeAgreed:routing.fastCandidate?.verification?.accepted === true
  };
}

async function resolveFastRuntime(settings) {
  try {
    await Promise.all([fs.access(settings.fastPython), fs.access(settings.fastScript)]);
    const root = path.resolve(settings.fastModelRoot);
    try {
      await fs.access(path.join(root, 'model.bin'));
      return { python:settings.fastPython, script:settings.fastScript, model:root };
    } catch {
      const entries = await fs.readdir(root, { withFileTypes:true });
      const candidates = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(root, entry.name);
        try {
          await fs.access(path.join(candidate, 'model.bin'));
          candidates.push(candidate);
        } catch {
          // Ignore incomplete snapshots. The quality model remains available.
        }
      }
      const model = candidates.sort().at(-1);
      return model ? { python:settings.fastPython, script:settings.fastScript, model } : null;
    }
  } catch {
    return null;
  }
}

async function createQualityProbeAudio(audioPath, jobDir, intervals) {
  if (!Array.isArray(intervals) || !intervals.length) throw new Error('质量抽查缺少有效时间窗口。');
  const target = path.join(jobDir, 'asr-quality-probe.wav');
  const filters = intervals.map(([start, end], index) => `[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[p${index}]`);
  filters.push(`${intervals.map((_, index) => `[p${index}]`).join('')}concat=n=${intervals.length}:v=0:a=1[out]`);
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', audioPath,
    '-filter_complex', filters.join(';'), '-map', '[out]', '-ac', '1', '-ar', '16000', target
  ]);
  await fs.chmod(target, 0o600);
  return target;
}

async function writeTranscriptArtifacts(jobDir, payload) {
  const text = String(payload?.text || '').trim();
  const json = { ...payload, text };
  await Promise.all([
    fs.writeFile(path.join(jobDir, 'transcript.txt'), `${text}\n`, { mode:0o600 }),
    fs.writeFile(path.join(jobDir, 'transcript.json'), `${JSON.stringify(json, null, 2)}\n`, { mode:0o600 }),
    fs.writeFile(path.join(jobDir, 'transcript.vtt'), jsonTranscriptToVtt(json), { mode:0o600 })
  ]);
}

function transcriptionResult(payload, routing, { job, startedAt, input = null } = {}) {
  const segments = Array.isArray(payload?.segments) ? payload.segments : [];
  const qualitySignals = payload?.qualitySignals || summarizeAsrQuality(segments);
  const hasSignals = [
    qualitySignals?.meanWordProbability,
    qualitySignals?.meanAvgLogprob,
    qualitySignals?.highNoSpeechSegmentRatio,
    qualitySignals?.maxCompressionRatio
  ].some(Number.isFinite);
  return {
    text:String(payload?.text || ''),
    timed:payload?.timed || jsonTranscriptToVtt({ segments }),
    qualitySignals:hasSignals ? qualitySignals : null,
    routing:attachAsrCapabilityResult({
      job,
      routing,
      input,
      payload:{ ...payload, qualitySignals:hasSignals ? qualitySignals : null },
      startedAt
    })
  };
}

async function fileSha256OrNull(filePath) {
  try {
    const hash = createHash('sha256');
    await new Promise((resolve, reject) => {
      const stream = createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('error', reject);
      stream.on('end', resolve);
    });
    return `sha256:${hash.digest('hex')}`;
  } catch {
    return null;
  }
}

function adaptiveRoutingRecord({
  job,
  durationSeconds,
  initial,
  selectedProvider,
  selectedModel,
  fastEvaluation = null,
  fastVerification = null,
  fastFailure = null,
  fallbackFrom = null,
  primaryFailureCode = null,
  requiresHumanReview = false,
  escalated = false
}) {
  const reasons = [...initial.reasons];
  if (fastEvaluation?.accepted) reasons.push('fast_quality_accepted');
  if (fastEvaluation && !fastEvaluation.accepted) reasons.push('fast_quality_rejected', ...fastEvaluation.reasons);
  if (fastVerification?.accepted) reasons.push('quality_probe_agreed');
  if (fastVerification && !fastVerification.accepted) reasons.push('quality_probe_disagreed');
  if (fastFailure) reasons.push('fast_runtime_failed');
  if (fallbackFrom) reasons.push('quality_provider_failed_fallback');
  return {
    schemaVersion:'agent.army/adaptive-asr-route/v1',
    strategy:'adaptive-progressive',
    selectedProvider,
    selectedModel,
    fallbackFrom,
    primaryFailureCode,
    requiresHumanReview,
    escalated,
    reasons:[...new Set(reasons)],
    taskSignals:taskSignals(job),
    durationSeconds:Number.isFinite(durationSeconds) ? durationSeconds : null,
    fastCandidate:initial.route === 'fast_candidate' || fallbackFrom ? {
      attempted:true,
      accepted:fastEvaluation?.accepted === true && (Boolean(fallbackFrom) || fastVerification?.accepted === true),
      evaluation:fastEvaluation,
      verification:fastVerification,
      failure:fastFailure
    } : {
      attempted:false,
      accepted:false,
      evaluation:null,
      verification:null,
      failure:null
    },
    createdAt:new Date().toISOString()
  };
}

function failureCode(error) {
  return String(error?.code || '').trim() || 'provider_unavailable';
}

function taskSignals(job) {
  return {
    reviewPolicy:job?.reviewPolicy || 'optional',
    analysisDepth:job?.analysisDepth || 'fast',
    visualMode:job?.visualMode || 'off'
  };
}

function sanitizeRoutingFailure(error) {
  return {
    code:'fast_runtime_failed',
    message:String(error?.message || error || 'unknown failure').replace(/\s+/g, ' ').slice(-240)
  };
}

function jsonTranscriptToVtt(payload) {
  const segments = Array.isArray(payload?.segments) ? payload.segments : [];
  const cues = segments.map((segment, index) => {
    const start = Number(segment?.start);
    const end = Number(segment?.end);
    const text = String(segment?.text || '').trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text) return null;
    return `${index + 1}\n${vttTimestamp(start)} --> ${vttTimestamp(end)}\n${text}`;
  }).filter(Boolean);
  return cues.length ? `WEBVTT\n\n${cues.join('\n\n')}\n` : '';
}

function vttTimestamp(value) {
  const milliseconds = Math.max(0, Math.round(Number(value) * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1000);
  const remainder = milliseconds % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(remainder).padStart(3, '0')}`;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio:['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', (error) => reject(new Error(`${command} 无法启动：${error.message}`)));
    child.on('close', (code) => {
      if (code === 0) return resolve(output);
      reject(new Error(`${command} 执行失败（退出码 ${code}）：${output.slice(-900)}`));
    });
  });
}

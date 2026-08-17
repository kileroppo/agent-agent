import { execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { collectRuntimeFingerprint } from './runtime-fingerprint.mjs';

const execFileAsync = promisify(execFile);
const AGENT_ARMY_HOME = path.join(os.homedir(), '.agent-army');
const DEFAULT_ACCEPTANCE_ROOT = path.join(AGENT_ARMY_HOME, 'acceptance');
const STATE_ROOT = path.join(AGENT_ARMY_HOME, 'state', 'ajun-runtime-data');
const HERMES_PROFILE_ROOT = path.join(os.homedir(), '.hermes', 'profiles');
const REPO_HERMES_PROFILE_DIRECTORY = 'integrations/hermes/profiles';
const STATE_DATABASES = Object.freeze([
  path.join(STATE_ROOT, 'runtime.sqlite'),
  path.join(STATE_ROOT, 'task-run-events.sqlite'),
  path.join(STATE_ROOT, 'boom-monitor.sqlite'),
]);
const STATE_REFERENCE_FILES = Object.freeze([
  Object.freeze({ filePath:path.join(STATE_ROOT, 'runtime.json'), hashMode:'metadata' }),
  Object.freeze({ filePath:path.join(STATE_ROOT, 'capability-grants.json'), hashMode:'metadata' }),
  Object.freeze({ filePath:path.join(STATE_ROOT, 'stepfun-model-policy.json'), hashMode:'metadata' }),
  Object.freeze({ filePath:path.join(STATE_ROOT, 'hermes-native-completion-watches.json'), hashMode:'metadata' }),
  Object.freeze({ filePath:path.join(STATE_ROOT, 'official-feishu-ajun-completion-watches.json'), hashMode:'metadata' }),
  Object.freeze({ filePath:path.join(STATE_ROOT, 'product-maturity-validation-batches.json'), hashMode:'metadata' }),
  Object.freeze({ filePath:path.join(STATE_ROOT, 'lan-share-key'), hashMode:'metadata' }),
  Object.freeze({ filePath:path.join(STATE_ROOT, 'm5-budget-ticket-ed25519.pem'), hashMode:'metadata' }),
  Object.freeze({ filePath:path.join(STATE_ROOT, 'm5-budget-ticket-ed25519.pem.pub'), hashMode:'metadata' }),
]);
const ENDPOINTS = Object.freeze([
  Object.freeze({ id:'ajun-health', service:'ajun', url:'http://127.0.0.1:4321/api/health', required:true }),
  Object.freeze({ id:'ajun-console-overview', service:'ajun', url:'http://127.0.0.1:4321/api/console-overview', required:true }),
  Object.freeze({ id:'xiaod-health', service:'xiaod', url:'http://127.0.0.1:4318/api/health', required:true }),
  Object.freeze({ id:'paperclip-health', service:'paperclip', url:'http://127.0.0.1:3100/api/health', required:true }),
  Object.freeze({ id:'publisher-health', service:'publisher', url:'http://127.0.0.1:4390/health', required:false }),
]);
const SOFT_BUDGET_CNY = 40;
const HARD_BUDGET_CNY = 50;
const REQUIRED_ENDPOINT_AVAILABILITY_THRESHOLD = 0.995;
const RSS_GROWTH_RATIO_THRESHOLD = 1.25;
const RUNTIME_RELIABILITY_SNAPSHOT_FILE = 'runtime-reliability.json';
const RUNTIME_RELIABILITY_SNAPSHOT_LOCK_STALE_MS = 5 * 60 * 1_000;
const LONG_SOAK_DURATION_SECONDS = 72 * 60 * 60;
const AJUN_IDLE_CPU_P95_PERCENT_THRESHOLD = 5;
const AJUN_CPU_METRIC_VERSION = 'agent.army/ajun-cpu-interval-percent/v2';
const AJUN_CPU_MIN_INTERVAL_SAMPLE_COUNT = 5;
const AJUN_CPU_INTERVAL_COVERAGE_THRESHOLD = 0.995;
const RELIABILITY_ENDPOINT_P95_MS = Object.freeze({
  'ajun-health':300,
  'ajun-console-overview':1_000,
});

export function createRunId(now = new Date()) {
  const timestamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `stability-${timestamp}-${crypto.randomBytes(3).toString('hex')}`;
}

export function buildPublicRunResult({
  runId,
  artifactFiles = {},
  runDirectory:_runDirectory,
  acceptanceRoot:_acceptanceRoot,
  ...payload
} = {}) {
  return Object.freeze({
    runId:runId || null,
    artifacts:Object.freeze({ ...artifactFiles }),
    ...payload,
  });
}

export function parseBooleanOption(value, {
  defaultValue = false,
  label = 'boolean option',
} = {}) {
  if (value === undefined) return defaultValue;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error(`${label} 只允许 true 或 false。`);
}

export function resolveRunDirectory(runId, acceptanceRoot = DEFAULT_ACCEPTANCE_ROOT) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(String(runId || ''))) {
    throw new Error('run-id 只允许 1–96 位字母、数字、点、下划线或连字符。');
  }
  const root = path.resolve(acceptanceRoot);
  const candidate = path.resolve(root, runId);
  if (path.dirname(candidate) !== root) throw new Error('run-id 不能离开验收证据目录。');
  return candidate;
}

export async function preparePrivateRunDirectory(runId, acceptanceRoot = DEFAULT_ACCEPTANCE_ROOT) {
  const runDirectory = resolveRunDirectory(runId, acceptanceRoot);
  await fsp.mkdir(runDirectory, { recursive:true, mode:0o700 });
  await fsp.chmod(runDirectory, 0o700);
  return runDirectory;
}

export async function probeEndpoint(endpoint, {
  fetchImpl = fetch,
  timeoutMs = 3_000,
  now = () => new Date(),
  monotonicNow = () => performance.now(),
} = {}) {
  const startedAt = now().toISOString();
  const start = monotonicNow();
  let httpStatus = null;
  let ok = false;
  let errorCode = null;
  try {
    const response = await fetchImpl(endpoint.url, { signal:AbortSignal.timeout(timeoutMs) });
    httpStatus = response.status;
    await response.arrayBuffer();
    ok = response.ok;
  } catch (error) {
    errorCode = normalizeProbeError(error);
  }
  return Object.freeze({
    endpointId:endpoint.id,
    service:endpoint.service,
    required:endpoint.required,
    startedAt,
    durationMs:roundMillis(monotonicNow() - start),
    httpStatus,
    ok,
    errorCode,
  });
}

export async function collectObservation({
  root = process.cwd(),
  fingerprintFn = collectRuntimeFingerprint,
  endpoints = ENDPOINTS,
  probe = probeEndpoint,
  processSampler = sampleProcesses,
  now = () => new Date(),
} = {}) {
  const fingerprint = await fingerprintFn({ root });
  const endpointSamples = await Promise.all(endpoints.map((endpoint) => probe(endpoint)));
  const processes = await processSampler(fingerprint.live?.services || {});
  return Object.freeze({
    schemaVersion:'agent.army/stability-observation/v1',
    observedAt:now().toISOString(),
    safety:Object.freeze({ readOnly:true, secretsRead:false, externalEffects:false }),
    identity:Object.freeze({
      sourceGitHead:fingerprint.source?.gitHead || null,
      sourceClean:fingerprint.source?.clean === true,
      sourceChangedPathCount:fingerprint.source?.changedPathCount ?? null,
      sourceRelationship:fingerprint.live?.sourceRelationship || 'unproven',
      liveGitHead:fingerprint.live?.services?.ajun?.runtime?.gitHead || null,
      liveReleaseHash:fingerprint.live?.services?.ajun?.runtime?.releaseHash || null,
      livePayloadHash:fingerprint.live?.services?.ajun?.runtime?.payloadHash || null,
    }),
    endpoints:Object.freeze(endpointSamples),
    processes:Object.freeze(processes),
  });
}

export function evaluateIdentityGate(observation, expected = {}) {
  const errors = [];
  if (expected.gitHead && observation.identity?.liveGitHead !== expected.gitHead) {
    errors.push(`live Git HEAD 漂移：期望 ${expected.gitHead}，实际 ${observation.identity?.liveGitHead || 'unknown'}`);
  }
  if (expected.releaseHash && observation.identity?.liveReleaseHash !== expected.releaseHash) {
    errors.push(`live release hash 漂移：期望 ${expected.releaseHash}，实际 ${observation.identity?.liveReleaseHash || 'unknown'}`);
  }
  return Object.freeze({ passed:errors.length === 0, errors:Object.freeze(errors) });
}

/** A heartbeat is evidence of progress only when every required probe succeeded. */
export function isHeartbeatEligibleObservation(observation) {
  if (!validReliabilityTimestamp(observation?.observedAt)) return false;
  const endpoints = Array.isArray(observation?.endpoints) ? observation.endpoints : [];
  const requiredSamples = endpoints.filter((sample) => sample?.required === true);
  return requiredSamples.every((sample) => sample.ok === true)
    && ENDPOINTS.filter((endpoint) => endpoint.required).every((expected) => endpoints.some((sample) => (
    sample?.endpointId === expected.id && sample.required === true && sample.ok === true
  )));
}

export async function runEndpointLoad({
  levels = [1, 3, 5, 10],
  requestsPerEndpoint = 20,
  endpoints = ENDPOINTS.filter((endpoint) => endpoint.required),
  probe = probeEndpoint,
} = {}) {
  const results = [];
  for (const concurrency of levels) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 100) {
      throw new Error('并发级别必须是 1–100 的整数。');
    }
    const jobs = [];
    for (const endpoint of endpoints) {
      for (let index = 0; index < requestsPerEndpoint; index += 1) jobs.push(() => probe(endpoint));
    }
    const samples = await runPool(jobs, concurrency);
    results.push(Object.freeze({
      concurrency,
      requestCount:samples.length,
      endpoints:summarizeEndpointSamples(samples),
    }));
  }
  return Object.freeze({
    schemaVersion:'agent.army/stability-load/v1',
    generatedAt:new Date().toISOString(),
    scope:'read_only_loopback_http',
    externalEffects:false,
    results:Object.freeze(results),
  });
}

export function summarizeEndpointSamples(samples) {
  const byEndpoint = new Map();
  for (const sample of samples) {
    if (!byEndpoint.has(sample.endpointId)) byEndpoint.set(sample.endpointId, []);
    byEndpoint.get(sample.endpointId).push(sample);
  }
  return Object.freeze(Object.fromEntries([...byEndpoint].map(([endpointId, values]) => {
    const durations = values.map((value) => value.durationMs).filter(Number.isFinite).sort((a, b) => a - b);
    const successCount = values.filter((value) => value.ok).length;
    return [endpointId, Object.freeze({
      sampleCount:values.length,
      successCount,
      successRate:values.length ? roundRatio(successCount / values.length) : null,
      p50Ms:percentile(durations, 0.5),
      p95Ms:percentile(durations, 0.95),
      maxMs:durations.at(-1) ?? null,
    })];
  })));
}

export function evaluateBudget(totalCny, additionCny = 0) {
  const total = money(totalCny + additionCny);
  if (total >= HARD_BUDGET_CNY) return Object.freeze({ totalCny:total, gate:'hard_stop', allowNewProviderCall:false });
  if (total >= SOFT_BUDGET_CNY) return Object.freeze({ totalCny:total, gate:'soft_stop', allowNewProviderCall:false });
  return Object.freeze({ totalCny:total, gate:'open', allowNewProviderCall:true });
}

export function hashEvidenceReference(value) {
  const text = String(value || '').trim();
  return text ? crypto.createHash('sha256').update(text).digest('hex') : null;
}

export async function summarizeObservationFile(filePath) {
  const text = await fsp.readFile(filePath, 'utf8');
  const observations = text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  return summarizeObservations(observations);
}

export function summarizeObservations(observations = []) {
  const endpointSamples = observations.flatMap((observation) => observation.endpoints || []);
  const requiredSamples = endpointSamples.filter((sample) => sample.required);
  const requiredSuccess = requiredSamples.filter((sample) => sample.ok).length;
  const ajunProcesses = observations.map((observation) => observation.processes?.ajun).filter(Boolean);
  const rssValues = ajunProcesses.map((sample) => sample.rssBytes).filter(Number.isFinite);
  const openFdValues = ajunProcesses.map((sample) => sample.openFileDescriptorCount).filter(Number.isFinite);
  const cpuDiagnosticValues = ajunProcesses
    .map((sample) => sample.cpuPercent)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const cpuIntervals = summarizeCpuTimeIntervals(observations);
  const requiredEndpointSuccessRate = requiredSamples.length ? roundRatio(requiredSuccess / requiredSamples.length) : null;
  const rssTrend = summarizeResourceTrend(rssValues);
  const openFdTrend = summarizeResourceTrend(openFdValues);
  return Object.freeze({
    schemaVersion:'agent.army/stability-summary/v1',
    generatedAt:new Date().toISOString(),
    observationCount:observations.length,
    firstObservedAt:observations.at(0)?.observedAt || null,
    lastObservedAt:observations.at(-1)?.observedAt || null,
    requiredEndpointSuccessRate,
    requiredEndpointAvailabilityGate:Object.freeze({
      threshold:REQUIRED_ENDPOINT_AVAILABILITY_THRESHOLD,
      status:requiredEndpointSuccessRate === null
        ? 'unknown'
        : requiredEndpointSuccessRate >= REQUIRED_ENDPOINT_AVAILABILITY_THRESHOLD ? 'passed' : 'failed',
    }),
    externalEffectsGate:summarizeExternalEffectsGate(observations),
    endpoints:summarizeEndpointSamples(endpointSamples),
    ajun:Object.freeze({
      cpuMetricVersion:AJUN_CPU_METRIC_VERSION,
      cpuExpectedAdjacentIntervalCount:cpuIntervals.expectedAdjacentIntervalCount,
      cpuValidIntervalCount:cpuIntervals.validIntervalCount,
      cpuIntervalCoverageRatio:cpuIntervals.coverageRatio,
      cpuIntervalSampleCount:cpuIntervals.sampleCount,
      cpuP95Percent:cpuIntervals.p95Percent,
      cpuGate:Object.freeze(evaluateCpuGate(cpuIntervals)),
      cpuPercentDiagnosticP95:percentile(cpuDiagnosticValues, 0.95),
      initialRssBytes:rssTrend.initialValue,
      finalRssBytes:rssTrend.finalValue,
      maxRssBytes:rssTrend.maxValue,
      finalToInitialRssRatio:rssTrend.finalToInitialRatio,
      monotonicallyGrowingRss:rssTrend.monotonicallyGrowing,
      rssGate:Object.freeze(evaluateRssGate(rssTrend)),
      initialOpenFileDescriptorCount:openFdTrend.initialValue,
      finalOpenFileDescriptorCount:openFdTrend.finalValue,
      maxOpenFileDescriptorCount:openFdTrend.maxValue,
      finalToInitialOpenFileDescriptorRatio:openFdTrend.finalToInitialRatio,
      monotonicallyGrowingOpenFileDescriptorCount:openFdTrend.monotonicallyGrowing,
    }),
  });
}

/**
 * Derive single-core-equivalent CPU percentages from cumulative process CPU time.
 * Only adjacent v2 samples for the same PID are comparable. Legacy samples, PID
 * transitions, invalid wall-clock deltas and counter regressions are boundaries,
 * never values that may be blended into the percentile.
 */
export function summarizeCpuTimeIntervals(observations = []) {
  const intervalCpuPercents = [];
  for (let index = 1; index < observations.length; index += 1) {
    const previousObservation = observations[index - 1];
    const currentObservation = observations[index];
    const previous = previousObservation?.processes?.ajun;
    const current = currentObservation?.processes?.ajun;
    if (
      previous?.cpuTimeMetricVersion !== AJUN_CPU_METRIC_VERSION
      || current?.cpuTimeMetricVersion !== AJUN_CPU_METRIC_VERSION
    ) continue;
    const previousPid = Number(previous.pid);
    const currentPid = Number(current.pid);
    if (!Number.isSafeInteger(previousPid) || previousPid <= 0 || currentPid !== previousPid) continue;
    const previousCpuSeconds = previous.cpuTimeSeconds;
    const currentCpuSeconds = current.cpuTimeSeconds;
    if (!Number.isFinite(previousCpuSeconds) || !Number.isFinite(currentCpuSeconds)) continue;
    const cpuDeltaSeconds = currentCpuSeconds - previousCpuSeconds;
    if (cpuDeltaSeconds < 0) continue;
    const previousObservedMs = Date.parse(previousObservation?.observedAt || '');
    const currentObservedMs = Date.parse(currentObservation?.observedAt || '');
    const wallDeltaSeconds = (currentObservedMs - previousObservedMs) / 1_000;
    if (!Number.isFinite(wallDeltaSeconds) || wallDeltaSeconds <= 0) continue;
    const intervalCpuPercent = (cpuDeltaSeconds / wallDeltaSeconds) * 100;
    if (Number.isFinite(intervalCpuPercent) && intervalCpuPercent >= 0) {
      intervalCpuPercents.push(intervalCpuPercent);
    }
  }
  intervalCpuPercents.sort((left, right) => left - right);
  const expectedAdjacentIntervalCount = Math.max(0, observations.length - 1);
  const validIntervalCount = intervalCpuPercents.length;
  return Object.freeze({
    metricVersion:AJUN_CPU_METRIC_VERSION,
    expectedAdjacentIntervalCount,
    validIntervalCount,
    coverageRatio:expectedAdjacentIntervalCount > 0
      ? roundRatio(validIntervalCount / expectedAdjacentIntervalCount)
      : null,
    sampleCount:validIntervalCount,
    p95Percent:percentile(intervalCpuPercents, 0.95),
    intervalCpuPercents:Object.freeze(intervalCpuPercents.map(roundMillis)),
  });
}

export async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function readObservationRecords(filePath) {
  try {
    const text = await fsp.readFile(filePath, 'utf8');
    return Object.freeze(text.split(/\r?\n/).filter(Boolean).map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`observations.jsonl 第 ${index + 1} 行不是有效 JSON：${error.message}`);
      }
    }));
  } catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze([]);
    throw error;
  }
}

async function readExistingStopRequested(filePath) {
  let text;
  try {
    text = await fsp.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!text.trim()) return null;
  let summary;
  try {
    summary = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return null;
  return typeof summary.stopRequested === 'boolean' ? summary.stopRequested : null;
}

function summarizeExternalEffectsGate(observations) {
  let falseCount = 0;
  let trueCount = 0;
  let unknownCount = 0;
  for (const observation of observations) {
    const value = observation?.safety?.externalEffects;
    if (value === false) falseCount += 1;
    else if (value === true) trueCount += 1;
    else unknownCount += 1;
  }
  const status = trueCount > 0
    ? 'degraded'
    : observations.length > 0 && unknownCount === 0 ? 'passed' : 'unknown';
  return Object.freeze({
    status,
    observationCount:observations.length,
    externalEffectsFalseCount:falseCount,
    externalEffectsTrueCount:trueCount,
    unknownCount,
  });
}

async function summarizeCostLedger(filePath) {
  let text;
  try {
    text = await fsp.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return unknownCostGate('ledger_missing');
    throw error;
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length === 0) return unknownCostGate('ledger_empty');
  let totalCny = 0;
  let invalidRecordCount = 0;
  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      const amountCny = record?.amountCny;
      const nextGate = Number.isFinite(amountCny) && amountCny >= 0
        ? evaluateBudget(totalCny, amountCny)
        : null;
      const valid = record?.schemaVersion === 'agent.army/stability-cost/v1'
        && Number.isFinite(Date.parse(record?.recordedAt || ''))
        && Number.isFinite(amountCny)
        && amountCny >= 0
        && ['manual', 'paperclip', 'gateway', 'provider'].includes(record?.source)
        && (record?.referenceSha256 === null || /^[0-9a-f]{64}$/.test(record?.referenceSha256 || ''))
        && record?.totalCny === nextGate?.totalCny
        && record?.gate === nextGate?.gate;
      if (!valid) {
        invalidRecordCount += 1;
        continue;
      }
      totalCny = nextGate.totalCny;
    } catch {
      invalidRecordCount += 1;
    }
  }
  if (invalidRecordCount > 0) {
    return unknownCostGate('invalid_record', {
      recordCount:lines.length,
      validRecordCount:lines.length - invalidRecordCount,
      invalidRecordCount,
    });
  }
  const budget = evaluateBudget(totalCny);
  const level = budget.gate === 'hard_stop' ? 'hard'
    : budget.gate === 'soft_stop' ? 'soft' : 'open';
  return Object.freeze({
    currency:'CNY',
    totalCny:budget.totalCny,
    level,
    status:level === 'open' ? 'passed' : 'degraded',
    reason:level === 'open' ? 'within_budget' : `${level}_stop`,
    softStopCny:SOFT_BUDGET_CNY,
    hardStopCny:HARD_BUDGET_CNY,
    recordCount:lines.length,
    validRecordCount:lines.length,
    invalidRecordCount:0,
  });
}

function unknownCostGate(reason, {
  recordCount = 0,
  validRecordCount = 0,
  invalidRecordCount = 0,
} = {}) {
  return Object.freeze({
    currency:'CNY',
    totalCny:null,
    level:null,
    status:'unknown',
    reason,
    softStopCny:SOFT_BUDGET_CNY,
    hardStopCny:HARD_BUDGET_CNY,
    recordCount,
    validRecordCount,
    invalidRecordCount,
  });
}

function normalizeObservationTimes(observations) {
  const seen = new Set();
  const values = [];
  for (const observation of observations) {
    const observedMs = Date.parse(observation?.observedAt || '');
    if (!Number.isFinite(observedMs) || seen.has(observedMs)) continue;
    seen.add(observedMs);
    values.push(observedMs);
  }
  values.sort((left, right) => left - right);
  return values;
}

export function calculateObservedDurationMs(observations, {
  startedAt = null,
  intervalSeconds,
} = {}) {
  return initialObservationDurationState(observations, { startedAt, intervalSeconds }).effectiveObservedMs;
}

export function calculateObservationDurationProgress(observations, {
  startedAt = null,
  intervalSeconds,
  durationSeconds,
} = {}) {
  const targetDurationSeconds = positiveInteger(durationSeconds, 72 * 60 * 60, 'duration-seconds');
  const effectiveObservedMs = calculateObservedDurationMs(observations, { startedAt, intervalSeconds });
  return durationProgress(effectiveObservedMs, targetDurationSeconds);
}

/**
 * Seed once from a resumed JSONL, then advance only from the new observation.
 * Live observations are append-only; an out-of-order clock value is ignored so it
 * can never manufacture elapsed time. The final summary still reads the full log.
 */
export function createObservationDurationAccumulator(observations, {
  startedAt = null,
  intervalSeconds,
  durationSeconds,
} = {}) {
  const targetDurationSeconds = positiveInteger(durationSeconds, 72 * 60 * 60, 'duration-seconds');
  const state = initialObservationDurationState(observations, { startedAt, intervalSeconds });
  return Object.freeze({
    progress:() => durationProgress(state.effectiveObservedMs, targetDurationSeconds),
    append(observation) {
      const observedMs = Date.parse(observation?.observedAt || '');
      if (!Number.isFinite(observedMs) || (state.cursorMs !== null && observedMs <= state.cursorMs)) {
        return durationProgress(state.effectiveObservedMs, targetDurationSeconds);
      }
      if (state.cursorMs === null) {
        state.cursorMs = observedMs;
      } else {
        state.effectiveObservedMs += Math.min(observedMs - state.cursorMs, state.intervalMs);
        state.cursorMs = observedMs;
      }
      return durationProgress(state.effectiveObservedMs, targetDurationSeconds);
    },
  });
}

function initialObservationDurationState(observations, { startedAt = null, intervalSeconds } = {}) {
  const intervalMs = positiveInteger(intervalSeconds, 30, 'interval-seconds') * 1_000;
  const startMs = Date.parse(startedAt || '');
  const state = {
    intervalMs,
    cursorMs:Number.isFinite(startMs) ? startMs : null,
    effectiveObservedMs:0,
  };
  for (const observedMs of normalizeObservationTimes(observations)) {
    if (state.cursorMs === null) {
      state.cursorMs = observedMs;
      continue;
    }
    const deltaMs = observedMs - state.cursorMs;
    if (deltaMs > 0) state.effectiveObservedMs += Math.min(deltaMs, intervalMs);
    state.cursorMs = observedMs;
  }
  return state;
}

function durationProgress(effectiveObservedMs, targetDurationSeconds) {
  const targetDurationMs = targetDurationSeconds * 1_000;
  return Object.freeze({
    effectiveObservedMs,
    remainingDurationMs:Math.max(0, targetDurationMs - effectiveObservedMs),
    complete:effectiveObservedMs >= targetDurationMs,
  });
}

export async function acquireObserveLock(runDirectory) {
  const lockPath = path.join(runDirectory, 'observe.lock');
  let handle;
  try {
    handle = await fsp.open(lockPath, 'wx', 0o600);
    await fsp.chmod(lockPath, 0o600);
    return Object.freeze({
      lockPath,
      async release() {
        await handle.close();
        await fsp.unlink(lockPath).catch((error) => {
          if (error?.code !== 'ENOENT') throw error;
        });
      },
    });
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (error?.code === 'EEXIST') {
      throw new Error('已有同 run observe 正在执行；请等待当前观察结束后再重试。');
    }
    throw error;
  }
}

export async function prepareObserveRunState({
  runId,
  runDirectory,
  durationSeconds,
  intervalSeconds,
  expected,
  resume = false,
  now = () => new Date(),
} = {}) {
  const manifestPath = path.join(runDirectory, 'soak-manifest.json');
  const observationPath = path.join(runDirectory, 'observations.jsonl');
  const existingManifest = await readJsonIfExists(manifestPath);
  const observations = await readObservationRecords(observationPath);
  const observationCount = observations.length;
  if (observationCount > 0 && !resume) {
    throw new Error('已有 observations.jsonl；默认拒绝覆盖或混跑。确认继续请显式传 --resume true。');
  }
  if (resume && observationCount > 0 && !existingManifest) {
    throw new Error('已有 observations.jsonl 但缺少 soak-manifest.json，无法安全 resume。');
  }
  const manifestExpected = existingManifest?.expected || null;
  if (existingManifest && (
    (manifestExpected?.gitHead || null) !== (expected?.gitHead || null)
    || (manifestExpected?.releaseHash || null) !== (expected?.releaseHash || null)
  )) {
    throw new Error('resume 的身份期望值必须与既有 soak-manifest.json 一致。');
  }
  if (
    resume
    && observationCount > 0
    && existingManifest?.cpuMetric?.version !== AJUN_CPU_METRIC_VERSION
  ) {
    throw new Error('旧 run 不具备 CPU metric v2 契约，不能与 v2 样本混跑；请创建新 run。');
  }
  const startedAt = existingManifest?.startedAt || now().toISOString();
  const normalizedDurationSeconds = existingManifest?.durationSeconds ?? durationSeconds;
  const normalizedIntervalSeconds = existingManifest?.intervalSeconds ?? intervalSeconds;
  const resumeCount = existingManifest
    ? (existingManifest.resumeCount ?? 0) + (resume ? 1 : 0)
    : 0;
  const durationProgress = calculateObservationDurationProgress(observations, {
    startedAt,
    intervalSeconds:normalizedIntervalSeconds,
    durationSeconds:normalizedDurationSeconds,
  });
  const { effectiveObservedMs, remainingDurationMs } = durationProgress;
  const manifest = Object.freeze({
    schemaVersion:'agent.army/stability-run/v1',
    runId,
    phase:'soak',
    startedAt,
    durationSeconds:normalizedDurationSeconds,
    intervalSeconds:normalizedIntervalSeconds,
    resourceSamplingCadenceNote:'当前 30 秒采样比 1 分钟更密；CPU P95 使用相邻同 PID 累计 CPU 时间差计算。',
    cpuMetric:Object.freeze({
      version:AJUN_CPU_METRIC_VERSION,
      source:'macos_ps_time',
      aggregation:'adjacent_same_pid_cpu_time_delta_over_observed_time_delta_percent',
      percentile:'nearest_rank_p95',
      minimumIntervalSampleCount:AJUN_CPU_MIN_INTERVAL_SAMPLE_COUNT,
      minimumIntervalCoverageRatio:AJUN_CPU_INTERVAL_COVERAGE_THRESHOLD,
    }),
    manualResearchProbeMilestones:[24, 48, 72],
    requiresExternalConfirmation:true,
    expected:existingManifest?.expected || expected,
    resumeCount,
    lastResumedAt:resume ? now().toISOString() : existingManifest?.lastResumedAt || null,
    safety:Object.freeze({ readOnly:true, secretsRead:false, externalEffects:false, servicesMutated:false }),
  });
  return Object.freeze({
    manifestPath,
    observationPath,
    existingManifest,
    manifest,
    observations,
    observationCount,
    effectiveObservedMs,
    remainingDurationMs,
  });
}

export async function summarizeRunDirectory(runDirectory) {
  const manifest = await readJsonIfExists(path.join(runDirectory, 'soak-manifest.json'));
  const stopRequested = await readExistingStopRequested(path.join(runDirectory, 'summary.json'));
  const observationPath = path.join(runDirectory, 'observations.jsonl');
  const observations = await readObservationRecords(observationPath);
  // Finalization is the one deliberate full-log pass. The observe loop itself
  // only uses an in-memory incremental duration accumulator.
  const summary = summarizeObservations(observations);
  const costGate = await summarizeCostLedger(path.join(runDirectory, 'cost-ledger.jsonl'));
  const durationProgress = manifest
    ? calculateObservationDurationProgress(observations, {
      startedAt:manifest.startedAt,
      intervalSeconds:manifest.intervalSeconds,
      durationSeconds:manifest.durationSeconds,
    })
    : null;
  return Object.freeze({
    ...summary,
    stopRequested,
    costGate,
    identityGate:summarizeIdentityGates(observations),
    run:manifest ? Object.freeze({
      runId:manifest.runId || null,
      startedAt:manifest.startedAt || null,
      durationSeconds:manifest.durationSeconds ?? null,
      intervalSeconds:manifest.intervalSeconds ?? null,
      resourceSamplingCadenceNote:manifest.resourceSamplingCadenceNote || null,
      cpuMetric:manifest.cpuMetric?.version === AJUN_CPU_METRIC_VERSION
        ? Object.freeze({ ...manifest.cpuMetric })
        : null,
      manualResearchProbeMilestones:Array.isArray(manifest.manualResearchProbeMilestones)
        ? Object.freeze([...manifest.manualResearchProbeMilestones])
        : null,
      requiresExternalConfirmation:manifest.requiresExternalConfirmation === true,
      resumeCount:manifest.resumeCount ?? 0,
      expected:manifest.expected || null,
      effectiveObservedSeconds:durationProgress === null
        ? null
        : roundMillis(durationProgress.effectiveObservedMs / 1_000),
      remainingDurationSeconds:durationProgress === null || manifest.durationSeconds === undefined
        ? null
        : roundMillis(durationProgress.remainingDurationMs / 1_000),
    }) : null,
  });
}

/** Turn a complete soak summary into the only conclusion the runtime may display. */
export function buildRuntimeReliabilitySnapshot(summary = {}) {
  const endpointP95 = Object.fromEntries(Object.entries(RELIABILITY_ENDPOINT_P95_MS).map(([endpointId, thresholdMs]) => {
    const p95Ms = summary?.endpoints?.[endpointId]?.p95Ms;
    return [endpointId, p95Ms === null || p95Ms === undefined
      ? 'unknown'
      : Number(p95Ms) <= thresholdMs ? 'passed' : 'failed'];
  }));
  const completion = summary?.run?.remainingDurationSeconds === 0 ? 'passed' : 'unknown';
  const identity = summary?.identityGate?.status === 'passed' ? 'passed'
    : summary?.identityGate?.status === 'failed' ? 'failed' : 'unknown';
  const availability = summary?.requiredEndpointAvailabilityGate?.status === 'passed' ? 'passed'
    : summary?.requiredEndpointAvailabilityGate?.status === 'failed' ? 'failed' : 'unknown';
  const rss = summary?.ajun?.rssGate?.status === 'passed' ? 'passed'
    : summary?.ajun?.rssGate?.status === 'failed' ? 'failed' : 'unknown';
  const durationSeconds = Number(summary?.run?.durationSeconds);
  const isLongSoak = Number.isFinite(durationSeconds) && durationSeconds >= LONG_SOAK_DURATION_SECONDS;
  const longSoakCost = summary?.costGate?.status === 'passed' ? 'passed'
    : summary?.costGate?.status === 'degraded' ? 'failed' : 'unknown';
  const longSoakNaturalCompletion = summary?.stopRequested === false ? 'passed'
    : 'unknown';
  const longSoakExternalEffects = summary?.externalEffectsGate?.status === 'passed' ? 'passed'
    : summary?.externalEffectsGate?.status === 'degraded' ? 'failed' : 'unknown';
  const cpuP95Percent = summary?.ajun?.cpuP95Percent;
  const cpuMetricVersion = summary?.ajun?.cpuMetricVersion;
  const runCpuMetricVersion = summary?.run?.cpuMetric?.version;
  const cpuExpectedAdjacentIntervalCount = summary?.ajun?.cpuExpectedAdjacentIntervalCount;
  const cpuValidIntervalCount = summary?.ajun?.cpuValidIntervalCount;
  const cpuCoverageRatio = Number.isSafeInteger(cpuExpectedAdjacentIntervalCount)
    && cpuExpectedAdjacentIntervalCount > 0
    && Number.isSafeInteger(cpuValidIntervalCount)
    && cpuValidIntervalCount >= 0
    && cpuValidIntervalCount <= cpuExpectedAdjacentIntervalCount
    ? cpuValidIntervalCount / cpuExpectedAdjacentIntervalCount
    : null;
  const longSoakCpuP95 = completion !== 'passed'
    || runCpuMetricVersion !== AJUN_CPU_METRIC_VERSION
    || cpuMetricVersion !== AJUN_CPU_METRIC_VERSION
    || !Number.isSafeInteger(cpuValidIntervalCount)
    || cpuValidIntervalCount < AJUN_CPU_MIN_INTERVAL_SAMPLE_COUNT
    || !Number.isFinite(cpuCoverageRatio)
    || cpuCoverageRatio < AJUN_CPU_INTERVAL_COVERAGE_THRESHOLD
    || !Number.isFinite(cpuP95Percent)
    ? 'unknown'
    : cpuP95Percent <= AJUN_IDLE_CPU_P95_PERCENT_THRESHOLD ? 'passed' : 'failed';
  const gates = {
    completion,
    identity,
    availability,
    rss,
    ...endpointP95,
    ...(isLongSoak ? {
      'ajun-cpu-p95':longSoakCpuP95,
      'cost-budget':longSoakCost,
      'natural-completion':longSoakNaturalCompletion,
      'external-effects':longSoakExternalEffects,
    } : {}),
  };
  const failed = Object.entries(gates).filter(([, status]) => status === 'failed').map(([id]) => id);
  const unknown = Object.entries(gates).filter(([, status]) => status === 'unknown').map(([id]) => id);
  const expected = summary?.run?.expected || {};
  const runtimeIdentity = {
    gitHead:normalizedGitHead(expected.gitHead),
    releaseHash:normalizedSha256(expected.releaseHash),
  };
  const identityComplete = Boolean(runtimeIdentity.gitHead && runtimeIdentity.releaseHash);
  const status = failed.length ? 'degraded' : unknown.length || !identityComplete ? 'unknown' : 'healthy';
  const observationWindow = describeObservationWindow(durationSeconds);
  const observationLabel = observationWindow
    ? `当前 git/release 的${observationWindow}稳定性观测`
    : '当前 git/release 的稳定性观测';
  const scopeQualifier = Number(summary?.run?.durationSeconds) > 0
    && Number(summary.run.durationSeconds) < LONG_SOAK_DURATION_SECONDS
    ? '长期稳定仍以更长观测为准。'
    : '';
  const passedGateDescription = isLongSoak
    ? '所有可用率、端点 P95、A君 CPU P95、RSS、费用预算、自然完成和无外部副作用门禁通过。'
    : '所有可用率、端点 P95 和 RSS 门禁通过。';
  const failedGateDescription = failed.map((id) => ({
    completion:'有效观测时长',
    identity:'运行身份',
    availability:'必需端点可用率',
    rss:'A君 RSS',
    'ajun-health':'A君健康端点 P95',
    'ajun-console-overview':'A君控制台端点 P95',
    'ajun-cpu-p95':`A君 CPU P95（阈值 ${AJUN_IDLE_CPU_P95_PERCENT_THRESHOLD}%）`,
    'cost-budget':'费用预算（达到软/硬停止线）',
    'natural-completion':'自然完成',
    'external-effects':'无外部副作用',
  })[id] || id);
  const unknownGateDescription = unknown.map((id) => ({
    completion:'有效观测时长',
    identity:'运行身份',
    availability:'必需端点可用率',
    rss:'A君 RSS',
    'ajun-health':'A君健康端点 P95',
    'ajun-console-overview':'A君控制台端点 P95',
    'ajun-cpu-p95':'A君 CPU P95',
    'cost-budget':'费用预算证据',
    'natural-completion':'自然完成标记',
    'external-effects':'外部副作用证据',
  })[id] || id);
  return Object.freeze({
    status,
    detail:status === 'healthy'
      ? [ `${observationLabel}已完成，${passedGateDescription}`, scopeQualifier ].filter(Boolean).join(' ')
      : status === 'degraded'
        ? `${observationLabel}存在失败门禁：${failedGateDescription.join('、')}。`
        : isLongSoak && unknownGateDescription.length
          ? `${observationLabel}尚不完整，缺少可判定门禁：${unknownGateDescription.join('、')}；不能显示为稳定。`
          : `${observationLabel}尚不完整，不能显示为稳定。`,
    observedAt:summary?.lastObservedAt || summary?.generatedAt || null,
    runtimeIdentity:Object.freeze(runtimeIdentity),
    gates:Object.freeze(gates),
  });
}

export async function writeRuntimeReliabilitySnapshot(snapshot, {
  dataDir = resolveRuntimeDataDir(),
} = {}) {
  const directory = path.resolve(dataDir);
  await fsp.mkdir(directory, { recursive:true, mode:0o700 });
  await fsp.chmod(directory, 0o700);
  const target = path.join(directory, RUNTIME_RELIABILITY_SNAPSHOT_FILE);
  await withRuntimeReliabilitySnapshotLock(target, async () => {
    const existing = await openRuntimeReliabilitySnapshotForUpdate(target);
    try {
      if (shouldPreserveRuntimeReliabilitySnapshot(existing.snapshot, snapshot)) {
        await existing.handle?.chmod(0o600);
        return;
      }
    } finally {
      await existing.handle?.close();
    }
    await replaceRuntimeReliabilitySnapshot(target, snapshot);
  });
  return target;
}

/**
 * A successful, identity-verified sample proves an existing same-release conclusion is still being observed.
 * It deliberately does not alter observedAt/status/detail or summarize observations again.
 */
export async function writeRuntimeReliabilityProgressHeartbeat({
  runtimeIdentity,
  progressObservedAt,
  progressIntervalSeconds,
} = {}, {
  dataDir = resolveRuntimeDataDir(),
} = {}) {
  const identity = normalizedRuntimeIdentity(runtimeIdentity);
  const observedAt = validReliabilityTimestamp(progressObservedAt);
  const intervalSeconds = validProgressIntervalSeconds(progressIntervalSeconds);
  if (!identity || !observedAt || !intervalSeconds) return null;
  const directory = path.resolve(dataDir);
  await fsp.mkdir(directory, { recursive:true, mode:0o700 });
  await fsp.chmod(directory, 0o700);
  const target = path.join(directory, RUNTIME_RELIABILITY_SNAPSHOT_FILE);
  return withRuntimeReliabilitySnapshotLock(target, async () => {
    const existing = await openRuntimeReliabilitySnapshotForUpdate(target);
    let updated = null;
    try {
      const existingIdentity = normalizedRuntimeIdentity(existing.snapshot?.runtimeIdentity);
      if (!['healthy', 'degraded'].includes(existing.snapshot?.status)
        || !existingIdentity
        || existingIdentity.gitHead !== identity.gitHead
        || existingIdentity.releaseHash !== identity.releaseHash) return null;
      updated = {
        ...existing.snapshot,
        progressObservedAt:observedAt,
        progressIntervalSeconds:intervalSeconds,
      };
    } finally {
      await existing.handle?.close();
    }
    await replaceRuntimeReliabilitySnapshot(target, updated);
    return target;
  });
}

export async function acquireRuntimeReliabilitySnapshotLock(target, {
  timeoutMs = 5_000,
  retryMs = 10,
  now = () => Date.now(),
  isProcessAlive = runtimeLockProcessAlive,
  openLock = fsp.open,
} = {}) {
  const lockPath = `${target}.lock`;
  const token = crypto.randomUUID();
  const ownerPid = process.pid;
  const createdAt = new Date(now()).toISOString();
  const deadline = now() + timeoutMs;
  while (true) {
    let handle;
    let createdStat = null;
    try {
      await waitForRuntimeReliabilitySnapshotRecovery(lockPath, { deadline, retryMs, now });
      handle = await openLock(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      // lstat gives us an inode to clean up even when the injected/underlying
      // FileHandle.stat initialization step itself fails.
      createdStat = await fsp.lstat(lockPath);
      if (!createdStat.isFile()) throw new Error('稳定性快照锁不是普通文件，拒绝写入。');
      await handle.writeFile(`${JSON.stringify({ token, ownerPid, createdAt })}\n`, 'utf8');
      await handle.sync();
      const stat = await handle.stat();
      if (!stat.isFile() || stat.dev !== createdStat.dev || stat.ino !== createdStat.ino) {
        throw new Error('稳定性快照锁在初始化期间发生变化，拒绝写入。');
      }
      // Recovery guard may have been created after the first preflight check.
      // Do not let a new writer pass through while a stale lock is quarantined.
      if (await runtimeReliabilitySnapshotRecoveryExists(lockPath)) {
        await handle.close();
        handle = null;
        await unlinkRuntimeReliabilitySnapshotLockIfSameFile(lockPath, stat);
        if (now() >= deadline) throw new Error('稳定性快照正在被其他 observe/run 更新，等待锁超时。');
        await delay(retryMs);
        continue;
      }
      return Object.freeze({
        lockPath,
        async release() {
          await handle.close();
          const owned = await readOwnedRuntimeReliabilitySnapshotLock(lockPath, token, stat);
          if (owned) await fsp.unlink(lockPath).catch((error) => {
            if (error?.code !== 'ENOENT') throw error;
          });
        },
      });
    } catch (error) {
      await handle?.close().catch(() => {});
      if (createdStat !== null) {
        // Initialization failed after this process won O_EXCL. Only remove the
        // exact inode we created; a replacement lock is never unlinked here.
        await unlinkRuntimeReliabilitySnapshotLockIfSameFile(lockPath, createdStat);
      }
      if (error?.code !== 'EEXIST') throw error;
      if (await recoverStaleRuntimeReliabilitySnapshotLock(lockPath, { now, isProcessAlive })) continue;
      await assertRuntimeReliabilitySnapshotLockIsRegular(lockPath);
      if (now() >= deadline) throw new Error('稳定性快照正在被其他 observe/run 更新，等待锁超时。');
      await delay(retryMs);
    }
  }
}

async function withRuntimeReliabilitySnapshotLock(target, action) {
  const lock = await acquireRuntimeReliabilitySnapshotLock(target);
  try {
    return await action();
  } finally {
    await lock.release();
  }
}

async function assertRuntimeReliabilitySnapshotLockIsRegular(lockPath) {
  const linkStat = await fsp.lstat(lockPath).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (linkStat === null) return;
  if (!linkStat.isFile()) throw new Error('稳定性快照锁不是普通文件，拒绝写入。');
  const handle = await fsp.open(lockPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== linkStat.dev || stat.ino !== linkStat.ino) {
      throw new Error('稳定性快照锁在安全检查期间发生变化，拒绝写入。');
    }
  } finally {
    await handle.close();
  }
}

async function recoverStaleRuntimeReliabilitySnapshotLock(lockPath, { now, isProcessAlive }) {
  const observed = await readRuntimeReliabilitySnapshotLock(lockPath);
  if (!isStaleRuntimeReliabilitySnapshotLock(observed?.record, { now, isProcessAlive })) return false;
  const recovery = await acquireRuntimeReliabilitySnapshotRecovery(lockPath, { now });
  if (!recovery) return false;
  try {
    // A second inode/token read prevents a later writer from being quarantined.
    const current = await readRuntimeReliabilitySnapshotLock(lockPath);
    if (!sameRuntimeReliabilitySnapshotLock(current, observed)
      || !isStaleRuntimeReliabilitySnapshotLock(current?.record, { now, isProcessAlive })) return false;
    const quarantinePath = `${lockPath}.stale.${current.record.token}.${crypto.randomUUID()}`;
    await fsp.rename(lockPath, quarantinePath);
    await fsp.chmod(quarantinePath, 0o600);
    return true;
  } finally {
    await recovery.release();
  }
}

function isStaleRuntimeReliabilitySnapshotLock(record, { now, isProcessAlive }) {
  if (!validRuntimeReliabilitySnapshotLockRecord(record)) return false;
  const ageMs = now() - Date.parse(record.createdAt);
  const ownerState = isProcessAlive(record.ownerPid);
  // A live PID always wins, even if its timestamp is old. If liveness cannot be
  // determined (for example EPERM), only a long-expired lock is recoverable.
  return ownerState === false || (ownerState === null && Number.isFinite(ageMs) && ageMs >= RUNTIME_RELIABILITY_SNAPSHOT_LOCK_STALE_MS);
}

function validRuntimeReliabilitySnapshotLockRecord(record) {
  return typeof record?.token === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.token)
    && Number.isSafeInteger(record?.ownerPid) && record.ownerPid > 0
    && Number.isFinite(Date.parse(record?.createdAt || ''));
}

function sameRuntimeReliabilitySnapshotLock(left, right) {
  return Boolean(
    left && right
    && left.stat.dev === right.stat.dev
    && left.stat.ino === right.stat.ino
    && left.record?.token === right.record?.token,
  );
}

function runtimeLockProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'ESRCH' ? false : null;
  }
}

async function readRuntimeReliabilitySnapshotLock(lockPath) {
  let linkStat;
  try {
    linkStat = await fsp.lstat(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!linkStat.isFile()) throw new Error('稳定性快照锁不是普通文件，拒绝写入。');
  const handle = await fsp.open(lockPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== linkStat.dev || stat.ino !== linkStat.ino) {
      throw new Error('稳定性快照锁在安全检查期间发生变化，拒绝写入。');
    }
    let record = null;
    try {
      record = JSON.parse(await handle.readFile('utf8'));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    return { stat, record };
  } finally {
    await handle.close();
  }
}

async function unlinkRuntimeReliabilitySnapshotLockIfSameFile(lockPath, expectedStat) {
  const current = await readRuntimeReliabilitySnapshotLock(lockPath).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!current || current.stat.dev !== expectedStat.dev || current.stat.ino !== expectedStat.ino) return false;
  await fsp.unlink(lockPath).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
  return true;
}

async function acquireRuntimeReliabilitySnapshotRecovery(lockPath, { now }) {
  const recoveryPath = `${lockPath}.recovery`;
  const token = crypto.randomUUID();
  let handle;
  let createdStat = null;
  try {
    handle = await fsp.open(recoveryPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    createdStat = await fsp.lstat(recoveryPath);
    if (!createdStat.isFile()) throw new Error('稳定性快照恢复锁不是普通文件，拒绝写入。');
    await handle.writeFile(`${JSON.stringify({ token, ownerPid:process.pid, createdAt:new Date(now()).toISOString() })}\n`, 'utf8');
    await handle.sync();
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== createdStat.dev || stat.ino !== createdStat.ino) {
      throw new Error('稳定性快照恢复锁在初始化期间发生变化，拒绝写入。');
    }
    return Object.freeze({
      async release() {
        await handle.close();
        const owned = await readOwnedRuntimeReliabilitySnapshotLock(recoveryPath, token, stat);
        if (owned) await fsp.unlink(recoveryPath).catch((error) => {
          if (error?.code !== 'ENOENT') throw error;
        });
      },
    });
  } catch (error) {
    await handle?.close().catch(() => {});
    if (createdStat !== null) await unlinkRuntimeReliabilitySnapshotLockIfSameFile(recoveryPath, createdStat);
    if (error?.code === 'EEXIST') return null;
    throw error;
  }
}

async function runtimeReliabilitySnapshotRecoveryExists(lockPath) {
  const recoveryPath = `${lockPath}.recovery`;
  const stat = await fsp.lstat(recoveryPath).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (stat === null) return false;
  await assertRuntimeReliabilitySnapshotLockIsRegular(recoveryPath);
  return true;
}

async function waitForRuntimeReliabilitySnapshotRecovery(lockPath, { deadline, retryMs, now }) {
  while (await runtimeReliabilitySnapshotRecoveryExists(lockPath)) {
    if (now() >= deadline) throw new Error('稳定性快照正在被其他 observe/run 更新，等待锁超时。');
    await delay(retryMs);
  }
}

async function readOwnedRuntimeReliabilitySnapshotLock(lockPath, token, expectedStat) {
  let linkStat;
  try {
    linkStat = await fsp.lstat(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (!linkStat.isFile() || linkStat.dev !== expectedStat.dev || linkStat.ino !== expectedStat.ino) return false;
  const handle = await fsp.open(lockPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== expectedStat.dev || stat.ino !== expectedStat.ino) return false;
    const record = JSON.parse(await handle.readFile('utf8'));
    return record?.token === token;
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  } finally {
    await handle.close();
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function shouldPreserveRuntimeReliabilitySnapshot(existing, candidate) {
  if (!['healthy', 'degraded'].includes(existing?.status) || candidate?.status !== 'unknown') return false;
  const existingIdentity = normalizedRuntimeIdentity(existing?.runtimeIdentity);
  const candidateIdentity = normalizedRuntimeIdentity(candidate?.runtimeIdentity);
  return Boolean(
    existingIdentity
    && candidateIdentity
    && existingIdentity.gitHead === candidateIdentity.gitHead
    && existingIdentity.releaseHash === candidateIdentity.releaseHash
  );
}

function normalizedRuntimeIdentity(identity) {
  const gitHead = normalizedGitHead(identity?.gitHead);
  const releaseHash = normalizedSha256(identity?.releaseHash);
  return gitHead && releaseHash ? { gitHead, releaseHash } : null;
}

async function openRuntimeReliabilitySnapshotForUpdate(filePath) {
  let linkStat;
  try {
    linkStat = await fsp.lstat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return { snapshot:null, handle:null };
    throw error;
  }
  if (!linkStat.isFile()) throw new Error(`${RUNTIME_RELIABILITY_SNAPSHOT_FILE} 已存在但不是普通文件，拒绝更新。`);

  let handle;
  try {
    handle = await fsp.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || fileStat.dev !== linkStat.dev || fileStat.ino !== linkStat.ino) {
      throw new Error(`${RUNTIME_RELIABILITY_SNAPSHOT_FILE} 在安全检查期间发生变化，拒绝更新。`);
    }
    let snapshot = null;
    try {
      snapshot = JSON.parse(await handle.readFile('utf8'));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    return { snapshot, handle };
  } catch (error) {
    await handle?.close();
    throw error;
  }
}

async function replaceRuntimeReliabilitySnapshot(target, snapshot) {
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${RUNTIME_RELIABILITY_SNAPSHOT_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await fsp.writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { mode:0o600, flag:'wx' });
    await fsp.chmod(temporary, 0o600);
    await fsp.rename(temporary, target);
  } finally {
    await fsp.unlink(temporary).catch(() => {});
  }
}

function validReliabilityTimestamp(value) {
  const text = String(value || '').trim();
  return Number.isFinite(Date.parse(text)) ? text : null;
}

function validProgressIntervalSeconds(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 3_600 ? parsed : null;
}

function summarizeIdentityGates(observations) {
  const values = observations.map((observation) => observation?.identityGate?.passed);
  return Object.freeze({
    status:values.length === 0 || values.some((value) => value === undefined)
      ? 'unknown'
      : values.every(Boolean) ? 'passed' : 'failed',
  });
}

function resolveRuntimeDataDir(environment = process.env) {
  return path.resolve(environment.AGENT_ARMY_DATA_DIR || STATE_ROOT);
}

function normalizedGitHead(value) {
  const text = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(text) ? text : null;
}

function normalizedSha256(value) {
  const text = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(text) ? text : null;
}

export async function backupStateDatabases(runDirectory, databases = STATE_DATABASES) {
  const backupDirectory = path.join(runDirectory, 'sqlite-backups');
  await fsp.mkdir(backupDirectory, { recursive:true, mode:0o700 });
  await fsp.chmod(backupDirectory, 0o700);
  const results = [];
  for (const databasePath of databases) {
    if (!fs.existsSync(databasePath)) {
      results.push(Object.freeze({ database:path.basename(databasePath), status:'missing' }));
      continue;
    }
    const sourceIntegrity = sqliteScalar(databasePath, 'PRAGMA quick_check;');
    if (sourceIntegrity !== 'ok') throw new Error(`${path.basename(databasePath)} quick_check 失败：${sourceIntegrity}`);
    const destination = path.join(backupDirectory, path.basename(databasePath));
    execFileSync('sqlite3', [databasePath, `.backup '${sqlQuote(destination)}'`], { stdio:['ignore', 'pipe', 'pipe'] });
    await fsp.chmod(destination, 0o600);
    const backupIntegrity = sqliteScalar(destination, 'PRAGMA quick_check;', { immutable:true });
    if (backupIntegrity !== 'ok') throw new Error(`${path.basename(destination)} 备份 quick_check 失败：${backupIntegrity}`);
    results.push(Object.freeze({
      database:path.basename(databasePath),
      status:'backed_up',
      sourceBytes:(await fsp.stat(databasePath)).size,
      backupBytes:(await fsp.stat(destination)).size,
      sourceSha256:await sha256File(databasePath),
      backupSha256:await sha256File(destination),
      sourceIntegrity,
      backupIntegrity,
      sourceTableCount:Number(sqliteScalar(databasePath, "SELECT count(*) FROM sqlite_schema WHERE type='table';")),
      backupTableCount:Number(sqliteScalar(destination, "SELECT count(*) FROM sqlite_schema WHERE type='table';", { immutable:true })),
    }));
  }
  return Object.freeze(results);
}

export async function collectFileSnapshot(filePath, {
  baseDirectory = path.dirname(filePath),
  hashMode = 'content',
} = {}) {
  let stats;
  try {
    stats = await fsp.stat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return Object.freeze({
        relativePath:path.relative(baseDirectory, filePath) || path.basename(filePath),
        status:'missing',
        hashMode,
      });
    }
    throw error;
  }
  const relativePath = path.relative(baseDirectory, filePath) || path.basename(filePath);
  const normalizedMode = hashMode === 'content' ? 'content' : 'metadata';
  const snapshot = {
    relativePath,
    status:'present',
    hashMode:normalizedMode,
    fileType:stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other',
    size:stats.size,
    mode:stats.mode & 0o777,
    mtimeMs:Math.round(stats.mtimeMs),
  };
  if (snapshot.fileType === 'file' && normalizedMode === 'content') {
    return Object.freeze({ ...snapshot, sha256:await sha256File(filePath) });
  }
  return Object.freeze({
    ...snapshot,
    sha256:metadataSha256(snapshot),
  });
}

export async function collectReferenceSnapshots(entries, {
  baseDirectory = '/',
} = {}) {
  const snapshots = await Promise.all(entries.map((entry) => collectFileSnapshot(entry.filePath, {
    baseDirectory,
    hashMode:entry.hashMode,
  })));
  return Object.freeze(snapshots);
}

export async function collectHermesTemplateSnapshots(root) {
  const directory = path.join(root, REPO_HERMES_PROFILE_DIRECTORY);
  const names = (await fsp.readdir(directory).catch(() => []))
    .filter((name) => name.endsWith('.profile.json'))
    .sort();
  return collectReferenceSnapshots(
    names.map((name) => Object.freeze({ filePath:path.join(directory, name), hashMode:'content' })),
    { baseDirectory:root },
  );
}

export async function collectHermesProfileSnapshots(profileRoot = HERMES_PROFILE_ROOT) {
  const entries = await fsp.readdir(profileRoot, { withFileTypes:true }).catch(() => []);
  const profiles = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const profileDirectory = path.join(profileRoot, entry.name);
    const names = await fsp.readdir(profileDirectory).catch(() => []);
    const metadata = await Promise.all(names.map(async (name) => {
      const stats = await fsp.stat(path.join(profileDirectory, name)).catch(() => null);
      return stats ? Object.freeze({
        fileType:stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other',
        size:stats.size,
        mode:stats.mode & 0o777,
      }) : null;
    }));
    const present = metadata.filter(Boolean);
    profiles.push(Object.freeze({
      profileOrdinal:profiles.length + 1,
      entryCount:present.length,
      fileCount:present.filter((item) => item.fileType === 'file').length,
      directoryCount:present.filter((item) => item.fileType === 'directory').length,
      totalBytes:present.reduce((sum, item) => sum + item.size, 0),
      nonPrivateModeCount:present.filter((item) => (item.mode & 0o077) !== 0).length,
    }));
  }
  return Object.freeze({ profileCount:profiles.length, profiles:Object.freeze(profiles) });
}

function metadataSha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Parse macOS ps `time=` values: MM:SS, HH:MM:SS, or DD-HH:MM:SS. */
export function parsePsCpuTime(value) {
  const text = String(value ?? '').trim();
  const match = text.match(/^(?:(\d+)-)?(\d+):(\d{2})(?::(\d{2}))?(\.\d+)?$/);
  if (!match) return null;
  const days = match[1] === undefined ? 0 : Number(match[1]);
  const first = Number(match[2]);
  const second = Number(match[3]);
  const hasHours = match[4] !== undefined;
  const third = hasHours ? Number(match[4]) : 0;
  const fraction = match[5] ? Number(match[5]) : 0;
  if (![days, first, second, third].every(Number.isSafeInteger) || !Number.isFinite(fraction)) return null;
  if (days > 0 && !hasHours) return null;
  if (hasHours && second >= 60) return null;
  if (hasHours && days > 0 && first >= 24) return null;
  const seconds = hasHours
    ? (((days * 24) + first) * 60 * 60) + (second * 60) + third + fraction
    : (first * 60) + second + fraction;
  if (
    (hasHours ? third : second) >= 60
    || !Number.isFinite(seconds)
    || seconds < 0
    || seconds > Number.MAX_SAFE_INTEGER
  ) return null;
  return seconds;
}

async function sampleProcesses(services) {
  const entries = await Promise.all(Object.entries(services).map(async ([name, service]) => {
    const pid = Number(service?.pid);
    if (!Number.isSafeInteger(pid) || pid <= 0) return [name, null];
    try {
      const [{ stdout:psOutput }, { stdout:lsofOutput }] = await Promise.all([
        execFileAsync('ps', ['-p', String(pid), '-o', 'pid=,pcpu=,rss=,time=,etime='], { encoding:'utf8' }),
        execFileAsync('lsof', ['-p', String(pid), '-Fn'], { encoding:'utf8', maxBuffer:8 * 1024 * 1024 }),
      ]);
      const match = psOutput.trim().match(/^(\d+)\s+([0-9.]+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      if (!match) return [name, Object.freeze({ pid, status:'unparsed' })];
      return [name, Object.freeze({
        pid,
        status:'observed',
        cpuPercent:Number(match[2]),
        rssBytes:Number(match[3]) * 1024,
        cpuTimeSeconds:parsePsCpuTime(match[4]),
        cpuTimeMetricVersion:AJUN_CPU_METRIC_VERSION,
        elapsed:String(match[5]).trim(),
        openFileDescriptorCount:lsofOutput.split(/\r?\n/).filter((line) => line.startsWith('f')).length,
      })];
    } catch {
      return [name, Object.freeze({ pid, status:'unavailable' })];
    }
  }));
  return Object.freeze(Object.fromEntries(entries));
}

async function runPool(jobs, concurrency) {
  const results = new Array(jobs.length);
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const index = next;
      next += 1;
      results[index] = await jobs[index]();
    }
  }
  await Promise.all(Array.from({ length:Math.min(concurrency, jobs.length) }, () => worker()));
  return results;
}

function percentile(sortedValues, ratio) {
  if (!sortedValues.length) return null;
  const index = Math.max(0, Math.ceil(sortedValues.length * ratio) - 1);
  return roundMillis(sortedValues[index]);
}

function isStrictlyMonotonicGrowth(values) {
  return values.length >= 5 && values.slice(1).every((value, index) => value > values[index]);
}

function summarizeResourceTrend(values) {
  const normalized = values.filter(Number.isFinite);
  const initialValue = normalized.at(0) ?? null;
  const finalValue = normalized.at(-1) ?? null;
  return Object.freeze({
    sampleCount:normalized.length,
    initialValue,
    finalValue,
    maxValue:normalized.length ? Math.max(...normalized) : null,
    finalToInitialRatio:normalized.length > 1 && initialValue > 0
      ? roundRatio(finalValue / initialValue)
      : null,
    monotonicallyGrowing:isStrictlyMonotonicGrowth(normalized),
  });
}

function describeObservationWindow(durationSeconds) {
  const seconds = Number(durationSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds % 3600 === 0) return `${seconds / 3600}小时`;
  if (seconds % 60 === 0) return `${seconds / 60}分钟`;
  return `${roundMillis(seconds)} 秒`;
}

function evaluateCpuGate(intervalSummary) {
  const expectedAdjacentIntervalCount = intervalSummary?.expectedAdjacentIntervalCount;
  const validIntervalCount = intervalSummary?.validIntervalCount;
  const exactCoverageRatio = Number.isSafeInteger(expectedAdjacentIntervalCount)
    && expectedAdjacentIntervalCount > 0
    && Number.isSafeInteger(validIntervalCount)
    && validIntervalCount >= 0
    && validIntervalCount <= expectedAdjacentIntervalCount
    ? validIntervalCount / expectedAdjacentIntervalCount
    : null;
  const coverageSufficient = Number.isFinite(exactCoverageRatio)
    && exactCoverageRatio >= AJUN_CPU_INTERVAL_COVERAGE_THRESHOLD;
  if (
    intervalSummary?.metricVersion !== AJUN_CPU_METRIC_VERSION
    || (intervalSummary?.sampleCount || 0) < AJUN_CPU_MIN_INTERVAL_SAMPLE_COUNT
    || !coverageSufficient
    || !Number.isFinite(intervalSummary?.p95Percent)
  ) {
    return Object.freeze({
      metricVersion:AJUN_CPU_METRIC_VERSION,
      thresholdPercent:AJUN_IDLE_CPU_P95_PERCENT_THRESHOLD,
      minimumIntervalSampleCount:AJUN_CPU_MIN_INTERVAL_SAMPLE_COUNT,
      minimumIntervalCoverageRatio:AJUN_CPU_INTERVAL_COVERAGE_THRESHOLD,
      expectedAdjacentIntervalCount:intervalSummary?.expectedAdjacentIntervalCount ?? null,
      validIntervalCount:intervalSummary?.validIntervalCount ?? null,
      coverageRatio:intervalSummary?.coverageRatio ?? null,
      status:'unknown',
      reason:(intervalSummary?.sampleCount || 0) < AJUN_CPU_MIN_INTERVAL_SAMPLE_COUNT
        ? 'insufficient_v2_interval_samples'
        : 'insufficient_v2_interval_coverage',
    });
  }
  return Object.freeze({
    metricVersion:AJUN_CPU_METRIC_VERSION,
    thresholdPercent:AJUN_IDLE_CPU_P95_PERCENT_THRESHOLD,
    minimumIntervalSampleCount:AJUN_CPU_MIN_INTERVAL_SAMPLE_COUNT,
    minimumIntervalCoverageRatio:AJUN_CPU_INTERVAL_COVERAGE_THRESHOLD,
    expectedAdjacentIntervalCount:intervalSummary.expectedAdjacentIntervalCount,
    validIntervalCount:intervalSummary.validIntervalCount,
    coverageRatio:intervalSummary.coverageRatio,
    status:intervalSummary.p95Percent <= AJUN_IDLE_CPU_P95_PERCENT_THRESHOLD ? 'passed' : 'failed',
    reason:intervalSummary.p95Percent <= AJUN_IDLE_CPU_P95_PERCENT_THRESHOLD
      ? 'within_threshold'
      : 'p95_above_threshold',
  });
}

function evaluateRssGate(trend) {
  if ((trend?.sampleCount || 0) < 5) {
    return Object.freeze({
      thresholdRatio:RSS_GROWTH_RATIO_THRESHOLD,
      status:'unknown',
      reason:'insufficient_samples',
    });
  }
  const ratioOkay = trend.finalToInitialRatio !== null && trend.finalToInitialRatio <= RSS_GROWTH_RATIO_THRESHOLD;
  const monotonicOkay = trend.monotonicallyGrowing === false;
  return Object.freeze({
    thresholdRatio:RSS_GROWTH_RATIO_THRESHOLD,
    status:ratioOkay && monotonicOkay ? 'passed' : 'failed',
    reason:ratioOkay
      ? monotonicOkay ? 'within_threshold' : 'monotonic_growth'
      : 'ratio_exceeded',
  });
}

function normalizeProbeError(error) {
  const code = String(error?.cause?.code || error?.code || error?.name || 'request_failed');
  return /^[A-Z0-9_]+$/i.test(code) ? code.slice(0, 64) : 'request_failed';
}

function roundMillis(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function roundRatio(value) {
  return Number.isFinite(value) ? Math.round(value * 1_000_000) / 1_000_000 : null;
}

function money(value) {
  if (!Number.isFinite(value) || value < 0) throw new Error('费用必须是非负数字。');
  return Math.round(value * 100) / 100;
}

function sqlQuote(value) {
  return String(value).replaceAll("'", "''");
}

function sqliteScalar(databasePath, sql, { immutable = false } = {}) {
  const query = immutable ? 'mode=ro&immutable=1' : 'mode=ro';
  return execFileSync('sqlite3', [`file:${databasePath}?${query}`, sql], {
    encoding:'utf8',
    stdio:['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

async function writePrivateJson(filePath, value) {
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode:0o600 });
  await fsp.chmod(filePath, 0o600);
}

async function appendPrivateJsonLine(filePath, value) {
  await fsp.appendFile(filePath, `${JSON.stringify(value)}\n`, { mode:0o600 });
  await fsp.chmod(filePath, 0o600);
}

function parseArgs(argv) {
  const [command = 'help', ...tokens] = argv;
  const options = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) throw new Error(`未知参数：${token}`);
    const key = token.slice(2);
    const value = tokens[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`参数 --${key} 缺少值。`);
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

function positiveInteger(value, fallback, label) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} 必须是正整数。`);
  return parsed;
}

async function gitChangedPaths(root) {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain=v1'], { cwd:root, encoding:'utf8' });
  return stdout.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3));
}

async function baselineCommand({ root, runId, acceptanceRoot }) {
  const runDirectory = await preparePrivateRunDirectory(runId, acceptanceRoot);
  const observation = await collectObservation({ root });
  const databaseBackups = await backupStateDatabases(runDirectory);
  const hermesTemplateSnapshots = await collectHermesTemplateSnapshots(root);
  const hermesProfileSnapshots = await collectHermesProfileSnapshots();
  const stateReferenceSnapshots = await collectReferenceSnapshots(STATE_REFERENCE_FILES, {
    baseDirectory:STATE_ROOT,
  });
  const baseline = Object.freeze({
    schemaVersion:'agent.army/stability-run/v1',
    runId,
    phase:'baseline',
    createdAt:new Date().toISOString(),
    safety:Object.freeze({ secretsRead:false, externalEffects:false, servicesMutated:false }),
    budget:Object.freeze({ currency:'CNY', softStop:SOFT_BUDGET_CNY, hardStop:HARD_BUDGET_CNY, spent:0 }),
    dirtyPaths:await gitChangedPaths(root),
    observation,
    databaseBackups,
    referenceSnapshots:Object.freeze({
      stateFiles:stateReferenceSnapshots,
      repoHermesTemplates:hermesTemplateSnapshots,
      liveHermesProfiles:hermesProfileSnapshots,
    }),
  });
  await writePrivateJson(path.join(runDirectory, 'baseline.json'), baseline);
  process.stdout.write(`${JSON.stringify(buildPublicRunResult({
    runId,
    artifactFiles:{ baseline:'baseline.json', sqliteBackups:'sqlite-backups/' },
    baseline,
  }), null, 2)}\n`);
}

async function loadCommand({ runId, acceptanceRoot, options }) {
  const runDirectory = await preparePrivateRunDirectory(runId, acceptanceRoot);
  const levels = String(options.levels || '1,3,5,10').split(',').map(Number);
  const requestsPerEndpoint = positiveInteger(options['requests-per-endpoint'], 20, 'requests-per-endpoint');
  const result = await runEndpointLoad({ levels, requestsPerEndpoint });
  await writePrivateJson(path.join(runDirectory, 'load.json'), result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function observeCommand({ root, runId, acceptanceRoot, options }) {
  const runDirectory = await preparePrivateRunDirectory(runId, acceptanceRoot);
  const lock = await acquireObserveLock(runDirectory);
  const durationSeconds = positiveInteger(options['duration-seconds'], 72 * 60 * 60, 'duration-seconds');
  const intervalSeconds = positiveInteger(options['interval-seconds'], 30, 'interval-seconds');
  const resume = parseBooleanOption(options.resume, { defaultValue:false, label:'resume' });
  const expected = Object.freeze({
    gitHead:options['expected-git-head'] || null,
    releaseHash:options['expected-release-hash'] || null,
  });
  try {
    const state = await prepareObserveRunState({
      runId,
      runDirectory,
      durationSeconds,
      intervalSeconds,
      expected,
      resume,
    });
    const { manifest, manifestPath, observationPath } = state;
    await writePrivateJson(manifestPath, manifest);
    let stopRequested = false;
    let wakeIntervalWait = null;
    const requestStop = () => {
      stopRequested = true;
      wakeIntervalWait?.();
    };
    const waitForNextInterval = () => new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (wakeIntervalWait === finish) wakeIntervalWait = null;
        resolve();
      };
      const timer = setTimeout(finish, manifest.intervalSeconds * 1_000);
      wakeIntervalWait = finish;
      if (stopRequested) finish();
    });
    process.once('SIGINT', requestStop);
    process.once('SIGTERM', requestStop);
    try {
      let identityFailure = null;
      // Resume pays one full-log calculation here. Every newly appended sample then
      // advances the accumulator in O(1), instead of repeatedly sorting JSONL.
      const durationAccumulator = createObservationDurationAccumulator(state.observations, {
        startedAt:manifest.startedAt,
        intervalSeconds:manifest.intervalSeconds,
        durationSeconds:manifest.durationSeconds,
      });
      let durationProgress = durationAccumulator.progress();
      const completeAtStart = durationProgress.complete;
      if (!durationProgress.complete) {
        do {
          const observation = await collectObservation({ root });
          const identityGate = evaluateIdentityGate(observation, manifest.expected);
          const observationWithGate = { ...observation, identityGate };
          await appendPrivateJsonLine(observationPath, observationWithGate);
          if (!identityGate.passed) {
            identityFailure = identityGate;
            break;
          }
          // 身份正确还不够：所有 required probe 均成功才证明当前 run 仍健康地推进。
          if (isHeartbeatEligibleObservation(observationWithGate)) {
            await writeRuntimeReliabilityProgressHeartbeat({
              runtimeIdentity:manifest.expected,
              progressObservedAt:observationWithGate.observedAt,
              progressIntervalSeconds:manifest.intervalSeconds,
            });
          }
          durationProgress = durationAccumulator.append(observationWithGate);
          if (durationProgress.complete || stopRequested) break;
          await waitForNextInterval();
        } while (!stopRequested);
      }
      const summary = await summarizeRunDirectory(runDirectory);
      const persistedStopRequested = completeAtStart
        ? summary.stopRequested
        : stopRequested ? true : durationProgress.complete ? false : null;
      const summaryWithOutcome = { ...summary, identityFailure, stopRequested:persistedStopRequested };
      await writePrivateJson(path.join(runDirectory, 'summary.json'), summaryWithOutcome);
      await writeRuntimeReliabilitySnapshot(buildRuntimeReliabilitySnapshot(summaryWithOutcome));
      process.stdout.write(`${JSON.stringify(buildPublicRunResult({
        runId,
        artifactFiles:{
          manifest:'soak-manifest.json',
          observations:'observations.jsonl',
          summary:'summary.json',
        },
        summary,
        identityFailure,
        stopRequested:persistedStopRequested,
      }), null, 2)}\n`);
      if (identityFailure) process.exitCode = 2;
    } finally {
      wakeIntervalWait?.();
      process.removeListener('SIGINT', requestStop);
      process.removeListener('SIGTERM', requestStop);
    }
  } finally {
    await lock.release();
  }
}

async function costCommand({ runId, acceptanceRoot, options }) {
  const runDirectory = await preparePrivateRunDirectory(runId, acceptanceRoot);
  const ledgerPath = path.join(runDirectory, 'cost-ledger.jsonl');
  let total = 0;
  if (fs.existsSync(ledgerPath)) {
    const lines = (await fsp.readFile(ledgerPath, 'utf8')).split(/\r?\n/).filter(Boolean);
    total = lines.reduce((sum, line) => sum + Number(JSON.parse(line).amountCny || 0), 0);
  }
  const amountCny = money(Number(options['amount-cny']));
  const gate = evaluateBudget(total, amountCny);
  const source = String(options.source || 'manual');
  if (!['manual', 'paperclip', 'gateway', 'provider'].includes(source)) {
    throw new Error('source 只允许 manual、paperclip、gateway 或 provider。');
  }
  const entry = Object.freeze({
    schemaVersion:'agent.army/stability-cost/v1',
    recordedAt:new Date().toISOString(),
    amountCny,
    source,
    referenceSha256:hashEvidenceReference(options.reference),
    totalCny:gate.totalCny,
    gate:gate.gate,
  });
  await appendPrivateJsonLine(ledgerPath, entry);
  process.stdout.write(`${JSON.stringify({ entry, ...gate }, null, 2)}\n`);
  if (!gate.allowNewProviderCall) process.exitCode = 2;
}

async function summarizeCommand({ runId, acceptanceRoot }) {
  const runDirectory = resolveRunDirectory(runId, acceptanceRoot);
  const summary = await summarizeRunDirectory(runDirectory);
  await writePrivateJson(path.join(runDirectory, 'summary.json'), summary);
  await writeRuntimeReliabilitySnapshot(buildRuntimeReliabilitySnapshot(summary));
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

function usage() {
  return [
    'Usage:',
    '  node scripts/stability-observer.mjs baseline --run-id <id>',
    '  node scripts/stability-observer.mjs load --run-id <id> [--levels 1,3,5,10] [--requests-per-endpoint 20]',
    '  node scripts/stability-observer.mjs observe --run-id <id> [--duration-seconds 259200] [--interval-seconds 30] [--resume true|false] --expected-git-head <sha> --expected-release-hash <sha256>',
    '  node scripts/stability-observer.mjs cost --run-id <id> --amount-cny <number> --source <paperclip|gateway|provider> [--reference text]',
    '  node scripts/stability-observer.mjs summarize --run-id <id>',
  ].join('\n');
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'help') {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const root = path.resolve(process.cwd());
  const runId = options['run-id'] || createRunId();
  const context = { root, runId, acceptanceRoot:DEFAULT_ACCEPTANCE_ROOT, options };
  if (command === 'baseline') return baselineCommand(context);
  if (command === 'load') return loadCommand(context);
  if (command === 'observe') return observeCommand(context);
  if (command === 'cost') return costCommand(context);
  if (command === 'summarize') return summarizeCommand(context);
  throw new Error(`未知命令：${command}\n${usage()}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${String(error?.message || error)}\n`);
    process.exitCode = 1;
  }
}

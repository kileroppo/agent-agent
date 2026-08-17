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
  const endpointSamples = observations.flatMap((observation) => observation.endpoints || []);
  const requiredSamples = endpointSamples.filter((sample) => sample.required);
  const requiredSuccess = requiredSamples.filter((sample) => sample.ok).length;
  const ajunProcesses = observations.map((observation) => observation.processes?.ajun).filter(Boolean);
  const rssValues = ajunProcesses.map((sample) => sample.rssBytes).filter(Number.isFinite);
  const openFdValues = ajunProcesses.map((sample) => sample.openFileDescriptorCount).filter(Number.isFinite);
  const cpuValues = ajunProcesses.map((sample) => sample.cpuPercent).filter(Number.isFinite).sort((a, b) => a - b);
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
    endpoints:summarizeEndpointSamples(endpointSamples),
    ajun:Object.freeze({
      cpuP95Percent:percentile(cpuValues, 0.95),
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
  const intervalMs = positiveInteger(intervalSeconds, 30, 'interval-seconds') * 1_000;
  const startMs = Date.parse(startedAt || '');
  let cursorMs = Number.isFinite(startMs) ? startMs : null;
  let totalMs = 0;
  for (const observedMs of normalizeObservationTimes(observations)) {
    if (cursorMs === null) {
      cursorMs = observedMs;
      continue;
    }
    const deltaMs = observedMs - cursorMs;
    if (deltaMs > 0) totalMs += Math.min(deltaMs, intervalMs);
    cursorMs = observedMs;
  }
  return totalMs;
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
  const startedAt = existingManifest?.startedAt || now().toISOString();
  const normalizedDurationSeconds = existingManifest?.durationSeconds ?? durationSeconds;
  const normalizedIntervalSeconds = existingManifest?.intervalSeconds ?? intervalSeconds;
  const resumeCount = existingManifest
    ? (existingManifest.resumeCount ?? 0) + (resume ? 1 : 0)
    : 0;
  const effectiveObservedMs = calculateObservedDurationMs(observations, {
    startedAt,
    intervalSeconds:normalizedIntervalSeconds,
  });
  const remainingDurationMs = Math.max(0, normalizedDurationSeconds * 1_000 - effectiveObservedMs);
  const manifest = Object.freeze({
    schemaVersion:'agent.army/stability-run/v1',
    runId,
    phase:'soak',
    startedAt,
    durationSeconds:normalizedDurationSeconds,
    intervalSeconds:normalizedIntervalSeconds,
    resourceSamplingCadenceNote:'当前 30 秒采样比 1 分钟更密，暂保留 30 秒并仅在 summary 输出 CPU P95。',
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
  const observationPath = path.join(runDirectory, 'observations.jsonl');
  const observations = await readObservationRecords(observationPath);
  const summary = await summarizeObservationFile(observationPath);
  const effectiveObservedMs = manifest
    ? calculateObservedDurationMs(observations, {
      startedAt:manifest.startedAt,
      intervalSeconds:manifest.intervalSeconds,
    })
    : null;
  return Object.freeze({
    ...summary,
    identityGate:summarizeIdentityGates(observations),
    run:manifest ? Object.freeze({
      runId:manifest.runId || null,
      startedAt:manifest.startedAt || null,
      durationSeconds:manifest.durationSeconds ?? null,
      intervalSeconds:manifest.intervalSeconds ?? null,
      resourceSamplingCadenceNote:manifest.resourceSamplingCadenceNote || null,
      manualResearchProbeMilestones:Array.isArray(manifest.manualResearchProbeMilestones)
        ? Object.freeze([...manifest.manualResearchProbeMilestones])
        : null,
      requiresExternalConfirmation:manifest.requiresExternalConfirmation === true,
      resumeCount:manifest.resumeCount ?? 0,
      expected:manifest.expected || null,
      effectiveObservedSeconds:effectiveObservedMs === null ? null : roundMillis(effectiveObservedMs / 1_000),
      remainingDurationSeconds:effectiveObservedMs === null || manifest.durationSeconds === undefined
        ? null
        : roundMillis(Math.max(0, manifest.durationSeconds - (effectiveObservedMs / 1_000))),
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
  const gates = { completion, identity, availability, rss, ...endpointP95 };
  const failed = Object.entries(gates).filter(([, status]) => status === 'failed').map(([id]) => id);
  const unknown = Object.entries(gates).filter(([, status]) => status === 'unknown').map(([id]) => id);
  const expected = summary?.run?.expected || {};
  const runtimeIdentity = {
    gitHead:normalizedGitHead(expected.gitHead),
    releaseHash:normalizedSha256(expected.releaseHash),
  };
  const identityComplete = Boolean(runtimeIdentity.gitHead && runtimeIdentity.releaseHash);
  const status = failed.length ? 'degraded' : unknown.length || !identityComplete ? 'unknown' : 'healthy';
  return Object.freeze({
    status,
    detail:status === 'healthy'
      ? '当前 git/release 的稳定性观测已完成，所有可用率、端点 P95 和 RSS 门禁通过。'
      : status === 'degraded'
        ? `当前 git/release 的稳定性观测存在失败门禁：${failed.join('、')}。`
        : '当前 git/release 的稳定性观测尚不完整，不能显示为稳定。',
    observedAt:summary?.lastObservedAt || summary?.generatedAt || null,
    runtimeIdentity:Object.freeze(runtimeIdentity),
  });
}

export async function writeRuntimeReliabilitySnapshot(snapshot, {
  dataDir = resolveRuntimeDataDir(),
} = {}) {
  const directory = path.resolve(dataDir);
  await fsp.mkdir(directory, { recursive:true, mode:0o700 });
  await fsp.chmod(directory, 0o700);
  const target = path.join(directory, RUNTIME_RELIABILITY_SNAPSHOT_FILE);
  const temporary = path.join(directory, `.${RUNTIME_RELIABILITY_SNAPSHOT_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await fsp.writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { mode:0o600, flag:'wx' });
    await fsp.chmod(temporary, 0o600);
    await fsp.rename(temporary, target);
    await fsp.chmod(target, 0o600);
    return target;
  } finally {
    await fsp.unlink(temporary).catch(() => {});
  }
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

async function sampleProcesses(services) {
  const entries = await Promise.all(Object.entries(services).map(async ([name, service]) => {
    const pid = Number(service?.pid);
    if (!Number.isSafeInteger(pid) || pid <= 0) return [name, null];
    try {
      const [{ stdout:psOutput }, { stdout:lsofOutput }] = await Promise.all([
        execFileAsync('ps', ['-p', String(pid), '-o', 'pid=,pcpu=,rss=,etime='], { encoding:'utf8' }),
        execFileAsync('lsof', ['-p', String(pid), '-Fn'], { encoding:'utf8', maxBuffer:8 * 1024 * 1024 }),
      ]);
      const match = psOutput.trim().match(/^(\d+)\s+([0-9.]+)\s+(\d+)\s+(.+)$/);
      if (!match) return [name, Object.freeze({ pid, status:'unparsed' })];
      return [name, Object.freeze({
        pid,
        status:'observed',
        cpuPercent:Number(match[2]),
        rssBytes:Number(match[3]) * 1024,
        elapsed:String(match[4]).trim(),
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
    const { manifest, manifestPath, observationPath, remainingDurationMs } = state;
    await writePrivateJson(manifestPath, manifest);
    let stopRequested = false;
    const requestStop = () => { stopRequested = true; };
    process.once('SIGINT', requestStop);
    process.once('SIGTERM', requestStop);
    try {
      const deadline = Date.now() + remainingDurationMs;
      let identityFailure = null;
      if (remainingDurationMs > 0) {
        do {
          const observation = await collectObservation({ root });
          const identityGate = evaluateIdentityGate(observation, manifest.expected);
          await appendPrivateJsonLine(observationPath, { ...observation, identityGate });
          if (!identityGate.passed) {
            identityFailure = identityGate;
            break;
          }
          if (Date.now() >= deadline || stopRequested) break;
          await new Promise((resolve) => setTimeout(resolve, manifest.intervalSeconds * 1_000));
        } while (!stopRequested);
      } else {
        stopRequested = true;
      }
      const summary = await summarizeRunDirectory(runDirectory);
      const summaryWithOutcome = { ...summary, identityFailure, stopRequested };
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
        stopRequested,
      }), null, 2)}\n`);
      if (identityFailure) process.exitCode = 2;
    } finally {
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

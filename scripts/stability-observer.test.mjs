import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  acquireRuntimeReliabilitySnapshotLock,
  acquireObserveLock,
  backupStateDatabases,
  buildPublicRunResult,
  buildRuntimeReliabilitySnapshot,
  calculateObservationDurationProgress,
  calculateObservedDurationMs,
  createObservationDurationAccumulator,
  collectFileSnapshot,
  collectHermesProfileSnapshots,
  collectObservation,
  evaluateBudget,
  evaluateIdentityGate,
  hashEvidenceReference,
  isHeartbeatEligibleObservation,
  parsePsCpuTime,
  parseBooleanOption,
  preparePrivateRunDirectory,
  prepareObserveRunState,
  probeEndpoint,
  readObservationRecords,
  resolveRunDirectory,
  runEndpointLoad,
  summarizeRunDirectory,
  summarizeEndpointSamples,
  summarizeCpuTimeIntervals,
  summarizeObservationFile,
  writeRuntimeReliabilityProgressHeartbeat,
  writeRuntimeReliabilitySnapshot,
} from './stability-observer.mjs';

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const observerScriptPath = path.join(scriptsDirectory, 'stability-observer.mjs');
const phase1ScriptPath = path.join(scriptsDirectory, 'run-stability-phase1.mjs');
const CPU_METRIC_V2 = 'agent.army/ajun-cpu-interval-percent/v2';
const LONG_SOAK_CLOSURE_GATES = Object.freeze({
  stopRequested:false,
  costGate:Object.freeze({ status:'passed' }),
  externalEffectsGate:Object.freeze({ status:'passed' }),
});

async function seedSoakRun(root, {
  runId = 'stability-seeded-run',
  manifest,
  observations = [],
} = {}) {
  const runDirectory = path.join(root, '.agent-army', 'acceptance', runId);
  await fsp.mkdir(runDirectory, { recursive:true, mode:0o700 });
  if (manifest) {
    await fsp.writeFile(path.join(runDirectory, 'soak-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  if (observations.length > 0) {
    await fsp.writeFile(
      path.join(runDirectory, 'observations.jsonl'),
      `${observations.map((item) => JSON.stringify(item)).join('\n')}\n`,
    );
  }
  return runDirectory;
}

async function waitForFile(filePath, { timeoutMs = 8_000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fsp.access(filePath);
      return;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('等待 CLI 证据文件超时');
}

function waitForChild(child, { timeoutMs = 8_000 } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('等待 CLI 子进程退出超时'));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function failingLockOpen(method) {
  return async (...args) => {
    const handle = await fsp.open(...args);
    return new Proxy(handle, {
      get(target, property) {
        if (property === method) {
          return async () => {
            const error = new Error(`injected ${method} failure`);
            error.code = 'EIO';
            throw error;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
}

test('验收目录限制 run-id 且收紧为 0700', async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'stability-observer-'));
  context.after(() => fsp.rm(root, { recursive:true, force:true }));
  assert.throws(() => resolveRunDirectory('../escape', root), /run-id/);
  const directory = await preparePrivateRunDirectory('stability-test', root);
  assert.equal(directory, path.join(root, 'stability-test'));
  assert.equal((await fsp.stat(directory)).mode & 0o777, 0o700);
});

test('完整且同身份的稳定性结论以 0600 原子快照供运行台读取', async (context) => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'stability-runtime-snapshot-'));
  context.after(() => fsp.rm(dataDir, { recursive:true, force:true }));
  const gitHead = 'a'.repeat(40);
  const releaseHash = 'b'.repeat(64);
  const snapshot = buildRuntimeReliabilitySnapshot({
    generatedAt:'2026-08-17T00:00:00.000Z', lastObservedAt:'2026-08-17T01:00:00.000Z',
    run:{ durationSeconds:1_800, remainingDurationSeconds:0, expected:{ gitHead, releaseHash } },
    identityGate:{ status:'passed' },
    requiredEndpointAvailabilityGate:{ status:'passed' },
    ajun:{ rssGate:{ status:'passed' } },
    endpoints:{ 'ajun-health':{ p95Ms:120 }, 'ajun-console-overview':{ p95Ms:600 } },
  });
  const filePath = await writeRuntimeReliabilitySnapshot(snapshot, { dataDir });
  assert.equal(snapshot.status, 'healthy');
  assert.match(snapshot.detail, /30分钟稳定性观测已完成/);
  assert.match(snapshot.detail, /长期稳定仍以更长观测为准/);
  assert.deepEqual(JSON.parse(await fsp.readFile(filePath, 'utf8')), snapshot);
  assert.equal((await fsp.stat(filePath)).mode & 0o777, 0o600);
  assert.deepEqual((await fsp.readdir(dataDir)).sort(), ['runtime-reliability.json']);
});

test('未完成 summarize 不降级覆盖同身份结论，但身份变化和新完整结论仍更新', async (context) => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'stability-runtime-non-regression-'));
  context.after(() => fsp.rm(dataDir, { recursive:true, force:true }));
  const firstIdentity = { gitHead:'a'.repeat(40), releaseHash:'b'.repeat(64) };
  const secondIdentity = { gitHead:'c'.repeat(40), releaseHash:'d'.repeat(64) };
  const snapshot = ({ identity = firstIdentity, remainingDurationSeconds = 0, p95Ms = 120 } = {}) => (
    buildRuntimeReliabilitySnapshot({
      generatedAt:'2026-08-17T00:00:00.000Z',
      lastObservedAt:remainingDurationSeconds === 0
        ? '2026-08-17T01:00:00.000Z'
        : '2026-08-17T00:10:00.000Z',
      ...LONG_SOAK_CLOSURE_GATES,
      run:{
        durationSeconds:259_200,
        remainingDurationSeconds,
        expected:identity,
        cpuMetric:{ version:CPU_METRIC_V2 },
      },
      identityGate:{ status:'passed' },
      requiredEndpointAvailabilityGate:{ status:'passed' },
      ajun:{
        cpuMetricVersion:CPU_METRIC_V2,
        cpuExpectedAdjacentIntervalCount:5,
        cpuValidIntervalCount:5,
        cpuIntervalSampleCount:5,
        cpuP95Percent:1,
        rssGate:{ status:'passed' },
      },
      endpoints:{ 'ajun-health':{ p95Ms }, 'ajun-console-overview':{ p95Ms:600 } },
    })
  );
  const readSnapshot = async () => JSON.parse(
    await fsp.readFile(path.join(dataDir, 'runtime-reliability.json'), 'utf8'),
  );

  for (const completed of [snapshot(), snapshot({ p95Ms:301 })]) {
    assert.match(completed.status, /^(healthy|degraded)$/);
    await writeRuntimeReliabilitySnapshot(completed, { dataDir });
    const unfinishedSameIdentity = snapshot({ remainingDurationSeconds:2_400 });
    assert.equal(unfinishedSameIdentity.status, 'unknown');
    await writeRuntimeReliabilitySnapshot(unfinishedSameIdentity, { dataDir });
    assert.deepEqual(await readSnapshot(), completed);
  }

  const unfinishedNewIdentity = snapshot({
    identity:secondIdentity,
    remainingDurationSeconds:2_400,
  });
  await writeRuntimeReliabilitySnapshot(unfinishedNewIdentity, { dataDir });
  assert.deepEqual(await readSnapshot(), unfinishedNewIdentity);

  const completedNewIdentity = snapshot({ identity:secondIdentity, p95Ms:301 });
  assert.equal(completedNewIdentity.status, 'degraded');
  await writeRuntimeReliabilitySnapshot(completedNewIdentity, { dataDir });
  assert.deepEqual(await readSnapshot(), completedNewIdentity);
  assert.equal((await fsp.stat(path.join(dataDir, 'runtime-reliability.json'))).mode & 0o777, 0o600);
});

test('运行中 heartbeat 只原子推进同身份完成结论，不读取或汇总 observations', async (context) => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'stability-runtime-heartbeat-'));
  context.after(() => fsp.rm(dataDir, { recursive:true, force:true }));
  const identity = { gitHead:'a'.repeat(40), releaseHash:'b'.repeat(64) };
  const completed = buildRuntimeReliabilitySnapshot({
    lastObservedAt:'2026-08-17T01:00:00.000Z',
    run:{ durationSeconds:1_800, remainingDurationSeconds:0, expected:identity },
    identityGate:{ status:'passed' }, requiredEndpointAvailabilityGate:{ status:'passed' },
    ajun:{ rssGate:{ status:'passed' } },
    endpoints:{ 'ajun-health':{ p95Ms:100 }, 'ajun-console-overview':{ p95Ms:200 } },
  });
  await writeRuntimeReliabilitySnapshot(completed, { dataDir });
  const heartbeat = '2026-08-18T01:00:00.000Z';
  await writeRuntimeReliabilityProgressHeartbeat({
    runtimeIdentity:identity, progressObservedAt:heartbeat, progressIntervalSeconds:30,
  }, { dataDir });
  const refreshed = JSON.parse(await fsp.readFile(path.join(dataDir, 'runtime-reliability.json'), 'utf8'));
  assert.equal(refreshed.observedAt, completed.observedAt);
  assert.equal(refreshed.status, completed.status);
  assert.equal(refreshed.progressObservedAt, heartbeat);
  assert.equal(refreshed.progressIntervalSeconds, 30);

  await writeRuntimeReliabilityProgressHeartbeat({
    runtimeIdentity:{ gitHead:'c'.repeat(40), releaseHash:'d'.repeat(64) },
    progressObservedAt:'2026-08-18T01:00:30.000Z', progressIntervalSeconds:30,
  }, { dataDir });
  await writeRuntimeReliabilityProgressHeartbeat({
    runtimeIdentity:identity, progressObservedAt:'not-a-time', progressIntervalSeconds:30,
  }, { dataDir });
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(dataDir, 'runtime-reliability.json'), 'utf8')), refreshed);
});

test('snapshot 写入与 heartbeat 共用身份安全锁，旧 heartbeat 不会覆盖较新的 degraded 结论', async (context) => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'stability-runtime-write-lock-'));
  context.after(() => fsp.rm(dataDir, { recursive:true, force:true }));
  const identity = { gitHead:'a'.repeat(40), releaseHash:'b'.repeat(64) };
  const healthy = buildRuntimeReliabilitySnapshot({
    lastObservedAt:'2026-08-17T01:00:00.000Z',
    run:{ durationSeconds:1_800, remainingDurationSeconds:0, expected:identity },
    identityGate:{ status:'passed' }, requiredEndpointAvailabilityGate:{ status:'passed' },
    ajun:{ rssGate:{ status:'passed' } },
    endpoints:{ 'ajun-health':{ p95Ms:100 }, 'ajun-console-overview':{ p95Ms:200 } },
  });
  const degraded = { ...healthy, status:'degraded', detail:'同版本最新观测发现失败门禁。' };
  const target = await writeRuntimeReliabilitySnapshot(healthy, { dataDir });

  await Promise.all([
    writeRuntimeReliabilityProgressHeartbeat({
      runtimeIdentity:identity, progressObservedAt:'2026-08-18T01:00:00.000Z', progressIntervalSeconds:30,
    }, { dataDir }),
    writeRuntimeReliabilitySnapshot(degraded, { dataDir }),
  ]);
  assert.equal(JSON.parse(await fsp.readFile(target, 'utf8')).status, 'degraded');

  const lock = await acquireRuntimeReliabilitySnapshotLock(target);
  await fsp.unlink(lock.lockPath);
  await fsp.writeFile(lock.lockPath, '{"token":"replacement"}\n', { mode:0o600, flag:'wx' });
  await lock.release();
  assert.equal((await fsp.readFile(lock.lockPath, 'utf8')).includes('replacement'), true);
  await fsp.unlink(lock.lockPath);
});

test('snapshot 锁初始化 write/sync/stat 失败只清理自己创建的 inode，不留下死锁', async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'stability-runtime-lock-init-'));
  context.after(() => fsp.rm(root, { recursive:true, force:true }));
  for (const method of ['writeFile', 'sync', 'stat']) {
    const target = path.join(root, `${method}.json`);
    await assert.rejects(
      acquireRuntimeReliabilitySnapshotLock(target, { openLock:failingLockOpen(method) }),
      new RegExp(`injected ${method} failure`),
    );
    await assert.rejects(fsp.access(`${target}.lock`), { code:'ENOENT' });
  }
});

test('snapshot 锁初始化失败遇到路径替换时不删除新 inode', async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'stability-runtime-lock-replacement-'));
  context.after(() => fsp.rm(root, { recursive:true, force:true }));
  const target = path.join(root, 'runtime-reliability.json');
  const replacement = JSON.stringify({
    token:'11111111-1111-4111-8111-111111111111', ownerPid:process.pid, createdAt:new Date().toISOString(),
  });
  const openLock = async (...args) => {
    const handle = await fsp.open(...args);
    return new Proxy(handle, {
      get(targetHandle, property) {
        if (property === 'writeFile') return async () => {
          await fsp.unlink(`${target}.lock`);
          await fsp.writeFile(`${target}.lock`, `${replacement}\n`, { mode:0o600, flag:'wx' });
          throw new Error('injected replacement failure');
        };
        const value = Reflect.get(targetHandle, property, targetHandle);
        return typeof value === 'function' ? value.bind(targetHandle) : value;
      },
    });
  };

  await assert.rejects(acquireRuntimeReliabilitySnapshotLock(target, { openLock }), /injected replacement failure/);
  assert.equal((await fsp.readFile(`${target}.lock`, 'utf8')).trim(), replacement);
});

test('SIGKILL 遗留的死 PID snapshot 锁会隔离恢复，活 PID 的旧锁绝不被抢占', async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'stability-runtime-stale-lock-'));
  context.after(() => fsp.rm(root, { recursive:true, force:true }));
  const target = path.join(root, 'runtime-reliability.json');
  const deadLock = {
    token:'22222222-2222-4222-8222-222222222222', ownerPid:999_999_999,
    createdAt:'2026-01-01T00:00:00.000Z',
  };
  await fsp.writeFile(`${target}.lock`, `${JSON.stringify(deadLock)}\n`, { mode:0o600 });
  const recovered = await acquireRuntimeReliabilitySnapshotLock(target, { isProcessAlive:() => false });
  const names = await fsp.readdir(root);
  assert.equal(names.some((name) => name.startsWith('runtime-reliability.json.lock.stale.22222222-2222-4222-8222-222222222222.')), true);
  await recovered.release();

  const liveLock = {
    token:'33333333-3333-4333-8333-333333333333', ownerPid:process.pid,
    createdAt:'2020-01-01T00:00:00.000Z',
  };
  await fsp.writeFile(`${target}.lock`, `${JSON.stringify(liveLock)}\n`, { mode:0o600 });
  await assert.rejects(
    acquireRuntimeReliabilitySnapshotLock(target, { timeoutMs:25, retryMs:1, isProcessAlive:() => true }),
    /等待锁超时/,
  );
  assert.deepEqual(JSON.parse(await fsp.readFile(`${target}.lock`, 'utf8')), liveLock);
});

test('72 小时快照纳入 A君 CPU P95 门禁，未完成与样本缺失保持 unknown，30 分钟不受影响', () => {
  const identity = { gitHead:'a'.repeat(40), releaseHash:'b'.repeat(64) };
  const shortHealthy = buildRuntimeReliabilitySnapshot({
    run:{ durationSeconds:1_800, remainingDurationSeconds:0, expected:identity },
    identityGate:{ status:'passed' },
    requiredEndpointAvailabilityGate:{ status:'passed' },
    ajun:{ cpuP95Percent:99, rssGate:{ status:'passed' } },
    endpoints:{ 'ajun-health':{ p95Ms:120 }, 'ajun-console-overview':{ p95Ms:600 } },
  });
  const longPending = buildRuntimeReliabilitySnapshot({
    ...LONG_SOAK_CLOSURE_GATES,
    run:{
      durationSeconds:259_200,
      remainingDurationSeconds:258_000,
      expected:identity,
      cpuMetric:{ version:CPU_METRIC_V2 },
    },
    identityGate:{ status:'passed' },
    requiredEndpointAvailabilityGate:{ status:'passed' },
    ajun:{
      cpuMetricVersion:CPU_METRIC_V2,
      cpuExpectedAdjacentIntervalCount:5,
      cpuValidIntervalCount:5,
      cpuIntervalSampleCount:5,
      cpuP95Percent:99,
      rssGate:{ status:'passed' },
    },
    endpoints:{ 'ajun-health':{ p95Ms:120 }, 'ajun-console-overview':{ p95Ms:600 } },
  });
  const longHealthy = buildRuntimeReliabilitySnapshot({
    ...LONG_SOAK_CLOSURE_GATES,
    run:{
      durationSeconds:259_200,
      remainingDurationSeconds:0,
      expected:identity,
      cpuMetric:{ version:CPU_METRIC_V2 },
    },
    identityGate:{ status:'passed' },
    requiredEndpointAvailabilityGate:{ status:'passed' },
    ajun:{
      cpuMetricVersion:CPU_METRIC_V2,
      cpuExpectedAdjacentIntervalCount:5,
      cpuValidIntervalCount:5,
      cpuIntervalSampleCount:5,
      cpuP95Percent:5,
      rssGate:{ status:'passed' },
    },
    endpoints:{ 'ajun-health':{ p95Ms:120 }, 'ajun-console-overview':{ p95Ms:600 } },
  });
  const longCpuFailed = buildRuntimeReliabilitySnapshot({
    ...LONG_SOAK_CLOSURE_GATES,
    run:{
      durationSeconds:259_200,
      remainingDurationSeconds:0,
      expected:identity,
      cpuMetric:{ version:CPU_METRIC_V2 },
    },
    identityGate:{ status:'passed' },
    requiredEndpointAvailabilityGate:{ status:'passed' },
    ajun:{
      cpuMetricVersion:CPU_METRIC_V2,
      cpuExpectedAdjacentIntervalCount:5,
      cpuValidIntervalCount:5,
      cpuIntervalSampleCount:5,
      cpuP95Percent:5.01,
      rssGate:{ status:'passed' },
    },
    endpoints:{ 'ajun-health':{ p95Ms:120 }, 'ajun-console-overview':{ p95Ms:600 } },
  });
  const longCpuUnknown = buildRuntimeReliabilitySnapshot({
    ...LONG_SOAK_CLOSURE_GATES,
    run:{
      durationSeconds:259_200,
      remainingDurationSeconds:0,
      expected:identity,
      cpuMetric:{ version:CPU_METRIC_V2 },
    },
    identityGate:{ status:'passed' },
    requiredEndpointAvailabilityGate:{ status:'passed' },
    ajun:{
      cpuMetricVersion:CPU_METRIC_V2,
      cpuExpectedAdjacentIntervalCount:5,
      cpuValidIntervalCount:4,
      cpuIntervalSampleCount:4,
      cpuP95Percent:5,
      rssGate:{ status:'passed' },
    },
    endpoints:{ 'ajun-health':{ p95Ms:120 }, 'ajun-console-overview':{ p95Ms:600 } },
  });
  const longLegacyManifest = buildRuntimeReliabilitySnapshot({
    ...LONG_SOAK_CLOSURE_GATES,
    run:{
      durationSeconds:259_200,
      remainingDurationSeconds:0,
      expected:identity,
      cpuMetric:{ version:'legacy' },
    },
    identityGate:{ status:'passed' },
    requiredEndpointAvailabilityGate:{ status:'passed' },
    ajun:{
      cpuMetricVersion:CPU_METRIC_V2,
      cpuExpectedAdjacentIntervalCount:5,
      cpuValidIntervalCount:5,
      cpuIntervalSampleCount:5,
      cpuP95Percent:1,
      rssGate:{ status:'passed' },
    },
    endpoints:{ 'ajun-health':{ p95Ms:120 }, 'ajun-console-overview':{ p95Ms:600 } },
  });
  const longLowCoverage = buildRuntimeReliabilitySnapshot({
    ...LONG_SOAK_CLOSURE_GATES,
    run:{
      durationSeconds:259_200,
      remainingDurationSeconds:0,
      expected:identity,
      cpuMetric:{ version:CPU_METRIC_V2 },
    },
    identityGate:{ status:'passed' },
    requiredEndpointAvailabilityGate:{ status:'passed' },
    ajun:{
      cpuMetricVersion:CPU_METRIC_V2,
      cpuExpectedAdjacentIntervalCount:100,
      cpuValidIntervalCount:5,
      cpuIntervalSampleCount:5,
      cpuP95Percent:1,
      rssGate:{ status:'passed' },
    },
    endpoints:{ 'ajun-health':{ p95Ms:120 }, 'ajun-console-overview':{ p95Ms:600 } },
  });

  assert.equal(shortHealthy.status, 'healthy');
  assert.match(shortHealthy.detail, /30分钟稳定性观测已完成/);
  assert.match(shortHealthy.detail, /长期稳定仍以更长观测为准/);
  assert.equal(longPending.status, 'unknown');
  assert.match(longPending.detail, /72小时稳定性观测尚不完整/);
  assert.equal(longHealthy.status, 'healthy');
  assert.equal(longHealthy.gates['cost-budget'], 'passed');
  assert.equal(longHealthy.gates['natural-completion'], 'passed');
  assert.equal(longHealthy.gates['external-effects'], 'passed');
  assert.match(longHealthy.detail, /72小时稳定性观测已完成/);
  assert.match(longHealthy.detail, /A君 CPU P95/);
  assert.doesNotMatch(longHealthy.detail, /长期稳定仍以更长观测为准/);
  assert.equal(longCpuFailed.status, 'degraded');
  assert.match(longCpuFailed.detail, /A君 CPU P95（阈值 5%）/);
  assert.equal(longCpuUnknown.status, 'unknown');
  assert.match(longCpuUnknown.detail, /尚不完整/);
  assert.equal(longLegacyManifest.status, 'unknown');
  assert.equal(longLowCoverage.status, 'unknown');
});

test('macOS ps 累计 CPU time 支持分钟、小时、天格式并拒绝歧义值', () => {
  assert.equal(parsePsCpuTime('00:01.25'), 1.25);
  assert.equal(parsePsCpuTime('12:34.50'), 754.5);
  assert.equal(parsePsCpuTime('01:02:03.75'), 3_723.75);
  assert.equal(parsePsCpuTime('2-03:04:05.50'), 183_845.5);
  for (const invalid of ['', '1', '-1:00', '1:60', '1:60:00', '1-24:00:00', 'abc']) {
    assert.equal(parsePsCpuTime(invalid), null);
  }
});

test('CPU metric v2 只计算相邻同 PID 样本，并隔离旧样本、PID 漂移与负差', () => {
  const observation = (observedAt, pid, cpuTimeSeconds, version = CPU_METRIC_V2) => ({
    observedAt,
    processes:{ ajun:{ pid, cpuTimeSeconds, cpuTimeMetricVersion:version, cpuPercent:99 } },
  });
  const summary = summarizeCpuTimeIntervals([
    observation('2026-08-17T00:00:00.000Z', 10, 100),
    observation('2026-08-17T00:00:10.000Z', 10, 100.1), // 1%
    observation('2026-08-17T00:00:20.000Z', 11, 200), // PID boundary
    observation('2026-08-17T00:00:30.000Z', 11, 201), // 10%
    observation('2026-08-17T00:00:40.000Z', 11, 200), // counter regression
    observation('2026-08-17T00:00:50.000Z', 11, 200.2), // 2%
    observation('2026-08-17T00:01:00.000Z', 11, 200.3, 'legacy'), // legacy boundary
    observation('2026-08-17T00:01:10.000Z', 11, 200.4), // cannot bridge legacy
    observation('2026-08-17T00:01:20.000Z', 11, undefined), // missing counter boundary
    observation('2026-08-17T00:01:30.000Z', 11, 200.5), // cannot bridge missing field
    observation('invalid', 11, 200.6),
  ]);
  assert.equal(summary.metricVersion, CPU_METRIC_V2);
  assert.deepEqual(summary.intervalCpuPercents, [1, 2, 10]);
  assert.equal(summary.expectedAdjacentIntervalCount, 10);
  assert.equal(summary.validIntervalCount, 3);
  assert.equal(summary.coverageRatio, 0.3);
  assert.equal(summary.sampleCount, 3);
  assert.equal(summary.p95Percent, 10);
});

test('可靠性快照拒绝符号链接和非普通目标且不触碰链接外部文件', async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'stability-runtime-symlink-'));
  context.after(() => fsp.rm(root, { recursive:true, force:true }));
  const dataDir = path.join(root, 'runtime-data');
  const target = path.join(dataDir, 'runtime-reliability.json');
  const external = path.join(root, 'external.json');
  const externalContent = '{"outside":"must-not-change"}\n';
  await fsp.mkdir(dataDir, { mode:0o700 });
  await fsp.writeFile(external, externalContent, { mode:0o644 });
  await fsp.chmod(external, 0o644);
  await fsp.symlink(external, target);
  const externalMode = (await fsp.stat(external)).mode & 0o777;
  const candidate = buildRuntimeReliabilitySnapshot({
    run:{
      remainingDurationSeconds:3_600,
      expected:{ gitHead:'a'.repeat(40), releaseHash:'b'.repeat(64) },
    },
  });

  await assert.rejects(
    writeRuntimeReliabilitySnapshot(candidate, { dataDir }),
    /不是普通文件，拒绝更新/,
  );
  assert.equal((await fsp.lstat(target)).isSymbolicLink(), true);
  assert.equal(await fsp.readFile(external, 'utf8'), externalContent);
  assert.equal((await fsp.stat(external)).mode & 0o777, externalMode);

  await fsp.unlink(target);
  await fsp.mkdir(target);
  await assert.rejects(
    writeRuntimeReliabilitySnapshot(candidate, { dataDir }),
    /不是普通文件，拒绝更新/,
  );
  assert.equal((await fsp.lstat(target)).isDirectory(), true);
});

test('WAL 源库在线备份后可按 immutable 静态快照校验', async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'stability-sqlite-'));
  context.after(() => fsp.rm(root, { recursive:true, force:true }));
  const source = path.join(root, 'runtime.sqlite');
  execFileSync('sqlite3', [source, 'PRAGMA journal_mode=WAL; CREATE TABLE tasks(id TEXT PRIMARY KEY); INSERT INTO tasks VALUES (\'task-1\');']);
  const runDirectory = path.join(root, 'run');
  await fsp.mkdir(runDirectory, { mode:0o700 });
  const [result] = await backupStateDatabases(runDirectory, [source]);
  assert.equal(result.status, 'backed_up');
  assert.equal(result.sourceIntegrity, 'ok');
  assert.equal(result.backupIntegrity, 'ok');
  assert.equal(result.sourceTableCount, result.backupTableCount);
  assert.equal((await fsp.stat(path.join(runDirectory, 'sqlite-backups', 'runtime.sqlite'))).mode & 0o777, 0o600);
});

test('探针只保存状态、耗时和归一化错误，不保存响应正文', async () => {
  let clock = 10;
  const success = await probeEndpoint(
    { id:'health', service:'ajun', required:true, url:'http://127.0.0.1/health' },
    {
      fetchImpl:async () => ({ status:200, ok:true, async arrayBuffer() { return new TextEncoder().encode('secret'); } }),
      now:() => new Date('2026-08-17T00:00:00.000Z'),
      monotonicNow:() => { clock += 5; return clock; },
    },
  );
  assert.deepEqual(success, {
    endpointId:'health', service:'ajun', required:true,
    startedAt:'2026-08-17T00:00:00.000Z', durationMs:5, httpStatus:200, ok:true, errorCode:null,
  });
  assert.doesNotMatch(JSON.stringify(success), /secret/);

  const failure = await probeEndpoint(
    { id:'health', service:'ajun', required:true, url:'http://127.0.0.1/health' },
    { fetchImpl:async () => { const error = new Error('private details'); error.code = 'ECONNREFUSED'; throw error; } },
  );
  assert.equal(failure.errorCode, 'ECONNREFUSED');
  assert.doesNotMatch(JSON.stringify(failure), /private details/);
});

test('观测只投影运行身份和进程指标', async () => {
  const observation = await collectObservation({
    fingerprintFn:async () => ({
      source:{ gitHead:'a'.repeat(40), clean:false, changedPathCount:4 },
      live:{ sourceRelationship:'same_git_head', services:{ ajun:{ runtime:{ gitHead:'a'.repeat(40), releaseHash:'b'.repeat(64), payloadHash:'c'.repeat(64) } } } },
    }),
    endpoints:[{ id:'health', service:'ajun', required:true }],
    probe:async () => ({ endpointId:'health', service:'ajun', required:true, durationMs:2, httpStatus:200, ok:true, errorCode:null }),
    processSampler:async () => ({ ajun:{ pid:12, cpuPercent:1, rssBytes:1024 } }),
    now:() => new Date('2026-08-17T00:00:00.000Z'),
  });
  assert.equal(observation.schemaVersion, 'agent.army/stability-observation/v1');
  assert.equal(observation.identity.sourceChangedPathCount, 4);
  assert.equal(observation.identity.liveReleaseHash, 'b'.repeat(64));
  assert.equal(observation.safety.secretsRead, false);
});

test('身份门禁同时约束 Git HEAD 和 release hash', () => {
  const observation = { identity:{ liveGitHead:'a'.repeat(40), liveReleaseHash:'b'.repeat(64) } };
  assert.equal(evaluateIdentityGate(observation, { gitHead:'a'.repeat(40), releaseHash:'b'.repeat(64) }).passed, true);
  const failed = evaluateIdentityGate(observation, { gitHead:'c'.repeat(40), releaseHash:'d'.repeat(64) });
  assert.equal(failed.passed, false);
  assert.equal(failed.errors.length, 2);
});

test('heartbeat 只接受时间有效且所有 required endpoint 明确成功的采样', () => {
  const base = {
    observedAt:'2026-08-17T00:00:00.000Z',
    endpoints:[
      { endpointId:'ajun-health', required:true, ok:true },
      { endpointId:'ajun-console-overview', required:true, ok:true },
      { endpointId:'xiaod-health', required:true, ok:true },
      { endpointId:'paperclip-health', required:true, ok:true },
      { endpointId:'publisher-health', required:false, ok:false },
    ],
  };
  assert.equal(isHeartbeatEligibleObservation(base), true);
  assert.equal(isHeartbeatEligibleObservation({
    ...base,
    endpoints:base.endpoints.map((endpoint) => endpoint.endpointId === 'xiaod-health' ? { ...endpoint, ok:false } : endpoint),
  }), false);
  assert.equal(isHeartbeatEligibleObservation({ ...base, observedAt:'not-a-time' }), false);
  assert.equal(isHeartbeatEligibleObservation({ ...base, endpoints:[{ endpointId:'ajun-health', required:true, ok:true }] }), false);
});

test('只读并发探测按 1/3/5/10 分层并汇总 P95', async () => {
  let calls = 0;
  const result = await runEndpointLoad({
    levels:[1, 3, 5, 10],
    requestsPerEndpoint:2,
    endpoints:[{ id:'health', service:'ajun', required:true }],
    probe:async () => ({ endpointId:'health', required:true, ok:true, durationMs:++calls }),
  });
  assert.deepEqual(result.results.map((item) => item.concurrency), [1, 3, 5, 10]);
  assert.equal(result.results.every((item) => item.requestCount === 2), true);
  assert.equal(result.results.every((item) => item.endpoints.health.successRate === 1), true);
  assert.equal(result.externalEffects, false);
});

test('端点和费用门禁使用稳定阈值', () => {
  const summary = summarizeEndpointSamples([
    { endpointId:'health', ok:true, durationMs:10 },
    { endpointId:'health', ok:true, durationMs:20 },
    { endpointId:'health', ok:false, durationMs:30 },
  ]);
  assert.equal(summary.health.successRate, 0.666667);
  assert.equal(summary.health.p95Ms, 30);
  assert.equal(evaluateBudget(39.99, 0).gate, 'open');
  assert.equal(evaluateBudget(39.99, 0.01).gate, 'soft_stop');
  assert.equal(evaluateBudget(49, 1).gate, 'hard_stop');
  assert.equal(evaluateBudget(50, 0).allowNewProviderCall, false);
  const referenceHash = hashEvidenceReference('paperclip:issue:private-reference');
  assert.match(referenceHash, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(referenceHash, /private-reference/);
  assert.equal(hashEvidenceReference(''), null);
});

test('CLI 公共输出只暴露 runId 和产物文件名，不暴露绝对 home 或 runDirectory', () => {
  const result = buildPublicRunResult({
    runId:'stability-20260817-final',
    runDirectory:'/Users/pengaro/.agent-army/acceptance/stability-20260817-final',
    artifactFiles:{ baseline:'baseline.json', sqliteBackups:'sqlite-backups/' },
    baseline:{ schemaVersion:'agent.army/stability-run/v1' },
  });
  assert.equal(result.runId, 'stability-20260817-final');
  assert.deepEqual(result.artifacts, { baseline:'baseline.json', sqliteBackups:'sqlite-backups/' });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /\/Users\/pengaro|\.agent-army\/acceptance\/stability-20260817-final/);
  assert.equal(serialized.includes('runDirectory'), false);
});

test('恢复布尔参数和累计观察时长按恢复语义解析', () => {
  assert.equal(parseBooleanOption(undefined, { defaultValue:false, label:'resume' }), false);
  assert.equal(parseBooleanOption('true', { defaultValue:false, label:'resume' }), true);
  assert.equal(parseBooleanOption('false', { defaultValue:true, label:'resume' }), false);
  assert.throws(() => parseBooleanOption('yes', { defaultValue:false, label:'resume' }), /true 或 false/);
  const observedMs = calculateObservedDurationMs([
    { observedAt:'2026-08-17T00:00:00.000Z' },
    { observedAt:'2026-08-17T00:00:30.000Z' },
    { observedAt:'2026-08-17T00:01:00.000Z' },
    { observedAt:'2026-08-17T00:01:30.000Z' },
  ], {
    startedAt:'2026-08-17T00:00:00.000Z',
    intervalSeconds:30,
  });
  assert.equal(observedMs, 90_000);
});

test('累计观察时长会先排序去重，大 gap 按 interval 截断且乱序不重复计时', () => {
  const observedMs = calculateObservedDurationMs([
    { observedAt:'2026-08-17T00:03:00.000Z' },
    { observedAt:'2026-08-17T00:00:30.000Z' },
    { observedAt:'2026-08-17T00:02:00.000Z' },
    { observedAt:'2026-08-17T00:00:30.000Z' },
    { observedAt:'2026-08-17T00:01:00.000Z' },
  ], {
    startedAt:'2026-08-17T00:00:00.000Z',
    intervalSeconds:30,
  });
  assert.equal(observedMs, 120_000);
});

test('长测时长在 resume 单次扫描后按新增 observation 增量推进，结果保持与全量汇总一致', () => {
  const start = Date.parse('2026-08-17T00:00:00.000Z');
  const intervalSeconds = 30;
  const existing = Array.from({ length:10_000 }, (_, index) => ({
    observedAt:new Date(start + (index * intervalSeconds * 1_000)).toISOString(),
  }));
  const accumulator = createObservationDurationAccumulator(existing, {
    startedAt:new Date(start).toISOString(), intervalSeconds, durationSeconds:600_000,
  });
  const appended = Array.from({ length:10_000 }, (_, index) => ({
    observedAt:new Date(start + ((index + existing.length) * intervalSeconds * 1_000)).toISOString(),
  }));
  for (const observation of appended) accumulator.append(observation);
  const full = calculateObservationDurationProgress([...existing, ...appended], {
    startedAt:new Date(start).toISOString(), intervalSeconds, durationSeconds:600_000,
  });
  assert.deepEqual(accumulator.progress(), full);
  assert.deepEqual(accumulator.append({ observedAt:existing.at(-1).observedAt }), full);
});

test('跨数小时墙钟 gap 不会提前完成，只有有效观测累计满才完成', () => {
  const options = {
    startedAt:'2026-08-17T00:00:00.000Z',
    intervalSeconds:30,
    durationSeconds:90,
  };
  const afterWallClockGap = calculateObservationDurationProgress([
    { observedAt:'2026-08-17T05:00:00.000Z' },
  ], options);
  assert.equal(afterWallClockGap.effectiveObservedMs, 30_000);
  assert.equal(afterWallClockGap.remainingDurationMs, 60_000);
  assert.equal(afterWallClockGap.complete, false);

  const stillIncomplete = calculateObservationDurationProgress([
    { observedAt:'2026-08-17T05:00:00.000Z' },
    { observedAt:'2026-08-17T05:00:30.000Z' },
  ], options);
  assert.equal(stillIncomplete.effectiveObservedMs, 60_000);
  assert.equal(stillIncomplete.remainingDurationMs, 30_000);
  assert.equal(stillIncomplete.complete, false);

  const complete = calculateObservationDurationProgress([
    { observedAt:'2026-08-17T05:00:00.000Z' },
    { observedAt:'2026-08-17T05:00:30.000Z' },
    { observedAt:'2026-08-17T05:01:00.000Z' },
  ], options);
  assert.equal(complete.effectiveObservedMs, 90_000);
  assert.equal(complete.remainingDurationMs, 0);
  assert.equal(complete.complete, true);
});

test('cost CLI 只把 referenceSha256 落到 ledger，不保存原始 reference', async (context) => {
  const homeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'stability-cost-cli-home-'));
  context.after(() => fsp.rm(homeRoot, { recursive:true, force:true }));
  const runId = 'stability-cost-ledger';
  const rawReference = 'paperclip:issue:private-reference';
  const stdout = execFileSync(process.execPath, [
    observerScriptPath,
    'cost',
    '--run-id', runId,
    '--amount-cny', '12.34',
    '--source', 'paperclip',
    '--reference', rawReference,
  ], {
    cwd:path.resolve(scriptsDirectory, '..'),
    encoding:'utf8',
    env:{ ...process.env, HOME:homeRoot },
  });
  const ledgerPath = path.join(homeRoot, '.agent-army', 'acceptance', runId, 'cost-ledger.jsonl');
  const [entryText] = (await fsp.readFile(ledgerPath, 'utf8')).trim().split(/\r?\n/);
  const entry = JSON.parse(entryText);
  assert.equal(entry.amountCny, 12.34);
  assert.equal(entry.source, 'paperclip');
  assert.equal(entry.referenceSha256, hashEvidenceReference(rawReference));
  assert.equal(Object.hasOwn(entry, 'reference'), false);
  assert.doesNotMatch(entryText, /private-reference/);
  assert.doesNotMatch(stdout, /private-reference/);
});

test('run summary 对费用账本 fail-closed：0/open 通过，软硬停止线降级，缺失或坏记录未知', async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'stability-cost-summary-'));
  context.after(() => fsp.rm(root, { recursive:true, force:true }));
  const observation = {
    observedAt:'2026-08-17T00:00:00.000Z',
    safety:{ externalEffects:false },
    endpoints:[],
    processes:{},
  };
  const validRecord = (amountCny, gate) => ({
    schemaVersion:'agent.army/stability-cost/v1',
    recordedAt:'2026-08-17T00:00:00.000Z',
    amountCny,
    source:'manual',
    referenceSha256:null,
    totalCny:amountCny,
    gate,
  });
  const cases = [
    { id:'open', records:[validRecord(0, 'open')], expected:{ totalCny:0, level:'open', status:'passed' } },
    { id:'soft', records:[validRecord(40, 'soft_stop')], expected:{ totalCny:40, level:'soft', status:'degraded' } },
    { id:'hard', records:[validRecord(50, 'hard_stop')], expected:{ totalCny:50, level:'hard', status:'degraded' } },
    { id:'missing', records:null, expected:{ totalCny:null, level:null, status:'unknown', reason:'ledger_missing' } },
    { id:'invalid', records:['{"broken"'], expected:{ totalCny:null, level:null, status:'unknown', reason:'invalid_record' } },
  ];
  for (const item of cases) {
    const runDirectory = path.join(root, item.id);
    await fsp.mkdir(runDirectory, { recursive:true });
    await fsp.writeFile(path.join(runDirectory, 'observations.jsonl'), `${JSON.stringify(observation)}\n`);
    if (item.records) {
      const ledger = item.records.map((record) => typeof record === 'string' ? record : JSON.stringify(record)).join('\n');
      await fsp.writeFile(path.join(runDirectory, 'cost-ledger.jsonl'), `${ledger}\n`);
    }
    const summary = await summarizeRunDirectory(runDirectory);
    assert.equal(summary.costGate.totalCny, item.expected.totalCny, item.id);
    assert.equal(summary.costGate.level, item.expected.level, item.id);
    assert.equal(summary.costGate.status, item.expected.status, item.id);
    if (item.expected.reason) assert.equal(summary.costGate.reason, item.expected.reason, item.id);
  }
});

test('summary 汇总每条 observation 的 externalEffects，明确 true 优先降级，缺失或非法为 unknown', async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'stability-external-effects-'));
  context.after(() => fsp.rm(root, { recursive:true, force:true }));
  const file = path.join(root, 'observations.jsonl');
  const summarize = async (values) => {
    const observations = values.map((externalEffects, index) => ({
      observedAt:new Date(Date.parse('2026-08-17T00:00:00.000Z') + (index * 30_000)).toISOString(),
      ...(externalEffects === undefined ? {} : { safety:{ externalEffects } }),
      endpoints:[],
      processes:{},
    }));
    await fsp.writeFile(file, `${observations.map(JSON.stringify).join('\n')}\n`);
    return (await summarizeObservationFile(file)).externalEffectsGate;
  };
  const passed = await summarize([false, false]);
  assert.equal(passed.status, 'passed');
  assert.equal(passed.externalEffectsFalseCount, 2);
  assert.equal(passed.unknownCount, 0);
  const degraded = await summarize([false, undefined, true]);
  assert.equal(degraded.status, 'degraded');
  assert.equal(degraded.externalEffectsTrueCount, 1);
  assert.equal(degraded.unknownCount, 1);
  const missing = await summarize([false, undefined]);
  assert.equal(missing.status, 'unknown');
  const invalid = await summarize([false, 'false']);
  assert.equal(invalid.status, 'unknown');
});

test('72小时可靠性快照要求费用、自然完成和无外部副作用，30分钟旧 summary 仍兼容', () => {
  const identity = { gitHead:'a'.repeat(40), releaseHash:'b'.repeat(64) };
  const completeLongSummary = {
    ...LONG_SOAK_CLOSURE_GATES,
    run:{
      durationSeconds:259_200,
      remainingDurationSeconds:0,
      expected:identity,
      cpuMetric:{ version:CPU_METRIC_V2 },
    },
    identityGate:{ status:'passed' },
    requiredEndpointAvailabilityGate:{ status:'passed' },
    ajun:{
      cpuMetricVersion:CPU_METRIC_V2,
      cpuExpectedAdjacentIntervalCount:5,
      cpuValidIntervalCount:5,
      cpuP95Percent:1,
      rssGate:{ status:'passed' },
    },
    endpoints:{ 'ajun-health':{ p95Ms:120 }, 'ajun-console-overview':{ p95Ms:600 } },
  };
  const healthy = buildRuntimeReliabilitySnapshot(completeLongSummary);
  assert.equal(healthy.status, 'healthy');
  assert.match(healthy.detail, /费用预算、自然完成和无外部副作用门禁通过/);

  for (const level of ['soft', 'hard']) {
    const degraded = buildRuntimeReliabilitySnapshot({
      ...completeLongSummary,
      costGate:{ status:'degraded', level },
    });
    assert.equal(degraded.status, 'degraded', level);
    assert.equal(degraded.gates['cost-budget'], 'failed', level);
    assert.match(degraded.detail, /费用预算/);
  }
  const missingLedger = buildRuntimeReliabilitySnapshot({ ...completeLongSummary, costGate:undefined });
  assert.equal(missingLedger.status, 'unknown');
  assert.equal(missingLedger.gates['cost-budget'], 'unknown');
  assert.match(missingLedger.detail, /费用预算/);

  const stopped = buildRuntimeReliabilitySnapshot({ ...completeLongSummary, stopRequested:true });
  assert.equal(stopped.status, 'unknown');
  assert.equal(stopped.gates['natural-completion'], 'unknown');
  assert.match(stopped.detail, /自然完成/);
  const unknownStop = buildRuntimeReliabilitySnapshot({ ...completeLongSummary, stopRequested:null });
  assert.equal(unknownStop.status, 'unknown');
  assert.equal(unknownStop.gates['natural-completion'], 'unknown');

  const externalEffect = buildRuntimeReliabilitySnapshot({
    ...completeLongSummary,
    externalEffectsGate:{ status:'degraded' },
  });
  assert.equal(externalEffect.status, 'degraded');
  assert.equal(externalEffect.gates['external-effects'], 'failed');
  assert.match(externalEffect.detail, /外部副作用/);
  const unknownExternalEffect = buildRuntimeReliabilitySnapshot({
    ...completeLongSummary,
    externalEffectsGate:undefined,
  });
  assert.equal(unknownExternalEffect.status, 'unknown');
  assert.equal(unknownExternalEffect.gates['external-effects'], 'unknown');

  const legacyThirtyMinute = buildRuntimeReliabilitySnapshot({
    run:{ durationSeconds:1_800, remainingDurationSeconds:0, expected:identity },
    identityGate:{ status:'passed' },
    requiredEndpointAvailabilityGate:{ status:'passed' },
    ajun:{ rssGate:{ status:'passed' } },
    endpoints:{ 'ajun-health':{ p95Ms:120 }, 'ajun-console-overview':{ p95Ms:600 } },
  });
  assert.equal(legacyThirtyMinute.status, 'healthy');
  assert.equal(Object.hasOwn(legacyThirtyMinute.gates, 'cost-budget'), false);
  assert.doesNotMatch(JSON.stringify([healthy, missingLedger, stopped, externalEffect]), /cost-ledger|referenceSha256|\/Users\//);
});

test('已有 observations 时默认拒绝 observe 混跑，显式 resume 前不会覆盖', async (context) => {
  const homeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'stability-observe-no-resume-'));
  context.after(() => fsp.rm(homeRoot, { recursive:true, force:true }));
  const runId = 'stability-observe-no-resume';
  await seedSoakRun(homeRoot, {
    runId,
    manifest:{
      schemaVersion:'agent.army/stability-run/v1',
      runId,
      phase:'soak',
      startedAt:'2026-08-17T00:00:00.000Z',
      durationSeconds:120,
      intervalSeconds:30,
      expected:{ gitHead:'a'.repeat(40), releaseHash:'b'.repeat(64) },
      resumeCount:0,
      safety:{ readOnly:true, secretsRead:false, externalEffects:false, servicesMutated:false },
    },
    observations:[
      { observedAt:'2026-08-17T00:00:00.000Z', endpoints:[], processes:{} },
      { observedAt:'2026-08-17T00:00:30.000Z', endpoints:[], processes:{} },
    ],
  });
  assert.throws(() => execFileSync(process.execPath, [
    observerScriptPath,
    'observe',
    '--run-id', runId,
    '--duration-seconds', '120',
    '--interval-seconds', '30',
    '--expected-git-head', 'a'.repeat(40),
    '--expected-release-hash', 'b'.repeat(64),
  ], {
    cwd:path.resolve(scriptsDirectory, '..'),
    encoding:'utf8',
    env:{ ...process.env, HOME:homeRoot },
    stdio:'pipe',
  }), /默认拒绝覆盖或混跑|--resume true/);
});

test('resume 时身份期望值必须与既有 manifest 一致，否则直接拒绝', async (context) => {
  const homeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'stability-observe-mismatch-'));
  context.after(() => fsp.rm(homeRoot, { recursive:true, force:true }));
  const runId = 'stability-observe-mismatch';
  await seedSoakRun(homeRoot, {
    runId,
    manifest:{
      schemaVersion:'agent.army/stability-run/v1',
      runId,
      phase:'soak',
      startedAt:'2026-08-17T00:00:00.000Z',
      durationSeconds:120,
      intervalSeconds:30,
      expected:{ gitHead:'a'.repeat(40), releaseHash:'b'.repeat(64) },
      resumeCount:0,
      safety:{ readOnly:true, secretsRead:false, externalEffects:false, servicesMutated:false },
    },
    observations:[
      { observedAt:'2026-08-17T00:00:00.000Z', endpoints:[], processes:{} },
      { observedAt:'2026-08-17T00:00:30.000Z', endpoints:[], processes:{} },
    ],
  });
  assert.throws(() => execFileSync(process.execPath, [
    observerScriptPath,
    'observe',
    '--run-id', runId,
    '--duration-seconds', '120',
    '--interval-seconds', '30',
    '--resume', 'true',
    '--expected-git-head', 'c'.repeat(40),
    '--expected-release-hash', 'd'.repeat(64),
  ], {
    cwd:path.resolve(scriptsDirectory, '..'),
    encoding:'utf8',
    env:{ ...process.env, HOME:homeRoot },
    stdio:'pipe',
  }), /身份期望值必须与既有 soak-manifest\.json 一致/);
});

test('旧 run 缺少 CPU metric v2 契约时拒绝 resume，防止新旧样本混算', async (context) => {
  const homeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'stability-observe-cpu-v1-'));
  context.after(() => fsp.rm(homeRoot, { recursive:true, force:true }));
  const runId = 'stability-observe-cpu-v1';
  const expected = { gitHead:'a'.repeat(40), releaseHash:'b'.repeat(64) };
  const runDirectory = await seedSoakRun(homeRoot, {
    runId,
    manifest:{
      schemaVersion:'agent.army/stability-run/v1',
      runId,
      startedAt:'2026-08-17T00:00:00.000Z',
      durationSeconds:259_200,
      intervalSeconds:30,
      expected,
    },
    observations:[{
      observedAt:'2026-08-17T00:00:00.000Z',
      processes:{ ajun:{ pid:10, cpuPercent:1 } },
    }],
  });
  await assert.rejects(() => prepareObserveRunState({
    runId,
    runDirectory,
    durationSeconds:259_200,
    intervalSeconds:30,
    expected,
    resume:true,
  }), /旧 run 不具备 CPU metric v2 契约/);
});

test('resume 会保留 startedAt、累加 resumeCount，并按整 run 汇总剩余时长', async (context) => {
  const homeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'stability-observe-resume-'));
  context.after(() => fsp.rm(homeRoot, { recursive:true, force:true }));
  const runId = 'stability-observe-resume';
  const manifest = {
    schemaVersion:'agent.army/stability-run/v1',
    runId,
    phase:'soak',
    startedAt:'2026-08-17T00:00:00.000Z',
    durationSeconds:90,
    intervalSeconds:30,
    expected:{ gitHead:'a'.repeat(40), releaseHash:'b'.repeat(64) },
    cpuMetric:{ version:CPU_METRIC_V2 },
    resumeCount:0,
    safety:{ readOnly:true, secretsRead:false, externalEffects:false, servicesMutated:false },
  };
  const observations = [
    { observedAt:'2026-08-17T00:00:00.000Z', endpoints:[{ endpointId:'health', required:true, ok:true, durationMs:10 }], processes:{ ajun:{ cpuPercent:1, rssBytes:100 } } },
    { observedAt:'2026-08-17T00:00:30.000Z', endpoints:[{ endpointId:'health', required:true, ok:true, durationMs:11 }], processes:{ ajun:{ cpuPercent:2, rssBytes:101 } } },
    { observedAt:'2026-08-17T00:01:00.000Z', endpoints:[{ endpointId:'health', required:true, ok:true, durationMs:12 }], processes:{ ajun:{ cpuPercent:3, rssBytes:102 } } },
    { observedAt:'2026-08-17T00:01:30.000Z', endpoints:[{ endpointId:'health', required:true, ok:true, durationMs:13 }], processes:{ ajun:{ cpuPercent:4, rssBytes:103 } } },
  ];
  const runDirectory = await seedSoakRun(homeRoot, { runId, manifest, observations });
  const prepared = await prepareObserveRunState({
    runId,
    runDirectory,
    durationSeconds:90,
    intervalSeconds:30,
    expected:manifest.expected,
    resume:true,
  });
  assert.equal(prepared.manifest.startedAt, manifest.startedAt);
  assert.equal(prepared.manifest.resumeCount, 1);
  assert.equal(prepared.manifest.cpuMetric.version, CPU_METRIC_V2);
  assert.equal(prepared.manifest.cpuMetric.minimumIntervalCoverageRatio, 0.995);
  assert.equal(prepared.remainingDurationMs, 0);
  assert.equal((await readObservationRecords(path.join(runDirectory, 'observations.jsonl'))).length, 4);

  const stdout = execFileSync(process.execPath, [
    observerScriptPath,
    'observe',
    '--run-id', runId,
    '--duration-seconds', '90',
    '--interval-seconds', '30',
    '--resume', 'true',
    '--expected-git-head', 'a'.repeat(40),
    '--expected-release-hash', 'b'.repeat(64),
  ], {
    cwd:path.resolve(scriptsDirectory, '..'),
    encoding:'utf8',
    env:{ ...process.env, HOME:homeRoot },
  });
  const updatedManifest = JSON.parse(await fsp.readFile(path.join(runDirectory, 'soak-manifest.json'), 'utf8'));
  const summaryFile = JSON.parse(await fsp.readFile(path.join(runDirectory, 'summary.json'), 'utf8'));
  const summarized = await summarizeRunDirectory(runDirectory);
  assert.equal(updatedManifest.startedAt, manifest.startedAt);
  assert.equal(updatedManifest.resumeCount, 1);
  assert.equal(summaryFile.observationCount, 4);
  assert.equal(summaryFile.run.startedAt, manifest.startedAt);
  assert.equal(summaryFile.run.resumeCount, 1);
  assert.equal(summaryFile.run.effectiveObservedSeconds, 90);
  assert.equal(summaryFile.run.remainingDurationSeconds, 0);
  assert.equal(summaryFile.stopRequested, null);
  assert.deepEqual(summaryFile.run.manualResearchProbeMilestones, [24, 48, 72]);
  assert.equal(summaryFile.run.requiresExternalConfirmation, true);
  assert.equal(summarized.run.resumeCount, 1);
  assert.equal(summarized.observationCount, 4);
  assert.doesNotMatch(stdout, /\/Users\/|runDirectory/);
});

test('summarize 子命令重算时保留已有 stopRequested，缺失时明确为 null', async (context) => {
  const homeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'stability-summary-stop-outcome-'));
  context.after(() => fsp.rm(homeRoot, { recursive:true, force:true }));
  const runId = 'stability-summary-stop-outcome';
  const runDirectory = await seedSoakRun(homeRoot, {
    runId,
    manifest:{
      schemaVersion:'agent.army/stability-run/v1',
      runId,
      startedAt:'2026-08-17T00:00:00.000Z',
      durationSeconds:1_800,
      intervalSeconds:30,
      expected:{ gitHead:'a'.repeat(40), releaseHash:'b'.repeat(64) },
    },
    observations:[{
      observedAt:'2026-08-17T00:00:00.000Z',
      safety:{ externalEffects:false },
      identityGate:{ passed:true },
      endpoints:[],
      processes:{},
    }],
  });
  const summaryPath = path.join(runDirectory, 'summary.json');
  await fsp.writeFile(summaryPath, '{"stopRequested":true}\n');
  execFileSync(process.execPath, [observerScriptPath, 'summarize', '--run-id', runId], {
    cwd:path.resolve(scriptsDirectory, '..'),
    encoding:'utf8',
    env:{ ...process.env, HOME:homeRoot },
  });
  assert.equal(JSON.parse(await fsp.readFile(summaryPath, 'utf8')).stopRequested, true);

  const existing = JSON.parse(await fsp.readFile(summaryPath, 'utf8'));
  await fsp.writeFile(summaryPath, `${JSON.stringify({ ...existing, stopRequested:false })}\n`);
  assert.equal((await summarizeRunDirectory(runDirectory)).stopRequested, false);
  await fsp.unlink(summaryPath);
  assert.equal((await summarizeRunDirectory(runDirectory)).stopRequested, null);

  for (const invalidSummary of ['', '{"stopRequested":', '[]', 'null', '"not-an-object"']) {
    await fsp.writeFile(summaryPath, invalidSummary);
    assert.equal((await summarizeRunDirectory(runDirectory)).stopRequested, null);
  }
  await fsp.writeFile(summaryPath, '{"stopRequested":');
  execFileSync(process.execPath, [observerScriptPath, 'summarize', '--run-id', runId], {
    cwd:path.resolve(scriptsDirectory, '..'),
    encoding:'utf8',
    env:{ ...process.env, HOME:homeRoot },
  });
  const repairedSummary = JSON.parse(await fsp.readFile(summaryPath, 'utf8'));
  assert.equal(repairedSummary.schemaVersion, 'agent.army/stability-summary/v1');
  assert.equal(repairedSummary.stopRequested, null);
});

test('已完成 run 执行 resume 不采样时保留旧 stopRequested=true，不伪装自然完成', async (context) => {
  const homeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'stability-complete-resume-stop-'));
  context.after(() => fsp.rm(homeRoot, { recursive:true, force:true }));
  const runId = 'stability-complete-resume-stop';
  const expected = { gitHead:'a'.repeat(40), releaseHash:'b'.repeat(64) };
  const runDirectory = await seedSoakRun(homeRoot, {
    runId,
    manifest:{
      schemaVersion:'agent.army/stability-run/v1',
      runId,
      startedAt:'2026-08-17T00:00:00.000Z',
      durationSeconds:60,
      intervalSeconds:30,
      expected,
      cpuMetric:{ version:CPU_METRIC_V2 },
    },
    observations:[0, 30, 60].map((seconds) => ({
      observedAt:new Date(Date.parse('2026-08-17T00:00:00.000Z') + (seconds * 1_000)).toISOString(),
      safety:{ externalEffects:false },
      identityGate:{ passed:true },
      endpoints:[],
      processes:{},
    })),
  });
  const summaryPath = path.join(runDirectory, 'summary.json');
  await fsp.writeFile(summaryPath, '{"stopRequested":true}\n');
  const beforeCount = (await readObservationRecords(path.join(runDirectory, 'observations.jsonl'))).length;
  execFileSync(process.execPath, [
    observerScriptPath,
    'observe',
    '--run-id', runId,
    '--duration-seconds', '60',
    '--interval-seconds', '30',
    '--resume', 'true',
    '--expected-git-head', expected.gitHead,
    '--expected-release-hash', expected.releaseHash,
  ], {
    cwd:path.resolve(scriptsDirectory, '..'),
    encoding:'utf8',
    env:{ ...process.env, HOME:homeRoot },
  });
  const afterCount = (await readObservationRecords(path.join(runDirectory, 'observations.jsonl'))).length;
  const summary = JSON.parse(await fsp.readFile(summaryPath, 'utf8'));
  assert.equal(afterCount, beforeCount);
  assert.equal(summary.stopRequested, true);

  await fsp.writeFile(summaryPath, '{"stopRequested":');
  execFileSync(process.execPath, [
    observerScriptPath,
    'observe',
    '--run-id', runId,
    '--duration-seconds', '60',
    '--interval-seconds', '30',
    '--resume', 'true',
    '--expected-git-head', expected.gitHead,
    '--expected-release-hash', expected.releaseHash,
  ], {
    cwd:path.resolve(scriptsDirectory, '..'),
    encoding:'utf8',
    env:{ ...process.env, HOME:homeRoot },
  });
  const repairedSummary = JSON.parse(await fsp.readFile(summaryPath, 'utf8'));
  assert.equal(
    (await readObservationRecords(path.join(runDirectory, 'observations.jsonl'))).length,
    beforeCount,
  );
  assert.equal(repairedSummary.stopRequested, null);
});

test('本次从未完成状态自然达到有效时长时才落盘 stopRequested=false', async (context) => {
  const homeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'stability-natural-completion-'));
  context.after(() => fsp.rm(homeRoot, { recursive:true, force:true }));
  const runId = 'stability-natural-completion';
  execFileSync(process.execPath, [
    observerScriptPath,
    'observe',
    '--run-id', runId,
    '--duration-seconds', '1',
    '--interval-seconds', '1',
  ], {
    cwd:path.resolve(scriptsDirectory, '..'),
    encoding:'utf8',
    env:{ ...process.env, HOME:homeRoot },
  });
  const summary = JSON.parse(await fsp.readFile(
    path.join(homeRoot, '.agent-army', 'acceptance', runId, 'summary.json'),
    'utf8',
  ));
  assert.equal(summary.run.remainingDurationSeconds, 0);
  assert.equal(summary.stopRequested, false);
});

test('v2 manifest 缺少 resumeCount 时，resume 仍兼容并从 1 开始累计', async (context) => {
  const homeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'stability-observe-legacy-manifest-'));
  context.after(() => fsp.rm(homeRoot, { recursive:true, force:true }));
  const runId = 'stability-observe-legacy-manifest';
  const manifest = {
    schemaVersion:'agent.army/stability-run/v1',
    runId,
    phase:'soak',
    startedAt:'2026-08-17T00:00:00.000Z',
    durationSeconds:60,
    intervalSeconds:30,
    expected:{ gitHead:'a'.repeat(40), releaseHash:'b'.repeat(64) },
    cpuMetric:{ version:CPU_METRIC_V2 },
    safety:{ readOnly:true, secretsRead:false, externalEffects:false, servicesMutated:false },
  };
  const observations = [
    { observedAt:'2026-08-17T00:00:00.000Z', endpoints:[{ endpointId:'health', required:true, ok:true, durationMs:10 }], processes:{ ajun:{ cpuPercent:1, rssBytes:100 } } },
    { observedAt:'2026-08-17T00:00:30.000Z', endpoints:[{ endpointId:'health', required:true, ok:true, durationMs:11 }], processes:{ ajun:{ cpuPercent:2, rssBytes:101 } } },
    { observedAt:'2026-08-17T00:01:00.000Z', endpoints:[{ endpointId:'health', required:true, ok:true, durationMs:12 }], processes:{ ajun:{ cpuPercent:3, rssBytes:102 } } },
  ];
  const runDirectory = await seedSoakRun(homeRoot, { runId, manifest, observations });
  const prepared = await prepareObserveRunState({
    runId,
    runDirectory,
    durationSeconds:60,
    intervalSeconds:30,
    expected:manifest.expected,
    resume:true,
  });
  assert.equal(prepared.manifest.startedAt, manifest.startedAt);
  assert.equal(prepared.manifest.resumeCount, 1);
  assert.equal(prepared.remainingDurationMs, 0);

  execFileSync(process.execPath, [
    observerScriptPath,
    'observe',
    '--run-id', runId,
    '--duration-seconds', '60',
    '--interval-seconds', '30',
    '--resume', 'true',
    '--expected-git-head', 'a'.repeat(40),
    '--expected-release-hash', 'b'.repeat(64),
  ], {
    cwd:path.resolve(scriptsDirectory, '..'),
    encoding:'utf8',
    env:{ ...process.env, HOME:homeRoot },
  });
  const updatedManifest = JSON.parse(await fsp.readFile(path.join(runDirectory, 'soak-manifest.json'), 'utf8'));
  assert.equal(updatedManifest.resumeCount, 1);
  assert.equal(updatedManifest.startedAt, manifest.startedAt);
});

test('observe 独占锁原子创建为 0600，冲突时拒绝且 release 后清理', async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'stability-observe-lock-'));
  context.after(() => fsp.rm(root, { recursive:true, force:true }));
  const runDirectory = path.join(root, 'run');
  await fsp.mkdir(runDirectory, { recursive:true, mode:0o700 });
  const lock = await acquireObserveLock(runDirectory);
  const lockPath = path.join(runDirectory, 'observe.lock');
  assert.equal((await fsp.stat(lockPath)).mode & 0o777, 0o600);
  await assert.rejects(() => acquireObserveLock(runDirectory), /已有同 run observe 正在执行/);
  await lock.release();
  await assert.rejects(() => fsp.stat(lockPath), /ENOENT/);
});

for (const stopSignal of ['SIGINT', 'SIGTERM']) {
  test(`CLI observe 收到 ${stopSignal} 后立即唤醒、汇总并释放独占锁`, async (context) => {
    const homeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'stability-observe-signal-'));
    context.after(() => fsp.rm(homeRoot, { recursive:true, force:true }));
    const runId = `stability-observe-${stopSignal.toLowerCase()}`;
    const runDirectory = path.join(homeRoot, '.agent-army', 'acceptance', runId);
    const observationPath = path.join(runDirectory, 'observations.jsonl');
    const lockPath = path.join(runDirectory, 'observe.lock');
    const summaryPath = path.join(runDirectory, 'summary.json');
    const child = spawn(process.execPath, [
      observerScriptPath,
      'observe',
      '--run-id', runId,
      '--duration-seconds', '120',
      '--interval-seconds', '30',
    ], {
      cwd:path.resolve(scriptsDirectory, '..'),
      env:{ ...process.env, HOME:homeRoot },
      stdio:['ignore', 'pipe', 'pipe'],
    });
    context.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    const childResult = waitForChild(child);

    await waitForFile(observationPath);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const signalSentAt = Date.now();
    assert.equal(child.kill(stopSignal), true);
    const result = await childResult;
    const signalToExitMs = Date.now() - signalSentAt;

    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    assert.equal(signalToExitMs < 4_000, true, `${stopSignal} 后退出耗时 ${signalToExitMs}ms`);
    await assert.rejects(() => fsp.stat(lockPath), /ENOENT/);
    const summary = JSON.parse(await fsp.readFile(summaryPath, 'utf8'));
    assert.equal(summary.stopRequested, true);
    assert.equal(summary.observationCount >= 1, true);
    assert.equal(summary.run.remainingDurationSeconds > 0, true);
    assert.doesNotMatch(result.stdout, /observe\.lock|\/Users\/|\.agent-army|runDirectory/);
    assert.doesNotMatch(result.stderr, /observe\.lock|\/Users\/|\.agent-army|runDirectory/);
  });
}

test('CLI observe 遇到既有锁文件时拒绝，stdout/stderr 不泄露锁路径', async (context) => {
  const homeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'stability-observe-lock-cli-'));
  context.after(() => fsp.rm(homeRoot, { recursive:true, force:true }));
  const runId = 'stability-observe-lock-cli';
  const runDirectory = path.join(homeRoot, '.agent-army', 'acceptance', runId);
  await fsp.mkdir(runDirectory, { recursive:true, mode:0o700 });
  const lockPath = path.join(runDirectory, 'observe.lock');
  await fsp.writeFile(lockPath, '', { mode:0o600 });
  await fsp.chmod(lockPath, 0o600);
  try {
    assert.fail('expected observe CLI to reject existing lock');
  } catch {}
  assert.throws(() => execFileSync(process.execPath, [
    observerScriptPath,
    'observe',
    '--run-id', runId,
    '--duration-seconds', '60',
    '--interval-seconds', '30',
    '--resume', 'true',
    '--expected-git-head', 'a'.repeat(40),
    '--expected-release-hash', 'b'.repeat(64),
  ], {
    cwd:path.resolve(scriptsDirectory, '..'),
    encoding:'utf8',
    env:{ ...process.env, HOME:homeRoot },
    stdio:'pipe',
  }), (error) => {
    const stderr = String(error?.stderr || '');
    const stdout = String(error?.stdout || '');
    assert.match(stderr, /已有同 run observe 正在执行/);
    assert.doesNotMatch(stderr, /observe\.lock|\/Users\/|\.agent-army/);
    assert.doesNotMatch(stdout, /observe\.lock|\/Users\/|\.agent-army/);
    return true;
  });
});

test('72小时 JSONL 汇总可区分可用率、P95 和单调内存增长', async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'stability-summary-'));
  context.after(() => fsp.rm(root, { recursive:true, force:true }));
  const file = path.join(root, 'observations.jsonl');
  const lines = Array.from({ length:5 }, (_, index) => JSON.stringify({
    observedAt:`2026-08-17T00:00:0${index}.000Z`,
    endpoints:[{ endpointId:'health', required:true, ok:index !== 4, durationMs:10 + index }],
    processes:{ ajun:{ cpuPercent:index, rssBytes:100 + index, openFileDescriptorCount:20 + index } },
  }));
  await fsp.writeFile(file, `${lines.join('\n')}\n`);
  const summary = await summarizeObservationFile(file);
  assert.equal(summary.observationCount, 5);
  assert.equal(summary.requiredEndpointSuccessRate, 0.8);
  assert.equal(summary.requiredEndpointAvailabilityGate.status, 'failed');
  assert.equal(summary.endpoints.health.p95Ms, 14);
  assert.equal(summary.ajun.cpuMetricVersion, CPU_METRIC_V2);
  assert.equal(summary.ajun.cpuExpectedAdjacentIntervalCount, 4);
  assert.equal(summary.ajun.cpuValidIntervalCount, 0);
  assert.equal(summary.ajun.cpuIntervalCoverageRatio, 0);
  assert.equal(summary.ajun.cpuIntervalSampleCount, 0);
  assert.equal(summary.ajun.cpuP95Percent, null);
  assert.equal(summary.ajun.cpuPercentDiagnosticP95, 4);
  assert.equal(summary.ajun.cpuGate.status, 'unknown');
  assert.equal(summary.ajun.monotonicallyGrowingRss, true);
  assert.equal(summary.ajun.finalToInitialRssRatio, 1.04);
  assert.equal(summary.ajun.rssGate.status, 'failed');
  assert.equal(summary.ajun.rssGate.reason, 'monotonic_growth');
  assert.equal(summary.ajun.initialOpenFileDescriptorCount, 20);
  assert.equal(summary.ajun.finalOpenFileDescriptorCount, 24);
  assert.equal(summary.ajun.maxOpenFileDescriptorCount, 24);
  assert.equal(summary.ajun.finalToInitialOpenFileDescriptorRatio, 1.2);
  assert.equal(summary.ajun.monotonicallyGrowingOpenFileDescriptorCount, true);
});

test('summary 的 CPU P95 使用 v2 区间值和 nearest-rank，不使用瞬时 cpuPercent', async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'stability-summary-cpu-v2-'));
  context.after(() => fsp.rm(root, { recursive:true, force:true }));
  const file = path.join(root, 'observations.jsonl');
  const cumulativeCpuSeconds = [100, 101, 103, 106, 110, 115];
  const lines = cumulativeCpuSeconds.map((cpuTimeSeconds, index) => JSON.stringify({
    observedAt:new Date(Date.parse('2026-08-17T00:00:00.000Z') + (index * 100_000)).toISOString(),
    endpoints:[],
    processes:{ ajun:{
      pid:42,
      cpuTimeSeconds,
      cpuTimeMetricVersion:CPU_METRIC_V2,
      cpuPercent:99,
      rssBytes:100 + index,
    } },
  }));
  await fsp.writeFile(file, `${lines.join('\n')}\n`);
  const summary = await summarizeObservationFile(file);
  assert.equal(summary.ajun.cpuExpectedAdjacentIntervalCount, 5);
  assert.equal(summary.ajun.cpuValidIntervalCount, 5);
  assert.equal(summary.ajun.cpuIntervalCoverageRatio, 1);
  assert.equal(summary.ajun.cpuIntervalSampleCount, 5);
  assert.equal(summary.ajun.cpuP95Percent, 5);
  assert.equal(summary.ajun.cpuPercentDiagnosticP95, 99);
  assert.equal(summary.ajun.cpuGate.status, 'passed');
});

test('完整长测即使有 5 个有效 CPU 区间，覆盖率不足 99.5% 仍保持 unknown', async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'stability-summary-cpu-coverage-'));
  context.after(() => fsp.rm(root, { recursive:true, force:true }));
  const file = path.join(root, 'observations.jsonl');
  const lines = Array.from({ length:101 }, (_, index) => JSON.stringify({
    observedAt:new Date(Date.parse('2026-08-17T00:00:00.000Z') + (index * 30_000)).toISOString(),
    endpoints:[],
    processes:index <= 5 ? { ajun:{
      pid:42,
      cpuTimeSeconds:100 + (index * 0.3),
      cpuTimeMetricVersion:CPU_METRIC_V2,
      cpuPercent:1,
      rssBytes:100,
    } } : {},
  }));
  await fsp.writeFile(file, `${lines.join('\n')}\n`);
  const summary = await summarizeObservationFile(file);
  assert.equal(summary.ajun.cpuExpectedAdjacentIntervalCount, 100);
  assert.equal(summary.ajun.cpuValidIntervalCount, 5);
  assert.equal(summary.ajun.cpuIntervalCoverageRatio, 0.05);
  assert.equal(summary.ajun.cpuGate.status, 'unknown');

  const identity = { gitHead:'a'.repeat(40), releaseHash:'b'.repeat(64) };
  const snapshot = buildRuntimeReliabilitySnapshot({
    ...summary,
    ...LONG_SOAK_CLOSURE_GATES,
    run:{
      durationSeconds:259_200,
      remainingDurationSeconds:0,
      expected:identity,
      cpuMetric:{ version:CPU_METRIC_V2 },
    },
    identityGate:{ status:'passed' },
    requiredEndpointAvailabilityGate:{ status:'passed' },
    ajun:{ ...summary.ajun, rssGate:{ status:'passed' } },
    endpoints:{ 'ajun-health':{ p95Ms:120 }, 'ajun-console-overview':{ p95Ms:600 } },
  });
  assert.equal(snapshot.status, 'unknown');
});

test('summary 在高可用且 RSS 样本不足时分别给 passed 和 unknown', async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'stability-summary-gates-'));
  context.after(() => fsp.rm(root, { recursive:true, force:true }));
  const file = path.join(root, 'observations.jsonl');
  const lines = [
    { observedAt:'2026-08-17T00:00:00.000Z', endpoints:[{ endpointId:'health', required:true, ok:true, durationMs:10 }], processes:{ ajun:{ cpuPercent:1, rssBytes:100, openFileDescriptorCount:10 } } },
    { observedAt:'2026-08-17T00:00:30.000Z', endpoints:[{ endpointId:'health', required:true, ok:true, durationMs:11 }], processes:{ ajun:{ cpuPercent:2, rssBytes:110, openFileDescriptorCount:12 } } },
    { observedAt:'2026-08-17T00:01:00.000Z', endpoints:[{ endpointId:'health', required:true, ok:true, durationMs:12 }], processes:{ ajun:{ cpuPercent:3, rssBytes:105, openFileDescriptorCount:11 } } },
    { observedAt:'2026-08-17T00:01:30.000Z', endpoints:[{ endpointId:'health', required:true, ok:true, durationMs:13 }], processes:{ ajun:{ cpuPercent:4, rssBytes:115, openFileDescriptorCount:14 } } },
  ].map((item) => JSON.stringify(item));
  await fsp.writeFile(file, `${lines.join('\n')}\n`);
  const summary = await summarizeObservationFile(file);
  assert.equal(summary.requiredEndpointAvailabilityGate.status, 'passed');
  assert.equal(summary.ajun.rssGate.status, 'unknown');
  assert.equal(summary.ajun.rssGate.reason, 'insufficient_samples');
});

test('敏感文件只使用元数据哈希，不读取正文', async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'stability-file-snapshot-'));
  context.after(() => fsp.rm(root, { recursive:true, force:true }));
  const file = path.join(root, '.env');
  await fsp.writeFile(file, 'SECRET=top-secret\n');
  const metadataOnly = await collectFileSnapshot(file, { baseDirectory:root, hashMode:'metadata' });
  assert.equal(metadataOnly.hashMode, 'metadata');
  assert.doesNotMatch(JSON.stringify(metadataOnly), /top-secret/);

  const content = await collectFileSnapshot(file, { baseDirectory:root, hashMode:'content' });
  assert.equal(content.hashMode, 'content');
  assert.equal(typeof content.sha256, 'string');
  assert.equal(content.sha256.length, 64);
});

test('live Hermes 快照不保存 Profile、路径、文件名或文件正文', async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'stability-hermes-profile-'));
  context.after(() => fsp.rm(root, { recursive:true, force:true }));
  const profile = path.join(root, 'private-profile-id');
  await fsp.mkdir(profile);
  await fsp.writeFile(path.join(profile, 'new-provider-token.json'), 'top-secret-value', { mode:0o600 });
  const snapshot = await collectHermesProfileSnapshots(root);
  assert.equal(snapshot.profileCount, 1);
  assert.equal(snapshot.profiles[0].entryCount, 1);
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /private-profile-id|new-provider-token|top-secret-value/);
  assert.equal(serialized.includes(root), false);
});

test('Phase1 继续只声明本地汇总边界，不捕获原始日志也不声明 Provider 调用', async () => {
  const source = await fsp.readFile(phase1ScriptPath, 'utf8');
  assert.match(source, /stdio:'ignore'/);
  assert.match(source, /externalEffects:false/);
  assert.match(source, /providerCallsExpected:false/);
  assert.doesNotMatch(source, /child\.(?:stdout|stderr)|createWriteStream|appendFile/);
  assert.doesNotMatch(source, /https?:\/\/|fetch\(|axios|openai|anthropic|stepfun/i);
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  acquireObserveLock,
  backupStateDatabases,
  buildPublicRunResult,
  buildRuntimeReliabilitySnapshot,
  calculateObservedDurationMs,
  collectFileSnapshot,
  collectHermesProfileSnapshots,
  collectObservation,
  evaluateBudget,
  evaluateIdentityGate,
  hashEvidenceReference,
  parseBooleanOption,
  preparePrivateRunDirectory,
  prepareObserveRunState,
  probeEndpoint,
  readObservationRecords,
  resolveRunDirectory,
  runEndpointLoad,
  summarizeRunDirectory,
  summarizeEndpointSamples,
  summarizeObservationFile,
  writeRuntimeReliabilitySnapshot,
} from './stability-observer.mjs';

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const observerScriptPath = path.join(scriptsDirectory, 'stability-observer.mjs');
const phase1ScriptPath = path.join(scriptsDirectory, 'run-stability-phase1.mjs');

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
    run:{ remainingDurationSeconds:0, expected:{ gitHead, releaseHash } },
    identityGate:{ status:'passed' },
    requiredEndpointAvailabilityGate:{ status:'passed' },
    ajun:{ rssGate:{ status:'passed' } },
    endpoints:{ 'ajun-health':{ p95Ms:120 }, 'ajun-console-overview':{ p95Ms:600 } },
  });
  const filePath = await writeRuntimeReliabilitySnapshot(snapshot, { dataDir });
  assert.equal(snapshot.status, 'healthy');
  assert.deepEqual(JSON.parse(await fsp.readFile(filePath, 'utf8')), snapshot);
  assert.equal((await fsp.stat(filePath)).mode & 0o777, 0o600);
  assert.deepEqual((await fsp.readdir(dataDir)).sort(), ['runtime-reliability.json']);
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
  assert.deepEqual(summaryFile.run.manualResearchProbeMilestones, [24, 48, 72]);
  assert.equal(summaryFile.run.requiresExternalConfirmation, true);
  assert.equal(summarized.run.resumeCount, 1);
  assert.equal(summarized.observationCount, 4);
  assert.doesNotMatch(stdout, /\/Users\/|runDirectory/);
});

test('旧 manifest 缺少 resumeCount 时，resume 仍兼容并从 1 开始累计', async (context) => {
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

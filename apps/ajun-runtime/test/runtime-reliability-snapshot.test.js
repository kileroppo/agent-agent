import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildRuntimeReliabilitySnapshot,
  writeRuntimeReliabilityProgressHeartbeat,
  writeRuntimeReliabilitySnapshot,
} from '../../../scripts/stability-observer.mjs';
import { readRuntimeReliabilitySnapshot, readRuntimeReleaseIdentity } from '../src/runtime-reliability-snapshot.ts';
import { TaskOverview } from '../src/task-overview.ts';

test('旧 schema 快照没有 heartbeat 时仍可读取，并交由 24 小时结论时效规则处理', async (context) => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ajun-runtime-reliability-old-schema-'));
  context.after(() => fsp.rm(dataDir, { recursive:true, force:true }));
  const gitHead = 'e'.repeat(40);
  const releaseHash = 'f'.repeat(64);
  await fsp.writeFile(path.join(dataDir, 'runtime-reliability.json'), JSON.stringify({
    status:'healthy', detail:'旧完成结论', observedAt:new Date().toISOString(), runtimeIdentity:{ gitHead, releaseHash },
  }));

  const snapshot = await readRuntimeReliabilitySnapshot(dataDir);
  assert.equal(snapshot.progressObservedAt, null);
  assert.equal(snapshot.progressIntervalSeconds, null);
});

test('release manifest 缺少 gitHead 或 releaseHash 时不提供可采信运行身份', async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ajun-runtime-identity-incomplete-'));
  context.after(() => fsp.rm(root, { recursive:true, force:true }));
  const validGitHead = 'a'.repeat(40);
  const validReleaseHash = 'b'.repeat(64);

  await fsp.writeFile(path.join(root, 'release-manifest.json'), JSON.stringify({
    kind:'agent-army/ajun-immutable-runtime-release', git:{ gitHead:validGitHead },
  }));
  assert.equal(await readRuntimeReleaseIdentity(root), null);

  await fsp.writeFile(path.join(root, 'release-manifest.json'), JSON.stringify({
    kind:'agent-army/ajun-immutable-runtime-release', releaseHash:validReleaseHash,
  }));
  assert.equal(await readRuntimeReleaseIdentity(root), null);

  await fsp.writeFile(path.join(root, 'release-manifest.json'), JSON.stringify({
    kind:'agent-army/ajun-immutable-runtime-release', releaseHash:validReleaseHash, git:{ gitHead:validGitHead },
  }));
  assert.deepEqual(await readRuntimeReleaseIdentity(root), { gitHead:validGitHead, releaseHash:validReleaseHash });
});

test('observer 快照经 release 身份校验后端到端投影到运行台可靠性', async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ajun-runtime-reliability-'));
  context.after(() => fsp.rm(root, { recursive:true, force:true }));
  const dataDir = path.join(root, 'data');
  const runtimeRoot = path.join(root, 'release');
  const gitHead = 'a'.repeat(40);
  const releaseHash = 'b'.repeat(64);
  await fsp.mkdir(runtimeRoot, { recursive:true });
  await fsp.writeFile(path.join(runtimeRoot, 'release-manifest.json'), JSON.stringify({
    kind:'agent-army/ajun-immutable-runtime-release', releaseHash, git:{ gitHead },
  }));
  const completedAt = new Date(Date.now() - 24 * 60 * 60 * 1_000 - 1).toISOString();
  const snapshot = buildRuntimeReliabilitySnapshot({
    lastObservedAt:completedAt,
    run:{ remainingDurationSeconds:0, expected:{ gitHead, releaseHash } },
    identityGate:{ status:'passed' },
    requiredEndpointAvailabilityGate:{ status:'passed' },
    ajun:{ rssGate:{ status:'passed' } },
    endpoints:{ 'ajun-health':{ p95Ms:100 }, 'ajun-console-overview':{ p95Ms:200 } },
  });
  await writeRuntimeReliabilitySnapshot(snapshot, { dataDir });
  const overview = new TaskOverview({
    registry:{ list:async () => [], get:async () => null },
    store:{ list:async () => [], listApprovals:async () => [], listProposals:async () => [], listWorkflowAcceptances:async () => [] },
    governance:{ health:async () => ({ status:'ready', version:'test' }) },
    skillExecutionRegistry:{ overview:async () => [] },
    capabilityCatalog:{ openTaskDelegates:() => ({}) },
    getReliabilitySnapshot:() => readRuntimeReliabilitySnapshot(dataDir),
    getRuntimeIdentity:() => readRuntimeReleaseIdentity(runtimeRoot),
  });

  // 同身份的 72 小时 run 尚未结束时，observer 只能写 unknown；它不得立即覆盖已完成的短测结论。
  await writeRuntimeReliabilitySnapshot(buildRuntimeReliabilitySnapshot({
    lastObservedAt:new Date().toISOString(),
    run:{ durationSeconds:72 * 60 * 60, remainingDurationSeconds:72 * 60 * 60, expected:{ gitHead, releaseHash } },
    identityGate:{ status:'passed' },
    requiredEndpointAvailabilityGate:{ status:'passed' },
    ajun:{ rssGate:{ status:'passed' } },
    endpoints:{ 'ajun-health':{ p95Ms:100 }, 'ajun-console-overview':{ p95Ms:200 } },
  }), { dataDir });
  await writeRuntimeReliabilityProgressHeartbeat({
    runtimeIdentity:{ gitHead, releaseHash }, progressObservedAt:new Date().toISOString(), progressIntervalSeconds:30,
  }, { dataDir });
  const reliability = (await overview.readConsole()).health.reliability;
  assert.equal(reliability.status, 'healthy');
  assert.equal(reliability.observedAt, completedAt);
});

test('端到端快照在 observer 停止超过 heartbeat TTL 或时间明显未来时回到 unknown', async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ajun-runtime-reliability-freshness-'));
  context.after(() => fsp.rm(root, { recursive:true, force:true }));
  const dataDir = path.join(root, 'data');
  const runtimeRoot = path.join(root, 'release');
  const gitHead = 'c'.repeat(40);
  const releaseHash = 'd'.repeat(64);
  await fsp.mkdir(runtimeRoot, { recursive:true });
  await fsp.writeFile(path.join(runtimeRoot, 'release-manifest.json'), JSON.stringify({
    kind:'agent-army/ajun-immutable-runtime-release', releaseHash, git:{ gitHead },
  }));
  const overview = new TaskOverview({
    registry:{ list:async () => [], get:async () => null },
    store:{ list:async () => [], listApprovals:async () => [], listProposals:async () => [], listWorkflowAcceptances:async () => [] },
    governance:{ health:async () => ({ status:'ready', version:'test' }) },
    skillExecutionRegistry:{ overview:async () => [] },
    capabilityCatalog:{ openTaskDelegates:() => ({}) },
    getReliabilitySnapshot:() => readRuntimeReliabilitySnapshot(dataDir),
    getRuntimeIdentity:() => readRuntimeReleaseIdentity(runtimeRoot),
  });
  const summary = {
    run:{ remainingDurationSeconds:0, expected:{ gitHead, releaseHash } },
    identityGate:{ status:'passed' },
    requiredEndpointAvailabilityGate:{ status:'passed' },
    ajun:{ rssGate:{ status:'passed' } },
    endpoints:{ 'ajun-health':{ p95Ms:100 }, 'ajun-console-overview':{ p95Ms:200 } },
  };

  await writeRuntimeReliabilitySnapshot(buildRuntimeReliabilitySnapshot({
    ...summary,
    lastObservedAt:new Date(Date.now() - 24 * 60 * 60 * 1_000 - 1).toISOString(),
  }), { dataDir });
  await writeRuntimeReliabilityProgressHeartbeat({
    runtimeIdentity:{ gitHead, releaseHash },
    progressObservedAt:new Date(Date.now() - 121_000).toISOString(), progressIntervalSeconds:30,
  }, { dataDir });
  assert.equal((await overview.readConsole()).health.reliability.status, 'unknown');

  await writeRuntimeReliabilitySnapshot(buildRuntimeReliabilitySnapshot({
    ...summary,
    lastObservedAt:new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
  }), { dataDir });
  assert.equal((await overview.readConsole()).health.reliability.status, 'unknown');
});

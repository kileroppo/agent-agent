import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildRuntimeReliabilitySnapshot, writeRuntimeReliabilitySnapshot } from '../../../scripts/stability-observer.mjs';
import { readRuntimeReliabilitySnapshot, readRuntimeReleaseIdentity } from '../src/runtime-reliability-snapshot.ts';
import { TaskOverview } from '../src/task-overview.ts';

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
  const snapshot = buildRuntimeReliabilitySnapshot({
    lastObservedAt:'2026-08-17T01:00:00.000Z',
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

  assert.equal((await overview.readConsole()).health.reliability.status, 'healthy');
});

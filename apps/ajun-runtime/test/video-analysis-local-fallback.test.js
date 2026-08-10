import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  loadSourceTaskReadOnly,
  replaySyntheticFallback,
  summarizeSourceTask,
  verifyVideoAnalysisLocalFallback,
} from '../scripts/verify-video-analysis-local-fallback.mjs';

test('直接以 readOnly DatabaseSync 加载 data_json 且不改变运行库', async (t) => {
  const fixture = await runtimeFixture(t);
  const before = await fs.readFile(fixture.databasePath);
  const loaded = loadSourceTaskReadOnly({
    databasePath:fixture.databasePath,
    taskId:fixture.task.taskId,
  });
  const after = await fs.readFile(fixture.databasePath);
  assert.deepEqual(after, before);
  assert.equal(loaded.taskId, fixture.task.taskId);
  assert.deepEqual(summarizeSourceTask(loaded), {
    taskId:fixture.task.taskId,
    status:'succeeded',
    taskType:'media.transcribe-and-refine',
    verifiedArtifactTypes:['confirmed_transcript', 'visual_evidence_package'],
    databaseMode:'read_only',
  });
});

test('保留 synthetic auto 回放，验证无 advisor 和 Provider 的纯文本降级', async () => {
  const replay = await replaySyntheticFallback();
  assert.deepEqual(replay, {
    taskType:'content.video-benchmark-analysis',
    visualMode:'auto',
    status:'succeeded',
    generationMode:'deterministic_fallback',
    completeness:'partial',
    visualCoverage:'unavailable',
    reportReadable:true,
    reportNonEmpty:true,
    reportModuleCount:13,
    advisorApplied:false,
    providerCalls:0,
    modelUsageRecorded:false,
    tempDirectoryRemoved:true,
  });
});

test('CLI 主流程用只读库中的实际 file refs 回放且只返回脱敏计数', async (t) => {
  const fixture = await runtimeFixture(t);
  const result = await verifyVideoAnalysisLocalFallback({
    databasePath:fixture.databasePath,
    taskId:fixture.task.taskId,
    allowedArtifactRoots:[fixture.root],
  });
  assert.deepEqual(result.sourceEvidence, {
    taskId:fixture.task.taskId,
    status:'succeeded',
    taskType:'media.transcribe-and-refine',
    verifiedArtifactTypes:['confirmed_transcript', 'visual_evidence_package'],
    databaseMode:'read_only',
  });
  assert.deepEqual(result.replay, {
    taskType:'content.video-benchmark-analysis',
    visualMode:'auto',
    status:'succeeded',
    generationMode:'deterministic_fallback',
    completeness:'partial',
    visualCoverage:'unavailable',
    reportReadable:true,
    reportNonEmpty:true,
    reportModuleCount:13,
    confirmedTranscriptLoaded:true,
    visualFrameCount:2,
    visualStoryboardCount:1,
    advisorApplied:false,
    modelUsageRecorded:false,
    io:{
      sourceArtifactReads:3,
      temporaryArtifactReads:1,
      temporaryFileWrites:4,
      liveTaskStoreWrites:0,
      providerCalls:0,
      paidCalls:0,
    },
    tempDirectoryRemoved:true,
  });
  assert.deepEqual(result.safety, {
    databaseReadQueries:1,
    databaseWrites:0,
    liveTaskStoreWrites:0,
    providerCalls:0,
    paidCalls:0,
    externalSideEffects:0,
    privateContentPrinted:false,
    absoluteArtifactPathPrinted:false,
  });
  assert.doesNotMatch(
    JSON.stringify(result),
    new RegExp(`privacy-sentinel|file:\\/\\/|${escapeRegExp(fixture.root)}|ajun-video-live-fallback-`),
  );
});

async function runtimeFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-fallback-test-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const taskId = '11111111-1111-4111-8111-111111111111';
  const transcriptPath = path.join(root, 'confirmed.md');
  const visualDir = path.join(root, 'visual');
  const storyboardDir = path.join(visualDir, 'storyboards');
  const storyboardPath = path.join(storyboardDir, 'board.jpg');
  const manifestPath = path.join(visualDir, 'visual-evidence.json');
  await fs.mkdir(storyboardDir, { recursive:true });
  await fs.writeFile(transcriptPath, '[00:00] privacy-sentinel 开场交付真实结论。\n[00:08] 随后说明方法和使用边界。\n');
  await fs.writeFile(storyboardPath, 'fixture-storyboard');
  await fs.writeFile(manifestPath, JSON.stringify({
    schemaVersion:'agent.army/visual-evidence/v1',
    frames:[
      { frameId:'frame-001', timestamp:'00:00', reason:'opening_anchor' },
      { frameId:'frame-002', timestamp:'00:08', reason:'transcript_cue' },
    ],
    storyboards:[{
      storyboardId:'storyboard-001',
      localRef:'storyboards/board.jpg',
      frameRefs:['frame-001', 'frame-002'],
    }],
    coverage:{ firstFrameAt:'00:00', lastFrameAt:'00:08' },
  }));
  const task = {
    taskId,
    status:'succeeded',
    taskType:'media.transcribe-and-refine',
    input:{ title:'privacy-sentinel title' },
    artifactRefs:[
      {
        artifactId:'fixture-confirmed',
        type:'confirmed_transcript',
        location:pathToFileURL(transcriptPath).href,
        validation:{
          exists:true,
          readable:true,
          nonEmpty:true,
          confirmationMode:'automatic',
          automaticConfirmed:true,
        },
      },
      {
        artifactId:'fixture-visual',
        type:'visual_evidence_package',
        location:pathToFileURL(manifestPath).href,
        validation:{ exists:true, readable:true, nonEmpty:true },
      },
    ],
  };
  const databasePath = path.join(root, 'runtime.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec('CREATE TABLE tasks (task_id TEXT PRIMARY KEY, data_json TEXT NOT NULL)');
  database.prepare('INSERT INTO tasks (task_id, data_json) VALUES (?, ?)').run(taskId, JSON.stringify(task));
  database.close();
  return { root, databasePath, task };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

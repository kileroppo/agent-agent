import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { XiaodReconciler } from '../src/xiaod-reconciler.js';

function setup({ taskPatch = {}, getJob, onFailure = null, contentWorkspaceDir = null } = {}) {
  const task = {
    taskId: 'task-1', status: 'running', currentStage: 'delegated_to_xiaod', artifactRefs: [],
    execution: { executor: 'xiaod', xiaodJobId: 'xiaod-1', polling: { state: 'pending', consecutiveFailures: 0, nextPollAt: null } },
    ...taskPatch
  };
  const store = {
    async list() { return [task]; },
    async updateTask(taskId, patch) { assert.equal(taskId, 'task-1'); Object.assign(task, patch); return task; }
  };
  const now = () => Date.parse('2026-07-21T00:00:00.000Z');
  return {
    task,
    reconciler:new XiaodReconciler({
      store,
      xiaod:{ baseUrl:'http://127.0.0.1:4318', getJob },
      onFailure,
      contentWorkspaceDir,
      now,
    }),
  };
}

test('central reconciler settles a persisted running task after restart', async () => {
  const { task, reconciler } = setup({ getJob: async () => ({ id: 'xiaod-1', status: 'completed', title: '素材', output: { markdownPath: '/tmp/result.md', larkUrl: 'https://example.feishu.cn/docx/result', larkPermissionGranted: true }, quality: { passed: true } }) });
  await reconciler.reconcile();
  assert.equal(task.status, 'succeeded');
  assert.equal(task.execution.polling.state, 'settled');
  const delivery = task.artifactRefs.find((artifact) => artifact.type === 'xiaod_media_delivery');
  assert.equal(delivery.artifactId, 'xiaod-job:xiaod-1');
  assert.equal(delivery.data.larkPermissionGranted, true);
});

test('系统自动确认稿进入正式产物链，但不会标记为人工听审', async () => {
  const { task, reconciler } = setup({
    getJob:async () => ({
      id:'xiaod-1',
      status:'completed',
      title:'自动确认素材',
      output:{
        markdownPath:'/tmp/result.md',
        rawTranscriptPath:'/tmp/raw.txt',
        qualityReportPath:'/tmp/quality.json',
        confirmedTranscriptPath:'/tmp/confirmed.md',
        confirmationAttestationPath:'/tmp/automatic-confirmation.json',
        confirmedTranscriptChecksum:'checksum',
        confirmedTranscriptVersion:1,
        confirmationMode:'automatic',
        evidenceLevel:'untimed_machine_transcript'
      },
      quality:{ passed:true }
    })
  });
  await reconciler.reconcile();
  const confirmation = task.artifactRefs.find((artifact) => artifact.type === 'automatic_transcript_attestation');
  const transcript = task.artifactRefs.find((artifact) => artifact.type === 'confirmed_transcript');
  assert.equal(confirmation.validation.completeListen, false);
  assert.equal(transcript.validation.automaticConfirmed, true);
  assert.equal(transcript.validation.humanConfirmed, false);
  assert.deepEqual(transcript.sourceRefs, ['raw-transcript:xiaod-1', 'automatic-confirmation:xiaod-1:v1']);
});

test('小D已暂停时，A君保留已暂停状态并停止后续自动查询', async () => {
  const { task, reconciler } = setup({ getJob: async () => ({ id:'xiaod-1', status:'paused', progress:45 }) });
  await reconciler.reconcile();
  assert.equal(task.status, 'paused');
  assert.equal(task.execution.polling.state, 'settled');
  assert.equal(task.execution.polling.nextPollAt, null);
});

test('short Xiaod outages keep the task running and persist exponential backoff', async () => {
  const { task, reconciler } = setup({ getJob: async () => { throw new Error('connect ECONNREFUSED'); } });
  await reconciler.reconcile();
  assert.equal(task.status, 'running');
  assert.equal(task.currentStage, 'xiaod_status_retrying');
  assert.equal(task.execution.polling.state, 'backoff');
  assert.equal(task.execution.polling.consecutiveFailures, 1);
  assert.equal(task.execution.polling.nextPollAt, '2026-07-21T00:00:03.000Z');
  assert.equal(task.error.category, 'retryable');
});

test('Xiaod retryable failure is preserved on the parent task', async () => {
  let recoveryTask;
  const { task, reconciler } = setup({ getJob: async () => ({ id: 'xiaod-1', status: 'failed', error: '服务重启导致任务中断，请重试。', failure: { category: 'retryable', retryable: true, recovery: '请重试小D任务。' } }), onFailure: async (failed) => { recoveryTask = failed; } });
  await reconciler.reconcile();
  assert.equal(task.status, 'failed');
  assert.equal(task.error.category, 'retryable');
  assert.equal(task.error.retryable, true);
  assert.equal(task.error.userMessage, '请重试小D任务。');
  assert.equal(recoveryTask.taskId, 'task-1');
});

test('小D完成后把视觉证据包登记为受控产物', async () => {
  const { task, reconciler } = setup({
    getJob:async () => ({
      id:'xiaod-1',
      status:'completed',
      title:'视觉样片',
      output:{
        markdownPath:'/tmp/result.md',
        sourceEvidencePath:'/tmp/source.json',
        rawTranscriptPath:'/tmp/raw.vtt',
        qualityReportPath:'/tmp/quality.json',
        visualEvidencePath:'/tmp/visual-evidence.json',
        visualCoverage:{ status:'available', selectedFrames:12, storyboardCount:1 }
      },
      quality:{ passed:true }
    })
  });
  await reconciler.reconcile();
  const visual = task.artifactRefs.find((artifact) => artifact.type === 'visual_evidence_package');
  assert.equal(visual.location, 'file:///tmp/visual-evidence.json');
  assert.equal(visual.validation.sourceControlled, true);
  assert.equal(visual.validation.visualCoverage.selectedFrames, 12);
});

test('M5 素材阶段只在真实证据文件回读并哈希后生成 AssetPackage', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-assets-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const sourceEvidencePath = path.join(root, 'source.json');
  const visualEvidencePath = path.join(root, 'visual.json');
  const framesDir = path.join(root, 'frames');
  const contentWorkspaceDir = path.join(root, 'content-workspace');
  await fs.mkdir(framesDir);
  await fs.writeFile(path.join(framesDir, 'frame-001.png'), Buffer.from('fixture-png'));
  await fs.writeFile(sourceEvidencePath, JSON.stringify({ source:'https://example.com/video' }));
  await fs.writeFile(visualEvidencePath, JSON.stringify({
    schemaVersion:'agent.army/visual-evidence/v1',
    frames:[{
      frameId:'frame-001',
      timestamp:'00:00',
      localRef:'frames/frame-001.png',
    }],
  }));
  const { task, reconciler } = setup({
    taskPatch:{
      taskType:'content.campaign-assets',
      input:{
        sourceUrl:'https://example.com/video',
        context:{
          pipelineCaseId:'11111111-1111-4111-8111-111111111111',
          assetRightsBasis:'自产录屏，经活动授权用于内容生产。',
        },
      },
    },
    contentWorkspaceDir,
    getJob:async () => ({
      id:'xiaod-1',
      status:'completed',
      title:'M5 素材',
      output:{
        markdownPath:path.join(root, 'result.md'),
        sourceEvidencePath,
        visualEvidencePath,
        visualCoverage:{ status:'available', selectedFrames:1 },
      },
      quality:{ passed:true },
    }),
  });
  await reconciler.reconcile();
  const assetPackage = task.artifactRefs.find((artifact) => artifact.type === 'asset_package');
  assert.equal(task.status, 'succeeded');
  assert.equal(assetPackage.validation.sourceFilesReadBack, true);
  assert.equal(assetPackage.data.files.length, 2);
  assert.ok(assetPackage.data.files.every((file) => /^sha256:[0-9a-f]{64}$/.test(file.checksum)));
  assert.ok(assetPackage.data.files.every((file) => !('path' in file)));
  assert.equal(assetPackage.data.assets.length, 1);
  assert.equal(
    assetPackage.data.assets[0].relativePath,
    'campaigns/11111111-1111-4111-8111-111111111111/assets/frame-001.png',
  );
  assert.equal(assetPackage.data.coverSourcePath, assetPackage.data.assets[0].relativePath);
  assert.equal(
    await fs.readFile(path.join(contentWorkspaceDir, assetPackage.data.coverSourcePath), 'utf8'),
    'fixture-png',
  );
});

test('M5 素材阶段证据文件不可回读时失败闭锁', async () => {
  const { task, reconciler } = setup({
    taskPatch:{
      taskType:'content.campaign-assets',
      input:{ sourceUrl:'https://example.com/video' },
    },
    getJob:async () => ({
      id:'xiaod-1',
      status:'completed',
      title:'M5 空心素材',
      output:{
        markdownPath:'/tmp/result.md',
        sourceEvidencePath:'/not-found/source.json',
        visualEvidencePath:'/not-found/visual.json',
      },
      quality:{ passed:true },
    }),
  });
  await reconciler.reconcile();
  assert.equal(task.status, 'needs_input');
  assert.equal(task.error.code, 'm5_asset_file_unreadable');
  assert.equal(task.artifactRefs.length, 0);
});

test('必须分析画面但没有视频时，A君把小D失败映射为 needs_input', async () => {
  const { task, reconciler } = setup({
    getJob:async () => ({
      id:'xiaod-1',
      status:'failed',
      error:'没有取得可用于画面分析的视频。',
      failure:{
        category:'needs_input',
        retryable:false,
        recovery:'请补充本地视频、完成授权或改用自动模式。'
      }
    })
  });
  await reconciler.reconcile();
  assert.equal(task.status, 'needs_input');
  assert.equal(task.error.category, 'needs_input');
  assert.match(task.error.userMessage, /补充本地视频/);
});

test('恢复协调暂时失败时保留待处理记录，不覆盖原始业务失败', async () => {
  const { task, reconciler } = setup({ getJob: async () => ({ id: 'xiaod-1', status: 'failed', error: '任务失败。', failure: { category: 'manual', retryable: false } }), onFailure: async () => { throw new Error('恢复协调服务暂不可用'); } });
  await reconciler.reconcile();
  assert.equal(task.status, 'failed');
  assert.equal(task.error.code, 'xiaod_job_failed');
  assert.equal(task.recovery.coordination.status, 'pending');
  assert.match(task.recovery.coordination.reason, /暂不可用/);
});

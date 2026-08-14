import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { XiaodReconciler } from '../src/xiaod-reconciler.ts';
import { TaskLifecycleEventRecorder } from '../src/task-lifecycle-event-recorder.ts';

function setup({ taskPatch = {}, getJob, onFailure = null, contentWorkspaceDir = null, deliveryQuality = null, lifecycleEvents = null } = {}) {
  const task = {
    taskId: 'task-1', taskType:'media.transcribe-and-refine', status: 'running', currentStage: 'delegated_to_xiaod', artifactRefs: [],
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
      deliveryQuality,
      lifecycleEvents,
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

test('小D异步成功先扣留为质量复核并交给 DeliveryQualityRuntime 创建复核', async () => {
  const continued = [];
  const deliveryQuality = {
    async continue(task) {
      continued.push(structuredClone(task));
      task.deliveryQualityRuntime = {
        status:'review_pending',
        reviewTaskId:'review-task-1',
      };
      return task;
    },
  };
  const { task, reconciler } = setup({
    taskPatch:{
      qualityTier:'important',
      input:{ title:'团队正式素材整理', usageScenario:'发给团队直接使用', sourceUrl:'https://example.com/video', qualityTier:'important' },
      deliveryBrief:{
        readiness:'ready', purpose:'整理正式素材', audience:'团队', usageScenario:'正式使用',
        deliverables:['完整整理稿'], acceptanceCriteria:['内容完整且可读'], constraints:[],
      },
    },
    deliveryQuality,
    getJob:async () => ({
      id:'xiaod-1', status:'completed', title:'正式素材',
      output:{ markdownPath:'/tmp/result.md', larkUrl:'https://example.feishu.cn/docx/result', larkPermissionGranted:true },
      quality:{ passed:true },
    }),
  });

  await reconciler.reconcile();

  assert.equal(continued.length, 1);
  assert.equal(continued[0].status, 'running');
  assert.equal(continued[0].currentStage, 'delivery_quality_review_pending');
  assert.equal(continued[0].deliveryQuality.action, 'request_review');
  assert.equal(continued[0].deliveryQuality.reviewTaskRequest.taskType, 'governance.assurance-review');
  assert.equal(task.status, 'running');
  assert.equal(task.deliveryQualityRuntime.reviewTaskId, 'review-task-1');
});

test('小D异步结果持久化后写统一工作流事件且重复轮询不重复', async () => {
  const events = new Map();
  const lifecycleEvents = new TaskLifecycleEventRecorder({ eventStore:{
    appendTaskRunEvent(event) {
      if (events.has(event.eventId)) {
        throw Object.assign(new Error('duplicate'), { code:'task_run_event_exists' });
      }
      events.set(event.eventId, structuredClone(event));
    },
  } });
  const { reconciler } = setup({
    lifecycleEvents,
    getJob:async () => ({
      id:'xiaod-1', status:'completed', title:'素材',
      output:{ markdownPath:'/tmp/result.md', larkUrl:'https://example.feishu.cn/docx/result', larkPermissionGranted:true },
      quality:{ passed:true },
    }),
  });

  await reconciler.reconcile();
  await reconciler.reconcile();

  const recorded = [...events.values()];
  assert.equal(recorded.filter((event) => event.eventType === 'workflow_completed').length, 1);
  assert.equal(recorded.filter((event) => event.eventType === 'artifact_committed').length, 1);
});

test('小D下游标记完成但飞书交付权限未确认时转为待测试', async () => {
  const { task, reconciler } = setup({
    getJob:async () => ({
      id:'xiaod-1',
      status:'completed',
      title:'未确认交付',
      output:{ markdownPath:'/tmp/result.md', larkUrl:'https://example.feishu.cn/docx/result', larkPermissionGranted:false },
      quality:{ passed:true },
    }),
  });

  await reconciler.reconcile();

  assert.equal(task.status, 'waiting_test');
  assert.equal(task.currentStage, 'completion_evidence_invalid');
  assert.equal(task.error.code, 'completion_evidence_invalid');
});

test('小D等待飞书配置时A君停止伪装处理中，并给出可执行恢复口令', async () => {
  const { task, reconciler } = setup({
    getJob:async () => ({
      id:'xiaod-1', status:'awaiting_delivery', progress:92,
      output:{ markdownPath:'/tmp/result.md', larkDelivery:{ state:'failed_before_create', safeToRetry:true } }
    })
  });
  await reconciler.reconcile();
  assert.equal(task.status, 'needs_input');
  assert.equal(task.currentStage, 'xiaod_awaiting_delivery');
  assert.equal(task.execution.polling.state, 'settled');
  assert.equal(task.error.code, 'xiaod_delivery_pending');
  assert.match(task.error.userMessage, /继续飞书交付/);
});

test('小D飞书交付结果不确定时A君禁止自动重试并要求人工仲裁', async () => {
  const { task, reconciler } = setup({
    getJob:async () => ({
      id:'xiaod-1', status:'awaiting_delivery', progress:92, error:'provider response lost',
      failure:{ category:'manual', retryable:false },
      output:{ markdownPath:'/tmp/result.md', larkDelivery:{ state:'uncertain', safeToRetry:false } }
    })
  });
  await reconciler.reconcile();
  assert.equal(task.status, 'needs_input');
  assert.equal(task.execution.polling.state, 'settled');
  assert.equal(task.error.code, 'xiaod_delivery_uncertain');
  assert.equal(task.error.retryable, false);
  assert.match(task.error.userMessage, /不要重试/);
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

test('AI 初稿人工补正后，A君登记最新版本但不冒充完整人工听审', async () => {
  const { task, reconciler } = setup({
    getJob:async () => ({
      id:'xiaod-1',
      status:'completed',
      title:'补正素材',
      output:{
        markdownPath:'/tmp/result-v2.md',
        rawTranscriptPath:'/tmp/raw.txt',
        qualityReportPath:'/tmp/quality.json',
        confirmedTranscriptPath:'/tmp/confirmed-v2.md',
        confirmationAttestationPath:'/tmp/automatic-confirmation-v2.json',
        confirmedTranscriptChecksum:'checksum-v2',
        confirmedTranscriptVersion:2,
        confirmationMode:'automatic',
        evidenceLevel:'timed_machine_transcript',
        transcriptCorrection:{ applied:true, basedOnVersion:1 },
      },
      quality:{ passed:true },
    }),
  });
  await reconciler.reconcile();
  const confirmation = task.artifactRefs.find((artifact) => artifact.type === 'automatic_transcript_attestation');
  const transcript = task.artifactRefs.find((artifact) => artifact.type === 'confirmed_transcript');
  assert.match(confirmation.title, /人工补正记录/);
  assert.equal(confirmation.validation.completeListen, false);
  assert.equal(confirmation.validation.correctionApplied, true);
  assert.equal(transcript.artifactId, 'confirmed-transcript:xiaod-1:v2');
  assert.match(transcript.title, /AI 初稿人工补正版/);
  assert.equal(transcript.validation.humanConfirmed, false);
  assert.equal(transcript.validation.automaticConfirmed, true);
  assert.equal(transcript.validation.transcriptVersion, 2);
  assert.deepEqual(transcript.data, {
    confirmationMode:'automatic',
    correctionApplied:true,
    transcriptVersion:2,
    basedOnVersion:1,
  });
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

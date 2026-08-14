import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalVisualEvidenceAdapter, visualEvidenceQualityResult } from '../src/visual-capability-adapter.ts';
import { MediaPipeline } from '../src/pipeline.ts';

const checksum = `sha256:${'a'.repeat(64)}`;

test('本地视觉证据实现 CapabilityAdapter 且返回质量结果', async () => {
  const calls = [];
  const adapter = createLocalVisualEvidenceAdapter({
    createPackage:async (input) => {
      calls.push(input);
      return {
        manifestPath:'/controlled/visual-evidence.json',
        framePaths:['/controlled/frame.jpg'],
        storyboardPaths:['/controlled/storyboard.jpg'],
        payload:{
          durationSeconds:60,
          frames:[{ checksum }],
          storyboards:[{ checksum }],
          coverage:{ status:'available' }
        }
      };
    }
  });
  const result = await adapter.invoke({ payload:{ videoPath:'/controlled/video.mp4', outputDir:'/controlled/out', depth:'fast' } });
  assert.equal(adapter.adapterId, 'xiaod.local-visual-evidence');
  assert.equal(result.provider, 'local-ffmpeg');
  assert.equal(result.costUsd, 0);
  assert.equal(result.output.qualityResult.passed, true);
  assert.equal(result.usage.selectedFrames, 1);
  assert.equal(calls[0].videoPath, '/controlled/video.mp4');
});

test('视觉证据质量门缺帧或故事板时失败关闭', () => {
  const result = visualEvidenceQualityResult({ coverage:{ status:'unavailable' }, frames:[], storyboards:[] });
  assert.equal(result.passed, false);
  assert.deepEqual(result.reasons, [
    'visual_coverage_unavailable',
    'visual_frames_empty',
    'visual_storyboard_missing'
  ]);
});

test('媒体流水线通过视觉 CapabilityAdapter 生成证据并输出质量事件', async () => {
  const job = { id:'job-visual-pipeline', visualMode:'auto', analysisDepth:'full', sourceType:'upload', status:'transcribing', output:null };
  const calls = [];
  const events = [];
  const store = {
    get() { return job; },
    async update(_id, patch) { Object.assign(job, patch); return job; }
  };
  const visualAdapter = {
    adapterId:'fixture.visual',
    async invoke(input) {
      calls.push(input);
      return {
        provider:'local-ffmpeg', costUsd:0,
        output:{
          manifestPath:'/controlled/visual-evidence.json',
          payload:{
            frames:[{ checksum }],
            storyboards:[{ checksum }],
            selection:{ maxFrames:12 },
            coverage:{ status:'available' }
          },
          qualityResult:{ status:'passed', passed:true, reasons:[] }
        }
      };
    }
  };
  const pipeline = new MediaPipeline({
    store,
    workDir:'/controlled',
    asrRuntime:{},
    visualAdapter,
    onRunEvent:(event) => events.push(event)
  });
  const visual = await pipeline.prepareVisualEvidence({
    job,
    jobDir:'/controlled/job',
    acquired:{ visualSourcePath:'/controlled/video.mp4' },
    segments:[{ start:0, end:1, text:'片段' }],
    sourceMetadata:{ title:'fixture' }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.videoPath, '/controlled/video.mp4');
  assert.equal(visual.qualityResult.status, 'passed');
  assert.deepEqual(events.map((event) => event.eventType), ['capability_call_succeeded', 'quality_check_completed']);
});

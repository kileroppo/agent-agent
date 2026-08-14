import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { config } from '../src/config.ts';
import { AdaptiveAsrRuntime } from '../src/adaptive-asr-runtime.ts';

const confidentPayload = {
  text:'这是清晰完整的应急转录正文，质量模型暂时不可用，因此必须等待人工完整听审。',
  language:'zh',
  languageProbability:0.98,
  durationSeconds:90,
  durationAfterVadSeconds:88,
  segments:[{
    start:0,
    end:88,
    text:'这是清晰完整的应急转录正文，质量模型暂时不可用，因此必须等待人工完整听审。',
    avg_logprob:-0.2,
    no_speech_prob:0.03,
    compression_ratio:1.1,
    words:[
      { start:0, end:20, word:'这是清晰完整的应急转录正文', probability:0.95 },
      { start:20, end:50, word:'质量模型暂时不可用', probability:0.94 },
      { start:50, end:88, word:'因此必须等待人工完整听审', probability:0.96 }
    ]
  }]
};

test('质量模型失败时普通任务可降级 faster-whisper，但路由强制人工复核', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaod-asr-fallback-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const modelRoot = path.join(root, 'model');
  await fs.mkdir(modelRoot);
  await fs.writeFile(path.join(modelRoot, 'model.bin'), 'fixture');
  const script = path.join(root, 'fast.py');
  await fs.writeFile(script, '# fixture');
  const runEvents = [];
  const runtime = new AdaptiveAsrRuntime({
    onRunEvent:(event) => runEvents.push(event),
    settings:{
      ...config,
      adaptiveAsr:{
        ...config.adaptiveAsr,
        enabled:true,
        progressiveFastEnabled:false,
        fastPython:process.execPath,
        fastScript:script,
        fastModelRoot:modelRoot,
        fastMaxDurationSeconds:1800
      }
    }
  });
  runtime.transcribeQuality = async () => { throw new Error('quality unavailable'); };
  runtime.transcribeFast = async () => confidentPayload;
  const result = await runtime.transcribe(path.join(root, 'input.wav'), root, {
    job:{ reviewPolicy:'optional', analysisDepth:'fast', visualMode:'off' },
    durationSeconds:90
  });
  assert.equal(result.routing.selectedProvider, 'faster-whisper');
  assert.equal(result.routing.fallbackFrom, 'mlx-whisper');
  assert.equal(result.routing.requiresHumanReview, true);
  assert.equal(result.routing.fastCandidate.accepted, true);
  assert.equal(typeof result.routing.fastCandidate.accepted, 'boolean');
  assert.equal(result.routing.executionReceipt.schemaVersion, 'agent.army/execution-receipt/v2');
  assert.equal(result.routing.executionReceipt.routeId, 'audio.transcribe.faster-whisper');
  assert.equal(result.routing.executionReceipt.fallbackFrom, 'audio.transcribe.mlx-whisper');
  assert.equal(result.routing.executionReceipt.totalAttempts, 2);
  assert.equal(result.routing.qualityResult.status, 'review_required');
  assert.deepEqual(runEvents.filter((event) => event.eventType.startsWith('capability_call_')).map((event) => [event.attempt, event.status]), [
    [1, 'confirmed_failure'],
    [2, 'success']
  ]);
  assert.equal(runEvents.at(-1).eventType, 'quality_check_completed');
  assert.match(await fs.readFile(path.join(root, 'transcript.txt'), 'utf8'), /应急转录正文/);
});

test('正式任务的质量模型失败时不允许用小模型冒充完成', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaod-asr-no-formal-fallback-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const runEvents = [];
  const runtime = new AdaptiveAsrRuntime({ onRunEvent:(event) => runEvents.push(event) });
  runtime.transcribeQuality = async () => { throw new Error('quality unavailable'); };
  runtime.transcribeFast = async () => confidentPayload;
  await assert.rejects(
    runtime.transcribe(path.join(root, 'input.wav'), root, {
      job:{ reviewPolicy:'required', analysisDepth:'full', visualMode:'required' },
      durationSeconds:90
    }),
    (error) => {
      assert.match(error.message, /quality unavailable/);
      assert.equal(error.executionReceipt.schemaVersion, 'agent.army/execution-receipt/v2');
      assert.equal(error.executionReceipt.routeAttempts.length, 1);
      assert.equal(error.executionReceipt.routeAttempts[0].routeId, 'audio.transcribe.mlx-whisper');
      assert.equal(error.executionReceipt.outcome, 'confirmed_failure');
      return true;
    }
  );
  assert.equal(runEvents.find((event) => event.eventType === 'capability_call_failed')?.status, 'confirmed_failure');
});

test('策略选中 StepFun 时只调用一次 StepAudio，不静默改投本机', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaod-stepfun-asr-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const input = path.join(root, 'input.wav');
  await fs.writeFile(input, 'fixture');
  let providerCalls = 0;
  let localCalls = 0;
  const runtime = new AdaptiveAsrRuntime({
    stepfunAsr:{
      async transcribe() {
        providerCalls += 1;
        return { text:'这是 StepAudio 返回的完整转录正文，用于验证显式服务商路线不会跨服务商重复提交。', timed:null, segments:[], usage:{ input_tokens:20, output_tokens:10 } };
      },
    },
  });
  runtime.transcribeQuality = async () => { localCalls += 1; throw new Error('不应调用'); };
  const result = await runtime.transcribe(input, root, {
    job:{ asrProvider:'stepfun', reviewPolicy:'optional', analysisDepth:'fast', visualMode:'off' },
    durationSeconds:30,
  });
  assert.equal(providerCalls, 1);
  assert.equal(localCalls, 0);
  assert.equal(result.routing.selectedProvider, 'stepfun');
  assert.equal(result.routing.selectedModel, 'stepaudio-2.5-asr');
  assert.equal(result.routing.executionReceipt.routeId, 'audio.transcribe.stepfun');
  assert.equal(result.routing.executionReceipt.costUsd, null);
  assert.equal(result.routing.executionReceipt.billingStatus, 'subscription_included');
  assert.equal(result.routing.executionReceipt.apiCalls, 1);
});

test('StepFun 调用结果不确定时保留 ambiguous 回执，不自动重试或改投本机', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaod-stepfun-asr-ambiguous-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const input = path.join(root, 'input.wav');
  await fs.writeFile(input, 'fixture');
  let providerCalls = 0;
  let localCalls = 0;
  const runtime = new AdaptiveAsrRuntime({
    stepfunAsr:{
      async transcribe() {
        providerCalls += 1;
        throw Object.assign(new Error('provider response interrupted'), { code:'stepfun_asr_ambiguous' });
      },
    },
  });
  runtime.transcribeQuality = async () => { localCalls += 1; throw new Error('不应调用'); };
  await assert.rejects(
    runtime.transcribe(input, root, {
      job:{ asrProvider:'stepfun', reviewPolicy:'optional', analysisDepth:'fast', visualMode:'off' },
      durationSeconds:30,
    }),
    (error) => {
      assert.equal(error.executionReceipt.outcome, 'ambiguous');
      assert.equal(error.executionReceipt.routeAttempts[0].outcome, 'ambiguous');
      assert.equal(error.executionReceipt.failureCode, 'stepfun_asr_ambiguous');
      assert.equal(error.executionReceipt.apiCalls, 1);
      return true;
    },
  );
  assert.equal(providerCalls, 1);
  assert.equal(localCalls, 0);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  asrQualityResult,
  attachAsrCapabilityResult,
  attachAsrFailureReceipt
} from '../src/asr-capability-adapter.ts';

const job = { id:'job-1', sourceType:'upload', workflowId:'workflow-1', stepId:'step-1' };

test('字幕路线输出 ExecutionReceipt v2 且不保存原始正文', () => {
  const routing = { selectedProvider:'source-subtitle', selectedModel:null, fallbackFrom:null, durationSeconds:null };
  const result = attachAsrCapabilityResult({
    job,
    routing,
    payload:{ text:'这是一段只用于哈希的字幕正文。', timed:null },
    startedAt:'2026-08-13T00:00:00.000Z',
    completedAt:'2026-08-13T00:00:01.000Z'
  });
  assert.equal(result.executionReceipt.schemaVersion, 'agent.army/execution-receipt/v2');
  assert.equal(result.executionReceipt.routeId, 'audio.transcribe.source-subtitle');
  assert.equal(result.executionReceipt.outcome, 'success');
  assert.match(result.executionReceipt.inputHash, /^sha256:[a-f0-9]{64}$/);
  assert.match(result.executionReceipt.outputHash, /^sha256:[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(result.executionReceipt), /只用于哈希/);
  assert.equal(result.qualityResult.passed, true);
});

test('同一任务的不同输入形成不同输入哈希', () => {
  const routing = { selectedProvider:'source-subtitle', selectedModel:null };
  const left = attachAsrCapabilityResult({ job, routing, input:{ subtitleText:'第一份字幕' }, payload:{ text:'相同输出' } });
  const right = attachAsrCapabilityResult({ job, routing, input:{ subtitleText:'第二份字幕' }, payload:{ text:'相同输出' } });
  assert.notEqual(left.executionReceipt.inputHash, right.executionReceipt.inputHash);
  assert.equal(left.executionReceipt.outputHash, right.executionReceipt.outputHash);
});

test('A君委派任务的 ASR 回执使用军团任务编号关联统一时间线', () => {
  const result = attachAsrCapabilityResult({
    job:{ ...job, agentArmyTaskId:'army-task-123' },
    routing:{ selectedProvider:'source-subtitle' },
    payload:{ text:'足够长的字幕正文用于关联验证。' },
  });
  assert.equal(result.executionReceipt.taskId, 'army-task-123');
});

test('质量模型失败后的快速路线回执保留 Plan B 来源并要求人工复核', () => {
  const routing = {
    selectedProvider:'faster-whisper',
    selectedModel:'Systran/faster-whisper-small',
    fallbackFrom:'mlx-whisper',
    durationSeconds:90,
    requiresHumanReview:true,
    fastCandidate:{ attempted:true, evaluation:{ accepted:true, qualitySignals:{ meanWordProbability:0.95 } } }
  };
  const result = attachAsrCapabilityResult({
    job,
    routing,
    payload:{ text:'这是已经通过快速模型自身质量门的应急机器稿，但仍需要人工完整听审。' }
  });
  assert.equal(result.executionReceipt.fallbackFrom, 'audio.transcribe.mlx-whisper');
  assert.equal(result.executionReceipt.routeAttempts.length, 2);
  assert.deepEqual(result.executionReceipt.routeAttempts.map((item) => item.outcome), ['confirmed_failure', 'success']);
  assert.equal(result.executionReceipt.totalAttempts, 2);
  assert.equal(result.executionReceipt.recovered, false);
  assert.equal(result.qualityResult.status, 'review_required');
  assert.deepEqual(result.qualityResult.reasons, ['human_review_required']);
});

test('确定失败附带可排查失败回执且不伪造输出哈希', () => {
  const error = attachAsrFailureReceipt(Object.assign(new Error('mlx_whisper 无法启动：ENOENT'), { code:'startup_failure' }), {
    job,
    routing:{ selectedProvider:'mlx-whisper', selectedModel:'large-v3' },
    startedAt:'2026-08-13T00:00:00.000Z'
  });
  assert.equal(error.executionReceipt.outcome, 'confirmed_failure');
  assert.equal(error.executionReceipt.failureCode, 'startup_failure');
  assert.equal(error.executionReceipt.outputHash, null);
  assert.equal(error.executionReceipt.routeId, 'audio.transcribe.mlx-whisper');
});

test('快速质量结果缺少通过证据时失败关闭', () => {
  const result = asrQualityResult({
    routing:{ selectedProvider:'faster-whisper', fastCandidate:{ evaluation:null } },
    payload:{ text:'无置信信息稿' }
  });
  assert.equal(result.passed, false);
  assert.deepEqual(result.reasons, ['transcript_too_short', 'fast_quality_not_accepted']);
});

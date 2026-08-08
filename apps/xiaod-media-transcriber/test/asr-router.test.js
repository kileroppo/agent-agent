import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildQualityProbeIntervals,
  compareTranscriptProbe,
  evaluateFastTranscript,
  allowsFastFallback,
  selectInitialAsrRoute,
  summarizeAsrQuality
} from '../src/asr-router.js';

const confidentSegments = [
  {
    start:0,
    end:8,
    text:'这是一个清晰、简短并且内容完整的测试转录。',
    avg_logprob:-0.25,
    no_speech_prob:0.03,
    compression_ratio:1.15,
    words:[
      { start:0, end:2, word:'这是一个', probability:0.94 },
      { start:2, end:5, word:'清晰简短', probability:0.91 },
      { start:5, end:8, word:'测试转录', probability:0.9 }
    ]
  }
];

test('普通任务只把短中素材送入快速候选，最终采用仍需质量判断', () => {
  assert.deepEqual(selectInitialAsrRoute({
    job:{ reviewPolicy:'optional', analysisDepth:'fast', visualMode:'off' },
    durationSeconds:180,
    fastRuntimeAvailable:true,
    progressiveFastEnabled:true,
    fastMaxDurationSeconds:1800
  }), {
    route:'fast_candidate',
    reasons:['progressive_fast_candidate']
  });
});

test('正式听审、完整分析和超长素材直接使用质量模型', () => {
  assert.equal(selectInitialAsrRoute({
    job:{ reviewPolicy:'required', analysisDepth:'fast', visualMode:'off' },
    durationSeconds:60,
    fastRuntimeAvailable:true,
    progressiveFastEnabled:true
  }).route, 'quality_direct');
  assert.equal(selectInitialAsrRoute({
    job:{ reviewPolicy:'optional', analysisDepth:'full', visualMode:'off' },
    durationSeconds:60,
    fastRuntimeAvailable:true,
    progressiveFastEnabled:true
  }).route, 'quality_direct');
  assert.equal(selectInitialAsrRoute({
    job:{ reviewPolicy:'optional', analysisDepth:'fast', visualMode:'off' },
    durationSeconds:3601,
    fastRuntimeAvailable:true,
    progressiveFastEnabled:true,
    fastMaxDurationSeconds:1800
  }).route, 'quality_direct');
  assert.equal(selectInitialAsrRoute({
    job:{ reviewPolicy:'optional', analysisDepth:'fast', visualMode:'off' },
    durationSeconds:30,
    fastRuntimeAvailable:true,
    progressiveFastEnabled:true,
    fastMinDurationSeconds:60
  }).reasons[0], 'quality_model_faster_for_short_audio');
});

test('当前 Mac 基准显示质量模型更快时，不为使用快模型而绕远', () => {
  assert.deepEqual(selectInitialAsrRoute({
    job:{ reviewPolicy:'optional', analysisDepth:'fast', visualMode:'off' },
    durationSeconds:180,
    fastRuntimeAvailable:true,
    progressiveFastEnabled:false
  }), {
    route:'quality_direct',
    reasons:['quality_provider_locally_faster']
  });
});

test('快速运行时不可用时无感回退质量模型', () => {
  assert.deepEqual(selectInitialAsrRoute({
    job:{ reviewPolicy:'optional', analysisDepth:'fast', visualMode:'off' },
    durationSeconds:60,
    fastRuntimeAvailable:false
  }), {
    route:'quality_direct',
    reasons:['fast_runtime_unavailable']
  });
});

test('快速稿只有真实置信与完整性信号全部通过才被采用', () => {
  const result = evaluateFastTranscript({
    text:'这是一个清晰、简短并且内容完整的测试转录。',
    segments:confidentSegments,
    language:'zh',
    languageProbability:0.97,
    durationSeconds:10,
    durationAfterVadSeconds:8.5
  });
  assert.equal(result.accepted, true);
  assert.deepEqual(result.reasons, []);
  assert.ok(result.qualitySignals.meanWordProbability > 0.9);
  assert.ok(result.qualitySignals.meanAvgLogprob > -0.3);
});

test('低置信、重复文本或缺少时间段会自动升级大模型', () => {
  const result = evaluateFastTranscript({
    text:'错错错错错错错错错错错错错错错错错错错错',
    segments:[{
      ...confidentSegments[0],
      avg_logprob:-1.2,
      no_speech_prob:0.8,
      compression_ratio:2.8,
      words:[{ start:0, end:8, word:'错', probability:0.42 }]
    }],
    language:'zh',
    languageProbability:0.62,
    durationSeconds:10,
    durationAfterVadSeconds:8
  });
  assert.equal(result.accepted, false);
  assert.ok(result.reasons.includes('low_language_probability'));
  assert.ok(result.reasons.includes('low_word_probability'));
  assert.ok(result.reasons.includes('low_segment_logprob'));
  assert.ok(result.reasons.includes('high_no_speech_ratio'));
  assert.ok(result.reasons.includes('high_compression_ratio'));
  assert.ok(result.reasons.includes('repeated_character_run'));
});

test('质量信号汇总兼容 mlx-whisper 与 faster-whisper 的段落 JSON', () => {
  const signals = summarizeAsrQuality(confidentSegments);
  assert.equal(signals.segmentCount, 1);
  assert.equal(signals.wordCount, 3);
  assert.equal(signals.maxCompressionRatio, 1.15);
});

test('质量模型抽查开头中段结尾，与快速稿一致才允许采用', () => {
  const intervals = buildQualityProbeIntervals(600, 15);
  assert.deepEqual(intervals, [[0, 15], [292.5, 307.5], [585, 600]]);
  const fastSegments = [
    { start:0, end:15, text:'今天介绍智能转录路由。' },
    { start:292.5, end:307.5, text:'中间部分说明质量门禁。' },
    { start:585, end:600, text:'最后总结自动升级策略。' }
  ];
  const accepted = compareTranscriptProbe({
    fastSegments,
    probeText:'今天介绍智能转录路由。中间部分说明质量门禁。最后总结自动升级策略。',
    intervals
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.similarity, 1);
  const rejected = compareTranscriptProbe({
    fastSegments,
    probeText:'今天介绍普通下载工具。中间部分没有提到质量。最后直接结束。',
    intervals
  });
  assert.equal(rejected.accepted, false);
  assert.ok(rejected.similarity < rejected.threshold);
});

test('质量模型故障时只允许普通任务降级到快模型并转人工', () => {
  assert.equal(allowsFastFallback({
    job:{ reviewPolicy:'optional', analysisDepth:'fast', visualMode:'off' },
    durationSeconds:300,
    fastRuntimeAvailable:true,
    fastMaxDurationSeconds:1800
  }), true);
  assert.equal(allowsFastFallback({
    job:{ reviewPolicy:'required', analysisDepth:'fast', visualMode:'off' },
    durationSeconds:300,
    fastRuntimeAvailable:true
  }), false);
  assert.equal(allowsFastFallback({
    job:{ reviewPolicy:'optional', analysisDepth:'full', visualMode:'off' },
    durationSeconds:300,
    fastRuntimeAvailable:true
  }), false);
});

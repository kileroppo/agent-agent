import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { automaticConfirmationDecision, buildEvidenceRecords, parseTimedTranscript, sha256, timedTranscriptMarkdown } from '../src/transcript-evidence.js';
import { createTranscriptConfirmationFiles, reviewTranscript } from '../src/transcript-review.js';
import { JobStore } from '../src/store.js';
import { makeJob } from '../src/domain.js';

test('字幕解析保留可核验时间点并生成机器质量报告', () => {
  const raw = 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n开场钩子\n\n00:00:02.000 --> 00:00:05.000\n核心观点';
  const segments = parseTimedTranscript(raw, { kind:'subtitle' });
  assert.equal(segments.length, 2);
  assert.equal(segments[1].timestamp, '00:02');
  assert.match(timedTranscriptMarkdown('样片', segments), /\[00:02\] 核心观点/);
  const evidence = buildEvidenceRecords({
    sourceType:'url',
    sourceUrl:'https://example.com/watch?v=1&token=secret',
    contentPackage:{
      provider:'youtube',
      sourceRef:'https://example.com/watch',
      contentItems:{
        basic_content:{
          title:'真实原标题',
          author:'真实作者',
          durationSeconds:5,
          sourceUrl:'https://example.com/watch'
        }
      }
    },
    rawTranscript:raw,
    cleanTranscript:'开场钩子\n核心观点',
    segments,
    mediaDurationSeconds:5
  });
  assert.equal(evidence.sourceEvidence.sourceRef, 'https://example.com/watch');
  assert.deepEqual(evidence.sourceEvidence.sourceMetadata, {
    title:'真实原标题',
    author:'真实作者',
    platform:'youtube',
    durationSeconds:5,
    canonicalUrl:'https://example.com/watch'
  });
  assert.equal(evidence.qualityReport.passed, true);
  assert.equal(evidence.qualityReport.evidenceLevel, 'timed_machine_transcript');
});

test('音频覆盖和尾部完整性属于不能人工绕过的硬门禁', () => {
  const evidence = buildEvidenceRecords({
    sourceType:'upload',
    rawTranscript:'有效内容',
    cleanTranscript:'有效内容',
    segments:[{ startSeconds:0, endSeconds:8, timestamp:'00:00', text:'有效内容' }],
    mediaDurationSeconds:10,
    audioDurationSeconds:9
  });
  assert.deepEqual(evidence.qualityReport.hardFailures, [
    'audio_coverage_below_99_9_percent',
    'transcript_tail_gap_over_1_second'
  ]);
});

test('平台整数时长与本机探测相差不到一秒时使用精确时长，避免误报覆盖不足', async () => {
  const { qualityGateDuration } = await import('../src/pipeline.js');
  assert.equal(qualityGateDuration({
    reportedDurationSeconds:364,
    probedAudioDurationSeconds:363.178688
  }), 363.178688);
  assert.equal(qualityGateDuration({
    reportedDurationSeconds:364,
    probedAudioDurationSeconds:360
  }), 364);
});

test('质量门禁通过时默认生成系统确认稿，不冒充人工完整听审', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaod-auto-confirm-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const qualityReport = {
    passed:true,
    hardFailures:[],
    anomalies:[],
    evidenceLevel:'untimed_machine_transcript'
  };
  const transcript = '这是质量门禁通过的机器转录正文。系统可以自动确认，但不能声称已经有人完整听过。';
  const decision = automaticConfirmationDecision({ qualityReport, transcript });
  assert.equal(decision.eligible, true);
  const confirmation = await createTranscriptConfirmationFiles({
    directory:root,
    jobId:'auto-job',
    title:'自动确认样片',
    transcript,
    machineChecksum:sha256(transcript),
    confirmationMode:'automatic',
    confirmerRef:'xiaod-quality-gate',
    confirmedAt:'2026-07-28T00:00:00.000Z'
  });
  assert.equal(confirmation.confirmationMode, 'automatic');
  const markdown = await fs.readFile(confirmation.confirmedTranscriptPath, 'utf8');
  assert.match(markdown, /confirmationMode: automatic/);
  assert.match(markdown, /completeListen: false/);
  assert.match(markdown, /系统确认稿/);
  const attestation = JSON.parse(await fs.readFile(confirmation.confirmationAttestationPath, 'utf8'));
  assert.equal(attestation.completeListen, false);
  assert.equal(attestation.confirmationMode, 'automatic');
  assert.equal((await fs.stat(confirmation.confirmedTranscriptPath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(confirmation.confirmationAttestationPath)).mode & 0o777, 0o600);
});

test('转录异常时自动确认停止并转人工，不绕过质量问题', () => {
  const decision = automaticConfirmationDecision({
    qualityReport:{
      passed:true,
      hardFailures:[],
      anomalies:['repeated_character_run'],
      evidenceLevel:'untimed_machine_transcript'
    },
    transcript:'这是有异常异常异常异常异常异常异常异常异常异常异常异常异常的机器稿。'
  });
  assert.equal(decision.eligible, false);
  assert.deepEqual(decision.reasons, ['transcript_anomaly:repeated_character_run']);
});

test('ASR 语义置信信号异常时不能自动确认，即使音频覆盖完整', () => {
  const evidence = buildEvidenceRecords({
    sourceType:'upload',
    rawTranscript:'宇宙套发射以后就能解决所有问题。',
    cleanTranscript:'宇宙套发射以后就能解决所有问题。',
    segments:[{ startSeconds:0, endSeconds:4, timestamp:'00:00', text:'宇宙套发射以后就能解决所有问题。' }],
    mediaDurationSeconds:4,
    audioDurationSeconds:4,
    transcriptionQuality:{
      meanWordProbability:0.51,
      meanAvgLogprob:-1.1,
      highNoSpeechSegmentRatio:0,
      maxCompressionRatio:1.2
    }
  });
  assert.equal(evidence.qualityReport.passed, true);
  assert.equal(evidence.qualityReport.confidenceAvailable, true);
  assert.ok(evidence.qualityReport.anomalies.includes('low_mean_word_probability'));
  assert.equal(automaticConfirmationDecision({ qualityReport:evidence.qualityReport, transcript:'宇宙套发射以后就能解决所有问题。' }).eligible, false);
});

test('人工完整听审生成独立确认稿和校验值，重复确认幂等', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaod-review-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const store = new JobStore(root);
  await store.init();
  const job = await store.create(makeJob({ sourceType:'upload', originalName:'样片.mp4', reviewPolicy:'required' }));
  const jobDir = path.join(root, 'jobs', job.id);
  await fs.mkdir(jobDir, { recursive:true });
  const transcriptPath = path.join(jobDir, 'transcript-timed.md');
  const qualityReportPath = path.join(jobDir, 'quality.json');
  const guidePath = path.join(jobDir, 'guide.md');
  const originalMarkdownPath = path.join(jobDir, 'draft.md');
  await fs.writeFile(transcriptPath, '# 样片\n\n[00:00] 这是已经完整听审的测试转录正文。');
  await fs.writeFile(qualityReportPath, JSON.stringify({ hardFailures:[] }));
  await fs.writeFile(guidePath, '## 概述\n\n这是忠实的内容导览。');
  await fs.writeFile(originalMarkdownPath, '# 样片\n\n## 完整校对文本\n\n机器稿。');
  const awaiting = await store.update(job.id, {
    status:'awaiting_review',
    output:{ timedTranscriptPath:transcriptPath, transcriptPath, qualityReportPath, guidePath, markdownPath:originalMarkdownPath, transcriptChecksum:sha256('机器稿'), reviewStatus:'awaiting_review' }
  });
  let deliveredMarkdown = null;
  const delivery = { deliver:async ({ markdown }) => {
    deliveredMarkdown = markdown;
    return { configured:true, url:'https://feishu.cn/docx/reviewed', permissionGranted:true };
  } };
  const correctedTranscript = '这是已经由人工完整听审并修正后的测试转录正文，飞书只能收到这一版。';
  const first = await reviewTranscript({
    store, job:awaiting, delivery,
    input:{ decision:'confirm', completeListen:true, reviewerRef:'owner', correctedTranscript }
  });
  assert.equal(first.job.output.reviewStatus, 'confirmed');
  assert.equal(first.job.output.confirmationMode, 'human');
  assert.equal(first.job.output.confirmedTranscriptChecksum.length, 64);
  assert.equal(first.job.status, 'completed');
  assert.equal(first.job.output.larkUrl, 'https://feishu.cn/docx/reviewed');
  assert.match(deliveredMarkdown, /人工完整听审并修正后/);
  assert.doesNotMatch(deliveredMarkdown, /机器稿。/);
  assert.equal(await fs.readFile(first.job.output.markdownPath, 'utf8'), deliveredMarkdown);
  assert.match(await fs.readFile(first.job.output.confirmedTranscriptPath, 'utf8'), /completeListen: true/);
  const second = await reviewTranscript({ store, job:first.job, delivery, input:{ decision:'confirm', completeListen:true, reviewerRef:'owner' } });
  assert.equal(second.duplicate, true);
});

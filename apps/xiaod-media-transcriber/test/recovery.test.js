import test from 'node:test';
import assert from 'node:assert/strict';
import { canRetryJob, classifyFailure, interruptedByRestartFailure, retryPatch } from '../src/recovery.ts';

test('invalid media needs a replacement instead of retrying', () => {
  const failure = classifyFailure(new Error('ffmpeg 执行失败（退出码 1）：Invalid data found when processing input'));
  assert.equal(failure.category, 'needs_input');
  assert.equal(failure.retryable, false);
  assert.match(failure.recovery, /重新上传/);
  assert.equal(canRetryJob({ status: 'failed', failure }), false);
});

test('transient local transcription failures can retry and retain previous error history', () => {
  const failure = classifyFailure(new Error('whisper-cli 执行失败（退出码 1）'));
  const job = { status: 'failed', error: '本地转录未成功完成', failure, attempts: [] };
  assert.equal(canRetryJob(job), true);
  const patch = retryPatch(job);
  assert.equal(patch.status, 'queued');
  assert.equal(patch.failure, null);
  assert.equal(patch.attempts.length, 1);
  assert.equal(patch.attempts[0].previousError, '本地转录未成功完成');
});

test('the explicit local acceptance failpoint is classified as retryable', () => {
  const failure = classifyFailure(new Error('受控测试：transcribing 阶段执行失败。'));
  assert.equal(failure.retryable, true);
  assert.match(failure.recovery, /重试小D任务/);
});

test('公开视频站暂时限流时可以安全重试，不升级成技术故障', () => {
  const failure = classifyFailure(Object.assign(new Error('视频站临时限制读取'), {
    accessFailure: { category: 'retryable', safeMessage: '视频站临时限制读取，请稍后重试或改用本地文件。' }
  }));
  assert.equal(failure.category, 'retryable');
  assert.equal(failure.retryable, true);
  assert.equal(canRetryJob({ status: 'failed', failure }), true);
});

test('completed and non-retryable failed jobs never become retry candidates', () => {
  assert.equal(canRetryJob({ status: 'completed', failure: { retryable: true } }), false);
  assert.equal(canRetryJob({ status: 'failed', failure: { retryable: false } }), false);
});

test('a service restart produces the standard retryable failure', () => {
  const failure = interruptedByRestartFailure();
  assert.equal(failure.category, 'retryable');
  assert.equal(failure.retryable, true);
  assert.equal(canRetryJob({ status: 'failed', failure }), true);
});

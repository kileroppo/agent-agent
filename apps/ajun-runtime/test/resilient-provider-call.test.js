import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeJitteredDelay,
  isRetryableProviderError,
  pruneMessagesForContextLimit,
  withJitteredBackoff,
} from '../src/resilient-provider-call.ts';

test('isRetryableProviderError 准确识别 429、503 及超时', () => {
  assert.equal(isRetryableProviderError({ status: 429 }), true);
  assert.equal(isRetryableProviderError({ statusCode: 503 }), true);
  assert.equal(isRetryableProviderError({ code: 'ECONNRESET' }), true);
  assert.equal(isRetryableProviderError(new Error('Rate limit reached for model')), true);
  assert.equal(isRetryableProviderError({ status: 400 }), false);
  assert.equal(isRetryableProviderError(new Error('Invalid arguments')), false);
});

test('computeJitteredDelay 在指定退避窗口内生成带抖动延迟', () => {
  for (let i = 1; i <= 3; i++) {
    const delay = computeJitteredDelay(i, 200, 2000);
    assert.ok(delay >= 100);
    assert.ok(delay <= 2000);
  }
});

test('withJitteredBackoff 遇到可重试错误时有界重试并成功返回', async () => {
  let attempts = 0;
  const delays = [];

  const result = await withJitteredBackoff(
    async (att) => {
      attempts += 1;
      if (attempts < 3) {
        const err = new Error('Too Many Requests');
        err.status = 429;
        throw err;
      }
      return { success: true, attempts };
    },
    {
      maxRetries: 3,
      baseDelayMs: 50,
      sleepFn: async (ms) => { delays.push(ms); },
      onRetry: (err, att, delay) => {},
    }
  );

  assert.equal(result.success, true);
  assert.equal(attempts, 3);
  assert.equal(delays.length, 2);
});

test('pruneMessagesForContextLimit 超过预算时压缩中间过长输出', () => {
  const messages = [
    { role: 'system', content: 'You are an agent.' },
    { role: 'assistant', content: 'Long tool observation: ' + 'A'.repeat(5000) },
    { role: 'user', content: 'Final user question' },
    { role: 'assistant', content: 'Final answer' },
  ];

  const pruned = pruneMessagesForContextLimit(messages, { maxEstimatedTokens: 500, charsPerToken: 3.5 });
  assert.equal(pruned.length, 4);
  assert.equal(pruned[0].content, 'You are an agent.');
  assert.ok(pruned[1].content.includes('已自动压缩'));
  assert.equal(pruned[2].content, 'Final user question');
});

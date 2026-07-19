import test from 'node:test';
import assert from 'node:assert/strict';
import { createOneShotFailpoint } from '../src/test-failpoint.js';

test('one-shot failpoint is inert unless explicitly configured', () => {
  const failpoint = createOneShotFailpoint('');
  assert.doesNotThrow(() => failpoint('transcribing'));
});

test('one-shot failpoint fails only the configured stage once', () => {
  const failpoint = createOneShotFailpoint('transcribing');
  assert.doesNotThrow(() => failpoint('preparing'));
  assert.throws(() => failpoint('transcribing'), /受控测试：transcribing 阶段执行失败/);
  assert.doesNotThrow(() => failpoint('transcribing'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure } from '../src/recovery.js';
import { ContentAcquisitionError } from '../../../integrations/access/content-acquisition-center.js';

test('a missing account connection becomes a recoverable user-input failure without credential instructions', () => {
  const error = new ContentAcquisitionError({
    code: 'connection_required', category: 'needs_input', safeMessage: '该来源需要先在 A君中连接账号。', recommendedAction: 'reauthorize'
  });
  const failure = classifyFailure(error);
  assert.equal(failure.category, 'needs_input');
  assert.equal(failure.retryable, false);
  assert.match(failure.recovery, /连接账号/);
  assert.doesNotMatch(failure.recovery, /Cookie|token|密码/i);
});

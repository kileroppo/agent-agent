import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPatch } from '../scripts/patch-hermes-business-error-envelope.mjs';

const fixture = `
            return (
                f"Sorry, I encountered an unexpected error.{status_hint}\\n"
                "Try again or use /reset to start a fresh session."
            )
`;

test('未知 Agent 异常返回中文可追踪回执，不误导用户重置会话', () => {
  const patched = applyPatch(fixture);
  assert.match(patched, /AGENT_ARMY_BUSINESS_ERROR_ENVELOPE_V1/);
  assert.match(patched, /错误编号/);
  assert.match(patched, /logger\.error\("Agent user-facing error reference=%s session=%s"/);
  assert.doesNotMatch(patched, /Sorry, I encountered/);
  assert.doesNotMatch(patched, /\/reset/);
  assert.equal(applyPatch(patched), patched);
});

test('上游错误模板变化时拒绝猜测修改', () => {
  assert.throws(
    () => applyPatch('return "different upstream message"'),
    /位置已变化/,
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyPatch,
  applyPlatformBasePatch,
  defaultPlatformInput,
} from '../scripts/patch-hermes-business-error-envelope.mjs';

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

test('消息处理最外层异常只返回中文错误编号，不暴露异常类型或建议重置会话', () => {
  const platformFixture = `
                error_type = type(e).__name__
                error_detail = str(e)[:300] if str(e) else "no details available"
                _thread_metadata = _thread_metadata_for_source(event.source, _reply_anchor_for_event(event))
                await self.send(
                    chat_id=event.source.chat_id,
                    content=(
                        f"Sorry, I encountered an error ({error_type}).\\n"
                        f"{error_detail}\\n"
                        "Try again or use /reset to start a fresh session."
                    ),
                    metadata=_thread_metadata,
                )
`;

  const patched = applyPlatformBasePatch(platformFixture);
  assert.match(patched, /AGENT_ARMY_PLATFORM_ERROR_ENVELOPE_V1/);
  assert.match(patched, /错误编号/);
  assert.match(patched, /logger\.error\(\s*"Platform user-facing error reference=%s platform=%s"/);
  assert.doesNotMatch(patched, /Sorry, I encountered/);
  assert.doesNotMatch(patched, /error_detail/);
  assert.doesNotMatch(patched, /\/reset/);
  assert.equal(applyPlatformBasePatch(patched), patched);
});

test('省略平台目标时与已解析 Gateway 使用同一 Hermes root', () => {
  assert.equal(defaultPlatformInput('/opt/hermes-a'), '/opt/hermes-a');
  assert.equal(defaultPlatformInput('/opt/hermes-a', '/opt/hermes-b/gateway/platforms/base.py'), '/opt/hermes-b/gateway/platforms/base.py');
});

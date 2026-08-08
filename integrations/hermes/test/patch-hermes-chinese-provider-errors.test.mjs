import assert from 'node:assert/strict';
import test from 'node:test';
import { applyProviderErrorPatch } from '../scripts/patch-hermes-chinese-provider-errors.mjs';

const fixture = `_GATEWAY_AUTH_ERROR_RE = re.compile(
    r"(provider\\s+authentication\\s+failed|incorrect\\s+api\\s+key|invalid\\s+api\\s+key|\\b401\\b)",
    re.IGNORECASE,
)

def _gateway_provider_error_reply(text: str) -> str:
    """Map raw provider/API errors to a short user-safe Telegram reply."""
    if _GATEWAY_AUTH_ERROR_RE.search(text):
        return "auth"
    if _GATEWAY_PROVIDER_POLICY_RE.search(text):
        return "policy"
    if _GATEWAY_RATE_LIMIT_RE.search(text):
        return "rate"
    return "generic"


_GATEWAY_PROVIDER_ERROR_SHAPE_RE = re.compile(
    r"^\\s*(\\W*\\s*)?("
    r"api\\s+(?:call\\s+)?failed"
    r"|provider\\s+authentication\\s+failed"
    r")",
    re.IGNORECASE,
)
`;

test('余额、授权、限流和服务异常使用中文用户文案', () => {
  const patched = applyProviderErrorPatch(fixture);
  assert.match(patched, /AGENT_ARMY_CHINESE_PROVIDER_ERRORS_V1/);
  assert.match(patched, /当前 AI 服务额度不足/);
  assert.match(patched, /当前 AI 服务配置异常/);
  assert.match(patched, /等待 1–2 分钟后重试/);
  assert.match(patched, /当前 AI 服务暂时不可用/);
  assert.match(patched, /insufficient\[ _-\]\+balance/);
  assert.equal(applyProviderErrorPatch(patched), patched);
});

test('余额不足优先于 quota 限流文案', () => {
  const patched = applyProviderErrorPatch(fixture);
  const billingIndex = patched.indexOf('if _GATEWAY_BILLING_ERROR_RE.search(text)');
  const rateIndex = patched.indexOf('if _GATEWAY_RATE_LIMIT_RE.search(text)');
  assert.ok(billingIndex >= 0 && rateIndex > billingIndex);
});

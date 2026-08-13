#!/usr/bin/env node
import path from 'node:path';
import {
  defaultHermesRoot,
  patchHermesTextFile,
  replaceRequired as replacePatchAnchor,
} from './patch-support.mjs';

const hermesRootDefault = defaultHermesRoot('HERMES_AGENT_ROOT');

const billingRegex = `_GATEWAY_BILLING_ERROR_RE = re.compile(
    r"("
    r"\\b402\\b"
    r"|insufficient[ _-]+balance"
    r"|insufficient[ _-]+quota"
    r"|payment\\s+required"
    r"|out\\s+of\\s+(?:credits?|balance)"
    r"|(?:credit|balance)\\s+(?:exhausted|depleted)"
    r"|spending\\s+limit"
    r"|key\\s+limit\\s+exceeded"
    r")",
    re.IGNORECASE,
)

`;

const providerReply = `def _gateway_provider_error_reply(text: str) -> str:
    """Map raw provider/API errors to concise Chinese chat replies."""
    # AGENT_ARMY_CHINESE_PROVIDER_ERRORS_V1: provider details stay in logs;
    # chat users receive only the category, impact, and next action.
    if _GATEWAY_BILLING_ERROR_RE.search(text):
        return (
            "当前 AI 服务额度不足，暂时无法处理这条请求。"
            "请联系管理员补充额度后直接重试。"
        )
    if _GATEWAY_AUTH_ERROR_RE.search(text):
        return (
            "当前 AI 服务配置异常，暂时无法处理这条请求。"
            "请联系管理员检查模型授权后重试。"
        )
    if _GATEWAY_PROVIDER_POLICY_RE.search(text):
        return "这条请求未通过 AI 服务的安全检查，请调整内容后重试。"
    if _GATEWAY_RATE_LIMIT_RE.search(text):
        return "当前 AI 服务请求较多，请等待 1–2 分钟后重试。"
    return "当前 AI 服务暂时不可用，请稍后重试；如果持续出现，请联系管理员。"
`;

export function applyProviderErrorPatch(source) {
  if (source.includes('AGENT_ARMY_CHINESE_PROVIDER_ERRORS_V1')) return source;

  let result = replaceRequired(
    source,
    `_GATEWAY_AUTH_ERROR_RE = re.compile(
    r"(provider\\s+authentication\\s+failed|incorrect\\s+api\\s+key|invalid\\s+api\\s+key|\\b401\\b)",
    re.IGNORECASE,
)

`,
    `_GATEWAY_AUTH_ERROR_RE = re.compile(
    r"(provider\\s+authentication\\s+failed|incorrect\\s+api\\s+key|invalid\\s+api\\s+key|\\b401\\b)",
    re.IGNORECASE,
)

${billingRegex}`
  );

  const functionStart = result.indexOf('def _gateway_provider_error_reply(text: str) -> str:');
  const functionEnd = result.indexOf('\n\n_GATEWAY_PROVIDER_ERROR_SHAPE_RE = re.compile(', functionStart);
  if (functionStart < 0 || functionEnd < 0) {
    throw new Error('Hermes 结构不匹配，找不到 Provider 用户提示函数。');
  }
  result = `${result.slice(0, functionStart)}${providerReply}${result.slice(functionEnd)}`;

  return replaceRequired(
    result,
    `    r"api\\s+(?:call\\s+)?failed"
    r"|provider\\s+authentication\\s+failed"`,
    `    r"api\\s+(?:call\\s+)?failed"
    r"|insufficient[ _-]+balance"
    r"|insufficient[ _-]+quota"
    r"|payment\\s+required"
    r"|out\\s+of\\s+(?:credits?|balance)"
    r"|provider\\s+authentication\\s+failed"`
  );
}

function replaceRequired(source, marker, replacement) {
  return replacePatchAnchor(
    source,
    marker,
    replacement,
    `Hermes 结构不匹配，找不到补丁锚点：${marker.slice(0, 72)}`,
  );
}

async function main() {
  const result = await patchHermesTextFile({
    input: process.argv[2] || hermesRootDefault,
    relativePath: path.join('gateway', 'run.py'),
    transform: applyProviderErrorPatch,
  });
  console.log(`已安装 Hermes 中文 Provider 错误提示：${result.filePath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

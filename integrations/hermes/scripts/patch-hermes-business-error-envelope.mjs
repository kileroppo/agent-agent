#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const defaultGateway = path.join(
  process.env.HERMES_HOME || path.join(process.env.HOME || '', '.hermes', 'hermes-agent'),
  'gateway/run.py',
);

export function applyPatch(source) {
  if (source.includes('AGENT_ARMY_BUSINESS_ERROR_ENVELOPE_V1')) return source;
  const legacy = `            return (
                f"Sorry, I encountered an unexpected error.{status_hint}\\n"
                "Try again or use /reset to start a fresh session."
            )
`;
  if (!source.includes(legacy)) {
    throw new Error('Hermes Gateway 的通用错误回执位置已变化，拒绝猜测补丁。');
  }
  const replacement = `            # AGENT_ARMY_BUSINESS_ERROR_ENVELOPE_V1: keep unknown failures
            # actionable and traceable without exposing exception details or blaming session state.
            _business_error_ref = f"{int(time.time() * 1000):X}"[-10:]
            _business_error_hint = {
                401: "模型服务鉴权不可用",
                402: "模型服务额度不可用",
                429: "模型服务暂时繁忙",
                529: "模型服务暂时过载",
            }.get(status_code, "系统内部处理异常，通常不是会话内容导致")
            logger.error("Agent user-facing error reference=%s session=%s", _business_error_ref, session_key)
            return (
                "⚠️ 本轮处理未能正常完成，系统没有把它标记为成功。\\n"
                f"原因：{_business_error_hint}。\\n"
                f"错误编号：{_business_error_ref}\\n"
                "请先发送‘进度’确认是否已有任务；没有对应任务时，再重试原消息。"
            )
`;
  return source.replace(legacy, replacement);
}

async function main() {
  const filePath = process.argv[2] || defaultGateway;
  const original = await fs.readFile(filePath, 'utf8');
  const patched = applyPatch(original);
  if (patched === original) return console.log(`Hermes 中文错误回执已存在：${filePath}`);
  await fs.writeFile(filePath, patched);
  console.log(`已安装 Hermes 中文错误回执：${filePath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

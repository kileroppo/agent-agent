#!/usr/bin/env node
import path from 'node:path';
import {
  defaultHermesTarget,
  patchHermesTextFiles,
  resolveAndVerifyHermesTarget,
} from './patch-support.mjs';

const gatewayRelativePath = path.join('gateway', 'run.py');
const platformBaseRelativePath = path.join('gateway', 'platforms', 'base.py');
const defaultGateway = defaultHermesTarget(gatewayRelativePath);
const defaultPlatformBase = defaultHermesTarget(platformBaseRelativePath);

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

export function applyPlatformBasePatch(source) {
  if (source.includes('AGENT_ARMY_PLATFORM_ERROR_ENVELOPE_V1')) return source;
  const legacy = `                error_type = type(e).__name__
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
  if (!source.includes(legacy)) {
    throw new Error('Hermes 平台通用错误回执位置已变化，拒绝猜测补丁。');
  }
  const replacement = `                # AGENT_ARMY_PLATFORM_ERROR_ENVELOPE_V1: never expose Python
                # exception names/details or suggest destructive session resets to users.
                _platform_error_ref = f"{int(time.time() * 1000):X}"[-10:]
                logger.error(
                    "Platform user-facing error reference=%s platform=%s",
                    _platform_error_ref,
                    self.name,
                )
                _thread_metadata = _thread_metadata_for_source(event.source, _reply_anchor_for_event(event))
                await self.send(
                    chat_id=event.source.chat_id,
                    content=(
                        "⚠️ 本轮处理未能正常完成，系统没有把它标记为成功。\\n"
                        "原因：系统内部处理异常，通常不是你的会话内容导致。\\n"
                        f"错误编号：{_platform_error_ref}\\n"
                        "请保留错误编号并联系维护者检查；无需重置会话。"
                    ),
                    metadata=_thread_metadata,
                )
`;
  return source.replace(legacy, replacement);
}

export function defaultPlatformInput(gatewayRoot, explicitInput) {
  return explicitInput || gatewayRoot;
}

async function main() {
  const gatewayInput = process.argv[2] || defaultGateway;
  const gatewayTarget = await resolveAndVerifyHermesTarget(gatewayInput, gatewayRelativePath);
  const platformInput = defaultPlatformInput(gatewayTarget.root, process.argv[3]);
  const [gateway, platform] = await patchHermesTextFiles([
    { input: gatewayInput, relativePath: gatewayRelativePath, transform: applyPatch },
    { input: platformInput, relativePath: platformBaseRelativePath, transform: applyPlatformBasePatch },
  ]);

  if (!gateway.changed && !platform.changed) {
    console.log(`Hermes 中文错误回执已存在：${gateway.filePath}、${platform.filePath}`);
    return;
  }
  console.log(`已安装 Hermes 中文错误回执：${gateway.filePath}、${platform.filePath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

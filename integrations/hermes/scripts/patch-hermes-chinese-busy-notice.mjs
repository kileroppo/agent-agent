#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  atomicWriteFile,
  defaultHermesRoot,
  replaceRequired as replacePatchAnchor,
  resolveHermesTarget,
} from './patch-support.mjs';

const hermesRootDefault = defaultHermesRoot();

export function applyGatewayPatch(source) {
  if (source.includes('AGENT_ARMY_CHINESE_BUSY_NOTICE_V1')) return source;

  let result = replaceRequired(
    source,
    '                        status_parts.append(f"{elapsed_min} min elapsed")',
    '                        status_parts.append(f"已运行 {elapsed_min} 分钟")'
  );
  result = replaceRequired(
    result,
    '                    status_parts.append(f"iteration {iteration}/{max_iter}")',
    '                    status_parts.append(f"进度 {iteration}/{max_iter}")'
  );
  result = replaceRequired(
    result,
    '                    status_parts.append(f"running: {current_tool}")',
    '                    status_parts.append(f"正在使用 {current_tool}")'
  );
  result = replaceRequired(
    result,
    `        if is_steer_mode:
            message = (
                f"⏩ Steered into current run{status_detail}. "
                f"Your message arrives after the next tool call."
            )
        elif is_redirect_mode:
            message = (
                f"↪ Redirected current run{status_detail}. "
                f"I'll adjust using your correction."
            )`,
    `        # AGENT_ARMY_CHINESE_BUSY_NOTICE_V1: all operator-facing busy notices use concise Chinese.
        if is_steer_mode:
            message = (
                f"⏩ 已把你的补充加入当前任务{status_detail}。"
                f"完成手头这一步后会按新要求继续。"
            )
        elif is_redirect_mode:
            message = (
                f"↪ 已按你的新要求调整当前任务{status_detail}。"
                f"已完成的内容会保留。"
            )`
  );
  result = replaceRequired(
    result,
    `            message = (
                f"⏳ Subagent working{status_detail} — your message is queued for "
                f"when it finishes (use /stop to cancel everything)."
            )`,
    `            message = (
                f"⏳ 协作员工仍在处理{status_detail}。你的消息已排到下一步，"
                f"不会打断当前工作。"
            )`
  );
  result = replaceRequired(
    result,
    `            message = (
                f"⏳ Compressing context{status_detail} — your message is queued for "
                f"when it finishes (use /stop to cancel everything)."
            )`,
    `            message = (
                f"⏳ 正在整理对话上下文{status_detail}。你的消息已排到下一步，"
                f"整理完成后会继续。"
            )`
  );
  result = replaceRequired(
    result,
    `            message = (
                f"⏳ Queued for the next turn{status_detail}. "
                f"I'll respond once the current task finishes."
            )`,
    `            message = (
                f"⏳ 已把你的消息排到下一步{status_detail}。"
                f"当前任务完成后会单独处理。"
            )`
  );
  result = replaceRequired(
    result,
    `            message = (
                f"⚡ Interrupting current task{status_detail}. "
                f"I'll respond to your message shortly."
            )`,
    `            message = (
                f"⚡ 正在按你的新消息切换处理重点{status_detail}。"
                f"稍后会直接回复。"
            )`
  );
  result = replaceRequired(
    result,
    `        reply_anchor = self._reply_anchor_for_event(event)
        thread_meta = self._thread_metadata_for_source(event.source, reply_anchor)
        try:
            await adapter._send_with_retry(`,
    `        reply_anchor = self._reply_anchor_for_event(event)
        thread_meta = self._thread_metadata_for_source(event.source, reply_anchor)
        quick_sender = getattr(adapter, "send_busy_quick_actions", None)
        if callable(quick_sender):
            try:
                quick_result = await quick_sender(
                    chat_id=event.source.chat_id,
                    content=message,
                    current_mode=effective_mode,
                    reply_to=event.message_id,
                    metadata=thread_meta,
                )
                if getattr(quick_result, "success", False):
                    return True
            except Exception as quick_err:
                logger.debug("Failed to send busy quick actions: %s", quick_err)
        try:
            await adapter._send_with_retry(`
  );
  result = replaceRequired(
    result,
    '    async def _drain_active_agents(self, timeout: float) -> tuple[Dict[str, Any], bool]:\n',
    `${busyCommandMethod}

    async def _drain_active_agents(self, timeout: float) -> tuple[Dict[str, Any], bool]:
`
  );
  result = replaceRequired(
    result,
    `            if _cmd_def_inner and _cmd_def_inner.name == "restart":
                return await self._handle_restart_command(event)
`,
    `            if _cmd_def_inner and _cmd_def_inner.name == "restart":
                return await self._handle_restart_command(event)

            if _cmd_def_inner and _cmd_def_inner.name == "busy":
                return self._handle_agent_army_busy_command(event)
`
  );
  return replaceRequired(
    result,
    `        if canonical == "restart":
            return await self._handle_restart_command(event)

        if canonical == "stop":`,
    `        if canonical == "restart":
            return await self._handle_restart_command(event)

        if canonical == "busy":
            return self._handle_agent_army_busy_command(event)

        if canonical == "stop":`
  );
}

export function applyOnboardingPatch(source) {
  if (source.includes('AGENT_ARMY_CHINESE_BUSY_HINT_V1')) return source;
  const start = source.indexOf('def busy_input_hint_gateway(mode: str) -> str:');
  const end = source.indexOf('\n\ndef busy_input_hint_cli', start);
  if (start < 0 || end < 0) throw new Error('Hermes onboarding 结构不匹配，找不到 busy_input_hint_gateway。');
  return `${source.slice(0, start)}${busyHintMethod}${source.slice(end)}`;
}

const busyCommandMethod = `    def _handle_agent_army_busy_command(self, event: MessageEvent) -> str:
        """Show or change how a new message behaves while an Agent is working."""
        action = (event.get_command_args() or "").strip().lower() or "status"
        labels = {
            "interrupt": "直接调整当前任务",
            "queue": "等当前任务完成后单独处理",
            "steer": "完成手头这一步后加入当前任务",
        }
        if action == "status":
            current = self._busy_input_mode if self._busy_input_mode in labels else "interrupt"
            return f"当前设置：{labels[current]}。"
        if action not in labels:
            return "可选操作：/busy queue、/busy steer、/busy interrupt、/busy status。"

        self._busy_input_mode = action
        self._busy_text_mode = "queue" if action == "queue" else "interrupt"
        try:
            config_path = _hermes_home / "config.yaml"
            config = _load_gateway_config()
            if not isinstance(config, dict):
                config = {}
            display = config.get("display")
            if not isinstance(display, dict):
                display = {}
                config["display"] = display
            display["busy_input_mode"] = action
            atomic_yaml_write(config_path, config, sort_keys=False)
        except Exception as exc:
            logger.warning("Failed to persist busy input mode: %s", exc)
            return f"本次运行已切换为：{labels[action]}。重启后可能恢复原设置。"
        return f"已切换为：{labels[action]}。"`;

const busyHintMethod = `# AGENT_ARMY_CHINESE_BUSY_HINT_V1: concise Chinese guidance shared by every Gateway.
def busy_input_hint_gateway(mode: str) -> str:
    """首次在 Agent 工作中补充消息时显示的一次性中文说明。"""
    if mode == "queue":
        return (
            "💡 这是首次提示：刚才的消息已排到下一步，不会打断当前任务。"
            "你可以点下方按钮切换处理方式；这条说明以后不再出现。"
        )
    if mode == "steer":
        return (
            "💡 这是首次提示：刚才的补充会在完成手头这一步后加入当前任务。"
            "你可以点下方按钮切换处理方式；这条说明以后不再出现。"
        )
    if mode == "redirect":
        return (
            "💡 这是首次提示：刚才的新要求已用于调整当前任务，已完成的内容会保留。"
            "你可以点下方按钮改为下一步单独处理、查看设置或停止任务；"
            "这条说明以后不再出现。"
        )
    return (
        "💡 这是首次提示：刚才的新消息正在改变当前处理重点。"
        "你可以点下方按钮改为下一步单独处理、查看设置或停止任务；"
        "这条说明以后不再出现。"
    )`;

function replaceRequired(source, marker, replacement) {
  return replacePatchAnchor(
    source,
    marker,
    replacement,
    `Hermes 结构不匹配，找不到补丁锚点：${marker.slice(0, 72)}`,
  );
}

async function main() {
  const root = process.argv[2] || hermesRootDefault;
  const { root: hermesRoot, filePath: gatewayPath } = resolveHermesTarget(
    root,
    path.join('gateway', 'run.py'),
  );
  const onboardingPath = path.join(hermesRoot, 'agent/onboarding.py');

  const gatewayOriginal = await fs.readFile(gatewayPath, 'utf8');
  const onboardingOriginal = await fs.readFile(onboardingPath, 'utf8');
  const gatewayPatched = applyGatewayPatch(gatewayOriginal);
  const onboardingPatched = applyOnboardingPatch(onboardingOriginal);

  if (gatewayPatched !== gatewayOriginal) await atomicWriteFile(gatewayPath, gatewayPatched);
  if (onboardingPatched !== onboardingOriginal) await atomicWriteFile(onboardingPath, onboardingPatched);
  console.log(`已安装 Hermes 中文运行提示：${hermesRoot}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

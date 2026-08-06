import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyGatewayPatch,
  applyOnboardingPatch
} from '../scripts/patch-hermes-chinese-busy-notice.mjs';

const gatewayFixture = `                        status_parts.append(f"{elapsed_min} min elapsed")
                    status_parts.append(f"iteration {iteration}/{max_iter}")
                    status_parts.append(f"running: {current_tool}")
        if is_steer_mode:
            message = (
                f"⏩ Steered into current run{status_detail}. "
                f"Your message arrives after the next tool call."
            )
        elif is_redirect_mode:
            message = (
                f"↪ Redirected current run{status_detail}. "
                f"I'll adjust using your correction."
            )
            message = (
                f"⏳ Subagent working{status_detail} — your message is queued for "
                f"when it finishes (use /stop to cancel everything)."
            )
            message = (
                f"⏳ Compressing context{status_detail} — your message is queued for "
                f"when it finishes (use /stop to cancel everything)."
            )
            message = (
                f"⏳ Queued for the next turn{status_detail}. "
                f"I'll respond once the current task finishes."
            )
            message = (
                f"⚡ Interrupting current task{status_detail}. "
                f"I'll respond to your message shortly."
            )
        reply_anchor = self._reply_anchor_for_event(event)
        thread_meta = self._thread_metadata_for_source(event.source, reply_anchor)
        try:
            await adapter._send_with_retry(
    async def _drain_active_agents(self, timeout: float) -> tuple[Dict[str, Any], bool]:
            if _cmd_def_inner and _cmd_def_inner.name == "restart":
                return await self._handle_restart_command(event)
        if canonical == "restart":
            return await self._handle_restart_command(event)

        if canonical == "stop":
`;

const onboardingFixture = `def busy_input_hint_gateway(mode: str) -> str:
    if mode == "redirect":
        return "First-time tip"
    return "Send /busy queue"


def busy_input_hint_cli(mode: str) -> str:
    return "cli"
`;

test('所有 Gateway 的运行中提示统一为中文并优先发送飞书快捷按钮', () => {
  const patched = applyGatewayPatch(gatewayFixture);
  assert.match(patched, /AGENT_ARMY_CHINESE_BUSY_NOTICE_V1/);
  assert.match(patched, /已按你的新要求调整当前任务/);
  assert.match(patched, /send_busy_quick_actions/);
  assert.match(patched, /_handle_agent_army_busy_command/);
  assert.match(patched, /atomic_yaml_write/);
  assert.doesNotMatch(patched, /Redirected current run|Queued for the next turn/);
  assert.equal(applyGatewayPatch(patched), patched);
});

test('首次运行提示改成中文且不再要求用户手输英文命令', () => {
  const patched = applyOnboardingPatch(onboardingFixture);
  assert.match(patched, /AGENT_ARMY_CHINESE_BUSY_HINT_V1/);
  assert.match(patched, /点下方按钮/);
  assert.ok(!patched.includes('First-time tip'));
  assert.ok(!patched.includes('Send /busy'));
  assert.equal(applyOnboardingPatch(patched), patched);
});

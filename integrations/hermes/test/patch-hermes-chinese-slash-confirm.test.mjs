import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPatch } from '../scripts/patch-hermes-chinese-slash-confirm.mjs';

const fixture = `        if canonical == "new":
            return await self._maybe_confirm_destructive_slash(
                event=event,
                command="new",
                title="/new",
                detail=(
                    "This starts a fresh session and discards the current "
                    "conversation history."
                ),
                execute=_do_reset,
            )
            if choice == "cancel":
                return f"🟡 /{command} cancelled. Conversation unchanged."
            if choice == "always":
                note = (
                    "\\n\\nℹ️ Future /clear, /new, /reset, and /undo will run "
                    "without confirmation. Re-enable via "
                    "\`approvals.destructive_slash_confirm: true\` in config.yaml."
                )
        prompt_message = (
            f"⚠️ **Confirm /{command}**\\n\\n"
            f"{detail}\\n\\n"
            "Choose:\\n"
            "• **Approve Once** — proceed this time only\\n"
            "• **Always Approve** — proceed and silence this prompt permanently\\n"
            "• **Cancel** — keep current conversation\\n\\n"
            f"_Text fallback: reply \`{_p}approve\`, \`{_p}always\`, or \`{_p}cancel\`._"
        )
`;

test('Hermes 命令确认补丁把 /new 提示、取消回执和长期授权说明统一为中文', () => {
  const patched = applyPatch(fixture);
  assert.match(patched, /AGENT_ARMY_CHINESE_SLASH_CONFIRM_V1/);
  assert.match(patched, /这会开始一个全新会话/);
  assert.match(patched, /仅执行本次/);
  assert.match(patched, /以后不再询问/);
  assert.match(patched, /已取消 \/\{command\}/);
  assert.doesNotMatch(patched, /Approve Once|Always Approve|Conversation unchanged/);
  assert.equal(applyPatch(patched), patched);
});

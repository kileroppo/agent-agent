#!/usr/bin/env node
import path from 'node:path';
import {
  defaultHermesTarget,
  patchHermesTextFile,
  replaceRequired as replacePatchAnchor,
} from './patch-support.mjs';

const defaultGateway = defaultHermesTarget(path.join('gateway', 'run.py'));

export function applyPatch(source) {
  if (source.includes('AGENT_ARMY_CHINESE_SLASH_CONFIRM_V1')) return source;
  let result = replaceRequired(
    source,
    '        if canonical == "new":\n',
    '        # AGENT_ARMY_CHINESE_SLASH_CONFIRM_V1: keep destructive command guidance in Chinese.\n        if canonical == "new":\n'
  );
  result = replaceRequired(
    result,
    `                detail=(
                    "This starts a fresh session and discards the current "
                    "conversation history."
                ),`,
    `                detail=(
                    "这会开始一个全新会话；接下来的回答将从空白上下文开始，"
                    "当前对话不会再参与回答。"
                ),`
  );
  result = replaceRequired(
    result,
    '                return f"🟡 /{command} cancelled. Conversation unchanged."',
    '                return f"🟡 已取消 /{command}，当前会话保持不变。"'
  );
  result = replaceRequired(
    result,
    `                note = (
                    "\\n\\nℹ️ Future /clear, /new, /reset, and /undo will run "
                    "without confirmation. Re-enable via "
                    "\`approvals.destructive_slash_confirm: true\` in config.yaml."
                )`,
    `                note = (
                    "\\n\\nℹ️ 以后 /clear、/new、/reset 和 /undo 将不再询问确认。"
                    "如需恢复，请在 config.yaml 中设置 "
                    "\`approvals.destructive_slash_confirm: true\`。"
                )`
  );
  return replaceRequired(
    result,
    `        prompt_message = (
            f"⚠️ **Confirm /{command}**\\n\\n"
            f"{detail}\\n\\n"
            "Choose:\\n"
            "• **Approve Once** — proceed this time only\\n"
            "• **Always Approve** — proceed and silence this prompt permanently\\n"
            "• **Cancel** — keep current conversation\\n\\n"
            f"_Text fallback: reply \`{_p}approve\`, \`{_p}always\`, or \`{_p}cancel\`._"
        )`,
    `        prompt_message = (
            f"⚠️ **确认 /{command}**\\n\\n"
            f"{detail}\\n\\n"
            "请选择：\\n"
            "• **仅执行本次** — 本次继续，之后仍会询问\\n"
            "• **以后不再询问** — 本次继续，并永久关闭这类确认\\n"
            "• **取消** — 保留当前会话\\n\\n"
            f"_按钮不可用时，可回复 \`{_p}approve\`、\`{_p}always\` 或 \`{_p}cancel\`。_"
        )`
  );
}

function replaceRequired(source, marker, replacement) {
  return replacePatchAnchor(
    source,
    marker,
    replacement,
    `Hermes Gateway 结构不匹配，找不到补丁锚点：${marker.slice(0, 72)}`,
  );
}

async function main() {
  const result = await patchHermesTextFile({
    input: process.argv[2] || defaultGateway,
    relativePath: path.join('gateway', 'run.py'),
    transform: applyPatch,
  });
  if (!result.changed) return console.log(`Hermes 中文命令确认已存在：${result.filePath}`);
  console.log(`已安装 Hermes 中文命令确认：${result.filePath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

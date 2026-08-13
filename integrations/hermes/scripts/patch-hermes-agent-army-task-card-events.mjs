#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, verifyHermesTarget } from './patch-feishu-agent-proposal-router.mjs';

const defaultGateway = path.join(
  process.env.HERMES_HOME || path.join(process.env.HOME || '', '.hermes', 'hermes-agent'),
  'gateway/run.py',
);

const patchMarker = 'AGENT_ARMY_TRUSTED_TASK_CARD_EVENTS_V2';
const legacyPatchMarker = 'AGENT_ARMY_TRUSTED_TASK_CARD_EVENTS_V1';
const gatewayRelativePath = path.join('gateway', 'run.py');

function replaceExactlyOnce(source, anchor, replacement, label) {
  const first = source.indexOf(anchor);
  if (first < 0 || source.indexOf(anchor, first + anchor.length) >= 0) {
    throw new Error(`Hermes Gateway 的${label}结构已变化，拒绝猜测补丁。`);
  }
  return source.replace(anchor, replacement);
}

export function applyPatch(source) {
  if (source.includes(patchMarker)) {
    const markerCount = source.split(patchMarker).length - 1;
    if (
      markerCount !== 1
      || !source.includes('trusted_task_card_handler')
      || !source.includes('and is_trusted_task_card_event(event_type, tool_name)')
      || source.includes('"mcp__agent_army__task_create"')
    ) {
      throw new Error('Hermes 任务卡事件 Seam 不完整或仍内嵌工具白名单；拒绝继续。');
    }
    return source;
  }
  if (source.includes(legacyPatchMarker)) {
    let upgraded = replaceExactlyOnce(source, legacyPatchMarker, patchMarker, '旧任务卡事件标记');
    upgraded = replaceExactlyOnce(
      upgraded,
      `        _agent_army_task_card_adapter = (\n`,
      `        from plugins.platforms.feishu.agent_army_task_card import (\n            is_trusted_task_card_event,\n            trusted_task_card_handler,\n        )\n        _agent_army_task_card_adapter = (\n`,
      '旧任务卡事件 Module 接线',
    );
    upgraded = replaceExactlyOnce(
      upgraded,
      `        _agent_army_task_card_handler = getattr(\n            _agent_army_task_card_adapter,\n            "handle_agent_army_task_result",\n            None,\n        )\n        if not callable(_agent_army_task_card_handler):\n            _agent_army_task_card_handler = None\n`,
      `        _agent_army_task_card_handler = trusted_task_card_handler(\n            _agent_army_task_card_adapter,\n            source,\n            feishu_platform=Platform.FEISHU,\n        )\n`,
      '旧任务卡事件 Handler 接线',
    );
    upgraded = replaceExactlyOnce(
      upgraded,
      `                and event_type == "tool.completed"\n                and tool_name in {\n                    "mcp__agent_army__task_create",\n                    "mcp__agent_army__task_get",\n                }\n`,
      `                and is_trusted_task_card_event(event_type, tool_name)\n`,
      '旧任务卡事件白名单',
    );
    return upgraded;
  }

  const callbackAnchor = `        def progress_callback(event_type: str, tool_name: str = None, preview: str = None, args: dict = None, **kwargs):
            """Callback invoked by agent on tool lifecycle events."""
`;
  const callbackReplacement = `        # ${patchMarker}: bridge only trusted Agent Army MCP results.
        # The adapter owns schema validation and rendering; the Gateway never parses model replies.
        from plugins.platforms.feishu.agent_army_task_card import (
            is_trusted_task_card_event,
            trusted_task_card_handler,
        )
        _agent_army_task_card_adapter = (
            self._adapter_for_source(source)
            if source.platform == Platform.FEISHU
            else None
        )
        _agent_army_task_card_handler = trusted_task_card_handler(
            _agent_army_task_card_adapter,
            source,
            feishu_platform=Platform.FEISHU,
        )
        _agent_army_task_card_loop = asyncio.get_running_loop()

        def progress_callback(event_type: str, tool_name: str = None, preview: str = None, args: dict = None, **kwargs):
            """Callback invoked by agent on tool lifecycle events."""
            if (
                _agent_army_task_card_handler is not None
                and is_trusted_task_card_event(event_type, tool_name)
            ):
                try:
                    safe_schedule_threadsafe(
                        _agent_army_task_card_handler(source, kwargs.get("result")),
                        _agent_army_task_card_loop,
                        logger=logger,
                        log_message="Agent Army task card event scheduling error",
                    )
                except Exception as _task_card_err:
                    logger.debug("Agent Army task card event bridge failed: %s", _task_card_err)
`;

  const assignmentAnchor = `            agent.tool_progress_callback = (
                progress_callback
                if (
                    needs_progress_queue
                    or log_mode_enabled
                    or _live_status_adapter is not None
                )
                else None
            )
`;
  const assignmentReplacement = `            agent.tool_progress_callback = (
                progress_callback
                if (
                    needs_progress_queue
                    or log_mode_enabled
                    or _live_status_adapter is not None
                    or _agent_army_task_card_handler is not None
                )
                else None
            )
`;

  let patched = replaceExactlyOnce(
    source,
    callbackAnchor,
    callbackReplacement,
    '工具进度回调',
  );
  patched = replaceExactlyOnce(
    patched,
    assignmentAnchor,
    assignmentReplacement,
    '工具进度回调绑定',
  );
  return patched;
}

async function main() {
  const filePath = process.argv[2] || defaultGateway;
  const compatibility = await verifyHermesTarget(filePath, gatewayRelativePath);
  const pluginModule = path.join(
    compatibility.root,
    'plugins/platforms/feishu/agent_army_task_card.py',
  );
  await fs.access(pluginModule);
  const original = await fs.readFile(filePath, 'utf8');
  const patched = applyPatch(original);
  if (patched === original) {
    console.log(`Hermes Agent Army 任务卡事件桥已存在：${filePath}`);
    return;
  }
  await atomicWriteFile(filePath, patched);
  console.log(`已安装 Hermes Agent Army 任务卡事件桥：${filePath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

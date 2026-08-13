import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyPatch } from '../scripts/patch-hermes-agent-army-task-card-events.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const runtimeDirectory = path.resolve(here, '../runtime');
const runtimeBootstrap = `
import sys
sys.path.insert(0, ${JSON.stringify(runtimeDirectory)})
import agent_army_feishu_task_card as task_card_runtime
plugins = types.ModuleType("plugins")
platforms = types.ModuleType("plugins.platforms")
feishu = types.ModuleType("plugins.platforms.feishu")
sys.modules["plugins"] = plugins
sys.modules["plugins.platforms"] = platforms
sys.modules["plugins.platforms.feishu"] = feishu
sys.modules["plugins.platforms.feishu.agent_army_task_card"] = task_card_runtime
`;

const fixture = `
async def build_callback(self, source, agent):
        needs_progress_queue = False
        log_mode_enabled = False
        _live_status_adapter = None
        log_queue = None
        progress_queue = None

        def progress_callback(event_type: str, tool_name: str = None, preview: str = None, args: dict = None, **kwargs):
            """Callback invoked by agent on tool lifecycle events."""
            if log_queue is not None:
                if not progress_queue:
                    return
            if not progress_queue:
                return

        async def bind_callback():
            agent.tool_progress_callback = (
                progress_callback
                if (
                    needs_progress_queue
                    or log_mode_enabled
                    or _live_status_adapter is not None
                )
                else None
            )
        await bind_callback()
        return agent.tool_progress_callback
`;

test('可信 Agent Army MCP 完成结果只桥接一次，并在关闭进度提示时仍绑定回调', () => {
  const patched = applyPatch(fixture);
  assert.equal((patched.match(/AGENT_ARMY_TRUSTED_TASK_CARD_EVENTS_V2/g) || []).length, 1);
  assert.match(patched, /source\.platform == Platform\.FEISHU/);
  assert.match(patched, /kwargs\.get\("result"\)/);
  assert.match(patched, /is_trusted_task_card_event/);
  assert.doesNotMatch(patched, /mcp__agent_army__task_create/);
  assert.match(patched, /safe_schedule_threadsafe\(/);
  assert.match(patched, /or _agent_army_task_card_handler is not None/);
  assert.doesNotMatch(patched, /final_response|assistant_reply|json\.loads/);
  assert.equal(applyPatch(patched), patched);
  assert.throws(
    () => applyPatch(patched.replace('is_trusted_task_card_event(event_type, tool_name)', 'True')),
    /事件 Seam 不完整/,
  );

  const pythonSource = `
import asyncio
import types
${runtimeBootstrap}

class Platform:
    FEISHU = "feishu"
    SLACK = "slack"

class Logger:
    def debug(self, *args, **kwargs):
        pass

logger = Logger()
scheduled = []

def safe_schedule_threadsafe(coro, loop, **kwargs):
    task = asyncio.create_task(coro)
    scheduled.append(task)
    return task

${patched}

class Adapter:
    def __init__(self):
        self.calls = []

    async def handle_agent_army_task_result(self, source, result):
        self.calls.append((source.platform, result))

class Gateway:
    def __init__(self, adapter):
        self.adapter = adapter

    def _adapter_for_source(self, source):
        return self.adapter

async def main():
    adapter = Adapter()
    gateway = Gateway(adapter)
    agent = types.SimpleNamespace(tool_progress_callback=None)
    source = types.SimpleNamespace(platform=Platform.FEISHU)
    callback = await build_callback(gateway, source, agent)
    assert callback is not None
    created = {"taskId": "task-1", "status": "running"}
    refreshed = {"taskId": "task-1", "status": "succeeded"}
    callback("tool.completed", "mcp__agent_army__task_create", result=created)
    callback("tool.completed", "mcp__agent_army__task_get", result=refreshed)
    callback("tool.started", "mcp__agent_army__task_create", result=created)
    callback("tool.completed", "mcp__agent_army__task_list", result=created)
    await asyncio.sleep(0)
    assert adapter.calls == [
        (Platform.FEISHU, created),
        (Platform.FEISHU, refreshed),
    ]
    assert len(scheduled) == 2

asyncio.run(main())
`;
  const result = spawnSync('python3', ['-c', pythonSource], { encoding:'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('非飞书来源即使使用白名单工具也不会触发任务卡处理', () => {
  const patched = applyPatch(fixture);
  const pythonSource = `
import asyncio
import types
${runtimeBootstrap}

class Platform:
    FEISHU = "feishu"
    SLACK = "slack"

class Logger:
    def debug(self, *args, **kwargs):
        pass

logger = Logger()
scheduled = []

def safe_schedule_threadsafe(coro, loop, **kwargs):
    scheduled.append(coro)
    coro.close()

${patched}

class Adapter:
    async def handle_agent_army_task_result(self, source, result):
        raise AssertionError("non-Feishu source must not reach adapter")

class Gateway:
    def _adapter_for_source(self, source):
        return Adapter()

async def main():
    agent = types.SimpleNamespace(tool_progress_callback="unset")
    source = types.SimpleNamespace(platform=Platform.SLACK)
    callback = await build_callback(Gateway(), source, agent)
    assert callback is None
    assert agent.tool_progress_callback is None
    assert scheduled == []

asyncio.run(main())
`;
  const result = spawnSync('python3', ['-c', pythonSource], { encoding:'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('上游回调或绑定结构变化时拒绝猜测补丁', () => {
  assert.throws(
    () => applyPatch('def progress_callback_changed():\n    pass\n'),
    /结构已变化/,
  );
});

test('已安装 V1 事件桥原地迁移到 runtime Module Interface', () => {
  const current = applyPatch(fixture);
  const legacy = current
    .replaceAll('AGENT_ARMY_TRUSTED_TASK_CARD_EVENTS_V2', 'AGENT_ARMY_TRUSTED_TASK_CARD_EVENTS_V1')
    .replace(
      `        from plugins.platforms.feishu.agent_army_task_card import (\n            is_trusted_task_card_event,\n            trusted_task_card_handler,\n        )\n`,
      '',
    )
    .replace(
      `        _agent_army_task_card_handler = trusted_task_card_handler(\n            _agent_army_task_card_adapter,\n            source,\n            feishu_platform=Platform.FEISHU,\n        )\n`,
      `        _agent_army_task_card_handler = getattr(\n            _agent_army_task_card_adapter,\n            "handle_agent_army_task_result",\n            None,\n        )\n        if not callable(_agent_army_task_card_handler):\n            _agent_army_task_card_handler = None\n`,
    )
    .replace(
      '                and is_trusted_task_card_event(event_type, tool_name)\n',
      `                and event_type == "tool.completed"\n                and tool_name in {\n                    "mcp__agent_army__task_create",\n                    "mcp__agent_army__task_get",\n                }\n`,
    );
  const upgraded = applyPatch(legacy);
  assert.match(upgraded, /AGENT_ARMY_TRUSTED_TASK_CARD_EVENTS_V2/);
  assert.match(upgraded, /trusted_task_card_handler/);
  assert.match(upgraded, /is_trusted_task_card_event/);
  assert.doesNotMatch(upgraded, /mcp__agent_army__task_create/);
  assert.equal(applyPatch(upgraded), upgraded);
});

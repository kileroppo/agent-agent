import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { applyPatch } from '../scripts/patch-hermes-agent-army-task-card-events.mjs';

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
  assert.equal((patched.match(/AGENT_ARMY_TRUSTED_TASK_CARD_EVENTS_V1/g) || []).length, 1);
  assert.match(patched, /source\.platform == Platform\.FEISHU/);
  assert.match(patched, /kwargs\.get\("result"\)/);
  assert.match(patched, /safe_schedule_threadsafe\(/);
  assert.match(patched, /or _agent_army_task_card_handler is not None/);
  assert.doesNotMatch(patched, /final_response|assistant_reply|json\.loads/);
  assert.equal(applyPatch(patched), patched);

  const pythonSource = `
import asyncio
import types

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

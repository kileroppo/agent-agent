import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { applyPatch } from '../scripts/patch-hermes-platform-notification-isolation.mjs';

const fixture = `
            # Memory update notifications in chat.  Config: display.memory_notifications
            _mem_notif = user_config.get("display", {}).get("memory_notifications")
            if isinstance(_mem_notif, bool):
                _mem_notif = "on" if _mem_notif else "off"
            agent.memory_notifications = str(_mem_notif).lower() if _mem_notif else "on"
`;

test('Hermes 后台自我改进通知服从飞书平台级关闭配置', () => {
  const patched = applyPatch(fixture);
  assert.match(patched, /AGENT_ARMY_PLATFORM_NOTIFICATION_ISOLATION_V2/);
  assert.match(patched, /resolve_display_setting as _resolve_display_setting/);
  assert.match(patched, /_resolve_display_setting\(\s*user_config, platform_key, "memory_notifications", "on"/);
  assert.doesNotMatch(patched, /^\s+from gateway\.display_config import resolve_display_setting$/m);
  assert.doesNotMatch(patched, /user_config\.get\("display", \{\}\)\.get\("memory_notifications"\)/);
  assert.equal(applyPatch(patched), patched);
});

test('升级已安装的 V1 补丁，避免函数内同名导入遮蔽前置调用', () => {
  const v1 = `
            # AGENT_ARMY_PLATFORM_NOTIFICATION_ISOLATION_V1: resolve the platform override
            # before wiring background-review callbacks. Internal lifecycle notices must
            # never bypass display.platforms.<platform>.memory_notifications.
            from gateway.display_config import resolve_display_setting
            _mem_notif = resolve_display_setting(
                user_config, platform_key, "memory_notifications", "on"
            )
            if isinstance(_mem_notif, bool):
                _mem_notif = "on" if _mem_notif else "off"
            agent.memory_notifications = str(_mem_notif).lower() if _mem_notif else "on"
`;

  const patched = applyPatch(v1);
  assert.match(patched, /AGENT_ARMY_PLATFORM_NOTIFICATION_ISOLATION_V2/);
  assert.doesNotMatch(patched, /AGENT_ARMY_PLATFORM_NOTIFICATION_ISOLATION_V1/);
  assert.match(patched, /resolve_display_setting as _resolve_display_setting/);
  assert.doesNotMatch(patched, /^\s+from gateway\.display_config import resolve_display_setting$/m);
  assert.equal(applyPatch(patched), patched);
});

test('补丁后的 run_sync 可先读取 streaming，再读取平台通知配置', () => {
  const patchedBlock = applyPatch(fixture);
  const pythonSource = `
import sys
import types

gateway_module = types.ModuleType("gateway")
display_module = types.ModuleType("gateway.display_config")
display_module.resolve_display_setting = lambda config, platform, key, default=None: config.get(key, default)
sys.modules["gateway"] = gateway_module
sys.modules["gateway.display_config"] = display_module
resolve_display_setting = display_module.resolve_display_setting

def run_sync():
            user_config = {"streaming": False, "memory_notifications": False}
            platform_key = "feishu"
            agent = types.SimpleNamespace()
            streaming = resolve_display_setting(user_config, platform_key, "streaming")
${patchedBlock}
            return streaming, agent.memory_notifications

assert run_sync() == (False, "off")
`;
  const result = spawnSync('python3', ['-c', pythonSource], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

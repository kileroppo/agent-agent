import assert from 'node:assert/strict';
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
  assert.match(patched, /AGENT_ARMY_PLATFORM_NOTIFICATION_ISOLATION_V1/);
  assert.match(patched, /resolve_display_setting\(\s*user_config, platform_key, "memory_notifications", "on"/);
  assert.doesNotMatch(patched, /user_config\.get\("display", \{\}\)\.get\("memory_notifications"\)/);
  assert.equal(applyPatch(patched), patched);
});

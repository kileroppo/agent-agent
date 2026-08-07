#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const defaultGateway = path.join(
  process.env.HERMES_HOME || path.join(process.env.HOME || '', '.hermes', 'hermes-agent'),
  'gateway/run.py',
);

export function applyPatch(source) {
  if (source.includes('AGENT_ARMY_PLATFORM_NOTIFICATION_ISOLATION_V1')) return source;
  const legacy = `            _mem_notif = user_config.get("display", {}).get("memory_notifications")
            if isinstance(_mem_notif, bool):
                _mem_notif = "on" if _mem_notif else "off"
            agent.memory_notifications = str(_mem_notif).lower() if _mem_notif else "on"
`;
  if (!source.includes(legacy)) throw new Error('Hermes Gateway 的后台通知配置读取位置已变化，拒绝猜测补丁。');
  return source.replace(legacy, `            # AGENT_ARMY_PLATFORM_NOTIFICATION_ISOLATION_V1: resolve the platform override
            # before wiring background-review callbacks. Internal lifecycle notices must
            # never bypass display.platforms.<platform>.memory_notifications.
            from gateway.display_config import resolve_display_setting
            _mem_notif = resolve_display_setting(
                user_config, platform_key, "memory_notifications", "on"
            )
            if isinstance(_mem_notif, bool):
                _mem_notif = "on" if _mem_notif else "off"
            agent.memory_notifications = str(_mem_notif).lower() if _mem_notif else "on"
`);
}

async function main() {
  const filePath = process.argv[2] || defaultGateway;
  const original = await fs.readFile(filePath, 'utf8');
  const patched = applyPatch(original);
  if (patched === original) return console.log(`Hermes 平台通知隔离已存在：${filePath}`);
  await fs.writeFile(filePath, patched);
  console.log(`已安装 Hermes 平台通知隔离：${filePath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

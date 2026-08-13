#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, defaultHermesTarget } from './patch-support.mjs';

const defaultGateway = defaultHermesTarget(path.join('gateway', 'run.py'));

export function applyPatch(source) {
  const legacy = `            _mem_notif = user_config.get("display", {}).get("memory_notifications")
            if isinstance(_mem_notif, bool):
                _mem_notif = "on" if _mem_notif else "off"
            agent.memory_notifications = str(_mem_notif).lower() if _mem_notif else "on"
`;
  const unsafeV1 = `            # AGENT_ARMY_PLATFORM_NOTIFICATION_ISOLATION_V1: resolve the platform override
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
  const safeV2 = `            # AGENT_ARMY_PLATFORM_NOTIFICATION_ISOLATION_V2: resolve the platform override
            # before wiring background-review callbacks. Alias the local import so it cannot
            # shadow resolve_display_setting calls that execute earlier in run_sync().
            from gateway.display_config import resolve_display_setting as _resolve_display_setting
            _mem_notif = _resolve_display_setting(
                user_config, platform_key, "memory_notifications", "on"
            )
            if isinstance(_mem_notif, bool):
                _mem_notif = "on" if _mem_notif else "off"
            agent.memory_notifications = str(_mem_notif).lower() if _mem_notif else "on"
`;

  if (source.includes('AGENT_ARMY_PLATFORM_NOTIFICATION_ISOLATION_V2')) return source;
  if (source.includes(unsafeV1)) return source.replace(unsafeV1, safeV2);
  if (source.includes('AGENT_ARMY_PLATFORM_NOTIFICATION_ISOLATION_V1')) {
    throw new Error('Hermes Gateway 的 V1 平台通知补丁结构已变化，拒绝猜测升级。');
  }
  if (!source.includes(legacy)) throw new Error('Hermes Gateway 的后台通知配置读取位置已变化，拒绝猜测补丁。');
  return source.replace(legacy, safeV2);
}

async function main() {
  const filePath = process.argv[2] || defaultGateway;
  const original = await fs.readFile(filePath, 'utf8');
  const patched = applyPatch(original);
  if (patched === original) return console.log(`Hermes 平台通知隔离已存在：${filePath}`);
  await atomicWriteFile(filePath, patched);
  console.log(`已安装 Hermes 平台通知隔离：${filePath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

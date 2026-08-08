#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const PATCH_MARKER = 'AGENT_ARMY_DISPLAY_SETTING_SCOPE_V1';
const NOTIFICATION_MARKER = 'AGENT_ARMY_PLATFORM_NOTIFICATION_ISOLATION_V1';
const IMPORT_LINE = '            from gateway.display_config import resolve_display_setting\n';
const defaultGateway = path.join(
  process.env.HERMES_HOME || path.join(process.env.HOME || '', '.hermes', 'hermes-agent'),
  'gateway/run.py'
);

export function applyPatch(source) {
  if (source.includes(PATCH_MARKER)) return source;
  if (
    source.includes('AGENT_ARMY_PLATFORM_NOTIFICATION_ISOLATION_V2')
    && source.includes('from gateway.display_config import resolve_display_setting as _resolve_display_setting')
    && source.includes('_mem_notif = _resolve_display_setting(')
  ) {
    return source;
  }

  const notificationIndex = source.indexOf(NOTIFICATION_MARKER);
  if (notificationIndex < 0) {
    throw new Error('Hermes Gateway 结构不匹配，找不到平台通知补丁锚点。');
  }

  const runSyncIndex = source.lastIndexOf('        def run_sync():\n', notificationIndex);
  if (runSyncIndex < 0) {
    throw new Error('Hermes Gateway 结构不匹配，找不到包含平台通知逻辑的 run_sync。');
  }
  const bodyIndex = runSyncIndex + '        def run_sync():\n'.length;
  let result = `${source.slice(0, bodyIndex)}`
    + `            # ${PATCH_MARKER}: bind the display resolver before its first use.\n`
    + IMPORT_LINE
    + source.slice(bodyIndex);

  const relocatedNotificationIndex = result.indexOf(NOTIFICATION_MARKER, bodyIndex);
  const memorySettingIndex = result.indexOf('            _mem_notif = resolve_display_setting(', relocatedNotificationIndex);
  const lateImportIndex = result.indexOf(IMPORT_LINE, relocatedNotificationIndex);
  if (
    memorySettingIndex < 0
    || lateImportIndex < 0
    || lateImportIndex > memorySettingIndex
  ) {
    throw new Error('Hermes Gateway 结构不匹配，找不到导致作用域漂移的后置 import。');
  }
  result = result.slice(0, lateImportIndex) + result.slice(lateImportIndex + IMPORT_LINE.length);
  return result;
}

async function main() {
  const filePath = process.argv[2] || defaultGateway;
  const original = await fs.readFile(filePath, 'utf8');
  const patched = applyPatch(original);
  if (patched === original) {
    console.log(`Hermes display 作用域补丁已存在：${filePath}`);
    return;
  }
  const stat = await fs.stat(filePath);
  const temporary = `${filePath}.display-scope.tmp-${process.pid}`;
  await fs.writeFile(temporary, patched, { mode:stat.mode });
  await fs.rename(temporary, filePath);
  console.log(`已安装 Hermes display 作用域补丁：${filePath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

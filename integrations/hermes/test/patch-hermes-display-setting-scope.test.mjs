import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applyPatch } from '../scripts/patch-hermes-display-setting-scope.mjs';

const brokenGatewayFixture = `import sys
import types

gateway = types.ModuleType("gateway")
display_config = types.ModuleType("gateway.display_config")
display_config.resolve_display_setting = lambda *_args: "streaming-ok"
sys.modules["gateway"] = gateway
sys.modules["gateway.display_config"] = display_config

class GatewayRunner:
    def outer(self):
        from gateway.display_config import resolve_display_setting

        def run_sync():
            streaming = resolve_display_setting({}, "feishu", "streaming")
            # AGENT_ARMY_PLATFORM_NOTIFICATION_ISOLATION_V1: resolve the platform override
            # before wiring background-review callbacks. Internal lifecycle notices must
            # never bypass display.platforms.<platform>.memory_notifications.
            from gateway.display_config import resolve_display_setting
            _mem_notif = resolve_display_setting({}, "feishu", "memory_notifications", "on")
            return streaming, _mem_notif

        return run_sync()

print(GatewayRunner().outer())
`;

test('Hermes display 补丁修复 run_sync 后置 import 导致的真实消息崩溃，且可重复执行', () => {
  assert.throws(() => runPython(brokenGatewayFixture), /UnboundLocalError/);

  const patched = applyPatch(brokenGatewayFixture);
  assert.equal(runPython(patched).trim(), "('streaming-ok', 'streaming-ok')");
  assert.equal(applyPatch(patched), patched);
});

test('Hermes 已使用不遮蔽前置引用的 V2 别名时保持原样', () => {
  const safeV2 = brokenGatewayFixture
    .replace('AGENT_ARMY_PLATFORM_NOTIFICATION_ISOLATION_V1', 'AGENT_ARMY_PLATFORM_NOTIFICATION_ISOLATION_V2')
    .replace(
      'from gateway.display_config import resolve_display_setting\n            _mem_notif = resolve_display_setting(',
      'from gateway.display_config import resolve_display_setting as _resolve_display_setting\n            _mem_notif = _resolve_display_setting('
    );

  assert.equal(runPython(safeV2).trim(), "('streaming-ok', 'streaming-ok')");
  assert.equal(applyPatch(safeV2), safeV2);
});

function runPython(source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-display-scope-'));
  const file = path.join(root, 'gateway_fixture.py');
  try {
    fs.writeFileSync(file, source, { mode:0o600 });
    return execFileSync('python3', [file], { encoding:'utf8', stdio:['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const stderr = String(error?.stderr || error?.message || '');
    throw new Error(stderr);
  } finally {
    fs.rmSync(root, { recursive:true, force:true });
  }
}

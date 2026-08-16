import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  LABELS,
  defaultLayout,
  installPlugin,
  migrateRepositoryRuntime,
  pluginStatus,
  renderLaunchAgentPlists,
  rollbackRepositoryRuntime,
} from '../ops/local-ai/plugin-manager.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('插件发布使用内容哈希、current 指针和外置运行根', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'local-ai-plugin-'));
  try {
    const layout = defaultLayout({
      home:temporary,
      runtimeRoot:path.join(temporary, 'Application Support', 'AgentArmy', 'local-ai'),
      pluginRoot:path.join(temporary, 'Application Support', 'AgentArmy', 'plugins', 'local-ai'),
      launchAgentsDir:path.join(temporary, 'LaunchAgents'),
    });
    const status = await installPlugin({ repoRoot:REPO_ROOT, layout, activate:true, writeLaunchAgents:true, now:() => new Date('2026-08-16T00:00:00.000Z') });
    assert.equal(status.active, true);
    assert.match(status.currentReleaseHash, /^[a-f0-9]{64}$/);
    assert.equal((await fs.lstat(layout.currentLink)).isSymbolicLink(), true);
    const manifest = JSON.parse(await fs.readFile(path.join(layout.currentLink, 'plugin-manifest.json'), 'utf8'));
    assert.equal(manifest.releaseHash, status.currentReleaseHash);
    assert.equal(manifest.payload.some((entry) => entry.path === 'lib/local_ai_gateway.py'), true);
    const installed = await pluginStatus({ layout });
    assert.equal(installed.currentReleaseHash, status.currentReleaseHash);
    for (const label of Object.values(LABELS)) {
      const plist = await fs.readFile(path.join(layout.launchAgentsDir, `${label}.plist`), 'utf8');
      assert.equal(plist.includes(REPO_ROOT), false);
      assert.equal(plist.includes(layout.runtimeRoot), true);
      assert.equal(plist.includes(layout.currentLink), true);
    }
  } finally {
    await fs.rm(temporary, { recursive:true, force:true });
  }
});

test('LaunchAgent 渲染正确转义带空格和特殊字符的可迁移路径', () => {
  const layout = defaultLayout({
    home:'/Users/example',
    runtimeRoot:'/Users/example/Library/Application Support/Agent & Army/local-ai',
    pluginRoot:'/Users/example/Library/Application Support/Agent & Army/plugins/local-ai',
    launchAgentsDir:'/Users/example/Library/LaunchAgents',
  });
  const plists = renderLaunchAgentPlists({ layout });
  assert.match(plists[LABELS.gateway], /Agent &amp; Army/);
  assert.match(plists[LABELS.gateway], /<true\/>/);
  assert.match(plists[LABELS.qwen35], /<false\/>/);
});

test('仓库运行物迁移可回滚且不覆盖外置配对文件', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'local-ai-migrate-'));
  try {
    const sourceRoot = path.join(temporary, 'repo', 'work', 'local-ai');
    const runtimeRoot = path.join(temporary, 'support', 'local-ai');
    const pluginRoot = path.join(temporary, 'support', 'plugins', 'local-ai');
    const recordPath = path.join(temporary, 'migration.json');
    await fs.mkdir(path.join(sourceRoot, 'venvs', 'retrieval'), { recursive:true });
    await fs.mkdir(path.join(sourceRoot, 'venvs', 'mflux'), { recursive:true });
    await fs.mkdir(path.join(sourceRoot, 'venvs', 'mlx-vlm'), { recursive:true });
    await fs.mkdir(path.join(sourceRoot, 'artifacts'), { recursive:true });
    await fs.writeFile(path.join(sourceRoot, 'artifacts', 'proof.txt'), 'proof');
    await fs.mkdir(runtimeRoot, { recursive:true });
    await fs.mkdir(path.join(runtimeRoot, 'artifacts'));
    await fs.writeFile(path.join(runtimeRoot, 'mac-pairing.json'), '{}', { mode:0o600 });
    const layout = defaultLayout({ runtimeRoot, pluginRoot, launchAgentsDir:path.join(temporary, 'LaunchAgents') });
    const migration = await migrateRepositoryRuntime({ sourceRoot, layout, recordPath });
    assert.equal(migration.moves.length, 3);
    assert.equal(await fs.readFile(path.join(runtimeRoot, 'mac-pairing.json'), 'utf8'), '{}');
    assert.equal((await fs.lstat(path.join(runtimeRoot, 'venvs', 'gateway'))).isDirectory(), true);
    assert.equal(await fs.readFile(path.join(runtimeRoot, 'artifacts', 'proof.txt'), 'utf8'), 'proof');
    assert.equal((await fs.lstat(path.join(sourceRoot, 'venvs', 'mlx-vlm'))).isDirectory(), true);
    await rollbackRepositoryRuntime({ recordPath });
    assert.equal((await fs.lstat(path.join(sourceRoot, 'venvs', 'retrieval'))).isDirectory(), true);
    assert.equal((await fs.lstat(path.join(sourceRoot, 'artifacts', 'proof.txt'))).isFile(), true);
    assert.deepEqual(await fs.readdir(path.join(runtimeRoot, 'artifacts')), []);
  } finally {
    await fs.rm(temporary, { recursive:true, force:true });
  }
});

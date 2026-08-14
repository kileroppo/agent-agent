import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CONTENT_PLUGIN_STEPFUN_SHA256,
  CONTENT_PLUGIN_VERSION,
} from '../compat/paperclip-2026-722-binary-rpc.ts';
import pluginManifest from '../plugins/content-autonomy/src/manifest.ts';
import {
  BUNDLE_VERSION,
  BUNDLE_PREFIX,
  freezeContentAutonomyBundle,
  MANIFEST_FILE,
  validateFrozenBundle,
} from '../scripts/freeze-content-autonomy-bundle.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('0.5.0版本链与当前StepFun SHA保持一致，maintenance只从live 0.4.9升级和回滚', async () => {
  const pluginRoot = path.join(
    repositoryRoot,
    'integrations/paperclip/plugins/content-autonomy',
  );
  const packageJson = JSON.parse(await fs.readFile(
    path.join(pluginRoot, 'package.json'),
    'utf8',
  ));
  const packageLock = JSON.parse(await fs.readFile(
    path.join(pluginRoot, 'package-lock.json'),
    'utf8',
  ));
  const stepfunBytes = await fs.readFile(path.join(pluginRoot, 'src/stepfun-tools.ts'));
  const stepfunSha = crypto.createHash('sha256').update(stepfunBytes).digest('hex');
  const maintenance = await fs.readFile(path.join(
    repositoryRoot,
    'integrations/paperclip/scripts/maintain-content-autonomy-live.mjs',
  ), 'utf8');

  assert.equal(packageJson.version, '0.5.0');
  assert.equal(packageLock.version, '0.5.0');
  assert.equal(packageLock.packages[''].version, '0.5.0');
  assert.equal(pluginManifest.version, '0.5.0');
  assert.equal(BUNDLE_VERSION, '0.5.0');
  assert.equal(CONTENT_PLUGIN_VERSION, '0.5.0');
  assert.equal(
    CONTENT_PLUGIN_STEPFUN_SHA256,
    '6f0303f47cebebc6e02ea29a4a0bc8ec0397f652628215a35b41018f3d71f244',
  );
  assert.equal(stepfunSha, CONTENT_PLUGIN_STEPFUN_SHA256);
  assert.match(maintenance, /OLD_PLUGIN_VERSION = '0\.4\.9'/);
  assert.match(maintenance, /NEW_PLUGIN_VERSION = '0\.5\.0'/);
  assert.match(
    maintenance,
    /I_ACCEPT_CONTENT_AUTONOMY_0_5_0_LIVE_MAINTENANCE/,
  );
  assert.match(maintenance, /I_ACCEPT_CONTENT_AUTONOMY_0_4_9_ROLLBACK/);
  assert.match(maintenance, /stage = 'binary_compat_preserve'/);
  assert.match(maintenance, /expectedPluginVersion:OLD_PLUGIN_VERSION/);
});

test('冻结0.5.0复制完整运行依赖和ajun allowlist，精确排除生成物与Remotion缓存并设为只读', async (context) => {
  const repoRoot = await createFixture(context);
  const result = await freezeContentAutonomyBundle({ repoRoot });

  assert.equal(result.status, 'frozen');
  assert.match(result.payloadHash, /^[a-f0-9]{64}$/);
  assert.equal(path.basename(result.bundleRoot), `${BUNDLE_PREFIX}${result.payloadHash}`);
  assert.equal(
    await fs.readFile(path.join(
      result.bundleRoot,
      'apps/animated-chart/node_modules/pkg/bin.js',
    ), 'utf8'),
    '#!/usr/bin/env node\n',
  );
  assert.equal(
    await fs.readlink(path.join(
      result.bundleRoot,
      'apps/animated-chart/node_modules/.bin/tool',
    )),
    '../pkg/bin.js',
  );
  await assert.rejects(
    fs.stat(path.join(result.bundleRoot, 'apps/animated-chart/out/render.mp4')),
    { code: 'ENOENT' },
  );
  await assert.rejects(
    fs.stat(path.join(result.bundleRoot, 'apps/animated-chart/public/m5-draft/frame.png')),
    { code: 'ENOENT' },
  );
  await assert.rejects(
    fs.stat(path.join(
      result.bundleRoot,
      'apps/animated-chart/node_modules/.cache/webpack/render.pack',
    )),
    { code: 'ENOENT' },
  );
  await assert.rejects(
    fs.stat(path.join(
      result.bundleRoot,
      'apps/animated-chart/node_modules/.cache',
    )),
    { code: 'ENOENT' },
  );
  assert.equal(
    JSON.parse(await fs.readFile(path.join(
      result.bundleRoot,
      'apps/animated-chart/node_modules/remotion/package.json',
    ), 'utf8')).name,
    'remotion',
  );
  assert.equal(
    await fs.readFile(path.join(
      result.bundleRoot,
      'apps/animated-chart/node_modules/pkg/.cache/runtime.js',
    ), 'utf8'),
    'module.exports = "package-cache-source";\n',
  );
  assert.equal(
    await fs.readFile(path.join(
      result.bundleRoot,
      'apps/animated-chart/public/keep.txt',
    ), 'utf8'),
    'keep\n',
  );
  assert.equal(
    await fs.readFile(path.join(
      result.bundleRoot,
      'apps/ajun-runtime/src/m5-budget-cost-contract.ts',
    ), 'utf8'),
    'export const budgetContract = true;\n',
  );
  assert.equal(
    await fs.readFile(path.join(
      result.bundleRoot,
      'apps/ajun-runtime/src/local-budget-ticket-authority.ts',
    ), 'utf8'),
    'export const ticketAuthority = true;\n',
  );
  const designRelativePath =
    'designs/m2-authorization-architecture/a-jun-product-runtime-preview.png';
  const designBytes = await fs.readFile(path.join(result.bundleRoot, designRelativePath));
  assert.equal(designBytes.toString('utf8'), 'm2-product-preview\n');
  await assert.rejects(
    fs.stat(path.join(
      result.bundleRoot,
      'designs/m2-authorization-architecture/unrelated.html',
    )),
    { code: 'ENOENT' },
  );
  await assert.rejects(
    fs.stat(path.join(result.bundleRoot, 'designs/unrelated/extra.png')),
    { code: 'ENOENT' },
  );
  await assert.rejects(
    fs.stat(path.join(result.bundleRoot, 'apps/ajun-runtime/src/unrelated.js')),
    { code: 'ENOENT' },
  );

  assert.equal((await fs.stat(result.bundleRoot)).mode & 0o777, 0o555);
  assert.equal(
    (await fs.stat(path.join(
      result.bundleRoot,
      'apps/animated-chart/package.json',
    ))).mode & 0o777,
    0o444,
  );
  assert.equal(
    (await fs.stat(path.join(
      result.bundleRoot,
      'apps/animated-chart/node_modules/pkg/bin.js',
    ))).mode & 0o777,
    0o555,
  );

  const manifest = JSON.parse(await fs.readFile(
    path.join(result.bundleRoot, MANIFEST_FILE),
    'utf8',
  ));
  assert.equal(manifest.bundleVersion, '0.5.0');
  assert.equal(manifest.payloadHash, result.payloadHash);
  assert.deepEqual(manifest.exclusions, [
    'apps/animated-chart/out/**',
    'apps/animated-chart/public/m5-*/**',
    'apps/animated-chart/node_modules/.cache/**',
  ]);
  assert.equal(manifest.entries.some((entry) =>
    entry.path.startsWith('apps/animated-chart/node_modules/.cache/')), false);
  assert.deepEqual(manifest.includedFiles, [
    'apps/ajun-runtime/package.json',
    'apps/ajun-runtime/src/m5-budget-cost-contract.ts',
    'apps/ajun-runtime/src/local-budget-ticket-authority.ts',
    'designs/m2-authorization-architecture/a-jun-product-runtime-preview.png',
    'designs/m2-authorization-architecture/architecture-preview.png',
    'designs/agent-army-m1/desktop-preview.png',
    'designs/feishu-mobile-army-control/architecture-preview.png',
  ]);
  assert.deepEqual(
    manifest.entries.find((entry) => entry.path === designRelativePath),
    {
      type: 'file',
      path: designRelativePath,
      mode: '0444',
      size: designBytes.length,
      sha256: crypto.createHash('sha256').update(designBytes).digest('hex'),
    },
  );
  assert.ok(manifest.entries.some((entry) =>
    entry.type === 'symlink'
      && entry.path === 'apps/animated-chart/node_modules/.bin/tool'
      && entry.target === '../pkg/bin.js'));
  await validateFrozenBundle(result.bundleRoot, result.payloadHash);
});

test('相同源码重复冻结返回同一路径且不覆盖；已有包被改动时失败关闭', async (context) => {
  const repoRoot = await createFixture(context);
  const first = await freezeContentAutonomyBundle({ repoRoot });
  const second = await freezeContentAutonomyBundle({ repoRoot });
  assert.equal(second.status, 'already_frozen');
  assert.equal(second.bundleRoot, first.bundleRoot);
  assert.equal(second.payloadHash, first.payloadHash);

  const tampered = path.join(
    first.bundleRoot,
    'integrations/paperclip/plugins/content-autonomy/src/index.ts',
  );
  await fs.chmod(first.bundleRoot, 0o755);
  await fs.chmod(path.dirname(tampered), 0o755);
  await fs.chmod(tampered, 0o644);
  await fs.writeFile(tampered, 'tampered\n');
  await assert.rejects(
    freezeContentAutonomyBundle({ repoRoot }),
    /只读模式|内容哈希不匹配/,
  );
});

test('源码软链越出组件、输出目录软链和非0.5.0版本均被拒绝', async (context) => {
  const escapingRepo = await createFixture(context);
  await fs.writeFile(path.join(escapingRepo, 'outside.txt'), 'outside\n');
  await fs.symlink(
    '../../outside.txt',
    path.join(escapingRepo, 'apps/animated-chart/escape'),
  );
  await assert.rejects(
    freezeContentAutonomyBundle({ repoRoot: escapingRepo }),
    /软链目标.*越出允许根目录/,
  );

  const outputRepo = await createFixture(context);
  const realOutput = path.join(outputRepo, 'real-output');
  const linkedOutput = path.join(outputRepo, 'linked-output');
  await fs.mkdir(realOutput);
  await fs.symlink('real-output', linkedOutput);
  await assert.rejects(
    freezeContentAutonomyBundle({
      repoRoot: outputRepo,
      outputParent: linkedOutput,
    }),
    /输出路径含软链/,
  );

  const wrongVersionRepo = await createFixture(context);
  const packageFile = path.join(
    wrongVersionRepo,
    'integrations/paperclip/plugins/content-autonomy/package.json',
  );
  await fs.writeFile(packageFile, JSON.stringify({
    name: '@agent-army/paperclip-content-autonomy',
    version: '0.4.5',
  }));
  await assert.rejects(
    freezeContentAutonomyBundle({ repoRoot: wrongVersionRepo }),
    /只允许冻结 content-autonomy 0\.5\.0/,
  );
});

test('renderer固定design缺失或被软链替代时冻结失败关闭', async (context) => {
  const missingRepo = await createFixture(context);
  await fs.rm(path.join(
    missingRepo,
    'designs/m2-authorization-architecture/architecture-preview.png',
  ));
  await assert.rejects(
    freezeContentAutonomyBundle({ repoRoot: missingRepo }),
    { code: 'ENOENT' },
  );

  const symlinkRepo = await createFixture(context);
  const linkedDesign = path.join(
    symlinkRepo,
    'designs/m2-authorization-architecture/a-jun-product-runtime-preview.png',
  );
  await fs.rm(linkedDesign);
  await fs.symlink('architecture-preview.png', linkedDesign);
  await assert.rejects(
    freezeContentAutonomyBundle({ repoRoot: symlinkRepo }),
    /allowlist源码必须是普通文件/,
  );
});

test('verify运行插件test/check、renderer preflight测试和lint，并拒绝修改内容', async (context) => {
  const repoRoot = await createFixture(context);
  const calls = [];
  const result = await freezeContentAutonomyBundle({
    repoRoot,
    verify: true,
    runCommand: async (command, args, { cwd }) => {
      const pluginMarker = 'integrations/paperclip/plugins/content-autonomy';
      const appMarker = 'apps/animated-chart';
      calls.push({
        command,
        args,
        cwd: cwd.includes(pluginMarker) ? pluginMarker : appMarker,
      });
    },
  });
  assert.equal(result.status, 'frozen');
  assert.deepEqual(
    calls,
    [
      {
        command: 'npm',
        args: ['test'],
        cwd: 'integrations/paperclip/plugins/content-autonomy',
      },
      {
        command: 'npm',
        args: ['run', 'check'],
        cwd: 'integrations/paperclip/plugins/content-autonomy',
      },
      {
        command: 'npm',
        args: ['run', 'test:m5-preflight'],
        cwd: 'apps/animated-chart',
      },
      {
        command: 'npm',
        args: ['run', 'lint'],
        cwd: 'apps/animated-chart',
      },
    ],
  );

  const mutatingRepo = await createFixture(context);
  await assert.rejects(
    freezeContentAutonomyBundle({
      repoRoot: mutatingRepo,
      verify: true,
      runCommand: async (_command, _args, { cwd }) => {
        if (cwd.endsWith('content-autonomy')) {
          await fs.writeFile(path.join(cwd, 'verification-side-effect.txt'), 'changed\n');
        }
      },
    }),
    /验证命令修改了待冻结内容/,
  );
});

async function createFixture(context) {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-freeze-test-'));
  context.after(async () => {
    await makeWritable(repoRoot);
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  const pluginRoot = path.join(
    repoRoot,
    'integrations/paperclip/plugins/content-autonomy',
  );
  const appRoot = path.join(repoRoot, 'apps/animated-chart');
  const ajunRoot = path.join(repoRoot, 'apps/ajun-runtime');
  const designsRoot = path.join(repoRoot, 'designs');
  await fs.mkdir(path.join(pluginRoot, 'src'), { recursive: true });
  await fs.mkdir(path.join(pluginRoot, 'node_modules/plugin-dep'), { recursive: true });
  await fs.mkdir(path.join(appRoot, 'src'), { recursive: true });
  await fs.mkdir(path.join(appRoot, 'node_modules/.bin'), { recursive: true });
  await fs.mkdir(path.join(appRoot, 'node_modules/.cache/webpack'), { recursive: true });
  await fs.mkdir(path.join(appRoot, 'node_modules/pkg'), { recursive: true });
  await fs.mkdir(path.join(appRoot, 'node_modules/pkg/.cache'), { recursive: true });
  await fs.mkdir(path.join(appRoot, 'node_modules/remotion'), { recursive: true });
  await fs.mkdir(path.join(appRoot, 'out'), { recursive: true });
  await fs.mkdir(path.join(appRoot, 'public/m5-draft'), { recursive: true });
  await fs.mkdir(path.join(appRoot, 'public'), { recursive: true });
  await fs.mkdir(path.join(ajunRoot, 'src'), { recursive: true });
  await fs.mkdir(path.join(designsRoot, 'm2-authorization-architecture'), { recursive: true });
  await fs.mkdir(path.join(designsRoot, 'agent-army-m1'), { recursive: true });
  await fs.mkdir(path.join(designsRoot, 'feishu-mobile-army-control'), { recursive: true });
  await fs.mkdir(path.join(designsRoot, 'unrelated'), { recursive: true });

  await fs.writeFile(path.join(pluginRoot, 'package.json'), JSON.stringify({
    name: '@agent-army/paperclip-content-autonomy',
    version: '0.5.0',
    scripts: { test: 'node --test', check: 'node --check src/index.ts' },
  }));
  await fs.writeFile(path.join(pluginRoot, 'src/index.ts'), 'export const ready = true;\n');
  await fs.writeFile(
    path.join(pluginRoot, 'node_modules/plugin-dep/index.ts'),
    'module.exports = true;\n',
  );
  await fs.writeFile(path.join(appRoot, 'package.json'), JSON.stringify({
    name: 'animated-chart',
    scripts: { lint: 'eslint . && tsc' },
  }));
  await fs.writeFile(path.join(appRoot, 'src/index.ts'), 'export const chart = true;\n');
  await fs.writeFile(
    path.join(appRoot, 'node_modules/pkg/bin.js'),
    '#!/usr/bin/env node\n',
    { mode: 0o755 },
  );
  await fs.symlink('../pkg/bin.js', path.join(appRoot, 'node_modules/.bin/tool'));
  await fs.writeFile(
    path.join(appRoot, 'node_modules/.cache/webpack/render.pack'),
    'generated-remotion-cache\n',
  );
  await fs.writeFile(
    path.join(appRoot, 'node_modules/pkg/.cache/runtime.js'),
    'module.exports = "package-cache-source";\n',
  );
  await fs.writeFile(
    path.join(appRoot, 'node_modules/remotion/package.json'),
    JSON.stringify({ name:'remotion', version:'4.0.500' }),
  );
  await fs.writeFile(path.join(appRoot, 'out/render.mp4'), 'temporary\n');
  await fs.writeFile(path.join(appRoot, 'public/m5-draft/frame.png'), 'temporary\n');
  await fs.writeFile(path.join(appRoot, 'public/keep.txt'), 'keep\n');
  await fs.writeFile(path.join(ajunRoot, 'package.json'), JSON.stringify({
    name: 'ajun-runtime',
    version: '0.1.0',
  }));
  await fs.writeFile(
    path.join(ajunRoot, 'src/m5-budget-cost-contract.ts'),
    'export const budgetContract = true;\n',
  );
  await fs.writeFile(
    path.join(ajunRoot, 'src/local-budget-ticket-authority.ts'),
    'export const ticketAuthority = true;\n',
  );
  await fs.writeFile(
    path.join(ajunRoot, 'src/unrelated.js'),
    'export const excluded = true;\n',
  );
  await fs.writeFile(
    path.join(designsRoot, 'm2-authorization-architecture/a-jun-product-runtime-preview.png'),
    'm2-product-preview\n',
  );
  await fs.writeFile(
    path.join(designsRoot, 'm2-authorization-architecture/architecture-preview.png'),
    'm2-architecture-preview\n',
  );
  await fs.writeFile(
    path.join(designsRoot, 'agent-army-m1/desktop-preview.png'),
    'agent-army-desktop-preview\n',
  );
  await fs.writeFile(
    path.join(designsRoot, 'feishu-mobile-army-control/architecture-preview.png'),
    'feishu-mobile-architecture-preview\n',
  );
  await fs.writeFile(
    path.join(designsRoot, 'm2-authorization-architecture/unrelated.html'),
    '<p>excluded</p>\n',
  );
  await fs.writeFile(
    path.join(designsRoot, 'unrelated/extra.png'),
    'excluded\n',
  );
  return repoRoot;
}

async function makeWritable(root) {
  let stat;
  try {
    stat = await fs.lstat(root);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return;
    }
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return;
  }
  await fs.chmod(root, 0o700);
  for (const name of await fs.readdir(root)) {
    const absolute = path.join(root, name);
    const child = await fs.lstat(absolute);
    if (child.isDirectory() && !child.isSymbolicLink()) {
      await makeWritable(absolute);
    } else if (child.isFile()) {
      await fs.chmod(absolute, 0o600);
    }
  }
}

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { freezeAjunRuntimeRelease } from '../../../apps/ajun-runtime/scripts/manage-immutable-runtime-release.mjs';
import { migrateHermesGatewayLaunchd, parseLaunchdGatewayMigrationArgs } from '../scripts/migrate-hermes-gateway-launchd.mjs';

const execFile = promisify(execFileCallback);

test('迁移只接受显式单岗位、label、plist 和 apply/rollback 二选一', () => {
  assert.deepEqual(parseLaunchdGatewayMigrationArgs([
    '--apply', '--agent', 'xiaod', '--label', 'com.xiaod.hermes.gateway', '--plist', '/tmp/Library/LaunchAgents/com.xiaod.hermes.gateway.plist', '--guard-script', '/release/integrations/hermes/scripts/start-hermes-gateway-guarded.mjs'
  ]), { apply:true, rollback:false, agentId:'xiaod', label:'com.xiaod.hermes.gateway', plistPath:'/tmp/Library/LaunchAgents/com.xiaod.hermes.gateway.plist', backupPath:'', guardedScriptPath:'/release/integrations/hermes/scripts/start-hermes-gateway-guarded.mjs' });
  assert.throws(() => parseLaunchdGatewayMigrationArgs(['--apply', '--rollback', '--agent', 'xiaod', '--label', 'x', '--plist', '/x.plist']), /二选一/);
  assert.throws(() => parseLaunchdGatewayMigrationArgs(['--apply', '--agent', 'xiaod', '--label', 'x']), /--plist/);
  assert.throws(() => parseLaunchdGatewayMigrationArgs(['--apply', '--agent', 'xiaod', '--label', 'x', '--plist', '/x.plist']), /--guard-script/);
  assert.throws(() => parseLaunchdGatewayMigrationArgs(['--rollback', '--agent', 'xiaod', '--label', 'x', '--plist', '/x.plist']), /--backup/);
});

test('apply 精确备份后在临时文件改 ProgramArguments、lint 并原子替换', async () => {
  const fixture = await launchdFixture();
  try {
    const original = await fs.readFile(fixture.plistPath, 'utf8');
    const result = await migrateHermesGatewayLaunchd({
      apply:true, agentId:'xiaod', label:fixture.label, plistPath:fixture.plistPath, launchAgentsRoot:fixture.root,
      guardedScriptPath:fixture.guardPath, validateRelease:fixture.validateRelease,
      readPlistLabel:async () => fixture.label,
      readProgramArguments:async () => ['/venv/bin/python', '-m', 'hermes_cli.main', 'gateway', 'run', '--replace'],
      writeProgramArguments:async (staging, args) => fs.writeFile(staging, `guarded:${JSON.stringify(args)}`),
      lintPlist:async (staging) => assert.match(staging, /gateway-staging/)
    });
    assert.equal(result.mode, 'migration-applied');
    assert.equal(await fs.readFile(result.backupPath, 'utf8'), original);
    assert.equal((await fs.stat(result.backupPath)).mode & 0o777, 0o600);
    assert.match(await fs.readFile(fixture.plistPath, 'utf8'), /start-hermes-gateway-guarded\.mjs/);
  } finally { await fs.rm(fixture.base, { recursive:true, force:true }); }
});

test('macOS 默认 plutil 适配器能读取并迁移真实 ProgramArguments 数组', {
  skip:process.platform !== 'darwin'
}, async () => {
  const fixture = await launchdFixture();
  try {
    await fs.writeFile(fixture.plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${fixture.label}</string>
<key>ProgramArguments</key><array><string>/opt/hermes/bin/hermes</string><string>gateway</string><string>run</string><string>--replace</string></array>
</dict></plist>\n`);
    const result = await migrateHermesGatewayLaunchd({
      apply:true, agentId:'xiaod', label:fixture.label, plistPath:fixture.plistPath,
      launchAgentsRoot:fixture.root, guardedScriptPath:fixture.guardPath, validateRelease:fixture.validateRelease,
    });
    assert.equal(result.mode, 'migration-applied');
    assert.match(await fs.readFile(fixture.plistPath, 'utf8'), /start-hermes-gateway-guarded\.mjs/);
  } finally { await fs.rm(fixture.base, { recursive:true, force:true }); }
});

test('拒绝非 Hermes gateway、label 不匹配、目录外或符号链接 plist', async () => {
  const fixture = await launchdFixture();
  try {
    const guarded = { guardedScriptPath:fixture.guardPath, validateRelease:fixture.validateRelease };
    await assert.rejects(() => migrateHermesGatewayLaunchd({ apply:true, agentId:'xiaod', label:fixture.label, plistPath:fixture.plistPath, launchAgentsRoot:fixture.root, readPlistLabel:async () => fixture.label, readProgramArguments:async () => ['/bin/sh', '-c', 'not gateway'], ...guarded }), /不是 Hermes gateway run/);
    await assert.rejects(() => migrateHermesGatewayLaunchd({ apply:true, agentId:'xiaod', label:'wrong.label', plistPath:fixture.plistPath, launchAgentsRoot:fixture.root, readPlistLabel:async () => fixture.label, readProgramArguments:async () => ['/venv/bin/hermes', 'gateway', 'run'], ...guarded }), /Label 与显式 --label 不匹配/);
    await assert.rejects(() => migrateHermesGatewayLaunchd({ apply:true, agentId:'xiaod', label:fixture.label, plistPath:path.join(fixture.base, 'outside.plist'), launchAgentsRoot:fixture.root, ...guarded }), /真实 LaunchAgents 根目录/);
    const linked = path.join(fixture.root, 'linked.plist');
    await fs.symlink(fixture.plistPath, linked);
    await assert.rejects(() => migrateHermesGatewayLaunchd({ apply:true, agentId:'xiaod', label:fixture.label, plistPath:linked, launchAgentsRoot:fixture.root, ...guarded }), /不是安全普通文件/);
  } finally { await fs.rm(fixture.base, { recursive:true, force:true }); }
});

test('拒绝 LaunchAgents 或备份路径中的中间目录符号链接', async () => {
  const fixture = await launchdFixture();
  try {
    const outside = path.join(fixture.base, 'outside');
    const linkedDirectory = path.join(fixture.root, 'nested');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'linked.plist'), '<plist>outside</plist>\n');
    await fs.symlink(outside, linkedDirectory);
    await assert.rejects(() => migrateHermesGatewayLaunchd({
      apply:true, agentId:'xiaod', label:fixture.label,
      plistPath:path.join(linkedDirectory, 'linked.plist'), launchAgentsRoot:fixture.root,
      guardedScriptPath:fixture.guardPath, validateRelease:fixture.validateRelease,
    }), /路径包含符号链接/);

    const migrated = await migrateHermesGatewayLaunchd({
      apply:true, agentId:'xiaod', label:fixture.label, plistPath:fixture.plistPath, launchAgentsRoot:fixture.root,
      guardedScriptPath:fixture.guardPath, validateRelease:fixture.validateRelease,
      readPlistLabel:async () => fixture.label, readProgramArguments:async () => ['/venv/bin/hermes', 'gateway', 'run'],
      writeProgramArguments:async (staging) => fs.writeFile(staging, 'changed'), lintPlist:async () => {},
    });
    const backupRoot = path.dirname(path.dirname(migrated.backupPath));
    const forgedDirectory = path.join(backupRoot, 'linked-backup');
    const forgedOutside = path.join(fixture.base, 'forged-backup');
    await fs.mkdir(forgedOutside);
    await fs.copyFile(migrated.backupPath, path.join(forgedOutside, path.basename(fixture.plistPath)));
    await fs.copyFile(path.join(path.dirname(migrated.backupPath), 'backup.json'), path.join(forgedOutside, 'backup.json'));
    await fs.symlink(forgedOutside, forgedDirectory);
    await assert.rejects(() => migrateHermesGatewayLaunchd({
      rollback:true, agentId:'xiaod', label:fixture.label, plistPath:fixture.plistPath,
      backupPath:path.join(forgedDirectory, path.basename(fixture.plistPath)), launchAgentsRoot:fixture.root,
      readPlistLabel:async () => fixture.label, lintPlist:async () => {},
    }), /路径包含符号链接/);
  } finally { await fs.rm(fixture.base, { recursive:true, force:true }); }
});

test('拒绝 /tmp 中任意同名 guard，接受冻结器真实验证的 release guard', async (context) => {
  const fixture = await launchdFixture();
  const fakeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-fake-guard-'));
  try {
    const fakeGuard = path.join(fakeRoot, 'integrations/hermes/scripts/start-hermes-gateway-guarded.mjs');
    await fs.mkdir(path.dirname(fakeGuard), { recursive:true });
    await fs.writeFile(fakeGuard, 'process.exit(0);\n');
    await assert.rejects(() => migrateHermesGatewayLaunchd({
      apply:false, agentId:'xiaod', label:fixture.label, plistPath:fixture.plistPath, launchAgentsRoot:fixture.root,
      guardedScriptPath:fakeGuard, validateRelease:fixture.validateRelease,
      readPlistLabel:async () => fixture.label, readProgramArguments:async () => ['/venv/bin/hermes', 'gateway', 'run'],
    }), /不是可验证的不可变 release/);

    const frozen = await frozenGuardRelease(context);
    const result = await migrateHermesGatewayLaunchd({
      apply:false, agentId:'xiaod', label:fixture.label, plistPath:fixture.plistPath, launchAgentsRoot:fixture.root,
      guardedScriptPath:frozen.guardPath,
      readPlistLabel:async () => fixture.label, readProgramArguments:async () => ['/venv/bin/hermes', 'gateway', 'run'],
    });
    assert.equal(result.mode, 'migration-dry-run');
    assert.equal(result.desiredArguments[1], frozen.guardPath);
  } finally {
    await fs.rm(fixture.base, { recursive:true, force:true });
    await fs.rm(fakeRoot, { recursive:true, force:true });
  }
});

test('回滚只接受本工具对应岗位、label、plist 的受控备份', async () => {
  const fixture = await launchdFixture();
  try {
    const original = await fs.readFile(fixture.plistPath, 'utf8');
    const migrated = await migrateHermesGatewayLaunchd({
      apply:true, agentId:'xiaod', label:fixture.label, plistPath:fixture.plistPath, launchAgentsRoot:fixture.root,
      guardedScriptPath:fixture.guardPath, validateRelease:fixture.validateRelease,
      readPlistLabel:async () => fixture.label, readProgramArguments:async () => ['/venv/bin/hermes', 'gateway', 'run'],
      writeProgramArguments:async (staging) => fs.writeFile(staging, 'changed'), lintPlist:async () => {}
    });
    const rollback = await migrateHermesGatewayLaunchd({
      apply:false, rollback:true, agentId:'xiaod', label:fixture.label, plistPath:fixture.plistPath, backupPath:migrated.backupPath, launchAgentsRoot:fixture.root,
      readPlistLabel:async () => fixture.label, lintPlist:async () => {}
    });
    assert.equal(rollback.mode, 'rollback-applied');
    assert.equal(await fs.readFile(fixture.plistPath, 'utf8'), original);
    await assert.rejects(() => migrateHermesGatewayLaunchd({ apply:false, rollback:true, agentId:'operator', label:fixture.label, plistPath:fixture.plistPath, backupPath:migrated.backupPath, launchAgentsRoot:fixture.root, readPlistLabel:async () => fixture.label }), /备份元数据与显式岗位/);
  } finally { await fs.rm(fixture.base, { recursive:true, force:true }); }
});

test('回滚拒绝被修改的备份内容', async () => {
  const fixture = await launchdFixture();
  try {
    const migrated = await migrateHermesGatewayLaunchd({
      apply:true, agentId:'xiaod', label:fixture.label, plistPath:fixture.plistPath, launchAgentsRoot:fixture.root,
      guardedScriptPath:fixture.guardPath, validateRelease:fixture.validateRelease,
      readPlistLabel:async () => fixture.label, readProgramArguments:async () => ['/venv/bin/hermes', 'gateway', 'run'],
      writeProgramArguments:async (staging) => fs.writeFile(staging, 'changed'), lintPlist:async () => {},
    });
    await fs.appendFile(migrated.backupPath, 'tampered');
    await assert.rejects(() => migrateHermesGatewayLaunchd({
      apply:false, rollback:true, agentId:'xiaod', label:fixture.label, plistPath:fixture.plistPath,
      backupPath:migrated.backupPath, launchAgentsRoot:fixture.root, readPlistLabel:async () => fixture.label,
    }), /完整性核对失败/);
  } finally { await fs.rm(fixture.base, { recursive:true, force:true }); }
});

test('apply 在暂存后拒绝目标文件或父目录被替换', async () => {
  const fixture = await launchdFixture();
  try {
    const replacement = path.join(fixture.base, 'replacement.plist');
    await assert.rejects(() => migrateHermesGatewayLaunchd({
      apply:true, agentId:'xiaod', label:fixture.label, plistPath:fixture.plistPath, launchAgentsRoot:fixture.root,
      guardedScriptPath:fixture.guardPath, validateRelease:fixture.validateRelease,
      readPlistLabel:async () => fixture.label, readProgramArguments:async () => ['/venv/bin/hermes', 'gateway', 'run'],
      writeProgramArguments:async (staging) => {
        await fs.writeFile(staging, 'changed');
        await fs.writeFile(replacement, 'replacement');
        await fs.rename(replacement, fixture.plistPath);
      }, lintPlist:async () => {},
    }), /迁移失败；原 plist 未被替换/);
    assert.equal(await fs.readFile(fixture.plistPath, 'utf8'), 'replacement');

    const nested = path.join(fixture.root, 'nested');
    const displaced = path.join(fixture.base, 'displaced-nested');
    await fs.mkdir(nested);
    const nestedPlist = path.join(nested, path.basename(fixture.plistPath));
    await fs.writeFile(nestedPlist, '<plist>nested</plist>\n');
    await assert.rejects(() => migrateHermesGatewayLaunchd({
      apply:true, agentId:'xiaod', label:fixture.label, plistPath:nestedPlist, launchAgentsRoot:fixture.root,
      guardedScriptPath:fixture.guardPath, validateRelease:fixture.validateRelease,
      readPlistLabel:async () => fixture.label, readProgramArguments:async () => ['/venv/bin/hermes', 'gateway', 'run'],
      writeProgramArguments:async (staging) => {
        await fs.writeFile(staging, 'changed');
        await fs.rename(nested, displaced);
        await fs.mkdir(nested);
        await fs.writeFile(nestedPlist, '<plist>replacement parent</plist>\n');
      }, lintPlist:async () => {},
    }), /迁移失败；原 plist 未被替换/);
    assert.equal(await fs.readFile(nestedPlist, 'utf8'), '<plist>replacement parent</plist>\n');
  } finally { await fs.rm(fixture.base, { recursive:true, force:true }); }
});

test('rollback 在暂存后拒绝备份被替换', async () => {
  const fixture = await launchdFixture();
  try {
    const migrated = await migrateHermesGatewayLaunchd({
      apply:true, agentId:'xiaod', label:fixture.label, plistPath:fixture.plistPath, launchAgentsRoot:fixture.root,
      guardedScriptPath:fixture.guardPath, validateRelease:fixture.validateRelease,
      readPlistLabel:async () => fixture.label, readProgramArguments:async () => ['/venv/bin/hermes', 'gateway', 'run'],
      writeProgramArguments:async (staging) => fs.writeFile(staging, 'changed'), lintPlist:async () => {},
    });
    const replacement = path.join(fixture.base, 'replacement-backup.plist');
    await assert.rejects(() => migrateHermesGatewayLaunchd({
      rollback:true, agentId:'xiaod', label:fixture.label, plistPath:fixture.plistPath,
      backupPath:migrated.backupPath, launchAgentsRoot:fixture.root,
      readPlistLabel:async () => fixture.label,
      lintPlist:async () => {
        await fs.copyFile(migrated.backupPath, replacement);
        await fs.rename(replacement, migrated.backupPath);
      },
    }), /回滚失败；当前 plist 未被替换/);
    assert.equal(await fs.readFile(fixture.plistPath, 'utf8'), 'changed');
  } finally { await fs.rm(fixture.base, { recursive:true, force:true }); }
});

async function launchdFixture() {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-launchd-')));
  const root = path.join(base, 'Library', 'LaunchAgents');
  const label = 'com.xiaod.hermes.gateway';
  const plistPath = path.join(root, `${label}.plist`);
  const releaseRoot = path.join(base, 'fixture-release');
  const guardPath = path.join(releaseRoot, 'integrations/hermes/scripts/start-hermes-gateway-guarded.mjs');
  const releaseHash = 'a'.repeat(64);
  await fs.mkdir(root, { recursive:true });
  await fs.mkdir(path.dirname(guardPath), { recursive:true });
  await fs.writeFile(plistPath, '<plist>original</plist>\n');
  await fs.writeFile(guardPath, 'process.exit(0);\n');
  await fs.writeFile(path.join(releaseRoot, 'release-manifest.json'), JSON.stringify({ releaseHash }));
  const validateRelease = async (candidate, expectedHash) => {
    assert.equal(candidate, releaseRoot);
    assert.equal(expectedHash, releaseHash);
    return { releaseRoot, releaseHash };
  };
  return { base, root, label, plistPath, releaseRoot, guardPath, validateRelease };
}

async function frozenGuardRelease(context) {
  const repoRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-frozen-guard-')));
  context.after(async () => {
    await makeWritable(repoRoot);
    await fs.rm(repoRoot, { recursive:true, force:true });
  });
  const directories = [
    'apps/ajun-runtime/src', 'apps/ajun-runtime/public', 'agents/ajun',
    'integrations/hermes/profiles', 'integrations/hermes/scripts',
    'integrations/paperclip/m5-content-pipeline/config', 'integrations/paperclip/m5-content-pipeline/src',
    'integrations/paperclip/plugins/content-autonomy/src', 'integrations/publishing/m5-publisher-gateway/src',
    'integrations/access', 'integrations/boom-monitor', 'integrations/m5-kernel/src',
    'packages/m5-contracts/src', 'packages/paperclip-client/src',
  ];
  await Promise.all(directories.map((directory) => fs.mkdir(path.join(repoRoot, directory), { recursive:true })));
  const files = new Map([
    ['.gitignore', '/apps/ajun-runtime/data/releases/\n'],
    ['apps/ajun-runtime/package.json', '{"name":"ajun-runtime","type":"module"}\n'],
    ['apps/ajun-runtime/package-lock.json', '{"lockfileVersion":3}\n'],
    ['apps/ajun-runtime/src/server.ts', 'export const server = true;\n'],
    ['apps/ajun-runtime/public/index.html', '<!doctype html>\n'],
    ['agents/ajun/manifest.json', '{"agentId":"ajun"}\n'],
    ['integrations/hermes/profiles/ajun.profile.json', '{"profileId":"ajun"}\n'],
    ['integrations/hermes/scripts/hermes-skill-state.py', '# fixture\n'],
    ['integrations/hermes/scripts/reconcile-hermes-skill-whitelist.mjs', 'export {};\n'],
    ['integrations/hermes/scripts/start-hermes-gateway-guarded.mjs', 'export {};\n'],
    ['integrations/paperclip/m5-content-pipeline/package.json', '{"name":"pipeline"}\n'],
    ['integrations/paperclip/m5-content-pipeline/package-lock.json', '{"lockfileVersion":3}\n'],
    ['integrations/paperclip/m5-content-pipeline/config/definition.json', '{}\n'],
    ['integrations/paperclip/m5-content-pipeline/src/index.ts', 'export {};\n'],
    ['integrations/paperclip/plugins/content-autonomy/package.json', '{"name":"content-autonomy"}\n'],
    ['integrations/paperclip/plugins/content-autonomy/package-lock.json', '{"lockfileVersion":3}\n'],
    ['integrations/paperclip/plugins/content-autonomy/src/index.ts', 'export {};\n'],
    ['integrations/publishing/m5-publisher-gateway/package.json', '{"name":"publisher"}\n'],
    ['integrations/publishing/m5-publisher-gateway/src/index.ts', 'export {};\n'],
    ['integrations/access/package.json', '{"name":"access"}\n'],
    ['integrations/boom-monitor/package.json', '{"name":"boom"}\n'],
    ['integrations/m5-kernel/package.json', '{"name":"kernel"}\n'],
    ['integrations/m5-kernel/src/index.ts', 'export {};\n'],
    ['packages/m5-contracts/package.json', '{"name":"contracts"}\n'],
    ['packages/m5-contracts/src/index.ts', 'export {};\n'],
    ['packages/paperclip-client/package.json', '{"name":"paperclip-client"}\n'],
    ['packages/paperclip-client/src/index.ts', 'export {};\n'],
  ]);
  for (const [relative, content] of files) {
    const absolute = path.join(repoRoot, relative);
    await fs.mkdir(path.dirname(absolute), { recursive:true });
    await fs.writeFile(absolute, content);
  }
  await execFile('git', ['init'], { cwd:repoRoot });
  await execFile('git', ['add', '--', '.'], { cwd:repoRoot });
  await execFile('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'fixture'], { cwd:repoRoot });
  const release = await freezeAjunRuntimeRelease({ repoRoot });
  return {
    guardPath:path.join(release.releaseRoot, 'integrations/hermes/scripts/start-hermes-gateway-guarded.mjs'),
  };
}

async function makeWritable(root) {
  const state = await fs.lstat(root).catch(() => null);
  if (!state) return;
  if (state.isDirectory() && !state.isSymbolicLink()) {
    await fs.chmod(root, 0o755);
    for (const name of await fs.readdir(root)) await makeWritable(path.join(root, name));
  } else if (state.isFile()) {
    await fs.chmod(root, 0o644);
  }
}

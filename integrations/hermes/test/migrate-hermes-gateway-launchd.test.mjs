import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateHermesGatewayLaunchd, parseLaunchdGatewayMigrationArgs } from '../scripts/migrate-hermes-gateway-launchd.mjs';

test('迁移只接受显式单岗位、label、plist 和 apply/rollback 二选一', () => {
  assert.deepEqual(parseLaunchdGatewayMigrationArgs([
    '--apply', '--agent', 'xiaod', '--label', 'com.xiaod.hermes.gateway', '--plist', '/tmp/Library/LaunchAgents/com.xiaod.hermes.gateway.plist'
  ]), { apply:true, rollback:false, agentId:'xiaod', label:'com.xiaod.hermes.gateway', plistPath:'/tmp/Library/LaunchAgents/com.xiaod.hermes.gateway.plist', backupPath:'', guardedScriptPath:'' });
  assert.throws(() => parseLaunchdGatewayMigrationArgs(['--apply', '--rollback', '--agent', 'xiaod', '--label', 'x', '--plist', '/x.plist']), /二选一/);
  assert.throws(() => parseLaunchdGatewayMigrationArgs(['--apply', '--agent', 'xiaod', '--label', 'x']), /--plist/);
  assert.throws(() => parseLaunchdGatewayMigrationArgs(['--rollback', '--agent', 'xiaod', '--label', 'x', '--plist', '/x.plist']), /--backup/);
});

test('apply 精确备份后在临时文件改 ProgramArguments、lint 并原子替换', async () => {
  const fixture = await launchdFixture();
  try {
    const original = await fs.readFile(fixture.plistPath, 'utf8');
    const result = await migrateHermesGatewayLaunchd({
      apply:true, agentId:'xiaod', label:fixture.label, plistPath:fixture.plistPath, launchAgentsRoot:fixture.root,
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
      launchAgentsRoot:fixture.root
    });
    assert.equal(result.mode, 'migration-applied');
    assert.match(await fs.readFile(fixture.plistPath, 'utf8'), /start-hermes-gateway-guarded\.mjs/);
  } finally { await fs.rm(fixture.base, { recursive:true, force:true }); }
});

test('拒绝非 Hermes gateway、label 不匹配、目录外或符号链接 plist', async () => {
  const fixture = await launchdFixture();
  try {
    await assert.rejects(() => migrateHermesGatewayLaunchd({ apply:true, agentId:'xiaod', label:fixture.label, plistPath:fixture.plistPath, launchAgentsRoot:fixture.root, readPlistLabel:async () => fixture.label, readProgramArguments:async () => ['/bin/sh', '-c', 'not gateway'] }), /不是 Hermes gateway run/);
    await assert.rejects(() => migrateHermesGatewayLaunchd({ apply:true, agentId:'xiaod', label:'wrong.label', plistPath:fixture.plistPath, launchAgentsRoot:fixture.root, readPlistLabel:async () => fixture.label, readProgramArguments:async () => ['/venv/bin/hermes', 'gateway', 'run'] }), /Label 与显式 --label 不匹配/);
    await assert.rejects(() => migrateHermesGatewayLaunchd({ apply:true, agentId:'xiaod', label:fixture.label, plistPath:path.join(fixture.base, 'outside.plist'), launchAgentsRoot:fixture.root }), /必须位于单一用户 LaunchAgents/);
    const linked = path.join(fixture.root, 'linked.plist');
    await fs.symlink(fixture.plistPath, linked);
    await assert.rejects(() => migrateHermesGatewayLaunchd({ apply:true, agentId:'xiaod', label:fixture.label, plistPath:linked, launchAgentsRoot:fixture.root }), /不是安全普通文件/);
  } finally { await fs.rm(fixture.base, { recursive:true, force:true }); }
});

test('回滚只接受本工具对应岗位、label、plist 的受控备份', async () => {
  const fixture = await launchdFixture();
  try {
    const original = await fs.readFile(fixture.plistPath, 'utf8');
    const migrated = await migrateHermesGatewayLaunchd({
      apply:true, agentId:'xiaod', label:fixture.label, plistPath:fixture.plistPath, launchAgentsRoot:fixture.root,
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

async function launchdFixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-launchd-'));
  const root = path.join(base, 'Library', 'LaunchAgents');
  const label = 'com.xiaod.hermes.gateway';
  const plistPath = path.join(root, `${label}.plist`);
  await fs.mkdir(root, { recursive:true });
  await fs.writeFile(plistPath, '<plist>original</plist>\n');
  return { base, root, label, plistPath };
}

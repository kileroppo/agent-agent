import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  HOST,
  INSTALL_CONFIRMATION,
  LABEL,
  PORT,
  ROLLBACK_CONFIRMATION,
  manageDisabledPublisherLaunchAgent,
  parseArguments,
  renderDisabledPublisherLaunchAgent,
} from '../scripts/manage-disabled-launch-agent.mjs';

test('LaunchAgent 固定 disabled、loopback 4390、npm serve 和私有日志目录', async (context) => {
  const fixture = await createFixture(context);
  const plist = renderFixturePlist(fixture);

  assert.match(plist, new RegExp(`<string>${LABEL}</string>`));
  assert.match(plist, /<key>M5_PUBLISHER_MODE<\/key>\n    <string>disabled<\/string>/);
  assert.match(plist, new RegExp(`<key>M5_PUBLISHER_HOST</key>\\n    <string>${HOST.replaceAll('.', '\\.')}</string>`));
  assert.match(plist, new RegExp(`<key>M5_PUBLISHER_PORT</key>\\n    <string>${PORT}</string>`));
  assert.match(plist, /<string>run<\/string>\n    <string>serve<\/string>/);
  assert.match(plist, new RegExp(`<key>WorkingDirectory</key>\\n  <string>${escapeRegex(fixture.gatewayRoot)}</string>`));
  assert.match(plist, /work\/m5-publisher-gateway\/runtime\/stdout\.log/);
  assert.doesNotMatch(plist, /fake|real:douyin|real:xiaohongshu|approvedConnectorMap/);
});

test('默认 dry-run 只报告计划，不写 plist、不建 runtime、不调用变更命令', async (context) => {
  const fixture = await createFixture(context);
  const commands = [];
  const result = await manage(fixture, {
    runCommand:fakeLaunchctl(commands, { loaded:false }),
  });

  assert.equal(result.mode, 'dry-run');
  assert.equal(result.readOnly, true);
  assert.equal(result.publisherMode, 'disabled');
  assert.deepEqual(result.plannedActions, [
    'create-private-runtime-directory',
    'write-private-disabled-loopback-plist',
    'bootstrap-and-kickstart',
    'health-check-disabled-runtime',
  ]);
  assert.equal(await exists(fixture.plistPath), false);
  assert.equal(await exists(fixture.runtimeDirectory), false);
  assert.equal(commands.filter((item) => item.args[0] !== 'print').length, 0);
  assert.equal(result.rollback.action, 'uninstall-launch-agent-preserve-logs');
});

test('execute 缺显式确认时不安装、不启动', async (context) => {
  const fixture = await createFixture(context);
  const commands = [];
  await assert.rejects(
    manage(fixture, {
      mode:'execute',
      confirmation:'',
      runCommand:fakeLaunchctl(commands, { loaded:false }),
    }),
    (error) => error.code === 'launch_agent_confirmation_required',
  );
  assert.equal(await exists(fixture.plistPath), false);
  assert.equal(await exists(fixture.runtimeDirectory), false);
  assert.equal(commands.filter((item) => item.args[0] !== 'print').length, 0);
});

test('execute 写 0600 plist、0700 runtime 并只 bootstrap 同一 label', async (context) => {
  const fixture = await createFixture(context);
  const commands = [];
  const result = await manage(fixture, {
    mode:'execute',
    confirmation:INSTALL_CONFIRMATION,
    runCommand:fakeLaunchctl(commands, { loaded:false }),
    probeHealth:healthyDisabledProbe,
  });

  assert.equal(result.status, 'installed');
  assert.equal(result.plistWritten, true);
  assert.equal((await fs.stat(fixture.plistPath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(fixture.runtimeDirectory)).mode & 0o777, 0o700);
  const content = await fs.readFile(fixture.plistPath, 'utf8');
  assert.equal(content, renderFixturePlist(fixture));
  assert.deepEqual(
    commands.filter((item) => item.args[0] !== 'print').map((item) => item.args[0]),
    ['bootstrap', 'enable', 'kickstart'],
  );
  assert.ok(commands.every((item) => item.args.join(' ').includes(LABEL) || item.args[0] === 'bootstrap'));
  assert.equal(result.health.valid, true);
});

test('同 label、同配置且已加载时 execute 幂等 no-op', async (context) => {
  const fixture = await createFixture(context);
  await fs.writeFile(fixture.plistPath, renderFixturePlist(fixture), { mode:0o600 });
  const commands = [];
  const result = await manage(fixture, {
    mode:'execute',
    confirmation:INSTALL_CONFIRMATION,
    runCommand:fakeLaunchctl(commands, { loaded:true, pid:43210 }),
    probeHealth:healthyDisabledProbe,
  });

  assert.equal(result.status, 'already_installed');
  assert.equal(result.plistWritten, false);
  assert.equal(result.serviceAlreadyLoaded, true);
  assert.equal(commands.filter((item) => item.args[0] !== 'print').length, 0);
});

test('同 label 已加载但 health 失效时，execute 只 kickstart 一次并重新核验', async (context) => {
  const fixture = await createFixture(context);
  await fs.writeFile(fixture.plistPath, renderFixturePlist(fixture), { mode:0o600 });
  const commands = [];
  let probes = 0;
  const result = await manage(fixture, {
    mode:'execute',
    confirmation:INSTALL_CONFIRMATION,
    runCommand:fakeLaunchctl(commands, { loaded:true, pid:43210 }),
    probeHealth:async () => {
      probes += 1;
      return probes === 1
        ? { reachable:false, valid:false }
        : healthyDisabledProbe();
    },
  });

  assert.equal(result.status, 'restarted');
  assert.equal(result.restartedUnhealthyService, true);
  assert.deepEqual(
    commands.filter((item) => item.args[0] !== 'print').map((item) => item.args[0]),
    ['kickstart'],
  );
  assert.equal(result.health.valid, true);
});

test('拒绝符号链接 plist 和宽权限 plist', async (context) => {
  const symlinkFixture = await createFixture(context, 'symlink');
  const target = path.join(symlinkFixture.root, 'foreign.plist');
  await fs.writeFile(target, renderFixturePlist(symlinkFixture), { mode:0o600 });
  await fs.symlink(target, symlinkFixture.plistPath);
  await assert.rejects(
    manage(symlinkFixture),
    (error) => error.code === 'unsafe_launch_agent_plist',
  );

  const wideFixture = await createFixture(context, 'wide');
  await fs.writeFile(wideFixture.plistPath, renderFixturePlist(wideFixture), { mode:0o644 });
  await fs.chmod(wideFixture.plistPath, 0o644);
  await assert.rejects(
    manage(wideFixture),
    (error) => error.code === 'launch_agent_permissions_too_wide',
  );
});

test('拒绝同 label 的非 loopback 或不同配置，不覆盖未知 plist', async (context) => {
  const fixture = await createFixture(context);
  const unsafe = renderFixturePlist(fixture).replace(
    '<key>M5_PUBLISHER_HOST</key>\n    <string>127.0.0.1</string>',
    '<key>M5_PUBLISHER_HOST</key>\n    <string>0.0.0.0</string>',
  );
  await fs.writeFile(fixture.plistPath, unsafe, { mode:0o600 });
  const commands = [];
  await assert.rejects(
    manage(fixture, {
      mode:'execute',
      confirmation:INSTALL_CONFIRMATION,
      runCommand:fakeLaunchctl(commands, { loaded:false }),
    }),
    (error) => error.code === 'launch_agent_config_conflict',
  );
  assert.equal(await fs.readFile(fixture.plistPath, 'utf8'), unsafe);
  assert.equal(commands.filter((item) => item.args[0] !== 'print').length, 0);
});

test('同 label 已加载但缺少受管 plist 时拒绝接管或卸载', async (context) => {
  const fixture = await createFixture(context);
  const commands = [];
  const runCommand = fakeLaunchctl(commands, { loaded:true, pid:45678 });
  await assert.rejects(
    manage(fixture, {
      mode:'execute',
      confirmation:INSTALL_CONFIRMATION,
      runCommand,
    }),
    (error) => error.code === 'launch_agent_config_conflict',
  );
  await assert.rejects(
    manage(fixture, {
      mode:'rollback',
      confirmation:ROLLBACK_CONFIRMATION,
      runCommand,
    }),
    (error) => error.code === 'launch_agent_config_conflict',
  );
  assert.equal(await exists(fixture.plistPath), false);
  assert.equal(commands.filter((item) => item.args[0] !== 'print').length, 0);
});

test('status 只读返回 config、launchctl 和 disabled health', async (context) => {
  const fixture = await createFixture(context);
  await fs.writeFile(fixture.plistPath, renderFixturePlist(fixture), { mode:0o600 });
  const commands = [];
  const result = await manage(fixture, {
    mode:'status',
    runCommand:fakeLaunchctl(commands, { loaded:true, pid:34567 }),
    probeHealth:healthyDisabledProbe,
  });

  assert.equal(result.readOnly, true);
  assert.deepEqual(result.config, { kind:'managed', exact:true });
  assert.deepEqual(result.service, { loaded:true, pid:34567 });
  assert.equal(result.health.valid, true);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].args[0], 'print');
});

test('rollback 要求精确确认，卸载受管 label 并保留日志', async (context) => {
  const fixture = await createFixture(context);
  await fs.writeFile(fixture.plistPath, renderFixturePlist(fixture), { mode:0o600 });
  await fs.mkdir(fixture.runtimeDirectory, { recursive:true, mode:0o700 });
  await fs.writeFile(path.join(fixture.runtimeDirectory, 'stdout.log'), 'audit\n');
  const commands = [];

  await assert.rejects(
    manage(fixture, {
      mode:'rollback',
      runCommand:fakeLaunchctl(commands, { loaded:true }),
    }),
    (error) => error.code === 'launch_agent_confirmation_required',
  );
  assert.equal(await exists(fixture.plistPath), true);

  const result = await manage(fixture, {
    mode:'rollback',
    confirmation:ROLLBACK_CONFIRMATION,
    runCommand:fakeLaunchctl(commands, { loaded:true }),
  });
  assert.equal(result.status, 'uninstalled');
  assert.equal(result.logsPreserved, true);
  assert.equal(await exists(fixture.plistPath), false);
  assert.equal(await fs.readFile(path.join(fixture.runtimeDirectory, 'stdout.log'), 'utf8'), 'audit\n');
  assert.ok(commands.some((item) => item.args[0] === 'bootout'));
});

test('CLI 只接受四种模式，默认 dry-run', () => {
  assert.deepEqual(parseArguments([]), { mode:'dry-run', confirmation:'' });
  assert.deepEqual(parseArguments(['--mode', 'status']), { mode:'status', confirmation:'' });
  assert.throws(() => parseArguments(['--mode', 'real']), /mode 只允许/);
  assert.throws(() => parseArguments(['--host', '0.0.0.0']), /未知参数/);
});

async function createFixture(context, suffix = 'default') {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), `m5-publisher-launch-${suffix}-`));
  const root = await fs.realpath(created);
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const gatewayRoot = path.join(root, 'integrations/publishing/m5-publisher-gateway');
  const scripts = path.join(gatewayRoot, 'scripts');
  const homeDir = path.join(root, 'home');
  const launchAgents = path.join(homeDir, 'Library/LaunchAgents');
  const bin = path.join(root, 'bin');
  await fs.mkdir(scripts, { recursive:true });
  await fs.mkdir(launchAgents, { recursive:true });
  await fs.mkdir(bin, { recursive:true });
  await fs.mkdir(path.join(root, 'work'), { recursive:true });
  await fs.writeFile(path.join(gatewayRoot, 'package.json'), JSON.stringify({
    scripts:{ serve:'node scripts/run-service.mjs' },
  }));
  await fs.writeFile(path.join(scripts, 'run-service.mjs'), 'process.exit(0);\n');
  await fs.writeFile(path.join(scripts, 'manage-disabled-launch-agent.mjs'), '// fixture\n');
  const nodeExecutable = path.join(bin, 'node');
  const npmCliPath = path.join(bin, 'npm-cli.js');
  await fs.writeFile(nodeExecutable, '#!/bin/sh\nexit 0\n', { mode:0o700 });
  await fs.writeFile(npmCliPath, '#!/bin/sh\nexit 0\n', { mode:0o700 });
  await fs.chmod(nodeExecutable, 0o700);
  await fs.chmod(npmCliPath, 0o700);
  return {
    root,
    gatewayRoot,
    homeDir,
    launchAgents,
    nodeExecutable,
    npmCliPath,
    plistPath:path.join(launchAgents, `${LABEL}.plist`),
    runtimeDirectory:path.join(root, 'work/m5-publisher-gateway/runtime'),
  };
}

function renderFixturePlist(fixture) {
  return renderDisabledPublisherLaunchAgent({
    gatewayRoot:fixture.gatewayRoot,
    nodeExecutable:fixture.nodeExecutable,
    npmCliPath:fixture.npmCliPath,
    stdoutPath:path.join(fixture.runtimeDirectory, 'stdout.log'),
    stderrPath:path.join(fixture.runtimeDirectory, 'stderr.log'),
  });
}

function manage(fixture, options = {}) {
  return manageDisabledPublisherLaunchAgent({
    gatewayRoot:fixture.gatewayRoot,
    homeDir:fixture.homeDir,
    uid:501,
    nodeExecutable:fixture.nodeExecutable,
    npmCliPath:fixture.npmCliPath,
    runCommand:fakeLaunchctl([], { loaded:false }),
    probeHealth:async () => ({ reachable:false, valid:false }),
    ...options,
  });
}

function fakeLaunchctl(commands, { loaded, pid = null }) {
  return async (command, args) => {
    commands.push({ command, args:[...args] });
    if (args[0] === 'print') {
      return loaded
        ? { code:0, stdout:pid ? `pid = ${pid}\n` : 'state = running\n', stderr:'' }
        : { code:113, stdout:'', stderr:'not found' };
    }
    return { code:0, stdout:'', stderr:'' };
  };
}

async function healthyDisabledProbe() {
  return {
    reachable:true,
    httpStatus:200,
    valid:true,
    body:{
      status:'disabled',
      mode:'disabled',
      hardStop:false,
      realConnectorsConfigured:false,
    },
  };
}

async function exists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

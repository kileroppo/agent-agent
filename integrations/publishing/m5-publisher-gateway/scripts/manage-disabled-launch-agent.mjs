#!/usr/bin/env node

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);

export const LABEL = 'ai.agent-army.m5-publisher-gateway';
export const HOST = '127.0.0.1';
export const PORT = 4390;
export const INSTALL_CONFIRMATION = 'I_ACCEPT_INSTALL_M5_PUBLISHER_DISABLED_LAUNCH_AGENT';
export const ROLLBACK_CONFIRMATION = 'I_ACCEPT_UNINSTALL_M5_PUBLISHER_DISABLED_LAUNCH_AGENT';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_GATEWAY_ROOT = path.resolve(SCRIPT_DIRECTORY, '..');
const SAFE_PATH = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin';

export async function manageDisabledPublisherLaunchAgent({
  mode = 'dry-run',
  confirmation = '',
  gatewayRoot = DEFAULT_GATEWAY_ROOT,
  homeDir = os.homedir(),
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
  nodeExecutable,
  npmCliPath,
  runCommand = defaultRunCommand,
  probeHealth = defaultProbeHealth,
} = {}) {
  const normalizedMode = normalizeMode(mode);
  if (!Number.isInteger(uid) || uid < 0) {
    throw coded('invalid_launch_agent_uid', '无法确定当前 macOS 用户 UID。');
  }
  if (!path.isAbsolute(homeDir)) {
    throw coded('invalid_home_directory', 'LaunchAgent HOME 必须是绝对路径。');
  }

  const resolved = await resolveLayout({
    gatewayRoot,
    homeDir,
    nodeExecutable,
    npmCliPath,
  });
  const plist = renderDisabledPublisherLaunchAgent({
    gatewayRoot:resolved.gatewayRoot,
    nodeExecutable:resolved.nodeExecutable,
    npmCliPath:resolved.npmCliPath,
    stdoutPath:resolved.stdoutPath,
    stderrPath:resolved.stderrPath,
  });
  const domain = `gui/${uid}`;
  const service = `${domain}/${LABEL}`;
  const rollback = rollbackAction(resolved.scriptPath, resolved.nodeExecutable);
  const existing = await inspectExistingPlist(resolved.plistPath, plist);
  const loaded = await inspectLoadedService(runCommand, service);

  if (normalizedMode === 'status') {
    return {
      mode:'status',
      readOnly:true,
      label:LABEL,
      plistPath:resolved.plistPath,
      config:existing,
      service:loaded,
      health:await safeProbeHealth(probeHealth),
      rollback,
    };
  }

  if (normalizedMode === 'dry-run') {
    return {
      mode:'dry-run',
      readOnly:true,
      label:LABEL,
      host:HOST,
      port:PORT,
      publisherMode:'disabled',
      workingDirectory:resolved.gatewayRoot,
      runtimeDirectory:resolved.runtimeDirectory,
      plistPath:resolved.plistPath,
      config:existing,
      service:loaded,
      plannedActions:planInstall(existing, loaded),
      rollback,
    };
  }

  if (normalizedMode === 'rollback') {
    requireConfirmation(confirmation, ROLLBACK_CONFIRMATION, '卸载');
    if (existing.kind === 'conflict' || loaded.loaded && existing.kind !== 'managed') {
      throw coded(
        'launch_agent_config_conflict',
        '现有 LaunchAgent 不是受管的 disabled/loopback 配置，或同 label 进程缺少受管 plist；拒绝卸载未知服务。',
      );
    }
    if (loaded.loaded) {
      await runCommand('/bin/launchctl', ['bootout', service]);
    }
    if (existing.kind === 'managed') {
      await fs.unlink(resolved.plistPath);
    }
    return {
      mode:'rollback',
      status:loaded.loaded || existing.kind === 'managed' ? 'uninstalled' : 'already_absent',
      label:LABEL,
      plistRemoved:existing.kind === 'managed',
      serviceBootedOut:loaded.loaded,
      logsPreserved:true,
      runtimeDirectory:resolved.runtimeDirectory,
    };
  }

  requireConfirmation(confirmation, INSTALL_CONFIRMATION, '安装');
  if (existing.kind === 'conflict' || loaded.loaded && existing.kind !== 'managed') {
    throw coded(
      'launch_agent_config_conflict',
      '同 label 已存在不同、不安全或缺少受管 plist 的配置；先核对，拒绝覆盖。',
    );
  }

  let wrotePlist = false;
  try {
    await ensurePrivateRuntimeDirectory(resolved.runtimeDirectory);
    if (existing.kind === 'absent') {
      await atomicWritePrivateFile(resolved.plistPath, plist);
      wrotePlist = true;
    }
    if (!loaded.loaded) {
      await runCommand('/bin/launchctl', ['bootstrap', domain, resolved.plistPath]);
      await runCommand('/bin/launchctl', ['enable', service], { allowFailure:true });
      await runCommand('/bin/launchctl', ['kickstart', '-k', service]);
    }
    let health = await safeProbeHealth(probeHealth);
    let restartedUnhealthyService = false;
    if (loaded.loaded && !health.valid) {
      await runCommand('/bin/launchctl', ['kickstart', '-k', service]);
      restartedUnhealthyService = true;
      health = await waitForHealthyDisabled(probeHealth);
    } else if (!loaded.loaded) {
      health = await waitForHealthyDisabled(probeHealth);
    }
    if (!health.valid) {
      throw coded(
        'publisher_disabled_health_failed',
        'Publisher LaunchAgent 已加载，但 disabled health 未通过；按 recoveryAction 卸载并保留日志。',
      );
    }
    return {
      mode:'execute',
      status:existing.kind === 'managed' && loaded.loaded
        ? restartedUnhealthyService ? 'restarted' : 'already_installed'
        : 'installed',
      label:LABEL,
      plistPath:resolved.plistPath,
      plistWritten:wrotePlist,
      serviceAlreadyLoaded:loaded.loaded,
      restartedUnhealthyService,
      health,
      rollback,
    };
  } catch (error) {
    error.recoveryAction = rollback;
    throw error;
  }
}

export function renderDisabledPublisherLaunchAgent({
  gatewayRoot,
  nodeExecutable,
  npmCliPath,
  stdoutPath,
  stderrPath,
}) {
  for (const [name, value] of Object.entries({
    gatewayRoot,
    nodeExecutable,
    npmCliPath,
    stdoutPath,
    stderrPath,
  })) {
    if (!path.isAbsolute(String(value || ''))) {
      throw coded('invalid_launch_agent_path', `${name} 必须是绝对路径。`);
    }
  }
  const args = [nodeExecutable, npmCliPath, 'run', 'serve'];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${xml(LABEL)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...args.map((value) => `    <string>${xml(value)}</string>`),
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  <string>${xml(gatewayRoot)}</string>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>M5_PUBLISHER_MODE</key>',
    '    <string>disabled</string>',
    '    <key>M5_PUBLISHER_HOST</key>',
    `    <string>${HOST}</string>`,
    '    <key>M5_PUBLISHER_PORT</key>',
    `    <string>${PORT}</string>`,
    '    <key>PATH</key>',
    `    <string>${SAFE_PATH}</string>`,
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>ProcessType</key>',
    '  <string>Background</string>',
    '  <key>ThrottleInterval</key>',
    '  <integer>5</integer>',
    '  <key>Umask</key>',
    '  <integer>63</integer>',
    '  <key>StandardOutPath</key>',
    `  <string>${xml(stdoutPath)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xml(stderrPath)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export function validateManagedPlist(content, expectedContent) {
  if (content === expectedContent) return { kind:'managed', exact:true };
  const required = [
    `<string>${LABEL}</string>`,
    '<key>M5_PUBLISHER_MODE</key>\n    <string>disabled</string>',
    `<key>M5_PUBLISHER_HOST</key>\n    <string>${HOST}</string>`,
    `<key>M5_PUBLISHER_PORT</key>\n    <string>${PORT}</string>`,
  ];
  if (!required.every((item) => content.includes(item))) {
    return { kind:'conflict', exact:false };
  }
  return { kind:'conflict', exact:false };
}

export function parseArguments(argv) {
  const output = { mode:'dry-run', confirmation:'' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--mode') {
      output.mode = requireValue(argv[++index], '--mode');
      continue;
    }
    if (value === '--confirm') {
      output.confirmation = requireValue(argv[++index], '--confirm');
      continue;
    }
    throw coded('unknown_launch_agent_argument', `未知参数：${value}`);
  }
  output.mode = normalizeMode(output.mode);
  return output;
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const args = parseArguments(argv);
  const result = await manageDisabledPublisherLaunchAgent({ ...options, ...args });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

async function resolveLayout({
  gatewayRoot,
  homeDir,
  nodeExecutable,
  npmCliPath,
}) {
  const canonicalGatewayRoot = await canonicalDirectory(gatewayRoot, 'Publisher Gateway 工作目录');
  await assertNotWritableByOthers(canonicalGatewayRoot, 'Publisher Gateway 工作目录');
  await assertRegularFile(
    path.join(canonicalGatewayRoot, 'package.json'),
    'Publisher Gateway package.json',
  );
  await assertRegularFile(
    path.join(canonicalGatewayRoot, 'scripts/run-service.mjs'),
    'Publisher Gateway serve 脚本',
  );
  const packageJson = JSON.parse(
    await fs.readFile(path.join(canonicalGatewayRoot, 'package.json'), 'utf8'),
  );
  if (packageJson?.scripts?.serve !== 'node scripts/run-service.mjs') {
    throw coded('publisher_serve_contract_changed', 'npm serve 不再指向受审核的 run-service.mjs。');
  }

  const launchAgentsDirectory = await canonicalDirectory(
    path.join(homeDir, 'Library/LaunchAgents'),
    'LaunchAgents 目录',
  );
  await assertNotWritableByOthers(launchAgentsDirectory, 'LaunchAgents 目录');
  const runtime = await resolveRuntimeExecutables({ nodeExecutable, npmCliPath });
  const repositoryRoot = path.resolve(canonicalGatewayRoot, '../../..');
  const canonicalRepositoryRoot = await canonicalDirectory(repositoryRoot, '仓库根目录');
  const runtimeDirectory = path.join(
    canonicalRepositoryRoot,
    'work/m5-publisher-gateway/runtime',
  );
  await assertPathTreeHasNoSymlink(
    canonicalRepositoryRoot,
    path.dirname(runtimeDirectory),
    { allowMissing:true },
  );
  const scriptPath = path.join(canonicalGatewayRoot, 'scripts/manage-disabled-launch-agent.mjs');
  return {
    gatewayRoot:canonicalGatewayRoot,
    nodeExecutable:runtime.nodeExecutable,
    npmCliPath:runtime.npmCliPath,
    runtimeDirectory,
    stdoutPath:path.join(runtimeDirectory, 'stdout.log'),
    stderrPath:path.join(runtimeDirectory, 'stderr.log'),
    plistPath:path.join(launchAgentsDirectory, `${LABEL}.plist`),
    scriptPath,
  };
}

async function resolveRuntimeExecutables({ nodeExecutable, npmCliPath }) {
  const nodeCandidate = nodeExecutable || process.execPath;
  const npmCandidate = npmCliPath
    || process.env.npm_execpath
    || await locateNpmCli();
  const canonicalNode = await canonicalFile(nodeCandidate, 'Node 可执行文件');
  const canonicalNpm = await canonicalFile(npmCandidate, 'npm CLI');
  await assertExecutable(canonicalNode, 'Node 可执行文件');
  await assertExecutable(canonicalNpm, 'npm CLI');
  return { nodeExecutable:canonicalNode, npmCliPath:canonicalNpm };
}

async function locateNpmCli() {
  const { stdout } = await execFileAsync('/usr/bin/which', ['npm'], {
    encoding:'utf8',
    maxBuffer:64 * 1024,
  });
  const npmExecutable = stdout.trim();
  if (!npmExecutable) throw coded('npm_not_found', '找不到 npm。');
  return fs.realpath(npmExecutable);
}

async function inspectExistingPlist(plistPath, expectedContent) {
  const stat = await lstatOrNull(plistPath);
  if (!stat) return { kind:'absent', exact:false };
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw coded('unsafe_launch_agent_plist', 'LaunchAgent plist 必须是普通文件，拒绝符号链接。');
  }
  if ((stat.mode & 0o077) !== 0) {
    throw coded('launch_agent_permissions_too_wide', 'LaunchAgent plist 必须是 0600，拒绝组或其他用户权限。');
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw coded('launch_agent_owner_mismatch', 'LaunchAgent plist 不属于当前用户。');
  }
  const content = await fs.readFile(plistPath, 'utf8');
  return validateManagedPlist(content, expectedContent);
}

async function inspectLoadedService(runCommand, service) {
  const result = await runCommand('/bin/launchctl', ['print', service], { allowFailure:true });
  if (result.code !== 0) return { loaded:false, pid:null };
  const pid = Number(String(result.stdout || '').match(/\bpid\s*=\s*(\d+)/)?.[1]);
  return { loaded:true, pid:Number.isInteger(pid) ? pid : null };
}

function planInstall(existing, loaded) {
  if (existing.kind === 'conflict') {
    return ['refuse-config-conflict', 'run-explicit-rollback-after-review'];
  }
  if (existing.kind === 'managed' && loaded.loaded) return ['no-op-already-installed'];
  if (existing.kind === 'managed') return ['bootstrap-existing-private-plist', 'health-check-disabled-runtime'];
  return [
    'create-private-runtime-directory',
    'write-private-disabled-loopback-plist',
    'bootstrap-and-kickstart',
    'health-check-disabled-runtime',
  ];
}

async function ensurePrivateRuntimeDirectory(directory) {
  const parent = path.dirname(directory);
  const parentStat = await lstatOrNull(parent);
  if (parentStat?.isSymbolicLink()) {
    throw coded('unsafe_runtime_directory', 'Publisher runtime 父目录不能是符号链接。');
  }
  await fs.mkdir(directory, { recursive:true, mode:0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw coded('unsafe_runtime_directory', 'Publisher runtime 目录必须是普通目录。');
  }
  await fs.chmod(directory, 0o700);
}

async function atomicWritePrivateFile(target, content) {
  const temporary = `${target}.${process.pid}.${cryptoRandom()}.tmp`;
  try {
    await fs.writeFile(temporary, content, { encoding:'utf8', mode:0o600, flag:'wx' });
    await fs.link(temporary, target);
    await fs.unlink(temporary);
    await fs.chmod(target, 0o600);
  } finally {
    await fs.rm(temporary, { force:true }).catch(() => undefined);
  }
}

async function canonicalDirectory(input, label) {
  const absolute = path.resolve(String(input || ''));
  const stat = await fs.lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw coded('unsafe_launch_agent_path', `${label} 必须是非符号链接目录。`);
  }
  const canonical = await fs.realpath(absolute);
  if (canonical !== absolute) {
    throw coded('unsafe_launch_agent_path', `${label} 路径包含符号链接。`);
  }
  return canonical;
}

async function canonicalFile(input, label) {
  const absolute = path.resolve(String(input || ''));
  const canonical = await fs.realpath(absolute);
  if (canonical !== absolute) {
    throw coded('unsafe_launch_agent_path', `${label} 必须使用规范化非符号链接路径。`);
  }
  await assertRegularFile(canonical, label);
  return canonical;
}

async function assertRegularFile(file, label) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw coded('unsafe_launch_agent_path', `${label} 必须是普通文件。`);
  }
  await assertNotWritableByOthers(file, label);
}

async function assertExecutable(file, label) {
  const stat = await fs.stat(file);
  if ((stat.mode & 0o111) === 0) {
    throw coded('runtime_not_executable', `${label} 不可执行。`);
  }
}

async function assertNotWritableByOthers(target, label) {
  const stat = await fs.stat(target);
  if ((stat.mode & 0o022) !== 0) {
    throw coded('unsafe_writable_path', `${label} 不能允许组或其他用户写入。`);
  }
}

async function assertPathTreeHasNoSymlink(root, target, { allowMissing = false } = {}) {
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw coded('unsafe_runtime_directory', 'Publisher runtime 目录逃逸仓库。');
  }
  let cursor = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const stat = await lstatOrNull(cursor);
    if (!stat) {
      if (allowMissing) continue;
      throw coded('unsafe_runtime_directory', `目录不存在：${cursor}`);
    }
    if (stat.isSymbolicLink()) {
      throw coded('unsafe_runtime_directory', `目录包含符号链接：${cursor}`);
    }
  }
}

async function defaultRunCommand(command, args, { allowFailure = false } = {}) {
  try {
    const result = await execFileAsync(command, args, {
      encoding:'utf8',
      maxBuffer:1024 * 1024,
    });
    return { code:0, stdout:result.stdout, stderr:result.stderr };
  } catch (error) {
    const result = {
      code:Number.isInteger(error?.code) ? error.code : 1,
      stdout:String(error?.stdout || ''),
      stderr:String(error?.stderr || error?.message || ''),
    };
    if (allowFailure) return result;
    throw coded('launchctl_failed', `${command} ${args.join(' ')} 失败：${result.stderr.trim()}`);
  }
}

async function defaultProbeHealth() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`http://${HOST}:${PORT}/health`, {
      method:'GET',
      signal:controller.signal,
    });
    const body = await response.json();
    return {
      reachable:true,
      httpStatus:response.status,
      valid:response.status === 200
        && body?.status === 'disabled'
        && body?.mode === 'disabled'
        && body?.realConnectorsConfigured === false,
      body,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function safeProbeHealth(probeHealth) {
  try {
    return await probeHealth();
  } catch (error) {
    return {
      reachable:false,
      valid:false,
      errorCode:String(error?.name || error?.code || 'health_unavailable'),
    };
  }
}

async function waitForHealthyDisabled(probeHealth, attempts = 8) {
  let result = { reachable:false, valid:false, errorCode:'health_unavailable' };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    result = await safeProbeHealth(probeHealth);
    if (result.valid) return result;
    if (attempt + 1 < attempts) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  return result;
}

function rollbackAction(scriptPath, nodeExecutable) {
  return {
    action:'uninstall-launch-agent-preserve-logs',
    command:nodeExecutable,
    args:[
      scriptPath,
      '--mode',
      'rollback',
      '--confirm',
      ROLLBACK_CONFIRMATION,
    ],
  };
}

function normalizeMode(value) {
  const mode = String(value || 'dry-run').trim().toLowerCase();
  if (!['dry-run', 'execute', 'status', 'rollback'].includes(mode)) {
    throw coded('invalid_launch_agent_mode', 'mode 只允许 dry-run、execute、status 或 rollback。');
  }
  return mode;
}

function requireConfirmation(actual, expected, action) {
  if (actual !== expected) {
    throw coded(
      'launch_agent_confirmation_required',
      `${action}需要显式确认：--confirm ${expected}`,
    );
  }
}

function requireValue(value, option) {
  if (!value || value.startsWith('--')) {
    throw coded('launch_agent_argument_missing', `${option} 缺少值。`);
  }
  return value;
}

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function cryptoRandom() {
  return crypto.randomUUID();
}

async function lstatOrNull(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${String(error?.code || 'publisher_launch_agent_failed')}: ${String(error?.message || error)}\n`);
    if (error?.recoveryAction) {
      process.stderr.write(`${JSON.stringify({ recoveryAction:error.recoveryAction })}\n`);
    }
    process.exitCode = 1;
  });
}

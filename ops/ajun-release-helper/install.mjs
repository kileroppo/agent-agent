#!/usr/bin/env node

import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const LABEL = 'ai.agent-army.release-helper';
const BUNDLE_FILES = [
  'apps/ajun-runtime/scripts/manage-immutable-runtime-release.mjs',
  'apps/ajun-runtime/src/runtime-source-root.ts',
  'ops/ajun-release-helper/release-coordinator.mjs',
  'ops/ajun-release-helper/server.mjs',
  'ops/ajun-release-helper/system-adapter.mjs',
].sort();

export async function installReleaseHelper({ repositoryRoot, homeDir = os.homedir(), nodePath = process.execPath, runCommand = defaultRunCommand } = {}) {
  if (!repositoryRoot) throw new Error('必须提供 --repository-root');
  const repo = await fs.realpath(path.resolve(repositoryRoot));
  const bundleHash = await hashBundle(repo);
  const installParent = path.join(homeDir, '.agent-army', 'release-helper');
  const bundleRoot = path.join(installParent, `bundle-${bundleHash.slice(0, 16)}`);
  const helperRoot = path.join(bundleRoot, 'ops', 'ajun-release-helper');
  const stateDir = path.join(homeDir, '.agent-army', 'state', 'ajun-release-helper');
  const socketPath = path.join(stateDir, 'release-helper.sock');
  const configPath = path.join(stateDir, 'config.json');
  const plistPath = path.join(homeDir, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  await fs.mkdir(installParent, { recursive:true, mode:0o700 });
  await fs.mkdir(stateDir, { recursive:true, mode:0o700 });
  await installBundle(repo, bundleRoot, bundleHash);
  const config = {
    repositoryRoot:repo,
    mainPlist:path.join(homeDir, 'Library', 'LaunchAgents', 'ai.agent-army.ajun-runtime.plist'),
    stateDir,
    deployRoot:path.join(homeDir, '.agent-army', 'runtime-releases'),
    sourceParent:path.join(homeDir, '.agent-army', 'runtime-sources'),
    socketPath,
    label:'ai.agent-army.ajun-runtime',
    appPort:4321,
  };
  await writePrivateJson(configPath, config);
  const plist = buildLaunchAgentPlist({
    nodePath,
    serverPath:path.join(helperRoot, 'server.mjs'),
    configPath,
    workingDirectory:helperRoot,
    stdoutPath:path.join(stateDir, 'helper.log'),
    stderrPath:path.join(stateDir, 'helper.error.log'),
  });
  const temporary = `${plistPath}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(plistPath), { recursive:true, mode:0o700 });
  await fs.writeFile(temporary, plist, { mode:0o600 });
  await fs.chmod(temporary, 0o600);
  await runCommand('plutil', ['-lint', temporary]);
  await fs.rename(temporary, plistPath);
  const domain = `gui/${process.getuid()}`;
  await runCommand('launchctl', ['bootout', `${domain}/${LABEL}`]).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await runCommand('launchctl', ['bootstrap', domain, plistPath]);
  await runCommand('launchctl', ['kickstart', `${domain}/${LABEL}`]);
  return { label:LABEL, bundleHash, bundleRoot, stateDir, socketPath, plistPath };
}

export function buildLaunchAgentPlist({ nodePath, serverPath, configPath, workingDirectory, stdoutPath, stderrPath }) {
  const values = [nodePath, serverPath, configPath, workingDirectory, stdoutPath, stderrPath];
  if (values.some((value) => !path.isAbsolute(String(value || '')))) throw new Error('LaunchAgent 路径必须是绝对路径');
  const runtimePath = [path.dirname(nodePath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array><string>${xml(nodePath)}</string><string>${xml(serverPath)}</string><string>--config</string><string>${xml(configPath)}</string></array>
<key>WorkingDirectory</key><string>${xml(workingDirectory)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(runtimePath)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${xml(stdoutPath)}</string><key>StandardErrorPath</key><string>${xml(stderrPath)}</string>
</dict></plist>
`;
}

async function installBundle(repositoryRoot, bundleRoot, expectedHash) {
  try {
    await validateInstalledBundle(bundleRoot, expectedHash);
    return;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const temporary = await fs.mkdtemp(`${bundleRoot}.${process.pid}-`);
  const directories = new Set(['']);
  for (const relative of BUNDLE_FILES) {
    const destination = path.join(temporary, relative);
    await fs.mkdir(path.dirname(destination), { recursive:true, mode:0o700 });
    const bytes = await readStableOrdinaryFile(
      path.join(repositoryRoot, relative),
      repositoryRoot,
      `发布助手源码 ${relative}`,
    );
    await fs.writeFile(destination, bytes, { flag:'wx', mode:0o444 });
    await fs.chmod(destination, 0o444);
    let current = path.dirname(relative);
    while (current && current !== '.') {
      directories.add(current);
      current = path.dirname(current);
    }
  }
  for (const relative of [...directories].sort((left, right) => right.length - left.length)) {
    await fs.chmod(path.join(temporary, relative), 0o555);
  }
  await validateInstalledBundle(temporary, expectedHash, { requireHashedName:false });
  await fs.rename(temporary, bundleRoot);
  await validateInstalledBundle(bundleRoot, expectedHash);
}

async function hashBundle(repositoryRoot) {
  const hash = crypto.createHash('sha256');
  for (const relative of BUNDLE_FILES) {
    hash.update(relative).update(await readStableOrdinaryFile(
      path.join(repositoryRoot, relative),
      repositoryRoot,
      `发布助手源码 ${relative}`,
    ));
  }
  return hash.digest('hex');
}

async function validateInstalledBundle(bundleRoot, expectedHash, { requireHashedName = true } = {}) {
  const rootStat = await fs.lstat(bundleRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('既有发布助手包不是普通目录。');
  if ((rootStat.mode & 0o777) !== 0o555) throw new Error('既有发布助手包根目录不是只读模式。');
  if (requireHashedName && path.basename(bundleRoot) !== `bundle-${expectedHash.slice(0, 16)}`) {
    throw new Error('既有发布助手包目录名未绑定内容哈希。');
  }
  const expectedDirectories = new Set(['']);
  for (const relative of BUNDLE_FILES) {
    let current = path.dirname(relative);
    while (current && current !== '.') {
      expectedDirectories.add(current);
      current = path.dirname(current);
    }
  }
  const actualFiles = [];
  const actualDirectories = new Set(['']);
  async function walk(current, relativeRoot = '') {
    for (const name of (await fs.readdir(current)).sort()) {
      const absolute = path.join(current, name);
      const relative = path.join(relativeRoot, name).split(path.sep).join('/');
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error(`既有发布助手包含软链: ${relative}`);
      if (stat.isDirectory()) {
        if ((stat.mode & 0o777) !== 0o555) throw new Error(`既有发布助手包目录不是只读模式: ${relative}`);
        actualDirectories.add(relative);
        await walk(absolute, relative);
      } else if (stat.isFile()) {
        if ((stat.mode & 0o777) !== 0o444) throw new Error(`既有发布助手包文件不是只读模式: ${relative}`);
        actualFiles.push(relative);
      } else {
        throw new Error(`既有发布助手包含不支持条目: ${relative}`);
      }
    }
  }
  await walk(bundleRoot);
  if (JSON.stringify(actualFiles.sort()) !== JSON.stringify(BUNDLE_FILES)) {
    throw new Error('既有发布助手包文件清单不完整。');
  }
  if (JSON.stringify([...actualDirectories].sort()) !== JSON.stringify([...expectedDirectories].sort())) {
    throw new Error('既有发布助手包目录清单不完整。');
  }
  const actualHash = crypto.createHash('sha256');
  for (const relative of BUNDLE_FILES) {
    actualHash.update(relative).update(await readStableOrdinaryFile(
      path.join(bundleRoot, relative),
      bundleRoot,
      `既有发布助手包文件 ${relative}`,
    ));
  }
  if (actualHash.digest('hex') !== expectedHash) throw new Error('既有发布助手包内容哈希不匹配。');
}

async function readStableOrdinaryFile(file, allowedRoot, label) {
  const relative = path.relative(allowedRoot, file);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label}越出允许根目录。`);
  }
  const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint:true });
    if (!before.isFile()) throw new Error(`${label}不是普通文件。`);
    if (before.nlink !== 1n) throw new Error(`${label}不允许硬链接。`);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint:true });
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
    ) throw new Error(`${label}读取期间发生漂移。`);
    const pathStat = await fs.lstat(file, { bigint:true });
    if (pathStat.isSymbolicLink() || pathStat.dev !== after.dev || pathStat.ino !== after.ino) {
      throw new Error(`${label}读取期间路径被替换。`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function writePrivateJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode:0o600 });
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, file);
}

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

async function defaultRunCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio:['ignore', 'pipe', 'pipe'] });
    const stderr = [];
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve({ code }) : reject(new Error(`${path.basename(command)} 执行失败（${code}）。`)));
  });
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const index = process.argv.indexOf('--repository-root');
  const repositoryRoot = index >= 0 ? process.argv[index + 1] : '';
  const result = await installReleaseHelper({ repositoryRoot });
  console.log(JSON.stringify({ status:'installed', label:result.label, bundleHash:result.bundleHash, socketPath:result.socketPath }, null, 2));
}

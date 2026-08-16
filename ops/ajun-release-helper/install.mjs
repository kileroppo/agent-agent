#!/usr/bin/env node

import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LABEL = 'ai.agent-army.release-helper';
const FILES = ['server.mjs', 'release-coordinator.mjs', 'system-adapter.mjs'];

export async function installReleaseHelper({ repositoryRoot, homeDir = os.homedir(), nodePath = process.execPath, runCommand = defaultRunCommand } = {}) {
  if (!repositoryRoot) throw new Error('必须提供 --repository-root');
  const repo = await fs.realpath(path.resolve(repositoryRoot));
  const sourceDir = path.dirname(fileURLToPath(import.meta.url));
  const bundleHash = await hashBundle(sourceDir);
  const installParent = path.join(homeDir, '.agent-army', 'release-helper');
  const bundleRoot = path.join(installParent, `bundle-${bundleHash.slice(0, 16)}`);
  const stateDir = path.join(homeDir, '.agent-army', 'state', 'ajun-release-helper');
  const socketPath = path.join(stateDir, 'release-helper.sock');
  const configPath = path.join(stateDir, 'config.json');
  const plistPath = path.join(homeDir, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  await fs.mkdir(installParent, { recursive:true, mode:0o700 });
  await fs.mkdir(stateDir, { recursive:true, mode:0o700 });
  await installBundle(sourceDir, bundleRoot);
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
    serverPath:path.join(bundleRoot, 'server.mjs'),
    configPath,
    workingDirectory:bundleRoot,
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

async function installBundle(sourceDir, bundleRoot) {
  try {
    const stat = await fs.lstat(bundleRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('既有发布助手包不是普通目录。');
    return;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const temporary = `${bundleRoot}.${process.pid}.tmp`;
  await fs.mkdir(temporary, { mode:0o700 });
  for (const name of FILES) {
    await fs.copyFile(path.join(sourceDir, name), path.join(temporary, name), fs.constants.COPYFILE_EXCL);
    await fs.chmod(path.join(temporary, name), 0o444);
  }
  await fs.chmod(temporary, 0o555);
  await fs.rename(temporary, bundleRoot);
}

async function hashBundle(sourceDir) {
  const hash = crypto.createHash('sha256');
  for (const name of FILES) hash.update(name).update(await fs.readFile(path.join(sourceDir, name)));
  return hash.digest('hex');
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

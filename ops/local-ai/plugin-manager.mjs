#!/usr/bin/env node

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PLUGIN_SCHEMA = 'agent-army/local-ai-plugin/v1';
export const PLUGIN_ID = 'local-ai';
export const LABELS = Object.freeze({
  gateway:'com.agent-army.local-ai.gateway',
  qwen35:'com.agent-army.local-ai.qwen35',
  qwen36:'com.agent-army.local-ai.qwen36-candidate',
});

const PAYLOAD = Object.freeze([
  ['integrations/local-ai/local_ai_gateway.py', 'lib/local_ai_gateway.py'],
  ['integrations/local-ai/knowledge_index.py', 'lib/knowledge_index.py'],
  ['integrations/local-ai/retrieval_engine.py', 'lib/retrieval_engine.py'],
  ['ops/local-ai/plugin-runtime/launcher.py', 'bin/launcher.py'],
  ['ops/local-ai/plugin-runtime/download_models.py', 'bin/download_models.py'],
  ['ops/local-ai/plugin-runtime/mflux-generate-flux2', 'bin/mflux-generate-flux2'],
  ['ops/local-ai/plugin-runtime/mflux-generate-flux2-edit', 'bin/mflux-generate-flux2-edit'],
  ['ops/local-ai/model-manifest.json', 'model-manifest.json'],
  ['ops/local-ai/requirements/gateway.lock', 'requirements/gateway.lock'],
  ['ops/local-ai/requirements/mflux.lock', 'requirements/mflux.lock'],
]);

export function defaultLayout({
  home = os.homedir(),
  runtimeRoot = process.env.AGENT_ARMY_LOCAL_AI_HOME,
  pluginRoot = process.env.AGENT_ARMY_LOCAL_AI_PLUGIN_ROOT,
  launchAgentsDir,
} = {}) {
  const supportRoot = path.join(home, 'Library', 'Application Support', 'AgentArmy');
  const resolvedRuntimeRoot = path.resolve(runtimeRoot || path.join(supportRoot, 'local-ai'));
  const resolvedPluginRoot = path.resolve(pluginRoot || path.join(supportRoot, 'plugins', PLUGIN_ID));
  return Object.freeze({
    runtimeRoot:resolvedRuntimeRoot,
    pluginRoot:resolvedPluginRoot,
    releasesRoot:path.join(resolvedPluginRoot, 'releases'),
    currentLink:path.join(resolvedPluginRoot, 'current'),
    launchAgentsDir:path.resolve(launchAgentsDir || path.join(home, 'Library', 'LaunchAgents')),
  });
}

export async function installPlugin({ repoRoot, layout = defaultLayout(), activate = false, writeLaunchAgents = false, now = () => new Date() }) {
  const canonicalRepoRoot = await canonicalDirectory(repoRoot, '仓库根目录');
  const entries = [];
  const digest = crypto.createHash('sha256');
  for (const [sourceRelative, targetRelative] of PAYLOAD) {
    const source = path.join(canonicalRepoRoot, sourceRelative);
    const bytes = await readOrdinaryFile(source, canonicalRepoRoot, sourceRelative);
    digest.update(`${targetRelative}\0${bytes.length}\0`);
    digest.update(bytes);
    entries.push({ source, sourceRelative, targetRelative, bytes, sha256:sha256(bytes) });
  }
  const releaseHash = digest.digest('hex');
  const releaseRoot = path.join(layout.releasesRoot, releaseHash);
  await fs.mkdir(layout.releasesRoot, { recursive:true, mode:0o755 });
  if (!(await pathExists(releaseRoot))) {
    const staging = path.join(layout.releasesRoot, `.staging-${process.pid}-${crypto.randomUUID()}`);
    await fs.mkdir(staging, { recursive:false, mode:0o700 });
    try {
      for (const entry of entries) {
        const destination = path.join(staging, entry.targetRelative);
        await fs.mkdir(path.dirname(destination), { recursive:true, mode:0o755 });
        await fs.writeFile(destination, entry.bytes, { mode:entry.targetRelative.startsWith('bin/') ? 0o755 : 0o644 });
      }
      const manifest = {
        schemaVersion:PLUGIN_SCHEMA,
        pluginId:PLUGIN_ID,
        releaseHash,
        createdAt:now().toISOString(),
        sourceGitHead:gitHead(canonicalRepoRoot),
        payload:entries.map(({ targetRelative, sha256:entryHash, bytes }) => ({ path:targetRelative, sha256:entryHash, bytes:bytes.length })),
      };
      await fs.writeFile(path.join(staging, 'plugin-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode:0o644 });
      await fs.rename(staging, releaseRoot);
    } catch (error) {
      await fs.rm(staging, { recursive:true, force:true });
      throw error;
    }
  }
  await validateRelease(releaseRoot, releaseHash);
  await fs.mkdir(layout.runtimeRoot, { recursive:true, mode:0o700 });
  if (activate) await activatePluginRelease({ layout, releaseHash });
  if (writeLaunchAgents) await writeLaunchAgentFiles({ layout });
  return pluginStatus({ layout, expectedReleaseHash:releaseHash });
}

export async function activatePluginRelease({ layout = defaultLayout(), releaseHash }) {
  const releaseRoot = path.join(layout.releasesRoot, String(releaseHash || ''));
  await validateRelease(releaseRoot, releaseHash);
  await fs.mkdir(layout.pluginRoot, { recursive:true, mode:0o755 });
  const temporaryLink = path.join(layout.pluginRoot, `.current-${process.pid}-${crypto.randomUUID()}`);
  await fs.symlink(path.relative(layout.pluginRoot, releaseRoot), temporaryLink);
  await fs.rename(temporaryLink, layout.currentLink);
}

export async function pluginStatus({ layout = defaultLayout(), expectedReleaseHash = null } = {}) {
  let currentReleaseHash = null;
  try {
    const target = await fs.readlink(layout.currentLink);
    const releaseRoot = path.resolve(layout.pluginRoot, target);
    const manifest = JSON.parse(await fs.readFile(path.join(releaseRoot, 'plugin-manifest.json'), 'utf8'));
    await validateRelease(releaseRoot, manifest.releaseHash);
    currentReleaseHash = manifest.releaseHash;
  } catch {}
  return Object.freeze({
    schemaVersion:PLUGIN_SCHEMA,
    pluginId:PLUGIN_ID,
    pluginRoot:layout.pluginRoot,
    runtimeRoot:layout.runtimeRoot,
    currentReleaseHash,
    expectedReleaseHash,
    active:Boolean(currentReleaseHash && (!expectedReleaseHash || currentReleaseHash === expectedReleaseHash)),
    gatewayPython:path.join(layout.runtimeRoot, 'venvs', 'gateway', 'bin', 'python'),
    mfluxPython:path.join(layout.runtimeRoot, 'venvs', 'mflux', 'bin', 'python'),
  });
}

export function renderLaunchAgentPlists({ layout = defaultLayout() } = {}) {
  const python = path.join(layout.runtimeRoot, 'venvs', 'gateway', 'bin', 'python');
  const launcher = path.join(layout.currentLink, 'bin', 'launcher.py');
  const environment = {
    AGENT_ARMY_LOCAL_AI_HOME:layout.runtimeRoot,
    AGENT_ARMY_LOCAL_AI_PLUGIN_ROOT:layout.pluginRoot,
  };
  return Object.freeze({
    [LABELS.gateway]:renderPlist({
      label:LABELS.gateway,
      args:[python, launcher, 'gateway'],
      workingDirectory:layout.runtimeRoot,
      stdout:path.join(layout.runtimeRoot, 'logs', 'gateway.stdout.log'),
      stderr:path.join(layout.runtimeRoot, 'logs', 'gateway.stderr.log'),
      runAtLoad:true,
      keepAlive:true,
      environment,
    }),
    [LABELS.qwen35]:renderPlist({
      label:LABELS.qwen35,
      args:[python, launcher, 'qwen35'],
      workingDirectory:layout.runtimeRoot,
      stdout:path.join(layout.runtimeRoot, 'logs', 'qwen35.stdout.log'),
      stderr:path.join(layout.runtimeRoot, 'logs', 'qwen35.stderr.log'),
      runAtLoad:false,
      keepAlive:false,
      environment,
    }),
    [LABELS.qwen36]:renderPlist({
      label:LABELS.qwen36,
      args:[python, launcher, 'qwen36-candidate'],
      workingDirectory:layout.runtimeRoot,
      stdout:path.join(layout.runtimeRoot, 'logs', 'qwen36-candidate.stdout.log'),
      stderr:path.join(layout.runtimeRoot, 'logs', 'qwen36-candidate.stderr.log'),
      runAtLoad:false,
      keepAlive:false,
      environment,
    }),
  });
}

export async function writeLaunchAgentFiles({ layout = defaultLayout() } = {}) {
  await fs.mkdir(layout.launchAgentsDir, { recursive:true, mode:0o755 });
  const rendered = renderLaunchAgentPlists({ layout });
  for (const [label, contents] of Object.entries(rendered)) {
    const destination = path.join(layout.launchAgentsDir, `${label}.plist`);
    const temporary = `${destination}.tmp-${process.pid}`;
    await fs.writeFile(temporary, contents, { mode:0o600 });
    await fs.rename(temporary, destination);
  }
}

export async function migrateRepositoryRuntime({ sourceRoot, layout = defaultLayout(), recordPath }) {
  const canonicalSource = await canonicalDirectory(sourceRoot, '旧运行根');
  const destinationRoot = path.resolve(layout.runtimeRoot);
  if (canonicalSource === destinationRoot || destinationRoot.startsWith(`${canonicalSource}${path.sep}`)) {
    throw new Error('外置运行根不得位于旧运行根内部');
  }
  await fs.mkdir(destinationRoot, { recursive:true, mode:0o700 });
  const moves = [];
  const removedEmptyDestinations = [];
  const sourceVenvs = path.join(canonicalSource, 'venvs');
  const mappings = [];
  if (await pathExists(path.join(sourceVenvs, 'retrieval'))) mappings.push([path.join(sourceVenvs, 'retrieval'), path.join(destinationRoot, 'venvs', 'gateway')]);
  if (await pathExists(path.join(sourceVenvs, 'mflux'))) mappings.push([path.join(sourceVenvs, 'mflux'), path.join(destinationRoot, 'venvs', 'mflux')]);
  for (const name of await fs.readdir(canonicalSource)) {
    if (name === 'venvs') continue;
    mappings.push([path.join(canonicalSource, name), path.join(destinationRoot, name)]);
  }
  for (const [, destination] of mappings) {
    if (!(await pathExists(destination))) continue;
    const stat = await fs.lstat(destination);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.readdir(destination)).length > 0) {
      throw new Error(`迁移目标已存在且非空，拒绝覆盖: ${destination}`);
    }
    await fs.rmdir(destination);
    removedEmptyDestinations.push(destination);
  }
  try {
    for (const [source, destination] of mappings) {
      await fs.mkdir(path.dirname(destination), { recursive:true, mode:0o700 });
      await fs.rename(source, destination);
      moves.push({ source, destination });
    }
  } catch (error) {
    await reverseMoves(moves);
    for (const destination of removedEmptyDestinations) await fs.mkdir(destination, { recursive:true, mode:0o700 });
    throw error;
  }
  const record = {
    schemaVersion:'agent-army/local-ai-runtime-migration/v1',
    sourceRoot:canonicalSource,
    runtimeRoot:destinationRoot,
    moves,
    removedEmptyDestinations,
    leftBehind:[path.join(sourceVenvs, 'mlx-vlm')].filter((entry) => true),
  };
  if (recordPath) {
    await fs.writeFile(path.resolve(recordPath), `${JSON.stringify(record, null, 2)}\n`, { mode:0o600 });
  }
  return record;
}

export async function rollbackRepositoryRuntime({ recordPath }) {
  const record = JSON.parse(await fs.readFile(path.resolve(recordPath), 'utf8'));
  if (record?.schemaVersion !== 'agent-army/local-ai-runtime-migration/v1' || !Array.isArray(record.moves)) {
    throw new Error('迁移记录格式无效');
  }
  await reverseMoves(record.moves);
  for (const destination of record.removedEmptyDestinations || []) {
    await fs.mkdir(destination, { recursive:true, mode:0o700 });
  }
  return { rolledBack:record.moves.length };
}

export async function repairAdoptedRuntime({ layout = defaultLayout() } = {}) {
  const python = path.join(layout.runtimeRoot, 'venvs', 'mflux', 'bin', 'python');
  const scripts = [
    path.join(layout.runtimeRoot, 'venvs', 'mflux', 'bin', 'mflux-generate-flux2'),
    path.join(layout.runtimeRoot, 'venvs', 'mflux', 'bin', 'mflux-generate-flux2-edit'),
  ];
  await fs.access(python);
  for (const script of scripts) {
    const stat = await fs.lstat(script);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`MFLUX 入口必须是普通文件: ${script}`);
    const contents = await fs.readFile(script, 'utf8');
    const lines = contents.split('\n');
    lines[0] = `#!${python}`;
    await fs.writeFile(script, lines.join('\n'), { mode:0o755 });
  }
  return { repaired:scripts, python };
}

async function reverseMoves(moves) {
  for (const { source, destination } of [...moves].reverse()) {
    if (!(await pathExists(destination))) continue;
    if (await pathExists(source)) throw new Error(`回滚源已存在，拒绝覆盖: ${source}`);
    await fs.mkdir(path.dirname(source), { recursive:true, mode:0o700 });
    await fs.rename(destination, source);
  }
}

async function validateRelease(releaseRoot, expectedHash) {
  const canonical = await canonicalDirectory(releaseRoot, '插件发布根');
  const manifest = JSON.parse(await fs.readFile(path.join(canonical, 'plugin-manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== PLUGIN_SCHEMA || manifest.pluginId !== PLUGIN_ID || manifest.releaseHash !== expectedHash) {
    throw new Error('插件发布清单身份不匹配');
  }
  for (const entry of manifest.payload || []) {
    const absolute = path.resolve(canonical, entry.path);
    if (!absolute.startsWith(`${canonical}${path.sep}`)) throw new Error('插件发布清单路径越界');
    const bytes = await fs.readFile(absolute);
    if (sha256(bytes) !== entry.sha256 || bytes.length !== entry.bytes) throw new Error(`插件发布内容漂移: ${entry.path}`);
  }
  return manifest;
}

function renderPlist({ label, args, workingDirectory, stdout, stderr, runAtLoad, keepAlive, environment }) {
  const strings = args.map((value) => `    <string>${xml(value)}</string>`).join('\n');
  const environmentRows = Object.entries(environment).map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>${xml(label)}</string>\n  <key>ProgramArguments</key>\n  <array>\n${strings}\n  </array>\n  <key>WorkingDirectory</key>\n  <string>${xml(workingDirectory)}</string>\n  <key>EnvironmentVariables</key>\n  <dict>\n${environmentRows}\n  </dict>\n  <key>RunAtLoad</key>\n  <${runAtLoad ? 'true' : 'false'}/>\n  <key>KeepAlive</key>\n  <${keepAlive ? 'true' : 'false'}/>\n  <key>ThrottleInterval</key>\n  <integer>10</integer>\n  <key>StandardOutPath</key>\n  <string>${xml(stdout)}</string>\n  <key>StandardErrorPath</key>\n  <string>${xml(stderr)}</string>\n</dict>\n</plist>\n`;
}

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

async function readOrdinaryFile(file, root, label) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} 必须是普通文件`);
  const canonical = await fs.realpath(file);
  if (!canonical.startsWith(`${root}${path.sep}`)) throw new Error(`${label} 越出仓库根`);
  return fs.readFile(canonical);
}

async function canonicalDirectory(directory, label) {
  const canonical = await fs.realpath(path.resolve(directory));
  const stat = await fs.lstat(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} 必须是普通目录`);
  return canonical;
}

async function pathExists(target) {
  try { await fs.lstat(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function gitHead(repoRoot) {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd:repoRoot, encoding:'utf8', stdio:['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

function parseArgs(argv) {
  const command = argv[0] || 'status';
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`未知参数: ${token}`);
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) options[key] = true;
    else { options[key] = next; index += 1; }
  }
  return { command, options };
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  const repoRoot = path.resolve(options['repo-root'] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
  const layout = defaultLayout({ runtimeRoot:options['runtime-root'], pluginRoot:options['plugin-root'], launchAgentsDir:options['launch-agents-dir'] });
  let result;
  if (command === 'install') {
    result = await installPlugin({ repoRoot, layout, activate:options.activate === true, writeLaunchAgents:options['write-launch-agents'] === true });
  } else if (command === 'activate') {
    await activatePluginRelease({ layout, releaseHash:options.release });
    result = await pluginStatus({ layout });
  } else if (command === 'migrate-runtime') {
    result = await migrateRepositoryRuntime({ sourceRoot:options.source, layout, recordPath:options.record });
  } else if (command === 'rollback-runtime') {
    result = await rollbackRepositoryRuntime({ recordPath:options.record });
  } else if (command === 'repair-runtime') {
    result = await repairAdoptedRuntime({ layout });
  } else if (command === 'status') {
    result = await pluginStatus({ layout });
  } else {
    throw new Error(`未知命令: ${command}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`local-ai plugin manager: ${error.message}\n`);
    process.exitCode = 1;
  });
}

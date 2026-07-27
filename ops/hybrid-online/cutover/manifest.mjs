#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CUTOVER_SCHEMA = 'agent.army/cutover-state/v1';
export const MANIFEST_FILE = 'cutover-manifest.json';
export const REQUIRED_STATE_PATHS = Object.freeze([
  'agent-army/runtime.json',
  'hermes/default/.env',
  'hermes/default/auth.json',
  'hermes/default/config.yaml',
  'hermes/default/sessions/sessions.json',
  'hermes/default/state.db',
  'hermes/profiles/ajun/.env',
  'hermes/profiles/ajun/auth.json',
  'hermes/profiles/ajun/config.yaml',
  'hermes/profiles/ajun/state.db',
  'hermes/profiles/intel-researcher/.env',
  'hermes/profiles/intel-researcher/auth.json',
  'hermes/profiles/intel-researcher/config.yaml',
  'hermes/profiles/intel-researcher/sessions/sessions.json',
  'hermes/profiles/intel-researcher/state.db',
  'hermes/profiles/office-assistant/.env',
  'hermes/profiles/office-assistant/auth.json',
  'hermes/profiles/office-assistant/config.yaml',
  'hermes/profiles/office-assistant/sessions/sessions.json',
  'hermes/profiles/office-assistant/state.db',
  'paperclip/instance/.env',
  'paperclip/instance/config.json',
  'paperclip/instance/secrets/master.key',
  'private/feishu-agent-apps.json',
  'private/feishu-agent-secrets.json',
  'proof/local-services-stopped.json'
]);

export async function writeCutoverManifest({ root, sourceHead, sourceBranch, createdAt = new Date().toISOString() }) {
  const resolvedRoot = path.resolve(root);
  const files = await collectFiles(resolvedRoot);
  const backupFiles = files.filter((item) => /^paperclip\/backups\/[^/]+\.sql\.gz$/.test(item.path));
  if (backupFiles.length !== 1) throw new CutoverManifestError('必须且只能包含一个 Paperclip 官方 SQL 备份。');

  const present = new Set(files.map((item) => item.path));
  const missing = REQUIRED_STATE_PATHS.filter((requiredPath) => !present.has(requiredPath));
  if (missing.length) throw new CutoverManifestError(`迁移状态不完整：缺少 ${missing.join(', ')}`);

  const manifest = {
    schemaVersion:CUTOVER_SCHEMA,
    createdAt,
    source:{
      gitHead:assertGitHead(sourceHead),
      branch:assertBranch(sourceBranch)
    },
    servicesStopped:[
      'ai.agent-army.ajun-runtime',
      'ai.agent-army.paperclip',
      'ai.hermes.gateway',
      'ai.hermes.gateway-intel-researcher',
      'ai.hermes.gateway-office-assistant'
    ],
    files
  };
  await fs.writeFile(path.join(resolvedRoot, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { mode:0o600 });
  return manifest;
}

export async function verifyCutoverManifest({ root }) {
  const resolvedRoot = path.resolve(root);
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(resolvedRoot, MANIFEST_FILE), 'utf8'));
  } catch {
    throw new CutoverManifestError('迁移清单不存在或无法解析。');
  }
  if (manifest.schemaVersion !== CUTOVER_SCHEMA) throw new CutoverManifestError('迁移清单版本不受支持。');
  assertGitHead(manifest.source?.gitHead);
  assertBranch(manifest.source?.branch);
  if (!Array.isArray(manifest.files) || !manifest.files.length) throw new CutoverManifestError('迁移清单没有文件记录。');

  const actual = await collectFiles(resolvedRoot);
  const expected = [...manifest.files].sort(compareFileRecords);
  if (actual.length !== expected.length) throw new CutoverManifestError('迁移文件数量与清单不一致。');
  for (let index = 0; index < actual.length; index += 1) {
    const left = actual[index];
    const right = expected[index];
    if (left.path !== right.path || left.size !== right.size || left.sha256 !== right.sha256) {
      throw new CutoverManifestError(`迁移文件校验失败：${right.path || left.path}`);
    }
  }
  const present = new Set(actual.map((item) => item.path));
  for (const requiredPath of REQUIRED_STATE_PATHS) {
    if (!present.has(requiredPath)) throw new CutoverManifestError(`迁移状态缺少必需文件：${requiredPath}`);
  }
  if (actual.filter((item) => /^paperclip\/backups\/[^/]+\.sql\.gz$/.test(item.path)).length !== 1) {
    throw new CutoverManifestError('Paperclip SQL 备份数量不正确。');
  }
  return manifest;
}

async function collectFiles(root) {
  const records = [];
  await walk(root, '', records);
  return records.sort(compareFileRecords);
}

async function walk(root, relativeDir, records) {
  const directory = path.join(root, relativeDir);
  const entries = await fs.readdir(directory, { withFileTypes:true });
  for (const entry of entries) {
    const relativePath = normalizeRelative(path.posix.join(relativeDir.split(path.sep).join('/'), entry.name));
    if (relativePath === MANIFEST_FILE) continue;
    const absolutePath = path.join(root, ...relativePath.split('/'));
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink()) throw new CutoverManifestError(`迁移状态不允许符号链接：${relativePath}`);
    if (stat.isDirectory()) {
      await walk(root, relativePath, records);
      continue;
    }
    if (!stat.isFile()) throw new CutoverManifestError(`迁移状态含不支持的文件类型：${relativePath}`);
    records.push({
      path:relativePath,
      size:stat.size,
      sha256:await sha256(absolutePath)
    });
  }
}

function normalizeRelative(value) {
  const normalized = path.posix.normalize(String(value || ''));
  if (!normalized || normalized === '.' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw new CutoverManifestError('迁移状态含不安全路径。');
  }
  return normalized;
}

async function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  const handle = await fs.open(filePath, 'r');
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close().catch(() => {});
  }
  return hash.digest('hex');
}

function assertGitHead(value) {
  const head = String(value || '').trim();
  if (!/^[a-f0-9]{40}$/.test(head)) throw new CutoverManifestError('来源 Git 提交无效。');
  return head;
}

function assertBranch(value) {
  const branch = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(branch) || branch.includes('..') || branch.endsWith('/')) {
    throw new CutoverManifestError('来源 Git 分支无效。');
  }
  return branch;
}

function compareFileRecords(left, right) {
  return String(left.path).localeCompare(String(right.path), 'en');
}

export class CutoverManifestError extends Error {}

async function main() {
  const [command, root, sourceHead, sourceBranch] = process.argv.slice(2);
  try {
    if (command === 'write') {
      const manifest = await writeCutoverManifest({ root, sourceHead, sourceBranch });
      console.log(JSON.stringify({ schemaVersion:manifest.schemaVersion, files:manifest.files.length }));
      return;
    }
    if (command === 'verify') {
      const manifest = await verifyCutoverManifest({ root });
      console.log(JSON.stringify({ schemaVersion:manifest.schemaVersion, files:manifest.files.length }));
      return;
    }
    throw new CutoverManifestError('用法：manifest.mjs write <root> <git-head> <branch> 或 verify <root>');
  } catch (error) {
    console.error(error instanceof CutoverManifestError ? error.message : '迁移清单处理失败。');
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyCutoverManifest } from './manifest.mjs';

const DIRECTORY_MAPPINGS = Object.freeze([
  ['hermes/default', 'hermes/default'],
  ['hermes/profiles/ajun', 'hermes/profiles/ajun'],
  ['hermes/profiles/intel-researcher', 'hermes/profiles/intel-researcher'],
  ['hermes/profiles/office-assistant', 'hermes/profiles/office-assistant'],
  ['agent-army', '.'],
  ['paperclip/instance', '.paperclip/instances/default']
]);

const FILE_MAPPINGS = Object.freeze([
  ['private/feishu-agent-apps.json', 'private/feishu-agent-apps.json'],
  ['private/feishu-agent-secrets.json', 'private/feishu-agent-secrets.json'],
  ['proof/local-services-stopped.json', 'private/cutover/local-services-stopped.json']
]);

export async function applyCutoverState({ sourceRoot, dataRoot }) {
  const source = path.resolve(sourceRoot);
  const target = path.resolve(dataRoot);
  assertSafeDataRoot(target);
  const manifest = await verifyCutoverManifest({ root:source });

  await fs.mkdir(target, { recursive:true, mode:0o700 });
  for (const [sourceRelative, targetRelative] of DIRECTORY_MAPPINGS) {
    const sourcePath = resolveInside(source, sourceRelative);
    const targetPath = resolveInside(target, targetRelative);
    await fs.mkdir(targetPath, { recursive:true, mode:0o700 });
    await fs.cp(sourcePath, targetPath, {
      recursive:true,
      force:true,
      preserveTimestamps:true,
      verbatimSymlinks:false
    });
  }
  for (const [sourceRelative, targetRelative] of FILE_MAPPINGS) {
    const sourcePath = resolveInside(source, sourceRelative);
    const targetPath = resolveInside(target, targetRelative);
    await fs.mkdir(path.dirname(targetPath), { recursive:true, mode:0o700 });
    await fs.copyFile(sourcePath, targetPath);
    await fs.chmod(targetPath, 0o600);
  }

  const backup = manifest.files.find((item) => /^paperclip\/backups\/[^/]+\.sql\.gz$/.test(item.path));
  if (!backup) throw new CutoverApplyError('迁移清单缺少 Paperclip SQL 备份。');
  const backupTarget = resolveInside(target, 'private/cutover/paperclip-cutover-state.sql.gz');
  await fs.copyFile(resolveInside(source, backup.path), backupTarget);
  await fs.chmod(backupTarget, 0o600);
  return {
    files:manifest.files.length,
    sourceHead:manifest.source.gitHead,
    backupPath:backupTarget
  };
}

function assertSafeDataRoot(value) {
  if (!path.isAbsolute(value) || ['/', '/var', '/Users', '/home'].includes(value)) {
    throw new CutoverApplyError('目标数据目录过于宽泛。');
  }
}

function resolveInside(root, relativePath) {
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new CutoverApplyError('迁移映射越过受控目录。');
  }
  return resolved;
}

export class CutoverApplyError extends Error {}

async function main() {
  const [command, sourceRoot, dataRoot] = process.argv.slice(2);
  try {
    if (command !== 'apply') throw new CutoverApplyError('用法：apply-state.mjs apply <source-root> <data-root>');
    const result = await applyCutoverState({ sourceRoot, dataRoot });
    console.log(JSON.stringify({ files:result.files, sourceHead:result.sourceHead }));
  } catch (error) {
    console.error(error instanceof CutoverApplyError ? error.message : '迁移状态映射失败。');
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const cleanWorkOnly = args.includes('--work');
const cleanCachesOnly = args.includes('--caches');
const cleanAll = args.includes('--all') || (!cleanWorkOnly && !cleanCachesOnly);

async function getDirSize(dirPath) {
  let total = 0;
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      try {
        if (entry.isDirectory()) {
          total += await getDirSize(fullPath);
        } else if (entry.isFile()) {
          const stat = await fs.stat(fullPath);
          total += stat.size;
        }
      } catch {}
    }
  } catch {}
  return total;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

async function unlockDirectory(dirPath) {
  try {
    await execFileAsync('find', [dirPath, '-type', 'd', '-exec', 'chmod', '755', '{}', '+']);
    await execFileAsync('find', [dirPath, '-type', 'f', '-exec', 'chmod', '644', '{}', '+']);
  } catch {}
}

async function removeEntry(targetPath, isDir = false) {
  let size = 0;
  try {
    if (isDir) {
      size = await getDirSize(targetPath);
      if (!isDryRun) {
        await unlockDirectory(targetPath);
        await fs.rm(targetPath, { recursive: true, force: true });
      }
    } else {
      const stat = await fs.stat(targetPath);
      size = stat.size;
      if (!isDryRun) {
        try {
          await fs.chmod(targetPath, 0o644);
        } catch {}
        await fs.unlink(targetPath);
      }
    }
    return size;
  } catch {
    return 0;
  }
}

async function cleanWorkDir() {
  const workDir = path.join(root, 'work');
  let freed = 0;
  let count = 0;
  try {
    const entries = await fs.readdir(workDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.gitkeep') continue;
      const fullPath = path.join(workDir, entry.name);
      const size = await removeEntry(fullPath, entry.isDirectory());
      freed += size;
      count += 1;
      console.log(`  ${isDryRun ? '[DRY-RUN] ' : ''}清理 work 临时项: ${entry.name} (${formatBytes(size)})`);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`  读取 work 目录失败: ${err.message}`);
    }
  }
  return { freed, count };
}

async function cleanPattern(patternFn) {
  let freed = 0;
  let count = 0;

  async function walk(currentDir) {
    let entries = [];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.relative(root, fullPath);

      if (patternFn(entry.name, relPath, entry.isDirectory())) {
        const size = await removeEntry(fullPath, entry.isDirectory());
        freed += size;
        count += 1;
        console.log(`  ${isDryRun ? '[DRY-RUN] ' : ''}清理项: ${relPath} (${formatBytes(size)})`);
        continue;
      }

      if (entry.isDirectory()) {
        await walk(fullPath);
      }
    }
  }

  await walk(root);
  return { freed, count };
}

async function cleanDataReleases() {
  const releasesDir = path.join(root, 'apps/ajun-runtime/data/releases');
  let freed = 0;
  let count = 0;
  try {
    const entries = await fs.readdir(releasesDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(releasesDir, entry.name);
      const size = await removeEntry(fullPath, entry.isDirectory());
      freed += size;
      count += 1;
      console.log(`  ${isDryRun ? '[DRY-RUN] ' : ''}清理 data/releases 项: ${entry.name} (${formatBytes(size)})`);
    }
  } catch {}
  return { freed, count };
}

async function main() {
  console.log(`🧹 开始仓库清理 ${isDryRun ? '(DRY-RUN 试运行)' : ''}...`);
  let totalFreed = 0;
  let totalCount = 0;

  if (cleanAll || cleanWorkOnly) {
    console.log('\n📦 正在扫描 work/ 目录...');
    const res = await cleanWorkDir();
    totalFreed += res.freed;
    totalCount += res.count;
  }

  if (cleanAll || cleanCachesOnly) {
    console.log('\n🧹 正在扫描系统噪音与临时缓存 (.DS_Store, __pycache__, *.log, etc.)...');
    const res = await cleanPattern((name, relPath, isDir) => {
      if (name === '.DS_Store' || name.startsWith('._')) return true;
      if (isDir && (name === '__pycache__' || name === '.pytest_cache' || name === '.mypy_cache' || name === '.ruff_cache')) return true;
      if (!isDir && (name.endsWith('.pyc') || name.endsWith('.pyo') || name.endsWith('.tsbuildinfo'))) return true;
      if (!isDir && (name.endsWith('.sqlite-wal') || name.endsWith('.sqlite-shm') || name.endsWith('.sqlite-journal'))) return true;
      if (!isDir && name.endsWith('.log') && !relPath.startsWith('docs/')) return true;
      return false;
    });
    totalFreed += res.freed;
    totalCount += res.count;
  }

  if (cleanAll) {
    console.log('\n📦 正在扫描 apps/ajun-runtime/data/releases 临时镜像...');
    const res = await cleanDataReleases();
    totalFreed += res.freed;
    totalCount += res.count;
  }

  console.log(`\n✨ 清理完毕！共处理 ${totalCount} 个项目，释放空间：${formatBytes(totalFreed)}。\n`);
}

main().catch((err) => {
  console.error('清理失败:', err);
  process.exit(1);
});

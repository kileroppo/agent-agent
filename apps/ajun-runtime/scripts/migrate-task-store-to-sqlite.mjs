import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { SQLiteTaskStore } from '../src/sqlite-task-store.js';

const { source, target } = parseArguments(process.argv.slice(2));
if (!source || !target) {
  console.error('用法: node scripts/migrate-task-store-to-sqlite.mjs --source <runtime.json> --target <runtime.sqlite>');
  process.exitCode = 2;
} else {
  await migrate(path.resolve(source), path.resolve(target));
}

async function migrate(sourcePath, targetPath) {
  if (sourcePath === targetPath) throw new Error('源 JSON 与目标 SQLite 路径不能相同。');
  const sourceBytes = await fs.readFile(sourcePath);
  const snapshot = JSON.parse(sourceBytes.toString('utf8'));
  const sourceDigest = crypto.createHash('sha256').update(sourceBytes).digest('hex');
  const backupPath = `${sourcePath}.${sourceDigest.slice(0, 12)}.pre-sqlite.bak`;
  await createVerifiedBackup(sourceBytes, backupPath);

  const store = new SQLiteTaskStore(targetPath);
  try {
    const result = await store.importSnapshot(snapshot, { sourceDigest });
    console.log(`迁移状态: ${result.status === 'imported' ? '已导入' : '相同源已导入，无需重复写入'}`);
    console.log(`导入前数量: ${formatCounts(result.before)}`);
    console.log(`导入后数量: ${formatCounts(result.after)}`);
    console.log(`关键 ID 校验: ${Object.values(result.idChecks).every(Boolean) ? '通过' : '失败'}`);
    console.log(`源文件备份: ${backupPath}`);
    console.log('源 JSON 保持不变；切换运行时配置前请先停止对应服务。');
    console.log(`回滚命令（停止服务后执行）: rm -- ${shellQuote(targetPath)} ${shellQuote(`${targetPath}-wal`)} ${shellQuote(`${targetPath}-shm`)}`);
    console.log(`恢复备份命令（仅当源 JSON 后续被改动时）: cp -- ${shellQuote(backupPath)} ${shellQuote(sourcePath)}`);
  } finally {
    store.close();
  }
}

async function createVerifiedBackup(sourceBytes, backupPath) {
  try {
    await fs.writeFile(backupPath, sourceBytes, { flag:'wx', mode:0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await fs.readFile(backupPath);
    if (!existing.equals(sourceBytes)) throw new Error('已存在的迁移备份与当前源文件不一致，已停止。');
  }
  await fs.chmod(backupPath, 0o600);
}

function parseArguments(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--source') result.source = args[++index];
    else if (args[index] === '--target') result.target = args[++index];
    else throw new Error(`未知参数: ${args[index]}`);
  }
  return result;
}

function formatCounts(counts) { return Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(', '); }
function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

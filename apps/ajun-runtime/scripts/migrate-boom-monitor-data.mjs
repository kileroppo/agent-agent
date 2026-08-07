import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { backup, DatabaseSync } from 'node:sqlite';

const REQUIRED_TABLES = [
  'analysis_queue',
  'app_settings',
  'creators',
  'scan_jobs',
  'score_baselines',
  'scores',
  'shadow_scores',
  'transcripts',
  'works',
];

const REQUIRED_COLUMNS = {
  scores:['work_id', 'score_version', 'grade', 'tier'],
  shadow_scores:['work_id', 'version', 'grade'],
};
const MIGRATION_RECORD_NAME = 'boom-monitor-migration-manifest.json';

main().catch((error) => {
  console.error(`Boom Monitor 数据迁移失败: ${safeErrorMessage(error)}`);
  process.exitCode = 1;
});

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }
  if (!options.source || !options.dataDir) {
    printUsage();
    process.exitCode = 2;
    return;
  }
  await migrate(options);
}

async function migrate({ source, dataDir, apply, requireTargetMatch }) {
  const sourcePath = path.resolve(source);
  const resolvedDataDir = path.resolve(dataDir);
  const targetPath = path.join(resolvedDataDir, 'boom-monitor.sqlite');

  if (sourcePath === targetPath) {
    throw new Error('源数据库与目标数据库路径不能相同。');
  }

  await assertRegularSourceFile(sourcePath);
  const sourceManifest = inspectDatabase(sourcePath);

  console.log(`模式: ${apply ? '执行迁移' : '只读检查'}`);
  console.log(`源数据库: ${sourcePath}`);
  console.log(`目标数据库: ${targetPath}`);
  console.log(`源表行数: ${formatCounts(sourceManifest.rowCounts)}`);
  console.log(`正式评分版本: ${formatVersions(sourceManifest.scoreVersions)}`);
  console.log(`影子评分版本: ${formatVersions(sourceManifest.shadowScoreVersions)}`);
  console.log(`源逻辑指纹: ${sourceManifest.digest}`);

  if (requireTargetMatch) {
    const retirement = await verifyRetirementReadiness({
      dataDir:resolvedDataDir,
      targetPath,
      currentSource:sourceManifest,
    });
    console.log(`目标当前行数: ${formatCounts(retirement.target.rowCounts)}`);
    console.log('退役核验: Docker 当前源未变化，迁移备份仍完整，A君目标库完整且未丢失源表行数或关键评分版本。');
    return;
  }

  const target = await inspectExistingTarget(targetPath, sourceManifest);

  if (target.status === 'match') {
    if (!apply) {
      await assertPrivateMode(targetPath);
      console.log('目标状态: 已迁移且与源数据库一致；未覆盖、未重复写入。');
      return;
    }
  }

  if (target.status === 'conflict') {
    throw new Error('目标 boom-monitor.sqlite 已存在且含有不同数据，拒绝覆盖。');
  }

  if (!apply) {
    console.log('目标状态: 不存在；检查通过。添加 --apply 才会创建备份并迁移。');
    return;
  }

  await fs.mkdir(resolvedDataDir, { recursive:true, mode:0o700 });
  const backupDir = path.join(resolvedDataDir, 'boom-monitor-backups');
  await fs.mkdir(backupDir, { recursive:true, mode:0o700 });
  const backupPath = path.join(
    backupDir,
    `source-${sourceManifest.digest.slice(0, 16)}.pre-convergence.sqlite`,
  );

  const verifiedBackup = await createVerifiedBackup({
    sourcePath,
    expected:sourceManifest,
    backupPath,
  });
  await installTargetFromBackup({ backupPath, targetPath, expected:verifiedBackup });
  await fs.chmod(targetPath, 0o600);

  const installed = inspectDatabase(targetPath);
  assertEquivalentManifest(verifiedBackup, installed, '目标数据库');
  await assertPrivateMode(targetPath);
  const recordPath = path.join(resolvedDataDir, MIGRATION_RECORD_NAME);
  await createOrVerifyMigrationRecord({ recordPath, source:verifiedBackup, backupPath });
  await assertPrivateMode(recordPath, '迁移记录');

  if (target.status === 'match') {
    console.log('迁移结果: 已迁移且与源数据库一致；未覆盖、未重复写入。');
  } else {
    console.log(`迁移结果: 已完成；${formatCounts(installed.rowCounts)}`);
  }
  console.log(`源快照备份: ${backupPath}`);
  console.log(`不可变迁移记录: ${recordPath}`);
  console.log('校验结果: 表、行数、正式评分版本、影子评分版本、完整逻辑指纹均一致。');
  console.log('文件权限: 0600');
  console.log('源数据库保持不变；切换读取方并完成真实接口验收前，不要停用 Docker。');
}

async function verifyRetirementReadiness({ dataDir, targetPath, currentSource }) {
  const recordPath = path.join(dataDir, MIGRATION_RECORD_NAME);
  const record = await readMigrationRecord(recordPath);
  assertEquivalentManifest(record.source, currentSource, 'Docker 当前源数据库');
  await assertPrivateMode(recordPath, '迁移记录');

  if (path.basename(record.backupFile) !== record.backupFile) {
    throw new Error('迁移记录中的备份文件名无效。');
  }
  const backupPath = path.join(dataDir, 'boom-monitor-backups', record.backupFile);
  await assertRegularSourceFile(backupPath);
  const backup = inspectDatabase(backupPath);
  assertEquivalentManifest(record.source, backup, '迁移源快照备份');
  await assertPrivateMode(backupPath, '迁移源快照备份');

  const targetState = await pathState(targetPath);
  if (!targetState.exists || !targetState.isFile || targetState.size === 0) {
    throw new Error('A君目标 boom-monitor.sqlite 不存在或无效，不能退役。');
  }
  const target = inspectDatabase(targetPath);
  await assertProtectedTargetMode(targetPath);
  assertMinimumCounts(record.source.rowCounts, target.rowCounts);
  assertMinimumVersions(record.source.scoreVersions, target.scoreVersions, '正式评分');
  assertMinimumVersions(record.source.shadowScoreVersions, target.shadowScoreVersions, '影子评分');
  assertSourceIdentitiesRemain(record.source.identityKeys, target.identityKeys);
  return { record, backup, target };
}

function inspectDatabase(filePath) {
  const database = new DatabaseSync(filePath, { readOnly:true });
  try {
    database.exec('PRAGMA query_only = ON;');
    const integrity = database.prepare('PRAGMA quick_check').all();
    if (integrity.length !== 1 || integrity[0].quick_check !== 'ok') {
      throw new Error('SQLite quick_check 未通过。');
    }
    const foreignKeyErrors = database.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeyErrors.length > 0) {
      throw new Error('SQLite foreign_key_check 未通过。');
    }

    const presentTables = new Set(
      database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
        .map((row) => row.name),
    );
    const missingTables = REQUIRED_TABLES.filter((table) => !presentTables.has(table));
    if (missingTables.length > 0) {
      throw new Error(`缺少必需表: ${missingTables.join(', ')}`);
    }

    const tableColumns = {};
    for (const table of REQUIRED_TABLES) {
      tableColumns[table] = database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all();
    }
    for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
      const presentColumns = new Set(tableColumns[table].map((column) => column.name));
      const missingColumns = required.filter((column) => !presentColumns.has(column));
      if (missingColumns.length > 0) {
        throw new Error(`表 ${table} 缺少关键列: ${missingColumns.join(', ')}`);
      }
    }

    const rowCounts = Object.fromEntries(
      REQUIRED_TABLES.map((table) => [
        table,
        Number(database.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get().count),
      ]),
    );
    const scoreVersions = versionCounts(database, 'scores', 'score_version');
    const shadowScoreVersions = versionCounts(database, 'shadow_scores', 'version');
    assertVersionsAreNamed(scoreVersions, 'scores.score_version');
    assertVersionsAreNamed(shadowScoreVersions, 'shadow_scores.version');
    const identityKeys = Object.fromEntries(
      REQUIRED_TABLES.map((table) => [table, tableIdentityKeys(database, table, tableColumns[table])]),
    );

    const digest = logicalDigest(database, tableColumns);
    return { rowCounts, scoreVersions, shadowScoreVersions, identityKeys, digest };
  } finally {
    database.close();
  }
}

function tableIdentityKeys(database, table, columns) {
  const primaryKeyColumns = columns
    .filter((column) => Number(column.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((column) => column.name);
  if (primaryKeyColumns.length === 0) {
    throw new Error(`表 ${table} 没有主键，无法建立迁移身份门禁。`);
  }
  const selection = primaryKeyColumns.map(quoteIdentifier).join(', ');
  const orderBy = primaryKeyColumns.map(quoteIdentifier).join(', ');
  return database.prepare(
    `SELECT ${selection} FROM ${quoteIdentifier(table)} ORDER BY ${orderBy}`,
  ).all().map((row) => hashIdentityTuple(table, primaryKeyColumns, row));
}

function hashIdentityTuple(table, primaryKeyColumns, row) {
  const digest = crypto.createHash('sha256');
  hashPart(digest, table);
  for (const column of primaryKeyColumns) {
    hashPart(digest, column);
    hashValue(digest, row[column]);
  }
  return digest.digest('hex');
}

function logicalDigest(database, tableColumns) {
  const digest = crypto.createHash('sha256');
  for (const table of REQUIRED_TABLES) {
    const columns = tableColumns[table];
    hashPart(digest, table);
    hashPart(digest, JSON.stringify(columns.map((column) => ({
      name:column.name,
      type:column.type,
      notnull:Number(column.notnull),
      defaultValue:column.dflt_value,
      primaryKey:Number(column.pk),
    }))));

    const primaryKeyColumns = columns
      .filter((column) => Number(column.pk) > 0)
      .sort((left, right) => Number(left.pk) - Number(right.pk))
      .map((column) => column.name);
    const orderColumns = primaryKeyColumns.length > 0
      ? primaryKeyColumns
      : columns.map((column) => column.name);
    const orderBy = orderColumns.map(quoteIdentifier).join(', ');
    const statement = database.prepare(`SELECT * FROM ${quoteIdentifier(table)} ORDER BY ${orderBy}`);
    for (const row of statement.iterate()) {
      for (const column of columns) hashValue(digest, row[column.name]);
    }
  }
  return digest.digest('hex');
}

function hashPart(digest, value) {
  const bytes = Buffer.from(String(value), 'utf8');
  digest.update(`${bytes.length}:`);
  digest.update(bytes);
}

function hashValue(digest, value) {
  if (value === null) return hashPart(digest, 'null:');
  if (typeof value === 'bigint') return hashPart(digest, `bigint:${value}`);
  if (value instanceof Uint8Array) return hashPart(digest, `blob:${Buffer.from(value).toString('base64')}`);
  return hashPart(digest, `${typeof value}:${String(value)}`);
}

function versionCounts(database, table, column) {
  return database.prepare(
    `SELECT ${quoteIdentifier(column)} AS version, COUNT(*) AS count
       FROM ${quoteIdentifier(table)}
      GROUP BY ${quoteIdentifier(column)}
      ORDER BY ${quoteIdentifier(column)}`,
  ).all().map((row) => ({ version:String(row.version ?? ''), count:Number(row.count) }));
}

function assertVersionsAreNamed(versions, label) {
  if (versions.some(({ version }) => !version.trim())) {
    throw new Error(`${label} 存在空版本，拒绝迁移。`);
  }
}

async function createVerifiedBackup({ sourcePath, expected, backupPath }) {
  const existing = await pathState(backupPath);
  if (existing.exists) {
    if (!existing.isFile || existing.size === 0) {
      throw new Error('同名源快照备份已存在但不是有效普通文件。');
    }
    const manifest = inspectDatabase(backupPath);
    assertEquivalentManifest(expected, manifest, '已有源快照备份');
    await fs.chmod(backupPath, 0o600);
    return manifest;
  }

  const temporary = `${backupPath}.staging-${process.pid}-${crypto.randomUUID()}`;
  let sourceDatabase;
  try {
    sourceDatabase = new DatabaseSync(sourcePath, { readOnly:true });
    sourceDatabase.exec('PRAGMA query_only = ON;');
    await backup(sourceDatabase, temporary);
    await fs.chmod(temporary, 0o600);
    const manifest = inspectDatabase(temporary);
    assertEquivalentManifest(expected, manifest, '新建源快照备份');
    await linkWithoutOverwrite(temporary, backupPath, '源快照备份');
    await fs.chmod(backupPath, 0o600);
    return manifest;
  } finally {
    sourceDatabase?.close();
    await fs.rm(temporary, { force:true }).catch(() => {});
  }
}

async function createOrVerifyMigrationRecord({ recordPath, source, backupPath }) {
  const record = {
    schemaVersion:1,
    source:serializableManifest(source),
    backupFile:path.basename(backupPath),
  };
  const state = await pathState(recordPath);
  if (state.exists) {
    const existing = await readMigrationRecord(recordPath);
    if (JSON.stringify(existing) !== JSON.stringify(record)) {
      throw new Error('不可变迁移记录已存在且与当前源不一致，拒绝覆盖。');
    }
    await fs.chmod(recordPath, 0o600);
    return;
  }

  const temporary = `${recordPath}.staging-${process.pid}-${crypto.randomUUID()}`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag:'wx', mode:0o600 });
    await linkWithoutOverwrite(temporary, recordPath, '不可变迁移记录');
    await fs.chmod(recordPath, 0o600);
  } finally {
    await fs.rm(temporary, { force:true }).catch(() => {});
  }
}

async function readMigrationRecord(recordPath) {
  const state = await pathState(recordPath);
  if (!state.exists || !state.isFile || state.size === 0) {
    throw new Error('缺少不可变迁移记录，不能证明 Docker 源与 A君目标之间的迁移关系。');
  }
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(recordPath, 'utf8'));
  } catch {
    throw new Error('不可变迁移记录不是有效 JSON。');
  }
  if (
    parsed?.schemaVersion !== 1
    || typeof parsed?.source?.digest !== 'string'
    || !parsed?.source?.rowCounts
    || !Array.isArray(parsed?.source?.scoreVersions)
    || !Array.isArray(parsed?.source?.shadowScoreVersions)
    || !parsed?.source?.identityKeys
    || REQUIRED_TABLES.some((table) => !Array.isArray(parsed.source.identityKeys[table]))
    || typeof parsed?.backupFile !== 'string'
  ) {
    throw new Error('不可变迁移记录结构无效。');
  }
  return parsed;
}

function serializableManifest(manifest) {
  return {
    rowCounts:Object.fromEntries(REQUIRED_TABLES.map((table) => [table, Number(manifest.rowCounts[table])])),
    scoreVersions:manifest.scoreVersions.map(({ version, count }) => ({ version, count:Number(count) })),
    shadowScoreVersions:manifest.shadowScoreVersions.map(({ version, count }) => ({ version, count:Number(count) })),
    identityKeys:Object.fromEntries(
      REQUIRED_TABLES.map((table) => [table, [...manifest.identityKeys[table]]]),
    ),
    digest:manifest.digest,
  };
}

async function installTargetFromBackup({ backupPath, targetPath, expected }) {
  const state = await pathState(targetPath);
  if (state.exists) {
    if (state.isFile && state.size > 0) {
      const installed = inspectDatabase(targetPath);
      if (installed.digest === expected.digest) return;
    }
    throw new Error('目标 boom-monitor.sqlite 已存在，拒绝覆盖。');
  }

  const temporary = `${targetPath}.staging-${process.pid}-${crypto.randomUUID()}`;
  try {
    await fs.copyFile(backupPath, temporary, fsConstants.COPYFILE_EXCL);
    await fs.chmod(temporary, 0o600);
    const copied = inspectDatabase(temporary);
    assertEquivalentManifest(expected, copied, '目标暂存数据库');
    await linkWithoutOverwrite(temporary, targetPath, '目标数据库');
    await fs.chmod(targetPath, 0o600);
  } finally {
    await fs.rm(temporary, { force:true }).catch(() => {});
  }
}

async function linkWithoutOverwrite(source, target, label) {
  try {
    await fs.link(source, target);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`${label} 已被其他进程创建，拒绝覆盖。`);
    throw error;
  }
}

async function inspectExistingTarget(targetPath, sourceManifest) {
  const state = await pathState(targetPath);
  if (!state.exists) return { status:'missing' };
  if (!state.isFile || state.size === 0) return { status:'conflict' };
  try {
    const manifest = inspectDatabase(targetPath);
    return { status:manifest.digest === sourceManifest.digest ? 'match' : 'conflict', manifest };
  } catch {
    return { status:'conflict' };
  }
}

async function assertRegularSourceFile(sourcePath) {
  const state = await pathState(sourcePath);
  if (!state.exists) throw new Error('显式指定的源数据库不存在。');
  if (!state.isFile || state.size === 0) throw new Error('源数据库必须是非空普通文件。');
}

async function assertPrivateMode(filePath, label = '目标数据库') {
  const info = await fs.stat(filePath);
  if ((info.mode & 0o777) !== 0o600) throw new Error(`${label}权限不是 0600。`);
}

async function assertProtectedTargetMode(filePath) {
  const info = await fs.stat(filePath);
  const mode = info.mode & 0o777;
  if (mode !== 0o600 && mode !== 0o400) {
    throw new Error('目标数据库权限不是 0600 或回滚只读态 0400。');
  }
}

async function pathState(filePath) {
  try {
    const info = await fs.lstat(filePath);
    return { exists:true, isFile:info.isFile(), size:info.size };
  } catch (error) {
    if (error.code === 'ENOENT') return { exists:false, isFile:false, size:0 };
    throw error;
  }
}

function assertEquivalentManifest(expected, actual, label) {
  if (expected.digest !== actual.digest) throw new Error(`${label}完整逻辑指纹不一致。`);
  if (JSON.stringify(expected.rowCounts) !== JSON.stringify(actual.rowCounts)) {
    throw new Error(`${label}表行数不一致。`);
  }
  if (JSON.stringify(expected.scoreVersions) !== JSON.stringify(actual.scoreVersions)) {
    throw new Error(`${label}正式评分版本不一致。`);
  }
  if (JSON.stringify(expected.shadowScoreVersions) !== JSON.stringify(actual.shadowScoreVersions)) {
    throw new Error(`${label}影子评分版本不一致。`);
  }
  if (JSON.stringify(expected.identityKeys) !== JSON.stringify(actual.identityKeys)) {
    throw new Error(`${label}身份键集合不一致。`);
  }
}

function assertMinimumCounts(sourceCounts, targetCounts) {
  const losses = REQUIRED_TABLES
    .filter((table) => Number(targetCounts[table]) < Number(sourceCounts[table]))
    .map((table) => `${table}:${targetCounts[table]}<${sourceCounts[table]}`);
  if (losses.length > 0) {
    throw new Error(`A君目标数据库少于迁移源的最小行数: ${losses.join(', ')}`);
  }
}

function assertMinimumVersions(sourceVersions, targetVersions, label) {
  const targetByVersion = new Map(targetVersions.map(({ version, count }) => [version, Number(count)]));
  const losses = sourceVersions.filter(({ version, count }) => (targetByVersion.get(version) ?? 0) < Number(count));
  if (losses.length > 0) {
    throw new Error(`A君目标数据库缺少迁移源中的${label}版本记录。`);
  }
}

function assertSourceIdentitiesRemain(sourceIdentities, targetIdentities) {
  const missing = [];
  for (const table of REQUIRED_TABLES) {
    const targetKeys = new Set(targetIdentities[table]);
    const missingCount = sourceIdentities[table].filter((identity) => !targetKeys.has(identity)).length;
    if (missingCount > 0) missing.push(`${table}=${missingCount}`);
  }
  if (missing.length > 0) {
    throw new Error(`A君目标数据库缺少迁移源身份键: ${missing.join(', ')}`);
  }
}

function quoteIdentifier(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

function formatCounts(counts) {
  return REQUIRED_TABLES.map((table) => `${table}=${counts[table]}`).join(', ');
}

function formatVersions(versions) {
  return versions.length === 0 ? '无记录' : versions.map(({ version, count }) => `${version}=${count}`).join(', ');
}

function parseArguments(argumentsList) {
  const parsed = { apply:false, requireTargetMatch:false, help:false };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--apply') parsed.apply = true;
    else if (argument === '--verify-retirement' || argument === '--require-target-match') parsed.requireTargetMatch = true;
    else if (argument === '--help' || argument === '-h') parsed.help = true;
    else if (argument === '--source' || argument === '--data-dir') {
      const value = argumentsList[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} 缺少路径。`);
      parsed[argument === '--source' ? 'source' : 'dataDir'] = value;
      index += 1;
    } else {
      throw new Error('存在未知参数；只接受 --source、--data-dir、--apply 与 --verify-retirement。');
    }
  }
  if (parsed.apply && parsed.requireTargetMatch) {
    throw new Error('--apply 与 --verify-retirement 不能同时使用。');
  }
  return parsed;
}

function safeErrorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  return '未知错误。';
}

function printUsage() {
  console.log('用法: node scripts/migrate-boom-monitor-data.mjs --source <源 SQLite> --data-dir <A君数据目录> [--apply] [--verify-retirement]');
  console.log('默认仅检查；--apply 创建源快照备份、不可变迁移记录和 boom-monitor.sqlite；--verify-retirement 验证 Docker 源未变且 A君目标未丢数据。');
}

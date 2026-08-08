import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const SCRIPT = fileURLToPath(new URL('../scripts/migrate-boom-monitor-data.mjs', import.meta.url));
const LIFECYCLE_SCRIPT = fileURLToPath(new URL('../../../ops/boom-monitor/docker-lifecycle.sh', import.meta.url));
const LAUNCHD_AUTH_HELPER = fileURLToPath(new URL('../../../ops/boom-monitor/update-ajun-launchd-auth.py', import.meta.url));
const SECRET_SENTINEL = 'must-not-appear-in-output-token';

test('默认只读检查不会创建 A君数据目录或目标数据库', async () => {
  const fixture = await createFixture();
  const dataDir = path.join(fixture.directory, 'ajun-data');
  const result = await runMigration('--source', fixture.source, '--data-dir', dataDir);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /模式: 只读检查/);
  assert.match(result.stdout, /目标状态: 不存在/);
  assert.equal(await exists(dataDir), false);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(SECRET_SENTINEL));
});

test('显式 apply 创建经核验的 0600 数据库、备份和不可变记录，重复执行不重复写入', async () => {
  const fixture = await createFixture();
  const dataDir = path.join(fixture.directory, 'ajun-data');
  const first = await runMigration('--source', fixture.source, '--data-dir', dataDir, '--apply');

  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /迁移结果: 已完成/);
  assert.match(first.stdout, /校验结果: 表、行数、正式评分版本、影子评分版本、完整逻辑指纹均一致/);
  const target = path.join(dataDir, 'boom-monitor.sqlite');
  assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
  const backups = await fs.readdir(path.join(dataDir, 'boom-monitor-backups'));
  assert.equal(backups.length, 1);
  assert.equal((await fs.stat(path.join(dataDir, 'boom-monitor-backups', backups[0]))).mode & 0o777, 0o600);
  const recordPath = path.join(dataDir, 'boom-monitor-migration-manifest.json');
  assert.equal((await fs.stat(recordPath)).mode & 0o777, 0o600);
  const recordText = await fs.readFile(recordPath, 'utf8');
  assert.doesNotMatch(recordText, new RegExp(SECRET_SENTINEL));
  const record = JSON.parse(recordText);
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.source.rowCounts.works, 1);
  assert.equal(record.source.scoreVersions[0].version, 'v2');
  assert.equal(record.backupFile, backups[0]);
  assert.equal(record.source.identityKeys.works.length, 1);
  assert.match(record.source.identityKeys.works[0], /^[a-f0-9]{64}$/);
  assert.doesNotMatch(recordText, /creator-1|work-1|private-fixture/);

  const targetDb = new DatabaseSync(target, { readOnly:true });
  assert.deepEqual({ ...targetDb.prepare('SELECT score_version, COUNT(*) AS count FROM scores GROUP BY score_version').get() }, {
    score_version:'v2',
    count:1,
  });
  assert.equal(targetDb.prepare('SELECT COUNT(*) AS count FROM shadow_scores').get().count, 3);
  targetDb.close();

  const second = await runMigration('--source', fixture.source, '--data-dir', dataDir, '--apply');
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /已迁移且与源数据库一致；未覆盖、未重复写入/);
  assert.equal((await fs.readdir(path.join(dataDir, 'boom-monitor-backups'))).length, 1);
  assert.doesNotMatch(`${first.stdout}\n${first.stderr}\n${second.stdout}\n${second.stderr}`, new RegExp(SECRET_SENTINEL));
});

test('非空目标包含不同数据时拒绝覆盖', async () => {
  const fixture = await createFixture();
  const dataDir = path.join(fixture.directory, 'ajun-data');
  await fs.mkdir(dataDir);
  const target = path.join(dataDir, 'boom-monitor.sqlite');
  createBoomDatabase(target, { workId:'different-work' });
  const before = await fs.readFile(target);

  const result = await runMigration('--source', fixture.source, '--data-dir', dataDir, '--apply');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /已存在且含有不同数据，拒绝覆盖/);
  assert.deepEqual(await fs.readFile(target), before);
  assert.equal(await exists(path.join(dataDir, 'boom-monitor-backups')), false);
});

test('退役核验允许 A君新增设置，但要求 Docker 源、迁移记录和备份仍一致', async () => {
  const fixture = await createFixture();
  const dataDir = path.join(fixture.directory, 'ajun-data');
  const missing = await runMigration(
    '--source', fixture.source,
    '--data-dir', dataDir,
    '--verify-retirement',
  );
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /缺少不可变迁移记录/);

  assert.equal((await runMigration('--source', fixture.source, '--data-dir', dataDir, '--apply')).code, 0);
  await fs.chmod(path.join(dataDir, 'boom-monitor.sqlite'), 0o644);
  const insecure = await runMigration(
    '--source', fixture.source,
    '--data-dir', dataDir,
    '--verify-retirement',
  );
  assert.equal(insecure.code, 1);
  assert.match(insecure.stderr, /权限不是 0600/);

  const repaired = await runMigration('--source', fixture.source, '--data-dir', dataDir, '--apply');
  assert.equal(repaired.code, 0, repaired.stderr);
  assert.equal((await fs.stat(path.join(dataDir, 'boom-monitor.sqlite'))).mode & 0o777, 0o600);

  const target = new DatabaseSync(path.join(dataDir, 'boom-monitor.sqlite'));
  target.prepare('INSERT INTO app_settings(key, value_json) VALUES(?, ?)').run('analysis_daily_limit', '5');
  target.close();
  const matched = await runMigration(
    '--source', fixture.source,
    '--data-dir', dataDir,
    '--verify-retirement',
  );
  assert.equal(matched.code, 0, matched.stderr);
  assert.match(matched.stdout, /Docker 当前源未变化/);
  assert.match(matched.stdout, /app_settings=2/);
});

test('退役核验拒绝 Docker 源在迁移后发生变化', async () => {
  const fixture = await createFixture();
  const dataDir = path.join(fixture.directory, 'ajun-data');
  assert.equal((await runMigration('--source', fixture.source, '--data-dir', dataDir, '--apply')).code, 0);

  const source = new DatabaseSync(fixture.source);
  source.prepare('INSERT INTO app_settings(key, value_json) VALUES(?, ?)').run('late-docker-write', '1');
  source.close();
  const result = await runMigration(
    '--source', fixture.source,
    '--data-dir', dataDir,
    '--verify-retirement',
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Docker 当前源数据库完整逻辑指纹不一致/);
});

test('退役核验拒绝 A君目标丢失源行或关键评分版本', async () => {
  const fixture = await createFixture();
  const dataDir = path.join(fixture.directory, 'ajun-data');
  assert.equal((await runMigration('--source', fixture.source, '--data-dir', dataDir, '--apply')).code, 0);

  const target = new DatabaseSync(path.join(dataDir, 'boom-monitor.sqlite'));
  target.exec('DELETE FROM scores;');
  target.close();
  const result = await runMigration(
    '--source', fixture.source,
    '--data-dir', dataDir,
    '--verify-retirement',
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /少于迁移源的最小行数: scores:0<1/);

  const versionChanged = new DatabaseSync(path.join(dataDir, 'boom-monitor.sqlite'));
  versionChanged.prepare('INSERT INTO scores(work_id, score_version, grade, tier) VALUES(1, ?, ?, ?)').run('v3', 'T2', 'T2');
  versionChanged.close();
  const versionResult = await runMigration(
    '--source', fixture.source,
    '--data-dir', dataDir,
    '--verify-retirement',
  );
  assert.equal(versionResult.code, 1);
  assert.match(versionResult.stderr, /缺少迁移源中的正式评分版本记录/);
});

test('退役核验拒绝用等量同版本新行替换源身份键', async () => {
  const fixture = await createFixture();
  const dataDir = path.join(fixture.directory, 'ajun-data');
  assert.equal((await runMigration('--source', fixture.source, '--data-dir', dataDir, '--apply')).code, 0);
  const targetPath = path.join(dataDir, 'boom-monitor.sqlite');

  let target = new DatabaseSync(targetPath);
  target.exec("DELETE FROM scores; INSERT INTO scores(work_id, score_version, grade, tier) VALUES(2, 'v2', 'T2', 'T2');");
  target.close();
  let result = await runMigration('--source', fixture.source, '--data-dir', dataDir, '--verify-retirement');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /缺少迁移源身份键: scores=1/);

  target = new DatabaseSync(targetPath);
  target.exec("DELETE FROM scores; INSERT INTO scores(work_id, score_version, grade, tier) VALUES(1, 'v2', 'T2', 'T2'); DELETE FROM shadow_scores WHERE work_id=1 AND version='v2'; INSERT INTO shadow_scores(work_id, version, grade) VALUES(2, 'v2', 'T2');");
  target.close();
  result = await runMigration('--source', fixture.source, '--data-dir', dataDir, '--verify-retirement');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /缺少迁移源身份键: shadow_scores=1/);

  target = new DatabaseSync(targetPath);
  target.exec("DELETE FROM shadow_scores WHERE work_id=2 AND version='v2'; INSERT INTO shadow_scores(work_id, version, grade) VALUES(1, 'v2', 'T2'); DELETE FROM app_settings; INSERT INTO app_settings(key, value_json) VALUES('replacement-setting', '1');");
  target.close();
  result = await runMigration('--source', fixture.source, '--data-dir', dataDir, '--verify-retirement');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /缺少迁移源身份键: app_settings=1/);
});

test('Docker restore 静态门禁要求先验证 native writer 关闭并把新库设为只读', async () => {
  const source = await fs.readFile(LIFECYCLE_SCRIPT, 'utf8');
  const restoreBlock = source.slice(source.indexOf('  restore)'), source.indexOf('  help|-h|--help)'));
  assert.match(source, /AJUN_BOOM_MONITOR_ENABLED/);
  assert.match(source, /api\/boom-monitor\/health/);
  assert.match(source, /wait_for_ajun_health 503/);
  assert.match(source, /chmod 0400/);
  assert.ok(restoreBlock.indexOf('compose ps --status running') < restoreBlock.indexOf('compose up -d'));
  assert.ok(restoreBlock.indexOf('verify_ajun_writer_fenced') < restoreBlock.indexOf('compose up -d'));
  assert.ok(restoreBlock.indexOf('verify_migrated_target') < restoreBlock.indexOf('compose up -d'));
  assert.ok(restoreBlock.indexOf('configure_rollback_auth_and_restart') < restoreBlock.indexOf('compose up -d'));
  assert.ok(restoreBlock.indexOf('preserve_ajun_database_read_only') < restoreBlock.indexOf('compose up -d'));
  assert.match(source, /api\/integrations\/boom-monitor\/health/);
  assert.match(source, /legacy_bridge_probe 401/);
  assert.match(source, /legacy_bridge_probe 200/);
  assert.match(source, /mktemp -d "\$data_dir\/\.boom-monitor-retirement\.XXXXXX"/);
  assert.match(source, /mode=ro&immutable=1/);
  assert.match(source, /resume-native/);
  assert.match(source, /verify-native/);
  assert.doesNotMatch(source, /chmod\s+0[46]00\s+--/);
});

test('launchd 回滚认证助手通过 stdin 注入同一 Token，恢复 native 时彻底移除', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'boom-launchd-auth-'));
  const plist = path.join(directory, 'ai.agent-army.ajun-runtime.plist');
  await fs.writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>ai.agent-army.ajun-runtime</string><key>EnvironmentVariables</key><dict><key>AJUN_BOOM_MONITOR_ENABLED</key><string>false</string></dict></dict></plist>\n`);
  const token = crypto.randomBytes(32).toString('hex');

  const rollback = await runCommand('python3', [LAUNCHD_AUTH_HELPER, 'rollback', plist], token);
  assert.equal(rollback.code, 0, rollback.stderr);
  assert.doesNotMatch(`${rollback.stdout}\n${rollback.stderr}`, new RegExp(token));
  assert.equal((await fs.stat(plist)).mode & 0o777, 0o600);
  assert.equal((await runCommand('python3', [LAUNCHD_AUTH_HELPER, 'verify-rollback', plist], token)).code, 0);

  const native = await runCommand('python3', [LAUNCHD_AUTH_HELPER, 'native', plist], '');
  assert.equal(native.code, 0, native.stderr);
  assert.equal((await runCommand('python3', [LAUNCHD_AUTH_HELPER, 'verify-native', plist], '')).code, 0);
  assert.doesNotMatch(await fs.readFile(plist, 'utf8'), new RegExp(token));
});

test('缺少关键表时拒绝迁移', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'boom-migration-invalid-'));
  const source = path.join(directory, 'invalid.sqlite');
  const database = new DatabaseSync(source);
  database.exec('CREATE TABLE scores(work_id INTEGER PRIMARY KEY, score_version TEXT, grade TEXT, tier TEXT);');
  database.close();

  const result = await runMigration('--source', source, '--data-dir', path.join(directory, 'data'), '--apply');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /缺少必需表/);
});

async function createFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'boom-migration-'));
  const source = path.join(directory, 'source.sqlite');
  createBoomDatabase(source, { workId:'work-1' });
  return { directory, source };
}

function createBoomDatabase(filePath, { workId }) {
  const database = new DatabaseSync(filePath);
  database.exec(`
    CREATE TABLE creators(id INTEGER PRIMARY KEY, platform TEXT NOT NULL, creator_id TEXT NOT NULL);
    CREATE TABLE works(id INTEGER PRIMARY KEY, creator_id INTEGER NOT NULL, work_id TEXT NOT NULL);
    CREATE TABLE score_baselines(id INTEGER PRIMARY KEY, creator_id INTEGER NOT NULL);
    CREATE TABLE scores(work_id INTEGER PRIMARY KEY, score_version TEXT NOT NULL, grade TEXT NOT NULL, tier TEXT NOT NULL);
    CREATE TABLE shadow_scores(work_id INTEGER NOT NULL, version TEXT NOT NULL, grade TEXT NOT NULL, PRIMARY KEY(work_id, version));
    CREATE TABLE scan_jobs(id INTEGER PRIMARY KEY, status TEXT);
    CREATE TABLE analysis_queue(id INTEGER PRIMARY KEY, work_id INTEGER);
    CREATE TABLE transcripts(work_id INTEGER PRIMARY KEY, transcript_text TEXT);
    CREATE TABLE app_settings(key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
  `);
  database.prepare('INSERT INTO creators(id, platform, creator_id) VALUES(1, ?, ?)').run('xiaohongshu', 'creator-1');
  database.prepare('INSERT INTO works(id, creator_id, work_id) VALUES(1, 1, ?)').run(workId);
  database.prepare('INSERT INTO scores(work_id, score_version, grade, tier) VALUES(1, ?, ?, ?)').run('v2', 'T2', 'T2');
  for (const version of ['legacy-v1', 'shadow-v2', 'v2']) {
    database.prepare('INSERT INTO shadow_scores(work_id, version, grade) VALUES(1, ?, ?)').run(version, 'T2');
  }
  database.prepare('INSERT INTO app_settings(key, value_json) VALUES(?, ?)').run('private-fixture', SECRET_SENTINEL);
  database.close();
}

function runMigration(...argumentsList) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...argumentsList], {
      env:{ ...process.env, NODE_NO_WARNINGS:'1' },
      stdio:['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function runCommand(command, argumentsList, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argumentsList, {
      env:{ ...process.env, BOOM_MONITOR_BEARER_TOKEN:'' },
      stdio:['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

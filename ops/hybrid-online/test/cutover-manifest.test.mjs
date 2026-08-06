import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CutoverManifestError,
  REQUIRED_STATE_PATHS,
  verifyCutoverManifest,
  writeCutoverManifest
} from '../cutover/manifest.mjs';
import { applyCutoverState, CutoverApplyError } from '../cutover/apply-state.mjs';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-cutover-test-'));
  for (const relativePath of REQUIRED_STATE_PATHS) {
    const absolutePath = path.join(root, ...relativePath.split('/'));
    await fs.mkdir(path.dirname(absolutePath), { recursive:true });
    await fs.writeFile(absolutePath, `fixture:${relativePath}\n`, { mode:0o600 });
  }
  const backup = path.join(root, 'paperclip/backups/cutover.sql.gz');
  await fs.mkdir(path.dirname(backup), { recursive:true });
  await fs.writeFile(backup, 'portable-sql-fixture', { mode:0o600 });
  return root;
}

test('迁移清单覆盖三名员工连续记忆、任务真相、飞书配置和 Paperclip 可移植备份', async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const manifest = await writeCutoverManifest({
    root,
    sourceHead:'a'.repeat(40),
    sourceBranch:'codex/m2-cutover'
  });
  assert.ok(manifest.files.length > REQUIRED_STATE_PATHS.length);
  assert.deepEqual(await verifyCutoverManifest({ root }), manifest);
});

test('迁移文件被修改后校验失败关闭', async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  await writeCutoverManifest({ root, sourceHead:'b'.repeat(40), sourceBranch:'codex/m2-cutover' });
  await fs.appendFile(path.join(root, 'agent-army/runtime.json'), 'tampered');
  await assert.rejects(() => verifyCutoverManifest({ root }), CutoverManifestError);
});

test('迁移清单拒绝缺少员工会话或包含多个 Paperclip 备份', async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  await fs.rm(path.join(root, 'hermes/profiles/intel-researcher/sessions/sessions.json'));
  await assert.rejects(
    () => writeCutoverManifest({ root, sourceHead:'c'.repeat(40), sourceBranch:'codex/m2-cutover' }),
    /缺少/
  );
  await fs.mkdir(path.join(root, 'hermes/profiles/intel-researcher/sessions'), { recursive:true });
  await fs.writeFile(path.join(root, 'hermes/profiles/intel-researcher/sessions/sessions.json'), 'restored');
  await fs.writeFile(path.join(root, 'paperclip/backups/second.sql.gz'), 'duplicate');
  await assert.rejects(
    () => writeCutoverManifest({ root, sourceHead:'c'.repeat(40), sourceBranch:'codex/m2-cutover' }),
    /只能包含一个/
  );
});

test('迁移清单拒绝符号链接，避免归档越界读取', async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  await fs.symlink('/etc/passwd', path.join(root, 'private/unsafe-link'));
  await assert.rejects(
    () => writeCutoverManifest({ root, sourceHead:'d'.repeat(40), sourceBranch:'codex/m2-cutover' }),
    /不允许符号链接/
  );
});

test('隔离导入把员工状态映射到 Linux 数据布局且不复制 Paperclip 原始数据库', async (t) => {
  const root = await fixture();
  const target = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-cutover-target-'));
  t.after(() => Promise.all([
    fs.rm(root, { recursive:true, force:true }),
    fs.rm(target, { recursive:true, force:true })
  ]));
  await fs.mkdir(path.join(root, 'paperclip/instance/data/storage'), { recursive:true });
  await fs.writeFile(path.join(root, 'paperclip/instance/data/storage/attachment.txt'), 'attachment');
  await fs.mkdir(path.join(root, 'paperclip/instance/db'), { recursive:true });
  await fs.writeFile(path.join(root, 'paperclip/instance/db/forbidden-raw-db'), 'must-not-exist');
  await fs.rm(path.join(root, 'paperclip/instance/db'), { recursive:true });
  await writeCutoverManifest({ root, sourceHead:'e'.repeat(40), sourceBranch:'codex/m2-cutover' });

  const result = await applyCutoverState({ sourceRoot:root, dataRoot:path.join(target, 'data') });
  assert.equal(result.sourceHead, 'e'.repeat(40));
  assert.equal(await fs.readFile(path.join(target, 'data/runtime.json'), 'utf8'), 'fixture:agent-army/runtime.json\n');
  assert.equal(
    await fs.readFile(path.join(target, 'data/hermes/profiles/intel-researcher/sessions/sessions.json'), 'utf8'),
    'fixture:hermes/profiles/intel-researcher/sessions/sessions.json\n'
  );
  assert.equal(await fs.readFile(path.join(target, 'data/.paperclip/instances/default/data/storage/attachment.txt'), 'utf8'), 'attachment');
  await assert.rejects(() => fs.stat(path.join(target, 'data/.paperclip/instances/default/db')), { code:'ENOENT' });
  assert.equal(await fs.readFile(result.backupPath, 'utf8'), 'portable-sql-fixture');
});

test('隔离导入拒绝宽泛目标目录', async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  await writeCutoverManifest({ root, sourceHead:'f'.repeat(40), sourceBranch:'codex/m2-cutover' });
  await assert.rejects(() => applyCutoverState({ sourceRoot:root, dataRoot:'/' }), CutoverApplyError);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { TechnicalRepairPromotion } from '../src/technical-repair-promotion.ts';

const evidence = { metadata:{ agentArmyRepairEvidence:{ changedFiles:['src/fix.js'], testsPassed:true, recoveryVerified:true } } };
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const repairTask = (workspace, files = ['src/fix.js']) => ({
  taskId:'repair-task-123',
  execution:{ workspace:{ path:workspace } },
  input:{ context:{ repairScope:{ files } } },
});
const snapshot = (files) => ({
  version:2,
  taskId:'repair-task-123',
  sourceIdentity:null,
  files:Object.fromEntries(
    Object.entries(files).map(([file, content]) => [file, { sourceHash:hash(content) }]),
  ),
});

test('检查通过且主工程未变化时，A君 才带回允许范围内的修复', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-promotion-'))); const workspace = path.join(root, 'workspace');
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  await fs.mkdir(path.join(root, 'src'), { recursive:true }); await fs.mkdir(path.join(workspace, 'src'), { recursive:true });
  await fs.writeFile(path.join(root, 'src/fix.js'), 'before\n'); await fs.writeFile(path.join(workspace, 'src/fix.js'), 'after\n');
  await fs.writeFile(path.join(workspace, '.agent-army-repair-snapshot.json'), JSON.stringify(snapshot({ 'src/fix.js':'before\n' })));
  const result = await new TechnicalRepairPromotion({ projectRoot:root }).promote(repairTask(workspace), evidence);
  assert.equal(result.status, 'promoted'); assert.equal(await fs.readFile(path.join(root, 'src/fix.js'), 'utf8'), 'after\n');
});

test('主工程同一文件已经变化时，A君 不覆盖并留下冲突', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-promotion-'))); const workspace = path.join(root, 'workspace');
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  await fs.mkdir(path.join(root, 'src'), { recursive:true }); await fs.mkdir(path.join(workspace, 'src'), { recursive:true });
  await fs.writeFile(path.join(root, 'src/fix.js'), 'someone else\n'); await fs.writeFile(path.join(workspace, 'src/fix.js'), 'after\n');
  await fs.writeFile(path.join(workspace, '.agent-army-repair-snapshot.json'), JSON.stringify(snapshot({ 'src/fix.js':'before\n' })));
  const result = await new TechnicalRepairPromotion({ projectRoot:root }).promote(repairTask(workspace), evidence);
  assert.equal(result.status, 'conflict'); assert.equal(await fs.readFile(path.join(root, 'src/fix.js'), 'utf8'), 'someone else\n');
});

test('外置源码根只标记候选已更新，不冒充运行 release 已修复', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-promotion-candidate-')));
  const workspace = path.join(root, 'workspace');
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  await fs.mkdir(path.join(root, 'src'), { recursive:true });
  await fs.mkdir(path.join(workspace, 'src'), { recursive:true });
  await fs.writeFile(path.join(root, 'src/fix.js'), 'before\n');
  await fs.writeFile(path.join(workspace, 'src/fix.js'), 'after\n');
  await fs.writeFile(
    path.join(workspace, '.agent-army-repair-snapshot.json'),
    JSON.stringify(snapshot({ 'src/fix.js':'before\n' })),
  );
  const result = await new TechnicalRepairPromotion({
    projectRoot:root,
    sourceMode:'external_writable_git_root',
  }).promote(repairTask(workspace), evidence);
  assert.equal(result.status, 'candidate_promoted');
  assert.equal(result.recommendedCompletionStatus, 'waiting_test');
  assert.match(result.nextAction, /不可变 release/);
});

test('源码或工作区文件为 symlink 时拒绝晋升且不能改写根外文件', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-promotion-symlink-')));
  const workspace = path.join(root, 'workspace');
  const outside = path.join(root, '..', `outside-${crypto.randomUUID()}.js`);
  t.after(async () => {
    await fs.rm(root, { recursive:true, force:true });
    await fs.rm(outside, { force:true });
  });
  await fs.mkdir(path.join(root, 'src'), { recursive:true });
  await fs.mkdir(path.join(workspace, 'src'), { recursive:true });
  await fs.writeFile(outside, 'outside\n');
  await fs.symlink(outside, path.join(root, 'src/fix.js'));
  await fs.writeFile(path.join(workspace, 'src/fix.js'), 'after\n');
  await fs.writeFile(
    path.join(workspace, '.agent-army-repair-snapshot.json'),
    JSON.stringify(snapshot({ 'src/fix.js':'outside\n' })),
  );
  const result = await new TechnicalRepairPromotion({ projectRoot:root })
    .promote(repairTask(workspace), evidence);
  assert.equal(result.status, 'rejected');
  assert.match(result.reason, /符号链接/);
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside\n');
});

test('多文件晋升中途失败时回滚已经替换的文件，不留下半写', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-promotion-rollback-')));
  const workspace = path.join(root, 'workspace');
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  await fs.mkdir(path.join(root, 'src'), { recursive:true });
  await fs.mkdir(path.join(workspace, 'src'), { recursive:true });
  for (const [file, content] of [['a.js', 'a-before\n'], ['b.js', 'b-before\n']]) {
    await fs.writeFile(path.join(root, 'src', file), content);
    await fs.writeFile(path.join(workspace, 'src', file), content.replace('before', 'after'));
  }
  await fs.writeFile(
    path.join(workspace, '.agent-army-repair-snapshot.json'),
    JSON.stringify(snapshot({
      'src/a.js':'a-before\n',
      'src/b.js':'b-before\n',
    })),
  );
  const fsImpl = new Proxy(fs, {
    get(target, property) {
      if (property !== 'rename') return target[property];
      return async (oldPath, newPath) => {
        if (
          String(oldPath).includes('.agent-army-new-')
          && newPath === path.join(root, 'src/b.js')
        ) throw new Error('fixture rename failure');
        return fs.rename(oldPath, newPath);
      };
    },
  });
  const proof = {
    metadata:{
      agentArmyRepairEvidence:{
        changedFiles:['src/a.js', 'src/b.js'],
        testsPassed:true,
        recoveryVerified:true,
      },
    },
  };
  const result = await new TechnicalRepairPromotion({ projectRoot:root, fsImpl })
    .promote(repairTask(workspace, ['src/a.js', 'src/b.js']), proof);
  assert.equal(result.status, 'conflict');
  assert.equal(await fs.readFile(path.join(root, 'src/a.js'), 'utf8'), 'a-before\n');
  assert.equal(await fs.readFile(path.join(root, 'src/b.js'), 'utf8'), 'b-before\n');
});

test('多文件回滚也失败时保留唯一恢复锚并返回准确路径', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-promotion-recovery-')));
  const workspace = path.join(root, 'workspace');
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  await fs.mkdir(path.join(root, 'src'), { recursive:true });
  await fs.mkdir(path.join(workspace, 'src'), { recursive:true });
  for (const [file, content] of [['a.js', 'a-before\n'], ['b.js', 'b-before\n']]) {
    await fs.writeFile(path.join(root, 'src', file), content);
    await fs.writeFile(path.join(workspace, 'src', file), content.replace('before', 'after'));
  }
  await fs.writeFile(
    path.join(workspace, '.agent-army-repair-snapshot.json'),
    JSON.stringify(snapshot({
      'src/a.js':'a-before\n',
      'src/b.js':'b-before\n',
    })),
  );
  const sourceA = path.join(root, 'src/a.js');
  const sourceB = path.join(root, 'src/b.js');
  const fsImpl = new Proxy(fs, {
    get(target, property) {
      if (property !== 'rename') return target[property];
      return async (oldPath, newPath) => {
        if (String(oldPath).includes('.agent-army-new-') && newPath === sourceB) {
          throw new Error('fixture commit failure');
        }
        if (String(oldPath).includes('.agent-army-old-') && newPath === sourceA) {
          throw new Error('fixture rollback failure');
        }
        return fs.rename(oldPath, newPath);
      };
    },
  });
  const proof = {
    metadata:{
      agentArmyRepairEvidence:{
        changedFiles:['src/a.js', 'src/b.js'],
        testsPassed:true,
        recoveryVerified:true,
      },
    },
  };
  const result = await new TechnicalRepairPromotion({ projectRoot:root, fsImpl })
    .promote(repairTask(workspace, ['src/a.js', 'src/b.js']), proof);
  assert.equal(result.status, 'recovery_required');
  assert.equal(result.rollbackFailures.length, 1);
  assert.equal(result.rollbackFailures[0].source, sourceA);
  assert.match(result.rollbackFailures[0].backup, /\.agent-army-old-/);
  assert.equal(
    await fs.readFile(result.rollbackFailures[0].backup, 'utf8'),
    'a-before\n',
  );
  assert.equal(await fs.readFile(sourceA, 'utf8'), 'a-after\n');
  assert.equal(await fs.readFile(sourceB, 'utf8'), 'b-before\n');
});

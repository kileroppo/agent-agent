import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  atomicWriteFile,
  replaceExactlyOnce,
  replaceRequired,
  resolveHermesTarget,
} from '../scripts/patch-support.mjs';

test('Hermes 目标既可由根目录定位，也可接受精确 Python 文件', () => {
  const root = path.join(path.sep, 'opt', 'hermes-agent');
  const relativePath = path.join('gateway', 'run.py');
  const filePath = path.join(root, relativePath);

  assert.deepEqual(resolveHermesTarget(root, relativePath), { root, filePath });
  assert.deepEqual(resolveHermesTarget(filePath, relativePath), { root, filePath });
});

test('必需替换保持首次替换语义，精确替换拒绝重复锚点', () => {
  assert.equal(replaceRequired('a a', 'a', 'b', 'missing'), 'b a');
  assert.equal(replaceExactlyOnce('a', 'a', 'b', 'changed'), 'b');
  assert.throws(() => replaceRequired('a', 'b', 'c', 'missing'), /missing/);
  assert.throws(() => replaceExactlyOnce('a a', 'a', 'b', 'changed'), /changed/);
});

test('原子写入替换内容并保留现有权限', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-hermes-patch-'));
  context.after(() => fs.rm(directory, { recursive:true, force:true }));
  const filePath = path.join(directory, 'run.py');
  await fs.writeFile(filePath, 'before', { mode:0o640 });

  await atomicWriteFile(filePath, 'after');

  assert.equal(await fs.readFile(filePath, 'utf8'), 'after');
  assert.equal((await fs.stat(filePath)).mode & 0o777, 0o640);
  assert.deepEqual(await fs.readdir(directory), ['run.py']);
});

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  atomicWriteFile,
  patchHermesTextFile,
  replaceExactlyOnce,
  replaceRequired,
  resolveHermesTarget,
  transformAndWriteTextFiles,
} from '../scripts/patch-support.mjs';

const scriptsDirectory = fileURLToPath(new URL('../scripts/', import.meta.url));

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

test('原子写入只在内容变化时替换文件，并保留现有权限', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-hermes-patch-'));
  context.after(() => fs.rm(directory, { recursive:true, force:true }));
  const filePath = path.join(directory, 'run.py');
  await fs.writeFile(filePath, 'before', { mode:0o640 });

  assert.equal(await atomicWriteFile(filePath, 'after'), true);

  assert.equal(await fs.readFile(filePath, 'utf8'), 'after');
  assert.equal((await fs.stat(filePath)).mode & 0o777, 0o640);
  const installed = await fs.stat(filePath);
  assert.equal(await atomicWriteFile(filePath, Buffer.from('after')), false);
  const unchanged = await fs.stat(filePath);
  assert.equal(unchanged.ino, installed.ino);
  assert.equal(unchanged.mtimeMs, installed.mtimeMs);
  assert.deepEqual(await fs.readdir(directory), ['run.py']);
});

test('统一补丁入口在读取目标前失败关闭未锁定的 Hermes 安装', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-hermes-unpinned-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const relativePath = path.join('gateway', 'run.py');
  await fs.mkdir(path.dirname(path.join(root, relativePath)), { recursive:true });
  await fs.writeFile(path.join(root, 'pyproject.toml'), 'version = "0.19.1"\n');
  await fs.writeFile(path.join(root, relativePath), 'anchor\n');

  await assert.rejects(
    patchHermesTextFile({
      input: root,
      relativePath,
      transform: (source) => source.replace('anchor', 'patched'),
    }),
    /缺少可验证 Git 身份|版本未通过锁定校验/,
  );
  assert.equal(await fs.readFile(path.join(root, relativePath), 'utf8'), 'anchor\n');
});

test('所有 Hermes 可执行补丁都经过统一版本锁', async () => {
  const scriptNames = (await fs.readdir(scriptsDirectory))
    .filter((name) => name.startsWith('patch-') && name.endsWith('.mjs') && name !== 'patch-support.mjs');
  for (const scriptName of scriptNames) {
    const source = await fs.readFile(path.join(scriptsDirectory, scriptName), 'utf8');
    assert.match(
      source,
      /await (?:patchHermesTextFiles?|verifyHermesTarget|resolveAndVerifyHermesTarget)\(/,
      `${scriptName} 未接入 Hermes 版本锁`,
    );
  }
});

test('多目标补丁全部读取并转换成功后才开始写入', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-hermes-batch-'));
  context.after(() => fs.rm(directory, { recursive:true, force:true }));
  const first = path.join(directory, 'gateway.py');
  const second = path.join(directory, 'onboarding.py');
  await fs.writeFile(first, 'gateway-before');
  await fs.writeFile(second, 'onboarding-before');

  await assert.rejects(
    transformAndWriteTextFiles([
      { filePath:first, transform: () => 'gateway-after' },
      { filePath:second, transform: () => { throw new Error('second anchor changed'); } },
    ]),
    /second anchor changed/,
  );
  assert.equal(await fs.readFile(first, 'utf8'), 'gateway-before');
  assert.equal(await fs.readFile(second, 'utf8'), 'onboarding-before');
});

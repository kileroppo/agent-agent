import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyVersionLockedFile,
  contentPluginStepfunShaForVersion,
  patchHostSource,
  resolveCompatibilityTargets,
  rollbackVersionLockedFile,
  serializePaperclipHttpBody,
} from '../compat/paperclip-2026-722-binary-rpc.ts';
import { main as applyMain } from '../scripts/apply-paperclip-2026-722-binary-rpc.mjs';
import { main as rollbackMain } from '../scripts/rollback-paperclip-2026-722-binary-rpc.mjs';

test('二进制含0x00、0xff和U+FFFD字节时Base64往返无损，文本响应不变', () => {
  const binary = Buffer.from([0x00, 0xff, 0xef, 0xbf, 0xbd, 0x41]);
  const encoded = serializePaperclipHttpBody({
    'content-type':'audio/mpeg',
    'x-paperclip-body-encoding':'upstream-spoof',
  }, binary);
  assert.equal(encoded.headers['x-paperclip-body-encoding'], 'base64');
  assert.deepEqual(Buffer.from(encoded.body, 'base64'), binary);

  const text = Buffer.from('{"message":"你好�"}');
  const serializedText = serializePaperclipHttpBody({
    'content-type':'application/json; charset=utf-8',
    'x-paperclip-body-encoding':'upstream-spoof',
  }, text);
  assert.equal(serializedText.body, text.toString('utf8'));
  assert.equal('x-paperclip-body-encoding' in serializedText.headers, false);

  const missingContentType = serializePaperclipHttpBody({}, text);
  assert.equal(missingContentType.body, text.toString('utf8'));
  assert.equal('x-paperclip-body-encoding' in missingContentType.headers, false);
});

test('版本锁定文件补丁使用wx备份、校验原/目标SHA、幂等并可恢复', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paperclip-binary-rpc-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const file = path.join(root, 'host.js');
  const backupFile = `${file}.bak`;
  const original = Buffer.from('original-2026.722.0\n');
  const patched = Buffer.from('patched-base64-transport\n');
  await fs.writeFile(file, original, { mode:0o644 });

  const input = {
    file,
    backupFile,
    originalSha:sha256(original),
    patchedSha:sha256(patched),
    patch:async () => patched,
  };
  assert.deepEqual(await applyVersionLockedFile(input), {
    changed:true,
    status:'applied',
  });
  assert.deepEqual(await fs.readFile(file), patched);
  assert.deepEqual(await fs.readFile(backupFile), original);
  assert.equal((await fs.stat(backupFile)).mode & 0o777, 0o600);
  assert.deepEqual(await applyVersionLockedFile(input), {
    changed:false,
    status:'already_applied',
  });

  assert.deepEqual(await rollbackVersionLockedFile(input), {
    changed:true,
    status:'rolled_back',
  });
  assert.deepEqual(await fs.readFile(file), original);
  assert.deepEqual(await rollbackVersionLockedFile(input), {
    changed:false,
    status:'already_rolled_back',
  });
  assert.deepEqual(await fs.readFile(backupFile), original);
});

test('未知源码SHA、损坏备份和未知Paperclip版本均失败关闭', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paperclip-binary-rpc-deny-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const file = path.join(root, 'host.js');
  const backupFile = `${file}.bak`;
  const original = Buffer.from('expected');
  const patched = Buffer.from('patched');
  await fs.writeFile(file, 'unknown');
  await assert.rejects(applyVersionLockedFile({
    file,
    backupFile,
    originalSha:sha256(original),
    patchedSha:sha256(patched),
    patch:async () => patched,
  }), /既非原版也非目标版/);
  await assert.rejects(fs.stat(backupFile), { code:'ENOENT' });

  await fs.writeFile(file, original);
  await fs.writeFile(backupFile, 'tampered', { flag:'wx' });
  await assert.rejects(applyVersionLockedFile({
    file,
    backupFile,
    originalSha:sha256(original),
    patchedSha:sha256(patched),
    patch:async () => patched,
  }), /备份SHA不匹配/);
  assert.equal(await fs.readFile(backupFile, 'utf8'), 'tampered');

  const paperclipRoot = path.join(root, 'node_modules', 'paperclipai');
  const pluginRoot = path.join(root, 'plugin');
  await fs.mkdir(path.join(paperclipRoot, 'dist'), { recursive:true });
  await fs.mkdir(path.join(pluginRoot, 'src'), { recursive:true });
  await fs.writeFile(path.join(paperclipRoot, 'package.json'), JSON.stringify({
    name:'paperclipai',
    version:'2099.1.0',
  }));
  await fs.writeFile(path.join(paperclipRoot, 'dist', 'index.js'), '');
  await fs.writeFile(path.join(pluginRoot, 'package.json'), JSON.stringify({
    name:'@agent-army/paperclip-content-autonomy',
    version:'0.4.9',
  }));
  await fs.writeFile(path.join(pluginRoot, 'src', 'worker.js'), '');
  await assert.rejects(resolveCompatibilityTargets({
    paperclipEntry:path.join(paperclipRoot, 'dist', 'index.js'),
    pluginEntry:path.join(pluginRoot, 'src', 'worker.js'),
  }), /只允许 Paperclip 2026\.722\.0/);
  assert.throws(() => patchHostSource('unknown source'), /SHA或补丁锚点不匹配/);
});

test('0.5.0使用TS版StepFun SHA，0.4.x保留历史哈希且0.4.7回滚链不变', async (context) => {
  assert.equal(
    contentPluginStepfunShaForVersion('0.4.6'),
    'd0c3ba28e2a175e16beacf3f2ee2761caa77aec5a6b62cf710869210be11ecf7',
  );
  assert.equal(
    contentPluginStepfunShaForVersion('0.4.7'),
    'd0c3ba28e2a175e16beacf3f2ee2761caa77aec5a6b62cf710869210be11ecf7',
  );
  assert.equal(
    contentPluginStepfunShaForVersion('0.4.8'),
    'df8223807097e865db59b80a109530030ff36ffb06e032426fa01366404be4de',
  );
  assert.equal(
    contentPluginStepfunShaForVersion('0.4.9'),
    'df8223807097e865db59b80a109530030ff36ffb06e032426fa01366404be4de',
  );
  assert.equal(
    contentPluginStepfunShaForVersion('0.5.0'),
    '6f0303f47cebebc6e02ea29a4a0bc8ec0397f652628215a35b41018f3d71f244',
  );
  assert.equal(contentPluginStepfunShaForVersion('0.4.5'), null);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paperclip-binary-rpc-old-plugin-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const paperclipRoot = path.join(root, 'node_modules', 'paperclipai');
  const serverRoot = path.join(root, 'node_modules', '@paperclipai', 'server');
  const pluginRoot = path.join(root, 'content-autonomy-bundle-0.5.0-fixture');
  const paperclipEntry = path.join(paperclipRoot, 'dist', 'index.js');
  const hostFile = path.join(serverRoot, 'dist', 'services', 'plugin-host-services.js');
  const pluginEntry = path.join(pluginRoot, 'src', 'worker.ts');
  await fs.mkdir(path.dirname(paperclipEntry), { recursive:true });
  await fs.mkdir(path.dirname(hostFile), { recursive:true });
  await fs.mkdir(path.dirname(pluginEntry), { recursive:true });
  await fs.writeFile(path.join(paperclipRoot, 'package.json'), JSON.stringify({
    name:'paperclipai',
    version:'2026.722.0',
  }));
  await fs.writeFile(path.join(serverRoot, 'package.json'), JSON.stringify({
    name:'@paperclipai/server',
    version:'2026.722.0',
  }));
  await fs.writeFile(path.join(pluginRoot, 'package.json'), JSON.stringify({
    name:'@agent-army/paperclip-content-autonomy',
    version:'0.5.0',
  }));
  await fs.writeFile(paperclipEntry, '');
  await fs.writeFile(hostFile, '');
  await fs.writeFile(pluginEntry, '');
  await fs.copyFile(
    new URL('../plugins/content-autonomy/src/stepfun-tools.ts', import.meta.url),
    path.join(pluginRoot, 'src', 'stepfun-tools.ts'),
  );
  await fs.copyFile(
    new URL('../plugins/content-autonomy/src/stepfun-tools.ts', import.meta.url),
    path.join(pluginRoot, 'src', 'stepfun-tools.js'),
  );

  const targets = await resolveCompatibilityTargets({
    paperclipEntry,
    pluginEntry,
  });
  assert.equal(targets.pluginRoot, await fs.realpath(pluginRoot));
  assert.equal(targets.hostFile, await fs.realpath(hostFile));

  await fs.writeFile(path.join(pluginRoot, 'package.json'), JSON.stringify({
    name:'@agent-army/paperclip-content-autonomy',
    version:'0.4.7',
  }));
  await assert.rejects(
    resolveCompatibilityTargets({
      paperclipEntry,
      pluginEntry,
      expectedPluginVersion:'0.4.7',
    }),
    /StepFun二进制解码实现SHA不匹配/,
  );
  await assert.rejects(
    resolveCompatibilityTargets({
      paperclipEntry,
      pluginEntry,
      expectedPluginVersion:'0.4.5',
    }),
    /版本不在binary-RPC兼容白名单/,
  );
});

test('apply和rollback CLI缺少显式版本及动作确认时不会修改', async () => {
  await assert.rejects(applyMain([]), /显式确认/);
  await assert.rejects(rollbackMain([]), /显式确认/);
});

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

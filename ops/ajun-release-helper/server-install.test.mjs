import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { buildLaunchAgentPlist, installReleaseHelper } from './install.mjs';
import { startReleaseHelper } from './server.mjs';

test('LaunchAgent 固定入口并转义路径，不携带任意命令或凭据', () => {
  const plist = buildLaunchAgentPlist({
    nodePath:'/runtime/node', serverPath:'/helper/a&b/server.mjs', configPath:'/state/config.json',
    workingDirectory:'/helper/a&b', stdoutPath:'/state/out.log', stderrPath:'/state/error.log',
  });
  assert.match(plist, /ai\.agent-army\.release-helper/);
  assert.match(plist, /a&amp;b/);
  assert.match(plist, /<string>--config<\/string>/);
  assert.doesNotMatch(plist, /API_KEY|TOKEN|Cookie|<key>Shell/);
  assert.throws(() => buildLaunchAgentPlist({ nodePath:'node', serverPath:'/a', configPath:'/b', workingDirectory:'/c', stdoutPath:'/d', stderrPath:'/e' }), /绝对路径/);
});

test('安装包冻结正式 validator 完整依赖，真实导入启动且拒绝复用被篡改 bundle', async (context) => {
  const root = await fs.mkdtemp('/tmp/ajun-release-install-');
  let helper = null;
  context.after(async () => {
    if (helper) await helper.close();
    await makeTreeMutable(root);
    await fs.rm(root, { recursive:true, force:true });
  });
  const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
  const commands = [];
  const install = () => installReleaseHelper({
    repositoryRoot,
    homeDir:root,
    nodePath:process.execPath,
    runCommand:async (command, args) => {
      commands.push([command, ...args]);
      return { code:0 };
    },
  });
  const result = await install();
  const bundleFiles = [
    'apps/ajun-runtime/scripts/manage-immutable-runtime-release.mjs',
    'apps/ajun-runtime/src/runtime-source-root.ts',
    'ops/ajun-release-helper/release-coordinator.mjs',
    'ops/ajun-release-helper/server.mjs',
    'ops/ajun-release-helper/system-adapter.mjs',
  ];
  assert.match(path.basename(result.bundleRoot), /^bundle-[a-f0-9]{16}$/);
  assert.equal((await fs.lstat(result.bundleRoot)).mode & 0o777, 0o555);
  for (const relative of bundleFiles) {
    const stat = await fs.lstat(path.join(result.bundleRoot, relative));
    assert.equal(stat.isFile() && !stat.isSymbolicLink(), true, relative);
    assert.equal(stat.mode & 0o777, 0o444, relative);
  }
  const installedServerPath = path.join(result.bundleRoot, 'ops', 'ajun-release-helper', 'server.mjs');
  assert.match(await fs.readFile(result.plistPath, 'utf8'), new RegExp(escapeRegExp(installedServerPath)));
  const installedServer = await import(`${pathToFileURL(installedServerPath).href}?installed=${Date.now()}`);
  assert.equal(typeof installedServer.startReleaseHelper, 'function');
  helper = await installedServer.startReleaseHelper({
    configPath:path.join(result.stateDir, 'config.json'),
  });
  assert.equal((await request(result.socketPath, 'GET', '/health')).body.ok, true);
  assert.equal(commands.some(([command]) => command === 'plutil'), true);
  await install();

  const validatorPath = path.join(
    result.bundleRoot,
    'apps', 'ajun-runtime', 'scripts', 'manage-immutable-runtime-release.mjs',
  );
  await fs.chmod(validatorPath, 0o644);
  await assert.rejects(() => install(), /不是只读模式/);
  await fs.chmod(validatorPath, 0o444);

  const validatorParent = path.dirname(validatorPath);
  const displaced = path.join(root, 'displaced-validator.mjs');
  await fs.chmod(validatorParent, 0o755);
  await fs.rename(validatorPath, displaced);
  await fs.chmod(validatorParent, 0o555);
  await assert.rejects(() => install(), /文件清单不完整/);
  await fs.chmod(validatorParent, 0o755);
  await fs.rename(displaced, validatorPath);
  await fs.copyFile(validatorPath, displaced);
  await fs.unlink(validatorPath);
  await fs.symlink(displaced, validatorPath);
  await fs.chmod(validatorParent, 0o555);
  await assert.rejects(() => install(), /包含软链/);
});

test('Unix Socket 只开放固定状态和动作接口', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-release-server-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const releaseRoot = path.join(root, 'release', 'apps', 'ajun-runtime');
  await fs.mkdir(releaseRoot, { recursive:true });
  await fs.writeFile(path.join(root, 'release', 'release-manifest.json'), JSON.stringify({
    kind:'agent-army/ajun-immutable-runtime-release', releaseHash:'release-1', payloadHash:'payload-1', git:{ gitHead:'a'.repeat(40) },
  }));
  const plist = path.join(root, 'main.plist');
  await fs.writeFile(plist, 'fixture');
  const socketPath = path.join(root, 'state', 'helper.sock');
  const configPath = path.join(root, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({
    repositoryRoot:path.join(root, 'repo'), mainPlist:plist, stateDir:path.join(root, 'state'),
    deployRoot:path.join(root, 'deploy'), sourceParent:path.join(root, 'sources'), socketPath,
  }));
  const helper = await startReleaseHelper({ configPath });
  context.after(() => helper.close());
  assert.equal((await fs.stat(socketPath)).mode & 0o777, 0o600);
  assert.equal((await request(socketPath, 'GET', '/health')).status, 200);
  assert.equal((await request(socketPath, 'GET', '/status')).body.status.state, 'idle');
  assert.equal((await request(socketPath, 'POST', '/publish', {})).status, 400);
  assert.equal((await request(socketPath, 'POST', '/arbitrary', {})).status, 404);
});

function request(socketPath, method, route, body) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ socketPath, method, path:route, headers:encoded ? { 'content-type':'application/json', 'content-length':Buffer.byteLength(encoded) } : {} }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status:response.statusCode, body:JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.once('error', reject);
    req.end(encoded);
  });
}

async function makeTreeMutable(root) {
  const stat = await fs.lstat(root).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (!stat || stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await fs.chmod(root, 0o755);
    for (const name of await fs.readdir(root)) await makeTreeMutable(path.join(root, name));
  } else {
    await fs.chmod(root, 0o644);
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

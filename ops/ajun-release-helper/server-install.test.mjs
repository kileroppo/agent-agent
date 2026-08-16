import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildLaunchAgentPlist } from './install.mjs';
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

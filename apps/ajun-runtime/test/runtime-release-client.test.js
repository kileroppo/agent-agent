import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RuntimeReleaseClient, RuntimeReleaseClientError } from '../src/runtime-release-client.ts';

test('发布客户端只投影白名单状态字段', async (context) => {
  const fixture = await startSocketServer(context, (_request, response) => send(response, 200, {
    status:statusFixture({ secret:'must-not-pass', current:{ releaseHash:'release-1', gitHead:'a'.repeat(40), releaseRoot:'/private/path' } }),
  }));
  const status = await new RuntimeReleaseClient({ socketPath:fixture.socketPath }).status();
  assert.equal(status.current.releaseHash, 'release-1');
  assert.equal('releaseRoot' in status.current, false);
  assert.equal('secret' in status, false);
});

test('发布客户端保留助手的安全错误并把断线归为暂不可用', async (context) => {
  const fixture = await startSocketServer(context, (_request, response) => send(response, 400, { error:'请确认发布当前正式版本。' }));
  const client = new RuntimeReleaseClient({ socketPath:fixture.socketPath });
  await assert.rejects(() => client.action('publish', {}), (error) => error instanceof RuntimeReleaseClientError && error.httpStatus === 400);
  await assert.rejects(
    () => new RuntimeReleaseClient({ socketPath:path.join(fixture.root, 'missing.sock') }).status(),
    (error) => error.httpStatus === 503 && /尚未运行/.test(error.message),
  );
});

async function startSocketServer(context, handler) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-runtime-release-client-'));
  const socketPath = path.join(root, 'server.sock');
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  return { root, socketPath };
}

function statusFixture(extra = {}) {
  return {
    schemaVersion:'agent.army/self-service-release-status/v1', runId:null, action:null, state:'idle',
    message:'尚未检查新版。', startedAt:null, updatedAt:new Date().toISOString(), finishedAt:null,
    current:null, candidate:null, rollback:null, ...extra,
  };
}

function send(response, status, body) {
  response.writeHead(status, { 'content-type':'application/json' });
  response.end(JSON.stringify(body));
}

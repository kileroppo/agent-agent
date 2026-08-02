import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startRecoveryServer } from '../src/recovery-server.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

test('只读恢复入口只暴露固定GET，并拒绝全部写请求', async (context) => {
  const { server, status, port } = await startRecoveryServer({
    port:0,
    releaseHash:HASH_A,
    payloadHash:HASH_B,
    reason:'cutover_failed',
    now:() => new Date('2026-07-31T00:00:00.000Z'),
    pid:123,
    bootId:'boot-fixture',
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${port}`;

  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), status);
  assert.equal(status.mode, 'local_recovery_only');
  assert.equal(status.externalEffects, false);
  assert.equal(status.writableRoutes, false);

  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /只读恢复模式/);

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const response = await fetch(`${base}/api/overview`, {
      method,
      body:method === 'DELETE' ? undefined : '{"attempt":"write"}',
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('connection'), 'close');
    assert.equal((await response.json()).error, 'recovery_mode_read_only');
  }
  assert.equal((await fetch(`${base}/api/overview`)).status, 404);

  const raw = await sendIncompleteLargeWrite(port);
  assert.match(raw, /^HTTP\/1\.1 503 /);
  assert.match(raw, /\r\nConnection: close\r\n/i);
  assert.match(raw, /recovery_mode_read_only/);
});

test('恢复入口不导入业务执行器、文件系统、网络客户端或子进程', async () => {
  const sourcePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../src/recovery-server.js',
  );
  const source = await fs.readFile(sourcePath, 'utf8');
  assert.deepEqual(
    [...source.matchAll(/from ['"]([^'"]+)['"]/g)].map((match) => match[1]).sort(),
    ['node:crypto', 'node:http', 'node:url'],
  );
  assert.doesNotMatch(source, /from ['"]\.\/|from ['"]\.\.\//);
  assert.doesNotMatch(source, /node:(?:fs|child_process|net|tls|worker_threads)/);
  assert.doesNotMatch(source, /\bimport\s*\(/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /\brequest\.resume\s*\(/);
  assert.doesNotMatch(source, /\bsetInterval\s*\(/);
  assert.doesNotMatch(source, /\bsetTimeout\s*\(/);
});

test('恢复入口拒绝非loopback监听、非法端口和非哈希身份', async () => {
  const module = await import('../src/recovery-server.js');
  await assert.rejects(
    module.startRecoveryServer({
      port:0,
      releaseHash:'bad',
      payloadHash:HASH_B,
    }),
    /SHA-256/,
  );
  await assert.rejects(
    module.startRecoveryServer({
      host:'0.0.0.0',
      port:4321,
      releaseHash:HASH_A,
      payloadHash:HASH_B,
    }),
    /只允许监听127\.0\.0\.1/,
  );
  await assert.rejects(
    module.startRecoveryServer({
      host:'127.0.0.1',
      port:-1,
      releaseHash:HASH_A,
      payloadHash:HASH_B,
    }),
    /端口不合法/,
  );
});

function sendIncompleteLargeWrite(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host:'127.0.0.1', port });
    let response = '';
    socket.setEncoding('utf8');
    socket.setTimeout(1_000);
    socket.once('connect', () => {
      socket.write([
        'POST /api/overview HTTP/1.1',
        'Host: 127.0.0.1',
        'Content-Type: application/octet-stream',
        'Content-Length: 999999999',
        '',
        'partial-body-only',
      ].join('\r\n'));
    });
    socket.on('data', (chunk) => {
      response += chunk;
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('恢复入口未及时关闭未完成的大请求体连接'));
    });
    socket.once('error', reject);
    socket.once('close', () => resolve(response));
  });
}

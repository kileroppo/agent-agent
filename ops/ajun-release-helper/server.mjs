#!/usr/bin/env node

import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import { ReleaseCoordinator, ReleaseRequestError } from './release-coordinator.mjs';
import { AjunReleaseSystemAdapter } from './system-adapter.mjs';

export const RELEASE_HELPER_VERSION = '1.0.0';

export async function startReleaseHelper({ configPath } = {}) {
  if (!configPath) throw new Error('缺少 --config');
  const config = JSON.parse(await fs.readFile(path.resolve(configPath), 'utf8'));
  const adapter = new AjunReleaseSystemAdapter(config);
  const coordinator = new ReleaseCoordinator({ stateDir:config.stateDir, adapter });
  await coordinator.initialize();
  await prepareSocket(config.socketPath);
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/health') return sendJson(response, 200, { ok:true, version:RELEASE_HELPER_VERSION });
      if (request.method === 'GET' && request.url === '/status') return sendJson(response, 200, { status:coordinator.status() });
      const action = request.method === 'POST' ? request.url?.match(/^\/(check|publish|rollback)$/)?.[1] : null;
      if (action) return sendJson(response, 202, await coordinator.start(action, await readJsonBody(request)));
      return sendJson(response, 404, { error:'未找到这个发布助手入口。' });
    } catch (error) {
      const status = error instanceof ReleaseRequestError ? error.httpStatus : 500;
      return sendJson(response, status, { error:status === 500 ? '发布助手暂时不可用。' : error.message });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.socketPath, resolve);
  });
  await fs.chmod(config.socketPath, 0o600);
  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.unlink(config.socketPath).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
  };
  process.once('SIGTERM', () => { void close().finally(() => process.exit(0)); });
  process.once('SIGINT', () => { void close().finally(() => process.exit(0)); });
  return { server, coordinator, socketPath:config.socketPath, close };
}

async function prepareSocket(socketPath) {
  const target = path.resolve(socketPath);
  await fs.mkdir(path.dirname(target), { recursive:true, mode:0o700 });
  try {
    const stat = await fs.lstat(target);
    if (!stat.isSocket()) throw new Error('发布助手 Socket 路径被其他文件占用。');
    await fs.unlink(target);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32 * 1024) throw new ReleaseRequestError(413, '请求体过大。');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ReleaseRequestError(400, '请求体不是有效 JSON。');
  }
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'content-type':'application/json; charset=utf-8', 'content-length':Buffer.byteLength(body), 'cache-control':'no-store' });
  response.end(body);
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const index = process.argv.indexOf('--config');
  await startReleaseHelper({ configPath:index >= 0 ? process.argv[index + 1] : '' });
}

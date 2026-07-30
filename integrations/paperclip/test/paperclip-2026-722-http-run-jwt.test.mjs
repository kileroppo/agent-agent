import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  applyCompatibilityPatch,
  patchHttpIndexSource,
  resolveCompatibilityTargets,
  rollbackCompatibilityPatch,
} from '../compat/paperclip-2026-722-http-run-jwt.mjs';
import { main as applyMain } from '../scripts/apply-paperclip-2026-722-http-run-jwt.mjs';
import { main as rollbackMain } from '../scripts/rollback-paperclip-2026-722-http-run-jwt.mjs';

const HTTP_INDEX_ORIGINAL = `import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
export const httpAdapter = {
    type: "http",
    execute,
    testEnvironment,
    models: [],
    agentConfigurationDoc: \`# http agent configuration

Adapter: http

Core fields:
- url (string, required): endpoint to invoke
- method (string, optional): HTTP method, default POST
- headers (object, optional): request headers
- payloadTemplate (object, optional): JSON payload template
- timeoutSec (number, optional): request timeout in seconds
\`,
};
//# sourceMappingURL=index.js.map`;

test('forwardRunJwt 只向 loopback 注入 heartbeat JWT，且配置 headers 不能覆盖', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paperclip-http-jwt-behavior-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const httpDir = path.join(root, 'dist', 'adapters', 'http');
  await fs.mkdir(httpDir, { recursive:true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ type:'module' }));
  await fs.writeFile(path.join(root, 'dist', 'adapters', 'utils.js'), `
export const asString = (value, fallback) => typeof value === 'string' ? value : fallback;
export const asNumber = (value, fallback) => typeof value === 'number' ? value : fallback;
export const parseObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
`);
  await fs.writeFile(path.join(httpDir, 'index.js'), patchHttpIndexSource(HTTP_INDEX_ORIGINAL));
  await fs.writeFile(path.join(httpDir, 'test.js'), 'export async function testEnvironment() { return {}; }\n');
  const { httpAdapter } = await import(`${pathToFileURL(path.join(httpDir, 'index.js')).href}?${Date.now()}`);
  const { execute } = httpAdapter;
  assert.equal(httpAdapter.supportsLocalAgentJwt, true);

  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init:structuredClone(init) });
    return { ok:true };
  };
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  await execute({
    config:{
      url:'http://127.0.0.1:8787/publish',
      forwardRunJwt:true,
      headers:{ Authorization:'Bearer configured-token', 'x-test':'ok' },
    },
    runId:'run-1',
    agent:{ id:'agent-1' },
    context:{ taskId:'issue-1' },
    authToken:'heartbeat-jwt',
  });
  assert.equal(requests[0].init.headers.authorization, 'Bearer heartbeat-jwt');
  assert.equal(requests[0].init.headers.Authorization, undefined);
  assert.equal(requests[0].init.headers['x-test'], 'ok');
  assert.equal(requests[0].init.body.includes('heartbeat-jwt'), false);
  assert.equal(requests[0].init.redirect, 'manual');

  await execute({
    config:{ url:'http://[::1]:8787/publish', forwardRunJwt:true },
    runId:'run-ipv6',
    agent:{ id:'agent-ipv6' },
    context:{ taskId:'issue-ipv6' },
    authToken:'ipv6-jwt',
  });
  assert.equal(requests[1].init.headers.authorization, 'Bearer ipv6-jwt');
  assert.equal(requests[1].init.redirect, 'manual');

  await execute({
    config:{
      url:'https://example.com/hook',
      headers:{ Authorization:'Bearer configured-token' },
    },
    runId:'run-2',
    agent:{ id:'agent-2' },
    context:{ taskId:'issue-2' },
    authToken:'unused-jwt',
  });
  assert.equal(requests[2].init.headers.Authorization, 'Bearer configured-token');
  assert.equal(requests[2].init.headers.authorization, undefined);
  assert.equal(requests[2].init.redirect, undefined);
});

test('forwardRunJwt 对非 loopback、缺 JWT 和伪 loopback 均在 fetch 前失败关闭', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paperclip-http-jwt-deny-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const indexFile = await materializePatchedHttpAdapter(root);
  const { httpAdapter } = await import(`${pathToFileURL(indexFile).href}?${Date.now()}`);
  const { execute } = httpAdapter;
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return { ok:true };
  };
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  for (const [url, authToken, pattern] of [
    ['https://example.com/hook', 'jwt', /loopback/],
    ['http://localhost.evil.invalid/hook', 'jwt', /loopback/],
    ['http://127.0.0.1.evil.invalid/hook', 'jwt', /loopback/],
    ['http://localhost:8787/hook', '', /run JWT/],
  ]) {
    await assert.rejects(execute({
      config:{ url, forwardRunJwt:true },
      runId:'run-1',
      agent:{ id:'agent-1' },
      context:{ taskId:'issue-1' },
      authToken,
    }), pattern);
  }
  assert.equal(fetchCount, 0);
});

test('forwardRunJwt 禁止自动跟随 3xx，Bearer 不会被带出首个 loopback 请求', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paperclip-http-jwt-redirect-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const indexFile = await materializePatchedHttpAdapter(root);
  const { httpAdapter } = await import(`${pathToFileURL(indexFile).href}?${Date.now()}`);
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init:structuredClone(init) });
    return {
      ok:false,
      status:302,
      headers:new Headers({ location:'https://outside.example/collect' }),
    };
  };
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(httpAdapter.execute({
    config:{ url:'http://localhost:8787/publish', forwardRunJwt:true },
    runId:'run-1',
    agent:{ id:'agent-1' },
    context:{ taskId:'issue-1' },
    authToken:'heartbeat-jwt',
  }), /status 302/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://localhost:8787/publish');
  assert.equal(requests[0].init.redirect, 'manual');
  assert.equal(requests[0].init.headers.authorization, 'Bearer heartbeat-jwt');
});

test('版本锁定单文件补丁可幂等应用并从可信备份原子回滚', async (context) => {
  const fixture = await materializePaperclipFixture(context);
  const options = { paperclipEntry:fixture.paperclipEntry };
  const targets = await resolveCompatibilityTargets(options);
  assert.equal(targets.indexFile, await fs.realpath(fixture.indexFile));

  assert.deepEqual(pick(await applyCompatibilityPatch(options)), {
    changed:true,
    status:'applied',
  });
  assert.match(await fs.readFile(fixture.indexFile, 'utf8'), /redirect: "manual"/);
  assert.match(await fs.readFile(fixture.indexFile, 'utf8'), /supportsLocalAgentJwt: true/);
  assert.deepEqual(pick(await applyCompatibilityPatch(options)), {
    changed:false,
    status:'already_applied',
  });
  assert.deepEqual(pick(await rollbackCompatibilityPatch(options)), {
    changed:true,
    status:'rolled_back',
  });
  assert.equal(await fs.readFile(fixture.indexFile, 'utf8'), HTTP_INDEX_ORIGINAL);
  assert.deepEqual(pick(await rollbackCompatibilityPatch(options)), {
    changed:false,
    status:'already_rolled_back',
  });
});

test('未知源码和未知 Paperclip 版本失败关闭，CLI 必须显式确认', async (context) => {
  assert.throws(() => patchHttpIndexSource('unknown'), /SHA或补丁锚点/);
  const fixture = await materializePaperclipFixture(context, { version:'2099.1.0' });
  await assert.rejects(
    resolveCompatibilityTargets({ paperclipEntry:fixture.paperclipEntry }),
    /只允许 Paperclip 2026\.722\.0/,
  );
  await assert.rejects(applyMain([]), /显式确认/);
  await assert.rejects(rollbackMain([]), /显式确认/);
});

async function materializePatchedHttpAdapter(root) {
  const httpDir = path.join(root, 'dist', 'adapters', 'http');
  await fs.mkdir(httpDir, { recursive:true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ type:'module' }));
  await fs.writeFile(path.join(root, 'dist', 'adapters', 'utils.js'), `
export const asString = (value, fallback) => typeof value === 'string' ? value : fallback;
export const asNumber = (value, fallback) => typeof value === 'number' ? value : fallback;
export const parseObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
`);
  await fs.writeFile(path.join(httpDir, 'test.js'), 'export async function testEnvironment() { return {}; }\n');
  const indexFile = path.join(httpDir, 'index.js');
  await fs.writeFile(indexFile, patchHttpIndexSource(HTTP_INDEX_ORIGINAL));
  return indexFile;
}

async function materializePaperclipFixture(context, { version = '2026.722.0' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paperclip-http-jwt-fixture-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const paperclipRoot = path.join(root, 'node_modules', 'paperclipai');
  const serverRoot = path.join(root, 'node_modules', '@paperclipai', 'server');
  const paperclipEntry = path.join(paperclipRoot, 'dist', 'index.js');
  const indexFile = path.join(serverRoot, 'dist', 'adapters', 'http', 'index.js');
  await fs.mkdir(path.dirname(paperclipEntry), { recursive:true });
  await fs.mkdir(path.dirname(indexFile), { recursive:true });
  await fs.writeFile(path.join(paperclipRoot, 'package.json'), JSON.stringify({
    name:'paperclipai',
    version,
  }));
  await fs.writeFile(path.join(serverRoot, 'package.json'), JSON.stringify({
    name:'@paperclipai/server',
    version,
  }));
  await fs.writeFile(paperclipEntry, '');
  await fs.writeFile(indexFile, HTTP_INDEX_ORIGINAL);
  return { paperclipEntry, indexFile };
}

function pick(value) {
  return { changed:value.changed, status:value.status };
}

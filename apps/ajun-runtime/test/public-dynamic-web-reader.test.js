import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  PublicDynamicWebReader,
  runControlledChrome,
} from '../src/public-dynamic-web-reader.ts';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('动态公开页只给固定 Chrome 参数、临时 Profile 和单一受控 URL', async () => {
  const calls = [];
  const reader = new PublicDynamicWebReader({
    lookupImpl:async () => [{ address:'203.0.113.10', family:4 }],
    runImpl:async (command, args, options) => {
      calls.push({ command, args, options });
      return '<html><head><title>动态结果</title></head><body><main>脚本渲染后的正文</main></body></html>';
    },
  });
  const output = await reader.read({ sourceUrl:'https://example.com/app' });
  assert.equal(output.title, '动态结果');
  assert.match(output.text, /脚本渲染后的正文/);
  assert.equal(output.validation.javascriptRendered, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].command, /Google Chrome$/);
  assert.equal(calls[0].args.at(-1), 'about:blank');
  assert.equal(calls[0].options.sourceUrl, 'https://example.com/app');
  assert.equal(calls[0].args.some((arg) => arg.startsWith('--proxy-server=http://127.0.0.1:')), true);
  assert.equal(calls[0].args.some((arg) => arg.startsWith('--user-data-dir=')), true);
});

test('动态公开页在启动 Chrome 前拒绝本机和内网 URL', async () => {
  let runs = 0;
  const reader = new PublicDynamicWebReader({
    runImpl:async () => { runs += 1; return ''; },
  });
  await assert.rejects(() => reader.read({ sourceUrl:'http://localhost:4321/private' }), {
    code:'source_not_public',
  });
  assert.equal(runs, 0);
});

test('Chrome CDP 门禁在发出网络请求前拦截 POST 和跨源 GET', {
  skip:!existsSync(CHROME),
}, async () => {
  let postCount = 0;
  let crossOriginCount = 0;
  const otherOrigin = await listen((request, response) => {
    crossOriginCount += 1;
    response.end('outside');
  });
  const origin = await listen((request, response) => {
    if (request.method === 'POST') postCount += 1;
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(`<body>safe<script>
      fetch('/write', { method:'POST', body:'no' }).catch(() => {});
      fetch('http://127.0.0.1:${otherOrigin.port}/outside').catch(() => {});
    </script></body>`);
  });
  const profileDirectory = await mkdtemp(path.join(os.tmpdir(), 'agent-army-cdp-test-'));
  try {
    const html = await runControlledChrome(CHROME, [
      '--headless=new',
      '--disable-background-networking',
      '--no-first-run',
      `--user-data-dir=${profileDirectory}`,
      'about:blank',
    ], {
      timeoutMs:10_000,
      maxBuffer:1024 * 1024,
      sourceUrl:`http://127.0.0.1:${origin.port}/`,
    });
    assert.match(html, /safe/);
    assert.equal(postCount, 0);
    assert.equal(crossOriginCount, 0);
  } finally {
    await origin.close();
    await otherOrigin.close();
    await rm(profileDirectory, { recursive:true, force:true });
  }
});

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port:server.address().port,
    close:() => new Promise((resolve) => server.close(resolve)),
  };
}

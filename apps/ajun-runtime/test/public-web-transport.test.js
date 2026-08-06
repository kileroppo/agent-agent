import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicWebTransport, runBoundedCommand } from '../src/public-web-transport.js';

test('公开网页传输只发起一次受限的公开读取，并保留响应状态和正文', async () => {
  let received;
  const transport = new PublicWebTransport({
    lookupImpl:async () => [{ address:'93.184.216.34' }],
    run: async (command, args) => {
      received = { command, args };
      return Buffer.from('HTTP/2 200 OK\r\ncontent-type: text/html\r\n\r\n<html>公开内容</html>');
    }
  });
  const response = await transport.fetch('https://example.com/article', { headers:{ accept:'text/html' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/html');
  assert.match(await response.text(), /公开内容/);
  assert.equal(received.command, '/usr/bin/curl');
  assert.ok(received.args.includes('--max-redirs'));
  assert.ok(received.args.includes('0'));
  assert.ok(received.args.includes('=http,https'));
  assert.ok(received.args.includes('--user-agent'));
  assert.equal(received.args.at(-1), 'https://example.com/article');
});

test('公开网页传输允许公开 GitHub 调用提供固定 User-Agent', async () => {
  let received;
  const transport = new PublicWebTransport({ lookupImpl:async () => [{ address:'140.82.112.5' }], run:async (_command, args) => { received = args; return Buffer.from('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{}'); } });
  await transport.fetch('https://api.github.com/search/repositories?q=agent', { headers:{ Accept:'application/vnd.github+json', 'User-Agent':'agent-army-intel-researcher' } });
  assert.equal(received[received.indexOf('--user-agent') + 1], 'agent-army-intel-researcher');
});

test('公开网页传输把已校验DNS地址固定给curl，避免请求时重新解析到内网', async () => {
  let received;
  const transport = new PublicWebTransport({
    lookupImpl:async () => [{ address:'93.184.216.34' }],
    run:async (_command, args) => {
      received = args;
      return Buffer.from('HTTP/1.1 200 OK\r\ncontent-type: text/html\r\n\r\nok');
    },
  });
  await transport.fetch('https://example.com/article', { resolvedAddress:'93.184.216.34' });
  const resolveIndex = received.indexOf('--resolve');
  assert.notEqual(resolveIndex, -1);
  assert.equal(received[resolveIndex + 1], 'example.com:443:93.184.216.34');
  assert.equal(received.at(-1), 'https://example.com/article');
});

test('公开网页传输无法取得有效响应时不伪造内容', async () => {
  const transport = new PublicWebTransport({ lookupImpl:async () => [{ address:'93.184.216.34' }], run: async () => Buffer.from('not an http response') });
  await assert.rejects(() => transport.fetch('https://example.com/article'), /响应格式无效/);
});

test('公开网页传输本身拒绝DNS内网、mapped IPv6和含凭据URL', async () => {
  const internal = new PublicWebTransport({
    lookupImpl:async () => [{ address:'10.0.0.8' }],
    run:async () => { throw new Error('不应执行'); },
  });
  await assert.rejects(() => internal.fetch('https://internal.example/path'), /内网/);
  await assert.rejects(() => internal.fetch('http://[::ffff:a00:1]/path'), /内网/);
  await assert.rejects(() => internal.fetch('https://user:pass@example.com/path'), /含凭据/);
});

test('调用级 maxBytes 同时约束 curl 与流式 stdout 累计', async () => {
  let received;
  const transport = new PublicWebTransport({
    lookupImpl:async () => [{ address:'93.184.216.34' }],
    run:async (_command, args, options) => {
      received = { args, options };
      return Buffer.from('HTTP/1.1 200 OK\r\ncontent-type: application/octet-stream\r\n\r\nok');
    },
  });
  await transport.fetch('https://example.com/file', { maxBytes:2 * 1024 * 1024 });
  assert.equal(received.args[received.args.indexOf('--max-filesize') + 1], String(2 * 1024 * 1024));
  assert.equal(received.options.maxBuffer, 2 * 1024 * 1024 + 64 * 1024);

  await assert.rejects(
    () => runBoundedCommand(process.execPath, [
      '-e',
      'process.stdout.write(Buffer.alloc(2 * 1024 * 1024))',
    ], { maxBuffer:1024 * 1024 }),
    /超过传输上限/,
  );
});

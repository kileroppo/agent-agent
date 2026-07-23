import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicWebTransport } from '../src/public-web-transport.js';

test('公开网页传输只发起一次受限的公开读取，并保留响应状态和正文', async () => {
  let received;
  const transport = new PublicWebTransport({
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
  const transport = new PublicWebTransport({ run:async (_command, args) => { received = args; return Buffer.from('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{}'); } });
  await transport.fetch('https://api.github.com/search/repositories?q=agent', { headers:{ Accept:'application/vnd.github+json', 'User-Agent':'agent-army-github-scout' } });
  assert.equal(received[received.indexOf('--user-agent') + 1], 'agent-army-github-scout');
});

test('公开网页传输无法取得有效响应时不伪造内容', async () => {
  const transport = new PublicWebTransport({ run: async () => Buffer.from('not an http response') });
  await assert.rejects(() => transport.fetch('https://example.com/article'), /响应格式无效/);
});

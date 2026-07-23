import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicWebFetch, PublicWebFetchError, htmlToText } from '../src/public-web-fetch.js';

function response(body, type = 'text/html; charset=utf-8') { return new Response(body, { status: 200, headers: { 'content-type': type } }); }

test('HTML extraction preserves readable block boundaries instead of flattening the entire page', () => {
  assert.equal(htmlToText('<main><h1>标题</h1><p>第一段。</p><p>第二段。</p><ul><li>要点</li></ul></main>'), '标题\n第一段。\n第二段。\n- 要点');
});

test('公开网页能力只返回脱敏公开正文，不返回查询参数', async () => {
  const fetcher = new PublicWebFetch({ fetchImpl: async () => response('<html><title>示例</title><body><script>secret()</script><h1>公开正文</h1></body></html>'), lookupImpl: async () => [{ address:'93.184.216.34' }] });
  const result = await fetcher.acquire({ sourceUrl: 'https://example.com/article?private=ignored' });
  assert.equal(result.title, '示例'); assert.match(result.text, /公开正文/); assert.doesNotMatch(result.text, /secret/); assert.equal(result.sourceRef, 'https://example.com/article');
});

test('公开网页能力拒绝内网、本机和非网页内容', async () => {
  const fetcher = new PublicWebFetch({ fetchImpl: async () => response('binary', 'application/pdf'), lookupImpl: async () => [{ address:'93.184.216.34' }] });
  await assert.rejects(() => fetcher.acquire({ sourceUrl: 'http://127.0.0.1:4321/private' }), PublicWebFetchError);
  await assert.rejects(() => fetcher.acquire({ sourceUrl: 'https://example.com/file.pdf' }), /HTML/);
});

test('公开网页能力拒绝域名解析到内网和 IPv6 回环', async () => {
  const fetcher = new PublicWebFetch({ fetchImpl: async () => response('unused'), lookupImpl: async () => [{ address:'10.0.0.8' }] });
  await assert.rejects(() => fetcher.acquire({ sourceUrl: 'https://internal.example/path' }), /内网/);
  await assert.rejects(() => fetcher.acquire({ sourceUrl: 'http://[::1]/private' }), /内网/);
});

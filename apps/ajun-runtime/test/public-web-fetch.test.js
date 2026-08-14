import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicWebFetch, PublicWebFetchError, htmlToText } from '../src/public-web-fetch.ts';

function response(body, type = 'text/html; charset=utf-8') { return new Response(body, { status: 200, headers: { 'content-type': type } }); }

test('HTML extraction preserves readable block boundaries instead of flattening the entire page', () => {
  assert.equal(htmlToText('<main><h1>标题</h1><p>第一段。</p><p>第二段。</p><ul><li>要点</li></ul></main>'), '标题\n第一段。\n第二段。\n- 要点');
});

test('HTML extraction prioritizes main content and a requested fragment over long navigation', () => {
  const navigation = `<nav>${'<a>导航项目</a>'.repeat(4_000)}</nav>`;
  const html = `<html><head><title>文档标题</title></head><body>${navigation}<div role=main id=apicontent>
    <section><h2>简介</h2><p>正文开头。</p></section>
    <section><h3>Environment variables<span><a class=mark id=environment-variables></a></span></h3>
      <p>目标正文说明环境变量只影响当前进程。</p></section>
  </div><footer>页脚噪音</footer></body></html>`;
  const mainText = htmlToText(html);
  assert.match(mainText, /^简介\n正文开头。/);
  assert.doesNotMatch(mainText, /导航项目|文档标题|页脚噪音/);
  const focusedText = htmlToText(html, { fragment:'environment-variables' });
  assert.match(focusedText, /^Environment variables\n目标正文说明环境变量只影响当前进程。/);
  assert.doesNotMatch(focusedText, /正文开头|导航项目/);
});

test('公开网页能力只返回脱敏公开正文，不返回查询参数', async () => {
  let requestOptions;
  const fetcher = new PublicWebFetch({ fetchImpl: async (_url, options) => {
    requestOptions = options;
    return response('<html><title>示例</title><body><script>secret()</script><h1>公开正文</h1></body></html>');
  }, lookupImpl: async () => [{ address:'93.184.216.34' }] });
  const result = await fetcher.acquire({ sourceUrl: 'https://example.com/article?private=ignored' });
  assert.equal(result.title, '示例'); assert.match(result.text, /公开正文/); assert.doesNotMatch(result.text, /secret/); assert.equal(result.sourceRef, 'https://example.com/article');
  assert.match(result.contentHash, /^[0-9a-f]{64}$/);
  assert.equal(requestOptions.resolvedAddress, '93.184.216.34');
});

test('公开网页能力把 URL 锚点用于正文聚焦', async () => {
  const fetcher = new PublicWebFetch({
    fetchImpl:async () => response(`<nav>${'<a>目录噪音</a>'.repeat(4_000)}</nav><main>
      <section><h2>前置章节</h2><p>不相关内容。</p></section>
      <section><h2>目标章节<a id=target-section></a></h2><p>锚点对应正文。</p></section>
    </main>`),
    lookupImpl:async () => [{ address:'93.184.216.34' }],
  });
  const result = await fetcher.acquire({ sourceUrl:'https://example.com/docs#target-section' });
  assert.match(result.text, /^目标章节\n锚点对应正文。/);
  assert.doesNotMatch(result.text, /目录噪音|不相关内容/);
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
  await assert.rejects(() => fetcher.acquire({ sourceUrl: 'http://[::ffff:a00:1]/private' }), /内网/);
});

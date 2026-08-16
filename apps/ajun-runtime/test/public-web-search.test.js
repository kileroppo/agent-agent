import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicWebSearch, PublicWebSearchError } from '../src/public-web-search.ts';

test('公开搜索只返回有限的公开 HTTP 链接和标题', async () => {
  const search = new PublicWebSearch({ fetchImpl:async () => new Response('<a class="result__a" href="https://example.com/a">资料 A</a><a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.org%2Fb">资料 B</a>', { status:200 }) });
  const result = await search.search({ query:'Agent 军团', limit:2 });
  assert.equal(result.query, 'Agent 军团');
  assert.deepEqual(result.results, [{ url:'https://example.com/a', title:'资料 A' }, { url:'https://example.org/b', title:'资料 B' }]);
});

test('搜索站的导航链接不会被错当成公开资料；首个来源没有结果时会换备用来源', async () => {
  const calls = [];
  const search = new PublicWebSearch({ fetchImpl:async (url) => {
    calls.push(url);
    if (url.startsWith('https://html.duckduckgo.com')) return new Response('<a href="https://html.duckduckgo.com/html/">搜索首页</a>', { status:202 });
    return new Response('<li class="b_algo"><h2><a href="https://example.com/official">官方资料</a></h2></li>', { status:200 });
  } });
  const result = await search.search({ query:'公开资料', limit:1 });
  assert.equal(result.provider, 'bing');
  assert.deepEqual(result.results, [{ url:'https://example.com/official', title:'官方资料' }]);
  assert.equal(calls.length, 2);
});

test('Bing ck 跳转链接会还原真实公开来源，不把跳转占位页当正文', async () => {
  const target = 'https://www.weather.com.cn/weather/101210904.shtml';
  const encoded = `a1${Buffer.from(target).toString('base64url')}`;
  const search = new PublicWebSearch({ fetchImpl:async (url) => {
    if (url.startsWith('https://html.duckduckgo.com')) return new Response('', { status:202 });
    return new Response(`<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=${encoded}">义乌天气</a></h2></li>`, { status:200 });
  } });
  const result = await search.search({ query:'义乌天气', limit:1 });
  assert.deepEqual(result.results, [{ url:target, title:'义乌天气' }]);
});

test('中文天气查询优先使用 360 的真实目标链接，避免区域错误的搜索结果', async () => {
  const calls = [];
  const search = new PublicWebSearch({ fetchImpl:async (url) => {
    calls.push(url);
    return new Response(`<a href="https://www.so.com/link?m=opaque" data-mdurl="https://www.weather.com.cn/weather/101210101.shtml" data-res='{"pos":1}'>杭州7天天气预报</a>`, { status:200 });
  } });
  const result = await search.search({ query:'杭州 天气 中国天气网', limit:1 });
  assert.equal(result.provider, 'so');
  assert.deepEqual(result.results, [{
    url:'https://www.weather.com.cn/weather/101210101.shtml',
    title:'杭州7天天气预报',
  }]);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^https:\/\/www\.so\.com\/s\?q=/);
});

test('公开搜索失败或没有结果时不返回编造链接', async () => {
  const unavailable = new PublicWebSearch({ fetchImpl:async () => { throw new Error('offline'); } });
  await assert.rejects(() => unavailable.search({ query:'测试' }), PublicWebSearchError);
  const empty = new PublicWebSearch({ fetchImpl:async () => new Response('<html>none</html>', { status:200 }) });
  await assert.rejects(() => empty.search({ query:'测试' }), /没有得到/);
});

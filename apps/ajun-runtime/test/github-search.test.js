import assert from 'node:assert/strict';
import test from 'node:test';
import { GithubSearch } from '../src/github-search.js';

test('GitHub 公开检索解析仓库元数据，不携带认证头', async () => {
  let request;
  const search = new GithubSearch({ now:() => new Date('2026-07-23T00:00:00.000Z'), fetchImpl:async (url, options) => {
    request = { url, options };
    return Response.json({ items:[{ full_name:'openai/example', description:'公开示例', stargazers_count:1234, language:'JavaScript', updated_at:'2026-07-22T00:00:00.000Z', html_url:'https://github.com/openai/example', topics:['agent'] }] });
  } });
  const result = await search.search({ query:'agent runtime', limit:3 });
  assert.match(request.url, /q=agent\+runtime/);
  assert.equal(request.options.headers.Accept, 'application/vnd.github+json');
  assert.equal(request.options.headers['User-Agent'], 'agent-army-intel-researcher');
  assert.equal(request.options.headers.Authorization, undefined);
  assert.equal(result.results[0].fullName, 'openai/example');
  assert.equal(result.results[0].stars, 1234);
  assert.deepEqual(result.results[0].topics, ['agent']);
});

test('GitHub 公开文件读取解码 README 内容', async () => {
  const search = new GithubSearch({ now:() => new Date('2026-07-23T00:00:00.000Z'), fetchImpl:async () => Response.json({ encoding:'base64', content:Buffer.from('# Hello\n公开内容').toString('base64') }) });
  const result = await search.readRepo({ repo:'openai/example' });
  assert.equal(result.repo, 'openai/example');
  assert.equal(result.path, 'README');
  assert.match(result.text, /公开内容/);
  assert.equal(result.truncated, false);
});

test('GitHub 公开接口限流时返回可识别错误', async () => {
  const search = new GithubSearch({ fetchImpl:async () => new Response('', { status:403, headers:{ 'X-RateLimit-Remaining':'0' } }) });
  await assert.rejects(() => search.search({ query:'agent' }), (error) => error.code === 'github_rate_limited');
});

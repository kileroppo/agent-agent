import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalGithubResearch } from '../src/local-github-research.js';

const now = () => new Date('2026-07-23T00:00:00.000Z');

test('小R 搜索公开项目并产出可核验中文评估', async () => {
  let requestedLimit = null;
  const worker = new LocalGithubResearch({ now, githubSearch:{ async search({ limit }) { requestedLimit = limit; return { query:'agent runtime', searchedAt:now().toISOString(), results:[{ fullName:'openai/example', description:'A lightweight multi-agent framework', stars:1200, language:'JavaScript', updatedAt:'2026-07-22T00:00:00.000Z', url:'https://github.com/openai/example', topics:['agent'] }] }; } } });
  const result = await worker.execute({ taskId:'github-search-1', assigneeAgentId:'intel-researcher', input:{ query:'agent runtime', title:'返回前 3 个项目' } });
  assert.equal(result.status, 'succeeded');
  assert.equal(requestedLimit, 3);
  assert.equal(result.artifactRefs[0].type, 'research_github_report');
  assert.match(result.artifactRefs[0].data.results[0].assessment, /JavaScript/);
  assert.match(result.artifactRefs[0].data.results[0].suitability, /轻量 Agent 交接/);
  assert.deepEqual(result.usage.tools, [{ id:'github-public-search', name:'公开 GitHub 项目检索', calls:1 }]);
  assert.equal(result.artifactRefs[0].validation.publicReadOnly, true);
});

test('小R 读取公开仓库文件并只依据该文件生成摘要', async () => {
  const worker = new LocalGithubResearch({ now, githubSearch:{ async readRepo() { return { repo:'openai/example', path:'README', text:'# Example\n它使用公开接口实现功能。', truncated:false, fetchedAt:now().toISOString() }; } } });
  const result = await worker.execute({ taskId:'github-read-1', assigneeAgentId:'intel-researcher', input:{ repo:'openai/example' } });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.artifactRefs[0].type, 'github_code_read');
  assert.match(result.artifactRefs[0].data.summary, /公开接口/);
  assert.match(result.artifactRefs[0].data.basis, /本次读取/);
});

test('小R GitHub 检索限流时转为 needs_input，不编造结果', async () => {
  const worker = new LocalGithubResearch({ now, githubSearch:{ async search() { const error = new Error('限流'); error.code = 'github_rate_limited'; throw error; } } });
  const result = await worker.execute({ taskId:'github-limit-1', input:{ query:'agent' } });
  assert.equal(result.status, 'needs_input');
  assert.equal(result.error.code, 'github_rate_limited');
  assert.match(result.error.userMessage, /稍后重试/);
});

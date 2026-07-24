import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalPublicReport } from '../src/local-public-report.js';

test('单个公开网页在 AI 未配置时如实标注为机械摘要', async () => {
  const worker = new LocalPublicReport({ publicWebFetch:{ async acquire() { return { sourceRef:'https://example.com/readme', title:'示例页面', text:'第一句说明。第二句说明！第三句说明？第四句不会进入摘要。', fetchedAt:'2026-07-22T00:00:00.000Z', truncated:false }; } } });
  const result = await worker.execute({ taskId:'task-1', assigneeAgentId:'public-reporter', input:{ sourceUrl:'https://example.com/readme' } });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.currentStage, 'public_report_ready');
  assert.equal(result.artifactRefs[0].data.title, '示例页面');
  assert.match(result.artifactRefs[0].data.summary, /仅机械摘要，未做中文提炼/);
  assert.equal(result.artifactRefs[0].data.refinement.aiAssisted, false);
  assert.equal(result.artifactRefs[0].data.refinement.status, 'mechanical_summary');
  assert.equal(result.artifactRefs[0].validation.publicReadOnly, true);
  assert.deepEqual(result.usage.tools, [{ id:'public-web-fetch', name:'公开网页读取', calls:1 }]);
});

test('单个公开网页会通过 AI 提炼交付中文重点，而不是原文切片', async () => {
  const refineAdvisor = { async refine({ source }) { assert.equal(source.title, 'Example Domain'); return { keyPoints:['这是用于文档示例的保留域名', '页面提示不要把它用于实际运营'], recommendation:'仅把它用作示例链接。', basis:'仅根据已读取的公开网页内容' }; } };
  const worker = new LocalPublicReport({
    publicWebFetch:{ async acquire() { return { sourceRef:'https://example.com', title:'Example Domain', text:'Example Domain. This domain is for use in documentation examples without needing permission. Avoid use in operations.', fetchedAt:'2026-07-22T00:00:00.000Z', truncated:false }; } },
    refineAdvisor
  });
  const report = (await worker.execute({ taskId:'task-refined', assigneeAgentId:'public-reporter', input:{ sourceUrl:'https://example.com' } })).artifactRefs[0].data;
  assert.equal(report.refinement.aiAssisted, true);
  assert.equal(report.refinement.status, 'refined');
  assert.match(report.summary, /中文重点：这是用于文档示例的保留域名/);
  assert.doesNotMatch(report.summary, /This domain is for use/);
});

test('缺少网页链接时不猜测内容，明确等待用户补充', async () => {
  const worker = new LocalPublicReport({ publicWebFetch:{ async acquire() { throw new Error('must not fetch'); } } });
  const result = await worker.execute({ taskId:'task-1', assigneeAgentId:'public-reporter', input:{} });
  assert.equal(result.status, 'needs_input');
  assert.equal(result.currentStage, 'public_page_required');
});

test('公开资料员工可根据明确目标自己搜索公开网页，再逐篇读取交付', async () => {
  const searched = [];
  const requested = [];
  const worker = new LocalPublicReport({
    publicWebSearch:{ async search(input) { searched.push(input); return { query:input.query, searchedAt:'2026-07-22T00:00:00.000Z', results:[{ url:'https://example.com/a', title:'资料A' }, { url:'https://example.com/b', title:'资料B' }] }; } },
    publicWebFetch:{ async acquire({ sourceUrl }) { requested.push(sourceUrl); return { sourceRef:sourceUrl, title:sourceUrl.endsWith('/a') ? '资料A' : '资料B', text:'公开正文第一句。公开正文第二句。', fetchedAt:'2026-07-22T00:00:00.000Z', truncated:false }; } }
  });
  const result = await worker.execute({ taskId:'task-search', assigneeAgentId:'public-reporter', input:{ title:'查找 Agent 军团公开资料' } });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(searched, [{ query:'Agent 军团', limit:3 }]);
  assert.deepEqual(requested, ['https://example.com/a', 'https://example.com/b']);
  assert.equal(result.execution.mode, 'public_search_and_read');
  assert.deepEqual(result.usage.tools, [{ id:'public-web-search', name:'公开网页搜索', calls:1 }, { id:'public-web-fetch', name:'公开网页读取', calls:2 }]);
  assert.equal(result.artifactRefs[0].data.search.query, 'Agent 军团');
});

test('中文 Agent 权限治理请求会转成可检索的公开资料主题', async () => {
  let query = '';
  const worker = new LocalPublicReport({
    publicWebSearch:{ async search(input) { query = input.query; return { query, searchedAt:'2026-07-23T00:00:00.000Z', results:[{ url:'https://example.com/governance', title:'治理资料' }] }; } },
    publicWebFetch:{ async acquire() { return { sourceRef:'https://example.com/governance', title:'治理资料', text:'公开治理资料。', fetchedAt:'2026-07-23T00:00:00.000Z', truncated:false }; } }
  });
  const result = await worker.execute({ taskId:'task-governance', assigneeAgentId:'public-reporter', input:{ title:'查找三个 Agent 权限治理官方公开资料并给中文重点' } });
  assert.equal(query, 'Agent governance official documentation');
  assert.equal(result.status, 'succeeded');
});

test('公开搜索不可用时不编造资料，明确说明可直接给链接', async () => {
  const worker = new LocalPublicReport({ publicWebSearch:{ async search() { const error = new Error('公开搜索暂时不可用。'); error.code = 'search_unavailable'; throw error; } }, publicWebFetch:{ async acquire() { throw new Error('must not fetch'); } } });
  const result = await worker.execute({ taskId:'task-search-failed', input:{ title:'查找公开资料' } });
  assert.equal(result.status, 'needs_input');
  assert.equal(result.error.code, 'search_unavailable');
  assert.match(result.error.userMessage, /直接发一到五条公开网页链接/);
});

test('一条公开来源不可读时仍会交付其余实际读取到的资料', async () => {
  const requested = [];
  const worker = new LocalPublicReport({ publicWebFetch:{ async acquire({ sourceUrl }) {
    requested.push(sourceUrl);
    if (sourceUrl.endsWith('/blocked')) {
      const error = new Error('公开页面返回 406。');
      error.code = 'public_source_unavailable';
      throw error;
    }
    return { sourceRef:sourceUrl, title:'可读取资料', text:'可读取的公开正文。', fetchedAt:'2026-07-23T00:00:00.000Z', truncated:false };
  } } });
  const result = await worker.execute({ taskId:'task-partial-source', assigneeAgentId:'public-reporter', input:{ sourceUrls:['https://example.com/blocked', 'https://example.com/available'] } });
  const report = result.artifactRefs[0].data;
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(requested, ['https://example.com/blocked', 'https://example.com/available']);
  assert.equal(report.sourceCount, 1);
  assert.equal(report.unavailableSources.length, 1);
  assert.equal(report.unavailableSources[0].source, 'https://example.com/blocked');
  assert.match(report.summary, /1 条公开来源本次无法读取，已忽略/);
  assert.equal(result.usage.tools[0].calls, 2);
});

test('所有公开来源都不可读时等待用户补充，不伪造失败恢复任务', async () => {
  const worker = new LocalPublicReport({ publicWebFetch:{ async acquire() { const error = new Error('公开页面返回 406。'); error.code = 'public_source_unavailable'; throw error; } } });
  const result = await worker.execute({ taskId:'task-no-readable-source', assigneeAgentId:'public-reporter', input:{ sourceUrl:'https://example.com/blocked' } });
  assert.equal(result.status, 'needs_input');
  assert.equal(result.currentStage, 'public_sources_unavailable');
  assert.equal(result.error.code, 'public_sources_unavailable');
  assert.equal(result.error.unavailableSources.length, 1);
  assert.match(result.error.userMessage, /不会登录、不会读取私密内容/);
});

test('公开网页员工会逐条读取多份公开资料并交付可追踪对比报告', async () => {
  const requested = [];
  const worker = new LocalPublicReport({ publicWebFetch:{ async acquire({ sourceUrl }) {
    requested.push(sourceUrl);
    return { sourceRef:sourceUrl, title:sourceUrl.endsWith('a') ? '资料A' : '资料B', text:sourceUrl.endsWith('a') ? 'A 的第一句。A 的第二句。' : 'B 的第一句。B 的第二句。', fetchedAt:'2026-07-22T00:00:00.000Z', truncated:false };
  } } });
  const result = await worker.execute({ taskId:'task-compare', assigneeAgentId:'public-reporter', input:{ sourceUrls:['https://example.com/a', 'https://example.com/b'] } });
  const report = result.artifactRefs[0].data;
  assert.deepEqual(requested, ['https://example.com/a', 'https://example.com/b']);
  assert.equal(report.sourceCount, 2);
  assert.equal(report.sources.length, 2);
  assert.match(report.summary, /资料A/);
  assert.match(report.summary, /资料B/);
  assert.equal(result.execution.mode, 'public_read_comparison');
  assert.equal(result.usage.tools[0].calls, 2);
});

test('公开网页员工会把 AI 的对比结论限定在已读取的资料中，AI 不可用仍交付如实的分别重点', async () => {
  const fetch = { async acquire({ sourceUrl }) { return { sourceRef:sourceUrl, title:sourceUrl.endsWith('a') ? '资料A' : '资料B', text:sourceUrl.endsWith('a') ? '产品定位清楚。' : '用户反馈较多。', fetchedAt:'2026-07-22T00:00:00.000Z', truncated:false }; } };
  const advisor = { async compare({ sources }) { assert.equal(sources.length, 2); return { commonPoints:['两份资料都描述同一类产品'], differences:['资料1强调定位，资料2强调反馈'], recommendation:'先确认你最关心的比较维度', basis:'仅根据已读取的公开网页内容' }; } };
  const report = (await new LocalPublicReport({ publicWebFetch:fetch, comparisonAdvisor:advisor }).execute({ taskId:'task-ai-compare', assigneeAgentId:'public-reporter', input:{ sourceUrls:['https://example.com/a', 'https://example.com/b'] } })).artifactRefs[0].data;
  assert.equal(report.comparison.aiAssisted, true);
  assert.match(report.summary, /共同点/);
  assert.match(report.summary, /主要差别/);

  const fallback = (await new LocalPublicReport({ publicWebFetch:fetch, comparisonAdvisor:{ async compare() { throw new Error('unavailable'); } } }).execute({ taskId:'task-fallback-compare', assigneeAgentId:'public-reporter', input:{ sourceUrls:['https://example.com/a', 'https://example.com/b'] } })).artifactRefs[0].data;
  assert.equal(fallback.comparison.aiAssisted, false);
  assert.match(fallback.summary, /资料A/);
  assert.match(fallback.summary, /资料B/);
});

test('公开网页员工遇到超过五份资料会要求分批，不偷偷遗漏后面的资料', async () => {
  const requested = [];
  const worker = new LocalPublicReport({ publicWebFetch:{ async acquire({ sourceUrl }) { requested.push(sourceUrl); return { sourceRef:sourceUrl, title:sourceUrl, text:'公开正文。', fetchedAt:'2026-07-22T00:00:00.000Z', truncated:false }; } } });
  const result = await worker.execute({ taskId:'task-limit', assigneeAgentId:'public-reporter', input:{ sourceUrls:['https://example.com/1','https://example.com/2','https://example.com/3','https://example.com/4','https://example.com/5','https://example.com/6'] } });
  assert.equal(result.status, 'needs_input');
  assert.equal(result.currentStage, 'public_page_limit_exceeded');
  assert.match(result.error.userMessage, /最多对比五条/);
  assert.equal(requested.length, 0);
});

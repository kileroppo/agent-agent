import assert from 'node:assert/strict';
import test from 'node:test';
import { HermesIntelResearchAdvisor } from '../src/hermes-intel-research-advisor.ts';

const sources = [
  {
    sourceId:'source-1',
    title:'资料一',
    url:'https://example.com/a',
    fetchedAt:'2026-07-30T00:00:00.000Z',
    contentHash:'a'.repeat(64),
    summary:'公开摘要 A。',
    evidenceEligible:true,
    evidenceFragments:[{ fragmentId:'source-1-fragment-1', text:'公开摘要 A。' }],
  },
  {
    sourceId:'source-2',
    title:'资料二',
    url:'https://example.com/b',
    fetchedAt:'2026-07-30T00:00:00.000Z',
    contentHash:'b'.repeat(64),
    summary:'公开摘要 B。',
    evidenceEligible:true,
    evidenceFragments:[{ fragmentId:'source-2-fragment-1', text:'公开摘要 B。' }],
  },
];

test('小R AI 顾问只根据已读取来源返回结构化研究字段', async () => {
  let prompt = '';
  const advisor = new HermesIntelResearchAdvisor({ hermesHome:'/safe/profile', run:async (_command, args) => {
    assert.deepEqual(args.slice(0, 2), ['--toolsets', 'clarify']);
    assert.equal(args.includes('--ignore-rules'), false);
    prompt = args.at(-1);
    return '{"background":"公开背景","claims":[{"text":"两个来源分别记录 A 和 B","sourceIds":["source-1","source-2"],"evidenceFragments":[{"sourceId":"source-1","fragmentId":"source-1-fragment-1","text":"公开摘要 A。"},{"sourceId":"source-2","fragmentId":"source-2-fragment-1","text":"公开摘要 B。"}]}],"conclusion":"仅据资料可得的结论","recommendations":["先验证"],"openQuestions":["还需什么资料"]}';
  } });
  const report = await advisor.analyze({ topic:'示例主题', sources });
  assert.equal(report.aiAssisted, true);
  assert.deepEqual(report.findings, ['两个来源分别记录 A 和 B']);
  assert.deepEqual(report.claims[0].sourceIds, ['source-1', 'source-2']);
  assert.equal(report.claims[0].evidenceFragments.length, 2);
  assert.match(prompt, /不访问网页/);
  assert.match(prompt, /公开摘要 A/);
  assert.match(prompt, /禁止把所有来源批量挂到每条结论/);
});

test('小R AI 不可用时仍返回有边界的结构化降级报告', async () => {
  const report = await new HermesIntelResearchAdvisor({ hermesHome:'' }).analyze({ topic:'示例主题', sources });
  assert.equal(report.aiAssisted, false);
  assert.equal(report.findings.length, 2);
  assert.equal(report.claims.every((claim) => claim.sourceIds.length === 1), true);
  assert.match(report.conclusion, /无法确认/);
});

test('Hermes 顾问编造或改写 evidence fragment 时整份输出失效并回退', async () => {
  const advisor = new HermesIntelResearchAdvisor({
    hermesHome:'/safe/profile',
    run:async () => '{"background":"背景","claims":[{"text":"编造事实","sourceIds":["source-1"],"evidenceFragments":[{"sourceId":"source-1","fragmentId":"source-1-fragment-1","text":"不存在的片段"}]}],"conclusion":"结论","recommendations":[],"openQuestions":[]}',
  });
  const report = await advisor.analyze({ topic:'示例主题', sources });
  assert.equal(report.aiAssisted, false);
  assert.notEqual(report.claims[0].text, '编造事实');
});

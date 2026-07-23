import assert from 'node:assert/strict';
import test from 'node:test';
import { HermesIntelResearchAdvisor } from '../src/hermes-intel-research-advisor.js';

const sources = [{ title:'资料一', source:'https://example.com/a', summary:'公开摘要 A。' }, { title:'资料二', source:'https://example.com/b', summary:'公开摘要 B。' }];

test('小R AI 顾问只根据已读取来源返回结构化研究字段', async () => {
  let prompt = '';
  const advisor = new HermesIntelResearchAdvisor({ hermesHome:'/safe/profile', run:async (_command, args) => {
    prompt = args.at(-1);
    return '{"background":"公开背景","findings":["资料1说明 A"],"conclusion":"仅据资料可得的结论","recommendations":["先验证"],"openQuestions":["还需什么资料"]}';
  } });
  const report = await advisor.analyze({ topic:'示例主题', sources });
  assert.equal(report.aiAssisted, true);
  assert.deepEqual(report.findings, ['资料1说明 A']);
  assert.match(prompt, /不访问网页/);
  assert.match(prompt, /公开摘要 A/);
});

test('小R AI 不可用时仍返回有边界的结构化降级报告', async () => {
  const report = await new HermesIntelResearchAdvisor({ hermesHome:'' }).analyze({ topic:'示例主题', sources });
  assert.equal(report.aiAssisted, false);
  assert.equal(report.findings.length, 2);
  assert.match(report.conclusion, /无法确认/);
});

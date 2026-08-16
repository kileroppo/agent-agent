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

test('天气研究的 AI 不可用时仍从已读取七日预报生成可直接使用的三条建议', async () => {
  const weatherSources = [{
    sourceId:'source-1',
    title:'杭州7天天气预报',
    url:'https://www.weather.com.cn/weather/101210101.shtml',
    fetchedAt:'2026-08-17T00:00:00.000Z',
    contentHash:'c'.repeat(64),
    evidenceEligible:true,
    evidenceFragments:[{
      fragmentId:'source-1-fragment-1',
      text:'17日（今天） 多云 33 / 26℃ 18日（明天） 阴转多云 34 / 25℃ 19日（后天） 多云转阴 34 / 26℃ 20日（周四） 中雨转多云 33 / 25℃ 21日（周五） 小雨转阴 33 / 24℃ 22日（周六） 中雨转小雨 33 / 25℃ 23日（周日） 小雨 32 / 24℃',
    }],
  }, {
    sourceId:'source-2',
    title:'杭州-天气预报',
    url:'https://www.nmc.cn/publish/forecast/AZJ/hangzhou.html',
    fetchedAt:'2026-08-17T00:00:00.000Z',
    contentHash:'d'.repeat(64),
    evidenceEligible:true,
    evidenceFragments:[{
      fragmentId:'source-2-fragment-1',
      text:'杭州天气预报 发布时间：08-17 08:00 7天预报 08/17 周一 小雨 东风 微风 33℃ 26℃ 多云 东风 微风 08/18 周二 小雨 东北风 微风 34℃ 25℃ 多云 东南风 微风 08/19 周三 多云 东风 微风 34℃ 26℃ 阴 东南风 微风 08/20 周四 中雨 东风 微风 31℃ 25℃ 小雨 东南风 微风 08/21 周五 小雨 东风 微风 33℃ 26℃ 晴 东南风 微风 08/22 周六 小雨 东风 微风 33℃ 26℃ 多云 南风 微风 08/23 周日 小雨 东南风 微风 33℃ 26℃ 多云 南风 微风',
    }],
  }];
  const report = await new HermesIntelResearchAdvisor({ hermesHome:'' }).analyze({ topic:'查询杭州未来7天天气并给出出行建议', sources:weatherSources });
  assert.equal(report.aiAssisted, false);
  assert.equal(report.recommendations.length, 3);
  assert.match(report.conclusion, /17日（今天）多云，33℃\/26℃/);
  assert.match(report.recommendations.join('\n'), /20日.*带伞/);
  assert.deepEqual(report.claims[0].sourceIds, ['source-1']);
  assert.equal(report.claims[0].evidenceFragments[0].text, weatherSources[0].evidenceFragments[0].text);
  assert.match(report.conclusion, /有6天存在差异/);
  assert.match(report.conclusion, /17日天气为中国天气网“多云”、中央气象台“小雨转多云”/);
  assert.match(report.conclusion, /20日.*中国天气网33\/25℃、中央气象台31\/25℃/);
  assert.deepEqual(report.claims[1].sourceIds, ['source-1', 'source-2']);
  assert.equal(report.claims[1].evidenceFragments.length, 2);
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

import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalIntelResearcher } from '../src/local-intel-researcher.js';

const now = () => new Date('2026-07-23T00:00:00.000Z');

test('小R 使用给定公开来源产出结构化研究报告', async () => {
  const worker = new LocalIntelResearcher({ now, publicWebFetch:{ async acquire({ sourceUrl }) { return { sourceRef:sourceUrl, title:'公开资料', text:'第一项事实。第二项事实。', fetchedAt:now().toISOString(), truncated:false }; } }, researchAdvisor:{ async analyze({ topic, sources }) { assert.equal(topic, '研究 Agent 运行时'); assert.equal(sources.length, 2); return { background:'背景', findings:['发现'], conclusion:'结论', recommendations:['建议'], openQuestions:['问题'], basis:'仅根据已读取的公开来源内容', aiAssisted:true }; } } });
  const result = await worker.execute({ taskId:'intel-1', assigneeAgentId:'intel-researcher', input:{ topic:'研究 Agent 运行时', sourceUrls:['https://example.com/a', 'https://example.com/b'] } });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.artifactRefs[0].type, 'intel_research_report');
  assert.equal(result.artifactRefs[0].data.conclusion, '结论');
  assert.equal(result.artifactRefs[0].validation.structured, true);
});

test('小R 没有来源且读取失败时明确 needs_input，不编造报告', async () => {
  const worker = new LocalIntelResearcher({ now, publicWebFetch:{ async acquire() { throw new Error('无法读取'); } }, publicWebSearch:{ async search() { return { results:[{ url:'https://example.com/a' }] }; } } });
  const result = await worker.execute({ taskId:'intel-fail', input:{ topic:'研究主题' } });
  assert.equal(result.status, 'needs_input');
  assert.equal(result.error.code, 'research_sources_unavailable');
  assert.match(result.error.userMessage, /公开来源/);
});

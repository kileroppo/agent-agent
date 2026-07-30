import assert from 'node:assert/strict';
import test from 'node:test';
import { HermesPublicSummaryAdvisor } from '../src/hermes-public-summary-advisor.js';

test('单来源摘要顾问只能依据已读取内容给出中文重点', async () => {
  let prompt = '';
  const advisor = new HermesPublicSummaryAdvisor({ hermesHome:'/safe/profile', run:async (_command, args) => {
    assert.deepEqual(args.slice(0, 2), ['--toolsets', 'clarify']);
    assert.equal(args.includes('--ignore-rules'), false);
    prompt = args.at(-1);
    return '{"keyPoints":[{"text":"该页面只说明公开资料的使用范围","evidence":"This domain is for use in documentation examples."}],"recommendation":{"text":"按页面说明使用该资料","evidence":"documentation examples"}}';
  } });
  const result = await advisor.refine({ source:{ title:'Example Domain', source:'https://example.com', summary:'This domain is for use in documentation examples.' } });
  assert.deepEqual(result.keyPoints, ['该页面只说明公开资料的使用范围']);
  assert.match(prompt, /不访问网页/);
  assert.match(prompt, /Example Domain/);
});

test('未配置、没有重点或没有原文证据时不伪造中文提炼', async () => {
  const source = { title:'Example', summary:'Example text.' };
  assert.equal(await new HermesPublicSummaryAdvisor({ hermesHome:'' }).refine({ source }), null);
  const invalid = new HermesPublicSummaryAdvisor({ hermesHome:'/safe/profile', run:async () => '{"keyPoints":[]}' });
  assert.equal(await invalid.refine({ source }), null);
  const unsupported = new HermesPublicSummaryAdvisor({ hermesHome:'/safe/profile', run:async () => '{"keyPoints":[{"text":"编造结论","evidence":"不存在的原文"}]}' });
  assert.equal(await unsupported.refine({ source }), null);
});

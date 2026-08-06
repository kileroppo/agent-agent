import assert from 'node:assert/strict';
import test from 'node:test';
import { HermesPublicComparisonAdvisor } from '../src/hermes-public-comparison-advisor.js';

test('公开资料对比 AI 只能依据已读取摘要给出共同点、差别和建议', async () => {
  let prompt = '';
  const advisor = new HermesPublicComparisonAdvisor({ hermesHome:'/safe/profile', run:async (_command, args) => {
    assert.deepEqual(args.slice(0, 2), ['--toolsets', 'clarify']);
    assert.equal(args.includes('--ignore-rules'), false);
    prompt = args.at(-1);
    return '{"commonPoints":["两份资料都讨论公开网页摘要"],"differences":["资料1强调产品定位，资料2强调用户反馈"],"recommendation":"先确认要优先比较定位还是用户反馈"}';
  } });
  const result = await advisor.compare({ sources:[{ title:'资料1', summary:'产品定位。' }, { title:'资料2', summary:'用户反馈。' }] });
  assert.deepEqual(result.commonPoints, ['两份资料都讨论公开网页摘要']);
  assert.match(result.differences[0], /资料1/);
  assert.match(prompt, /不访问网页/);
  assert.match(prompt, /资料1/);
});

test('没有配置或 AI 回话不完整时不伪造对比结论', async () => {
  assert.equal(await new HermesPublicComparisonAdvisor({ hermesHome:'' }).compare({ sources:[{ title:'一', summary:'甲' }, { title:'二', summary:'乙' }] }), null);
  const invalid = new HermesPublicComparisonAdvisor({ hermesHome:'/safe/profile', run:async () => '{"commonPoints":[]}' });
  assert.equal(await invalid.compare({ sources:[{ title:'一', summary:'甲' }, { title:'二', summary:'乙' }] }), null);
});

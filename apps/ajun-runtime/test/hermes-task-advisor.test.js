import assert from 'node:assert/strict';
import test from 'node:test';
import { HermesTaskAdvisor } from '../src/hermes-task-advisor.js';

test('任务理解 AI 只输出目标、交付物、缺少信息和安全下一步', async () => {
  let prompt = '';
  const advisor = new HermesTaskAdvisor({ hermesHome:'/safe/profile', run:async (_command, args) => {
    assert.deepEqual(args.slice(0, 2), ['--toolsets', 'clarify']);
    assert.equal(args.includes('--ignore-rules'), false);
    prompt = args.at(-1);
    return '{"understanding":"把竞品信息整理成可执行清单","deliverable":"一份中文对比清单","missing":["竞品范围"],"safeNextStep":"先盘点当前可用员工与公开资料范围"}';
  } });
  const advice = await advisor.advise({ request:'帮我研究竞品', employees:[{ name:'公开资料报告员', acceptedTaskTypes:['report.public-material'] }] });
  assert.equal(advice.deliverable, '一份中文对比清单');
  assert.deepEqual(advice.missing, ['竞品范围']);
  assert.match(prompt, /公开资料报告员/);
  assert.match(prompt, /不调用工具、不执行任务/);
});

test('AI 回话不完整或没有配置运行环境时不产生假建议', async () => {
  const disabled = new HermesTaskAdvisor({ hermesHome:'' });
  assert.equal(await disabled.advise({ request:'帮我研究竞品' }), null);
  const invalid = new HermesTaskAdvisor({ hermesHome:'/safe/profile', run:async () => '{"understanding":"不完整"}' });
  assert.equal(await invalid.advise({ request:'帮我研究竞品' }), null);
});

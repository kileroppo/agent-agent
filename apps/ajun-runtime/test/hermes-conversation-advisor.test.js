import assert from 'node:assert/strict';
import test from 'node:test';
import { HermesConversationAdvisor } from '../src/hermes-conversation-advisor.js';

test('AI 能把自然追问识别为上一轮使用记录的明细请求', async () => {
  const advisor = new HermesConversationAdvisor({ hermesHome:'/safe/profile', run:async (_command, args) => {
    assert.deepEqual(args.slice(0, 2), ['--toolsets', 'clarify']);
    assert.equal(args.includes('--ignore-rules'), false);
    assert.match(args.at(-1), /usage_report/);
    assert.match(args.at(-1), /哪18项/);
    return '{"action":"show_last_usage_items"}';
  } });
  assert.deepEqual(await advisor.decide({ message:'哪18项？', context:{ kind:'usage_report', recordedTaskCount:18, actualToolCalls:3, createdAt:'2026-07-22T00:00:00.000Z' } }), { action:'show_last_usage_items' });
});

test('AI 不能从对话理解层发明其他动作', async () => {
  const advisor = new HermesConversationAdvisor({ hermesHome:'/safe/profile', run:async () => '{"action":"send_money"}' });
  assert.equal(await advisor.decide({ message:'直接付款', context:{ kind:'usage_report' } }), null);
});

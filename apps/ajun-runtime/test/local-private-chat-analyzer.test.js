import assert from 'node:assert/strict';
import test from 'node:test';
import { chunkMessages, LocalPrivateChatAnalyzer } from '../src/local-private-chat-analyzer.js';

test('本机分析器拒绝非回环地址', () => {
  assert.throws(() => new LocalPrivateChatAnalyzer({ baseUrl:'https://example.com' }), (error) => error.code === 'local_model_not_loopback');
});

test('分析器只给模型匿名发言者并清除模型复述的原句', async () => {
  const bodies = [];
  const analyzer = new LocalPrivateChatAnalyzer({
    model:'qwen3:14b',
    fetchImpl:async (url, options = {}) => {
      if (url.endsWith('/api/tags')) return { ok:true, async json() { return { models:[{ name:'qwen3:14b' }] }; } };
      bodies.push(JSON.parse(options.body));
      return { ok:true, async json() { return { response:JSON.stringify({ summary:'这是绝不能原样保存的敏感聊天原句', topics:['排期'], decisions:[], todos:['跟进'], risks:[], replySuggestions:[] }) }; } };
    },
    now:() => new Date('2026-08-02T02:00:00.000Z')
  });
  assert.equal((await analyzer.health()).status, 'ready');
  const result = await analyzer.analyze([{ time:'10:00', sender:'真实姓名', content:'这是绝不能原样保存的敏感聊天原句' }]);
  assert.equal(bodies[0].prompt.includes('真实姓名'), false);
  assert.equal(result.summary, '[已省略原句]');
  assert.equal(result.containsRawChat, false);
});

test('消息按最新优先限制总字符并按 2 万字符以内分块', () => {
  const messages = Array.from({ length:200 }, (_, index) => ({ time:String(index), speaker:'发言者1', content:'x'.repeat(900) }));
  const chunks = chunkMessages(messages);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 20_000));
  assert.ok(chunks.reduce((sum, chunk) => sum + chunk.length, 0) <= 120_000);
});

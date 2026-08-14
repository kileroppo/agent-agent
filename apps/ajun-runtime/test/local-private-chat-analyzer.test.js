import assert from 'node:assert/strict';
import test from 'node:test';
import { chunkMessages, LocalPrivateChatAnalyzer } from '../src/local-private-chat-analyzer.ts';

test('本机分析器拒绝非回环地址', () => {
  assert.throws(() => new LocalPrivateChatAnalyzer({ baseUrl:'https://example.com' }), (error) => error.code === 'local_model_not_loopback');
});

test('分析器只给模型匿名发言者并清除模型复述的原句', async () => {
  const bodies = [];
  const analyzer = new LocalPrivateChatAnalyzer({
    model:'qwen3:14b',
    baseUrl:'http://127.0.0.1:11434',
    fetchImpl:async (url, options = {}) => {
      if (url.endsWith('/api/tags')) return { ok:true, async json() { return { models:[{ name:'qwen3:14b' }] }; } };
      bodies.push(JSON.parse(options.body));
      return { ok:true, async json() { return { response:JSON.stringify({ summary:'模型摘录：不能原样保存的敏感聊天', topics:['排期'], decisions:[], todos:['跟进'], risks:[], replySuggestions:[] }) }; } };
    },
    now:() => new Date('2026-08-02T02:00:00.000Z')
  });
  assert.equal((await analyzer.health()).status, 'ready');
  const result = await analyzer.analyze([{ time:'10:00', sender:'真实姓名', content:'这是绝不能原样保存的敏感聊天原句' }]);
  assert.equal(bodies[0].prompt.includes('真实姓名'), false);
  assert.equal(bodies[0].options.num_ctx, 32_768);
  assert.equal(result.summary, '模型摘录：[已省略原句]');
  assert.equal(result.containsRawChat, false);
});

test('默认 OpenAI 兼容服务通过健康检查并返回结构化本机结果', async () => {
  const model = '/local/qwen3.5-9b';
  const bodies = [];
  const analyzer = new LocalPrivateChatAnalyzer({
    model,
    baseUrl:'http://127.0.0.1:18081',
    fetchImpl:async (url, options = {}) => {
      if (url.endsWith('/health')) return { ok:true, async json() { return { status:'healthy', loaded_model:model }; } };
      bodies.push(JSON.parse(options.body));
      return { ok:true, async json() { return { choices:[{ message:{ content:JSON.stringify({ summary:'安全摘要', topics:[], decisions:[], todos:[], risks:[], replySuggestions:[] }) } }] }; } };
    },
    now:() => new Date('2026-08-04T00:00:00.000Z')
  });
  assert.equal((await analyzer.health()).status, 'ready');
  const result = await analyzer.analyze([{ time:'10:00', sender:'甲', content:'短消息' }]);
  assert.equal(bodies[0].messages[0].content.includes('发言者1'), true);
  assert.equal(bodies[0].enable_thinking, false);
  assert.equal(bodies[0].max_tokens, 512);
  assert.equal(result.summary, '安全摘要');
});

test('消息按最新优先限制总字符并按 2 万字符以内分块', () => {
  const messages = Array.from({ length:200 }, (_, index) => ({ time:String(index), speaker:'发言者1', content:'x'.repeat(900) }));
  const chunks = chunkMessages(messages);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 20_000));
  assert.ok(chunks.reduce((sum, chunk) => sum + chunk.length, 0) <= 120_000);
});

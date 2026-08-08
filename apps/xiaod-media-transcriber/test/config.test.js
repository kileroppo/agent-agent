import test from 'node:test';
import assert from 'node:assert/strict';
import { configuredCapabilities, requireLoopbackHost } from '../src/config.js';
import { buildRefinerRequest, extractRefinerMarkdown, fallbackGuide, requestRefinement } from '../src/pipeline.js';

test('configuration reports only complete optional integrations', () => {
  const capabilities = configuredCapabilities();
  assert.equal(typeof capabilities.aiRefinement, 'boolean');
  assert.equal(typeof capabilities.lark, 'boolean');
  assert.equal(typeof capabilities.mediaCrawlerDeep, 'boolean');
  assert.equal(typeof capabilities.testFailpointArmed, 'boolean');
});

test('小D运行台只允许回环监听，拒绝环境变量把无鉴权入口暴露到局域网', () => {
  assert.equal(requireLoopbackHost('127.0.0.1'), '127.0.0.1');
  assert.equal(requireLoopbackHost('127.1.2.3'), '127.1.2.3');
  assert.equal(requireLoopbackHost('localhost'), 'localhost');
  assert.equal(requireLoopbackHost('::1'), '::1');
  assert.throws(() => requireLoopbackHost('0.0.0.0'), /只允许监听本机回环地址/);
  assert.throws(() => requireLoopbackHost('192.168.1.20'), /只允许监听本机回环地址/);
});

test('StepFun uses Messages API and corrects a Step Plan base for step-3.7', () => {
  const request = buildRefinerRequest({ url: 'https://api.stepfun.com/step_plan/v1', apiKey: 'test-key', model: 'step-3.7-flash', maxTokens: 1234 }, '标题', '原文');
  assert.equal(request.provider, 'stepfun');
  assert.equal(request.url, 'https://api.stepfun.com/v1/messages');
  const payload = JSON.parse(request.options.body);
  assert.equal(payload.max_tokens, 1234);
  assert.equal(payload.system.includes('内容导览'), true);
  assert.deepEqual(payload.messages, [{ role: 'user', content: '标题：标题\n\n原始转录：\n原文' }]);
});

test('StepFun routes step-router-v1 through Step Plan Messages API', () => {
  const request = buildRefinerRequest({ url: 'https://api.stepfun.com/v1/messages', apiKey: 'test-key', model: 'step-router-v1', maxTokens: 1024 }, '标题', '原文');
  assert.equal(request.url, 'https://api.stepfun.com/step_plan/v1/messages');
});

test('a missing refiner yields a guide rather than duplicating the full transcript', () => {
  const guide = fallbackGuide('测试');
  assert.match(guide, /待人工确认/);
  assert.doesNotMatch(guide, /第一句。/);
});

test('extracts text from StepFun, OpenAI-compatible, and Responses-style payloads', () => {
  assert.equal(extractRefinerMarkdown({ content: [{ type: 'thinking', thinking: '...' }, { type: 'text', text: 'StepFun 正文' }] }), 'StepFun 正文');
  assert.equal(extractRefinerMarkdown({ choices: [{ message: { content: '兼容接口正文' } }] }), '兼容接口正文');
  assert.equal(extractRefinerMarkdown({ output: [{ content: [{ type: 'output_text', text: 'Responses 正文' }] }] }), 'Responses 正文');
});

test('an empty refiner response falls back to a deliverable guide instead of failing transcription', async () => {
  const result = await requestRefinement(
    { url: 'https://api.stepfun.com/v1/messages', apiKey: 'test-key', model: 'step-3.7-flash' },
    '测试',
    '原文',
    async () => new Response(JSON.stringify({ content: [{ type: 'thinking', thinking: 'no final text' }] }), { status: 200 })
  );
  assert.equal(result.usedRefiner, false);
  assert.match(result.markdown, /待人工确认/);
  assert.match(result.refinerFallbackReason, /没有返回正文/);
});

test('a stalled refiner falls back instead of leaving a task in the整理 stage', async () => {
  const result = await requestRefinement(
    { url: 'https://api.stepfun.com/v1/messages', apiKey: 'test-key', model: 'step-3.7-flash' },
    '测试',
    '原文',
    async (_url, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once:true })),
    5
  );
  assert.equal(result.usedRefiner, false);
  assert.match(result.refinerFallbackReason, /语义整理未完成/);
});

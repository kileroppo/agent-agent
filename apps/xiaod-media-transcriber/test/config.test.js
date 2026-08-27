import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertPreflightReady,
  configuredCapabilities,
  prepareTaskRunEventDatabasePath,
  requireLoopbackHost,
  resolveTaskRunEventDb,
} from '../src/config.ts';
import { buildRefinerRequest, extractRefinerMarkdown, fallbackGuide, requestRefinement } from '../src/pipeline.ts';

test('assertPreflightReady passes for writable directory and detects tools', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaod-preflight-test-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const result = await assertPreflightReady({ workDir: root, asrBin: 'mlx_whisper' });
  assert.equal(result.workDirWritable, true);
  assert.equal(result.workDirPath, path.resolve(root));
  assert.equal(typeof result.ffmpegAvailable, 'boolean');
  assert.equal(typeof result.asrBinAvailable, 'boolean');
});

test('assertPreflightReady rejects invalid workDir path with actionable error', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaod-invalid-workdir-'));
  const filePath = path.join(root, 'already-a-file');
  await fs.writeFile(filePath, 'not-a-directory');
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  await assert.rejects(
    assertPreflightReady({ workDir: path.join(filePath, 'sub-dir') }),
    /小D启动准入失败/
  );
});

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

test('运行事件库优先使用显式路径，其次复用A君数据目录', () => {
  assert.equal(
    resolveTaskRunEventDb({
      AGENT_ARMY_TASK_RUN_EVENT_DB:'./explicit/events.sqlite',
      AGENT_ARMY_DATA_DIR:'./shared-data',
    }),
    path.resolve('./explicit/events.sqlite'),
  );
  assert.equal(
    resolveTaskRunEventDb({ AGENT_ARMY_DATA_DIR:'./shared-data' }),
    path.resolve('./shared-data/task-run-events.sqlite'),
  );
  assert.match(resolveTaskRunEventDb({}), /apps\/ajun-runtime\/data\/task-run-events\.sqlite$/);
});

test('启动前创建0700事件目录、收紧已有数据库为0600并拒绝符号链接父目录', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaod-task-events-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const databasePath = path.join(root, 'shared-events', 'task-run-events.sqlite');
  assert.equal(await prepareTaskRunEventDatabasePath(databasePath), databasePath);
  assert.equal((await fs.stat(path.dirname(databasePath))).mode & 0o777, 0o700);
  await fs.writeFile(databasePath, '', { mode:0o644 });
  await prepareTaskRunEventDatabasePath(databasePath);
  assert.equal((await fs.stat(databasePath)).mode & 0o777, 0o600);

  const target = path.join(root, 'real-events');
  const linked = path.join(root, 'linked-events');
  await fs.mkdir(target, { mode:0o700 });
  await fs.symlink(target, linked);
  await assert.rejects(
    prepareTaskRunEventDatabasePath(path.join(linked, 'events.sqlite')),
    { code:'task_run_event_parent_unsafe' },
  );
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

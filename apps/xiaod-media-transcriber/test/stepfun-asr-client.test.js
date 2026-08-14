import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { StepFunAsrClient, parseStepFunAsrSse } from '../src/stepfun-asr-client.ts';

const sse = [
  'data: {"type":"transcript.text.delta","delta":"你好"}',
  '',
  'data: {"type":"transcript.text.delta","delta":"世界"}',
  '',
  'data: {"type":"transcript.text.done","text":"你好世界","usage":{"input_tokens":10,"output_tokens":4}}',
  '',
].join('\n');

test('解析 StepFun SSE 时以 done 全文和 usage 为最终回执', () => {
  assert.deepEqual(parseStepFunAsrSse(sse), {
    text:'你好世界',
    usage:{ input_tokens:10, output_tokens:4 },
  });
});

test('StepFun ASR 只调用官方 Step Plan SSE 且不泄漏凭据到结果', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stepfun-asr-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const input = path.join(root, 'input.wav');
  await fs.writeFile(input, Buffer.from('RIFF-fixture'));
  let request = null;
  const client = new StepFunAsrClient({
    credentialProvider:{ async resolve() { return { apiKey:'test-secret-not-for-output' }; } },
    fetchImpl:async (url, options) => {
      request = { url, options };
      return new Response(sse, { status:200, headers:{ 'content-type':'text/event-stream' } });
    },
  });
  const result = await client.transcribe(input);
  assert.equal(request.url, 'https://api.stepfun.com/step_plan/v1/audio/asr/sse');
  const body = JSON.parse(request.options.body);
  assert.equal(body.audio.input.transcription.model, 'stepaudio-2.5-asr');
  assert.equal(body.audio.input.format.type, 'wav');
  assert.equal(result.text, '你好世界');
  assert.equal(JSON.stringify(result).includes('test-secret'), false);
});

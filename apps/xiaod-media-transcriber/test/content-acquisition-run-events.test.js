import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MediaPipeline } from '../src/pipeline.ts';

test('小D在判断采集成功或失败前先把acquisition receipt交给统一事件桥', async (context) => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaod-acquisition-events-'));
  context.after(() => fs.rm(workDir, { recursive:true, force:true }));
  const receipts = [];
  const fetches = [];
  const successfulReceipt = receipt('success');
  const pipeline = new MediaPipeline({
    store:{ get() { return null; } },
    workDir,
    contentCenter:{
      async fetch(input) {
        fetches.push(input);
        return {
          ok:true,
          acquisitionReceipt:successfulReceipt,
          contentPackage:{ provider:'public_media', acquisitionPath:'general', providedCapabilities:['subtitles'] },
          runtime:{ kind:'subtitle', path:path.join(workDir, 'subtitle.vtt') },
        };
      },
    },
    runEventBridge:{ async recordExecutionReceipt(value) { receipts.push(value); } },
  });
  const result = await pipeline.acquire({
    id:'job-acquire', agentArmyTaskId:'agent-army-task-acquire',
    sourceType:'url', sourceUrl:'https://example.com/watch',
  }, workDir);
  assert.equal(result.kind, 'subtitle');
  assert.deepEqual(receipts, [successfulReceipt]);
  assert.equal(fetches[0].taskId, 'agent-army-task-acquire');

  const failedReceipt = receipt('confirmed_failure');
  pipeline.contentCenter = {
    async fetch() {
      return {
        ok:false, code:'adapter_unavailable', safeMessage:'通道不可用', recommendedAction:'retry',
        acquisitionReceipt:failedReceipt,
      };
    },
  };
  await assert.rejects(
    pipeline.acquire({ id:'job-acquire', sourceType:'url', sourceUrl:'https://example.com/watch' }, workDir),
    /通道不可用/,
  );
  assert.deepEqual(receipts, [successfulReceipt, failedReceipt]);
});

function receipt(outcome) {
  return Object.freeze({
    receiptId:`receipt:content-acquisition:${outcome}`,
    taskId:'agent-army-task-acquire',
    outcome,
  });
}

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CapabilityModelPolicyReader,
  LOCAL_ASR_SELECTION,
  STEPFUN_ASR_SELECTION,
} from '../src/capability-model-policy.ts';

test('能力策略把 A君 UI 保存的 StepFun ASR 冻结为受支持选择', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaod-model-policy-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const filePath = path.join(root, 'stepfun-model-policy.json');
  await fs.writeFile(filePath, JSON.stringify({ capabilities:{ asr:STEPFUN_ASR_SELECTION } }));
  const reader = new CapabilityModelPolicyReader({ filePath });
  assert.deepEqual(await reader.asrSelection(), STEPFUN_ASR_SELECTION);
  assert.deepEqual((await reader.snapshot()).asr, STEPFUN_ASR_SELECTION);
});

test('策略缺失、损坏或未知模型时安全回到本机 ASR', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaod-model-policy-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const filePath = path.join(root, 'stepfun-model-policy.json');
  const reader = new CapabilityModelPolicyReader({ filePath });
  assert.deepEqual(await reader.asrSelection(), LOCAL_ASR_SELECTION);
  await fs.writeFile(filePath, '{bad json');
  assert.deepEqual(await reader.asrSelection(), LOCAL_ASR_SELECTION);
  await fs.writeFile(filePath, JSON.stringify({ capabilities:{ asr:{ provider:'other', model:'unknown' } } }));
  assert.deepEqual(await reader.asrSelection(), LOCAL_ASR_SELECTION);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOneShotFailpoint, createPersistentOneShotFailpoint, resetPersistentOneShotFailpoint } from '../src/test-failpoint.ts';

test('one-shot failpoint is inert unless explicitly configured', () => {
  const failpoint = createOneShotFailpoint('');
  assert.doesNotThrow(() => failpoint('transcribing'));
});

test('one-shot failpoint fails only the configured stage once', () => {
  const failpoint = createOneShotFailpoint('transcribing');
  assert.doesNotThrow(() => failpoint('preparing'));
  assert.throws(() => failpoint('transcribing'), /受控测试：transcribing 阶段执行失败/);
  assert.doesNotThrow(() => failpoint('transcribing'));
});

test('persistent failpoint stays consumed after a runtime restart while armed', async (t) => {
  const markerDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaod-failpoint-'));
  const markerPath = path.join(markerDir, 'consumed');
  t.after(() => fs.rm(markerDir, { recursive:true, force:true }));
  const firstRuntime = createPersistentOneShotFailpoint('transcribing', markerPath);
  await assert.rejects(() => firstRuntime('transcribing'), /受控测试：transcribing 阶段执行失败/);
  const restartedRuntime = createPersistentOneShotFailpoint('transcribing', markerPath);
  await assert.doesNotReject(() => restartedRuntime('transcribing'));
  await resetPersistentOneShotFailpoint(markerPath);
  await assert.rejects(() => createPersistentOneShotFailpoint('transcribing', markerPath)('transcribing'), /受控测试：transcribing 阶段执行失败/);
});

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  OperationsHealthTransitionState,
  operationsHealthTransitionPath,
} from '../src/operations-health-transition-state.ts';

test('持续异常只在首次进入 degraded 时触发，恢复后再次异常才重新触发', async (context) => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'operations-health-transition-'));
  context.after(() => fsp.rm(dataDir, { recursive:true, force:true }));
  const filePath = operationsHealthTransitionPath(dataDir);
  const state = new OperationsHealthTransitionState({ filePath });

  assert.equal((await state.observe({ status:'degraded', checkedAt:'2026-08-17T00:00:00.000Z' })).enteredDegraded, true);
  assert.equal((await state.observe({ status:'degraded', checkedAt:'2026-08-18T00:00:00.000Z' })).enteredDegraded, false);
  assert.equal((await state.observe({ status:'healthy', checkedAt:'2026-08-18T01:00:00.000Z' })).changed, true);
  assert.equal((await state.observe({ status:'degraded', checkedAt:'2026-08-18T02:00:00.000Z' })).enteredDegraded, true);
  assert.equal((await fsp.stat(filePath)).mode & 0o777, 0o600);
});

test('进程重启后从私有状态文件恢复，持续异常不会重复派发', async (context) => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'operations-health-restart-'));
  context.after(() => fsp.rm(dataDir, { recursive:true, force:true }));
  const filePath = operationsHealthTransitionPath(dataDir);
  await new OperationsHealthTransitionState({ filePath }).observe({ status:'degraded' });

  const restarted = new OperationsHealthTransitionState({ filePath });
  assert.deepEqual(await restarted.observe({ status:'degraded' }), {
    previous:'degraded', current:'degraded', changed:false, enteredDegraded:false,
  });
});

test('符号链接状态文件被拒绝，避免越界读写', async (context) => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'operations-health-symlink-'));
  context.after(() => fsp.rm(dataDir, { recursive:true, force:true }));
  const target = path.join(dataDir, 'outside.json');
  const filePath = operationsHealthTransitionPath(dataDir);
  await fsp.writeFile(target, '{}');
  await fsp.symlink(target, filePath);
  await assert.rejects(
    () => new OperationsHealthTransitionState({ filePath }).observe({ status:'degraded' }),
    /普通文件/,
  );
});

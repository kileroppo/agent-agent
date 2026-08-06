import fs from 'node:fs/promises';
import path from 'node:path';

// This hook exists only for an explicitly authorized local acceptance test.
// The in-memory form is useful for unit tests. The runtime form below persists
// consumption while the switch remains armed, so an automatic service restart
// cannot make a retry fail a second time.
export function createOneShotFailpoint(stage) {
  const target = String(stage || '').trim();
  let consumed = false;

  return (currentStage) => {
    if (!target || consumed || currentStage !== target) return;
    consumed = true;
    throw new Error(`受控测试：${currentStage} 阶段执行失败。`);
  };
}

export function createPersistentOneShotFailpoint(stage, markerPath) {
  const target = String(stage || '').trim();

  return async (currentStage) => {
    if (!target || currentStage !== target) return;
    try {
      await fs.mkdir(path.dirname(markerPath), { recursive:true });
      await fs.writeFile(markerPath, JSON.stringify({ stage:target, consumedAt:new Date().toISOString() }), { flag:'wx' });
    } catch (error) {
      if (error?.code === 'EEXIST') return;
      throw error;
    }
    throw new Error(`受控测试：${currentStage} 阶段执行失败。`);
  };
}

export async function resetPersistentOneShotFailpoint(markerPath) {
  await fs.rm(markerPath, { force:true });
}

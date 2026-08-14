import fs from 'node:fs/promises';
import path from 'node:path';

// This hook exists only for an explicitly authorized local acceptance test.
// The in-memory form is useful for unit tests. The runtime form below persists
// consumption while the switch remains armed, so an automatic service restart
// cannot make a retry fail a second time.
export function createOneShotFailpoint(stage: unknown): (currentStage: string) => void {
  const target = String(stage || '').trim();
  let consumed = false;

  return (currentStage: string) => {
    if (!target || consumed || currentStage !== target) return;
    consumed = true;
    throw new Error(`受控测试：${currentStage} 阶段执行失败。`);
  };
}

export function createPersistentOneShotFailpoint(
  stage: unknown,
  markerPath: string,
): (currentStage: string) => Promise<void> {
  const target = String(stage || '').trim();

  return async (currentStage: string) => {
    if (!target || currentStage !== target) return;
    try {
      await fs.mkdir(path.dirname(markerPath), { recursive:true });
      await fs.writeFile(markerPath, JSON.stringify({ stage:target, consumedAt:new Date().toISOString() }), { flag:'wx' });
    } catch (error: unknown) {
      if (errorCode(error) === 'EEXIST') return;
      throw error;
    }
    throw new Error(`受控测试：${currentStage} 阶段执行失败。`);
  };
}

export async function resetPersistentOneShotFailpoint(markerPath: string): Promise<void> {
  await fs.rm(markerPath, { force:true });
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error
    ? String(error.code || '')
    : '';
}

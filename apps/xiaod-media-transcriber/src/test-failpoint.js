// This hook exists only for an explicitly authorized local acceptance test.
// It is disabled by default and is intentionally process-local: restarting
// without the flag restores ordinary processing immediately.
export function createOneShotFailpoint(stage) {
  const target = String(stage || '').trim();
  let consumed = false;

  return (currentStage) => {
    if (!target || consumed || currentStage !== target) return;
    consumed = true;
    throw new Error(`受控测试：${currentStage} 阶段执行失败。`);
  };
}

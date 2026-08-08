export function canRefreshConsole({ page, accessGate, forms = [] } = {}) {
  if (!page || !accessGate || page.hidden || !accessGate.hidden) return false;
  return !forms.some((form) => form?.contains?.(page.activeElement));
}

export function startRefreshScheduler({
  refresh,
  canRefresh = () => true,
  intervalMs = 15_000,
  schedule = globalThis.setInterval,
  cancel = globalThis.clearInterval,
  visibilityTarget = globalThis.document,
} = {}) {
  if (typeof refresh !== 'function') throw new TypeError('refresh 必须是函数。');
  if (typeof canRefresh !== 'function') throw new TypeError('canRefresh 必须是函数。');
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new TypeError('intervalMs 必须是正数。');

  let stopped = false;
  let running = false;
  const refreshNow = async () => {
    if (stopped || running || !canRefresh()) return false;
    running = true;
    try {
      await refresh({ background:true });
      return true;
    } catch {
      return false;
    } finally {
      running = false;
    }
  };
  const onVisibilityChange = () => { void refreshNow(); };
  const timer = schedule(() => { void refreshNow(); }, intervalMs);
  visibilityTarget?.addEventListener?.('visibilitychange', onVisibilityChange);

  return Object.freeze({
    intervalMs,
    refreshNow,
    stop() {
      if (stopped) return;
      stopped = true;
      cancel(timer);
      visibilityTarget?.removeEventListener?.('visibilitychange', onVisibilityChange);
    },
  });
}

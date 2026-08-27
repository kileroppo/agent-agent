export function createDataLifecycleConsole({
  root,
  api,
  confirmAction = window.confirm.bind(window),
}: {
  root: HTMLElement | null;
  api: (path: string, options?: RequestInit) => Promise<Record<string, unknown>>;
  confirmAction?: (message: string) => boolean;
}) {
  if (!root) return { activate() {} };

  const taskCountEl = root.querySelector('#storage-tasks-count');
  const eventsCountEl = root.querySelector('#storage-events-count');
  const evalCountEl = root.querySelector('#storage-eval-count');
  const sizeEl = root.querySelector('#storage-size-bytes');
  const messageEl = root.querySelector('#storage-message');
  const ledgerEl = root.querySelector('#storage-ledger');
  const checkBtn = root.querySelector<HTMLButtonElement>('#storage-check');
  const reconcileBtn = root.querySelector<HTMLButtonElement>('#storage-reconcile');

  let loading = false;

  function fmtBytes(bytes: number): string {
    if (!bytes || bytes <= 0) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let val = bytes;
    while (val >= 1024 && i < u.length - 1) {
      val /= 1024;
      i++;
    }
    return `${val.toFixed(2)} ${u[i]}`;
  }

  async function loadStatus(updateMessage = true) {
    try {
      if (updateMessage && messageEl) messageEl.textContent = '正在读取全系统数据存储水位…';
      const data: Record<string, unknown> = await api('/api/data-lifecycle');
      const dl = (data?.dataLifecycle || {}) as Record<string, unknown>;

      if (taskCountEl) {
        const tasksCount = (dl.tasksCount || {}) as Record<string, number>;
        const total = tasksCount.tasks || 0;
        const routine = tasksCount.routineTasks || 0;
        taskCountEl.textContent = `${total} 项 (例行 ${routine})`;
      }
      if (eventsCountEl) {
        const ev = (dl.eventsCount || {}) as Record<string, unknown>;
        const byClass = (ev.byClass || {}) as Record<string, number>;
        const total = (ev.totalEvents as number) || 0;
        const transient = byClass.transient || 0;
        const detail = byClass.detail || 0;
        const audit = byClass.audit || 0;
        eventsCountEl.textContent = `${total} 条 (临时 ${transient} · 详情 ${detail} · 审计 ${audit})`;
      }
      if (evalCountEl) {
        evalCountEl.textContent = `${Number(dl.evalCasesCount || 0)} 个用例`;
      }
      if (sizeEl) {
        const dataSize = Number(dl.dataDirSizeBytes || 0);
        const wsSize = Number(dl.contentWorkspaceSizeBytes || 0);
        sizeEl.textContent = `${fmtBytes(dataSize + wsSize)} (数据 ${fmtBytes(dataSize)} · 工作区 ${fmtBytes(wsSize)})`;
      }
      if (updateMessage && messageEl) {
        messageEl.textContent = `水位核对正常（检查时间：${new Date(String(dl.inspectedAt || '')).toLocaleTimeString('zh-CN')}）`;
      }
    } catch (err: unknown) {
      if (updateMessage && messageEl) messageEl.textContent = `读取存储状态失败：${err instanceof Error ? err.message : String(err)}`;
    }
  }

  async function triggerReconcile(dryRun: boolean) {
    if (loading) return;
    if (!dryRun) {
      const ok = confirmAction('确认执行全系统数据安全清理？\n系统将按照分级留存策略物理清理过期例行任务、闲置会话、旧运行事件与超期媒体物料。活跃与非终态任务受到绝对保护。');
      if (!ok) return;
    }

    loading = true;
    if (checkBtn) checkBtn.disabled = true;
    if (reconcileBtn) reconcileBtn.disabled = true;
    if (messageEl) messageEl.textContent = dryRun ? '正在扫描全系统超期数据（Dry-Run）…' : '正在执行全系统安全清理…';

    try {
      const res = (await api(`/api/data-lifecycle/reconcile?dryRun=${dryRun ? 'true' : 'false'}`, {
        method: 'POST',
      })) as Record<string, unknown>;
      const result = (res?.result || {}) as Record<string, unknown>;
      const tasksPruned = (result.tasksPruned || {}) as Record<string, unknown>;
      const del = (tasksPruned.deleted || tasksPruned.expiring || {}) as Record<string, number>;
      const eventsCleaned = (result.eventsCleaned || {}) as Record<string, number>;
      const artifactsCleaned = (result.artifactsCleaned || {}) as Record<string, number>;

      if (ledgerEl) {
        ledgerEl.innerHTML = `
          <div class="storage-ledger-summary">
            <p><strong>模式：</strong>${dryRun ? '只读预览 (Dry-Run)' : '物理清理 (Apply)'}</p>
            <p><strong>任务清理：</strong>例行 ${del.routineTasks || 0} · 终态 ${del.terminalTasks || 0} · 会话 ${del.conversationContexts || 0}</p>
            <p><strong>事件清理：</strong>${eventsCleaned.deletedEvents || eventsCleaned.expiringEvents || 0} 条 (事故摘要: ${eventsCleaned.incidentSummariesCreated || 0})</p>
            <p><strong>物料释放：</strong>${artifactsCleaned.cleanedFilesCount || 0} 个文件 · ${fmtBytes(artifactsCleaned.cleanedBytes || 0)}</p>
          </div>
        `;
      }
      if (!dryRun) {
        await loadStatus(false);
      }
      if (messageEl) {
        messageEl.textContent = dryRun
          ? `扫描完成：预计可清理 ${Number(result.totalReclaimedItems || 0)} 项超期记录，释放空间 ${fmtBytes(Number(result.totalReclaimedBytes || 0))}`
          : `清理完成：已安全清理 ${Number(result.totalReclaimedItems || 0)} 项记录，释放空间 ${fmtBytes(Number(result.totalReclaimedBytes || 0))}`;
      }
    } catch (err: unknown) {
      if (messageEl) messageEl.textContent = `执行失败：${err instanceof Error ? err.message : String(err)}`;
    } finally {
      loading = false;
      if (checkBtn) checkBtn.disabled = false;
      if (reconcileBtn) reconcileBtn.disabled = false;
    }
  }

  checkBtn?.addEventListener('click', () => triggerReconcile(true));
  reconcileBtn?.addEventListener('click', () => triggerReconcile(false));

  return {
    activate() {
      void loadStatus();
    },
  };
}

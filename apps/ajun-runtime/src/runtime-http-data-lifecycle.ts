import type { IncomingMessage } from 'node:http';
import type { DataLifecycleGovernanceReconciler } from './data-lifecycle-governance.ts';

export async function routeDataLifecycleApi({
  request,
  dataLifecycleGovernance,
  local,
  readBody = async () => ({}),
}: {
  request: IncomingMessage;
  dataLifecycleGovernance?: DataLifecycleGovernanceReconciler;
  local: boolean;
  readBody?: () => Promise<Record<string, unknown>>;
}): Promise<{ status: number; payload: Record<string, unknown> } | null> {
  const url = request.url ? new URL(request.url, 'http://127.0.0.1') : null;
  if (!url || !url.pathname.startsWith('/api/data-lifecycle')) {
    return null;
  }

  if (request.method === 'GET' && url.pathname === '/api/data-lifecycle') {
    if (!dataLifecycleGovernance) {
      return { status: 503, payload: { error: '数据闭环治理模块尚未就绪。' } };
    }
    const status = await dataLifecycleGovernance.inspectStorageStatus();
    return { status: 200, payload: { ok: true, dataLifecycle: status } };
  }

  if (request.method === 'POST' && url.pathname === '/api/data-lifecycle/reconcile') {
    if (!local) {
      return { status: 403, payload: { error: '数据闭环清理指令只能在本机执行。' } };
    }
    if (!dataLifecycleGovernance) {
      return { status: 503, payload: { error: '数据闭环治理模块尚未就绪。' } };
    }

    const body = await readBody().catch(() => ({}));
    const dryRun = url.searchParams.get('dryRun') === 'true' || body?.dryRun === true;
    const result = await dataLifecycleGovernance.runFullClosedLoop({ dryRun });
    return { status: 200, payload: { ok: true, result } };
  }

  return null;
}

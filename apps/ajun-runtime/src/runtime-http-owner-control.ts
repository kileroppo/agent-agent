import { deleteReleaseSnapshot, listReleaseSnapshots, readXiaodLiveReleaseHash, releaseProtectionMap } from './runtime-release-inventory.ts';

export async function routeOwnerControlApi({
  request,
  ownerActionSession,
  runtimeRelease,
  development,
  local,
  hasConsoleProof,
  readBody,
}: any) {
  if (request.method === 'GET' && request.url === '/api/dev/hot-reload') {
    if (!development.hotReload?.enabled) return { status:200, payload:{ enabled:false } };
    if (!local) return denied(403, '开发热更新只能在本机使用。');
    return { status:200, payload:{ enabled:true, revision:development.hotReload.revision } };
  }
  if (request.method === 'GET' && request.url === '/api/owner-action-session') {
    return local
      ? { status:200, payload:ownerActionSession.issue() }
      : denied(403, '本机动作会话只能由老板在这台设备上获取。');
  }
  if (request.method === 'GET' && request.url === '/api/runtime-release/status') {
    if (!local) return denied(403, '版本管理只能由老板在本机查看。');
    if (!runtimeRelease) return denied(503, '发布助手尚未接入。');
    return { status:200, payload:{ status:await runtimeRelease.status() } };
  }
  if (request.method === 'GET' && request.url === '/api/runtime-release/listing') {
    if (!local) return denied(403, '版本库只能由老板在本机查看。');
    let helperStatus:any = null;
    if (runtimeRelease) {
      try { helperStatus = await runtimeRelease.status(); } catch { helperStatus = null; }
    }
    const xiaodReleaseHash = await readXiaodLiveReleaseHash();
    const protectedHashes = releaseProtectionMap(helperStatus, xiaodReleaseHash);
    return { status:200, payload:{
      releases:await listReleaseSnapshots(protectedHashes, 'ajun'),
      helperOnline:Boolean(helperStatus),
      components:{ xiaod:{ releaseHash:xiaodReleaseHash, protected:Boolean(xiaodReleaseHash) } },
    } };
  }
  if (request.method === 'POST' && request.url === '/api/runtime-release/delete') {
    if (!local) return denied(403, '版本库只能由老板在本机操作。');
    if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      return denied(415, '版本操作必须使用 application/json。');
    }
    if (!hasConsoleProof) return denied(403, '版本操作必须来自当前 A君 控制台。');
    if (!ownerActionSession.authorize(request.headers['x-ajun-owner-action'])) {
      return denied(403, '本机动作会话无效或已过期，请重新打开版本管理。');
    }
    const body:any = await readBody();
    if (body?.confirm !== 'delete_release_snapshot') return denied(400, '请确认要删除该版本快照。');
    if (!runtimeRelease) return denied(503, '发布助手尚未接入，无法确认运行中版本，已阻止删除。');
    let helperStatus:any;
    try { helperStatus = await runtimeRelease.status(); } catch { return denied(503, '无法核对运行中版本，已阻止删除。'); }
    const protectedHashes = releaseProtectionMap(helperStatus, await readXiaodLiveReleaseHash());
    try {
      const removed = await deleteReleaseSnapshot(String(body.releaseHash || ''), protectedHashes, 'ajun');
      return { status:200, payload:{ deleted:removed } };
    } catch (error:any) {
      return denied(400, error?.message || '删除失败。');
    }
  }
  const action = request.url?.match(/^\/api\/runtime-release\/(check|publish|rollback)$/)?.[1];
  if (request.method !== 'POST' || !action) return null;
  if (!local) return denied(403, '版本管理只能由老板在本机操作。');
  if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    return denied(415, '版本操作必须使用 application/json。');
  }
  if (!hasConsoleProof) return denied(403, '版本操作必须来自当前 A君 控制台。');
  if (!ownerActionSession.authorize(request.headers['x-ajun-owner-action'])) {
    return denied(403, '本机动作会话无效或已过期，请重新打开版本管理。');
  }
  if (!runtimeRelease) return denied(503, '发布助手尚未接入。');
  return { status:202, payload:await runtimeRelease.action(action, await readBody()) };
}

export function hasSameOriginRequest(request: any): boolean {
  const origin = String(request.headers.origin || '').trim();
  const host = String(request.headers.host || '').trim();
  if (!host) return false;
  const scheme = request.socket.encrypted ? 'https' : 'http';
  const expectedOrigin = `${scheme}://${host}`;
  if (origin) return origin === expectedOrigin;
  const referer = String(request.headers.referer || '').trim();
  if (referer) {
    try {
      return new URL(referer).origin === expectedOrigin;
    } catch {
      return false;
    }
  }
  return String(request.headers['sec-fetch-site'] || '').toLowerCase() === 'same-origin';
}

function denied(status: number, error: string) {
  return { status, payload:{ error } };
}

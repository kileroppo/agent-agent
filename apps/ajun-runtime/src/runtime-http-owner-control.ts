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

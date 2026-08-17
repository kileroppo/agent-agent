export async function routeWorkflowAcceptanceApi({
  request,
  tasks,
  local,
  sameOrigin,
  authorize,
  readBody,
}: any) {
  if (request.method !== 'POST') return null;
  const match = request.url?.match(/^\/api\/workflows\/([^/?#]+)\/acceptance$/);
  if (!match) return null;
  if (!local) return denied(403, '工作验收只能由老板在本机操作。');
  if (!isJson(request)) return denied(415, '工作验收请求必须使用 application/json。');
  if (!sameOrigin) return denied(403, '工作验收请求必须来自当前 A君 控制台。');
  if (!authorize) return denied(403, '本机动作会话无效或已过期，请刷新任务详情后重试。');

  const idempotencyKey = singleHeader(request.headers['idempotency-key']);
  if (!idempotencyKey) return denied(422, '缺少本次操作编号，请刷新任务详情后重试。');
  if (idempotencyKey.length > 200) return denied(422, '本次操作编号无效，请刷新任务详情后重试。');
  const input = await readBody();
  if (!Number.isSafeInteger(input?.expectedRevision) || input.expectedRevision < 0) {
    return denied(422, '验收版本号无效，请刷新任务详情后重试。');
  }
  if (typeof tasks?.recordWorkflowAcceptance !== 'function') {
    return denied(503, '工作验收入口尚未就绪，请稍后重试。');
  }
  let workflowId: string;
  try {
    workflowId = decodeURIComponent(match[1]);
  } catch {
    return denied(422, '工作编号无效，请刷新任务详情后重试。');
  }
  const result = await tasks.recordWorkflowAcceptance(workflowId, {
    decision:input.decision,
    note:input.note,
    expectedVersion:input.expectedRevision,
    idempotencyKey,
    source:'local_console',
  });
  return { status:200, payload:result };
}

export function workflowAcceptanceErrorStatus(error: any): number | null {
  const code = String(error?.code || '');
  if (!code.startsWith('workflow_acceptance_')) return null;
  return code.endsWith('_conflict') ? 409 : 422;
}

function isJson(request: any) {
  return String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json');
}

function singleHeader(value: unknown): string {
  if (Array.isArray(value)) return '';
  return String(value || '').trim();
}

function denied(status: number, error: string) {
  return { status, payload:{ error } };
}

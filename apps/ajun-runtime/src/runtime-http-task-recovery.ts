export async function routeTaskRecoveryApi({
  request,
  tasks,
  local,
  sameOrigin,
  authorize,
  readBody,
}: any) {
  if (request.method !== 'POST') return null;
  const match = request.url?.match(/^\/api\/tasks\/([0-9a-f-]+)\/recovery-actions\/(resume_approved_mission|use_confirmed_transcript_only|request_safe_recovery|request_read_only_diagnosis|retry_visual_analysis_after_recovery|accept_reviewed_artifact)$/i);
  if (!match) return null;
  if (!local) return denied(403, '任务恢复只能由老板在本机发起。');
  if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    return denied(415, '任务恢复请求必须使用 application/json。');
  }
  if (!sameOrigin) return denied(403, '任务恢复请求必须来自当前 A君 控制台。');
  if (!authorize) return denied(403, '本机动作会话无效或已过期，请刷新任务详情后重试。');
  const input = await readBody();
  const result = await tasks.requestRecovery(match[1], {
    actionKey:match[2],
    expectedUpdatedAt:input.expectedUpdatedAt,
    requestId:String(request.headers['idempotency-key'] || '').trim(),
  }, { kind:'local-owner', ref:'A君' });
  return { status:result.status === 'accepted' ? 202 : 200, payload:result };
}

function denied(status: number, error: string) {
  return { status, payload:{ error } };
}

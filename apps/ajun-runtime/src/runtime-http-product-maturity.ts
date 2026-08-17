import { productMaturityDisabledState } from './runtime/product-maturity-runtime-boundary.ts';

export async function routeProductMaturityApi({
  request,
  service,
  local,
  sameOrigin,
  authorize,
  readBody,
}: any) {
  const create = request.method === 'POST'
    && request.url === '/api/product-maturity/validation-batches';
  const decision = request.method === 'POST'
    ? request.url?.match(/^\/api\/product-maturity\/validation-batches\/(maturity-[0-9a-f-]{36})\/decision$/i)
    : null;
  if (!create && !decision) return null;

  const label = create ? '产品成熟度验证批次' : '产品成熟度统一验收';
  const denied = validateOwnerJsonAction({ request, local, sameOrigin, authorize, label });
  if (denied) return { status:denied.status, payload:{ error:denied.error } };
  if (!service) return { status:503, payload:productMaturityDisabledState() };
  const input = await readBody();
  return create
    ? { status:202, payload:await service.create() }
    : { status:200, payload:await service.decide(decision[1], input) };
}

function validateOwnerJsonAction({ request, local, sameOrigin, authorize, label }: any) {
  if (!local) return { status:403, error:`${label}只能由老板在本机发起。` };
  if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return { status:415, error:`${label}请求必须使用 application/json。` };
  if (!sameOrigin) return { status:403, error:`${label}请求必须来自当前 A君 控制台。` };
  if (!authorize) return { status:403, error:'本机动作会话无效或已过期，请刷新后重试。' };
  return null;
}

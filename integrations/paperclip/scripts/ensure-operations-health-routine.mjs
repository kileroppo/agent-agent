#!/usr/bin/env node

const BASE_URL = 'http://127.0.0.1:3100';
const COMPANY_NAME = 'Agent军团';
const ROUTINE_TITLE = 'A君定时本机巡检';
const ROUTINE_MARKER = 'agent-army:operations-health-v1';
const TRIGGER_LABEL = '每半小时巡检一次';
const CRON = '*/30 * * * *';
const TIMEZONE = 'Asia/Shanghai';

export async function ensureOperationsHealthRoutine({ fetchImpl = fetch } = {}) {
  const request = async (pathname, options = {}) => {
    const response = await fetchImpl(`${BASE_URL}${pathname}`, {
      method:options.method || 'GET', headers:options.body ? { 'content-type':'application/json' } : undefined,
      body:options.body ? JSON.stringify(options.body) : undefined
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Paperclip 返回 ${response.status}`);
    return payload;
  };

  const companies = await request('/api/companies');
  const company = asList(companies).find((item) => item.name === COMPANY_NAME);
  if (!company) throw new Error('Paperclip 中未找到 Agent军团。');
  const agents = await request(`/api/companies/${company.id}/agents`);
  const operator = asList(agents).find((agent) => agent.name === 'A君本机健康官' && agent.adapterType === 'http' && agent.status !== 'terminated');
  if (!operator) throw new Error('Paperclip 中未找到可用的 A君本机健康官。');

  const routines = await request(`/api/companies/${company.id}/routines`);
  let routine = asList(routines).find((item) => item.title === ROUTINE_TITLE || String(item.description || '').includes(ROUTINE_MARKER));
  const routineBody = {
    title:ROUTINE_TITLE,
    description:`${ROUTINE_MARKER}\n只检查 A君、小D 与 Paperclip 的本机运行状态；不登录、不外发、不修改业务数据。异常只留下可追踪的健康结果，由既有恢复流程决定后续处理。`,
    assigneeAgentId:operator.id,
    priority:'low', status:'active', concurrencyPolicy:'skip_if_active', catchUpPolicy:'skip_missed'
  };
  const created = !routine;
  routine = routine
    ? await request(`/api/routines/${encodeURIComponent(routine.id)}`, { method:'PATCH', body:routineBody })
    : await request(`/api/companies/${company.id}/routines`, { method:'POST', body:routineBody });

  const detailed = Array.isArray(routine.triggers) ? routine : await request(`/api/routines/${encodeURIComponent(routine.id)}`);
  const triggers = Array.isArray(detailed.triggers) ? detailed.triggers : [];
  let trigger = triggers.find((item) => item.kind === 'schedule' && (item.label === TRIGGER_LABEL || item.cronExpression === CRON));
  const triggerBody = { label:TRIGGER_LABEL, enabled:true, cronExpression:CRON, timezone:TIMEZONE };
  const triggerCreated = !trigger;
  trigger = trigger
    ? await request(`/api/routine-triggers/${encodeURIComponent(trigger.id)}`, { method:'PATCH', body:triggerBody })
    : await request(`/api/routines/${encodeURIComponent(routine.id)}/triggers`, { method:'POST', body:{ kind:'schedule', ...triggerBody } });

  return { created, triggerCreated, routine:{ id:routine.id, title:routine.title || ROUTINE_TITLE, status:routine.status || 'active' }, trigger:{ id:trigger.id, cronExpression:trigger.cronExpression || CRON, timezone:trigger.timezone || TIMEZONE } };
}

function asList(value) { return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : []; }

if (import.meta.url === `file://${process.argv[1]}`) {
  ensureOperationsHealthRoutine()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}

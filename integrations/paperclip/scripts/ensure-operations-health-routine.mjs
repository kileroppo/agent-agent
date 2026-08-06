#!/usr/bin/env node

const BASE_URL = 'http://127.0.0.1:3100';
const COMPANY_NAME = 'Agent军团';
const ROUTINE_TITLE = 'A君定时本机巡检';
const ROUTINE_MARKER = 'agent-army:operations-health-v2';
const ROUTINE_CONTRACT_MARKER = '[agent-army:operations-health:routine]';
const CONTROLLER_ROLE = 'operations-health-controller';
const CONTROLLER_URL = 'http://127.0.0.1:4321/api/paperclip/heartbeat';
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
  const controllerBody = {
    name:'本机健康确定性控制器',
    role:'devops',
    title:'每半小时执行登记服务的无模型只读健康检查',
    icon:'radar',
    capabilities:'无模型、无自由参数；只读检查登记的本机健康接口，异常时才派发运维事故。',
    adapterType:'http',
    adapterConfig:{ url:CONTROLLER_URL },
    budgetMonthlyCents:0,
    permissions:{ canCreateAgents:false, canCreateSkills:false, canAssignTasks:false },
    metadata:{
      agentArmySystemRole:CONTROLLER_ROLE,
      agentArmyManagedOnly:false,
      executionOwner:'ajun-runtime-deterministic',
    },
  };
  const matchingControllers = asList(agents).filter((agent) =>
    agent.status !== 'terminated' && agent.metadata?.agentArmySystemRole === CONTROLLER_ROLE
  );
  if (matchingControllers.length > 1) throw new Error(`Paperclip 本机健康控制器必须唯一，当前为 ${matchingControllers.length} 个。`);
  const controllerCreated = matchingControllers.length === 0;
  let controller = matchingControllers[0] || await request(`/api/companies/${company.id}/agents`, { method:'POST', body:controllerBody });
  if (controllerCreated || controllerNeedsUpdate(controller, controllerBody)) {
    controller = await request(`/api/agents/${encodeURIComponent(controller.id)}`, {
      method:'PATCH',
      body:{
        ...(controllerCreated ? {} : controllerBody),
        status:'idle',
      },
    });
  }

  const routines = await request(`/api/companies/${company.id}/routines`);
  let routine = asList(routines).find((item) => item.title === ROUTINE_TITLE || /agent-army:operations-health-v\d+/.test(String(item.description || '')));
  const routineBody = {
    title:ROUTINE_TITLE,
    description:`${ROUTINE_MARKER}\n${ROUTINE_CONTRACT_MARKER}\n由无模型 HTTP 控制器只读检查 A君、小D 与 Paperclip 的本机运行状态；正常时不调用任何大模型。只有发现异常时才幂等派发运维事故；不登录、不外发、不修改业务数据。`,
    assigneeAgentId:controller.id,
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

  return {
    controller:{ id:controller.id, created:controllerCreated, adapterType:'http', url:CONTROLLER_URL },
    created,
    triggerCreated,
    routine:{ id:routine.id, title:routine.title || ROUTINE_TITLE, status:routine.status || 'active' },
    trigger:{ id:trigger.id, cronExpression:trigger.cronExpression || CRON, timezone:trigger.timezone || TIMEZONE },
  };
}

function asList(value) { return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : []; }

function controllerNeedsUpdate(current, desired) {
  return current.status !== 'idle'
    || current.adapterType !== desired.adapterType
    || current.adapterConfig?.url !== desired.adapterConfig.url
    || current.metadata?.executionOwner !== desired.metadata.executionOwner;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ensureOperationsHealthRoutine()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}

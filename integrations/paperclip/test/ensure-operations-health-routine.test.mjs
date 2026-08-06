import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureOperationsHealthRoutine } from '../scripts/ensure-operations-health-routine.mjs';

function response(body, ok = true, status = ok ? 200 : 500) { return { ok, status, async json() { return body; } }; }

test('为本机巡检建立无模型 HTTP 控制器和可重复执行的安排', async () => {
  const calls = [];
  const result = await ensureOperationsHealthRoutine({ fetchImpl: async (url, options = {}) => {
    const path = new URL(url).pathname; const body = options.body ? JSON.parse(options.body) : null; calls.push({ path, method:options.method || 'GET', body });
    if (path === '/api/companies') return response([{ id:'company-1', name:'Agent军团' }]);
    if (path === '/api/companies/company-1/agents' && options.method === 'GET') return response([{ id:'agent-1', name:'运维官', adapterType:'hermes_local', status:'idle', metadata:{ agentArmyId:'operator' } }]);
    if (path === '/api/companies/company-1/agents' && options.method === 'POST') return response({ id:'controller-1', ...body });
    if (path === '/api/agents/controller-1') return response({ id:'controller-1', ...body });
    if (path === '/api/companies/company-1/routines') return options.method === 'POST' ? response({ id:'routine-1', title:body.title, status:'active' }) : response([]);
    if (path === '/api/routines/routine-1') return response({ id:'routine-1', title:'A君定时本机巡检', status:'active', triggers:[] });
    if (path === '/api/routines/routine-1/triggers') return response({ id:'trigger-1', kind:'schedule', cronExpression:body.cronExpression, timezone:body.timezone });
    throw new Error(`unexpected ${options.method || 'GET'} ${path}`);
  } });
  assert.equal(result.created, true);
  assert.equal(result.triggerCreated, true);
  const controller = calls.find((item) => item.path === '/api/companies/company-1/agents' && item.method === 'POST');
  assert.equal(controller.body.adapterType, 'http');
  assert.deepEqual(controller.body.adapterConfig, { url:'http://127.0.0.1:4321/api/paperclip/heartbeat' });
  assert.equal(controller.body.metadata.agentArmySystemRole, 'operations-health-controller');
  const created = calls.find((item) => item.path === '/api/companies/company-1/routines' && item.method === 'POST');
  assert.deepEqual(created.body, {
    title:'A君定时本机巡检',
    description:'agent-army:operations-health-v2\n[agent-army:operations-health:routine]\n由无模型 HTTP 控制器只读检查 A君、小D 与 Paperclip 的本机运行状态；正常时不调用任何大模型。只有发现异常时才幂等派发运维事故；不登录、不外发、不修改业务数据。',
    assigneeAgentId:'controller-1', priority:'low', status:'active', concurrencyPolicy:'skip_if_active', catchUpPolicy:'skip_missed'
  });
  assert.equal(calls.find((item) => item.path === '/api/routines/routine-1/triggers').body.cronExpression, '*/30 * * * *');
});

test('已有巡检安排和控制器时只校正时间与绑定，不重复创建', async () => {
  const calls = [];
  const result = await ensureOperationsHealthRoutine({ fetchImpl: async (url, options = {}) => {
    const path = new URL(url).pathname; const body = options.body ? JSON.parse(options.body) : null; calls.push({ path, method:options.method || 'GET', body });
    if (path === '/api/companies') return response([{ id:'company-1', name:'Agent军团' }]);
    if (path === '/api/companies/company-1/agents' && options.method === 'GET') return response([{ id:'controller-1', name:'本机健康确定性控制器', adapterType:'http', status:'idle', adapterConfig:{ url:'http://127.0.0.1:4321/api/paperclip/heartbeat' }, metadata:{ agentArmySystemRole:'operations-health-controller' } }]);
    if (path === '/api/agents/controller-1') return response({ id:'controller-1', ...body });
    if (path === '/api/companies/company-1/routines') return response([{ id:'routine-1', title:'A君定时本机巡检', status:'paused', triggers:[{ id:'trigger-1', kind:'schedule', label:'每半小时巡检一次', cronExpression:'0 9 * * *' }] }]);
    if (path === '/api/routines/routine-1') return response({ id:'routine-1', title:'A君定时本机巡检', status:'active', triggers:[{ id:'trigger-1', kind:'schedule', label:'每半小时巡检一次', cronExpression:'0 9 * * *' }] });
    if (path === '/api/routine-triggers/trigger-1') return response({ id:'trigger-1', kind:'schedule', cronExpression:body.cronExpression, timezone:body.timezone });
    throw new Error(`unexpected ${options.method || 'GET'} ${path}`);
  } });
  assert.equal(result.created, false);
  assert.equal(result.triggerCreated, false);
  assert.equal(calls.some((item) => item.path === '/api/companies/company-1/routines' && item.method === 'POST'), false);
  assert.equal(calls.some((item) => item.path === '/api/companies/company-1/agents' && item.method === 'POST'), false);
  assert.equal(calls.some((item) => item.path === '/api/routines/routine-1' && item.method === 'PATCH'), true);
  assert.equal(calls.find((item) => item.path === '/api/routine-triggers/trigger-1').body.cronExpression, '*/30 * * * *');
});

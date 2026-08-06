import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpPaperclipAdapter } from '../src/index.js';

const companyId = '00000000-0000-4000-8000-000000000001';
const pipelineId = '00000000-0000-4000-8000-000000000002';
const routineId = '00000000-0000-4000-8000-000000000003';
const caseId = '00000000-0000-4000-8000-000000000004';

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function recordingFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const call = {
      url: new URL(url).pathname,
      method: init.method,
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const handler = routes[`${call.method} ${call.url}`];
    if (!handler) return response({ error: 'unexpected route' }, 404);
    return response(typeof handler === 'function' ? handler(call) : handler);
  };
  return { calls, fetchImpl };
}

test('Http adapter路径与2026.722 Goal/Project/Routine/Pipeline/Budget API一致', async () => {
  const recorder = recordingFetch({
    [`GET /api/companies/${companyId}/goals`]: [],
    [`POST /api/companies/${companyId}/goals`]: { id: 'goal-id' },
    [`POST /api/companies/${companyId}/projects`]: { id: 'project-id' },
    [`POST /api/companies/${companyId}/routines`]: { id: routineId },
    [`POST /api/companies/${companyId}/pipelines`]: { id: pipelineId, stages: [] },
    [`POST /api/companies/${companyId}/budgets/policies`]: { policy: { id: 'budget-id' } },
  });
  const adapter = new HttpPaperclipAdapter({
    apiBase: 'http://127.0.0.1:3100',
    companyId,
    fetchImpl: recorder.fetchImpl,
  });
  await adapter.findByMarker('goal', '[marker]');
  await adapter.create('goal', { title: 'Goal' });
  await adapter.create('project', { name: 'Project' });
  await adapter.create('routine', { title: 'Routine' });
  await adapter.create('pipeline', { key: 'm5', name: 'M5' });
  const budget = await adapter.upsertBudget({ scopeType: 'project', scopeId: pipelineId, amount: 625 });

  assert.equal(budget.id, 'budget-id');
  assert.deepEqual(recorder.calls.map((call) => `${call.method} ${call.url}`), [
    `GET /api/companies/${companyId}/goals`,
    `POST /api/companies/${companyId}/goals`,
    `POST /api/companies/${companyId}/projects`,
    `POST /api/companies/${companyId}/routines`,
    `POST /api/companies/${companyId}/pipelines`,
    `POST /api/companies/${companyId}/budgets/policies`,
  ]);
});

test('Http adapter 创建并幂等对账无模型 M5 每日系统控制器', async () => {
  const controllerId = '00000000-0000-4000-8000-000000000009';
  const payload = {
    name:'M5 每日确定性控制器',
    role:'devops',
    title:'固定入口',
    icon:'cog',
    capabilities:'无模型',
    adapterType:'http',
    adapterConfig:{ url:'http://127.0.0.1:4321/api/paperclip/m5-daily-heartbeat' },
    budgetMonthlyCents:0,
    permissions:{ canCreateAgents:false, canCreateSkills:false, canAssignTasks:false },
    metadata:{
      agentArmySystemRole:'m5-daily-controller',
      agentArmyManagedOnly:false,
      executionOwner:'ajun-runtime-deterministic',
    },
  };
  const recorder = recordingFetch({
    [`GET /api/companies/${companyId}/agents`]: [],
    [`POST /api/companies/${companyId}/agents`]: { id:controllerId, ...payload, status:'paused' },
    [`PATCH /api/agents/${controllerId}`]: { id:controllerId, ...payload, status:'idle' },
  });
  const adapter = new HttpPaperclipAdapter({
    apiBase:'http://127.0.0.1:3100',
    companyId,
    fetchImpl:recorder.fetchImpl,
  });

  const result = await adapter.ensureSystemAgent(payload);
  assert.equal(result.created, true);
  assert.equal(result.resource.status, 'idle');
  assert.deepEqual(recorder.calls.map((call) => `${call.method} ${call.url}`), [
    `GET /api/companies/${companyId}/agents`,
    `POST /api/companies/${companyId}/agents`,
    `PATCH /api/agents/${controllerId}`,
  ]);
});

test('Http adapter 对系统控制器做结构比较，权限键顺序不同不会触发无效PATCH', async () => {
  const controllerId = '00000000-0000-4000-8000-000000000009';
  const payload = {
    name:'M5 每日确定性控制器',
    role:'devops',
    title:'固定入口',
    icon:'cog',
    capabilities:'无模型',
    adapterType:'http',
    adapterConfig:{ url:'http://127.0.0.1:4321/api/paperclip/m5-daily-heartbeat' },
    budgetMonthlyCents:0,
    permissions:{ canCreateAgents:false, canCreateSkills:false, canAssignTasks:false },
    metadata:{
      agentArmySystemRole:'m5-daily-controller',
      agentArmyManagedOnly:false,
      executionOwner:'ajun-runtime-deterministic',
    },
  };
  const recorder = recordingFetch({
    [`GET /api/companies/${companyId}/agents`]: [{
      id:controllerId,
      ...payload,
      permissions:{ canAssignTasks:false, canCreateSkills:false, canCreateAgents:false },
      status:'idle',
    }],
  });
  const adapter = new HttpPaperclipAdapter({
    apiBase:'http://127.0.0.1:3100',
    companyId,
    fetchImpl:recorder.fetchImpl,
  });

  const result = await adapter.ensureSystemAgent(payload);
  assert.equal(result.updated, false);
  assert.deepEqual(recorder.calls.map((call) => `${call.method} ${call.url}`), [
    `GET /api/companies/${companyId}/agents`,
  ]);
});

test('Http adapter 使用专用权限端点修复系统控制器权限，不把permissions塞进Agent PATCH', async () => {
  const controllerId = '00000000-0000-4000-8000-000000000009';
  const payload = {
    name:'M5 每日确定性控制器',
    role:'devops',
    title:'固定入口',
    icon:'cog',
    capabilities:'无模型',
    adapterType:'http',
    adapterConfig:{ url:'http://127.0.0.1:4321/api/paperclip/m5-daily-heartbeat' },
    budgetMonthlyCents:0,
    permissions:{ canCreateAgents:false, canCreateSkills:false, canAssignTasks:false },
    metadata:{
      agentArmySystemRole:'m5-daily-controller',
      agentArmyManagedOnly:false,
      executionOwner:'ajun-runtime-deterministic',
    },
  };
  const current = {
    id:controllerId,
    ...payload,
    permissions:{ canCreateAgents:true, canCreateSkills:false, canAssignTasks:false },
    status:'idle',
  };
  const recorder = recordingFetch({
    [`GET /api/companies/${companyId}/agents`]: [current],
    [`PATCH /api/agents/${controllerId}/permissions`]: (call) => ({
      ...current,
      permissions:call.body,
    }),
  });
  const adapter = new HttpPaperclipAdapter({
    apiBase:'http://127.0.0.1:3100',
    companyId,
    fetchImpl:recorder.fetchImpl,
  });

  const result = await adapter.ensureSystemAgent(payload);
  assert.equal(result.updated, true);
  assert.deepEqual(recorder.calls.map((call) => `${call.method} ${call.url}`), [
    `GET /api/companies/${companyId}/agents`,
    `PATCH /api/agents/${controllerId}/permissions`,
  ]);
});

test('Http adapter 复用真实Paperclip系统控制器时保留name和派生urlKey，避免shortname冲突', async () => {
  const controllerId = '3a4883ae-11c2-4bed-a2f3-5cfc269501b6';
  const payload = {
    name:'复盘确定性控制器 M5 Retrospective',
    role:'researcher',
    title:'新版复盘入口',
    icon:'brain',
    capabilities:'无模型',
    adapterType:'http',
    adapterConfig:{ url:'http://127.0.0.1:4321/api/paperclip/m5-retrospective-heartbeat' },
    budgetMonthlyCents:0,
    permissions:{ canCreateAgents:false, canCreateSkills:false, canAssignTasks:false },
    metadata:{
      agentArmySystemRole:'m5-retrospective-controller',
      agentArmyManagedOnly:false,
      executionOwner:'ajun-runtime-deterministic',
    },
  };
  let stored = {
    id:controllerId,
    urlKey:'m5-2',
    ...payload,
    name:'M5 确定性复盘控制器 2',
    title:'旧版复盘入口',
    status:'idle',
  };
  const recorder = recordingFetch({
    [`GET /api/companies/${companyId}/agents`]: () => [
      {
        id:'7fab77e8-ec22-481f-af0b-a16a25226b1e',
        name:'M5 每日确定性控制器',
        urlKey:'m5',
        status:'idle',
        metadata:{ agentArmySystemRole:'m5-daily-controller' },
      },
      stored,
    ],
    [`PATCH /api/agents/${controllerId}`]: (call) => {
      assert.equal(Object.hasOwn(call.body, 'name'), false);
      assert.equal(Object.hasOwn(call.body, 'urlKey'), false);
      assert.equal(Object.hasOwn(call.body, 'shortname'), false);
      stored = {
        ...stored,
        ...call.body,
        name:stored.name,
        urlKey:stored.urlKey,
      };
      return stored;
    },
  });
  const adapter = new HttpPaperclipAdapter({
    apiBase:'http://127.0.0.1:3100',
    companyId,
    fetchImpl:recorder.fetchImpl,
  });

  const result = await adapter.ensureSystemAgent(payload);
  const repeated = await adapter.ensureSystemAgent(payload);

  assert.equal(result.updated, true);
  assert.equal(result.resource.name, 'M5 确定性复盘控制器 2');
  assert.equal(result.resource.urlKey, 'm5-2');
  assert.equal(repeated.updated, false);
  assert.equal(repeated.resource.name, 'M5 确定性复盘控制器 2');
  assert.equal(repeated.resource.urlKey, 'm5-2');
  assert.deepEqual(recorder.calls.map((call) => `${call.method} ${call.url}`), [
    `GET /api/companies/${companyId}/agents`,
    `PATCH /api/agents/${controllerId}`,
    `GET /api/companies/${companyId}/agents`,
  ]);
});

test('Http adapter 用完整默认岗位修复Paperclip归一化的paused Routine，随后真实详情重放零PATCH', async () => {
  const assigneeAgentId = '600be7e0-9ea4-4ba3-9815-c11b8f0876cc';
  const revisionId = 'c45f195e-5a34-4241-b70a-c466295e03f9';
  const routinePayload = {
    projectId:'86ad0a0a-02c5-46ec-99b1-1131605d4a15',
    goalId:'0363da03-091e-4987-835c-066dcd8f8491',
    title:'M5 / 并行证据包',
    description:'[agent-army:m5:routine:m5-evidence] [agent-army:m5:deployment:m5-ai-agent-content-v2:routine:m5-evidence] 只处理并行工作分支；当前 Case 为 {{case_id}}，版本为 {{case_version}}；完成来源核验并写回 EvidencePackage。 不发布、不安装技能、不读取登录态。',
    assigneeAgentId,
    priority:'medium',
    status:'active',
    concurrencyPolicy:'skip_if_active',
    catchUpPolicy:'skip_missed',
    variables:[
      {
        name:'case_id',
        type:'text',
        label:'Pipeline Case ID',
        options:[],
        required:true,
      },
      {
        name:'case_version',
        type:'number',
        label:'Case version',
        options:[],
        required:true,
      },
    ],
  };
  let stored = {
    id:routineId,
    companyId,
    ...routinePayload,
    assigneeAgentId:null,
    status:'paused',
    activityGatePolicy:'always',
    activityGateScope:'company',
    originKind:'manual',
    env:null,
    latestRevisionId:revisionId,
    latestRevisionNumber:1,
    variables:routinePayload.variables.map((variable) => ({
      ...variable,
      defaultValue:null,
    })),
    project:{ id:routinePayload.projectId, name:'M5 AI Agent 内容活动 / v2' },
    assignee:null,
    descriptionDocument:{ key:'description', body:routinePayload.description },
    triggers:[],
    recentRuns:[],
    activeIssue:null,
  };
  const recorder = recordingFetch({
    [`GET /api/routines/${routineId}`]: () => stored,
    [`PATCH /api/routines/${routineId}`]: (call) => {
      assert.equal(call.body.assigneeAgentId, assigneeAgentId);
      assert.equal(call.body.status, 'active');
      assert.equal(call.body.baseRevisionId, revisionId);
      const { baseRevisionId: _baseRevisionId, ...patch } = call.body;
      stored = {
        ...stored,
        ...patch,
        latestRevisionId:'c45f195e-5a34-4241-b70a-c466295e0300',
        latestRevisionNumber:2,
        variables:patch.variables.map((variable) => ({
          ...variable,
          defaultValue:variable.defaultValue ?? null,
        })),
      };
      return stored;
    },
  });
  const adapter = new HttpPaperclipAdapter({
    apiBase:'http://127.0.0.1:3100',
    companyId,
    fetchImpl:recorder.fetchImpl,
  });

  const repaired = await adapter.reconcileRoutine({ id:routineId }, routinePayload);
  const replayed = await adapter.reconcileRoutine({ id:routineId }, routinePayload);

  assert.equal(repaired.updated, true);
  assert.equal(repaired.resource.assigneeAgentId, assigneeAgentId);
  assert.equal(repaired.resource.status, 'active');
  assert.equal(replayed.updated, false);
  assert.deepEqual(recorder.calls.map((call) => `${call.method} ${call.url}`), [
    `GET /api/routines/${routineId}`,
    `PATCH /api/routines/${routineId}`,
    `GET /api/routines/${routineId}`,
  ]);
});

test('Transition发送stage key；Trigger和Case解包真实响应', async () => {
  const recorder = recordingFetch({
    [`PUT /api/pipelines/${pipelineId}/transitions`]: { transitions: [] },
    [`POST /api/routines/${routineId}/triggers`]: {
      trigger: { id: 'trigger-id', kind: 'schedule', enabled: false },
      revision: { id: 'revision-id' },
    },
    [`POST /api/pipelines/${pipelineId}/cases`]: {
      case: { id: caseId, caseKey: 'm5:day-1' },
      created: true,
    },
    [`POST /api/cases/${caseId}/review`]: { case: { id: caseId, version: 2 } },
  });
  const adapter = new HttpPaperclipAdapter({
    apiBase: 'http://localhost:3100',
    companyId,
    fetchImpl: recorder.fetchImpl,
  });
  await adapter.setPipelineTransitions(pipelineId, [{
    fromStageKey: 'topic',
    toStageKey: 'research',
    label: '推进',
  }]);
  const trigger = await adapter.createRoutineTrigger(routineId, {
    kind: 'schedule',
    enabled: false,
    cronExpression: '0 9 * * *',
    timezone: 'Asia/Shanghai',
  });
  const pipelineCase = await adapter.ingestCase(pipelineId, {
    caseKey: 'm5:day-1',
    title: 'Day 1',
  });
  await adapter.reviewCase(caseId, {
    decision: 'request_changes',
    reason: '缺少来源',
    expectedVersion: 1,
  });

  assert.equal(trigger.id, 'trigger-id');
  assert.equal(pipelineCase.id, caseId);
  assert.deepEqual(recorder.calls[0].body, {
    transitions: [{ fromStageKey: 'topic', toStageKey: 'research', label: '推进' }],
    enforceTransitions: true,
  });
  assert.deepEqual(recorder.calls.map((call) => `${call.method} ${call.url}`), [
    `PUT /api/pipelines/${pipelineId}/transitions`,
    `POST /api/routines/${routineId}/triggers`,
    `POST /api/pipelines/${pipelineId}/cases`,
    `POST /api/cases/${caseId}/review`,
  ]);
});

test('Http adapter复用2026.722批量Case与blocker接口表达并行分支汇聚', async () => {
  const joinId = '00000000-0000-4000-8000-000000000020';
  const branchIds = [
    '00000000-0000-4000-8000-000000000021',
    '00000000-0000-4000-8000-000000000022',
    '00000000-0000-4000-8000-000000000023',
    '00000000-0000-4000-8000-000000000024',
  ];
  const items = branchIds.map((id, index) => ({
    caseKey:`m5:parallel:branch-${index + 1}`,
    requestKey:`parallel-branch-${index + 1}`,
    title:`分支${index + 1}`,
    stageKey:'draft',
    parentCaseId:joinId,
  }));
  const recorder = recordingFetch({
    [`POST /api/pipelines/${pipelineId}/cases/batch`]: items.map((item, index) => ({
        ok:true,
        case:{ id:branchIds[index], pipelineId, ...item },
        created:true,
      })),
    [`PUT /api/cases/${joinId}/blockers`]: {
      blockers:branchIds.map((blockedByCaseId) => ({ caseId:joinId, blockedByCaseId })),
    },
  });
  const adapter = new HttpPaperclipAdapter({
    apiBase:'http://127.0.0.1:3100',
    companyId,
    fetchImpl:recorder.fetchImpl,
  });

  const branches = await adapter.ingestCases(pipelineId, items);
  await adapter.replaceCaseBlockers(joinId, branchIds);

  assert.deepEqual(branches.map((item) => item.id), branchIds);
  assert.deepEqual(recorder.calls, [
    {
      method:'POST',
      url:`/api/pipelines/${pipelineId}/cases/batch`,
      body:{ items },
    },
    {
      method:'PUT',
      url:`/api/cases/${joinId}/blockers`,
      body:{ blockedByCaseIds:branchIds },
    },
  ]);
});

test('Http adapter用PATCH安全对账已有Routine和Pipeline，不删除未声明资源', async () => {
  const stageId = '00000000-0000-4000-8000-000000000005';
  const revisionId = '00000000-0000-4000-8000-000000000006';
  const routinePayload = {
    title:'M5 / 选题',
    description:'处理 {{case_id}} / {{case_version}}',
    status:'active',
    variables:[
      { name:'case_id', type:'text', required:true },
      { name:'case_version', type:'number', required:true },
    ],
  };
  const pipelinePayload = {
    key:'m5-ai-agent-content',
    name:'M5 AI Agent 实战内容流水线',
    description:'声明',
    projectId:'00000000-0000-4000-8000-000000000007',
    enforceTransitions:true,
    stages:[{
      key:'topic',
      name:'选题',
      kind:'working',
      position:0,
      config:{ m5Policy:{ maxConcurrency:4 } },
    }],
  };
  let routineState = {
    id:routineId,
    title:'旧标题',
    description:'旧描述',
    status:'active',
    variables:[],
    latestRevisionId:revisionId,
  };
  let pipelineState = {
    id:pipelineId,
    key:pipelinePayload.key,
    name:'旧流水线',
    description:'旧声明',
    projectId:pipelinePayload.projectId,
    enforceTransitions:true,
    stages:[{
      id:stageId,
      key:'topic',
      name:'旧选题',
      kind:'working',
      position:0,
      config:{ m5Policy:{ maxConcurrency:99 } },
    }],
  };
  const recorder = recordingFetch({
    [`GET /api/routines/${routineId}`]: () => routineState,
    [`PATCH /api/routines/${routineId}`]: (call) => {
      routineState = { id:routineId, ...call.body, latestRevisionId:'revision-next' };
      return routineState;
    },
    [`GET /api/pipelines/${pipelineId}`]: () => pipelineState,
    [`PATCH /api/pipelines/${pipelineId}`]: (call) => {
      pipelineState = { ...pipelineState, ...call.body };
      return pipelineState;
    },
    [`PATCH /api/pipelines/${pipelineId}/stages/${stageId}`]: (call) => {
      pipelineState.stages[0] = { id:stageId, ...call.body };
      return pipelineState.stages[0];
    },
  });
  const adapter = new HttpPaperclipAdapter({
    apiBase:'http://127.0.0.1:3100',
    companyId,
    fetchImpl:recorder.fetchImpl,
  });

  const routine = await adapter.reconcileRoutine({ id:routineId }, routinePayload);
  const pipeline = await adapter.reconcilePipeline({ id:pipelineId }, pipelinePayload);

  assert.equal(routine.updated, true);
  assert.equal(pipeline.updated, true);
  assert.ok(recorder.calls.some((call) =>
    call.method === 'PATCH'
    && call.url === `/api/routines/${routineId}`
    && call.body.baseRevisionId === revisionId,
  ));
  assert.ok(recorder.calls.some((call) =>
    call.method === 'PATCH'
    && call.url === `/api/pipelines/${pipelineId}/stages/${stageId}`,
  ));
  assert.equal(pipeline.resource.stages[0].config.m5Policy.maxConcurrency, 4);
});

test('Http adapter默认拒绝非loopback Paperclip', () => {
  assert.throws(() => new HttpPaperclipAdapter({
    apiBase: 'https://paperclip.example.com',
    companyId,
  }), /只允许连接 loopback/);
});

test('Http adapter用短期Run JWT和canonical Run头核验当前Agent身份', async () => {
  let captured;
  const adapter = new HttpPaperclipAdapter({
    apiBase:'http://127.0.0.1:3100',
    companyId,
    fetchImpl:async (url, init) => {
      captured = { url, init };
      return response({ id:'agent-current', companyId });
    },
  });
  const actor = await adapter.authenticateRun({
    apiKey:'short-lived-run-jwt',
    runId:'run-current',
  });
  assert.deepEqual(actor, { id:'agent-current', companyId });
  assert.equal(new URL(captured.url).pathname, '/api/agents/me');
  assert.equal(captured.init.headers.authorization, 'Bearer short-lived-run-jwt');
  assert.equal(captured.init.headers['x-paperclip-run-id'], 'run-current');
});

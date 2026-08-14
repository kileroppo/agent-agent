import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TaskCapabilityCatalog } from '../src/task-capability-catalog.ts';
import { TaskExecutionCoordinator } from '../src/task-execution-coordinator.ts';
import { TaskStore } from '../src/task-store.ts';

test('任务执行协调器拒绝把没有专用产物的 succeeded 写成系统成功', async () => {
  let stored = { taskId:'task-1', taskType:'report.public-material', status:'queued', governance:null };
  const store = {
    async updateTask(_taskId, patch) { stored = { ...stored, ...patch }; return stored; },
  };
  const executor = { async execute() { return { status:'succeeded', currentStage:'done' }; } };
  const coordinator = new TaskExecutionCoordinator({
    store,
    capabilityCatalog:new TaskCapabilityCatalog({ executors:{ reporter:executor } }),
  });
  const result = await coordinator.execute(stored, { agentId:'reporter', status:'active' });
  assert.equal(result.status, 'waiting_test');
  assert.equal(result.currentStage, 'completion_evidence_invalid');
  assert.equal(result.error.code, 'completion_evidence_invalid');
  assert.equal(result.usage.schemaVersion, 'agent.army/task-usage/v1');
});

test('任务执行协调器只在专用产物通过完成契约后持久化 succeeded', async () => {
  let stored = { taskId:'task-valid', taskType:'report.public-material', status:'queued', governance:null };
  const store = {
    async updateTask(_taskId, patch) { stored = { ...stored, ...patch }; return stored; },
  };
  const executor = { async execute() { return {
    status:'succeeded',
    currentStage:'public_report_ready',
    artifactRefs:[{
      type:'public_web_report',
      validation:{ exists:true, readable:true, nonEmpty:true },
      data:{ summary:'可验证摘要' },
    }],
  }; } };
  const coordinator = new TaskExecutionCoordinator({
    store,
    capabilityCatalog:new TaskCapabilityCatalog({ executors:{ reporter:executor } }),
  });

  const result = await coordinator.execute(stored, { agentId:'reporter', status:'active' });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.currentStage, 'public_report_ready');
  assert.equal(result.error, undefined);
});

test('任务执行协调器在缺少执行器时保持任务不变', async () => {
  const task = { taskId:'task-2', status:'queued' };
  const coordinator = new TaskExecutionCoordinator({
    store:{ updateTask() { throw new Error('不应写入'); } },
    capabilityCatalog:new TaskCapabilityCatalog(),
  });
  assert.equal(await coordinator.execute(task, { agentId:'missing', status:'active' }), task);
});

test('成熟度信号存在但统一 guard 未装配时 fail closed 且不唤醒 Paperclip Hermes', async () => {
  let stored = {
    taskId:'maturity-without-guard', taskType:'operations.technical-repair', status:'queued',
    source:{ eventRef:'maturity-55555555-5555-4555-8555-555555555555' },
    input:{ context:{ productMaturityAuthorization:{ kind:'product-maturity-validation', token:'signed' } } },
  };
  let localExecutions = 0;
  const coordinator = new TaskExecutionCoordinator({
    store:{ async updateTask(_id, patch) { stored = { ...stored, ...patch }; return stored; } },
    capabilityCatalog:new TaskCapabilityCatalog({ executors:{ 'technical-expert':{ async execute() { localExecutions += 1; } } } }),
  });
  const result = await coordinator.execute(stored, {
    agentId:'technical-expert', status:'active', executionOwner:'paperclip-hermes',
    interaction:{ runtime:'hermes-profile', directFeishu:'required' },
  });
  assert.equal(localExecutions, 0);
  assert.equal(result.status, 'needs_input');
  assert.equal(result.currentStage, 'maturity_execution_guard_unavailable');
  assert.equal(result.error.code, 'maturity_execution_guard_unavailable');
  assert.equal(result.execution, undefined);
});

test('子任务自身成熟度信号被剥离但父任务属于成熟度批次时仍 fail closed', async () => {
  const parent = {
    taskId:'maturity-parent', taskType:'army.cross-agent-mission',
    input:{ context:{ productMaturityBatchId:'maturity-66666666-6666-4666-8666-666666666666' } },
  };
  let stored = {
    taskId:'stripped-maturity-child', parentTaskId:parent.taskId,
    taskType:'operations.technical-repair', status:'queued', input:{ context:{} }, source:{ channel:'army-mission' },
  };
  let localExecutions = 0;
  const coordinator = new TaskExecutionCoordinator({
    store:{
      async list() { return [parent, stored]; },
      async updateTask(_id, patch) { stored = { ...stored, ...patch }; return stored; },
    },
    capabilityCatalog:new TaskCapabilityCatalog({ executors:{ 'technical-expert':{ async execute() { localExecutions += 1; } } } }),
  });
  const result = await coordinator.execute(stored, {
    agentId:'technical-expert', status:'active', executionOwner:'paperclip-hermes',
    interaction:{ runtime:'hermes-profile', directFeishu:'required' },
  });
  assert.equal(localExecutions, 0);
  assert.equal(result.status, 'needs_input');
  assert.equal(result.error.code, 'maturity_execution_guard_unavailable');
  assert.equal(result.execution, undefined);
});

test('任务执行协调器并发恢复同一任务时只调用一次执行器', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-execution-claim-'));
  try {
    const store = new TaskStore(path.join(directory, 'runtime.json'));
    const task = await store.createTask({ taskType:'operations.health-review', status:'queued' });
    let executions = 0;
    const executor = {
      async execute() {
        executions += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { status:'needs_input', currentStage:'manual_input_required' };
      },
    };
    const coordinator = new TaskExecutionCoordinator({
      store,
      capabilityCatalog:new TaskCapabilityCatalog({ executors:{ operator:executor } }),
    });

    const results = await Promise.all([
      coordinator.execute(task, { agentId:'operator', status:'active' }),
      coordinator.execute(task, { agentId:'operator', status:'active' }),
    ]);

    assert.equal(executions, 1);
    assert.equal(results.some((item) => item.status === 'running'), true);
    assert.equal((await store.list())[0].status, 'needs_input');
  } finally {
    await fs.rm(directory, { recursive:true, force:true });
  }
});

test('成熟度子任务即使岗位配置为 Paperclip Hermes 也强制走本地确定性执行', async () => {
  let stored = { taskId:'maturity-child', taskType:'governance.agent-proposal', status:'queued', governance:{ paperclipIssueId:'must-not-wake' } };
  let localExecutions = 0;
  let governanceUpdates = 0;
  const executor = { async execute() { localExecutions += 1; return { status:'needs_input', currentStage:'local-deterministic' }; } };
  const guard = {
    async verifyOrBlock() { return { executionMode:'draft_only' }; },
    async execute(task, selected) { return selected.execute(task); },
  };
  const coordinator = new TaskExecutionCoordinator({
    store:{ async updateTask(_id, patch) { stored = { ...stored, ...patch }; return stored; } },
    governance:{ async update() { governanceUpdates += 1; return {}; } },
    capabilityCatalog:new TaskCapabilityCatalog({ executors:{ creator:executor } }),
    maturityExecutionGuard:guard,
  });
  const result = await coordinator.execute(stored, {
    agentId:'creator', status:'active', executionOwner:'paperclip-hermes',
    interaction:{ runtime:'hermes-profile', directFeishu:'required' },
  });
  assert.equal(localExecutions, 1);
  assert.equal(governanceUpdates, 0);
  assert.equal(result.currentStage, 'local-deterministic');
  assert.notEqual(result.currentStage, 'waiting_paperclip_heartbeat');
});

test('产品成熟度总任务即使 A君 配置 Paperclip 也只走本地计划且持久化零用量', async () => {
  let stored = {
    taskId:'maturity-root', taskType:'army.cross-agent-mission', assigneeAgentId:'ajun', status:'queued',
    governance:{ paperclipIssueId:'must-not-project-or-wake' },
  };
  let localExecutions = 0;
  let governanceUpdates = 0;
  const executor = { async execute() {
    localExecutions += 1;
    return {
      status:'running', currentStage:'mission_planned',
      execution:{ executor:'ajun', outcome:'subtasks_ready' },
      artifactRefs:[{ type:'cross_agent_mission_plan', validation:{ exists:true, readable:true, nonEmpty:true } }],
      usage:{
        model:{ provider:'deterministic-local', model:'mission_plan', inputTokens:0, outputTokens:0, apiCalls:0 },
        cost:{ amount:0, currency:'USD', basis:'included' },
      },
    };
  } };
  const guard = {
    async verifyOrBlock() { return { executionMode:'mission_plan' }; },
    async execute(task, selected) { return selected.execute(task); },
  };
  const coordinator = new TaskExecutionCoordinator({
    store:{ async updateTask(_id, patch) { stored = { ...stored, ...patch }; return stored; } },
    governance:{ async update() { governanceUpdates += 1; return {}; } },
    capabilityCatalog:new TaskCapabilityCatalog({ executors:{ ajun:executor } }),
    maturityExecutionGuard:guard,
  });
  const result = await coordinator.execute(stored, {
    agentId:'ajun', status:'active', executionOwner:'paperclip-hermes',
    interaction:{ runtime:'hermes-profile', directFeishu:'required' },
  });
  assert.equal(localExecutions, 1);
  assert.equal(governanceUpdates, 0);
  assert.equal(result.currentStage, 'mission_planned');
  assert.equal(result.usage.model.status, 'reported');
  assert.equal(result.usage.model.apiCalls, 0);
  assert.equal(result.usage.cost.status, 'reported');
  assert.equal(result.usage.cost.amount, 0);
});

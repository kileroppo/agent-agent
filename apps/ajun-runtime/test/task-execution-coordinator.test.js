import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskCapabilityCatalog } from '../src/task-capability-catalog.js';
import { TaskExecutionCoordinator } from '../src/task-execution-coordinator.js';

test('任务执行协调器通过能力目录执行并持久化结果', async () => {
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
  assert.equal(result.status, 'succeeded');
  assert.equal(result.currentStage, 'done');
  assert.equal(result.usage.schemaVersion, 'agent.army/task-usage/v1');
});

test('任务执行协调器在缺少执行器时保持任务不变', async () => {
  const task = { taskId:'task-2', status:'queued' };
  const coordinator = new TaskExecutionCoordinator({
    store:{ updateTask() { throw new Error('不应写入'); } },
    capabilityCatalog:new TaskCapabilityCatalog(),
  });
  assert.equal(await coordinator.execute(task, { agentId:'missing', status:'active' }), task);
});

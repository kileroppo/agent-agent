import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TaskCapabilityCatalog } from '../src/task-capability-catalog.ts';
import { TaskExecutionCoordinator } from '../src/task-execution-coordinator.ts';
import { TaskStore } from '../src/task-store.js';

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

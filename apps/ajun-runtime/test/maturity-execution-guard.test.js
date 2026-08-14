import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MaturityExecutionGuard } from '../src/maturity-execution-guard.ts';
import { isExactWaitingMaturityMissionRetry, knownZeroUsage } from '../src/maturity-legacy-content-retry.ts';
import { LocalVideoScriptPackage } from '../src/local-video-script-package.ts';
import { LocalContentCreator } from '../src/local-content-creation.ts';

function fixture(executionMode, taskType) {
  const mission = { taskId:'mission-1', input:{ context:{ productMaturityBatchId:'maturity-1' } } };
  let task = {
    taskId:'task-1', parentTaskId:mission.taskId, taskType,
    input:{ title:'受控验证', researchMode:'off', approvedForUse:false, context:{} },
  };
  const store = {
    async list() { return [mission, task]; },
    async updateTask(_taskId, patch) { task = { ...task, ...patch }; return task; },
  };
  const policy = {
    verifyTaskAuthorization() {
      return {
        executionMode, maxModelCalls:0, maxCostUsd:0, costKnown:true,
      };
    },
  };
  return { guard:new MaturityExecutionGuard({ store, policy }), store, task:() => task };
}

test('成熟度恢复只接受明确上报的数值零用量', () => {
  const receipt = (apiCalls, amount) => ({
    model:{ status:'reported', apiCalls },
    cost:{ status:'reported', amount, currency:'USD' },
  });
  assert.equal(knownZeroUsage(receipt(0, 0)), true);
  for (const unknown of [null, '', ' ', undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(knownZeroUsage(receipt(unknown, 0)), false);
    assert.equal(knownZeroUsage(receipt(0, unknown)), false);
  }
});

test('成熟度总任务恢复只接受本地 A君 的精确旧执行形状', () => {
  const batchId = 'maturity-77777777-7777-4777-8777-777777777777';
  const mission = {
    taskType:'army.cross-agent-mission', assigneeAgentId:'ajun', status:'waiting_test',
    currentStage:'mission_waiting_test', attempt:1,
    idempotencyKey:`product-maturity-validation:${batchId}`,
    source:{ eventRef:batchId }, input:{ context:{ productMaturityBatchId:batchId } },
    error:null, governance:null,
    execution:{
      executor:'ajun', mode:'cross_agent_mission_plan', outcome:'subtasks_ready',
      startedAt:'2026-08-11T00:00:00.000Z', finishedAt:'2026-08-11T00:00:01.000Z',
    },
    usage:{
      model:{ status:'reported', apiCalls:0 },
      cost:{ status:'reported', amount:0, currency:'USD' },
    },
  };
  assert.equal(isExactWaitingMaturityMissionRetry(mission), true);
  assert.equal(isExactWaitingMaturityMissionRetry({
    ...mission, execution:{ ...mission.execution, owner:'paperclip-hermes' },
  }), false);
  assert.equal(isExactWaitingMaturityMissionRetry({
    ...mission, execution:{ ...mission.execution, mode:'paperclip-hermes' },
  }), false);
  assert.equal(isExactWaitingMaturityMissionRetry({
    ...mission, execution:{ ...mission.execution, extra:true },
  }), false);
});

test('创建官成熟度执行只创建 draft，不调用 submit，并登记已知 0 USD', async () => {
  const { guard, task } = fixture('draft_only', 'governance.agent-proposal');
  let submitted = 0;
  const proposals = {
    async create() { return { proposalId:'proposal-1', status:'draft', candidateManifest:{ name:'只读差异核对员' } }; },
    async submit() { submitted += 1; throw new Error('不应提交'); },
  };
  const executor = {
    proposals,
    async execute(inputTask) {
      const proposal = await this.proposals.create();
      let reviewSubmission = { status:'pending' };
      try { await this.proposals.submit(proposal.proposalId); }
      catch { reviewSubmission = { status:'pending' }; }
      return {
        status:'succeeded', execution:{ executor:'creator', outcome:'draft' },
        artifactRefs:[{ type:'agent_proposal', validation:{ exists:true, readable:true }, data:{ ...proposal, reviewSubmission } }],
      };
    },
  };
  const result = await guard.execute(task(), executor, { proposalInput:{} });
  assert.equal(submitted, 0);
  assert.equal(result.artifactRefs[0].data.status, 'draft');
  assert.match(result.artifactRefs[0].checksum, /^[0-9a-f]{64}$/);
  assert.equal(result.usage.model.apiCalls, 0);
  assert.deepEqual(result.usage.cost, {
    amount:0, currency:'USD', basis:'included', source:'maturity_zero_model_contract',
  });
});

test('技术专家成熟度执行只在隔离工作区做确定性单文件修复', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maturity-fixture-'));
  try {
    const fixtureDir = path.join(root, 'docs/acceptance-fixtures/technical-repair-sandbox');
    await fs.mkdir(fixtureDir, { recursive:true });
    await fs.writeFile(path.join(fixtureDir, 'calculator.js'), 'export function add(left, right) {\n  return left - right;\n}\n');
    await fs.writeFile(path.join(fixtureDir, 'calculator.test.js'), "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { add } from './calculator.js';\ntest('add', () => assert.equal(add(2, 3), 5));\n");
    await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}\n');
    const { guard, task } = fixture('deterministic_fixture', 'operations.technical-repair');
    const executor = {
      workspace:{ async prepare() { return { workspace:root, reused:false }; } },
      async execute(inputTask) {
        assert.equal(this.promotion, null);
        const prepared = await this.workspace.prepare(inputTask);
        const run = await this.runner.run(inputTask, prepared.workspace);
        return {
          status:'succeeded', currentStage:'acceptance_fixture_verified',
          execution:{
            executor:'technical-expert', outcome:'acceptance_verified_in_isolated_workspace',
            verification:{ testsPassed:true, recoveryVerified:true, acceptanceOnly:true },
          },
          artifactRefs:[{ type:'technical_repair_case', validation:{ exists:true, readable:true }, data:run.evidence }],
        };
      },
    };
    const originalExecFile = process.env.PATH;
    assert.ok(originalExecFile);
    // 用真实 git 仓库记录唯一 diff，避免把测试夹具的其他文件误计为修复。
    const { execFile } = await import('node:child_process');
    await new Promise((resolve, reject) => execFile('git', ['init', '-q'], { cwd:root }, (error) => error ? reject(error) : resolve()));
    await new Promise((resolve, reject) => execFile('git', ['add', '.'], { cwd:root }, (error) => error ? reject(error) : resolve()));
    await new Promise((resolve, reject) => execFile('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture'], { cwd:root }, (error) => error ? reject(error) : resolve()));

    const result = await guard.execute(task(), executor);
    assert.match(await fs.readFile(path.join(fixtureDir, 'calculator.js'), 'utf8'), /left \+ right/);
    assert.match(result.artifactRefs[0].checksum, /^[0-9a-f]{64}$/);
    assert.equal(result.usage.model.apiCalls, 0);
  } finally {
    await fs.rm(root, { recursive:true, force:true });
  }
});

test('小创缺少可证明的本地脚本执行接缝时在调用前 fail closed', async () => {
  const { guard, task } = fixture('local_draft_only', 'content.video-script-package');
  let calls = 0;
  const executor = { async execute() { calls += 1; return { status:'succeeded' }; } };
  await assert.rejects(() => guard.execute(task(), executor), /费用边界未知/);
  assert.equal(calls, 0);
  assert.equal(task().status, 'waiting_test');
  assert.equal(task().error.code, 'maturity_execution_guard_rejected');
});

test('小创零研究 shadow 保留 LocalVideoScriptPackage 原型方法并生成确定性待审包', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maturity-content-shadow-'));
  try {
    const { guard, store, task } = fixture('local_draft_only', 'content.video-script-package');
    const scriptPackage = new LocalVideoScriptPackage({ store, artifactsDir:path.join(root, 'artifacts') });
    const executor = new LocalContentCreator({
      store, artifactsDir:path.join(root, 'content-artifacts'), scriptPackage,
    });
    const result = await guard.execute(task(), executor);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.usage.model.apiCalls, 0);
    assert.equal(result.usage.cost.amount, 0);
    const artifact = result.artifactRefs.find((item) => item.type === 'video_script_package');
    assert.equal(artifact.data.generationMode, 'deterministic_fallback');
    assert.equal(artifact.data.researchStatus, 'not_required');
    assert.equal(artifact.data.templateLifecycle.approvedForUse, false);
    assert.equal(artifact.validation.externalSideEffects, 0);
  } finally {
    await fs.rm(root, { recursive:true, force:true });
  }
});

test('成熟度总任务下的验签失败子任务持久化阻断，不调用执行器', async () => {
  const mission = { taskId:'mission-1', input:{ context:{ productMaturityBatchId:'maturity-1' } } };
  let task = { taskId:'task-1', parentTaskId:mission.taskId, taskType:'operations.health-review', status:'queued' };
  const store = {
    async list() { return [mission, task]; },
    async updateTask(_taskId, patch) { task = { ...task, ...patch }; return task; },
  };
  const guard = new MaturityExecutionGuard({
    store,
    policy:{ verifyTaskAuthorization() { throw new Error('额外第四子任务'); } },
  });
  await assert.rejects(() => guard.verifyOrBlock(task), /额外第四子任务/);
  assert.equal(task.status, 'waiting_test');
  assert.equal(task.currentStage, 'maturity_execution_blocked');
});

for (const [name, tasks, parentTaskId] of [
  ['父任务缺失', [], 'missing-parent'],
  ['父任务错配', [{ taskId:'other-parent', input:{ context:{ productMaturityBatchId:'maturity-other' } } }], 'missing-parent'],
  ['父批次标记被删', [{ taskId:'parent-without-batch', input:{ context:{} } }], 'parent-without-batch'],
]) test(`带成熟度授权的子任务${name}时在执行器前阻断`, async () => {
  let task = {
    taskId:`task-${name}`, parentTaskId, taskType:'content.video-script-package', status:'queued',
    source:{ eventRef:'maturity-11111111-1111-4111-8111-111111111111' },
    input:{ context:{ productMaturityAuthorization:{ kind:'product-maturity-validation', token:'signed' } } },
  };
  const store = {
    async list() { return [...tasks, task]; },
    async updateTask(_id, patch) { task = { ...task, ...patch }; return task; },
  };
  let calls = 0;
  const guard = new MaturityExecutionGuard({ store, policy:{ verifyTaskAuthorization() { return {}; } } });
  await assert.rejects(() => guard.execute(task, { async execute() { calls += 1; } }), /父级缺失|无法解析/);
  assert.equal(calls, 0);
  assert.equal(task.status, 'waiting_test');
});

test('产品成熟度总任务由本地 A君 生成计划并登记已知 0 次调用和 0 USD', async () => {
  let mission = {
    taskId:'mission-root-local',
    taskType:'army.cross-agent-mission',
    assigneeAgentId:'ajun',
    idempotencyKey:'product-maturity-validation:maturity-44444444-4444-4444-8444-444444444444',
    source:{ eventRef:'maturity-44444444-4444-4444-8444-444444444444' },
    input:{ context:{ productMaturityBatchId:'maturity-44444444-4444-4444-8444-444444444444' } },
  };
  const store = {
    async list() { return [mission]; },
    async updateTask(_id, patch) { mission = { ...mission, ...patch }; return mission; },
  };
  let localExecutions = 0;
  const guard = new MaturityExecutionGuard({
    store,
    policy:{ verifyMissionAuthorization() {
      return { executionMode:'mission_plan', maxModelCalls:0, maxCostUsd:0, costKnown:true };
    } },
  });
  const result = await guard.execute(mission, {
    async execute() {
      localExecutions += 1;
      return {
        status:'running', currentStage:'mission_planned',
        execution:{ executor:'ajun', outcome:'subtasks_ready' },
        artifactRefs:[{ type:'cross_agent_mission_plan', validation:{ exists:true, readable:true, nonEmpty:true } }],
      };
    },
  });
  assert.equal(localExecutions, 1);
  assert.equal(result.currentStage, 'mission_planned');
  assert.equal(result.usage.model.apiCalls, 0);
  assert.deepEqual(result.usage.cost, {
    amount:0, currency:'USD', basis:'included', source:'maturity_zero_model_contract',
  });
});

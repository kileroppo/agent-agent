import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AutonomousWorkPlanError,
  createWorkPlan,
  recordAutonomyUsage,
  recordWorkPlanCheckpoint,
  replanAfterFailure
} from '../src/autonomous-work-planner.ts';

const goalSpec = {
  schemaVersion:'agent.army/goal-spec/v1',
  goalId:'goal-1',
  objective:'完成研究并交付',
  deliverables:['研究报告'],
  constraints:[],
  acceptanceCriteria:['通过来源检查'],
  priority:'normal',
  requestedPermissions:['public-web:read'],
  createdAt:'2026-07-29T10:00:00.000Z'
};

test('工作计划创建为版本化 DAG，并拒绝不存在的依赖和循环', () => {
  const plan = createWorkPlan({
    goalSpec,
    steps:[
      { stepId:'research', objective:'检索来源', requiredCapabilities:['public-web:read'], acceptanceCriteria:['至少两个来源'] },
      { stepId:'write', objective:'撰写报告', dependsOn:['research'], acceptanceCriteria:['结论引用来源'] }
    ],
    now:'2026-07-29T10:01:00.000Z'
  });

  assert.equal(plan.schemaVersion, 'agent.army/work-plan/v1');
  assert.equal(plan.version, 1);
  assert.equal(plan.status, 'ready');
  assert.deepEqual(plan.steps.map((step) => [step.stepId, step.dependsOn, step.status]), [
    ['research', [], 'pending'],
    ['write', ['research'], 'pending']
  ]);
  assert.equal(plan.budget.hardLimits.maxDurationMs, 60 * 60 * 1000);
  assert.equal(plan.budget.hardLimits.maxModelCalls, 20);
  assert.equal(plan.budget.hardLimits.maxConcurrency, 4);
  assert.equal(plan.budget.hardLimits.maxDelegationDepth, 2);
  assert.equal(plan.budget.approvalThresholdUsd, 5);

  assert.throws(
    () => createWorkPlan({ goalSpec, steps:[{ stepId:'a', objective:'A', dependsOn:['missing'], acceptanceCriteria:['done'] }] }),
    (error) => error instanceof AutonomousWorkPlanError && error.code === 'invalid_dependency'
  );
  assert.throws(
    () => createWorkPlan({ goalSpec, steps:[
      { stepId:'a', objective:'A', dependsOn:['b'], acceptanceCriteria:['done'] },
      { stepId:'b', objective:'B', dependsOn:['a'], acceptanceCriteria:['done'] }
    ] }),
    (error) => error instanceof AutonomousWorkPlanError && error.code === 'dependency_cycle'
  );
  assert.throws(
    () => createWorkPlan({
      goalSpec:{ ...goalSpec, metadata:{ password:'never-store-this' } },
      steps:[{ stepId:'safe', objective:'执行', acceptanceCriteria:['完成'] }]
    }),
    (error) => error instanceof AutonomousWorkPlanError && error.code === 'sensitive_data_rejected'
  );
});

test('checkpoint 不可变地推进步骤，保留产物，并阻止跳过依赖', () => {
  const original = createWorkPlan({
    goalSpec,
    steps:[
      { stepId:'research', objective:'检索来源', acceptanceCriteria:['来源可访问'] },
      { stepId:'write', objective:'撰写报告', dependsOn:['research'], acceptanceCriteria:['报告完整'] }
    ],
    now:'2026-07-29T10:00:00.000Z'
  });
  assert.throws(
    () => recordWorkPlanCheckpoint(original, { stepId:'write', status:'running' }),
    (error) => error instanceof AutonomousWorkPlanError && error.code === 'dependency_not_satisfied'
  );

  const running = recordWorkPlanCheckpoint(original, {
    stepId:'research',
    status:'running',
    checkpoint:{ cursor:'page-2' },
    now:'2026-07-29T10:02:00.000Z'
  });
  const completed = recordWorkPlanCheckpoint(running, {
    stepId:'research',
    status:'completed',
    checkpoint:{ sourceCount:3 },
    artifactRefs:['artifact:research-1'],
    now:'2026-07-29T10:03:00.000Z'
  });

  assert.equal(original.steps[0].status, 'pending');
  assert.equal(running.steps[0].attempt, 1);
  assert.equal(completed.steps[0].status, 'completed');
  assert.deepEqual(completed.steps[0].checkpoint, { sourceCount:3 });
  assert.deepEqual(completed.steps[0].artifactRefs, ['artifact:research-1']);
  assert.equal(completed.status, 'running');
});

test('自主预算在硬上限停止，在预计费用超过 5 美元时等待审批', () => {
  const plan = createWorkPlan({
    goalSpec,
    steps:[{ stepId:'work', objective:'执行任务', acceptanceCriteria:['完成'] }],
    now:'2026-07-29T10:00:00.000Z'
  });
  const underLimit = recordAutonomyUsage(plan, {
    modelCalls:19,
    estimatedCostUsd:4.99,
    activeChildren:4,
    delegationDepth:2
  }, { now:'2026-07-29T10:30:00.000Z' });
  assert.equal(underLimit.decision.status, 'allowed');
  assert.equal(underLimit.plan.budget.usage.modelCalls, 19);

  const exhausted = recordAutonomyUsage(underLimit.plan, { modelCalls:2 }, {
    now:'2026-07-29T10:31:00.000Z'
  });
  assert.equal(exhausted.decision.status, 'budget_exhausted');
  assert.deepEqual(exhausted.decision.reasons, ['max_model_calls']);
  assert.equal(exhausted.plan.status, 'budget_exhausted');

  const approval = recordAutonomyUsage(plan, { estimatedCostUsd:5.01 }, {
    now:'2026-07-29T10:01:00.000Z'
  });
  assert.equal(approval.decision.status, 'waiting_approval');
  assert.equal(approval.decision.approvalRequired, true);
  assert.equal(approval.plan.status, 'waiting_approval');
  assert.throws(
    () => recordWorkPlanCheckpoint(approval.plan, { stepId:'work', status:'running' }),
    (error) => error instanceof AutonomousWorkPlanError && error.code === 'execution_gated'
  );

  const elapsed = recordAutonomyUsage(plan, {}, { now:'2026-07-29T11:00:00.001Z' });
  assert.equal(elapsed.decision.status, 'budget_exhausted');
  assert.deepEqual(elapsed.decision.reasons, ['max_duration']);

  for (const [usage, reason] of [
    [{ activeChildren:5 }, 'max_concurrency'],
    [{ delegationDepth:3 }, 'max_delegation_depth']
  ]) {
    const result = recordAutonomyUsage(plan, usage, { now:'2026-07-29T10:01:00.000Z' });
    assert.equal(result.decision.status, 'budget_exhausted');
    assert.deepEqual(result.decision.reasons, [reason]);
  }
});

test('任务可以缩小自主预算但不能突破全局硬上限', () => {
  const plan = createWorkPlan({
    goalSpec,
    budget:{
      maxDurationMinutes:15,
      maxModelCalls:6,
      maxConcurrentSubtasks:2,
      maxDependencyDepth:1,
      maxCostUsd:1.5
    },
    steps:[{ stepId:'work', objective:'执行任务', acceptanceCriteria:['完成'] }],
    now:'2026-07-29T10:00:00.000Z'
  });
  assert.deepEqual(plan.budget.hardLimits, {
    maxDurationMs:15 * 60 * 1000,
    maxModelCalls:6,
    maxConcurrency:2,
    maxDelegationDepth:1
  });
  assert.equal(plan.budget.approvalThresholdUsd, 1.5);
  assert.equal(recordAutonomyUsage(plan, { modelCalls:7 }, { now:'2026-07-29T10:01:00.000Z' }).decision.status, 'budget_exhausted');
  assert.equal(recordAutonomyUsage(plan, { estimatedCostUsd:1.51 }, { now:'2026-07-29T10:01:00.000Z' }).decision.status, 'waiting_approval');
  assert.throws(
    () => createWorkPlan({
      goalSpec,
      budget:{ maxConcurrentSubtasks:5 },
      steps:[{ stepId:'work', objective:'执行任务', acceptanceCriteria:['完成'] }]
    }),
    (error) => error instanceof AutonomousWorkPlanError && error.code === 'invalid_budget'
  );
});

test('部分失败后有限重规划只替换失败分支，并重接下游依赖', () => {
  let plan = createWorkPlan({
    goalSpec,
    steps:[
      { stepId:'context', objective:'准备上下文', acceptanceCriteria:['上下文有效'] },
      { stepId:'research', objective:'检索来源', dependsOn:['context'], acceptanceCriteria:['来源可用'] },
      { stepId:'write', objective:'撰写报告', dependsOn:['research'], acceptanceCriteria:['报告完整'] }
    ],
    now:'2026-07-29T10:00:00.000Z'
  });
  plan = recordWorkPlanCheckpoint(plan, { stepId:'context', status:'running' });
  plan = recordWorkPlanCheckpoint(plan, { stepId:'context', status:'completed' });
  plan = recordWorkPlanCheckpoint(plan, { stepId:'research', status:'failed', checkpoint:{ reason:'provider_timeout' } });
  const replanned = replanAfterFailure(plan, {
    failedStepId:'research',
    reason:'改用已安装的备用公开检索能力',
    replacementSteps:[
      { stepId:'research-retry', objective:'重新检索来源', dependsOn:['context'], acceptanceCriteria:['来源可用'] }
    ],
    now:'2026-07-29T10:05:00.000Z'
  });

  assert.equal(replanned.version, 2);
  assert.equal(replanned.replanCount, 1);
  assert.equal(replanned.steps.find((step) => step.stepId === 'context').status, 'completed');
  assert.equal(replanned.steps.find((step) => step.stepId === 'research').status, 'superseded');
  assert.deepEqual(replanned.steps.find((step) => step.stepId === 'research').supersededBy, ['research-retry']);
  assert.deepEqual(replanned.steps.find((step) => step.stepId === 'write').dependsOn, ['research-retry']);
  assert.equal(replanned.status, 'running');
});

test('同一工作计划最多允许三次失败重规划', () => {
  let plan = createWorkPlan({
    goalSpec,
    steps:[{ stepId:'attempt-0', objective:'执行', acceptanceCriteria:['完成'] }]
  });
  for (let index = 0; index < 3; index += 1) {
    const current = `attempt-${index}`;
    const replacement = `attempt-${index + 1}`;
    plan = recordWorkPlanCheckpoint(plan, { stepId:current, status:'failed' });
    plan = replanAfterFailure(plan, {
      failedStepId:current,
      reason:`第 ${index + 1} 次调整`,
      replacementSteps:[{ stepId:replacement, objective:'再次执行', acceptanceCriteria:['完成'] }]
    });
  }
  plan = recordWorkPlanCheckpoint(plan, { stepId:'attempt-3', status:'failed' });
  assert.throws(
    () => replanAfterFailure(plan, {
      failedStepId:'attempt-3',
      reason:'第四次调整',
      replacementSteps:[{ stepId:'attempt-4', objective:'继续执行', acceptanceCriteria:['完成'] }]
    }),
    (error) => error instanceof AutonomousWorkPlanError && error.code === 'replan_limit_reached'
  );
});

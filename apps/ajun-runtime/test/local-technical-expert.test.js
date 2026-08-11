import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalTechnicalExpert } from '../src/local-technical-expert.ts';
import { MissionChildPolicy } from '../src/workflow/mission-child-policy.ts';

const maturityItems = [
  { key:'creator', taskType:'governance.agent-proposal', agentId:'creator' },
  { key:'technical-expert', taskType:'operations.technical-repair', agentId:'technical-expert' },
  { key:'content-creator', taskType:'content.video-script-package', agentId:'content-creator' },
];

async function maturityAuthorizationFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-technical-expert-policy-'));
  const policy = await MissionChildPolicy.open({ keyPath:path.join(root, 'policy.key') });
  const batchId = 'maturity-11111111-1111-4111-8111-111111111111';
  const authorization = policy.issue(batchId, maturityItems);
  const mission = { taskId:'mission-11111111-1111-4111-8111-111111111111', idempotencyKey:'product-maturity-validation:batch-1', input:{ context:{ productMaturityBatchId:batchId } } };
  return { policy, batchId, authorization, mission };
}

test('技术专家接手复杂故障后留下真实修复任务，不冒充已经修好', async () => {
  const expert = new LocalTechnicalExpert({ now: () => new Date('2026-07-21T00:00:00.000Z') });
  const result = await expert.execute({
    taskId: 'technical-task', parentTaskId: 'failed-task', taskType: 'operations.technical-repair',
    input: { context: { failedTaskId: 'failed-task', failure: { code: 'xiaod_job_failed', category: 'manual', stage: 'distilling', retryable: false } } }
  });
  const repair = result.artifactRefs[0].data;
  assert.equal(result.status, 'waiting_test');
  assert.equal(result.currentStage, 'technical_diagnosis_ready');
  assert.equal(result.artifactRefs[0].type, 'technical_repair_case');
  assert.equal(result.artifactRefs[1].type, 'technical_diagnosis_report');
  assert.equal(repair.implementationStarted, false);
  assert.match(repair.nextAction, /补充最小诊断证据/);
});

test('Paperclip 已登记技术专家时任务保持处理中，等待 A君 准备独立副本且不冒充已经修好', async () => {
  const expert = new LocalTechnicalExpert({ now:() => new Date('2026-07-21T10:00:00.000Z') });
  const result = await expert.execute({ taskId:'technical-task', parentTaskId:'failed-task', taskType:'operations.technical-repair', governance:{ paperclipIssueId:'issue-1', paperclipIssueIdentifier:'AGE-100', paperclipAssigneeAgentId:'paperclip-tech-1' }, input:{ title:'修复故障', context:{ failure:{ code:'executor_failed', stage:'execution', category:'manual', retryable:false } } }, execution:{} });
  const repair = result.artifactRefs[0].data;
  assert.equal(result.status, 'waiting_test');
  assert.equal(result.currentStage, 'technical_diagnosis_ready');
  assert.equal(repair.engineeringAssigned, true);
  assert.equal(repair.implementationStarted, false);
  assert.match(repair.nextAction, /补充最小诊断证据/);
});

test('技术专家执行后没有留下完整结果时，A君 标为待测试而不假装处理中', async () => {
  const expert = new LocalTechnicalExpert({ now:() => new Date('2026-07-21T10:00:00.000Z'), workspace:{ async prepare() { return { workspace:'/safe/repair', reused:false }; } }, runner:{ async run() { return { status:'evidence_missing' }; } } });
  const result = await expert.execute({ taskId:'technical-task', governance:{ paperclipAssigneeAgentId:'paperclip-tech-1' }, input:{ context:{ repairScope:{ files:['apps/a.js'], testCommand:'npm test', recoveryCheck:'检查恢复' } } }, execution:{} });
  assert.equal(result.status, 'waiting_test');
  assert.equal(result.currentStage, 'repair_evidence_missing');
  assert.match(result.artifactRefs[0].data.nextAction, /没有留下完整修复结果/);
});

test('技术专家自动检查超时后，A君 标记待测试并保留独立副本', async () => {
  const expert = new LocalTechnicalExpert({ now:() => new Date('2026-07-21T10:00:00.000Z'), workspace:{ async prepare() { return { workspace:'/safe/repair', reused:false }; } }, runner:{ async run() { return { status:'waiting_for_test', reason:'超时' }; } } });
  const result = await expert.execute({ taskId:'technical-task', governance:{ paperclipAssigneeAgentId:'paperclip-tech-1' }, input:{ context:{ repairScope:{ files:['apps/a.js'], testCommand:'npm test', recoveryCheck:'检查恢复' } } }, execution:{} });
  assert.equal(result.status, 'waiting_test');
  assert.equal(result.currentStage, 'repair_waiting_for_test');
  assert.match(result.artifactRefs[0].data.nextAction, /待测试/);
});

test('技术诊断没有给出安全范围时，技术专家标记待测试而不是猜测修改', async () => {
  const expert = new LocalTechnicalExpert({ now:() => new Date('2026-07-21T10:00:00.000Z'), workspace:{ async prepare() { return { workspace:'/safe/repair', reused:false }; } }, runner:{ async run() { return { status:'waiting_for_scope' }; } } });
  const result = await expert.execute({ taskId:'technical-task', governance:{ paperclipAssigneeAgentId:'paperclip-tech-1' }, input:{ context:{ diagnosis:{ status:'waiting_for_test' } } }, execution:{} });
  assert.equal(result.status, 'waiting_test');
  assert.equal(result.currentStage, 'technical_diagnosis_ready');
  assert.equal(result.artifactRefs[1].data.codeRepairAttempted, false);
});

test('技术专家留下完整结果且可安全带回时，A君 等待治理记录而不重复执行', async () => {
  const evidence = { metadata:{ agentArmyRepairEvidence:{ changedFiles:['apps/a.js'], testsPassed:true, recoveryVerified:true } } };
  const expert = new LocalTechnicalExpert({ now:() => new Date('2026-07-21T10:00:00.000Z'), workspace:{ async prepare() { return { workspace:'/safe/repair', reused:false }; } }, runner:{ async run() { return { status:'evidence_ready', evidence }; } }, promotion:{ async promote() { return { status:'promoted', changedFiles:['apps/a.js'] }; } } });
  const result = await expert.execute({ taskId:'technical-task', governance:{ paperclipAssigneeAgentId:'paperclip-tech-1' }, input:{ context:{ repairScope:{ files:['apps/a.js'], testCommand:'npm test', recoveryCheck:'检查恢复' } } }, execution:{} });
  assert.equal(result.status, 'running');
  assert.equal(result.currentStage, 'repair_promoted_awaiting_record');
  assert.deepEqual(result.execution.verification, {
    verified:true,
    changedFiles:['apps/a.js'],
    testsPassed:true,
    testCommand:'npm test',
    testSummary:'',
    recoveryVerified:true,
    recoveryCheck:'检查恢复',
    recoverySummary:'',
    remainingTests:[]
  });
  assert.equal(result.artifactRefs[0].data.verification.verified, true);
  assert.match(result.artifactRefs[0].data.nextAction, /安全带回主工程/);
});

test('外置源码根修复只进入候选待发版，不冒充当前运行版本已修复', async () => {
  const evidence = { metadata:{ agentArmyRepairEvidence:{ changedFiles:['apps/a.js'], testsPassed:true, recoveryVerified:true } } };
  const expert = new LocalTechnicalExpert({
    now:() => new Date('2026-07-21T10:00:00.000Z'),
    workspace:{ async prepare() { return { workspace:'/safe/repair', reused:false }; } },
    runner:{ async run() { return { status:'evidence_ready', evidence }; } },
    promotion:{ async promote() {
      return {
        status:'candidate_promoted',
        changedFiles:['apps/a.js'],
        recommendedCompletionStatus:'waiting_test',
        nextAction:'生成并验证新的不可变 release。',
      };
    } },
  });
  const result = await expert.execute({
    taskId:'technical-task',
    governance:{ paperclipAssigneeAgentId:'paperclip-tech-1' },
    input:{ context:{ repairScope:{ files:['apps/a.js'], testCommand:'npm test', recoveryCheck:'检查恢复' } } },
    execution:{},
  });
  assert.equal(result.status, 'waiting_test');
  assert.equal(result.currentStage, 'repair_candidate_awaiting_release');
  assert.equal(result.execution.outcome, 'candidate_promoted');
  assert.equal(result.execution.verification.candidateOnly, true);
  assert.equal(result.execution.verification.runningReleaseUpdated, false);
  assert.match(result.artifactRefs[0].data.nextAction, /不可变 release/);
});

test('受控产品成熟度夹具在隔离工作区通过测试与恢复检查后直接验收，不晋升源码也不要求发版', async () => {
  const { policy, batchId, authorization, mission } = await maturityAuthorizationFixture();
  const fixtureFile = 'docs/acceptance-fixtures/technical-repair-sandbox/calculator.js';
  const evidence = { metadata:{ agentArmyRepairEvidence:{
    changedFiles:[fixtureFile],
    testsPassed:true,
    testSummary:'calculator fixture test passed',
    recoveryVerified:true,
    recoverySummary:'only calculator.js changed',
  } } };
  let promotionCalls = 0;
  const expert = new LocalTechnicalExpert({
    now:() => new Date('2026-08-11T00:00:00.000Z'),
    workspace:{ async prepare() { return { workspace:'/safe/project/work/acceptance-runs/technical-task-123', reused:false }; } },
    runner:{ async run() { return { status:'evidence_ready', evidence }; } },
    promotion:{ async promote() { promotionCalls += 1; throw new Error('产品成熟度夹具不得晋升'); } },
    missionChildPolicy:policy,
    missionResolver:async () => mission,
  });
  const result = await expert.execute({
    taskId:'technical-task-123',
    taskType:'operations.technical-repair',
    assigneeAgentId:'technical-expert',
    parentTaskId:mission.taskId,
    idempotencyKey:`${mission.idempotencyKey}:technical-expert`,
    source:{ eventRef:batchId, missionTaskId:mission.taskId },
    workflow:{ step:{ key:'technical-expert' } },
    governance:{ paperclipAssigneeAgentId:'paperclip-tech-1' },
    input:{ context:{
      missionTaskId:mission.taskId,
      productMaturityAuthorization:authorization,
      acceptanceWorkspaceRoot:'/safe/project/work/acceptance-runs',
      repairScope:{ files:[fixtureFile], testCommand:'node --test calculator.test.js', recoveryCheck:'只修改 calculator.js' },
    } },
    execution:{},
  });
  assert.equal(promotionCalls, 0);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.currentStage, 'acceptance_fixture_verified');
  assert.equal(result.execution.outcome, 'acceptance_verified_in_isolated_workspace');
  assert.deepEqual(result.execution.verification, {
    verified:true,
    changedFiles:[fixtureFile],
    testsPassed:true,
    testCommand:'node --test calculator.test.js',
    testSummary:'calculator fixture test passed',
    recoveryVerified:true,
    recoveryCheck:'只修改 calculator.js',
    recoverySummary:'only calculator.js changed',
    remainingTests:[],
    acceptanceOnly:true,
    sourceProjectRootChanged:false,
    runningReleaseUpdated:false,
  });
  assert.match(result.artifactRefs[0].data.nextAction, /未带回源码根/);
  assert.match(result.artifactRefs[0].data.nextAction, /不需要生成新 release/);
});

test('篡改签名、错岗位、错步骤或错批次都不能绕过普通修复的晋升与 release 门禁', async () => {
  const { policy, batchId, authorization, mission } = await maturityAuthorizationFixture();
  const tamperedAuthorization = { ...authorization, token:`${authorization.token.split('.')[0]}.invalid` };
  const fixtureFile = 'docs/acceptance-fixtures/technical-repair-sandbox/calculator.js';
  const evidence = { metadata:{ agentArmyRepairEvidence:{ changedFiles:[fixtureFile], testsPassed:true, recoveryVerified:true } } };
  let promotionCalls = 0;
  const baseTask = {
    taskId:'technical-task-123',
    taskType:'operations.technical-repair',
    assigneeAgentId:'technical-expert',
    parentTaskId:mission.taskId,
    idempotencyKey:`${mission.idempotencyKey}:technical-expert`,
    source:{ eventRef:batchId, missionTaskId:mission.taskId },
    workflow:{ step:{ key:'technical-expert' } },
    input:{ context:{
      missionTaskId:mission.taskId,
      productMaturityAuthorization:authorization,
      acceptanceWorkspaceRoot:'/safe/project/work/acceptance-runs',
      repairScope:{ files:[fixtureFile], testCommand:'npm test', recoveryCheck:'检查恢复' },
    } },
    execution:{},
  };
  const variants = [
    { ...baseTask, input:{ context:{ ...baseTask.input.context, productMaturityAuthorization:tamperedAuthorization } } },
    { ...baseTask, assigneeAgentId:'reviewer' },
    { ...baseTask, workflow:{ step:{ key:'creator' } } },
    { ...baseTask, source:{ eventRef:'maturity-22222222-2222-4222-8222-222222222222' } },
  ];
  for (const task of variants) {
    const expert = new LocalTechnicalExpert({
      now:() => new Date('2026-08-11T00:00:00.000Z'),
      workspace:{ async prepare() { return { workspace:'/safe/project/work/acceptance-runs/technical-task-123', reused:false }; } },
      runner:{ async run() { return { status:'evidence_ready', evidence }; } },
      promotion:{ async promote() {
        promotionCalls += 1;
        return { status:'candidate_promoted', changedFiles:[fixtureFile], nextAction:'生成并验证新的不可变 release。' };
      } },
      missionChildPolicy:policy,
      missionResolver:async () => mission,
    });
    const result = await expert.execute(task);
    assert.equal(result.status, 'waiting_test');
    assert.equal(result.currentStage, 'repair_candidate_awaiting_release');
    assert.equal(result.execution.verification.acceptanceOnly, undefined);
    assert.equal(result.execution.verification.candidateOnly, true);
    assert.match(result.artifactRefs[0].data.nextAction, /不可变 release/);
  }
  assert.equal(promotionCalls, variants.length);
});

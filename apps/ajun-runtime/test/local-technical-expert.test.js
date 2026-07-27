import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalTechnicalExpert } from '../src/local-technical-expert.js';

test('技术专家接手复杂故障后留下真实修复任务，不冒充已经修好', async () => {
  const expert = new LocalTechnicalExpert({ now: () => new Date('2026-07-21T00:00:00.000Z') });
  const result = await expert.execute({
    taskId: 'technical-task', parentTaskId: 'failed-task', taskType: 'operations.technical-repair',
    input: { context: { failedTaskId: 'failed-task', failure: { code: 'xiaod_job_failed', category: 'manual', stage: 'distilling', retryable: false } } }
  });
  const repair = result.artifactRefs[0].data;
  assert.equal(result.status, 'succeeded');
  assert.equal(result.currentStage, 'technical_repair_case_ready');
  assert.equal(result.artifactRefs[0].type, 'technical_repair_case');
  assert.equal(repair.implementationStarted, false);
  assert.match(repair.nextAction, /接入受控工程执行器/);
});

test('Paperclip 已登记技术专家时任务保持处理中，等待 A君 准备独立副本且不冒充已经修好', async () => {
  const expert = new LocalTechnicalExpert({ now:() => new Date('2026-07-21T10:00:00.000Z') });
  const result = await expert.execute({ taskId:'technical-task', parentTaskId:'failed-task', taskType:'operations.technical-repair', governance:{ paperclipIssueId:'issue-1', paperclipIssueIdentifier:'AGE-100', paperclipAssigneeAgentId:'paperclip-tech-1' }, input:{ title:'修复故障', context:{ failure:{ code:'executor_failed', stage:'execution', category:'manual', retryable:false } } }, execution:{} });
  const repair = result.artifactRefs[0].data;
  assert.equal(result.status, 'running');
  assert.equal(result.currentStage, 'paperclip_engineering_assigned');
  assert.equal(repair.engineeringAssigned, true);
  assert.equal(repair.implementationStarted, false);
  assert.match(repair.nextAction, /等待 A君 建立独立修理副本/);
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
  assert.equal(result.currentStage, 'repair_scope_pending');
  assert.match(result.artifactRefs[0].data.nextAction, /不会猜测/);
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

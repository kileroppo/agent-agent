import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CapabilityAcceptanceBundle } from '../src/workflow/capability-acceptance-bundle.ts';
import { MissionChildPolicy } from '../src/workflow/mission-child-policy.ts';

test('一个固定批次生成十岗位证据包，统一决定不改历史任务终态', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maturity-bundle-'));
  const tasks = seedTasks();
  const originalStatuses = new Map(tasks.map((item) => [item.taskId, item.status]));
  const store = { async list() { return tasks; } };
  const policy = await MissionChildPolicy.open({ keyPath:path.join(root, 'policy.key') });
  const missions = {
    async createBusinessMission(input) {
      assert.deepEqual(input.items.map((item) => item.taskType), ['governance.agent-proposal', 'operations.technical-repair', 'content.video-script-package']);
      assert.deepEqual(input.items.map((item) => item.context.productMaturityAuthorization.kind), Array(3).fill('product-maturity-validation'));
      assert.deepEqual(input.items[2].context.sourceTaskIds, [
        '10e4f814-1111-4111-8111-111111111111',
        'b5403cd9-1111-4111-8111-111111111111',
      ]);
      assert.deepEqual(input.items[2].context.requiredSourceTaskIds, input.items[2].context.sourceTaskIds);
      const mission = successTask('mission-new', 'army.cross-agent-mission', 'ajun');
      mission.input = { context:{ productMaturityBatchId:input.source.eventRef } };
      const children = input.items.map((item) => ({ ...successTask(`${item.key}-new`, item.taskType, item.agentId), parentTaskId:mission.taskId }));
      tasks.push(mission, ...children);
      return { mission, children };
    },
  };
  const service = new CapabilityAcceptanceBundle({ store, missions, policy, ledgerPath:path.join(root, 'ledger.json'), projectRoot:root });
  const batch = await service.create();
  assert.equal(batch.roles.length, 10);
  assert.equal(batch.status, 'ready_for_decision');
  assert.equal(batch.acceptanceEligible, true);
  assert.deepEqual(batch.roles.find((item) => item.agentId === 'technical-expert'), {
    agentId:'technical-expert',
    name:'技术专家',
    verified:true,
    evidenceTaskId:'technical-expert-new',
    verifiedAt:'2026-08-10T00:01:00.000Z',
    batchStatus:'succeeded',
    batchVerified:true,
    evidenceOrigin:'current_batch',
    latestFailureTaskId:null,
    latestFailureAt:null,
    freshness:'later_than_latest_failure_or_no_failure',
  });
  assert.equal(batch.roles.find((item) => item.agentId === 'reviewer').evidenceOrigin, 'historical');
  assert.deepEqual(batch.policy, { maxModelCalls:4, maxCostUsd:0.08, externalActions:false, publishing:false });
  const accepted = await service.decide(batch.batchId, { decision:'accepted', evidenceHash:batch.evidenceHash, note:'统一阅读通过' });
  assert.equal(accepted.decision.status, 'accepted');
  assert.equal(accepted.decision.historicalTaskStatusesChanged, false);
  for (const [taskId, status] of originalStatuses) assert.equal(tasks.find((item) => item.taskId === taskId).status, status);
  assert.equal((await service.create()).batchId, batch.batchId);
});

test('证据变化后旧 hash 失效，不能静默登记验收', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maturity-stale-'));
  const tasks = seedTasks();
  const policy = await MissionChildPolicy.open({ keyPath:path.join(root, 'policy.key') });
  const missions = { async createBusinessMission(input) {
    const mission = successTask('mission-new', 'army.cross-agent-mission', 'ajun');
    mission.input = { context:{ productMaturityBatchId:input.source.eventRef } };
    const children = input.items.map((item) => ({ ...successTask(`${item.key}-new`, item.taskType, item.agentId), parentTaskId:mission.taskId }));
    tasks.push(mission, ...children); return { mission, children };
  } };
  const service = new CapabilityAcceptanceBundle({ store:{ async list() { return tasks; } }, missions, policy, ledgerPath:path.join(root, 'ledger.json'), projectRoot:root });
  const batch = await service.create();
  tasks.find((item) => item.taskId === 'content-creator-new').updatedAt = '2026-08-11T00:00:00.000Z';
  await assert.rejects(() => service.decide(batch.batchId, { decision:'accepted', evidenceHash:batch.evidenceHash }), (error) => error.code === 'maturity_evidence_stale' && error.httpStatus === 409);
});

test('当前批次 waiting_test 不得用历史成功替代，accepted 被拒但 revision_required 可登记', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maturity-current-batch-gate-'));
  const tasks = seedTasks();
  tasks.push(successTask('technical-expert-historical', 'operations.technical-repair', 'technical-expert'));
  const policy = await MissionChildPolicy.open({ keyPath:path.join(root, 'policy.key') });
  const missions = { async createBusinessMission(input) {
    const mission = successTask('mission-current-gate', 'army.cross-agent-mission', 'ajun');
    mission.input = { context:{ productMaturityBatchId:input.source.eventRef } };
    const children = input.items.map((item) => ({
      ...successTask(`${item.key}-current-gate`, item.taskType, item.agentId),
      parentTaskId:mission.taskId,
    }));
    children.find((item) => item.assigneeAgentId === 'technical-expert').status = 'waiting_test';
    tasks.push(mission, ...children);
    return { mission, children };
  } };
  const service = new CapabilityAcceptanceBundle({
    store:{ async list() { return tasks; } },
    missions,
    policy,
    ledgerPath:path.join(root, 'ledger.json'),
    projectRoot:root,
  });

  const batch = await service.create();
  assert.equal(batch.status, 'ready_for_decision');
  assert.equal(batch.acceptanceEligible, false);
  const technical = batch.roles.find((item) => item.agentId === 'technical-expert');
  assert.equal(technical.verified, false);
  assert.equal(technical.evidenceTaskId, 'technical-expert-current-gate');
  assert.equal(technical.batchStatus, 'waiting_test');
  assert.equal(technical.batchVerified, false);
  assert.equal(technical.evidenceOrigin, 'current_batch');
  assert.notEqual(technical.evidenceTaskId, 'technical-expert-historical');

  await assert.rejects(
    () => service.decide(batch.batchId, { decision:'accepted', evidenceHash:batch.evidenceHash }),
    (error) => error.code === 'maturity_batch_not_acceptance_eligible' && error.httpStatus === 409,
  );
  const revision = await service.decide(batch.batchId, {
    decision:'revision_required',
    evidenceHash:batch.evidenceHash,
    note:'技术修复仍在等待验证。',
  });
  assert.equal(revision.status, 'revision_required');
  assert.equal(revision.decision.status, 'revision_required');
  assert.equal(revision.acceptanceEligible, false);
});

function seedTasks() {
  const tasks = [
    sourceTask('10e4f814-1111-4111-8111-111111111111', 'media.transcribe-and-refine', 'xiaod', 'confirmed_transcript'),
    sourceTask('b5403cd9-1111-4111-8111-111111111111', 'content.video-benchmark-analysis', 'video-content-analyst', 'video_content_analysis_report'),
  ];
  for (const [id, type, agent] of [
    ['research', 'research.intel-report', 'intel-researcher'],
    ['office', 'office.presentation-package', 'office-assistant'],
    ['review', 'governance.approval-review', 'reviewer'],
    ['architect', 'governance.architecture-review', 'architect'],
  ]) tasks.push(successTask(`${id}-existing`, type, agent));
  return tasks;
}

function sourceTask(taskId, taskType, agentId, artifactType) {
  const task = successTask(taskId, taskType, agentId);
  task.artifactRefs[0].type = artifactType;
  return task;
}

function successTask(taskId, taskType, assigneeAgentId) {
  return { taskId, taskType, assigneeAgentId, status:'succeeded', createdAt:'2026-08-10T00:00:00.000Z', updatedAt:'2026-08-10T00:01:00.000Z', artifactRefs:[{ type:'verified_output', validation:{ exists:true, readable:true, nonEmpty:true } }] };
}

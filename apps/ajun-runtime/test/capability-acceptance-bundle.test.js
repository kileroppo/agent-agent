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
  let missionCount = 0;
  const missions = {
    async createBusinessMission(input) {
      missionCount += 1;
      assert.deepEqual(input.items.map((item) => item.taskType), ['governance.agent-proposal', 'operations.technical-repair', 'content.video-script-package']);
      assert.deepEqual(input.items.map((item) => item.context.productMaturityAuthorization.kind), Array(3).fill('product-maturity-validation'));
      assert.equal(input.items[0].proposalOnly, true);
      assert.equal(input.items[0].draftOnly, true);
      assert.equal(input.items[1].deterministicAcceptanceRepair, true);
      assert.equal(input.items[2].researchMode, 'off');
      assert.equal(input.items[2].approvedForUse, false);
      assert.deepEqual(input.items[2].context.modelPolicy, { maxCalls:0, maxCostUsd:0, costKnown:true });
      assert.deepEqual(input.items[2].context.sourceTaskIds, [
        '10e4f814-1111-4111-8111-111111111111',
        'b5403cd9-1111-4111-8111-111111111111',
      ]);
      assert.deepEqual(input.items[2].context.requiredSourceTaskIds, input.items[2].context.sourceTaskIds);
      const mission = successTask(`mission-${missionCount}`, 'army.cross-agent-mission', 'ajun');
      const children = input.items.map((item) => ({ ...successTask(`${item.key}-${missionCount}`, item.taskType, item.agentId), parentTaskId:mission.taskId }));
      bindMissionFixture(input, mission, children);
      tasks.push(mission, ...children);
      return { mission, children };
    },
  };
  const service = new CapabilityAcceptanceBundle({ store, missions, policy, ledgerPath:path.join(root, 'ledger.json'), projectRoot:root, runtimeBoundarySnapshot:safeRuntimeBoundarySnapshot });
  const batch = await service.create();
  assert.equal(batch.roles.length, 10);
  assert.equal(batch.status, 'ready_for_decision');
  assert.equal(batch.acceptanceEligible, true);
  assert.deepEqual(batch.batchEvidence, {
    exactShape:true, missionCount:1, childCount:3, unexpectedBatchTaskCount:0,
    missionAuthorizationValid:true,
    authorizationValid:true, authorizationFailureCount:0,
    authorizationDigestValid:true,
    authorizationTokenDigest:batch.authorizationDigest,
    reservationAuthorizationDigest:batch.authorizationDigest,
    usageKnown:true, usageZero:true, modelCalls:0, costKnown:true, costUsd:0,
    creatorDraftOnly:true, technicalAcceptanceOnly:true, contentDraftOnly:true,
    contentSourceBindingsValid:true, outputDigestsValid:true,
  });
  assert.equal(batch.sourceEvidence.valid, true);
  assert.equal(batch.runtimeBoundary.safe, true);
  assert.deepEqual(batch.roles.find((item) => item.agentId === 'technical-expert'), {
    agentId:'technical-expert',
    name:'技术专家',
    verified:true,
    evidenceTaskId:'technical-expert-1',
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
  assert.equal((await service.create()).batchId, batch.batchId);
  assert.equal(missionCount, 1);
  const accepted = await service.decide(batch.batchId, { decision:'accepted', evidenceHash:batch.evidenceHash, note:'统一阅读通过' });
  assert.equal(accepted.decision.status, 'accepted');
  assert.equal(accepted.decision.historicalTaskStatusesChanged, false);
  for (const [taskId, status] of originalStatuses) assert.equal(tasks.find((item) => item.taskId === taskId).status, status);
  const [nextBatch, duplicateRequest] = await Promise.all([service.create(), service.create()]);
  assert.notEqual(nextBatch.batchId, batch.batchId);
  assert.equal(duplicateRequest.batchId, nextBatch.batchId);
  assert.equal(missionCount, 2);
});

test('mission 创建后响应中断时重试复用同一批次幂等标识', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maturity-retry-'));
  const ledgerPath = path.join(root, 'ledger.json');
  const tasks = seedTasks();
  const policy = await MissionChildPolicy.open({ keyPath:path.join(root, 'policy.key') });
  const attempts = [];
  let result = null;
  const missions = { async createBusinessMission(input) {
    attempts.push({ eventRef:input.source.eventRef, idempotencyKey:input.idempotencyKey });
    if (!result) {
      const mission = successTask('mission-recovered', 'army.cross-agent-mission', 'ajun');
      const children = input.items.map((item) => ({
        ...successTask(`${item.key}-recovered`, item.taskType, item.agentId),
        parentTaskId:mission.taskId,
      }));
      bindMissionFixture(input, mission, children);
      result = { mission, children };
      tasks.push(mission, ...children);
      throw new Error('response interrupted after mission persisted');
    }
    return result;
  } };
  const service = new CapabilityAcceptanceBundle({
    store:{ async list() { return tasks; } },
    missions,
    policy,
    ledgerPath,
    projectRoot:root,
    runtimeBoundarySnapshot:safeRuntimeBoundarySnapshot,
  });

  await assert.rejects(() => service.create(), /response interrupted/);
  const reservation = JSON.parse(await fs.readFile(ledgerPath, 'utf8')).batches[0];
  assert.equal(reservation.status, 'creation_unknown');
  assert.equal(reservation.missionTaskId, null);
  assert.equal(reservation.batchId, attempts[0].eventRef);
  assert.equal(reservation.sourceTaskIds.length, 2);

  const restartedService = new CapabilityAcceptanceBundle({
    store:{ async list() { return tasks; } },
    missions,
    policy,
    ledgerPath,
    projectRoot:root,
    runtimeBoundarySnapshot:safeRuntimeBoundarySnapshot,
  });
  const recovered = await restartedService.create();
  assert.equal(recovered.status, 'ready_for_decision');
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[1], attempts[0]);
  assert.deepEqual((await fs.readdir(root)).filter((name) => name.endsWith('.tmp')), []);
});

test('create 与 decide 共用串行锁，决定落账后并发 create 才追加新批次', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maturity-create-decide-lock-'));
  const tasks = seedTasks();
  let blockNextList = false;
  let markListStarted;
  let releaseList;
  const listStarted = new Promise((resolve) => { markListStarted = resolve; });
  const listReleased = new Promise((resolve) => { releaseList = resolve; });
  const store = { async list() {
    if (blockNextList) {
      blockNextList = false;
      markListStarted();
      await listReleased;
    }
    return tasks;
  } };
  const policy = await MissionChildPolicy.open({ keyPath:path.join(root, 'policy.key') });
  let missionCount = 0;
  const missions = { async createBusinessMission(input) {
    missionCount += 1;
    const mission = successTask(`mission-lock-${missionCount}`, 'army.cross-agent-mission', 'ajun');
    const children = input.items.map((item) => ({
      ...successTask(`${item.key}-lock-${missionCount}`, item.taskType, item.agentId),
      parentTaskId:mission.taskId,
    }));
    bindMissionFixture(input, mission, children);
    tasks.push(mission, ...children);
    return { mission, children };
  } };
  const service = new CapabilityAcceptanceBundle({
    store,
    missions,
    policy,
    ledgerPath:path.join(root, 'ledger.json'),
    projectRoot:root,
    runtimeBoundarySnapshot:safeRuntimeBoundarySnapshot,
  });
  const first = await service.create();

  blockNextList = true;
  const decisionPromise = service.decide(first.batchId, { decision:'accepted', evidenceHash:first.evidenceHash });
  await listStarted;
  let createSettled = false;
  const createPromise = service.create().finally(() => { createSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(createSettled, false);
  assert.equal(missionCount, 1);

  releaseList();
  const decision = await decisionPromise;
  const second = await createPromise;
  assert.equal(decision.status, 'accepted');
  assert.notEqual(second.batchId, first.batchId);
  assert.equal(missionCount, 2);
});

test('畸形账本 fail closed，不调用 mission 覆盖原状态', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maturity-malformed-ledger-'));
  const ledgerPath = path.join(root, 'ledger.json');
  await fs.writeFile(ledgerPath, JSON.stringify({
    schemaVersion:'agent.army/product-maturity-validation-ledger/v1',
    batches:{ corrupted:true },
  }));
  const policy = await MissionChildPolicy.open({ keyPath:path.join(root, 'policy.key') });
  let missionCount = 0;
  const service = new CapabilityAcceptanceBundle({
    store:{ async list() { return seedTasks(); } },
    missions:{ async createBusinessMission() { missionCount += 1; } },
    policy,
    ledgerPath,
    projectRoot:root,
    runtimeBoundarySnapshot:safeRuntimeBoundarySnapshot,
  });

  await assert.rejects(() => service.create(), /账本不可读取/);
  assert.equal(missionCount, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(ledgerPath, 'utf8')).batches, { corrupted:true });
});

test('证据变化后旧 hash 失效，不能静默登记验收', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maturity-stale-'));
  const tasks = seedTasks();
  const policy = await MissionChildPolicy.open({ keyPath:path.join(root, 'policy.key') });
  const missions = { async createBusinessMission(input) {
    const mission = successTask('mission-new', 'army.cross-agent-mission', 'ajun');
    const children = input.items.map((item) => ({ ...successTask(`${item.key}-new`, item.taskType, item.agentId), parentTaskId:mission.taskId }));
    bindMissionFixture(input, mission, children);
    tasks.push(mission, ...children); return { mission, children };
  } };
  const service = new CapabilityAcceptanceBundle({ store:{ async list() { return tasks; } }, missions, policy, ledgerPath:path.join(root, 'ledger.json'), projectRoot:root, runtimeBoundarySnapshot:safeRuntimeBoundarySnapshot });
  const batch = await service.create();
  tasks.find((item) => item.taskId === 'content-creator-new').artifactRefs[0].checksum = 'e'.repeat(64);
  await assert.rejects(() => service.decide(batch.batchId, { decision:'accepted', evidenceHash:batch.evidenceHash }), (error) => error.code === 'maturity_evidence_stale' && error.httpStatus === 409);
});

test('refresh 重验固定来源，来源 artifact 失效后 evidenceHash 与 acceptance 一起失效', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maturity-source-refresh-'));
  const tasks = seedTasks();
  const policy = await MissionChildPolicy.open({ keyPath:path.join(root, 'policy.key') });
  const missions = { async createBusinessMission(input) {
    const mission = successTask('mission-source-refresh', 'army.cross-agent-mission', 'ajun');
    const children = input.items.map((item) => ({ ...successTask(`${item.key}-source-refresh`, item.taskType, item.agentId), parentTaskId:mission.taskId }));
    bindMissionFixture(input, mission, children);
    tasks.push(mission, ...children);
    return { mission, children };
  } };
  const service = new CapabilityAcceptanceBundle({
    store:{ async list() { return tasks; } }, missions, policy,
    ledgerPath:path.join(root, 'ledger.json'), projectRoot:root,
    runtimeBoundarySnapshot:safeRuntimeBoundarySnapshot,
  });
  const initial = await service.create();
  tasks.find((task) => task.taskId.startsWith('10e4f814')).artifactRefs[0].validation.readable = false;
  const refreshed = await service.create();
  assert.notEqual(refreshed.evidenceHash, initial.evidenceHash);
  assert.equal(refreshed.sourceEvidence.valid, false);
  assert.equal(refreshed.acceptanceEligible, false);
});

test('当前批次 waiting_test 不得用历史成功替代，accepted 被拒但 revision_required 可登记', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maturity-current-batch-gate-'));
  const tasks = seedTasks();
  tasks.push(successTask('technical-expert-historical', 'operations.technical-repair', 'technical-expert'));
  const policy = await MissionChildPolicy.open({ keyPath:path.join(root, 'policy.key') });
  const missions = { async createBusinessMission(input) {
    const mission = successTask('mission-current-gate', 'army.cross-agent-mission', 'ajun');
    const children = input.items.map((item) => ({
      ...successTask(`${item.key}-current-gate`, item.taskType, item.agentId),
      parentTaskId:mission.taskId,
    }));
    bindMissionFixture(input, mission, children);
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
    runtimeBoundarySnapshot:safeRuntimeBoundarySnapshot,
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

test('当前批次出现额外同批次任务或未知费用时 acceptanceEligible fail closed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maturity-exact-batch-gate-'));
  const tasks = seedTasks();
  const policy = await MissionChildPolicy.open({ keyPath:path.join(root, 'policy.key') });
  const missions = { async createBusinessMission(input) {
    const mission = successTask('mission-exact-gate', 'army.cross-agent-mission', 'ajun');
    const children = input.items.map((item) => ({
      ...successTask(`${item.key}-exact-gate`, item.taskType, item.agentId),
      parentTaskId:mission.taskId,
    }));
    bindMissionFixture(input, mission, children);
    delete children[0].usage.cost;
    const extra = successTask('extra-batch-task', 'operations.health-review', 'operator');
    extra.source = { eventRef:input.source.eventRef };
    tasks.push(mission, ...children, extra);
    return { mission, children };
  } };
  const service = new CapabilityAcceptanceBundle({
    store:{ async list() { return tasks; } }, missions, policy,
    ledgerPath:path.join(root, 'ledger.json'), projectRoot:root,
    runtimeBoundarySnapshot:safeRuntimeBoundarySnapshot,
  });

  const batch = await service.create();
  assert.equal(batch.status, 'ready_for_decision');
  assert.equal(batch.acceptanceEligible, false);
  assert.equal(batch.batchEvidence.exactShape, false);
  assert.equal(batch.batchEvidence.unexpectedBatchTaskCount, 1);
  assert.equal(batch.batchEvidence.usageKnown, false);
  assert.equal(batch.batchEvidence.costKnown, false);
});

test('子任务授权的 step/idempotency/source/mission binding 任一漂移都会阻断 accepted', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maturity-child-authorization-'));
  const tasks = seedTasks();
  const policy = await MissionChildPolicy.open({ keyPath:path.join(root, 'policy.key') });
  const missions = { async createBusinessMission(input) {
    const mission = successTask('mission-auth-binding', 'army.cross-agent-mission', 'ajun');
    const children = input.items.map((item) => ({ ...successTask(`${item.key}-auth-binding`, item.taskType, item.agentId), parentTaskId:mission.taskId }));
    bindMissionFixture(input, mission, children);
    children[2].source.missionTaskId = 'mission-tampered';
    tasks.push(mission, ...children);
    return { mission, children };
  } };
  const service = new CapabilityAcceptanceBundle({
    store:{ async list() { return tasks; } }, missions, policy,
    ledgerPath:path.join(root, 'ledger.json'), projectRoot:root,
    runtimeBoundarySnapshot:safeRuntimeBoundarySnapshot,
  });

  const batch = await service.create();
  assert.equal(batch.batchEvidence.authorizationValid, false);
  assert.equal(batch.batchEvidence.authorizationFailureCount, 1);
  assert.equal(batch.acceptanceEligible, false);
});

test('mission 与三个 child 的 token 虽有效但不匹配 reservation authorizationDigest 时阻断 accepted', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maturity-authorization-digest-'));
  const tasks = seedTasks();
  const policy = await MissionChildPolicy.open({ keyPath:path.join(root, 'policy.key') });
  const missions = { async createBusinessMission(input) {
    const mission = successTask('mission-authorization-digest', 'army.cross-agent-mission', 'ajun');
    const children = input.items.map((item) => ({ ...successTask(`${item.key}-authorization-digest`, item.taskType, item.agentId), parentTaskId:mission.taskId }));
    bindMissionFixture(input, mission, children);
    const replacement = policy.issue(input.source.eventRef, input.items, new Date(Date.now() + 1_000));
    mission.input.context.businessMissionItems = input.items.map((item) => ({
      ...item,
      context:{ ...item.context, productMaturityAuthorization:replacement },
    }));
    children.forEach((child) => { child.input.context.productMaturityAuthorization = replacement; });
    tasks.push(mission, ...children);
    return { mission, children };
  } };
  const service = new CapabilityAcceptanceBundle({
    store:{ async list() { return tasks; } }, missions, policy,
    ledgerPath:path.join(root, 'ledger.json'), projectRoot:root,
    runtimeBoundarySnapshot:safeRuntimeBoundarySnapshot,
  });

  const batch = await service.create();
  assert.equal(batch.batchEvidence.missionAuthorizationValid, true);
  assert.equal(batch.batchEvidence.authorizationFailureCount, 0);
  assert.equal(batch.batchEvidence.authorizationDigestValid, false);
  assert.notEqual(batch.batchEvidence.authorizationTokenDigest, batch.authorizationDigest);
  assert.equal(batch.acceptanceEligible, false);
});

test('小创自洽但虚假的 sourceTaskBindings/sourceRefs 不能替代固定来源真实 artifactId', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maturity-bogus-source-binding-'));
  const tasks = seedTasks();
  const policy = await MissionChildPolicy.open({ keyPath:path.join(root, 'policy.key') });
  const missions = { async createBusinessMission(input) {
    const mission = successTask('mission-bogus-binding', 'army.cross-agent-mission', 'ajun');
    const children = input.items.map((item) => ({ ...successTask(`${item.key}-bogus-binding`, item.taskType, item.agentId), parentTaskId:mission.taskId }));
    bindMissionFixture(input, mission, children);
    const contentArtifact = children[2].artifactRefs[0];
    contentArtifact.sourceRefs = ['bogus-transcript', 'bogus-analysis'];
    contentArtifact.data.sourceTaskBindings = contentArtifact.data.sourceTaskIds.map((taskId, index) => ({
      taskId,
      artifactIds:[contentArtifact.sourceRefs[index]],
    }));
    tasks.push(mission, ...children);
    return { mission, children };
  } };
  const service = new CapabilityAcceptanceBundle({
    store:{ async list() { return tasks; } }, missions, policy,
    ledgerPath:path.join(root, 'ledger.json'), projectRoot:root,
    runtimeBoundarySnapshot:safeRuntimeBoundarySnapshot,
  });

  const batch = await service.create();
  assert.equal(batch.sourceEvidence.valid, true);
  assert.equal(batch.batchEvidence.contentSourceBindingsValid, false);
  assert.equal(batch.acceptanceEligible, false);
});

test('固定来源或批次输出 artifact 缺少内容 digest 时 fail closed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maturity-null-digest-'));
  const tasks = seedTasks();
  tasks[0].artifactRefs[0].checksum = null;
  const policy = await MissionChildPolicy.open({ keyPath:path.join(root, 'policy.key') });
  const missions = { async createBusinessMission(input) {
    const mission = successTask('mission-null-digest', 'army.cross-agent-mission', 'ajun');
    const children = input.items.map((item) => ({ ...successTask(`${item.key}-null-digest`, item.taskType, item.agentId), parentTaskId:mission.taskId }));
    bindMissionFixture(input, mission, children);
    children[2].artifactRefs[0].checksum = null;
    tasks.push(mission, ...children);
    return { mission, children };
  } };
  const service = new CapabilityAcceptanceBundle({
    store:{ async list() { return tasks; } }, missions, policy,
    ledgerPath:path.join(root, 'ledger.json'), projectRoot:root,
    runtimeBoundarySnapshot:safeRuntimeBoundarySnapshot,
  });

  const batch = await service.create();
  assert.equal(batch.sourceEvidence.valid, false);
  assert.equal(batch.batchEvidence.outputDigestsValid, false);
  assert.equal(batch.acceptanceEligible, false);
});

test('mission 与三个 child 的模型和费用合并计算，mission 非零即阻断 accepted', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maturity-mission-usage-'));
  const tasks = seedTasks();
  const policy = await MissionChildPolicy.open({ keyPath:path.join(root, 'policy.key') });
  const missions = { async createBusinessMission(input) {
    const mission = successTask('mission-nonzero-usage', 'army.cross-agent-mission', 'ajun');
    const children = input.items.map((item) => ({ ...successTask(`${item.key}-nonzero-usage`, item.taskType, item.agentId), parentTaskId:mission.taskId }));
    bindMissionFixture(input, mission, children);
    mission.usage.model.apiCalls = 1;
    mission.usage.cost.amount = 0.01;
    tasks.push(mission, ...children);
    return { mission, children };
  } };
  const service = new CapabilityAcceptanceBundle({
    store:{ async list() { return tasks; } }, missions, policy,
    ledgerPath:path.join(root, 'ledger.json'), projectRoot:root,
    runtimeBoundarySnapshot:safeRuntimeBoundarySnapshot,
  });

  const batch = await service.create();
  assert.equal(batch.batchEvidence.usageKnown, true);
  assert.equal(batch.batchEvidence.usageZero, false);
  assert.equal(batch.batchEvidence.modelCalls, 1);
  assert.equal(batch.batchEvidence.costUsd, 0.01);
  assert.equal(batch.acceptanceEligible, false);
});

test('历史岗位证据必须匹配 assignee，且早于最新失败时不得 verified', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maturity-historical-freshness-'));
  const tasks = seedTasks();
  const staleReview = tasks.find((task) => task.taskId === 'review-existing');
  staleReview.updatedAt = '2026-08-10T00:01:00.000Z';
  const latestFailure = successTask('review-failed-later', 'governance.approval-review', 'reviewer');
  latestFailure.status = 'failed';
  latestFailure.updatedAt = '2026-08-10T00:02:00.000Z';
  const wrongAssignee = successTask('review-wrong-assignee', 'governance.approval-review', 'architect');
  wrongAssignee.updatedAt = '2026-08-10T00:03:00.000Z';
  tasks.push(latestFailure, wrongAssignee);
  const policy = await MissionChildPolicy.open({ keyPath:path.join(root, 'policy.key') });
  const missions = { async createBusinessMission(input) {
    const mission = successTask('mission-history', 'army.cross-agent-mission', 'ajun');
    const children = input.items.map((item) => ({ ...successTask(`${item.key}-history`, item.taskType, item.agentId), parentTaskId:mission.taskId }));
    bindMissionFixture(input, mission, children);
    tasks.push(mission, ...children);
    return { mission, children };
  } };
  const service = new CapabilityAcceptanceBundle({
    store:{ async list() { return tasks; } }, missions, policy,
    ledgerPath:path.join(root, 'ledger.json'), projectRoot:root,
    runtimeBoundarySnapshot:safeRuntimeBoundarySnapshot,
  });

  const batch = await service.create();
  const reviewer = batch.roles.find((row) => row.agentId === 'reviewer');
  assert.equal(reviewer.evidenceTaskId, 'review-existing');
  assert.equal(reviewer.freshness, 'predates_latest_failure');
  assert.equal(reviewer.verified, false);
  assert.equal(batch.acceptanceEligible, false);
});

test('Publisher/Campaign/Cron 边界 active 或 unknown 时 fail closed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maturity-runtime-boundary-'));
  const tasks = seedTasks();
  const policy = await MissionChildPolicy.open({ keyPath:path.join(root, 'policy.key') });
  let boundary = { ...safeRuntimeBoundarySnapshot(), campaigns:{ activeCount:1 } };
  const missions = { async createBusinessMission(input) {
    const mission = successTask('mission-runtime-boundary', 'army.cross-agent-mission', 'ajun');
    const children = input.items.map((item) => ({ ...successTask(`${item.key}-runtime-boundary`, item.taskType, item.agentId), parentTaskId:mission.taskId }));
    bindMissionFixture(input, mission, children);
    tasks.push(mission, ...children);
    return { mission, children };
  } };
  const service = new CapabilityAcceptanceBundle({
    store:{ async list() { return tasks; } }, missions, policy,
    ledgerPath:path.join(root, 'ledger.json'), projectRoot:root,
    runtimeBoundarySnapshot:async () => boundary,
  });

  const active = await service.create();
  assert.equal(active.runtimeBoundary.known, true);
  assert.equal(active.runtimeBoundary.safe, false);
  assert.equal(active.runtimeBoundary.campaignActiveCount, 1);
  assert.equal(active.acceptanceEligible, false);
  boundary = {
    schemaVersion:'agent.army/product-maturity-runtime-boundary/v1',
    publisher:{ disabled:true }, campaigns:{ activeCount:0 }, cron:{ disabled:true },
  };
  const missingIdentity = await service.create();
  assert.equal(missingIdentity.runtimeBoundary.observationIdentityValid, false);
  assert.equal(missingIdentity.runtimeBoundary.known, false);
  assert.equal(missingIdentity.runtimeBoundary.safe, false);
  boundary = null;
  const unknown = await service.create();
  assert.equal(unknown.runtimeBoundary.known, false);
  assert.equal(unknown.runtimeBoundary.safe, false);
  assert.equal(unknown.acceptanceEligible, false);
});

test('过期 creating/creation_unknown reservation 转 recovery_required，禁止重发授权或创建新批次', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maturity-expired-reservation-'));
  const ledgerPath = path.join(root, 'ledger.json');
  const record = legacyBatchRecord({
    batchId:'maturity-11111111-1111-4111-8111-111111111111',
    status:'creating',
    missionTaskId:null,
    createdAt:'2026-08-10T00:00:00.000Z',
    updatedAt:'2026-08-10T00:00:00.000Z',
  });
  await writeLedgerFixture(ledgerPath, [record]);
  const policy = await MissionChildPolicy.open({ keyPath:path.join(root, 'policy.key') });
  let missionCount = 0;
  const service = new CapabilityAcceptanceBundle({
    store:{ async list() { throw new Error('expired reservation must not list tasks'); } },
    missions:{ async createBusinessMission() { missionCount += 1; } },
    policy, ledgerPath, projectRoot:root,
    now:() => new Date('2026-08-11T00:00:00.000Z'),
    runtimeBoundarySnapshot:safeRuntimeBoundarySnapshot,
  });

  const recovered = await service.create();
  assert.equal(recovered.status, 'recovery_required');
  assert.equal(recovered.recovery.automaticRetryAllowed, false);
  assert.equal(missionCount, 0);
  assert.equal((JSON.parse(await fs.readFile(ledgerPath, 'utf8'))).batches.length, 1);

  const unknownRecord = legacyBatchRecord({
    batchId:'maturity-44444444-4444-4444-8444-444444444444',
    status:'creation_unknown',
    missionTaskId:null,
    createdAt:'2026-08-10T00:00:00.000Z',
    updatedAt:'2026-08-10T00:00:01.000Z',
  });
  await writeLedgerFixture(ledgerPath, [unknownRecord]);
  const unknownService = new CapabilityAcceptanceBundle({
    store:{ async list() { throw new Error('expired reservation must not list tasks'); } },
    missions:{ async createBusinessMission() { missionCount += 1; } },
    policy, ledgerPath, projectRoot:root,
    now:() => new Date('2026-08-11T00:00:00.000Z'),
    runtimeBoundarySnapshot:safeRuntimeBoundarySnapshot,
  });
  const unknownRecovered = await unknownService.create();
  assert.equal(unknownRecovered.status, 'recovery_required');
  assert.equal(missionCount, 0);
});

test('旧 v1 未决 mission 账本仍可读取并复用，不会创建第二个 mission', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maturity-legacy-v1-'));
  const ledgerPath = path.join(root, 'ledger.json');
  const batchId = 'maturity-22222222-2222-4222-8222-222222222222';
  const mission = successTask('legacy-mission', 'army.cross-agent-mission', 'ajun');
  mission.input = { context:{ productMaturityBatchId:batchId } };
  const tasks = [...seedTasks(), mission];
  await writeLedgerFixture(ledgerPath, [legacyBatchRecord({ batchId, missionTaskId:mission.taskId, status:'running' })]);
  const policy = await MissionChildPolicy.open({ keyPath:path.join(root, 'policy.key') });
  let missionCount = 0;
  const service = new CapabilityAcceptanceBundle({
    store:{ async list() { return tasks; } },
    missions:{ async createBusinessMission() { missionCount += 1; } },
    policy, ledgerPath, projectRoot:root,
    runtimeBoundarySnapshot:safeRuntimeBoundarySnapshot,
  });

  const reused = await service.create();
  assert.equal(reused.batchId, batchId);
  assert.equal(reused.status, 'running');
  assert.equal(missionCount, 0);
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
  task.artifactRefs[0].artifactId = `${artifactType}:${taskId}`;
  return task;
}

function successTask(taskId, taskType, assigneeAgentId) {
  const task = {
    taskId, taskType, assigneeAgentId, status:'succeeded',
    createdAt:'2026-08-10T00:00:00.000Z', updatedAt:'2026-08-10T00:01:00.000Z',
    artifactRefs:[{
      artifactId:`verified_output:${taskId}`,
      type:'verified_output',
      location:`fixture://${taskId}`,
      checksum:'a'.repeat(64),
      validation:{ exists:true, readable:true, nonEmpty:true },
    }],
  };
  if (taskType === 'army.cross-agent-mission') task.usage = knownZeroUsage();
  if (taskType === 'governance.agent-proposal') {
    task.artifactRefs = [{ artifactId:`agent_proposal:${taskId}`, type:'agent_proposal', checksum:'b'.repeat(64), validation:{ exists:true, readable:true, nonEmpty:true }, data:{ status:'draft', reviewSubmission:{ status:'pending' } } }];
    task.usage = knownZeroUsage();
  }
  if (taskType === 'operations.technical-repair') {
    task.artifactRefs = [{ artifactId:`technical_repair_case:${taskId}`, type:'technical_repair_case', checksum:'c'.repeat(64), validation:{ exists:true, readable:true, nonEmpty:true } }];
    task.execution = { technicalRepair:{ verification:{ acceptanceOnly:true, testsPassed:true, recoveryVerified:true } } };
    task.usage = knownZeroUsage();
  }
  if (taskType === 'content.video-script-package') {
    const sourceTaskIds = ['10e4f814-1111-4111-8111-111111111111', 'b5403cd9-1111-4111-8111-111111111111'];
    const sourceArtifactIds = [`confirmed_transcript:${sourceTaskIds[0]}`, `video_content_analysis_report:${sourceTaskIds[1]}`];
    task.artifactRefs = [{
      artifactId:`video_script_package:${taskId}`,
      type:'video_script_package',
      checksum:'d'.repeat(64),
      sourceRefs:sourceArtifactIds,
      validation:{ exists:true, readable:true, nonEmpty:true, fileCount:5, externalSideEffects:0 },
      data:{
        publishingStatus:'draft_only', generationMode:'deterministic_fallback',
        templateLifecycle:{ approvedForUse:false }, sourceTaskIds,
        sourceTaskBindings:sourceTaskIds.map((sourceTaskId, index) => ({ taskId:sourceTaskId, artifactIds:[sourceArtifactIds[index]] })),
      },
    }];
    task.usage = knownZeroUsage();
  }
  return task;
}

function bindMissionFixture(input, mission, children) {
  mission.idempotencyKey = input.idempotencyKey;
  mission.source = input.source;
  mission.input = { context:{
    productMaturityBatchId:input.source.eventRef,
    businessMissionItems:input.items,
  } };
  mission.usage = knownZeroUsage();
  children.forEach((child, index) => {
    const item = input.items[index];
    child.parentTaskId = mission.taskId;
    child.idempotencyKey = `${input.idempotencyKey}:${item.key}`;
    child.source = { ...input.source, channel:'army-mission', missionTaskId:mission.taskId };
    child.input = {
      title:item.title,
      description:[item.description, `来自多人协作分工。验收：${item.acceptance}`].filter(Boolean).join('\n'),
      platforms:item.platforms || [],
      contentGoal:item.contentGoal || null,
      researchMode:item.researchMode === 'off' ? 'off' : 'auto',
      approvedForUse:item.approvedForUse === true,
      context:{ ...(item.context || {}), missionTaskId:mission.taskId, dependsOn:item.dependsOn || [] },
    };
    child.workflow = { step:{ key:item.key } };
  });
}

function safeRuntimeBoundarySnapshot() {
  return {
    schemaVersion:'agent.army/product-maturity-runtime-boundary/v1',
    publisher:{ disabled:true },
    campaigns:{ activeCount:0 },
    cron:{ disabled:true },
    revision:`sha256:${'f'.repeat(64)}`,
  };
}

function legacyBatchRecord(overrides = {}) {
  return {
    schemaVersion:'agent.army/product-maturity-validation-batch/v1',
    batchId:'maturity-33333333-3333-4333-8333-333333333333',
    createdAt:'2026-08-10T00:00:00.000Z',
    updatedAt:'2026-08-10T00:00:00.000Z',
    status:'running',
    missionTaskId:'legacy-mission',
    childTaskIds:[],
    sourceTaskIds:[
      '10e4f814-1111-4111-8111-111111111111',
      'b5403cd9-1111-4111-8111-111111111111',
    ],
    policy:{ maxModelCalls:4, maxCostUsd:0.08, externalActions:false, publishing:false },
    authorizationDigest:'a'.repeat(64),
    decision:null,
    ...overrides,
  };
}

async function writeLedgerFixture(ledgerPath, batches) {
  await fs.writeFile(ledgerPath, JSON.stringify({
    schemaVersion:'agent.army/product-maturity-validation-ledger/v1',
    batches,
  }));
}

function knownZeroUsage() {
  return {
    schemaVersion:'agent.army/task-usage/v1',
    model:{ status:'reported', apiCalls:0 },
    cost:{ status:'reported', currency:'USD', amount:0 },
  };
}

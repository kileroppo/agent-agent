import assert from 'node:assert/strict';
import test from 'node:test';
import {
  consumeM5SystemPlanRevision,
  deriveM5StageRecoveryState,
  getActiveM5PlanRevision,
  m5StageWorkProductCandidates,
  M5StageRecoveryController,
  M5StageRecoveryError,
  M5StageRecoveryLedger,
  planM5StageFailureRecovery,
} from '../src/m5-stage-recovery-controller.ts';
import {
  consumeM5SystemPlanRevision as kernelConsumeM5SystemPlanRevision,
  deriveM5StageRecoveryState as kernelDeriveM5StageRecoveryState,
  getActiveM5PlanRevision as kernelGetActiveM5PlanRevision,
  M5StageRecoveryController as KernelM5StageRecoveryController,
  M5StageRecoveryError as KernelM5StageRecoveryError,
  planM5StageFailureRecovery as kernelPlanM5StageFailureRecovery,
} from '@agent-army/m5-kernel/stage-recovery-controller';
import { getM5RoutineExecutionContract } from '@agent-army/m5-kernel/routine-execution-contract';

const CASE_ID = '11111111-1111-4111-8111-111111111111';
const ISSUE_ID = '22222222-2222-4222-8222-222222222222';
const CONTENT_CASE_ID = '66666666-6666-4666-8666-666666666666';
const contract = getM5RoutineExecutionContract('m5-voice');
const renderContract = getM5RoutineExecutionContract('m5-render');

test('M5 阶段恢复账本对调用方只暴露三个业务动作', () => {
  assert.deepEqual(
    Object.getOwnPropertyNames(M5StageRecoveryLedger.prototype)
      .filter((name) => name !== 'constructor')
      .sort(),
    ['consumeSystemPlanRevision', 'getActivePlanRevision', 'recordFailure'],
  );
});

test('A君恢复门面保留 Kernel 旧函数与错误类 identity', () => {
  assert.equal(consumeM5SystemPlanRevision, kernelConsumeM5SystemPlanRevision);
  assert.equal(deriveM5StageRecoveryState, kernelDeriveM5StageRecoveryState);
  assert.equal(getActiveM5PlanRevision, kernelGetActiveM5PlanRevision);
  assert.equal(M5StageRecoveryController, KernelM5StageRecoveryController);
  assert.equal(M5StageRecoveryError, KernelM5StageRecoveryError);
  assert.equal(planM5StageFailureRecovery, kernelPlanM5StageFailureRecovery);
  assert.throws(
    () => new M5StageRecoveryController({ maxStageRetries:0 }),
    (error) => error instanceof M5StageRecoveryError,
  );
});

test('同阶段候选选择器识别stageKey、kind或schema任一声明并忽略无关产物', () => {
  const candidate = (metadata) => ({
    kind:'work_product',
    type:'artifact',
    metadata,
  });
  const selected = m5StageWorkProductCandidates([
    candidate({ stageKey:contract.stageKey }),
    candidate({ kind:contract.expectedWorkProduct.type }),
    candidate({ schemaVersion:contract.expectedWorkProduct.schemaVersion }),
    candidate({
      stageKey:'research',
      kind:'EvidencePackage',
      schemaVersion:'agent.army/evidence-package/v1',
    }),
    { kind:'attachment', type:'artifact', metadata:{ stageKey:contract.stageKey } },
  ], contract);
  assert.equal(selected.length, 3);
});

test('M5 单阶段失败安排两次安全重试，第三次转为内容重规划', async () => {
  const governance = new RecoveryFakeGovernance();
  const controller = recoveryController(governance);

  assert.equal((await fail(controller, governance, 'run-0001')).action, 'retry');
  assert.equal(storedStageRecovery(governance).stageAttempt, 1);
  assert.equal((await fail(controller, governance, 'run-0002')).action, 'retry');
  assert.equal(storedStageRecovery(governance).stageAttempt, 2);

  const replanned = await fail(controller, governance, 'run-0003');
  assert.equal(replanned.action, 'replan');
  assert.equal(replanned.replanCount, 1);
  assert.equal(storedStageRecovery(governance).stageAttempt, 0);
  assert.equal(storedStageRecovery(governance).replanCount, 1);
  assert.equal(governance.issueUpdates.at(-1).status, 'todo');
});

test('恢复账本直接返回当前阶段可消费的 PlanRevision', async () => {
  const governance = new RecoveryFakeGovernance();
  const controller = recoveryController(governance);
  await fail(controller, governance, 'run-active-0001');
  await fail(controller, governance, 'run-active-0002');
  const replanned = await fail(controller, governance, 'run-active-0003');

  const active = await getActiveM5PlanRevision({
    governance,
    pipelineCaseId:CASE_ID,
    stageKey:contract.stageKey,
  });
  assert.equal(active.revisionId, replanned.planRevision.revisionId);
  assert.equal(active.nextRoute.stageKey, contract.stageKey);
});

test('控制器构造后替换 Governance、上限和时钟仍在下次恢复生效', async () => {
  const original = new RecoveryFakeGovernance();
  const replacement = new RecoveryFakeGovernance();
  const controller = recoveryController(original);
  controller.governance = replacement;
  controller.maxStageRetries = 1;
  controller.now = () => new Date('2026-08-13T08:09:10.000Z');

  await fail(controller, replacement, 'run-override-0001');
  const replanned = await fail(controller, replacement, 'run-override-0002');

  assert.equal(replanned.action, 'replan');
  assert.equal(replanned.occurredAt, '2026-08-13T08:09:10.000Z');
  assert.equal(original.casePatches, 0);
  assert.equal(replacement.casePatches, 2);
});

test('CAS 冲突会重读完整快照，且只在 patch 成功后更新 Issue', async () => {
  const governance = new ConflictOnceRecoveryGovernance();
  const controller = recoveryController(governance);

  const result = await fail(controller, governance, 'run-conflict-0001');

  assert.equal(result.action, 'retry');
  assert.deepEqual(governance.operationLog, [
    'get-case', 'get-issue', 'get-runs', 'get-events', 'get-outputs', 'patch-conflict',
    'get-case', 'get-issue', 'get-runs', 'get-events', 'get-outputs', 'patch-success',
    'reopen-issue',
  ]);
  assert.equal(governance.casePatches, 1);
});

test('PlanRevision 读取可复用已读 Case，消费 CAS 冲突只重读 Case 再写回执', async () => {
  const systemContract = getM5RoutineExecutionContract('m5-publish');
  const governance = new ConflictOnceRecoveryGovernance({ conflictCount:0 });
  const controller = recoveryController(governance);
  await failWithContract(controller, governance, systemContract, 'run-plan-0001');
  await failWithContract(controller, governance, systemContract, 'run-plan-0002');
  const replanned = await failWithContract(
    controller,
    governance,
    systemContract,
    'run-plan-0003',
  );
  governance.operationLog = [];

  const active = await getActiveM5PlanRevision({
    governance,
    pipelineCaseId:CASE_ID,
    stageKey:systemContract.stageKey,
    pipelineCase:structuredClone(governance.caseItem),
  });
  assert.equal(active.revisionId, replanned.planRevision.revisionId);
  assert.deepEqual(governance.operationLog, []);

  governance.conflictCount = 1;
  const receipt = await consumeM5SystemPlanRevision({
    governance,
    pipelineCaseId:CASE_ID,
    stageKey:systemContract.stageKey,
    runId:'run-plan-consume-0004',
    routeSummary:'系统控制器已重新从当前 Case 派生本次执行输入。',
    now:() => new Date('2026-08-13T09:10:11.000Z'),
  });
  assert.equal(receipt.revisionId, replanned.planRevision.revisionId);
  assert.deepEqual(governance.operationLog, [
    'get-case', 'patch-conflict',
    'get-case', 'patch-success',
  ]);
});

test('M5 内容最多重规划三次，之后 Case blocked 且只写一个恢复动作', async () => {
  const governance = new RecoveryFakeGovernance();
  const controller = recoveryController(governance);
  const decisions = [];
  for (let index = 1; index <= 12; index += 1) {
    decisions.push(await fail(
      controller,
      governance,
      `run-${String(index).padStart(4, '0')}`,
    ));
  }

  assert.deepEqual(
    decisions.map((item) => item.action),
    [
      'retry', 'retry', 'replan',
      'retry', 'retry', 'replan',
      'retry', 'retry', 'replan',
      'retry', 'retry', 'blocked',
    ],
  );
  const recovery = storedStageRecovery(governance);
  assert.equal(recovery.status, 'blocked');
  assert.equal(recovery.replanCount, 3);
  assert.deepEqual(Object.keys(recovery.recoveryAction).sort(), ['action', 'id', 'instruction']);
  assert.equal(recovery.recoveryAction.action, 'owner_restore_current_stage');
  assert.match(recovery.recoveryAction.instruction, /仅恢复当前 Case/);
  assert.equal(governance.issueUpdates.at(-1).status, 'blocked');
  assert.equal(governance.casePatches, 12);
});

test('内容重规划次数跨阶段累计，不能通过切换阶段重置三次上限', async () => {
  const governance = new RecoveryFakeGovernance();
  const controller = recoveryController(governance);

  await fail(controller, governance, 'run-voice-0001');
  await fail(controller, governance, 'run-voice-0002');
  const voiceReplan = await fail(controller, governance, 'run-voice-0003');
  assert.equal(voiceReplan.replanCount, 1);

  governance.caseItem.stageKey = 'render';
  governance.runs = [];
  const firstRender = await failWithContract(
    controller,
    governance,
    renderContract,
    'run-render-0001',
  );
  const secondRender = await failWithContract(
    controller,
    governance,
    renderContract,
    'run-render-0002',
  );
  const renderReplan = await failWithContract(
    controller,
    governance,
    renderContract,
    'run-render-0003',
  );

  assert.equal(firstRender.action, 'retry');
  assert.equal(secondRender.action, 'retry');
  assert.equal(renderReplan.action, 'replan');
  assert.equal(renderReplan.replanCount, 2);
  assert.equal(governance.caseItem.fields.m5ContentRecovery.replanCount, 2);
  assert.deepEqual(
    [...new Set(governance.caseItem.fields.m5ContentRecovery.history.map((item) => item.stageKey))],
    ['voice', 'render'],
  );
});

test('并行分支和平台子 Case 共用日期内容根的三次重规划上限', async () => {
  const governance = new DescendantRecoveryFakeGovernance();
  const controller = recoveryController(governance);

  await fail(controller, governance, 'run-branch-0001');
  await fail(controller, governance, 'run-branch-0002');
  await fail(controller, governance, 'run-branch-0003');
  assert.equal(governance.contentCase.fields.m5ContentRecovery.replanCount, 1);
  assert.equal(governance.caseItem.fields.m5ContentRecovery, undefined);

  governance.caseItem = {
    id:CASE_ID,
    version:1,
    parentCaseId:CONTENT_CASE_ID,
    caseKey:'campaign-fixture:2026-07-30:douyin:v1',
    stageKey:'render',
    fields:{
      campaignId:'campaign-fixture',
      scheduledDate:'2026-07-30',
      platform:'douyin',
      contentVersion:'v1',
    },
  };
  governance.runs = [];
  await failWithContract(controller, governance, renderContract, 'run-platform-0001');
  await failWithContract(controller, governance, renderContract, 'run-platform-0002');
  const replanned = await failWithContract(
    controller,
    governance,
    renderContract,
    'run-platform-0003',
  );

  assert.equal(replanned.replanCount, 2);
  assert.equal(governance.contentCase.fields.m5ContentRecovery.replanCount, 2);
  assert.deepEqual(
    governance.contentCase.fields.m5ContentRecovery.history.map((item) => item.stageKey),
    ['voice', 'render'],
  );
});

test('同一 Paperclip Run 重放不重复计数或写 Case，重启后从持久字段继续', async () => {
  const governance = new RecoveryFakeGovernance();
  const firstController = recoveryController(governance);
  const first = await fail(firstController, governance, 'run-replay-0001');
  const patchesAfterFirst = governance.casePatches;

  const replayed = await fail(firstController, governance, 'run-replay-0001');
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.action, first.action);
  assert.equal(governance.casePatches, patchesAfterFirst);
  assert.equal(storedStageRecovery(governance).history.length, 1);

  const restartedController = recoveryController(governance);
  const resumed = await fail(restartedController, governance, 'run-replay-0002');
  assert.equal(resumed.action, 'retry');
  assert.equal(resumed.stageAttempt, 2);
  assert.equal(storedStageRecovery(governance).history.length, 2);
});

test('Case 字段缺失时可从 Paperclip Issue/事件与 Run 推导计数', () => {
  const state = deriveM5StageRecoveryState({
    assignment:assignment('run-event-0003'),
    contract,
    caseItem:{ id:CASE_ID, version:4, fields:{} },
    issue:{
      metadata:{
        m5StageRecovery:{
          schemaVersion:'agent.army/m5-stage-recovery/v1',
          stageKey:'voice',
          stageAttempt:0,
          replanCount:1,
          history:[],
        },
      },
    },
    runs:[
      { id:'run-event-0001', status:'failed' },
      { id:'run-event-0002', status:'failed' },
      { id:'run-event-0003', status:'running' },
    ],
    events:[{
      payload:{
        fields:{
          m5StageRecovery:{
            schemaVersion:'agent.army/m5-stage-recovery/v1',
            stageKey:'voice',
            stageAttempt:0,
            replanCount:1,
            history:[{
              runId:'run-event-0002',
              action:'replan',
              stageKey:'voice',
              stageAttempt:3,
              replanCount:1,
            }],
          },
        },
      },
    }],
  });

  assert.equal(state.stageAttempt, 1);
  assert.equal(state.replanCount, 1);
  assert.equal(state.history[0].action, 'replan');
  assert.deepEqual(state.failedRunIds.sort(), ['run-event-0001', 'run-event-0002']);
});

test('Case 已有唯一健康 Work Product 时只完成 Issue，不重写 Case 或重复产物', async () => {
  const governance = new RecoveryFakeGovernance();
  governance.outputs.push({
    id:'work-product-voice',
    kind:'work_product',
    type:'artifact',
    provider:'agent-army.ajun-runtime',
    externalId:`sha256:${'b'.repeat(64)}`,
    sourceTrust:null,
    status:'active',
    healthStatus:'healthy',
    metadata:{
      schemaVersion:contract.expectedWorkProduct.schemaVersion,
      kind:contract.expectedWorkProduct.type,
      stageKey:contract.stageKey,
      sourceTaskId:'task-voice-0001',
      sourceArtifactId:'artifact-voice-0001',
      artifactHash:`sha256:${'b'.repeat(64)}`,
      artifact:{
        model:'stepaudio-2.5-tts',
        voice:'official-voice-1',
        relativePath:'campaigns/voice.mp3',
        checksum:`sha256:${'a'.repeat(64)}`,
        bytes:1024,
      },
    },
  });
  let validations = 0;
  const controller = recoveryController(governance, {
    workProductValidator:async ({ product, targetCaseId }) => {
      validations += 1;
      assert.equal(product.id, 'work-product-voice');
      assert.equal(targetCaseId, CASE_ID);
    },
  });
  const result = await fail(controller, governance, 'run-existing-wp');

  assert.equal(result.action, 'verified_work_product');
  assert.equal(result.replayed, true);
  assert.equal(governance.casePatches, 0);
  assert.equal(governance.outputs.length, 1);
  assert.equal(governance.issueUpdates.at(-1).status, 'done');
  assert.equal(validations, 1);
});

test('恢复入口同阶段合法加漂移、两个合法都硬停，无关阶段输出不影响恢复', async (t) => {
  for (const variant of ['valid-plus-drift', 'drift-plus-valid', 'two-valid', 'unrelated']) {
    await t.test(variant, async () => {
      const governance = new RecoveryFakeGovernance();
      const valid = recoveryVoiceWorkProduct('work-product-valid');
      const extra = recoveryVoiceWorkProduct(`work-product-${variant}`);
      if (variant.includes('drift')) {
        extra.provider = 'forged.provider';
      } else if (variant === 'unrelated') {
        extra.metadata.stageKey = 'research';
        extra.metadata.schemaVersion = 'agent.army/evidence-package/v1';
        extra.metadata.kind = 'EvidencePackage';
      }
      governance.outputs.push(...(
        variant === 'drift-plus-valid' ? [extra, valid] : [valid, extra]
      ));
      const controller = recoveryController(governance, {
        workProductValidator:async () => true,
      });
      if (variant === 'unrelated') {
        assert.equal(
          (await fail(controller, governance, `run-${variant}`)).action,
          'verified_work_product',
        );
      } else {
        await assert.rejects(
          () => fail(controller, governance, `run-${variant}`),
          /多个 Work Product 候选|未解决漂移/,
        );
        assert.equal(governance.issueUpdates.length, 0);
      }
      assert.equal(governance.casePatches, 0);
      assert.equal(governance.outputs.length, 2);
    });
  }
});

test('健康标签产物未通过共享完整校验时不走恢复快捷完成', async () => {
  const governance = new RecoveryFakeGovernance();
  governance.outputs.push({
    id:'work-product-forged',
    kind:'work_product',
    type:'artifact',
    provider:'agent-army.ajun-runtime',
    externalId:`sha256:${'b'.repeat(64)}`,
    sourceTrust:null,
    status:'active',
    healthStatus:'healthy',
    metadata:{
      schemaVersion:contract.expectedWorkProduct.schemaVersion,
      kind:contract.expectedWorkProduct.type,
      stageKey:contract.stageKey,
      sourceTaskId:'task-voice-0001',
      sourceArtifactId:'artifact-voice-0001',
      artifactHash:`sha256:${'b'.repeat(64)}`,
      artifact:{ relativePath:'campaigns/voice.mp3' },
    },
  });
  const controller = recoveryController(governance, {
    workProductValidator:async () => {
      throw new Error('work_product_drift');
    },
  });
  await assert.rejects(
    () => fail(controller, governance, 'run-forged-wp'),
    /Work Product 漂移.*禁止自动恢复或覆盖/,
  );
  assert.equal(governance.issueUpdates.length, 0);
  assert.equal(governance.casePatches, 0);
});

test('缺少来源血缘或哈希的同阶段 output 触发漂移硬停而不是安排覆盖重试', async () => {
  const governance = new RecoveryFakeGovernance();
  governance.outputs.push({
    id:'work-product-untrusted',
    kind:'work_product',
    type:'artifact',
    provider:'agent-army.ajun-runtime',
    sourceTrust:null,
    status:'active',
    healthStatus:'healthy',
    metadata:{
      schemaVersion:contract.expectedWorkProduct.schemaVersion,
      kind:contract.expectedWorkProduct.type,
      stageKey:contract.stageKey,
      artifact:{ relativePath:'campaigns/voice.mp3' },
    },
  });

  await assert.rejects(
    () => fail(recoveryController(governance), governance, 'run-untrusted-wp'),
    /Work Product 候选.*漂移/,
  );
  assert.equal(governance.issueUpdates.length, 0);
  assert.equal(governance.casePatches, 0);
});

function recoveryController(governance, options = {}) {
  return new M5StageRecoveryController({
    governance,
    ...options,
    now:() => new Date('2026-07-30T12:00:00.000Z'),
  });
}

async function fail(controller, governance, runId) {
  return failWithContract(controller, governance, contract, runId);
}

function recoveryVoiceWorkProduct(id) {
  return {
    id,
    kind:'work_product',
    type:'artifact',
    provider:'agent-army.ajun-runtime',
    externalId:`sha256:${'b'.repeat(64)}`,
    sourceTrust:null,
    status:'active',
    healthStatus:'healthy',
    metadata:{
      schemaVersion:contract.expectedWorkProduct.schemaVersion,
      kind:contract.expectedWorkProduct.type,
      stageKey:contract.stageKey,
      sourceTaskId:'task-voice-0001',
      sourceArtifactId:`artifact-${id}`,
      artifactHash:`sha256:${'b'.repeat(64)}`,
      artifact:{
        model:'stepaudio-2.5-tts',
        voice:'official-voice-1',
        relativePath:'campaigns/voice.mp3',
        checksum:`sha256:${'a'.repeat(64)}`,
        bytes:1024,
      },
    },
  };
}

async function failWithContract(controller, governance, selectedContract, runId) {
  if (!governance.runs.some((run) => run.id === runId)) {
    governance.runs.push({ id:runId, status:'failed' });
  }
  return controller.handleFailure({
    assignment:assignment(runId),
    contract:selectedContract,
    summary:'受控 fixture 阶段失败。',
  });
}

function assignment(runId) {
  return {
    issueId:ISSUE_ID,
    runId,
    pipelineCaseId:CASE_ID,
    routineKey:'m5-voice',
    agentId:'content-creator',
  };
}

function storedStageRecovery(governance, stageKey = 'voice') {
  const contentCase = governance.contentCase || governance.caseItem;
  return contentCase.fields.m5ContentRecovery.stageRecoveries[`${CASE_ID}:${stageKey}`];
}

class RecoveryFakeGovernance {
  constructor() {
    this.caseItem = {
      id:CASE_ID,
      version:1,
      caseKey:'campaign-fixture:2026-07-30',
      stageKey:'voice',
      fields:{
        campaignId:'campaign-fixture',
        scheduledDate:'2026-07-30',
      },
    };
    this.issue = { id:ISSUE_ID, status:'in_progress' };
    this.runs = [];
    this.events = [];
    this.outputs = [];
    this.issueUpdates = [];
    this.casePatches = 0;
  }

  async getPipelineCase() { return structuredClone(this.caseItem); }
  async getPaperclipIssue() { return structuredClone(this.issue); }
  async getPaperclipIssueRuns() { return structuredClone(this.runs); }
  async getPipelineCaseEvents() { return structuredClone(this.events); }
  async getPipelineCaseOutputs() { return structuredClone(this.outputs); }

  async patchPipelineCaseFields(caseId, { expectedVersion, fields }) {
    assert.equal(caseId, CASE_ID);
    assert.equal(expectedVersion, this.caseItem.version);
    this.caseItem.fields = structuredClone(fields);
    this.caseItem.version += 1;
    this.casePatches += 1;
    this.events.push({
      payload:{
        fields:{
          m5StageRecovery:structuredClone(fields.m5StageRecovery),
          m5ContentRecovery:structuredClone(fields.m5ContentRecovery),
        },
      },
    });
    return structuredClone(this.caseItem);
  }

  async reopenM5StageIssue(_issueId, { comment }) {
    this.issue.status = 'todo';
    this.issueUpdates.push({ status:'todo', comment });
  }

  async blockM5StageIssue(_issueId, { comment }) {
    this.issue.status = 'blocked';
    this.issueUpdates.push({ status:'blocked', comment });
  }

  async completeM5RecoveredStageIssue(_issueId, { comment }) {
    this.issue.status = 'done';
    this.issueUpdates.push({ status:'done', comment });
  }
}

class ConflictOnceRecoveryGovernance extends RecoveryFakeGovernance {
  constructor({ conflictCount = 1 } = {}) {
    super();
    this.conflictCount = conflictCount;
    this.operationLog = [];
  }

  async getPipelineCase(...args) {
    this.operationLog.push('get-case');
    return super.getPipelineCase(...args);
  }

  async getPaperclipIssue(...args) {
    this.operationLog.push('get-issue');
    return super.getPaperclipIssue(...args);
  }

  async getPaperclipIssueRuns(...args) {
    this.operationLog.push('get-runs');
    return super.getPaperclipIssueRuns(...args);
  }

  async getPipelineCaseEvents(...args) {
    this.operationLog.push('get-events');
    return super.getPipelineCaseEvents(...args);
  }

  async getPipelineCaseOutputs(...args) {
    this.operationLog.push('get-outputs');
    return super.getPipelineCaseOutputs(...args);
  }

  async patchPipelineCaseFields(...args) {
    if (this.conflictCount > 0) {
      this.conflictCount -= 1;
      this.operationLog.push('patch-conflict');
      const error = new Error('version conflict');
      error.status = 409;
      throw error;
    }
    this.operationLog.push('patch-success');
    return super.patchPipelineCaseFields(...args);
  }

  async reopenM5StageIssue(...args) {
    this.operationLog.push('reopen-issue');
    return super.reopenM5StageIssue(...args);
  }
}

class DescendantRecoveryFakeGovernance extends RecoveryFakeGovernance {
  constructor() {
    super();
    this.contentCase = {
      id:CONTENT_CASE_ID,
      version:1,
      caseKey:'campaign-fixture:2026-07-30',
      stageKey:'parallel_join_gate',
      fields:{
        campaignId:'campaign-fixture',
        scheduledDate:'2026-07-30',
      },
    };
    this.caseItem = {
      id:CASE_ID,
      version:1,
      parentCaseId:CONTENT_CASE_ID,
      caseKey:'campaign-fixture:2026-07-30:parallel:v1:voice',
      stageKey:'voice',
      fields:{
        campaignId:'campaign-fixture',
        scheduledDate:'2026-07-30',
        contentVersion:'v1',
        workBranch:{ kind:'voice' },
      },
    };
  }

  async getPipelineCase(caseId) {
    return structuredClone(caseId === CONTENT_CASE_ID ? this.contentCase : this.caseItem);
  }

  async patchPipelineCaseFields(caseId, { expectedVersion, fields }) {
    const target = caseId === CONTENT_CASE_ID ? this.contentCase : this.caseItem;
    assert.equal(expectedVersion, target.version);
    target.fields = structuredClone(fields);
    target.version += 1;
    this.casePatches += 1;
    this.events.push({
      payload:{
        fields:{
          m5StageRecovery:structuredClone(fields.m5StageRecovery),
          m5ContentRecovery:structuredClone(fields.m5ContentRecovery),
        },
      },
    });
    return structuredClone(target);
  }
}

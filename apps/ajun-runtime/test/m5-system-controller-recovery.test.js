import assert from 'node:assert/strict';
import test from 'node:test';
import {
  consumeM5SystemControllerPlanRevision,
  recoverM5SystemControllerFailure,
} from '../src/m5-system-controller-recovery.js';
import { getM5RoutineExecutionContract } from '../src/m5-routine-execution-contract.js';

const CASE_ID = '77777777-7777-4777-8777-777777777777';
const ISSUE_ID = '88888888-8888-4888-8888-888888888888';

for (const routineKey of [
  'm5-parallel-join',
  'm5-publish',
  'm5-metrics',
  'm5-retrospective',
]) {
  test(`${routineKey} 系统控制器失败进入同一受控重试与重规划循环`, async () => {
    const contract = getM5RoutineExecutionContract(routineKey);
    const governance = new SystemRecoveryGovernance(contract);

    const first = await recover(governance, contract, 'run-system-0001');
    const second = await recover(governance, contract, 'run-system-0002');
    const third = await recover(governance, contract, 'run-system-0003');

    assert.equal(first.recovery.action, 'retry');
    assert.equal(second.recovery.action, 'retry');
    assert.equal(third.recovery.action, 'replan');
    assert.equal(third.recovery.replanCount, 1);
    assert.equal(governance.caseItem.fields.m5ContentRecovery.replanCount, 1);
    assert.equal(governance.issueUpdates.at(-1).status, 'todo');
    const consumption = await consumeM5SystemControllerPlanRevision({
      governance,
      pipelineCaseId:CASE_ID,
      runId:'run-system-0004',
      routineKey:contract.routineKey,
      systemRole:contract.systemController,
    });
    assert.equal(consumption.revisionId, third.recovery.planRevision.revisionId);
    assert.equal(consumption.routeChanged, true);
    assert.equal(consumption.routeKind, 'system_controller_rederive_case_state');
    assert.equal(
      governance.caseItem.fields.m5ContentRecovery.planRevisionConsumptions[0].runId,
      'run-system-0004',
    );
    const fourth = await recover(governance, contract, 'run-system-0004');
    assert.equal(fourth.recovery.action, 'retry');
    assert.equal(
      governance.caseItem.fields.m5ContentRecovery.planRevisionConsumptions[0].revisionId,
      third.recovery.planRevision.revisionId,
    );
  });
}

test('系统控制器同一路线重复失败不能伪装成新恢复，最终按上限 blocked', async () => {
  const contract = getM5RoutineExecutionContract('m5-publish');
  const governance = new SystemRecoveryGovernance(contract);

  await recover(governance, contract, 'run-fake-route-0001');
  await recover(governance, contract, 'run-fake-route-0002');
  const firstReplan = await recover(governance, contract, 'run-fake-route-0003');
  assert.equal(firstReplan.recovery.action, 'replan');
  await consumeM5SystemControllerPlanRevision({
    governance,
    pipelineCaseId:CASE_ID,
    runId:'run-fake-route-0004',
    routineKey:contract.routineKey,
    systemRole:contract.systemController,
  });
  await recover(governance, contract, 'run-fake-route-0004');

  const decisions = [];
  for (let index = 5; index <= 12; index += 1) {
    const runId = `run-fake-route-${String(index).padStart(4, '0')}`;
    await assert.rejects(
      consumeM5SystemControllerPlanRevision({
        governance,
        pipelineCaseId:CASE_ID,
        runId,
        routineKey:contract.routineKey,
        systemRole:contract.systemController,
      }),
      /输入、工具或策略没有真实变化/,
    );
    decisions.push((await recover(governance, contract, runId)).recovery.action);
  }

  assert.deepEqual(decisions, [
    'retry', 'replan',
    'retry', 'retry', 'replan',
    'retry', 'retry', 'blocked',
  ]);
  assert.equal(governance.caseItem.fields.m5ContentRecovery.replanCount, 3);
  assert.equal(governance.issueUpdates.at(-1).status, 'blocked');
});

async function recover(governance, contract, runId) {
  governance.runs.push({ id:runId, status:'failed' });
  return recoverM5SystemControllerFailure({
    governance,
    issueId:ISSUE_ID,
    runId,
    agentId:'99999999-9999-4999-8999-999999999999',
    routineKey:contract.routineKey,
    systemRole:contract.systemController,
    error:new Error('/Users/private/token-secret should be redacted'),
  });
}

class SystemRecoveryGovernance {
  constructor(contract) {
    this.contract = contract;
    this.runs = [];
    this.issueUpdates = [];
    this.issue = {
      id:ISSUE_ID,
      status:'in_progress',
      description:[
        `[agent-army:m5:routine:${contract.routineKey}]`,
        `当前 Case 为 ${CASE_ID}，版本为 1。`,
      ].join(' '),
    };
    this.caseItem = {
      id:CASE_ID,
      version:1,
      parentCaseId:null,
      caseKey:'campaign-system:2026-07-30',
      stageKey:contract.stageKey,
      fields:{
        campaignId:'campaign-system',
        scheduledDate:'2026-07-30',
      },
    };
  }

  async verifySystemAssignment() { return { issue:structuredClone(this.issue) }; }
  async assertCaseIssueLink(caseId, issueId) {
    assert.equal(caseId, CASE_ID);
    assert.equal(issueId, ISSUE_ID);
  }
  async getPipelineCase() { return structuredClone(this.caseItem); }
  async getPaperclipIssue() { return structuredClone(this.issue); }
  async getPaperclipIssueRuns() { return structuredClone(this.runs); }
  async getPipelineCaseEvents() { return []; }
  async getPipelineCaseOutputs() { return []; }
  async patchPipelineCaseFields(_caseId, { expectedVersion, fields }) {
    assert.equal(expectedVersion, this.caseItem.version);
    this.caseItem = {
      ...this.caseItem,
      version:this.caseItem.version + 1,
      fields:structuredClone(fields),
    };
  }
  async reopenM5StageIssue(_issueId, { comment }) {
    this.issueUpdates.push({ status:'todo', comment });
  }
  async blockM5StageIssue(_issueId, { comment }) {
    this.issueUpdates.push({ status:'blocked', comment });
  }
  async completeM5RecoveredStageIssue(_issueId, { comment }) {
    this.issueUpdates.push({ status:'done', comment });
  }
}

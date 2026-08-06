import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PaperclipLearningLifecycleHandler,
} from '../src/paperclip-learning-lifecycle.js';

const IDS = Object.freeze({
  issue:'11111111-1111-4111-8111-111111111111',
  run:'22222222-2222-4222-8222-222222222222',
  agent:'33333333-3333-4333-8333-333333333333',
  case:'44444444-4444-4444-8444-444444444444',
});

class FakeGovernance {
  constructor() {
    this.issue = {
      id:IDS.issue,
      status:'in_progress',
      description:`[agent-army:m5:routine:m5-learning] 推进学习闭环；当前 Case 为 ${IDS.case}，版本为 8。`,
    };
    this.case = { id:IDS.case, stageKey:'learning', version:8 };
    this.links = [];
    this.updates = [];
    this.transitions = [];
  }

  async verifySystemAssignment(input) {
    assert.deepEqual(input, {
      issueId:IDS.issue,
      runId:IDS.run,
      paperclipAgentId:IDS.agent,
      systemRole:'m5-learning-controller',
    });
    return { issue:this.issue };
  }

  async assertCaseIssueLink(caseId, issueId) {
    this.links.push({ caseId, issueId });
  }

  async updateLearningIssue(issueId, payload) {
    this.updates.push({ issueId, payload });
  }

  async getPipelineCase() {
    return structuredClone(this.case);
  }

  async transitionPipelineCase(caseId, payload, options) {
    this.transitions.push({ caseId, ...payload, runId:options.runId });
    this.case = { ...this.case, stageKey:payload.toStageKey, version:this.case.version + 1 };
  }
}

function payload(overrides = {}) {
  return {
    runId:IDS.run,
    agentId:IDS.agent,
    context:{ taskId:IDS.issue },
    ...overrides,
  };
}

test('学习控制器只从可信 Issue 绑定推进，并在等待审批时进入 in_review', async () => {
  const governance = new FakeGovernance();
  const lifecycle = {
    async advance(input) {
      assert.deepEqual(input, {
        caseId:IDS.case,
        issueId:IDS.issue,
        runId:IDS.run,
      });
      return {
        state:'waiting_reviewer_approval',
        workProductId:'learning-proposal-1',
      };
    },
  };
  const result = await new PaperclipLearningLifecycleHandler({
    governance,
    lifecycle,
  }).handle(payload());

  assert.equal(result.accepted, true);
  assert.equal(result.terminal, false);
  assert.equal(result.caseVersion, 8);
  assert.deepEqual(governance.links, [{ caseId:IDS.case, issueId:IDS.issue }]);
  assert.equal(governance.updates[0].payload.status, 'in_review');
  assert.match(governance.updates[0].payload.comment, /等待审核官审批/);
});

for (const state of ['validated', 'rolled_back', 'rejected']) {
  test(`${state} 决定完成学习 Issue`, async () => {
    const governance = new FakeGovernance();
    const handler = new PaperclipLearningLifecycleHandler({
      governance,
      lifecycle:{
        async advance() {
          return { state, workProductId:`decision-${state}` };
        },
      },
    });
    const result = await handler.handle(payload());
    assert.equal(result.terminal, true);
    assert.equal(governance.updates[0].payload.status, 'done');
    assert.deepEqual(governance.transitions, [{
      caseId:IDS.case,
      expectedVersion:8,
      toStageKey:'done',
      runId:IDS.run,
    }]);
  });
}

test('单次heartbeat连续写离线回放并推进到人工审批边界', async () => {
  const governance = new FakeGovernance();
  let advances = 0;
  const result = await new PaperclipLearningLifecycleHandler({
    governance,
    lifecycle:{
      async advance() {
        advances += 1;
        if (advances === 1) {
          return {
            state:'offline_replay_passed',
            replayed:false,
            createdKind:'OfflineReplay',
            workProductId:'offline-replay-1',
          };
        }
        return {
          state:'waiting_reviewer_approval',
          replayed:false,
          createdKind:'LearningProposal',
          workProductId:'proposal-1',
        };
      },
    },
  }).handle(payload());
  assert.equal(advances, 2);
  assert.equal(result.state, 'waiting_reviewer_approval');
  assert.equal(governance.updates[0].payload.status, 'in_review');
});

test('已完成学习 Issue 幂等跳过，不重复写 Work Product', async () => {
  const governance = new FakeGovernance();
  governance.issue.status = 'done';
  let advances = 0;
  const result = await new PaperclipLearningLifecycleHandler({
    governance,
    lifecycle:{ async advance() { advances += 1; } },
  }).handle(payload());
  assert.equal(result.skipped, true);
  assert.equal(advances, 0);
  assert.equal(governance.updates.length, 0);
});

test('调用方不能指定 Case、模板、指标或审批结果', async () => {
  const governance = new FakeGovernance();
  const handler = new PaperclipLearningLifecycleHandler({
    governance,
    lifecycle:{ async advance() { throw new Error('不应执行'); } },
  });
  await assert.rejects(
    handler.handle(payload({ templateVersionId:'forged' })),
    /不接受调用方指定 templateVersionId/,
  );
  governance.issue.description = '普通任务';
  await assert.rejects(handler.handle(payload()), /只接受 M5 学习 Routine/);
});

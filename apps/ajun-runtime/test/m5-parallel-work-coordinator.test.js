import assert from 'node:assert/strict';
import test from 'node:test';
import { M5ParallelWorkCoordinator } from '../src/m5-parallel-work-coordinator.js';
import { FakePaperclipAdapter } from '../../../integrations/paperclip/m5-content-pipeline/src/index.js';

const PIPELINE_ID = '22222222-2222-4222-8222-222222222222';
const DAY_ID = '33333333-3333-4333-8333-333333333333';

class ParallelFakeAdapter extends FakePaperclipAdapter {
  constructor() {
    super({
      pipelines:[{ id:PIPELINE_ID, key:'m5-content-pipeline' }],
      cases:[{
        id:DAY_ID,
        pipelineId:PIPELINE_ID,
        caseKey:'m5-parallel:2026-08-03',
        title:'第1天',
        stageKey:'parallel_join_gate',
        version:1,
        parentCaseId:'11111111-1111-4111-8111-111111111111',
        fields:{
          campaignId:'m5-parallel',
          scheduledDate:'2026-08-03',
          contentVersion:'v1',
        },
      }],
    });
    this.outputs = new Map();
    this.issueLinks = new Map();
    this.routineRuns = [];
    this.activeOutsideBatch = 0;
  }

  async getCase(caseId) {
    return this.state.cases.find((item) => item.id === caseId) || null;
  }

  async listPipelineCases() {
    return this.state.cases;
  }

  async getCaseOutputs(caseId) {
    return this.outputs.get(caseId) || [];
  }

  async listCaseIssueLinks(caseId) {
    return this.issueLinks.get(caseId) || [];
  }

  async runParallelRoutine({ branch, routineKey, idempotencyKey }) {
    const issueId = `44444444-4444-4444-8444-${String(this.routineRuns.length + 1).padStart(12, '0')}`;
    const result = {
      id:`55555555-5555-4555-8555-${String(this.routineRuns.length + 1).padStart(12, '0')}`,
      linkedIssueId:issueId,
      status:'issue_created',
    };
    this.routineRuns.push({ branchId:branch.id, routineKey, idempotencyKey, result });
    this.issueLinks.set(branch.id, [{
      issue:{ id:issueId, status:'todo' },
      role:'automation',
    }]);
    return result;
  }

  async linkCaseIssue(caseId, issueId) {
    const links = this.issueLinks.get(caseId) || [];
    if (!links.some((item) => item.issue?.id === issueId)) {
      links.push({ issue:{ id:issueId, status:'todo' }, role:'automation' });
      this.issueLinks.set(caseId, links);
    }
  }

  async countActiveParallelIssues() {
    const active = new Set(
      Array.from({ length:this.activeOutsideBatch }, (_, index) => `outside-${index}`),
    );
    for (const links of this.issueLinks.values()) {
      for (const item of links) {
        if (['todo', 'in_progress', 'blocked'].includes(item.issue?.status)) {
          active.add(item.issue.id);
        }
      }
    }
    return active.size;
  }
}

function healthyOutput(kind) {
  return {
    kind:'work_product',
    type:'artifact',
    status:'active',
    healthStatus:'healthy',
    metadata:{ kind },
  };
}

function markIssueDone(adapter, branch) {
  const issueId = adapter.issueLinks.get(branch.id)?.[0]?.issue?.id;
  for (const links of adapter.issueLinks.values()) {
    for (const link of links) {
      if (link.issue?.id === issueId) link.issue.status = 'done';
    }
  }
}

test('TopicSelection 后创建五分支，先派发研究、素材和生图，小拆与配音等待前置产物', async () => {
  const adapter = new ParallelFakeAdapter();
  adapter.outputs.set(DAY_ID, [healthyOutput('TopicSelection')]);
  const coordinator = new M5ParallelWorkCoordinator({ adapter, pipelineId:PIPELINE_ID });

  const first = await coordinator.reconcile(DAY_ID);

  assert.equal(first.created.branches.length, 5);
  assert.deepEqual(
    adapter.routineRuns.map((item) => item.routineKey).sort(),
    ['m5-assets', 'm5-evidence', 'm5-image-generation'],
  );
  assert.equal(
    first.waiting.find((item) => item.kind === 'visual_analysis').reason,
    'asset_package_not_verified',
  );
  assert.equal(first.waiting.find((item) => item.kind === 'voice').reason, 'script_not_verified');
  assert.equal(await adapter.countActiveParallelIssues(), 3);

  const replay = await coordinator.reconcile(DAY_ID);
  assert.equal(adapter.routineRuns.length, 3);
  assert.equal(replay.dispatched.length, 0);
});

test('配音只在脚本 Work Product 核验后派发，且全局活动 Issue 达到4时不再派发', async () => {
  const adapter = new ParallelFakeAdapter();
  adapter.outputs.set(DAY_ID, [
    healthyOutput('TopicSelection'),
    healthyOutput('ScriptPackage'),
  ]);
  adapter.activeOutsideBatch = 4;
  const coordinator = new M5ParallelWorkCoordinator({ adapter, pipelineId:PIPELINE_ID });

  const capped = await coordinator.reconcile(DAY_ID);
  assert.equal(adapter.routineRuns.length, 0);
  assert.equal(capped.waiting.find((item) => item.kind === 'visual_analysis').reason, 'asset_package_not_verified');
  assert.equal(capped.waiting.filter((item) => item.kind !== 'visual_analysis')
    .every((item) => item.reason === 'global_concurrency_limit'), true);

  adapter.activeOutsideBatch = 0;
  const started = await coordinator.reconcile(DAY_ID);
  assert.equal(started.dispatched.length, 4);
  assert.equal(adapter.routineRuns.at(-1).routineKey, 'm5-voice');
  assert.equal(await adapter.countActiveParallelIssues(), 4);
});

test('只有五分支终态且对应健康 Work Product 全部存在时才完成分支和 join', async () => {
  const adapter = new ParallelFakeAdapter();
  adapter.outputs.set(DAY_ID, [
    healthyOutput('TopicSelection'),
    healthyOutput('ScriptPackage'),
  ]);
  const coordinator = new M5ParallelWorkCoordinator({ adapter, pipelineId:PIPELINE_ID });
  const started = await coordinator.reconcile(DAY_ID);
  const initialByKind = Object.fromEntries(started.created.branches.map((item) => [item.fields.workBranch.kind, item]));
  markIssueDone(adapter, initialByKind.assets);
  adapter.outputs.set(initialByKind.assets.id, [healthyOutput('AssetPackage')]);
  const visualStarted = await coordinator.reconcile(DAY_ID);
  const byKind = Object.fromEntries(visualStarted.created.branches.map((item) => [item.fields.workBranch.kind, item]));
  assert.equal(visualStarted.dispatched.some((item) => item.kind === 'visual_analysis'), true);
  const expected = {
    research:'EvidencePackage',
    assets:'AssetPackage',
    image_generation:'GeneratedImagePackage',
    visual_analysis:'VisualAnalysisPackage',
    voice:'VoicePackage',
  };

  for (const [kind, branch] of Object.entries(byKind)) {
    markIssueDone(adapter, branch);
    adapter.outputs.set(branch.id, kind === 'voice' ? [] : [healthyOutput(expected[kind])]);
  }
  const incomplete = await coordinator.reconcile(DAY_ID);
  assert.equal(incomplete.joined, false);
  assert.equal(incomplete.waiting.some((item) => item.kind === 'voice' && item.reason === 'work_product_missing'), true);
  assert.notEqual(incomplete.created.join.stageKey, 'done');

  adapter.outputs.set(byKind.voice.id, [healthyOutput('VoicePackage')]);
  const complete = await coordinator.reconcile(DAY_ID);
  assert.equal(complete.joined, true);
  assert.equal(complete.created.join.stageKey, 'done');
  assert.equal(complete.created.branches.every((item) => item.stageKey === 'done'), true);
  assert.equal(complete.dayCase.stageKey, 'render');
});

test('Issue done 但 Work Product 不健康时拒绝完成分支和汇聚', async () => {
  const adapter = new ParallelFakeAdapter();
  adapter.outputs.set(DAY_ID, [
    healthyOutput('TopicSelection'),
    healthyOutput('ScriptPackage'),
  ]);
  const coordinator = new M5ParallelWorkCoordinator({ adapter, pipelineId:PIPELINE_ID });
  const started = await coordinator.reconcile(DAY_ID);
  const initialByKind = Object.fromEntries(started.created.branches.map((item) => [item.fields.workBranch.kind, item]));
  markIssueDone(adapter, initialByKind.assets);
  adapter.outputs.set(initialByKind.assets.id, [healthyOutput('AssetPackage')]);
  const visualStarted = await coordinator.reconcile(DAY_ID);
  for (const branch of visualStarted.created.branches) {
    markIssueDone(adapter, branch);
    adapter.outputs.set(branch.id, [{
      ...healthyOutput(branch.fields.workBranch.requiredWorkProduct),
      healthStatus:'degraded',
    }]);
  }

  const result = await coordinator.reconcile(DAY_ID);
  assert.equal(result.joined, false);
  assert.equal(
    result.created.branches.find((item) => item.fields.workBranch.kind === 'visual_analysis').stageKey,
    'draft',
  );
});

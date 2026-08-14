import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createRoleExecutionComposition } from '../src/runtime/role-execution-composition.ts';

test('岗位执行总装保持 research、content、technical Module 的对象与工具接线', async () => {
  const root = path.join(os.tmpdir(), 'agent-army-role-execution-composition-test');
  const store = {
    async list() { return []; },
  };
  const governance = {
    async createIssueWorkProduct() {},
    async getIssueWorkProducts() { return []; },
  };
  const composition = await createRoleExecutionComposition({
    environment:{},
    paths:{
      sourceProjectRoot:root,
      repairWorktreeParent:path.join(root, 'repairs'),
      hermesProfileRoot:path.join(root, 'hermes'),
      dataDir:path.join(root, 'data'),
      autoWorkRoot:path.join(root, 'auto-work'),
      xiaodArtifactRoot:path.join(root, 'xiaod'),
      contentWorkspaceDir:path.join(root, 'content'),
    },
    runtimeSource:{
      mode:'source',
      sourceIdentity:{ kind:'git', commit:'test' },
      async verify() {},
    },
    registry:{
      async get(agentId) {
        return agentId === 'video-content-analyst'
          ? { agentId, runtimeCapabilities:{ localAiCapabilities:[] } }
          : null;
      },
      async list() { return []; },
    },
    store,
    governance,
    contentCampaign:{
      templateResolver:{},
      async executeProviderVision() {},
      async campaigns() {
        return { async assertReplayableM5WorkProduct() {} };
      },
    },
    xiaod:{},
    localAi:{
      async invoke() {},
      async controlService() {},
      async health() { return { status:'ready' }; },
    },
    taskRunEvents:{ async appendTaskRunEvent() {} },
    port:4321,
  });

  const acceptance = composition.proposals.restrictedAcceptanceRunner;
  assert.equal(composition.proposals.taskService, composition.tasks);
  assert.equal(composition.tasks.fallbackExecutor, acceptance.publicReport);
  assert.equal(composition.publicWebFetch, acceptance.publicReport.publicWebFetch);
  assert.equal(composition.tasks.executors['intel-researcher'], acceptance.intelResearcher);

  assert.equal(composition.tasks.executors['video-content-analyst'], acceptance.videoContentAnalyst);
  assert.equal(composition.tasks.executors['content-creator'], acceptance.contentCreator);
  assert.equal(
    composition.tasks.executors['content-creator'].scriptPackage.researcher,
    composition.tasks.executors['intel-researcher'],
  );

  assert.equal(
    composition.tasks.roleToolAdapters,
    composition.tasks.officePresentationExecution.roleToolAdapters,
  );
  for (const adapterId of [
    'ajun-public-search',
    'ajun-public-fetch',
    'hermes-public-browser',
    'hermes-pdf',
    'github-public',
    'ajun-task-store',
    'ajun-office-markdown',
    'open-kimi-pptd',
    'local-pptx',
    'paperclip-work-product',
    'content-library',
  ]) {
    assert.equal(typeof composition.tasks.roleToolAdapters[adapterId], 'function', adapterId);
  }

  const technicalRecoveryResult = Symbol('technical-recovery-result');
  const failedTask = { taskId:'failed-task' };
  assert.equal(composition.failureRecovery.tasks, composition.tasks);
  assert.equal(typeof composition.failureRecovery.diagnoser?.diagnose, 'function');
  composition.failureRecovery.handle = async (task) => {
    assert.equal(task, failedTask);
    return technicalRecoveryResult;
  };
  assert.equal(
    await composition.tasks.failureRecovery.recover(failedTask),
    technicalRecoveryResult,
  );
  const technicalExecutor = composition.tasks.executors['technical-expert'];
  assert.equal(composition.tasks.capabilityCatalog.executor('technical-expert'), technicalExecutor);
});

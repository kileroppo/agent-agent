import assert from 'node:assert/strict';
import test from 'node:test';
import {
  selectAffectedTestFiles,
  selectAffectedWorkspaces,
} from './run-affected-tests.mjs';

function workspace(name, directory, dependencies = []) {
  return [name, {
    name,
    directory,
    dependencies:new Set(dependencies),
    manifest:{ name, scripts:{ test:'node --test' } },
  }];
}

const graph = new Map([
  workspace('@agent-army/contracts', 'packages/contracts'),
  workspace('@agent-army/client', 'packages/client'),
  workspace('@agent-army/pipeline', 'integrations/pipeline', ['@agent-army/contracts', '@agent-army/client']),
  workspace('ajun-runtime', 'apps/ajun-runtime', ['@agent-army/contracts', '@agent-army/client']),
]);

test('共享契约变更会选择自身和全部递归消费者，并按依赖优先排序', () => {
  assert.deepEqual(
    selectAffectedWorkspaces(['packages/contracts/src/index.js'], graph),
    ['@agent-army/contracts', '@agent-army/pipeline', 'ajun-runtime'],
  );
});

test('普通应用变更只选择所属 workspace', () => {
  assert.deepEqual(
    selectAffectedWorkspaces(['apps/ajun-runtime/src/task.js'], graph),
    ['ajun-runtime'],
  );
});

test('根脚本和仓库目录清单变更选择全部 workspace，docs/contracts 只触发 A君', () => {
  assert.deepEqual(
    selectAffectedWorkspaces(['docs/contracts/core-contracts.md'], graph),
    ['ajun-runtime'],
  );
  assert.deepEqual(
    selectAffectedWorkspaces(['scripts/check.mjs'], graph),
    ['@agent-army/client', '@agent-army/contracts', '@agent-army/pipeline', 'ajun-runtime'],
  );
  assert.deepEqual(
    selectAffectedWorkspaces(['repository-catalog.json'], graph),
    ['@agent-army/client', '@agent-army/contracts', '@agent-army/pipeline', 'ajun-runtime'],
  );
});

test('A君深层模块变更只选择该模块及 TaskService 接缝测试', () => {
  const ajun = graph.get('ajun-runtime');
  assert.deepEqual(
    selectAffectedTestFiles([
      'apps/ajun-runtime/src/task-execution-coordinator.js',
      'apps/ajun-runtime/test/task-execution-coordinator.test.js',
    ], ajun),
    [
      'test/task-execution-coordinator.test.js',
      'test/task-service.test.js',
    ],
  );
  assert.deepEqual(
    selectAffectedTestFiles([
      'apps/ajun-runtime/src/task-intake.js',
      'apps/ajun-runtime/src/task-notification.js',
    ], ajun),
    [
      'test/cross-agent-mission-service.test.js',
      'test/open-task-runtime-wiring.test.js',
      'test/task-service.test.js',
    ],
  );
  assert.deepEqual(
    selectAffectedTestFiles([
      'apps/ajun-runtime/src/task-approval-coordinator.js',
      'apps/ajun-runtime/src/task-overview.js',
    ], ajun),
    [
      'test/runtime-start.test.js',
      'test/task-overview-focus.test.js',
      'test/task-service.test.js',
    ],
  );
  assert.deepEqual(
    selectAffectedTestFiles([
      'apps/ajun-runtime/src/task-attention-presentation.js',
      'apps/ajun-runtime/src/task-recovery.js',
      'apps/ajun-runtime/src/task-recovery-policy.js',
    ], ajun),
    [
      'test/failure-recovery-coordinator.test.js',
      'test/feishu-commander.test.js',
      'test/production-control-plane-boundary.test.js',
      'test/task-presentation.test.js',
      'test/task-recovery.test.js',
      'test/task-service.test.js',
    ],
  );
  assert.deepEqual(
    selectAffectedTestFiles([
      'apps/ajun-runtime/src/task-paperclip-assignment.js',
      'apps/ajun-runtime/src/task-role-execution.js',
    ], ajun),
    [
      'test/local-content-growth.test.js',
      'test/m5-role-tool-execution.test.js',
      'test/paperclip-employee-assignment.test.js',
      'test/task-service.test.js',
    ],
  );
  assert.deepEqual(
    selectAffectedTestFiles([
      'apps/ajun-runtime/src/open-task-research-execution.js',
      'apps/ajun-runtime/src/local-content-analysis.js',
      'apps/ajun-runtime/public/app-interactions.js',
    ], ajun),
    [
      'test/console-boundary.test.js',
      'test/content-campaign-ui.test.js',
      'test/local-content-growth.test.js',
      'test/open-task-routing.test.js',
      'test/open-task-runtime-wiring.test.js',
      'test/runtime-start.test.js',
      'test/task-service.test.js',
    ],
  );
  assert.deepEqual(
    selectAffectedTestFiles([
      'apps/ajun-runtime/public/task-record-detail-view.js',
      'apps/ajun-runtime/public/refresh-scheduler.js',
    ], ajun),
    [
      'test/console-boundary.test.js',
      'test/console-operator-flow-ui.test.js',
      'test/refresh-scheduler.test.js',
      'test/runtime-start.test.js',
      'test/task-record-service.test.js',
    ],
  );
  assert.deepEqual(
    selectAffectedTestFiles([
      'apps/ajun-runtime/src/task-record-service.js',
      'apps/ajun-runtime/src/task-presentation.js',
      'apps/ajun-runtime/public/console-navigation.js',
    ], ajun),
    [
      'test/console-navigation.test.js',
      'test/task-presentation.test.js',
      'test/task-record-service.test.js',
    ],
  );
});

test('分析意图 TypeScript Module 变更选择自身及四个真实消费者测试', () => {
  const ajun = graph.get('ajun-runtime');
  assert.deepEqual(
    selectAffectedTestFiles(['apps/ajun-runtime/src/analysis-intent.ts'], ajun),
    [
      'test/agent-army-client.test.js',
      'test/analysis-intent.test.js',
      'test/feishu-commander.test.js',
      'test/local-content-growth.test.js',
      'test/task-service.test.js',
    ],
  );
});

test('产品装配 Module 变更选择所属领域和运行组合测试', () => {
  const ajun = graph.get('ajun-runtime');
  assert.deepEqual(
    selectAffectedTestFiles([
      'apps/ajun-runtime/src/runtime/content-campaign-composition.js',
      'apps/ajun-runtime/src/runtime/paperclip-system-control-composition.js',
    ], ajun),
    [
      'test/content-campaign-service.test.js',
      'test/m5-role-tool-execution.test.js',
      'test/m5-server-publisher-composition.test.js',
      'test/paperclip-heartbeat.test.js',
      'test/paperclip-learning-lifecycle.test.js',
      'test/paperclip-metric-monitor.test.js',
      'test/paperclip-publisher-controller.test.js',
      'test/paperclip-publisher-run-context.test.js',
      'test/paperclip-retrospective.test.js',
      'test/runtime-start.test.js',
    ],
  );
  assert.deepEqual(
    selectAffectedTestFiles([
      'apps/ajun-runtime/src/runtime/role-execution-composition.js',
    ], ajun),
    [
      'test/agent-proposal-service.test.js',
      'test/local-content-growth.test.js',
      'test/local-intel-researcher.test.js',
      'test/local-office-assistant.test.js',
      'test/local-technical-expert.test.js',
      'test/open-task-runtime-wiring.test.js',
      'test/runtime-start.test.js',
      'test/task-service.test.js',
      'test/technical-repair-diagnoser.test.js',
      'test/technical-repair-promotion.test.js',
      'test/technical-repair-watchdog.test.js',
    ],
  );
});

test('A君未知或跨模块文件变更退回 workspace 全量测试', () => {
  const ajun = graph.get('ajun-runtime');
  assert.equal(
    selectAffectedTestFiles(['apps/ajun-runtime/src/task-service.js'], ajun),
    null,
  );
  assert.equal(
    selectAffectedTestFiles(['integrations/pipeline/src/index.js'], ajun),
    null,
  );
});

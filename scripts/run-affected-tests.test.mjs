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

test('根脚本变更选择全部 workspace，docs/contracts 只触发 A君', () => {
  assert.deepEqual(
    selectAffectedWorkspaces(['docs/contracts/core-contracts.md'], graph),
    ['ajun-runtime'],
  );
  assert.deepEqual(
    selectAffectedWorkspaces(['scripts/check.mjs'], graph),
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

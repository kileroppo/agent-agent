import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_TASK_CAPABILITY_CATALOG,
  TaskCapabilityCatalog,
} from '../src/task-capability-catalog.js';

test('任务能力目录集中固定岗位、开放委派和内容产物契约', () => {
  assert.equal(DEFAULT_TASK_CAPABILITY_CATALOG.fixedAgentId('content.video-script-package'), 'content-creator');
  assert.equal(DEFAULT_TASK_CAPABILITY_CATALOG.fixedAgentId('office.presentation-package'), 'office-assistant');
  assert.equal(DEFAULT_TASK_CAPABILITY_CATALOG.openDelegate('research.open-investigation'), 'research.intel-report');
  assert.deepEqual(
    DEFAULT_TASK_CAPABILITY_CATALOG.contentGrowthContract('content.performance-review', 'video-content-analyst'),
    {
      taskType:'content.performance-review',
      agentId:'video-content-analyst',
      artifactType:'content_performance_report',
    },
  );
  assert.equal(
    DEFAULT_TASK_CAPABILITY_CATALOG.contentGrowthContract('content.performance-review', 'content-creator'),
    null,
  );
});

test('任务能力目录按岗位返回装配好的执行器', () => {
  const executor = { execute() {} };
  const catalog = new TaskCapabilityCatalog({ executors:{ 'content-creator':executor } });
  assert.equal(catalog.executor('content-creator'), executor);
  assert.equal(catalog.executor('missing'), null);
});

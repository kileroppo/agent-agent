import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_TASK_DEFINITION_REGISTRY,
  TaskDefinitionRegistry,
} from '../src/task-definition-registry.js';

test('任务定义注册中心集中默认岗位、固定岗位和开放委派', () => {
  assert.equal(DEFAULT_TASK_DEFINITION_REGISTRY.defaultAgentId('research.intel-report'), 'intel-researcher');
  assert.equal(DEFAULT_TASK_DEFINITION_REGISTRY.fixedAgentId('research.intel-report'), null);
  assert.equal(DEFAULT_TASK_DEFINITION_REGISTRY.fixedAgentId('content.video-script-package'), 'content-creator');
  assert.equal(DEFAULT_TASK_DEFINITION_REGISTRY.openDelegate('research.open-investigation'), 'research.intel-report');
});

test('任务定义注册中心集中展示元数据和意图入口', () => {
  assert.equal(DEFAULT_TASK_DEFINITION_REGISTRY.taskTypeForIntent('office_presentation'), 'office.presentation-package');
  assert.equal(DEFAULT_TASK_DEFINITION_REGISTRY.taskTypeForIntent('unknown'), 'army.intake');
  assert.equal(DEFAULT_TASK_DEFINITION_REGISTRY.workerName('research.github-search'), '小R');
  assert.equal(DEFAULT_TASK_DEFINITION_REGISTRY.workerName({ taskType:'unknown', assigneeAgentId:'technical-expert' }), '技术专家');
  assert.equal(DEFAULT_TASK_DEFINITION_REGISTRY.taskLabel('office.presentation-package'), '演示文稿制作');
  assert.equal(DEFAULT_TASK_DEFINITION_REGISTRY.directTaskType('intel-researcher'), 'research.intel-report');
  assert.equal(DEFAULT_TASK_DEFINITION_REGISTRY.entryDefaultAgentId('content.video-script-package'), 'content-creator');
  assert.equal(DEFAULT_TASK_DEFINITION_REGISTRY.entryDefaultAgentId('army.intake'), null);
  assert.equal(DEFAULT_TASK_DEFINITION_REGISTRY.allowsApprovalInheritance('operations.health-review'), true);
  assert.equal(DEFAULT_TASK_DEFINITION_REGISTRY.allowsApprovalInheritance('operations.incident-response'), false);
});

test('任务定义注册中心按少量稳定入口分类返回任务类型', () => {
  assert.deepEqual(DEFAULT_TASK_DEFINITION_REGISTRY.taskTypesForCategory('content-creation'), [
    'content.platform-draft',
    'content.video-script-package',
  ]);
  assert.equal(DEFAULT_TASK_DEFINITION_REGISTRY.belongsToCategory('army.intake', 'research-entry'), true);
  assert.equal(DEFAULT_TASK_DEFINITION_REGISTRY.prerequisiteTaskType('content.video-benchmark-analysis'), 'media.transcribe-and-refine');
});

test('自定义注册中心拒绝缺失 taskType 的定义', () => {
  assert.throws(() => new TaskDefinitionRegistry({ definitions:[{}] }), /taskType is required/);
  assert.throws(() => new TaskDefinitionRegistry({ definitions:[{ taskType:'x' }, { taskType:'x' }] }), /must be unique/);
  assert.throws(() => new TaskDefinitionRegistry({ definitions:[{ taskType:'x', openDelegate:'missing' }], defaultTaskType:'x' }), /openDelegate/);
  assert.throws(() => new TaskDefinitionRegistry({ definitions:[{ taskType:'x', prerequisiteTaskType:'missing' }], defaultTaskType:'x' }), /prerequisiteTaskType/);
  assert.throws(() => new TaskDefinitionRegistry({ definitions:[{ taskType:'x' }], defaultTaskType:'missing' }), /defaultTaskType/);
});

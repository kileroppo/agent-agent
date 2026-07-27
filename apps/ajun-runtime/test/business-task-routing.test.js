import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalizeBusinessAssignment } from '../src/business-task-routing.js';

test('基于前置工作生成老板汇报时强制交给办公执行助理', () => {
  const assignment = canonicalizeBusinessAssignment({
    title:'基于工作1真实失败记录和工作2已验证产物生成最终老板汇报',
    taskType:'research.intel-report',
    agentId:'intel-researcher'
  });

  assert.equal(assignment.taskType, 'office.briefing-package');
  assert.equal(assignment.agentId, 'office-assistant');
  assert.equal(assignment.dependsOnPrevious, true);
});

test('研究如何生成汇报的独立主题不会被误改成办公任务', () => {
  const assignment = canonicalizeBusinessAssignment({
    title:'研究企业如何自动生成工作汇报',
    taskType:'research.intel-report',
    agentId:'intel-researcher'
  });

  assert.equal(assignment.taskType, 'research.intel-report');
  assert.equal(assignment.agentId, 'intel-researcher');
  assert.equal(assignment.dependsOnPrevious, false);
});

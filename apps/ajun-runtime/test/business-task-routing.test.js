import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalizeBusinessAssignment, githubRepositoryQuery } from '../src/business-task-routing.js';

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

test('模型误选主题研究时，明确 GitHub 开源项目请求仍强制交给小R的 GitHub 检索', () => {
  const assignment = canonicalizeBusinessAssignment({
    title:'查找 3 个 GitHub 开源 Agent 编排项目并给出链接与一句话判断',
    taskType:'research.intel-report',
    agentId:'intel-researcher'
  });

  assert.equal(assignment.taskType, 'research.github-search');
  assert.equal(assignment.agentId, 'intel-researcher');
  assert.equal(assignment.dependsOnPrevious, false);
});

test('GitHub 中文编排请求归一成公开仓库可检索关键词', () => {
  assert.equal(githubRepositoryQuery('搜索并比较 3 个 GitHub 开源多智能体编排项目'), 'multi-agent');
  assert.equal(githubRepositoryQuery('寻找适合 Agent 军团的编排框架'), 'agent orchestration');
  assert.equal(githubRepositoryQuery('请以关键词 agent governance 搜索并返回 3 个仓库'), 'agent governance');
});

test('内容增长任务只能路由给小拆、小创和小办的对应能力', () => {
  assert.equal(canonicalizeBusinessAssignment({ title:'拆解视频', taskType:'content.video-benchmark-analysis', agentId:'xiaod' }).agentId, 'video-content-analyst');
  assert.equal(canonicalizeBusinessAssignment({ title:'生成抖音草稿', taskType:'content.platform-draft', agentId:'video-content-analyst' }).agentId, 'content-creator');
  assert.equal(canonicalizeBusinessAssignment({ title:'归档本次工作', taskType:'office.knowledge-summary', agentId:'content-creator' }).agentId, 'office-assistant');
});

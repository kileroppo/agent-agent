import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalTaskCoordinator } from '../src/local-task-coordinator.js';

test('协调官把带公开链接的素材请求建议给小D，且不发起外部动作', async () => {
  const coordinator = new LocalTaskCoordinator({ now: () => new Date('2026-07-20T08:00:00.000Z') });
  const result = await coordinator.execute({ taskId: 'task-1', createdAt: '2026-07-20T07:59:00.000Z', input: { title: '整理这个视频', description: '', sourceUrl: 'https://example.com/video' }, execution: {} });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.artifactRefs[0].type, 'task_intake_record');
  assert.equal(result.artifactRefs[0].data.recommendedAgentId, 'xiaod');
  assert.equal(result.artifactRefs[0].data.externalActionStarted, false);
});

test('协调官不会把未知请求伪装成已路由', async () => {
  const coordinator = new LocalTaskCoordinator();
  const result = await coordinator.execute({ taskId: 'task-2', input: { title: '做一个新方向', description: '', sourceUrl: null }, execution: {} });
  assert.equal(result.artifactRefs[0].data.recommendedAgentId, null);
  assert.match(result.artifactRefs[0].data.nextAction, /没有唯一可执行岗位/);
});

test('未知工作会调用任务理解 AI，并安全交给架构师评估能力缺口', async () => {
  const advisor = { async advise() { return { understanding:'把竞品整理成行动清单', deliverable:'中文竞品行动清单', missing:['竞品名称'], safeNextStep:'先确认公开资料范围' }; } };
  const registry = { async list() { return [{ agentId:'public-reporter', name:'公开资料报告员', status:'active', acceptedTaskTypes:['report.public-material'] }, { agentId:'architect', name:'架构师', status:'active', acceptedTaskTypes:['governance.architecture-review'] }]; } };
  const coordinator = new LocalTaskCoordinator({ advisor, registry });
  const result = await coordinator.execute({ taskId:'task-1', createdAt:'2026-07-22T10:00:00.000Z', input:{ title:'帮我研究竞品' }, execution:{} });
  const record = result.artifactRefs[0].data;
  assert.equal(result.status, 'succeeded');
  assert.equal(record.recommendedTaskType, 'governance.architecture-review');
  assert.equal(record.recommendedAgentId, 'architect');
  assert.equal(record.autoContinue, true);
  assert.equal(record.advisor.deliverable, '中文竞品行动清单');
  assert.match(record.nextAction, /竞品整理成行动清单/);
  assert.match(record.nextAction, /中文竞品行动清单/);
  assert.match(record.nextAction, /竞品名称/);
  assert.equal(record.externalActionStarted, false);
});

test('包含登录、付费等风险描述的工作会交给审核官，不自动继续', async () => {
  const advisor = { async advise() { return { understanding:'购买一项服务', deliverable:'购买结果', missing:[], safeNextStep:'先确认范围' }; } };
  const registry = { async list() { return [{ agentId:'architect', name:'架构师', status:'active', acceptedTaskTypes:['governance.architecture-review'] }]; } };
  const record = (await new LocalTaskCoordinator({ advisor, registry }).execute({ taskId:'task-risk', input:{ title:'帮我登录账号并付费购买服务' }, execution:{} })).artifactRefs[0].data;
  assert.equal(record.recommendedTaskType, 'governance.approval-review');
  assert.equal(record.recommendedAgentId, 'reviewer');
  assert.equal(record.autoContinue, false);
});

test('协调官把审核和高风险描述交给审核官，只形成审查建议', async () => {
  const coordinator = new LocalTaskCoordinator();
  const result = await coordinator.execute({ taskId: 'task-3', input: { title: '审核发布范围', description: '', sourceUrl: null }, execution: {} });
  const record = result.artifactRefs[0].data;
  assert.equal(record.recommendedTaskType, 'governance.approval-review');
  assert.equal(record.recommendedAgentId, 'reviewer');
  assert.equal(record.externalActionStarted, false);
});

test('协调官把岗位能力评估交给架构师', async () => {
  const coordinator = new LocalTaskCoordinator();
  const result = await coordinator.execute({ taskId: 'task-4', input: { title: '评估现有岗位能力', description: '', sourceUrl: null }, execution: {} });
  const record = result.artifactRefs[0].data;
  assert.equal(record.recommendedTaskType, 'governance.architecture-review');
  assert.equal(record.recommendedAgentId, 'architect');
  assert.equal(record.externalActionStarted, false);
});

test('协调官识别创建 Agent 请求但只建议创建草案', async () => {
  const coordinator = new LocalTaskCoordinator();
  const result = await coordinator.execute({ taskId:'task-create', createdAt:'2026-07-20T00:00:00.000Z', input:{ title:'创建一个公开资料报告 Agent', description:'每日输出摘要', sourceUrl:null } });
  const record = result.artifactRefs[0].data;
  assert.equal(record.recommendedTaskType, 'governance.agent-proposal');
  assert.equal(record.recommendedAgentId, 'creator');
  assert.match(record.nextAction, /不会直接创建生产 Agent/);
});

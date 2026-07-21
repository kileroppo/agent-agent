import assert from 'node:assert/strict';
import test from 'node:test';
import { FeishuCommander, FeishuCommanderValidationError } from '../src/feishu-commander.js';

function setup() {
  const calls = { tasks: [], proposals: [] };
  const task = (input) => ({ taskId: `task-${calls.tasks.length}`, input: { sourceUrl: input.title.match(/https?:\/\/\S+/)?.[0] || null }, artifactRefs: input.taskType === 'operations.health-review' ? [{ type: 'health_report', data: { overall: 'healthy' } }] : input.taskType === 'army.intake' ? [{ type: 'task_intake_record', data: { nextAction: '请补充交付物。' } }] : [] });
  const commander = new FeishuCommander({
    tasks: { async create(input) { calls.tasks.push(input); return task(input); } },
    proposals: { async create(input, options) { calls.proposals.push({ input, options }); return { proposalId: 'proposal-1', status: 'draft' }; }, async submit() { return { proposalId: 'proposal-1', status: 'pending_approval' }; } }
  });
  return { commander, calls };
}

test('飞书军团总管将系统检查直接路由给运维官，且不创建 Paperclip 语义', async () => {
  const { commander, calls } = setup();
  const result = await commander.handle({ text: '检查系统状态', sourceEventRef: 'feishu:health-1', requesterRef: 'user-safe-ref' });
  assert.equal(calls.tasks[0].taskType, 'operations.health-review');
  assert.equal(calls.tasks[0].source.channel, 'feishu');
  assert.equal(calls.tasks[0].idempotencyKey, 'feishu:feishu:health-1');
  assert.match(result.reply, /系统检查完成/);
});

test('飞书军团总管将小D请求保留为同一飞书事件任务', async () => {
  const { commander, calls } = setup();
  const result = await commander.handle({ text: '整理视频 https://example.com/demo.mp4', sourceEventRef: 'feishu:media-1' });
  assert.equal(calls.tasks[0].taskType, 'media.transcribe-and-refine');
  assert.equal(calls.tasks[0].source.eventRef, 'feishu:media-1');
  assert.match(result.reply, /已交给小D/);
});

test('创建 Agent 只提交草案审核，不创建业务任务', async () => {
  const { commander, calls } = setup();
  const result = await commander.handle({ text: '创建一个 Agent，整理公开行业报告', sourceEventRef: 'feishu:create-1' });
  assert.equal(calls.tasks.length, 0);
  assert.equal(calls.proposals[0].input.sourceEventRef, 'feishu:create-1');
  assert.equal(calls.proposals[0].options.source, 'feishu');
  assert.match(result.reply, /提交组织级审核/);
});

test('缺少飞书事件引用时拒绝登记，避免重复副作用', async () => {
  const { commander } = setup();
  await assert.rejects(() => commander.handle({ text: '检查系统状态' }), FeishuCommanderValidationError);
});

test('待审批飞书任务会返回可渲染的 local 审批卡摘要', async () => {
  const approval = { approvalId:'approval-1', status:'pending', governanceMode:'local', action:'manual-risk-review', riskLevel:'high', reason:'需要确认范围。', requestedScope:{ taskType:'operations.health-review' }, validUntil:'2030-01-01T00:00:00.000Z' };
  const commander = new FeishuCommander({
    tasks: { async create() { return { taskId:'task-approval', status:'waiting_approval', approvalRefs:['approval-1'], input:{ sourceUrl:null }, artifactRefs:[] }; } },
    proposals: {}, store: { async listApprovals() { return [approval]; } }
  });
  const result = await commander.handle({ text:'外发系统健康摘要', sourceEventRef:'feishu:approval-1', chatRef:'chat-safe-ref' });
  assert.equal(result.approval.approvalId, 'approval-1');
  assert.equal(result.approval.governanceMode, 'local');
});

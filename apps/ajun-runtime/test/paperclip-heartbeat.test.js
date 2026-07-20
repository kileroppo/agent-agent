import assert from 'node:assert/strict';
import test from 'node:test';
import { PaperclipHeartbeatError, PaperclipHeartbeatHandler } from '../src/paperclip-heartbeat.js';

test('Paperclip heartbeat 只执行被指派的本机任务并回报同一张任务单', async () => {
  const calls = [];
  const handler = new PaperclipHeartbeatHandler({
    now: () => new Date('2026-07-20T12:00:00.000Z'),
    operator: { async execute(task) { calls.push(task); return { status:'succeeded', currentStage:'health_report_ready', artifactRefs:[{ type:'health_report', data:{ overall:'healthy' } }] }; } },
    governance: { async getPaperclipIssue() { return { status:'in_progress' }; }, async completePaperclipIssue(issueId, payload) { calls.push({ issueId, payload }); } }
  });
  const result = await handler.handle({ runId:'run-1', agentId:'agent-1', context:{ taskId:'issue-1' } });
  assert.deepEqual(result, { accepted:true, issueId:'issue-1', stage:'health_report_ready', status:'succeeded' });
  assert.equal(calls[0].taskId, 'issue-1');
  assert.equal(calls[1].issueId, 'issue-1');
  assert.equal(calls[1].payload.runId, 'run-1');
});

test('Paperclip heartbeat 没有任务时不生成本地队列', async () => {
  const handler = new PaperclipHeartbeatHandler({ operator:{ async execute() { throw new Error('不应执行'); } }, governance:{} });
  const result = await handler.handle({ runId:'run-1', agentId:'agent-1', context:{} });
  assert.deepEqual(result, { accepted:true, skipped:true, reason:'当前 heartbeat 没有分配任务。' });
});

test('Paperclip heartbeat 缺少标识会被拒绝', async () => {
  const handler = new PaperclipHeartbeatHandler({ operator:{}, governance:{} });
  await assert.rejects(() => handler.handle({ context:{ taskId:'issue-1' } }), PaperclipHeartbeatError);
});

test('已完成或并发的 Paperclip 任务不会重复执行', async () => {
  let executes = 0;
  let resolveExecute;
  const handler = new PaperclipHeartbeatHandler({
    operator: { async execute() { executes += 1; await new Promise((resolve) => { resolveExecute = resolve; }); return { status:'succeeded', currentStage:'health_report_ready' }; } },
    governance: { async getPaperclipIssue() { return { status:'in_progress' }; }, async completePaperclipIssue() {} }
  });
  const first = handler.handle({ runId:'run-1', agentId:'agent-1', context:{ taskId:'issue-1' } });
  const second = handler.handle({ runId:'run-2', agentId:'agent-1', context:{ taskId:'issue-1' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executes, 1);
  resolveExecute();
  await Promise.all([first, second]);

  const completed = new PaperclipHeartbeatHandler({ operator:{ async execute() { throw new Error('不应执行'); } }, governance:{ async getPaperclipIssue() { return { status:'done' }; } } });
  assert.deepEqual(await completed.handle({ runId:'run-3', agentId:'agent-1', context:{ taskId:'issue-1' } }), { accepted:true, skipped:true, issueId:'issue-1', reason:'任务已完成，不重复执行。' });
});

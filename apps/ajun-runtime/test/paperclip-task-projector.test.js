import assert from 'node:assert/strict';
import test from 'node:test';
import { PaperclipTaskProjector } from '../src/paperclip-task-projector.js';

test('任务投影 Module 通过语义 Client 创建 Issue 与审批', async () => {
  const calls = [];
  const endpoint = {
    async request(method, path, { body } = {}) {
      calls.push({ method, path, body });
      if (path === '/api/companies') return [{ id:'company-1', name:'Agent军团' }];
      if (path.endsWith('/agents')) return [{ id:'agent-1', name:'运维官', status:'active', metadata:{ agentArmyId:'operator' } }];
      if (path.endsWith('/issues')) return { id:'issue-1', identifier:'ARMY-1' };
      if (path.endsWith('/approvals')) return { id:'approval-1' };
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  const projector = new PaperclipTaskProjector({
    endpoint,
    clock:() => new Date('2026-08-03T00:00:00.000Z'),
  });
  const result = await projector.project({
    taskId:'task-1', taskType:'operations.health-review', status:'queued', priority:'normal',
    assigneeAgentId:'operator', input:{ title:'健康检查', description:'只读检查' },
  }, { action:'inspect', riskLevel:'low', reason:'test', requestedScope:{} });
  assert.equal(result.paperclipIssueId, 'issue-1');
  assert.equal(result.paperclipApprovalId, 'approval-1');
  assert.equal(calls.some((call) => call.path === '/api/companies/company-1/issues'), true);
});

test('任务投影 Module 在 Paperclip 不可用时返回可重试投影状态', async () => {
  const projector = new PaperclipTaskProjector({
    endpoint:{ async request() { throw new Error('offline'); } },
    clock:() => new Date('2026-08-03T00:00:00.000Z'),
  });
  const result = await projector.project({
    taskId:'task-1', taskType:'report.public-material', status:'queued',
    input:{ title:'公开报告', description:'' },
  });
  assert.deepEqual(result, {
    status:'sync_pending',
    reason:'offline',
    syncedAt:'2026-08-03T00:00:00.000Z',
  });
});

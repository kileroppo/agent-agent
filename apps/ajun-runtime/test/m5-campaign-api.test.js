import assert from 'node:assert/strict';
import test from 'node:test';
import { routeM5CampaignApi } from '../src/m5-campaign-api.ts';

test('M5 Campaign 路由在进入领域服务前统一执行本机门禁', async () => {
  let calls = 0;
  const result = await routeM5CampaignApi({
    method:'POST', url:'/api/content-campaigns', local:false,
    readBody:async () => ({ campaignId:'private' }),
    getService:async () => { calls += 1; return {}; },
  });
  assert.equal(result.status, 403);
  assert.equal(calls, 0);
});

test('M5 Campaign 路由把草案与控制命令委托给同一个领域接口', async () => {
  const calls = [];
  const service = {
    async createDraft(input) { calls.push(['create', input]); return { id:'campaign-1' }; },
    async control(id, action, input) { calls.push(['control', id, action, input]); return { id, status:action }; },
  };
  const created = await routeM5CampaignApi({
    method:'POST', url:'/api/content-campaigns', local:true,
    readBody:async () => ({ campaignId:'campaign-1' }), getService:async () => service,
  });
  const paused = await routeM5CampaignApi({
    method:'POST', url:'/api/content-campaigns/aaaaaaaa/pause', local:true,
    readBody:async () => ({ reason:'maintenance' }), getService:async () => service,
  });
  assert.equal(created.status, 201);
  assert.equal(paused.status, 200);
  assert.deepEqual(calls, [
    ['create', { campaignId:'campaign-1' }],
    ['control', 'aaaaaaaa', 'pause', { reason:'maintenance' }],
  ]);
});

test('M5 Hermes 路由验证 assignment、记录产物并在失败时登记恢复事实', async () => {
  const calls = [];
  const tasks = {
    async getPaperclipAssignment(input) { calls.push(['verify', input.paperclipApiKey]); return { task:{ taskId:'task-1' }, assignment:{ id:'assignment-1' } }; },
    async recordM5StageExecution(taskId, result) { calls.push(['record', taskId]); return { artifact:{ id:'artifact-1' }, duplicate:false, result }; },
  };
  const result = await routeM5CampaignApi({
    method:'POST', url:'/api/mcp/m5-stage-execute', local:true, paperclipApiKey:'run-key',
    readBody:async () => ({ issueId:'issue-1' }), tasks,
    getService:async () => ({ async executeHermesStage(){ return { status:'succeeded' }; } }),
  });
  assert.equal(result.status, 200);
  assert.deepEqual(calls, [['verify', 'run-key'], ['record', 'task-1']]);
});

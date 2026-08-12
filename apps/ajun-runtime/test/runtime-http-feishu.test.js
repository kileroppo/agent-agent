import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { presentCommanderReply, presentTaskStatus, resolveTaskCardAction } from '../src/runtime-http-feishu.js';
import { createAjunHttpHandler } from '../src/runtime-http-handler.js';

const taskId = '7df3c85a-1111-2222-3333-444444444444';

test('飞书任务回执把业务内容、唯一下一步和短任务入口组成一个闭环', () => {
  const result = presentCommanderReply({
    kind:'media_task',
    task:{
      taskId,
      status:'queued',
      input:{ title:'整理这个视频' },
    },
    reply:`已交给小D处理公开素材，任务号：${taskId}。完成后会回到当前飞书会话。`,
  }, 'http://127.0.0.1:4321');

  assert.match(result.reply, /^已交给小D处理公开素材/);
  assert.match(result.reply, /下一步：无需重复提交；开始处理后会更新进度。/);
  assert.equal(result.reply.match(/查看任务 #7DF3C85A/g)?.length, 1);
  assert.equal(result.reply.match(/下一步：/g)?.length, 1);
  assert.equal(result.presentation.taskRef, '#7DF3C85A');
  assert.equal(result.taskCard.schemaVersion, 'agent.army/task-card/v1');
  assert.equal(result.taskCard.taskId, taskId);
  assert.equal(result.taskCard.state, 'queued');
});

test('已有明确下一步的业务回复不会再追加第二个动作', () => {
  const result = presentCommanderReply({
    kind:'task_status',
    task:{
      taskId,
      status:'waiting_approval',
      input:{ title:'发送周报' },
    },
    reply:'发送周报正在等待确认。\n下一步：请核对收件人和内容范围。',
  }, 'http://127.0.0.1:4321');

  assert.equal(result.reply.match(/下一步：/g)?.length, 1);
  assert.match(result.reply, /请核对收件人和内容范围/);
  assert.match(result.reply, /查看任务 #7DF3C85A/);
});

test('业务正文已经完整表达下一步时不重复同一句话', () => {
  const result = presentCommanderReply({
    kind:'task_status',
    task:{
      taskId,
      status:'needs_input',
      input:{ title:'整理员工资料' },
      error:{ userMessage:'请补充员工名单。' },
    },
    reply:'请补充员工名单。',
  }, 'http://127.0.0.1:4321');

  assert.equal(result.reply.match(/请补充员工名单/g)?.length, 1);
  assert.match(result.reply, /查看任务 #7DF3C85A/);
});

test('不带任务的普通对话保持原样', () => {
  const payload = { kind:'identity', reply:'我是A君。' };
  assert.equal(presentCommanderReply(payload, 'http://127.0.0.1:4321'), payload);
});

test('Commander 投影使用调用方传入的审批事实，不自行读取状态', () => {
  const result = presentCommanderReply({
    task:{ taskId, status:'running', input:{ title:'发送周报' } },
    reply:'周报已进入处理队列。',
  }, 'http://127.0.0.1:4321', {
    approvals:[{
      approvalId:'approval-1',
      taskId,
      status:'pending',
      governanceMode:'paperclip',
    }],
    owner:'小办',
  });

  assert.equal(result.taskCard.state, 'waiting_approval');
  assert.equal(result.taskCard.owner, '小办');
  assert.deepEqual(result.taskCard.actions.map(({ action }) => action), ['approve', 'reject']);
});

test('任务状态接口保留旧字段并附加同一 task-card/v1 投影', () => {
  const result = presentTaskStatus({
    taskId,
    status:'recovery_pending',
    terminal:false,
    message:'运维官正在接手。',
  }, {
    taskId,
    status:'failed',
    input:{ title:'整理公开视频' },
    updatedAt:'2026-08-12T03:00:00.000Z',
  }, { owner:'运维官' });

  assert.equal(result.status, 'recovery_pending');
  assert.equal(result.message, '运维官正在接手。');
  assert.equal(result.taskCard.state, 'recovery_pending');
  assert.equal(result.taskCard.taskId, taskId);
  assert.equal(result.taskCard.owner, '运维官');
});

test('Commander 与任务状态 HTTP API 返回相同版本的权威卡片投影', async (context) => {
  const task = {
    taskId,
    status:'running',
    input:{ title:'整理公开资料' },
    source:{ channel:'feishu', chatRef:'chat-1' },
    updatedAt:'2026-08-12T03:00:00.000Z',
  };
  const approvals = [];
  const fixture = await startFeishuHandler(context, {
    work:{
      store:{
        async list() { return [task]; },
        async listApprovals() { return approvals; },
      },
      tasks:{
        async recoveryView() { return { actions:[] }; },
        async notificationStatus(receivedTaskId, chatRef) {
          assert.equal(receivedTaskId, taskId);
          assert.equal(chatRef, 'chat-1');
          return { taskId, status:'running', terminal:false, message:'正在整理公开资料。' };
        },
      },
    },
    feishu:{
      commander:{
        async handle() { return { kind:'media_task', task, reply:'任务已登记。' }; },
      },
    },
  });

  const commander = await postJson(`${fixture.baseUrl}/api/feishu/commander`, { text:'整理资料' });
  assert.equal(commander.response.status, 202);
  assert.equal(commander.body.taskCard.schemaVersion, 'agent.army/task-card/v1');

  const status = await postJson(`${fixture.baseUrl}/api/feishu/task-status`, { taskId, chatRef:'chat-1' });
  assert.equal(status.response.status, 200);
  assert.equal(status.body.taskCard.schemaVersion, commander.body.taskCard.schemaVersion);
  assert.equal(status.body.taskCard.taskId, commander.body.taskCard.taskId);
  assert.equal(status.body.taskCard.contentHash, commander.body.taskCard.contentHash);
  assert.equal(status.body.message, '正在整理公开资料。');
});

test('恢复子任务推进时卡片 revision 随链上权威时间变化', () => {
  const root = {
    taskId,
    status:'failed',
    input:{ title:'整理公开视频' },
    updatedAt:'2026-08-12T03:00:00.000Z',
  };
  const running = presentTaskStatus({
    taskId,
    status:'technical_repair',
    terminal:false,
    message:'技术专家正在处理。',
    projectionTruth:{
      taskId:'repair-1', status:'running', revision:'3', updatedAt:'2026-08-12T03:01:00.000Z',
    },
  }, root);
  const waitingTest = presentTaskStatus({
    taskId,
    status:'waiting_test',
    terminal:true,
    message:'已保留待测试结果。',
    projectionTruth:{
      taskId:'repair-1', status:'waiting_test', revision:'4', updatedAt:'2026-08-12T03:02:00.000Z',
    },
  }, root);

  assert.equal(running.projectionTruth, undefined);
  assert.equal(waitingTest.projectionTruth, undefined);
  assert.equal(running.taskCard.state, 'technical_repair');
  assert.equal(waitingTest.taskCard.state, 'waiting_test');
  assert.notEqual(waitingTest.taskCard.sourceRevision, running.taskCard.sourceRevision);
  assert.notEqual(waitingTest.taskCard.contentHash, running.taskCard.contentHash);
});

test('任务卡审批先写权威决定再返回无旧按钮的最新投影', async () => {
  let task = {
    taskId,
    status:'waiting_approval',
    approvalRefs:['approval-1'],
    input:{ title:'发送周报' },
    source:{ channel:'feishu', chatRef:'chat-1' },
    updatedAt:'2026-08-12T03:00:00.000Z',
  };
  let approvals = [{
    approvalId:'approval-1', taskId, status:'pending', governanceMode:'local',
    createdAt:'2026-08-12T03:01:00.000Z',
  }];
  const store = {
    async getTask() { return task; },
    async listApprovals() { return approvals; },
  };
  const tasks = { async recoveryView() { return { actions:[] }; } };
  const current = presentCommanderReply({ task, reply:'等待审批。' }, '', { approvals }).taskCard;
  const result = await resolveTaskCardAction({
    taskId,
    action:'approve',
    approvalId:'approval-1',
    chatRef:'chat-1',
    sourceRevision:current.sourceRevision,
    contentHash:current.contentHash,
  }, {
    store,
    tasks,
    resolveApproval:async () => {
      approvals = [{ ...approvals[0], status:'approved', decidedAt:'2026-08-12T03:02:00.000Z' }];
      task = { ...task, status:'running', updatedAt:'2026-08-12T03:02:00.000Z' };
    },
  });

  assert.equal(result.taskCard.state, 'running');
  assert.deepEqual(result.taskCard.actions, []);
  const stale = await resolveTaskCardAction({
      taskId,
      action:'approve',
      approvalId:'approval-1',
      chatRef:'chat-1',
      sourceRevision:current.sourceRevision,
      contentHash:current.contentHash,
    }, { store, tasks, resolveApproval:async () => {} });
  assert.equal(stale.actionApplied, false);
  assert.equal(stale.reason, 'stale_projection');
  assert.equal(stale.taskCard.state, 'running');
});

test('任务卡仅为真实小D作业开放暂停并返回新审批态', async () => {
  let task = {
    taskId,
    status:'running',
    approvalRefs:[],
    input:{ title:'整理公开视频' },
    source:{ channel:'feishu', chatRef:'chat-1' },
    execution:{ executor:'xiaod', xiaodJobId:'job-1' },
    updatedAt:'2026-08-12T03:00:00.000Z',
  };
  let approvals = [];
  const store = {
    async getTask() { return task; },
    async listApprovals() { return approvals; },
  };
  const tasks = {
    async recoveryView() { return { actions:[] }; },
    async requestPause() {
      approvals = [{ approvalId:'pause-1', taskId, action:'pause-task', status:'pending', governanceMode:'paperclip' }];
      task = { ...task, approvalRefs:['pause-1'], updatedAt:'2026-08-12T03:01:00.000Z' };
    },
  };
  const current = presentCommanderReply({ task, reply:'正在处理。' }, '', { approvals }).taskCard;
  assert.deepEqual(current.actions.map((item) => item.action), ['pause']);
  const result = await resolveTaskCardAction({
    taskId,
    action:'pause',
    chatRef:'chat-1',
    sourceRevision:current.sourceRevision,
    contentHash:current.contentHash,
  }, { store, tasks, resolveApproval:async () => {} });
  assert.equal(result.taskCard.state, 'waiting_approval');
  assert.deepEqual(result.taskCard.actions.map((item) => item.action), ['approve', 'reject']);
  assert.deepEqual(result.taskCard.actions.map((item) => item.label), ['确认暂停', '保持运行']);
});

test('进度刚更新但仍可暂停时沿用用户意图，不把正常竞态报成失败', async () => {
  let task = {
    taskId,
    status:'running',
    approvalRefs:[],
    input:{ title:'整理公开视频' },
    source:{ channel:'feishu', chatRef:'chat-1' },
    execution:{ executor:'xiaod', xiaodJobId:'job-1', xiaodProgress:40 },
    updatedAt:'2026-08-12T03:01:00.000Z',
  };
  let approvals = [];
  let pauseRequests = 0;
  const store = {
    async getTask() { return task; },
    async listApprovals() { return approvals; },
  };
  const tasks = {
    async recoveryView() { return { actions:[] }; },
    async requestPause() {
      pauseRequests += 1;
      approvals = [{ approvalId:'pause-latest', taskId, action:'pause-task', status:'pending', governanceMode:'paperclip' }];
      task = { ...task, approvalRefs:['pause-latest'], updatedAt:'2026-08-12T03:02:00.000Z' };
    },
  };

  const result = await resolveTaskCardAction({
    taskId,
    action:'pause',
    chatRef:'chat-1',
    sourceRevision:'2026-08-12T03:00:00.000Z:0',
    contentHash:'stale-card-hash',
  }, { store, tasks, resolveApproval:async () => {} });

  assert.equal(pauseRequests, 1);
  assert.equal(result.actionApplied, true);
  assert.equal(result.taskCard.state, 'waiting_approval');
  assert.deepEqual(result.taskCard.actions.map((item) => item.label), ['确认暂停', '保持运行']);
});

test('任务已经进入下一阶段时点击旧暂停按钮会刷新卡片而不报错', async () => {
  const task = {
    taskId,
    status:'needs_input',
    input:{ title:'整理公开视频' },
    source:{ channel:'feishu', chatRef:'chat-1' },
    execution:{ executor:'xiaod', xiaodJobId:'job-1', xiaodProgress:92 },
    updatedAt:'2026-08-12T03:02:00.000Z',
  };
  const store = {
    async getTask() { return task; },
    async listApprovals() { return []; },
  };
  const tasks = {
    async recoveryView() { return { actions:[] }; },
    async requestPause() { assert.fail('阶段变化后不得再申请暂停'); },
  };

  const result = await resolveTaskCardAction({
    taskId,
    action:'pause',
    chatRef:'chat-1',
    sourceRevision:'2026-08-12T03:00:00.000Z:0',
    contentHash:'stale-card-hash',
  }, { store, tasks, resolveApproval:async () => {} });

  assert.equal(result.actionApplied, false);
  assert.equal(result.reason, 'stale_projection');
  assert.equal(result.taskCard.state, 'needs_input');
  assert.deepEqual(result.taskCard.actions, []);
});

async function startFeishuHandler(context, { work, feishu }) {
  const handler = createAjunHttpHandler({
    environment:{},
    publicDir:new URL('../public', import.meta.url).pathname,
    dataDir:'/tmp/agent-army-task-card-http-test',
    detailBaseUrl:'http://127.0.0.1:4321',
    network:{ deploymentMode:'local', lanEnabled:false, lanAccess:{ enabled:false, key:null } },
    paperclip:{},
    work:{
      proposals:{}, missions:{}, macWorker:{}, xiaod:{},
      boomMonitor:null, boomMonitorEnabled:false,
      ...work,
    },
    connections:{},
    localAi:null,
    feishu:{
      officialFeishuChannel:{}, hermesNativeCompletionWatcher:{},
      resolveFeishuApproval:async () => {},
      ...feishu,
    },
    m5:{},
  });
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return { baseUrl:`http://127.0.0.1:${server.address().port}` };
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify(body),
  });
  return { response, body:await response.json() };
}

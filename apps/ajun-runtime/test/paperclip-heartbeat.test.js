import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOperationsHealthIncidentDispatcher,
  PaperclipCampaignDailyHandler,
  PaperclipHeartbeatError,
  PaperclipHeartbeatHandler,
} from '../src/paperclip-heartbeat.js';

test('M5 每日 HTTP heartbeat 无模型、无自由参数地执行唯一确定性激活', async () => {
  const calls = [];
  const activation = {
    campaignCaseId:'campaign-1',
    dayCaseId:'day-1',
    scheduledDate:'2026-08-03',
    activated:true,
    replayed:false,
    stageKey:'topic',
  };
  const handler = new PaperclipCampaignDailyHandler({
    now:() => new Date('2026-08-03T01:00:00.000Z'),
    campaignActivator:async (...args) => {
      calls.push({ kind:'activate', args });
      return activation;
    },
    governance:{
      async verifySystemAssignment(input) {
        calls.push({ kind:'verify', input });
        return { issue:{
          status:'in_progress',
          assigneeAgentId:'controller-1',
          description:'[agent-army:m5:routine:m5-daily-campaign] 固定日程入口',
        } };
      },
      async completePaperclipIssue(issueId, payload) {
        calls.push({ kind:'complete', issueId, payload });
      },
    },
  });

  const result = await handler.handle({
    runId:'run-1',
    agentId:'controller-1',
    context:{ taskId:'issue-1' },
  });

  assert.deepEqual(calls[0], {
    kind:'verify',
    input:{
      issueId:'issue-1',
      runId:'run-1',
      paperclipAgentId:'controller-1',
      systemRole:'m5-daily-controller',
    },
  });
  assert.deepEqual(calls[1], { kind:'activate', args:[] });
  assert.equal(calls[2].issueId, 'issue-1');
  assert.equal(calls[2].payload.result.execution.executor, 'm5-daily-http-controller');
  assert.equal(calls[2].payload.result.artifactRefs[0].validation.deterministic, true);
  assert.deepEqual(calls[2].payload.result.artifactRefs[0].data, activation);
  assert.equal(result.activation.scheduledDate, '2026-08-03');
});

test('M5 每日 HTTP heartbeat 拒绝非固定 Routine 或控制器身份漂移', async (t) => {
  for (const [label, issue, message] of [
    ['身份漂移', {
      status:'in_progress',
      assigneeAgentId:'controller-other',
      description:'[agent-army:m5:routine:m5-daily-campaign]',
    }, /身份不一致/],
    ['非每日 Routine', {
      status:'in_progress',
      assigneeAgentId:'controller-1',
      description:'[agent-army:m5:routine:m5-topic]',
    }, /只接受 M5 每日 Routine/],
  ]) {
    await t.test(label, async () => {
      const handler = new PaperclipCampaignDailyHandler({
        campaignActivator:async () => { throw new Error('不应执行'); },
        governance:{ async verifySystemAssignment() {
          if (label === '身份漂移') throw new Error('Paperclip HTTP 系统控制器身份不一致。');
          return { issue };
        } },
      });
      await assert.rejects(() => handler.handle({
        runId:'run-1',
        agentId:'controller-1',
        context:{ taskId:'issue-1' },
      }), label === '身份漂移' ? /系统控制器身份不一致/ : message);
    });
  }

  await t.test('调用方试图指定活动或日期', async () => {
    const handler = new PaperclipCampaignDailyHandler({
      campaignActivator:async () => { throw new Error('不应执行'); },
      governance:{ async verifySystemAssignment() { throw new Error('不应核验'); } },
    });
    await assert.rejects(() => handler.handle({
      runId:'run-1',
      agentId:'controller-1',
      context:{
        taskId:'issue-1',
        campaignId:'caller-selected',
        scheduledDate:'2099-01-01',
      },
    }), /不接受调用方指定/);
  });
});

test('Paperclip 健康 heartbeat 由无模型控制器执行并隐藏成功记录', async () => {
  const calls = [];
  const handler = new PaperclipHeartbeatHandler({
    now: () => new Date('2026-07-20T12:00:00.000Z'),
    operator: { async execute(task) { calls.push(task); return { status:'succeeded', currentStage:'health_report_ready', artifactRefs:[{ type:'health_report', data:{ overall:'healthy' } }] }; } },
    governance: {
      async verifySystemAssignment(input) { calls.push({ kind:'verify', input }); return { issue:{ status:'in_progress', description:'[agent-army:operations-health:routine]' } }; },
      async completePaperclipIssue(issueId, payload) { calls.push({ kind:'complete', issueId, payload }); },
    },
    incidentDispatcher:async () => { throw new Error('健康时不应唤醒运维官模型'); },
  });
  const result = await handler.handle({ runId:'run-1', agentId:'agent-1', context:{ taskId:'issue-1' } });
  assert.deepEqual(calls[0], {
    kind:'verify',
    input:{
      issueId:'issue-1',
      runId:'run-1',
      paperclipAgentId:'agent-1',
      systemRole:'operations-health-controller',
    },
  });
  assert.equal(calls[1].taskId, 'issue-1');
  assert.equal(calls[2].kind, 'complete');
  assert.equal(calls[2].issueId, 'issue-1');
  assert.equal(calls[2].payload.runId, 'run-1');
  assert.equal(calls[2].payload.hideFromDashboard, true);
  assert.deepEqual(result, { accepted:true, issueId:'issue-1', stage:'health_report_ready', status:'succeeded', health:'healthy', incident:null });
});

test('Paperclip 健康 heartbeat 只在异常时派发运维事故并保留可见证据', async () => {
  const calls = [];
  const report = {
    checkedAt:'2026-08-06T02:30:00.000Z',
    overall:'degraded',
    components:[
      { id:'ajun-runtime', status:'healthy' },
      { id:'xiaod', status:'degraded', evidence:{ errorCode:'health_unreachable' } },
    ],
  };
  const handler = new PaperclipHeartbeatHandler({
    now:() => new Date('2026-08-06T02:30:00.000Z'),
    operator:{ async execute() {
      calls.push({ kind:'health' });
      return { status:'succeeded', currentStage:'health_report_ready', artifactRefs:[{ type:'health_report', data:report }] };
    } },
    governance:{
      async verifySystemAssignment() { return { issue:{ status:'in_progress', description:'[agent-army:operations-health:routine]' } }; },
      async completePaperclipIssue(issueId, payload) { calls.push({ kind:'complete', issueId, payload }); },
    },
    async incidentDispatcher(input) {
      calls.push({ kind:'incident', input });
      return { taskId:'incident-1', status:'queued' };
    },
  });

  const result = await handler.handle({ runId:'run-2', agentId:'health-controller-1', context:{ taskId:'issue-2' } });

  assert.equal(calls[0].kind, 'health');
  assert.deepEqual(calls[1], {
    kind:'incident',
    input:{
      sourceIssueId:'issue-2',
      sourceRunId:'run-2',
      checkedAt:'2026-08-06T02:30:00.000Z',
      report,
    },
  });
  assert.equal(calls[2].kind, 'complete');
  assert.equal(calls[2].payload.hideFromDashboard, false);
  assert.deepEqual(result.incident, { taskId:'incident-1', status:'queued' });
  assert.equal(result.health, 'degraded');
});

test('同一天的同类健康异常复用同一事故幂等键', async () => {
  const requests = [];
  const dispatch = createOperationsHealthIncidentDispatcher({
    tasks:{ async create(input) { requests.push(input); return { taskId:'incident-1', status:'queued' }; } },
  });
  const report = {
    overall:'degraded',
    components:[
      { id:'xiaod', name:'小D素材处理', status:'degraded', evidence:{ errorCode:'health_unreachable' } },
      { id:'ajun-runtime', name:'A君运行台', status:'healthy' },
    ],
  };

  await dispatch({ sourceIssueId:'issue-1', sourceRunId:'run-1', checkedAt:'2026-08-06T01:00:00.000Z', report });
  await dispatch({ sourceIssueId:'issue-2', sourceRunId:'run-2', checkedAt:'2026-08-06T09:00:00.000Z', report });

  assert.equal(requests[0].taskType, 'operations.incident-response');
  assert.equal(requests[0].agentId, 'operator');
  assert.equal(requests[0].idempotencyKey, requests[1].idempotencyKey);
  assert.match(requests[0].idempotencyKey, /^operations-health-incident:2026-08-06:/);
  assert.deepEqual(requests[0].context.healthIncident.unhealthyComponents, [
    { componentId:'xiaod', name:'小D素材处理', status:'degraded', errorCode:'health_unreachable' },
  ]);
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

test('本机健康控制器拒绝非巡检 Routine 任务', async () => {
  const handler = new PaperclipHeartbeatHandler({
    operator:{ async execute() { throw new Error('不应执行'); } },
    governance:{ async verifySystemAssignment() { return { issue:{ status:'in_progress', description:'普通任务' } }; } },
  });
  await assert.rejects(
    () => handler.handle({ runId:'run-1', agentId:'controller-1', context:{ taskId:'issue-1' } }),
    /只接受本机健康巡检 Routine/,
  );
});

test('已完成或并发的 Paperclip 任务不会重复执行', async () => {
  let executes = 0;
  let resolveExecute;
  const handler = new PaperclipHeartbeatHandler({
    operator: { async execute() { executes += 1; await new Promise((resolve) => { resolveExecute = resolve; }); return { status:'succeeded', currentStage:'health_report_ready' }; } },
    governance: { async verifySystemAssignment() { return { issue:{ status:'in_progress', description:'[agent-army:operations-health:routine]' } }; }, async completePaperclipIssue() {} }
  });
  const first = handler.handle({ runId:'run-1', agentId:'agent-1', context:{ taskId:'issue-1' } });
  const second = handler.handle({ runId:'run-2', agentId:'agent-1', context:{ taskId:'issue-1' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executes, 1);
  resolveExecute();
  await Promise.all([first, second]);

  const completed = new PaperclipHeartbeatHandler({ operator:{ async execute() { throw new Error('不应执行'); } }, governance:{ async verifySystemAssignment() { return { issue:{ status:'done', description:'[agent-army:operations-health:routine]' } }; } } });
  assert.deepEqual(await completed.handle({ runId:'run-3', agentId:'agent-1', context:{ taskId:'issue-1' } }), { accepted:true, skipped:true, issueId:'issue-1', reason:'任务已完成，不重复执行。' });
});

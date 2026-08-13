import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AgentArmyTaskInputError,
  missionClientInputFromTool,
  missionCreateToolInputSchema,
  prepareMissionCreateRequest,
  prepareTaskCreateRequest,
  taskClientInputFromTool,
  taskCreateToolInputSchema,
} from '../src/contracts/agent-army-task-input.js';
import {
  normalizeMissionHttpInput,
  normalizeTaskHttpInput,
} from '../src/contracts/agent-army-http-input.js';
import {
  createMissionHttpResult,
  createTaskHttpResult,
  projectMcpToolValue,
} from '../src/contracts/agent-army-adapter-projection.js';

test('共享任务输入契约统一 MCP schema、snake_case 映射和岗位来源身份', () => {
  const parsed = taskCreateToolInputSchema.parse({
    title:'形成公开资料研究报告',
    task_type:'research.intel-report',
    agent_id:'intel-researcher',
    goal:'输出带来源的结论',
    acceptance_criteria:['事实与判断分开'],
    chat_ref:'oc-contract',
  });
  const input = taskClientInputFromTool(parsed, {
    agentIds:['intel-researcher'],
    taskTypes:['research.intel-report'],
    profileId:'intel-researcher-profile',
    taskCardPolicy:'routed-task',
  });

  assert.equal(input.taskType, 'research.intel-report');
  assert.equal(input.sourceAgentId, 'intel-researcher');
  assert.equal(input.sourceProfileId, 'intel-researcher-profile');
  assert.equal(input.taskCardPolicy, 'routed-task');
  assert.deepEqual(input.goalSpec.acceptanceCriteria, ['事实与判断分开']);
});

test('共享多人输入契约保留依赖图并执行同一岗位范围门禁', () => {
  const parsed = missionCreateToolInputSchema.parse({
    title:'整理并汇报',
    items:[
      { key:'collect', title:'整理资料', task_type:'media.transcribe-and-refine', agent_id:'xiaod' },
      { key:'brief', title:'形成汇报', task_type:'office.briefing-package', agent_id:'office-assistant', depends_on:['collect'] },
    ],
  });
  const mission = missionClientInputFromTool(parsed, { allowMissions:true, agentIds:[], taskTypes:[] });
  assert.deepEqual(mission.items[1].dependsOn, ['collect']);
  assert.equal(mission.waitForTerminal, true);

  assert.throws(
    () => missionClientInputFromTool(parsed, { allowMissions:false, agentIds:['xiaod'], taskTypes:[] }),
    (error) => error instanceof AgentArmyTaskInputError && /不能创建多人总任务/.test(error.message),
  );
});

test('Client 请求契约集中清洗来源、幂等键和任务/总任务 HTTP payload', () => {
  const task = prepareTaskCreateRequest({
    title:'  整理\u0000公开资料  ',
    taskType:'research.intel-report',
    chatRef:'oc-contract',
    requestRef:'message-contract',
    sourceAgentId:'intel-researcher',
    sourceProfileId:'profile-contract',
    sourceTaskIds:['source-task-1234'],
  }, { now:() => 60_000 });
  assert.equal(task.kind, 'task');
  assert.equal(task.body.title, '整理 公开资料');
  assert.equal(task.body.idempotencyKey, 'hermes:message-contract');
  assert.deepEqual(task.body.context, {
    sourceTaskIds:['source-task-1234'],
    dependsOnPrevious:true,
  });
  assert.equal(task.body.source.profileId, 'profile-contract');

  const mission = prepareMissionCreateRequest({
    title:'形成汇报',
    chatRef:'oc-contract',
    items:[{ title:'整理资料', taskType:'research.intel-report', agentId:'intel-researcher' }],
  }, { now:() => 90_000 });
  assert.match(mission.body.idempotencyKey, /^hermes-mission:oc-contract:/);
  assert.equal(mission.body.items[0].key, 'work-1');
  assert.throws(
    () => prepareTaskCreateRequest({ title:'坏链接', taskType:'research.intel-report', sourceUrls:['not-a-url'] }),
    /链接格式不正确/,
  );
  const ftpTask = { title:'坏协议', task_type:'research.intel-report', source_urls:['ftp://example.com/a'] };
  assert.equal(taskCreateToolInputSchema.safeParse(ftpTask).success, false);
  assert.equal(missionCreateToolInputSchema.safeParse({
    title:'坏协议总任务',
    items:[{ title:'整理资料', task_type:'research.intel-report', agent_id:'intel-researcher', source_urls:['ftp://example.com/a'] }],
  }).success, false);
  assert.throws(
    () => normalizeTaskHttpInput({ title:'坏协议', taskType:'research.intel-report', sourceUrls:['ftp://example.com/a'] }),
    /统一契约/,
  );
  assert.throws(
    () => normalizeTaskHttpInput({ title:'坏协议', taskType:'research.intel-report', sourceUrl:'ftp://example.com/a' }),
    /统一契约/,
  );
  assert.throws(
    () => normalizeMissionHttpInput({
      title:'坏协议总任务',
      items:[{ title:'整理资料', taskType:'research.intel-report', agentId:'intel-researcher', sourceUrls:['ftp://example.com/a'] }],
    }),
    /多人任务输入不符合统一契约/,
  );
  assert.throws(
    () => prepareMissionCreateRequest({
      title:'坏协议总任务',
      items:[{ title:'整理资料', taskType:'research.intel-report', agentId:'intel-researcher', sourceUrls:['ftp://example.com/a'] }],
    }),
    /链接格式不正确/,
  );
  assert.throws(
    () => prepareTaskCreateRequest({ title:'坏时长', taskType:'research.intel-report', durationSeconds:1 }),
    /15 到 600 秒/,
  );
});

test('HTTP 与 MCP 投影契约统一创建回执和结构化工具结果', async () => {
  const watched = [];
  const completionWatcher = {
    async watch(input) { watched.push(input); },
  };
  const input = {
    title:'整理资料',
    source:{ channel:'feishu', chatRef:'oc-contract' },
  };
  const task = await createTaskHttpResult(input, {
    tasks:{ async create(value) { return { taskId:'task-contract', source:value.source, input:value }; } },
    completionWatcher,
  });
  assert.equal(task.task.taskId, 'task-contract');
  assert.equal(task.completionWatch.registered, true);

  const mission = await createMissionHttpResult(input, {
    missions:{ async createBusinessMission(value) { return { mission:{ taskId:'mission-contract', source:value.source }, children:[] }; } },
    completionWatcher,
  });
  assert.equal(mission.mission.taskId, 'mission-contract');
  assert.equal(mission.completionWatch.registered, true);
  assert.deepEqual(watched, [
    { taskId:'task-contract', chatId:'oc-contract' },
    { taskId:'mission-contract', chatId:'oc-contract' },
  ]);

  const projected = projectMcpToolValue([{ taskId:'task-contract', presentation:{ summary:'资料整理中。' } }]);
  assert.equal(projected.structuredContent.items[0].taskId, 'task-contract');
  assert.match(projected.content[0].text, /资料整理中/);
});

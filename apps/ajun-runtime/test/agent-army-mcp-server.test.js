import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createAgentArmyMcpServer, scopeFromEnvironment } from '../src/agent-army-mcp-server.js';

test('Agent Army MCP exposes factual read and controlled action tools', async (t) => {
  const calls = [];
  const clientApi = {
    capabilities:async () => ({
      employees:[{ agentId:'xiaod', name:'小D', role:'整理音视频', acceptedTaskTypes:['media.transcribe-and-refine'], capabilityTruth:{ overall:'live' } }],
      capabilities:[{ id:'task-coordination', name:'统一任务协调', detail:'任务可登记', truth:{ overall:'verified' } }],
    }),
    armyStatus:async () => ({ taskFocus:{ inProgress:0 } }),
    employeeStatus:async (employee) => ({ agentId:employee }),
    listTasks:async (input) => [{ taskId:'task-1234', ...input }],
    getTask:async (taskId) => ({ taskId }),
    createTask:async (input) => {
      calls.push(['create', input]);
      return {
        taskId:'task-created',
        presentation:{
          statusLabel:'处理中',
          summary:'整理公开视频：任务正在处理中。',
          taskRef:'#TASKCREA',
          nextAction:'等待结果即可。',
          detailUrl:'http://127.0.0.1:4321/tasks/task-created'
        }
      };
    },
    createMission:async (input) => { calls.push(['mission', input]); return { mission:{ taskId:'mission-created' }, children:[] }; },
    controlTask:async (taskId, action) => ({ task:{ taskId }, action }),
    listApprovals:async () => [],
    resolveApproval:async () => { throw new Error('not expected'); },
    revokePrivateReadGrant:async (approvalId, input) => { calls.push(['revoke-private-read', { approvalId, ...input }]); return { approval:{ approvalId, status:'approved', privateReadGrantStatus:{ status:'revoked' } } }; }
  };
  const { client, server } = await connect(clientApi);
  t.after(async () => { await client.close(); await server.close(); });

  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    ['agent_manual', 'agent_proposal_create_execute', 'approval_list', 'approval_resolve', 'capabilities', 'content_performance_review_execute', 'employee_assignment_execute', 'employee_status', 'm5_stage_execute', 'mission_create', 'operations_health_execute', 'paperclip_assignment_complete', 'paperclip_assignment_get', 'platform_content_draft_execute', 'private_read_grant_revoke', 'status', 'task_control', 'task_create', 'task_get', 'task_list', 'technical_repair_execute', 'video_content_analyze_execute', 'video_script_package_execute']
  );

  const allManuals = await client.callTool({ name:'agent_manual', arguments:{ agent:'all' } });
  assert.equal(allManuals.isError, undefined);
  assert.ok(allManuals.structuredContent.count >= 11);
  assert.match(allManuals.content[0].text, /小D使用说明书/);

  const capabilities = await client.callTool({ name:'capabilities', arguments:{} });
  assert.equal(capabilities.structuredContent.employees[0].agentId, 'xiaod');
  assert.match(capabilities.content[0].text, /岗位登记（不等于业务已验证）/);
  assert.match(capabilities.content[0].text, /小D：运行可达，待业务验证/);
  assert.doesNotMatch(capabilities.content[0].text, /全部可用|11 名全部可用/);

  const created = await client.callTool({
    name:'task_create',
    arguments:{ title:'整理公开视频', task_type:'media.transcribe-and-refine', agent_id:'xiaod' }
  });
  assert.equal(created.structuredContent.taskId, 'task-created');
  assert.match(created.content[0].text, /处理中 · 整理公开视频/);
  assert.match(created.content[0].text, /查看任务：http:\/\/127\.0\.0\.1:4321\/tasks\/task-created/);
  assert.doesNotMatch(created.content[0].text, /"status"/);
  assert.equal(calls[0][1].taskType, 'media.transcribe-and-refine');

  const revoked = await client.callTool({
    name:'private_read_grant_revoke',
    arguments:{ approval_id:'approval-1234', chat_ref:'chat-a' }
  });
  assert.equal(revoked.structuredContent.approval.privateReadGrantStatus.status, 'revoked');
  assert.deepEqual(calls.find((item) => item[0] === 'revoke-private-read')[1], { approvalId:'approval-1234', chatRef:'chat-a' });

  await client.callTool({
    name:'task_create',
    arguments:{
      title:'开放研究',
      task_type:'research.open-investigation',
      agent_id:'intel-researcher',
      goal:'形成有来源的比较报告',
      deliverables:['比较报告'],
      constraints:['只读公开来源'],
      acceptance_criteria:['结论区分事实和判断'],
      capability_requests:[{
        capability_id:'content.public.fetch',
        purpose:'读取公开资料'
      }],
      autonomy_budget:{
        max_duration_minutes:15,
        max_model_calls:6,
        max_concurrent_subtasks:2,
        max_dependency_depth:1,
        max_cost_usd:1.5
      }
    }
  });
  const researchCreate = calls.find((item) => item[0] === 'create' && item[1].title === '开放研究');
  assert.deepEqual(researchCreate[1].goalSpec, {
    outcome:'形成有来源的比较报告',
    deliverables:['比较报告'],
    constraints:['只读公开来源'],
    acceptanceCriteria:['结论区分事实和判断'],
    capabilityRequests:[{
      capabilityId:'content.public.fetch',
      purpose:'读取公开资料',
      source:undefined
    }],
    budget:{
      maxDurationMinutes:15,
      maxModelCalls:6,
      maxConcurrentSubtasks:2,
      maxDependencyDepth:1,
      maxCostUsd:1.5
    }
  });

  const mission = await client.callTool({
    name:'mission_create',
    arguments:{
      title:'完成老板本周内容任务',
      items:[
        { title:'整理公开视频', task_type:'media.transcribe-and-refine', agent_id:'xiaod', source_urls:['https://example.com/video'], review_policy:'required' },
        { title:'研究公开资料', task_type:'research.intel-report', agent_id:'intel-researcher' },
        {
          title:'整理统一汇报',
          task_type:'office.briefing-package',
          agent_id:'office-assistant',
          depends_on_previous:true,
          evidence_mode:'formal',
          depth:'full',
          focus:'结论',
          platforms:['douyin'],
          content_goal:'形成老板汇报'
        }
      ]
    }
  });
  assert.equal(mission.structuredContent.mission.taskId, 'mission-created');
  const missionCall = calls.find((item) => item[0] === 'mission');
  assert.equal(missionCall[1].items[2].agentId, 'office-assistant');
  assert.equal(missionCall[1].items[2].dependsOnPrevious, true);
  assert.equal(missionCall[1].items[0].reviewPolicy, 'required');
  assert.equal(missionCall[1].items[2].evidenceMode, 'formal');
  assert.equal(missionCall[1].items[2].depth, 'full');
  assert.equal(missionCall[1].items[2].focus, '结论');
  assert.deepEqual(missionCall[1].items[2].platforms, ['douyin']);
  assert.equal(missionCall[1].items[2].contentGoal, '形成老板汇报');
  assert.equal(missionCall[1].waitForTerminal, true);
});

test('MCP 的单任务和多人任务都保留分析模式', async (t) => {
  const calls = [];
  const clientApi = {
    capabilities:async () => ({}), armyStatus:async () => ({}), employeeStatus:async () => ({}),
    listTasks:async () => [], getTask:async () => ({}),
    createTask:async (input) => { calls.push(['task', input]); return { taskId:'analysis-created' }; },
    createMission:async (input) => { calls.push(['mission', input]); return { mission:{ taskId:'mission-created' }, children:[] }; },
    controlTask:async () => ({}), listApprovals:async () => [], resolveApproval:async () => ({})
  };
  const { client, server } = await connect(clientApi);
  t.after(async () => { await client.close(); await server.close(); });

  const task = await client.callTool({
    name:'task_create',
    arguments:{
      title:'探索表达风格',
      task_type:'content.video-benchmark-analysis',
      agent_id:'video-content-analyst',
      analysis_intent:'style'
    }
  });
  assert.equal(task.isError, undefined);
  assert.equal(calls[0][1].analysisIntent, 'style');

  const mission = await client.callTool({
    name:'mission_create',
    arguments:{
      title:'提取视频模板',
      items:[{
        title:'提取模板',
        task_type:'content.video-benchmark-analysis',
        agent_id:'video-content-analyst',
        analysis_intent:'template'
      }]
    }
  });
  assert.equal(mission.isError, undefined);
  assert.equal(calls[1][1].items[0].analysisIntent, 'template');
});

test('MCP 会修正模型误选的小R老板汇报并保留来源任务', async (t) => {
  const calls = [];
  const clientApi = {
    capabilities:async () => ({}), armyStatus:async () => ({}), employeeStatus:async () => ({}),
    listTasks:async () => [], getTask:async () => ({}),
    createTask:async (input) => { calls.push(['task', input]); return { taskId:'brief-created' }; },
    createMission:async (input) => { calls.push(['mission', input]); return { mission:{ taskId:'mission-created' }, children:[] }; },
    controlTask:async () => ({}), listApprovals:async () => [], resolveApproval:async () => ({})
  };
  const { client, server } = await connect(clientApi);
  t.after(async () => { await client.close(); await server.close(); });

  await client.callTool({
    name:'mission_create',
    arguments:{
      title:'完成两项工作并给老板汇报',
      items:[
        { title:'研究公开资料', task_type:'research.intel-report', agent_id:'intel-researcher' },
        { title:'等待前项完成后生成最终老板汇报', task_type:'research.intel-report', agent_id:'intel-researcher' }
      ]
    }
  });
  await client.callTool({
    name:'task_create',
    arguments:{
      title:'基于工作1真实失败记录和工作2已验证产物生成最终老板汇报',
      task_type:'research.intel-report',
      agent_id:'intel-researcher',
      source_task_ids:['task-source-1234']
    }
  });

  assert.equal(calls[0][1].items[1].taskType, 'office.briefing-package');
  assert.equal(calls[0][1].items[1].agentId, 'office-assistant');
  assert.equal(calls[0][1].items[1].dependsOnPrevious, true);
  assert.equal(calls[1][1].taskType, 'office.briefing-package');
  assert.equal(calls[1][1].agentId, 'office-assistant');
  assert.deepEqual(calls[1][1].sourceTaskIds, ['task-source-1234']);
});

test('多人交办不能被 task_create 吞成一条小D任务', async (t) => {
  const created = [];
  const clientApi = {
    capabilities:async () => ({}), armyStatus:async () => ({}), employeeStatus:async () => ({}),
    listTasks:async () => [], getTask:async () => ({}),
    createTask:async (input) => { created.push(input); return { taskId:'unexpected' }; },
    createMission:async () => ({ mission:{ taskId:'mission-created' }, children:[] }),
    controlTask:async () => ({}), listApprovals:async () => [], resolveApproval:async () => ({})
  };
  const { client, server } = await connect(clientApi);
  t.after(async () => { await client.close(); await server.close(); });

  const result = await client.callTool({
    name:'task_create',
    arguments:{
      title:'我有三项工作，请只建立一个总任务：\n1. 整理公开视频\n2. 查询公开资料\n3. 整理老板汇报',
      task_type:'media.transcribe-and-refine',
      agent_id:'xiaod'
    }
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /mission_create/);
  assert.equal(created.length, 0);
});

test('approval_resolve requires a live MCP elicitation confirmation', async (t) => {
  const decisions = [];
  const clientApi = {
    capabilities:async () => ({}), armyStatus:async () => ({}), employeeStatus:async () => ({}),
    listTasks:async () => [], getTask:async () => ({}), createTask:async () => ({}), controlTask:async () => ({}),
    listApprovals:async () => [{ approvalId:'approval-1234', reason:'需要确认本次范围', status:'pending' }],
    resolveApproval:async (approvalId, decision) => { decisions.push({ approvalId, decision }); return { task:{ taskId:'task-1234' } }; }
  };
  const { client, server } = await connect(clientApi, {
    elicitationHandler:async () => ({ action:'accept', content:{} })
  });
  t.after(async () => { await client.close(); await server.close(); });

  const result = await client.callTool({
    name:'approval_resolve',
    arguments:{ approval_id:'approval-1234', decision:'approve' }
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(decisions, [{ approvalId:'approval-1234', decision:'approve' }]);
});

test('approval_resolve fails closed when elicitation is declined', async (t) => {
  let resolved = false;
  const clientApi = {
    capabilities:async () => ({}), armyStatus:async () => ({}), employeeStatus:async () => ({}),
    listTasks:async () => [], getTask:async () => ({}), createTask:async () => ({}), controlTask:async () => ({}),
    listApprovals:async () => [{ approvalId:'approval-1234', reason:'需要确认', status:'pending' }],
    resolveApproval:async () => { resolved = true; return {}; }
  };
  const { client, server } = await connect(clientApi, {
    elicitationHandler:async () => ({ action:'decline' })
  });
  t.after(async () => { await client.close(); await server.close(); });

  const result = await client.callTool({
    name:'approval_resolve',
    arguments:{ approval_id:'approval-1234', decision:'approve' }
  });

  assert.equal(result.isError, true);
  assert.equal(resolved, false);
});

test('approval_resolve closes an explicitly rejected approval without asking to approve the rejection', async (t) => {
  const decisions = [];
  let elicited = false;
  const clientApi = {
    capabilities:async () => ({}), armyStatus:async () => ({}), employeeStatus:async () => ({}),
    listTasks:async () => [], getTask:async () => ({}), createTask:async () => ({}), controlTask:async () => ({}),
    listApprovals:async () => [{ approvalId:'approval-1234', reason:'需要确认', status:'pending' }],
    resolveApproval:async (approvalId, decision) => { decisions.push({ approvalId, decision }); return { task:{ taskId:'task-1234', status:'cancelled' } }; }
  };
  const { client, server } = await connect(clientApi, {
    elicitationHandler:async () => { elicited = true; return { action:'accept', content:{} }; }
  });
  t.after(async () => { await client.close(); await server.close(); });

  const result = await client.callTool({
    name:'approval_resolve',
    arguments:{ approval_id:'approval-1234', decision:'reject' }
  });

  assert.equal(result.isError, undefined);
  assert.equal(elicited, false);
  assert.deepEqual(decisions, [{ approvalId:'approval-1234', decision:'reject' }]);
});

test('独立员工 MCP 作用域只展示和创建本岗位任务，不能创建多人总任务', async (t) => {
  const created = [];
  const clientApi = {
    capabilities:async () => ({
      employees:[
        { agentId:'intel-researcher', acceptedTaskTypes:['research.intel-report'] },
        { agentId:'xiaod', acceptedTaskTypes:['media.transcribe-and-refine'] }
      ]
    }),
    armyStatus:async () => ({}),
    employeeStatus:async () => ({}),
    listTasks:async (input) => [{ taskId:'research-1234', agentId:input.employee }],
    getTask:async () => ({ taskId:'research-1234', agentId:'intel-researcher' }),
    createTask:async (input) => { created.push(input); return { taskId:'research-created' }; },
    createMission:async () => { throw new Error('不应调用'); },
    controlTask:async () => ({}),
    listApprovals:async () => [],
    resolveApproval:async () => ({})
  };
  const { client, server } = await connect(clientApi, {
    scope:{ agentIds:['intel-researcher'], taskTypes:['research.intel-report'], allowMissions:false }
  });
  t.after(async () => { await client.close(); await server.close(); });

  const capabilities = await client.callTool({ name:'capabilities', arguments:{} });
  assert.deepEqual(capabilities.structuredContent.employees.map((item) => item.agentId), ['intel-researcher']);

  const listed = await client.callTool({ name:'task_list', arguments:{} });
  assert.equal(listed.structuredContent.items[0].agentId, 'intel-researcher');

  const allowed = await client.callTool({
    name:'task_create',
    arguments:{ title:'研究公开资料', task_type:'research.intel-report' }
  });
  assert.equal(allowed.structuredContent.taskId, 'research-created');
  assert.equal(created[0].agentId, 'intel-researcher');

  const wrongTask = await client.callTool({
    name:'task_create',
    arguments:{ title:'整理视频', task_type:'media.transcribe-and-refine', agent_id:'xiaod' }
  });
  assert.equal(wrongTask.isError, true);

  const mission = await client.callTool({
    name:'mission_create',
    arguments:{ title:'多人工作', items:[{ title:'研究', task_type:'research.intel-report', agent_id:'intel-researcher' }] }
  });
  assert.equal(mission.isError, true);
  assert.equal(created.length, 1);
});

test('A君可以查询全员说明书，独立员工只能回答自己的说明书', async (t) => {
  const ajunConnection = await connect({}, {
    scope:{
      agentIds:['ajun'],
      taskTypes:['army.intake'],
      allowedTools:['agent_manual'],
      allowMissions:true,
    },
  });
  t.after(async () => { await ajunConnection.client.close(); await ajunConnection.server.close(); });
  const all = await ajunConnection.client.callTool({ name:'agent_manual', arguments:{ agent:'all' } });
  assert.equal(all.isError, undefined);
  assert.ok(all.structuredContent.count >= 11);
  assert.match(all.content[0].text, /A君·军团总管使用说明书/);
  assert.match(all.content[0].text, /技术专家使用说明书/);
  assert.match(all.content[0].text, /## 输出示例/);
  assert.match(all.content[0].text, /## 成功运行证据/);

  const xiaodConnection = await connect({}, {
    scope:{
      agentIds:['xiaod'],
      taskTypes:['media.transcribe-and-refine'],
      allowedTools:['agent_manual'],
      allowMissions:false,
    },
  });
  t.after(async () => { await xiaodConnection.client.close(); await xiaodConnection.server.close(); });
  const own = await xiaodConnection.client.callTool({ name:'agent_manual', arguments:{} });
  assert.equal(own.structuredContent.manual.agentId, 'xiaod');
  assert.match(own.content[0].text, /音视频/);
  assert.match(own.content[0].text, /尚未补公开截图/);

  const denied = await xiaodConnection.client.callTool({
    name:'agent_manual',
    arguments:{ agent:'架构师' },
  });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /只能回答自己的使用说明书/);

  const deniedAll = await xiaodConnection.client.callTool({
    name:'agent_manual',
    arguments:{ agent:'all' },
  });
  assert.equal(deniedAll.isError, true);
  assert.match(deniedAll.content[0].text, /查询全部或其他岗位请询问 A君/);
});

test('治理员工 MCP 只注册 Manifest 明确允许的工具', async (t) => {
  const clientApi = {
    capabilities:async () => ({ employees:[] }),
    getPaperclipAssignment:async () => ({ assignment:{ issueId:'issue-1234' } })
  };
  const { client, server } = await connect(clientApi, {
    scope:{
      agentIds:['architect'],
      taskTypes:['governance.architecture-review'],
      allowedTools:['capabilities', 'paperclip_assignment_get'],
      allowMissions:false
    }
  });
  t.after(async () => { await client.close(); await server.close(); });

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['capabilities', 'paperclip_assignment_get']);
});

test('岗位只能调用 Manifest 分配的本机 AI 能力且不能自行跨机批准', async (t) => {
  const calls = [];
  const { client, server } = await connect({}, {
    scope:{
      agentIds:['xiaod'],
      taskTypes:['media.transcribe-and-refine'],
      allowedTools:['local_ai_invoke'],
      localAiCapabilities:['audio.transcribe'],
      allowMissions:false,
    },
    localAi:{
      async invoke(input) {
        calls.push(input);
        return { requestId:'local-one', provider:'local-whisper', result:{ text:'ok' } };
      },
    },
  });
  t.after(async () => { await client.close(); await server.close(); });

  const allowed = await client.callTool({
    name:'local_ai_invoke',
    arguments:{
      capability:'audio.transcribe',
      input:{ audioPath:'/tmp/current-assignment.wav' },
      options:{ preferredNode:'desktop', allowDesktopFallback:true },
    },
  });
  assert.equal(allowed.structuredContent.provider, 'local-whisper');
  assert.equal(calls[0].approved, false);
  assert.equal(calls[0].options.preferredNode, 'mac');
  assert.equal('allowDesktopFallback' in calls[0].options, false);

  const denied = await client.callTool({
    name:'local_ai_invoke',
    arguments:{ capability:'image.generate', input:{ prompt:'not allowed' } },
  });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /没有本机 AI 能力/);
});

test('Paperclip heartbeat 只暴露当前岗位的受控执行与指派工具', { concurrency:false }, async () => {
  const keys = [
    'AGENT_ARMY_ALLOWED_MCP_TOOLS',
    'PAPERCLIP_TASK_ID',
    'PAPERCLIP_RUN_ID',
    'PAPERCLIP_AGENT_ID'
  ];
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.AGENT_ARMY_ALLOWED_MCP_TOOLS = 'capabilities,task_list,task_create,agent_manual,paperclip_assignment_get,agent_proposal_create_execute,operations_health_execute,employee_assignment_execute,paperclip_assignment_complete';
    process.env.PAPERCLIP_TASK_ID = 'b3357f8c-1d3a-4a80-8bac-2eb44468e320';
    process.env.PAPERCLIP_RUN_ID = '4f968d26-9bd9-4e86-b4fd-8ef68ae82ea2';
    process.env.PAPERCLIP_AGENT_ID = '5afa80b6-dbc6-491d-9019-a234850b235b';
    assert.deepEqual(
      scopeFromEnvironment().allowedTools,
      ['agent_manual', 'paperclip_assignment_get', 'agent_proposal_create_execute', 'operations_health_execute', 'employee_assignment_execute', 'paperclip_assignment_complete']
    );
  } finally {
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
});

test('Paperclip heartbeat 工具白名单缺失或过滤后为空时 fail-closed', { concurrency:false }, async (t) => {
  const keys = [
    'AGENT_ARMY_ALLOWED_MCP_TOOLS',
    'PAPERCLIP_TASK_ID',
    'PAPERCLIP_RUN_ID',
    'PAPERCLIP_AGENT_ID'
  ];
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.PAPERCLIP_TASK_ID = 'b3357f8c-1d3a-4a80-8bac-2eb44468e320';
    process.env.PAPERCLIP_RUN_ID = '4f968d26-9bd9-4e86-b4fd-8ef68ae82ea2';
    process.env.PAPERCLIP_AGENT_ID = '5afa80b6-dbc6-491d-9019-a234850b235b';
    for (const configured of [undefined, 'task_create,approval_resolve']) {
      await t.test(configured === undefined ? '缺失' : '全被过滤', () => {
        if (configured === undefined) delete process.env.AGENT_ARMY_ALLOWED_MCP_TOOLS;
        else process.env.AGENT_ARMY_ALLOWED_MCP_TOOLS = configured;
        assert.throws(
          () => scopeFromEnvironment(),
          /没有有效工具白名单，拒绝启动/,
        );
      });
    }
  } finally {
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
});

test('四岗受控执行工具从 heartbeat 环境取身份且不接收任意参数', { concurrency:false }, async (t) => {
  const keys = [
    'AGENT_ARMY_AGENT_ID',
    'PAPERCLIP_TASK_ID',
    'PAPERCLIP_RUN_ID',
    'PAPERCLIP_AGENT_ID'
  ];
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const calls = [];
  try {
    process.env.AGENT_ARMY_AGENT_ID = 'intel-researcher';
    process.env.PAPERCLIP_TASK_ID = 'b3357f8c-1d3a-4a80-8bac-2eb44468e320';
    process.env.PAPERCLIP_RUN_ID = '4f968d26-9bd9-4e86-b4fd-8ef68ae82ea2';
    process.env.PAPERCLIP_AGENT_ID = '5afa80b6-dbc6-491d-9019-a234850b235b';
    const { client, server } = await connect({
      executeEmployeeAssignment:async (input) => {
        calls.push(input);
        return { result:{ status:'succeeded', recommendedCompletionStatus:'succeeded' } };
      }
    }, {
      scope:{
        agentIds:['intel-researcher'],
        taskTypes:['content.campaign-research'],
        allowedTools:['employee_assignment_execute'],
        allowMissions:false
      }
    });
    t.after(async () => { await client.close(); await server.close(); });
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name), ['employee_assignment_execute']);
    const result = await client.callTool({ name:'employee_assignment_execute', arguments:{} });
    assert.equal(result.structuredContent.result.recommendedCompletionStatus, 'succeeded');
    assert.deepEqual(calls, [{
      issueId:'b3357f8c-1d3a-4a80-8bac-2eb44468e320',
      runId:'4f968d26-9bd9-4e86-b4fd-8ef68ae82ea2',
      paperclipAgentId:'5afa80b6-dbc6-491d-9019-a234850b235b',
      agentArmyId:'intel-researcher'
    }]);
  } finally {
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
});

test('创建官通过受控 MCP 写入结构化岗位草案，不获得终端或微信数据库权限', { concurrency:false }, async (t) => {
  const keys = [
    'AGENT_ARMY_AGENT_ID',
    'PAPERCLIP_TASK_ID',
    'PAPERCLIP_RUN_ID',
    'PAPERCLIP_AGENT_ID'
  ];
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const calls = [];
  try {
    process.env.AGENT_ARMY_AGENT_ID = 'creator';
    process.env.PAPERCLIP_TASK_ID = 'b3357f8c-1d3a-4a80-8bac-2eb44468e320';
    process.env.PAPERCLIP_RUN_ID = '4f968d26-9bd9-4e86-b4fd-8ef68ae82ea2';
    process.env.PAPERCLIP_AGENT_ID = '5afa80b6-dbc6-491d-9019-a234850b235b';
    const { client, server } = await connect({
      executeAgentProposal:async (input) => {
        calls.push(input);
        return { result:{ status:'succeeded', proposal:{ proposalId:'proposal-wechat' } } };
      }
    }, {
      scope:{
        agentIds:['creator'],
        taskTypes:['governance.agent-proposal'],
        allowedTools:['agent_proposal_create_execute'],
        allowMissions:false
      }
    });
    t.after(async () => { await client.close(); await server.close(); });

    const result = await client.callTool({
      name:'agent_proposal_create_execute',
      arguments:{
        requested_outcome:'按批准范围获取本机微信聊天',
        candidate_name:'微信聊天取件员',
        agent_id:'wechat-chat-reader',
        department:'信息服务部',
        responsibilities:['按批准范围导出聊天'],
        non_responsibilities:['不读取密钥或整库'],
        accepted_task_types:['wechat.chat.export'],
        desired_skills:['yichen-wechat-local-vault'],
        requested_capabilities:['wechat.local-vault.chat.read'],
        acceptance_title:'使用脱敏夹具验证单会话导出'
      }
    });

    assert.equal(result.structuredContent.result.proposal.proposalId, 'proposal-wechat');
    assert.equal(calls[0].agentArmyId, 'creator');
    assert.deepEqual(calls[0].requestedCapabilities, ['wechat.local-vault.chat.read']);
  } finally {
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
});

async function connect(clientApi, { elicitationHandler = async () => ({ action:'decline' }), scope, localAi } = {}) {
  const server = createAgentArmyMcpServer({ client:clientApi, ...(scope ? { scope } : {}), ...(localAi ? { localAi } : {}) });
  const client = new Client(
    { name:'agent-army-test', version:'1.0.0' },
    { capabilities:{ elicitation:{ form:{} } } }
  );
  client.setRequestHandler(ElicitRequestSchema, elicitationHandler);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

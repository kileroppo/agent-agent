import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createAgentArmyMcpServer, scopeFromEnvironment } from '../src/agent-army-mcp-server.js';

test('Agent Army MCP exposes factual read and controlled action tools', async (t) => {
  const calls = [];
  const clientApi = {
    capabilities:async () => ({ employees:[{ agentId:'xiaod', acceptedTaskTypes:['media.transcribe-and-refine'] }] }),
    armyStatus:async () => ({ taskFocus:{ inProgress:0 } }),
    employeeStatus:async (employee) => ({ agentId:employee }),
    listTasks:async (input) => [{ taskId:'task-1234', ...input }],
    getTask:async (taskId) => ({ taskId }),
    createTask:async (input) => { calls.push(['create', input]); return { taskId:'task-created' }; },
    createMission:async (input) => { calls.push(['mission', input]); return { mission:{ taskId:'mission-created' }, children:[] }; },
    controlTask:async (taskId, action) => ({ task:{ taskId }, action }),
    listApprovals:async () => [],
    resolveApproval:async () => { throw new Error('not expected'); }
  };
  const { client, server } = await connect(clientApi);
  t.after(async () => { await client.close(); await server.close(); });

  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    ['approval_list', 'approval_resolve', 'capabilities', 'content_performance_review_execute', 'employee_status', 'mission_create', 'paperclip_assignment_complete', 'paperclip_assignment_get', 'platform_content_draft_execute', 'status', 'task_control', 'task_create', 'task_get', 'task_list', 'technical_repair_execute', 'video_content_analyze_execute', 'video_script_package_execute']
  );

  const capabilities = await client.callTool({ name:'capabilities', arguments:{} });
  assert.equal(capabilities.structuredContent.employees[0].agentId, 'xiaod');

  const created = await client.callTool({
    name:'task_create',
    arguments:{ title:'整理公开视频', task_type:'media.transcribe-and-refine', agent_id:'xiaod' }
  });
  assert.equal(created.structuredContent.taskId, 'task-created');
  assert.equal(calls[0][1].taskType, 'media.transcribe-and-refine');

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
  assert.equal(calls[1][1].items[2].agentId, 'office-assistant');
  assert.equal(calls[1][1].items[2].dependsOnPrevious, true);
  assert.equal(calls[1][1].items[0].reviewPolicy, 'required');
  assert.equal(calls[1][1].items[2].evidenceMode, 'formal');
  assert.equal(calls[1][1].items[2].depth, 'full');
  assert.equal(calls[1][1].items[2].focus, '结论');
  assert.deepEqual(calls[1][1].items[2].platforms, ['douyin']);
  assert.equal(calls[1][1].items[2].contentGoal, '形成老板汇报');
  assert.equal(calls[1][1].waitForTerminal, true);
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

test('Paperclip heartbeat 只暴露当前指派读取与完成工具', { concurrency:false }, async () => {
  const keys = [
    'AGENT_ARMY_ALLOWED_MCP_TOOLS',
    'PAPERCLIP_TASK_ID',
    'PAPERCLIP_RUN_ID',
    'PAPERCLIP_AGENT_ID'
  ];
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.AGENT_ARMY_ALLOWED_MCP_TOOLS = 'capabilities,task_list,task_create,paperclip_assignment_get,paperclip_assignment_complete';
    process.env.PAPERCLIP_TASK_ID = 'b3357f8c-1d3a-4a80-8bac-2eb44468e320';
    process.env.PAPERCLIP_RUN_ID = '4f968d26-9bd9-4e86-b4fd-8ef68ae82ea2';
    process.env.PAPERCLIP_AGENT_ID = '5afa80b6-dbc6-491d-9019-a234850b235b';
    assert.deepEqual(
      scopeFromEnvironment().allowedTools,
      ['paperclip_assignment_get', 'paperclip_assignment_complete']
    );
  } finally {
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
});

async function connect(clientApi, { elicitationHandler = async () => ({ action:'decline' }), scope } = {}) {
  const server = createAgentArmyMcpServer({ client:clientApi, ...(scope ? { scope } : {}) });
  const client = new Client(
    { name:'agent-army-test', version:'1.0.0' },
    { capabilities:{ elicitation:{ form:{} } } }
  );
  client.setRequestHandler(ElicitRequestSchema, elicitationHandler);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

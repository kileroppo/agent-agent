import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentArmyClient, AgentArmyClientError } from '../src/agent-army-client.js';

const overview = {
  capabilities:[{ id:'task-coordination', name:'统一任务协调', status:'ready', detail:'已就绪' }],
  agents:[{
    agentId:'xiaod', name:'小D', status:'active', role:'整理音视频',
    responsibilities:['转录'], acceptedTaskTypes:['media.transcribe-and-refine']
  }],
  tasks:[{
    taskId:'11111111-1111-1111-1111-111111111111',
    taskType:'media.transcribe-and-refine',
    assigneeAgentId:'xiaod',
    status:'running',
    currentStage:'transcribing',
    updatedAt:'2026-07-26T01:00:00.000Z',
    input:{ title:'整理公开视频' },
    approvalRefs:[],
    artifactRefs:[]
  }],
  approvals:[],
  taskFocus:{ inProgress:1 },
  usage:{ taskCount:1 }
};

test('AgentArmyClient exposes factual capability and employee views', async () => {
  const client = new AgentArmyClient({ fetchImpl:fakeFetch({ 'GET /api/overview':overview }) });
  const capabilities = await client.capabilities();
  const employee = await client.employeeStatus('小D');

  assert.equal(capabilities.employees[0].agentId, 'xiaod');
  assert.deepEqual(capabilities.employees[0].acceptedTaskTypes, ['media.transcribe-and-refine']);
  assert.equal(employee.recentTasks[0].status, 'running');
});

test('AgentArmyClient creates an idempotent Hermes task and returns its read model', async () => {
  const requests = [];
  const client = new AgentArmyClient({
    now:() => 60_000,
    fetchImpl:async (url, options = {}) => {
      const key = `${options.method || 'GET'} ${new URL(url).pathname}`;
      requests.push({ key, body:options.body ? JSON.parse(options.body) : null });
      if (key === 'POST /api/tasks') return response(201, { task:{ taskId:'22222222-2222-2222-2222-222222222222' } });
      if (key === 'GET /api/overview') return response(200, {
        ...overview,
        tasks:[{ ...overview.tasks[0], taskId:'22222222-2222-2222-2222-222222222222', source:{ channel:'feishu', chatRef:'oc_test' } }]
      });
      if (key === 'POST /api/feishu/task-status') return response(200, { terminal:false, status:'running', message:'正在处理。' });
      return response(404, { error:'missing' });
    }
  });

  const task = await client.createTask({
    title:'整理公开视频',
    taskType:'media.transcribe-and-refine',
    agentId:'xiaod',
    chatRef:'oc_test',
    sourceTaskIds:['source-task-1234']
  });

  assert.equal(task.taskId, '22222222-2222-2222-2222-222222222222');
  const create = requests.find((item) => item.key === 'POST /api/tasks');
  assert.equal(create.body.source.channel, 'feishu');
  assert.equal(create.body.source.chatRef, 'oc_test');
  assert.deepEqual(create.body.context.sourceTaskIds, ['source-task-1234']);
  assert.equal(create.body.context.dependsOnPrevious, true);
  assert.match(create.body.idempotencyKey, /^hermes:oc_test:/);
});

test('AgentArmyClient rejects non-loopback base URLs', () => {
  assert.throws(
    () => new AgentArmyClient({ baseUrl:'https://example.com' }),
    (error) => error instanceof AgentArmyClientError && /loopback/.test(error.message)
  );
});

test('AgentArmyClient creates one idempotent mission for up to three employee assignments', async () => {
  const requests = [];
  const missionId = '33333333-3333-3333-3333-333333333333';
  const childId = '44444444-4444-4444-4444-444444444444';
  const client = new AgentArmyClient({
    now:() => 90_000,
    fetchImpl:async (url, options = {}) => {
      const key = `${options.method || 'GET'} ${new URL(url).pathname}`;
      requests.push({ key, body:options.body ? JSON.parse(options.body) : null });
      if (key === 'POST /api/mcp/missions') return response(201, {
        mission:{ taskId:missionId },
        children:[{ taskId:childId }],
        reply:'总任务已建立。'
      });
      if (key === 'GET /api/overview') return response(200, {
        ...overview,
        tasks:[
          {
            taskId:missionId, taskType:'army.cross-agent-mission', assigneeAgentId:'task-coordinator',
            status:'running', currentStage:'mission_in_progress', input:{ title:'完成本周任务' }, artifactRefs:[], approvalRefs:[]
          },
          {
            taskId:childId, taskType:'research.intel-report', assigneeAgentId:'intel-researcher',
            status:'succeeded', currentStage:'intel_research_ready', input:{ title:'研究公开资料' }, artifactRefs:[], approvalRefs:[]
          }
        ]
      });
      return response(404, { error:'missing' });
    }
  });

  const result = await client.createMission({
    title:'完成本周任务',
    chatRef:'oc_boss',
    items:[{ title:'研究公开资料', taskType:'research.intel-report', agentId:'intel-researcher', dependsOnPrevious:true }]
  });

  assert.equal(result.mission.taskId, missionId);
  assert.equal(result.children[0].agentId, 'intel-researcher');
  assert.equal(result.userMessage, '总任务已建立。');
  const create = requests.find((item) => item.key === 'POST /api/mcp/missions');
  assert.match(create.body.idempotencyKey, /^hermes-mission:oc_boss:/);
  assert.equal(create.body.items[0].taskType, 'research.intel-report');
  assert.equal(create.body.items[0].dependsOnPrevious, true);
});

test('AgentArmyClient waits for a short mission and returns the delayed office child with final guidance', async () => {
  const missionId = '55555555-5555-5555-5555-555555555555';
  let overviewCalls = 0;
  let sleeps = 0;
  const client = new AgentArmyClient({
    missionWaitMs:1_000,
    missionPollMs:50,
    sleepImpl:async () => { sleeps += 1; },
    fetchImpl:async (url, options = {}) => {
      const key = `${options.method || 'GET'} ${new URL(url).pathname}`;
      if (key === 'POST /api/mcp/missions') return response(201, {
        mission:{ taskId:missionId },
        children:[{ taskId:'media-child' }],
        reply:'总任务已建立。'
      });
      if (key === 'GET /api/overview') {
        overviewCalls += 1;
        const finished = overviewCalls >= 2;
        return response(200, {
          ...overview,
          tasks:[
            {
              taskId:missionId,
              taskType:'army.cross-agent-mission',
              assigneeAgentId:'task-coordinator',
              status:finished ? 'succeeded' : 'running',
              currentStage:finished ? 'mission_delivered' : 'mission_in_progress',
              input:{ title:'三员工总任务' },
              approvalRefs:[],
              artifactRefs:finished ? [{
                type:'cross_agent_mission_summary',
                validation:{ exists:true, readable:true, nonEmpty:true },
                data:{
                  completed:true,
                  terminal:true,
                  statuses:[
                    { title:'整理视频', employeeId:'xiaod', taskId:'media-child', status:'succeeded', artifactTypes:['xiaod_media_delivery'] },
                    { title:'统一汇报', employeeId:'office-assistant', taskId:'office-child', status:'succeeded', artifactTypes:['office_briefing_package'] }
                  ]
                }
              }] : []
            },
            {
              taskId:'media-child',
              parentTaskId:missionId,
              taskType:'media.transcribe-and-refine',
              assigneeAgentId:'xiaod',
              status:'succeeded',
              input:{ title:'整理视频' },
              approvalRefs:[],
              artifactRefs:[]
            },
            ...(finished ? [{
              taskId:'office-child',
              parentTaskId:missionId,
              taskType:'office.briefing-package',
              assigneeAgentId:'office-assistant',
              status:'succeeded',
              input:{ title:'统一汇报' },
              approvalRefs:[],
              artifactRefs:[]
            }] : [])
          ]
        });
      }
      return response(404, { error:'missing' });
    }
  });

  const result = await client.createMission({
    title:'三员工总任务',
    waitForTerminal:true,
    items:[
      { title:'整理视频', taskType:'media.transcribe-and-refine', agentId:'xiaod' },
      { title:'统一汇报', taskType:'office.briefing-package', agentId:'office-assistant', dependsOnPrevious:true }
    ]
  });

  assert.equal(sleeps, 1);
  assert.equal(result.mission.status, 'succeeded');
  assert.deepEqual(result.children.map((task) => task.agentId).sort(), ['office-assistant', 'xiaod']);
  assert.match(result.userMessage, /直接向负责人做最终汇报/);
});

test('AgentArmyClient keeps task artifacts and errors sanitized', async () => {
  const client = new AgentArmyClient({ fetchImpl:fakeFetch({
    'GET /api/overview':{
      ...overview,
      tasks:[{
        ...overview.tasks[0],
        error:{ code:'failed', category:'manual', userMessage:'需要处理\n但不返回原始日志' },
        artifactRefs:[{ type:'xiaod_media_delivery', data:{ larkUrl:'https://example.test/doc', larkPermissionGranted:true, raw:'secret' } }]
      }]
    },
    'POST /api/feishu/task-status':{ terminal:true, message:'已完成。' }
  }) });

  const task = await client.getTask('11111111-1111-1111-1111-111111111111');
  assert.deepEqual(task.artifacts, [{ type:'xiaod_media_delivery', ref:'https://example.test/doc', verified:true }]);
  assert.equal(task.error.userMessage, '需要处理 但不返回原始日志');
  assert.equal(JSON.stringify(task).includes('raw'), false);
});

test('AgentArmyClient returns a compact Paperclip assignment without the full task envelope', async () => {
  const client = new AgentArmyClient({ fetchImpl:fakeFetch({
    'POST /api/mcp/paperclip-assignment':{
      assignment:{
        issueId:'issue-1234',
        identifier:'AGE-123',
        title:'形成岗位草案',
        description:'完成当前指派。',
        agentId:'creator',
        runId:'run-1234',
        secret:'must-not-leak'
      },
      task:{
        taskId:'task-1234',
        taskType:'governance.agent-proposal',
        status:'running',
        currentStage:'paperclip_hermes_running',
        input:{ description:'large internal task envelope' },
        governance:{ paperclipApiKey:'must-not-leak' }
      }
    }
  }) });

  const assignment = await client.getPaperclipAssignment({});
  assert.deepEqual(assignment, {
    assignment:{
      issueId:'issue-1234',
      identifier:'AGE-123',
      title:'形成岗位草案',
      description:'完成当前指派。',
      agentId:'creator',
      runId:'run-1234'
    },
    task:{
      taskId:'task-1234',
      taskType:'governance.agent-proposal',
      status:'running',
      currentStage:'paperclip_hermes_running'
    }
  });
  assert.equal(JSON.stringify(assignment).includes('must-not-leak'), false);
  assert.equal(JSON.stringify(assignment).includes('large internal task envelope'), false);
});

test('AgentArmyClient exposes only the approved repair scope to the technical expert', async () => {
  const client = new AgentArmyClient({ fetchImpl:fakeFetch({
    'POST /api/mcp/paperclip-assignment':{
      assignment:{
        issueId:'issue-tech',
        identifier:'AGE-TECH',
        title:'修复隔离样例',
        description:'修复已知错误。',
        agentId:'technical-expert',
        runId:'run-tech'
      },
      task:{
        taskId:'task-tech',
        taskType:'operations.technical-repair',
        status:'running',
        currentStage:'paperclip_hermes_running',
        input:{ context:{
          repairScope:{
            files:['docs/fixture/calculator.mjs'],
            testCommand:'node --test docs/fixture/calculator.test.mjs',
            recoveryCheck:'确认返回正确结果。'
          },
          failure:{ rawLog:'must-not-leak' }
        } }
      }
    }
  }) });

  const assignment = await client.getPaperclipAssignment({});
  assert.deepEqual(assignment.task.repairScope, {
    files:['docs/fixture/calculator.mjs'],
    testCommand:'node --test docs/fixture/calculator.test.mjs',
    recoveryCheck:'确认返回正确结果。'
  });
  assert.equal(JSON.stringify(assignment).includes('must-not-leak'), false);
});

test('AgentArmyClient exposes sanitized business mission, research and office reports', async () => {
  const client = new AgentArmyClient({ fetchImpl:fakeFetch({
    'GET /api/overview':{
      ...overview,
      tasks:[{
        ...overview.tasks[0],
        taskType:'army.cross-agent-mission',
        artifactRefs:[
          {
            type:'cross_agent_mission_summary',
            location:'runtime://mission/summary',
            validation:{ exists:true, readable:true, nonEmpty:true },
            data:{
              kind:'business',
              summary:'完成本周任务',
              completed:true,
              terminal:true,
              statuses:[{ title:'研究', employeeId:'intel-researcher', taskId:'child-12345678', status:'succeeded', artifactTypes:['intel_research_report'], raw:'secret' }],
              decision:{ outcome:'completed', briefing:{ title:'汇报包', summary:'都完成了', openItems:[], nextAction:'请审阅', raw:'secret' } },
              raw:'secret'
            }
          },
          {
            type:'intel_research_report',
            validation:{ exists:true, readable:true, nonEmpty:true },
            data:{ topic:'主题', findings:['发现'], conclusion:'结论', recommendations:['建议'], openQuestions:[], sources:[{ title:'来源', source:'https://example.com', summary:'公开摘要', raw:'secret' }], raw:'secret' }
          },
          {
            type:'office_briefing_package',
            validation:{ exists:true, readable:true, nonEmpty:true },
            data:{ title:'汇报包', summary:'摘要', sourceTasks:[{ taskId:'child-12345678', title:'研究', employeeId:'intel-researcher', status:'succeeded', raw:'secret' }], openItems:[], nextAction:'审阅', markdown:'secret markdown' }
          }
        ]
      }]
    },
    'POST /api/feishu/task-status':{ terminal:true, message:'已完成。' }
  }) });

  const task = await client.getTask('11111111-1111-1111-1111-111111111111');
  assert.equal(task.artifacts[0].report.outcome, 'completed');
  assert.equal(task.artifacts[1].report.conclusion, '结论');
  assert.equal(task.artifacts[2].report.nextAction, '审阅');
  assert.equal(JSON.stringify(task).includes('secret'), false);
});

test('AgentArmyClient exposes a verified sanitized health report', async () => {
  const client = new AgentArmyClient({ fetchImpl:fakeFetch({
    'GET /api/overview':{
      ...overview,
      tasks:[{
        ...overview.tasks[0],
        taskType:'operations.health-review',
        artifactRefs:[{
          type:'health_report',
          location:'runtime://task/health-report',
          validation:{ exists:true, readable:true, nonEmpty:true },
          data:{
            checkedAt:'2026-07-26T02:29:51.675Z',
            overall:'healthy',
            components:[{ id:'ajun-runtime', name:'A君运行台', status:'healthy', detail:'运行正常。', raw:'secret' }],
            recommendedAction:'无需恢复动作。',
            raw:'secret'
          }
        }]
      }]
    },
    'POST /api/feishu/task-status':{ terminal:true, message:'【运维官健康检查】整体：正常' }
  }) });

  const task = await client.getTask('11111111-1111-1111-1111-111111111111');
  assert.equal(task.artifacts[0].verified, true);
  assert.equal(task.artifacts[0].report.overall, 'healthy');
  assert.equal(task.artifacts[0].report.components[0].name, 'A君运行台');
  assert.equal(JSON.stringify(task).includes('secret'), false);
});

function fakeFetch(routes) {
  return async (url, options = {}) => {
    const key = `${options.method || 'GET'} ${new URL(url).pathname}`;
    return key in routes ? response(200, routes[key]) : response(404, { error:`missing ${key}` });
  };
}

function response(status, body) {
  return { ok:status >= 200 && status < 300, status, async json() { return body; } };
}

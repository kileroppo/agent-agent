import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentArmyClient, AgentArmyClientError } from '../src/agent-army-client.ts';

const overview = {
  capabilities:[{ id:'task-coordination', name:'统一任务协调', status:'ready', detail:'已就绪', truth:{ declared:true, configured:true, live:true, verified:true, humanAccepted:false, overall:'verified', verifiedAt:'2026-08-10T01:00:00.000Z', evidenceTaskId:'task-evidence', evidenceRef:'task:task-evidence', freshness:'later_than_latest_failure', latestFailureAt:'2026-08-09T01:00:00.000Z', latestFailureTaskId:'task-failure' } }],
  agents:[{
    agentId:'xiaod', name:'小D', status:'active', role:'整理音视频',
    responsibilities:['转录'], acceptedTaskTypes:['media.transcribe-and-refine'],
    capabilityTruth:{ declared:true, configured:true, live:true, verified:false, humanAccepted:false, overall:'live' },
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
  validationCampaign:{ taskCount:2, groupCount:1 },
  usage:{ taskCount:1 }
};

test('AgentArmyClient exposes factual capability and employee views', async () => {
  const client = new AgentArmyClient({ fetchImpl:fakeFetch({ 'GET /api/overview':overview }) });
  const capabilities = await client.capabilities();
  const employee = await client.employeeStatus('小D');

  assert.equal(capabilities.employees[0].agentId, 'xiaod');
  assert.deepEqual(capabilities.employees[0].acceptedTaskTypes, ['media.transcribe-and-refine']);
  assert.equal(capabilities.employees[0].capabilityTruth.overall, 'live');
  assert.equal(capabilities.capabilities[0].truth.overall, 'verified');
  assert.equal(capabilities.capabilities[0].truth.evidenceTaskId, 'task-evidence');
  assert.equal(capabilities.capabilities[0].truth.freshness, 'later_than_latest_failure');
  assert.equal(employee.recentTasks[0].status, 'running');
  const status = await client.armyStatus();
  assert.deepEqual(status.validationCampaign, { taskCount:2, groupCount:1 });
  assert.equal(status.viewKind, 'army_status');
  assert.equal(status.presentation.userActionRequired, false);
  assert.match(status.presentation.summary, /军团正常，正在处理 1 项工作/);
});

test('AgentArmyClient turns an active recovery into a contextual closed-loop status', async () => {
  const client = new AgentArmyClient({
    fetchImpl:fakeFetch({
      'GET /api/overview':{
        ...overview,
        taskFocus:{ inProgress:0, waitingApproval:0 },
        tasks:[
          {
            ...overview.tasks[0],
            status:'failed',
            input:{ title:'研究竞品资料' },
            assigneeAgentId:'xiaod',
            recovery:{ coordination:{ status:'escalated', technicalTaskId:'repair-active' } },
          },
          {
            taskId:'repair-active',
            taskType:'operations.technical-repair',
            status:'running',
            input:{ title:'诊断研究任务故障' },
            updatedAt:'2026-07-26T02:00:00.000Z',
          },
        ],
      },
    }),
  });

  const status = await client.armyStatus();
  assert.equal(status.presentation.status, 'recovering');
  assert.equal(status.presentation.userActionRequired, false);
  assert.match(status.presentation.summary, /小D处理“研究竞品资料”时出现异常/);
  assert.match(status.presentation.summary, /技术专家正在诊断修复/);
  assert.match(status.presentation.summary, /暂时不用你处理/);
});

test('AgentArmyClient does not surface an already completed recovery as a current incident', async () => {
  const root = {
    ...overview.tasks[0],
    status:'failed',
    recovery:{ coordination:{ status:'escalated', technicalTaskId:'repair-1' } },
  };
  const repair = {
    taskId:'repair-1',
    parentTaskId:root.taskId,
    taskType:'operations.technical-repair',
    status:'succeeded',
    input:{ title:'修复任务故障' },
    updatedAt:'2026-07-26T02:00:00.000Z',
  };
  const client = new AgentArmyClient({
    fetchImpl:fakeFetch({
      'GET /api/overview':{
        ...overview,
        taskFocus:{ inProgress:0, waitingApproval:0 },
        tasks:[root, repair],
      },
    }),
  });

  const status = await client.armyStatus();
  assert.equal(status.presentation.status, 'normal');
  assert.doesNotMatch(status.presentation.summary, /异常|技术专家/);
});

test('AgentArmyClient does not claim diagnosis before a real recovery task exists', async () => {
  const client = new AgentArmyClient({
    fetchImpl:fakeFetch({
      'GET /api/overview':{
        ...overview,
        taskFocus:{ inProgress:0, waitingApproval:0 },
        tasks:[{
          ...overview.tasks[0],
          status:'failed',
          recovery:{ coordination:{ status:'pending' } },
        }],
      },
    }),
  });

  const status = await client.armyStatus();
  assert.equal(status.presentation.status, 'normal');
  assert.doesNotMatch(status.presentation.summary, /正在诊断|正在修复|自动重试/);
});

test('AgentArmyClient creates an idempotent Hermes task and returns its read model', async () => {
  const requests = [];
  const client = new AgentArmyClient({
    now:() => 60_000,
    fetchImpl:async (url, options = {}) => {
      const key = `${options.method || 'GET'} ${new URL(url).pathname}`;
      requests.push({ key, body:options.body ? JSON.parse(options.body) : null });
      if (key === 'POST /api/tasks') return response(201, { task:{ taskId:'22222222-2222-2222-2222-222222222222' } });
      if (key === 'POST /api/mcp/completion-watches') return response(200, { registered:true });
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
    connectionId:'123e4567-e89b-42d3-a456-426614174000',
    sourceTaskIds:['source-task-1234']
  });

  assert.equal(task.taskId, '22222222-2222-2222-2222-222222222222');
  const create = requests.find((item) => item.key === 'POST /api/tasks');
  assert.equal(create.body.source.channel, 'feishu');
  assert.equal(create.body.source.chatRef, 'oc_test');
  assert.deepEqual(create.body.context.sourceTaskIds, ['source-task-1234']);
  assert.equal(create.body.connectionId, '123e4567-e89b-42d3-a456-426614174000');
  assert.equal(create.body.context.dependsOnPrevious, true);
  assert.match(create.body.idempotencyKey, /^hermes:oc_test:/);
  const watch = requests.find((item) => item.key === 'POST /api/mcp/completion-watches');
  assert.deepEqual(watch.body, { taskId:'22222222-2222-2222-2222-222222222222', chatRef:'oc_test' });
});

test('AgentArmyClient 保留动态卡契约但在没有锚点回执时继续登记文本回告', async () => {
  const requests = [];
  const taskId = '32323232-3232-4323-8323-323232323232';
  const client = new AgentArmyClient({
    fetchImpl:async (url, options = {}) => {
      const key = `${options.method || 'GET'} ${new URL(url).pathname}`;
      requests.push({ key, body:options.body ? JSON.parse(options.body) : null });
      if (key === 'POST /api/tasks') return response(201, {
        task:{ taskId },
        completionWatch:{
          required:false,
          registered:false,
          delegated:true,
          duplicateWatchSuppressed:true,
          taskId,
          completionDelivery:{ mode:'dynamic_card', owner:'hermes_gateway' },
        },
      });
      if (key === 'GET /api/overview') return response(200, {
        ...overview,
        tasks:[{ ...overview.tasks[0], taskId, source:{ channel:'feishu', chatRef:'oc_card' } }],
      });
      if (key === 'POST /api/mcp/completion-watches') return response(200, {
        required:true, registered:true, taskId,
      });
      if (key === 'POST /api/feishu/task-status') return response(200, {
        terminal:false,
        status:'running',
        message:'正在处理。',
      });
      return response(404, { error:'missing' });
    },
  });

  const result = await client.createTask({
    title:'动态卡任务',
    taskType:'media.transcribe-and-refine',
    agentId:'xiaod',
    chatRef:'oc_card',
    completionDelivery:{ mode:'dynamic_card', owner:'hermes_gateway' },
  });

  const create = requests.find((item) => item.key === 'POST /api/tasks');
  assert.deepEqual(create.body.completionDelivery, { mode:'dynamic_card', owner:'hermes_gateway' });
  assert.equal(requests.some((item) => item.key === 'POST /api/mcp/completion-watches'), true);
  assert.deepEqual(result.completionDelivery, { mode:'dynamic_card', owner:'hermes_gateway' });
  assert.equal(result.completionWatch.registered, true);
});

test('AgentArmyClient 只通过原飞书会话写回受控任务评价', async () => {
  const requests = [];
  const taskId = '11111111-1111-1111-1111-111111111111';
  const client = new AgentArmyClient({
    fetchImpl:async (url, options = {}) => {
      const key = `${options.method || 'GET'} ${new URL(url).pathname}`;
      requests.push({ key, body:options.body ? JSON.parse(options.body) : null });
      if (key === `POST /api/mcp/tasks/${taskId}/feedback`) return response(200, {
        task:{ ...overview.tasks[0], status:'succeeded', feedback:{ sentiment:'useful' } },
      });
      if (key === 'GET /api/overview') return response(200, overview);
      return response(404, { error:'missing' });
    },
  });

  const task = await client.recordTaskFeedback(taskId, {
    sentiment:'useful',
    note:'这次结果有用，验收通过。',
    chatRef:'oc_test',
  });

  assert.equal(task.status, 'succeeded');
  assert.deepEqual(requests[0], {
    key:`POST /api/mcp/tasks/${taskId}/feedback`,
    body:{ sentiment:'useful', note:'这次结果有用，验收通过。', chatRef:'oc_test' },
  });
  await assert.rejects(
    () => client.recordTaskFeedback(taskId, { sentiment:'unknown', chatRef:'oc_test' }),
    /useful 或 needs_improvement/,
  );
});

test('服务端已登记终态回告时客户端不重复登记', async () => {
  const requests = [];
  const missionId = '29292929-2929-2929-2929-292929292929';
  const client = new AgentArmyClient({
    fetchImpl:async (url, options = {}) => {
      const key = `${options.method || 'GET'} ${new URL(url).pathname}`;
      requests.push(key);
      if (key === 'POST /api/mcp/missions') return response(201, {
        mission:{ taskId:missionId }, children:[], reply:'总任务已经登记。',
        completionWatch:{ required:true, registered:true, taskId:missionId },
      });
      if (key === 'GET /api/overview') return response(200, {
        ...overview,
        tasks:[{
          taskId:missionId, taskType:'army.cross-agent-mission', assigneeAgentId:'ajun',
          status:'running', currentStage:'paperclip_hermes_running', input:{ title:'视频分析' },
          approvalRefs:[], artifactRefs:[],
        }],
      });
      return response(404, { error:'missing' });
    },
  });

  const result = await client.createMission({
    title:'视频分析', chatRef:'oc_owner',
    items:[{ key:'media', title:'获取视频', taskType:'media.transcribe-and-refine', agentId:'xiaod' }],
  });

  assert.equal(result.completionWatch.registered, true);
  assert.equal(requests.includes('POST /api/mcp/completion-watches'), false);
});

test('终态回告两次登记均失败时明确告知不能承诺自动通知', async () => {
  const missionId = '30303030-3030-3030-3030-303030303030';
  const client = new AgentArmyClient({
    fetchImpl:async (url, options = {}) => {
      const key = `${options.method || 'GET'} ${new URL(url).pathname}`;
      if (key === 'POST /api/mcp/missions') return response(201, {
        mission:{ taskId:missionId }, children:[], reply:'总任务已经登记。',
        completionWatch:{ required:true, registered:false, errorCode:'completion_watch_registration_failed' },
      });
      if (key === 'POST /api/mcp/completion-watches') return response(500, { error:'watch unavailable' });
      if (key === 'GET /api/overview') return response(200, {
        ...overview,
        tasks:[{
          taskId:missionId, taskType:'army.cross-agent-mission', assigneeAgentId:'ajun',
          status:'running', currentStage:'paperclip_hermes_running', input:{ title:'视频分析' },
          approvalRefs:[], artifactRefs:[],
        }],
      });
      return response(404, { error:'missing' });
    },
  });

  const result = await client.createMission({
    title:'视频分析', chatRef:'oc_owner',
    items:[{ key:'media', title:'获取视频', taskType:'media.transcribe-and-refine', agentId:'xiaod' }],
  });

  assert.equal(result.completionWatch.registered, false);
  assert.match(result.userMessage, /自动回告暂未登记成功/);
});

test('AgentArmyClient 拒绝非法账号连接标识', async () => {
  const client = new AgentArmyClient({ fetchImpl:async () => { throw new Error('不应请求'); } });
  await assert.rejects(() => client.createTask({
    title:'整理素材',
    taskType:'media.transcribe-and-refine',
    connectionId:'not-a-uuid'
  }), AgentArmyClientError);
});

test('只有视频 URL 的正式拆解默认自动质量确认并继续小拆分析', async () => {
  const requests = [];
  const missionId = '23232323-2323-2323-2323-232323232323';
  const mediaId = '24242424-2424-2424-2424-242424242424';
  const client = new AgentArmyClient({
    fetchImpl:async (url, options = {}) => {
      const key = `${options.method || 'GET'} ${new URL(url).pathname}`;
      requests.push({ key, body:options.body ? JSON.parse(options.body) : null });
      if (key === 'POST /api/mcp/missions') return response(201, {
        mission:{ taskId:missionId },
        children:[{ taskId:mediaId }],
        reply:'总任务已建立，等待完整听审。'
      });
      if (key === 'POST /api/mcp/completion-watches') return response(200, { registered:true });
      if (key === 'GET /api/overview') return response(200, {
        ...overview,
        tasks:[
          {
            taskId:missionId, taskType:'army.cross-agent-mission', assigneeAgentId:'ajun',
            status:'running', currentStage:'mission_in_progress', input:{ title:'拆解公开视频｜受控获取与拆解' },
            approvalRefs:[], artifactRefs:[]
          },
          {
            taskId:mediaId, parentTaskId:missionId, taskType:'media.transcribe-and-refine', assigneeAgentId:'xiaod',
            status:'running', currentStage:'xiaod_processing', input:{ title:'获取并整理：拆解公开视频' },
            approvalRefs:[], artifactRefs:[]
          }
        ]
      });
      return response(404, { error:'missing' });
    }
  });

  const result = await client.createTask({
    title:'拆解公开视频',
    taskType:'content.video-benchmark-analysis',
    agentId:'video-content-analyst',
    sourceUrls:['https://example.com/video'],
    evidenceMode:'formal',
    depth:'full',
    focus:'开场钩子',
    chatRef:'oc_content',
    requestRef:'message-content-1'
  });

  assert.equal(result.mission.taskId, missionId);
  assert.equal(requests.some((item) => item.key === 'POST /api/tasks'), false);
  const create = requests.find((item) => item.key === 'POST /api/mcp/missions');
  assert.equal(create.body.items.length, 2);
  assert.equal(create.body.items[0].agentId, 'xiaod');
  assert.equal(create.body.items[0].reviewPolicy, 'optional');
  assert.deepEqual(create.body.items[0].sourceUrls, ['https://example.com/video']);
  assert.equal(create.body.items[1].agentId, 'video-content-analyst');
  assert.equal(create.body.items[1].dependsOnPrevious, true);
  assert.equal(create.body.items[1].evidenceMode, 'formal');
  assert.equal(create.body.items[1].depth, 'full');
  assert.equal(create.body.items[1].focus, '开场钩子');
  const watch = requests.find((item) => item.key === 'POST /api/mcp/completion-watches');
  assert.deepEqual(watch.body, { taskId:missionId, chatRef:'oc_content' });
});

test('用户明确要求正式完整拆解时覆盖模型误传的 fast，但默认仍走自动质量确认', async () => {
  const requests = [];
  const missionId = '25252525-2525-2525-2525-252525252525';
  const client = new AgentArmyClient({
    fetchImpl:async (url, options = {}) => {
      const key = `${options.method || 'GET'} ${new URL(url).pathname}`;
      requests.push({ key, body:options.body ? JSON.parse(options.body) : null });
      if (key === 'POST /api/mcp/missions') return response(201, {
        mission:{ taskId:missionId },
        children:[],
        reply:'总任务已建立，等待完整听审。'
      });
      if (key === 'POST /api/mcp/completion-watches') return response(200, { registered:true });
      if (key === 'GET /api/overview') return response(200, {
        ...overview,
        tasks:[{
          taskId:missionId,
          taskType:'army.cross-agent-mission',
          assigneeAgentId:'ajun',
          status:'running',
          currentStage:'mission_in_progress',
          input:{ title:'正式完整拆解 B站视频｜受控获取与拆解' },
          approvalRefs:[],
          artifactRefs:[]
        }]
      });
      return response(404, { error:'missing' });
    }
  });

  await client.createTask({
    title:'正式完整拆解 B站视频',
    description:'对公开视频进行正式完整拆解。',
    taskType:'content.video-benchmark-analysis',
    agentId:'video-content-analyst',
    sourceUrls:['https://example.com/video'],
    evidenceMode:'formal',
    depth:'fast',
    reviewPolicy:'optional',
    chatRef:'oc_content',
    requestRef:'message-content-2'
  });

  const create = requests.find((item) => item.key === 'POST /api/mcp/missions');
  assert.equal(create.body.items[0].reviewPolicy, 'optional');
  assert.equal(create.body.items[1].depth, 'full');
});

test('结构化分析模式优先于自然语言并贯穿视频获取任务与小拆任务', async () => {
  const requests = [];
  const client = new AgentArmyClient({
    fetchImpl:async (url, options = {}) => {
      const key = `${options.method || 'GET'} ${new URL(url).pathname}`;
      requests.push({ key, body:options.body ? JSON.parse(options.body) : null });
      if (key === 'POST /api/mcp/missions') return response(201, {
        mission:{ taskId:'27272727-2727-2727-2727-272727272727' },
        children:[],
        reply:'总任务已建立。'
      });
      if (key === 'POST /api/mcp/completion-watches') return response(200, { registered:true });
      if (key === 'GET /api/overview') return response(200, { ...overview, tasks:[] });
      return response(404, { error:'missing' });
    }
  });

  await client.createTask({
    title:'总结这个视频',
    taskType:'content.video-benchmark-analysis',
    sourceUrls:['https://example.com/video'],
    analysisIntent:'style',
    depth:'fast',
    chatRef:'oc_content',
    requestRef:'message-content-style'
  });

  const create = requests.find((item) => item.key === 'POST /api/mcp/missions');
  assert.equal(create.body.items.length, 2);
  assert.equal(create.body.items[0].analysisIntent, 'style');
  assert.equal(create.body.items[0].depth, 'full');
  assert.equal(create.body.items[1].analysisIntent, 'style');
  assert.equal(create.body.items[1].depth, 'full');
  assert.equal(create.body.items.some((item) => ['content-creator', 'reviewer', 'operator'].includes(item.agentId)), false);
});

test('自然语言同时命中多个分析模式时要求用户只选一种', async () => {
  const client = new AgentArmyClient({ fetchImpl:async () => { throw new Error('不应发送请求'); } });
  await assert.rejects(() => client.createTask({
    title:'深度拆解并提取模板',
    taskType:'content.video-benchmark-analysis',
    sourceUrls:['https://example.com/video']
  }), /检测到多个分析模式/);
});

test('切换分析模式并引用原小D任务时只创建新分析任务', async () => {
  const requests = [];
  const client = new AgentArmyClient({
    fetchImpl:async (url, options = {}) => {
      const key = `${options.method || 'GET'} ${new URL(url).pathname}`;
      requests.push({ key, body:options.body ? JSON.parse(options.body) : null });
      if (key === 'POST /api/tasks') return response(201, { task:{ taskId:'28282828-2828-2828-2828-282828282828' } });
      if (key === 'POST /api/feishu/task-status') return response(200, { terminal:false, status:'running', message:'处理中。' });
      if (key === 'GET /api/overview') return response(200, { ...overview, tasks:[{ ...overview.tasks[0], taskId:'28282828-2828-2828-2828-282828282828' }] });
      return response(404, { error:'missing' });
    }
  });
  await client.createTask({
    title:'继续深度拆解', taskType:'content.video-benchmark-analysis', analysisIntent:'deep',
    sourceUrls:['https://example.com/video'], sourceTaskIds:['source-task-1234']
  });
  assert.equal(requests.some((item) => item.key === 'POST /api/mcp/missions'), false);
  const create = requests.find((item) => item.key === 'POST /api/tasks');
  assert.deepEqual(create.body.context.sourceTaskIds, ['source-task-1234']);
  assert.equal(create.body.analysisIntent, 'deep');
});

test('用户明确要求人工完整听审时保留人工确认门禁', async () => {
  const requests = [];
  const client = new AgentArmyClient({
    fetchImpl:async (url, options = {}) => {
      const key = `${options.method || 'GET'} ${new URL(url).pathname}`;
      requests.push({ key, body:options.body ? JSON.parse(options.body) : null });
      if (key === 'POST /api/mcp/missions') return response(201, {
        mission:{ taskId:'26262626-2626-2626-2626-262626262626' },
        children:[],
        reply:'总任务已建立。'
      });
      if (key === 'POST /api/mcp/completion-watches') return response(200, { registered:true });
      if (key === 'GET /api/overview') return response(200, { ...overview, tasks:[] });
      return response(404, { error:'missing' });
    }
  });

  await client.createTask({
    title:'人工听审后拆解',
    taskType:'content.video-benchmark-analysis',
    sourceUrls:['https://example.com/video'],
    evidenceMode:'formal',
    reviewPolicy:'required',
    chatRef:'oc_content',
    requestRef:'message-content-human-review'
  });

  const create = requests.find((item) => item.key === 'POST /api/mcp/missions');
  assert.equal(create.body.items[0].reviewPolicy, 'required');
});

test('内容增长单次等待早于 Hermes 300 秒桥返回，12 分钟预算留在 A君后台', async () => {
  let capturedTimeoutMs;
  const signal = new AbortController().signal;
  const client = new AgentArmyClient({
    timeoutSignalImpl:(timeoutMs) => {
      capturedTimeoutMs = timeoutMs;
      return signal;
    },
    fetchImpl:async (_url, options) => {
      assert.equal(options.signal, signal);
      return response(200, { result:{ verified:true } });
    }
  });

  const result = await client.executeContentGrowth({
    issueId:'issue-content-timeout',
    runId:'run-content-timeout',
    paperclipAgentId:'agent-content-timeout',
    agentArmyId:'video-content-analyst'
  });

  assert.equal(result.result.verified, true);
  assert.equal(capturedTimeoutMs, 270_000);
});

test('运维官健康执行只转发当前 Paperclip 身份到固定本机路由', async () => {
  const requests = [];
  const client = new AgentArmyClient({
    fetchImpl:async (url, options = {}) => {
      requests.push({
        path:new URL(url).pathname,
        method:options.method,
        body:JSON.parse(options.body)
      });
      return response(200, { result:{ verified:true, healthStatus:'healthy' } });
    }
  });

  const result = await client.executeOperationsHealth({
    issueId:'issue-health',
    runId:'run-health',
    paperclipAgentId:'agent-health',
    agentArmyId:'operator'
  });

  assert.equal(result.result.healthStatus, 'healthy');
  assert.deepEqual(requests, [{
    path:'/api/mcp/operations-health-execute',
    method:'POST',
    body:{
      issueId:'issue-health',
      runId:'run-health',
      paperclipAgentId:'agent-health',
      agentArmyId:'operator'
    }
  }]);
});

test('员工指派执行只转发当前 Paperclip 身份，不能注入岗位、路径或命令', async () => {
  const requests = [];
  const client = new AgentArmyClient({
    fetchImpl:async (url, options = {}) => {
      requests.push({
        path:new URL(url).pathname,
        method:options.method,
        body:JSON.parse(options.body)
      });
      return response(200, { result:{ verified:true, recommendedCompletionStatus:'succeeded' } });
    }
  });

  const result = await client.executeEmployeeAssignment({
    issueId:'issue-research',
    runId:'run-research',
    paperclipAgentId:'agent-research',
    agentArmyId:'intel-researcher',
    path:'/tmp/not-allowed',
    command:'whoami',
    agentId:'ajun'
  });

  assert.equal(result.result.verified, true);
  assert.deepEqual(requests, [{
    path:'/api/mcp/employee-assignment-execute',
    method:'POST',
    body:{
      issueId:'issue-research',
      runId:'run-research',
      paperclipAgentId:'agent-research',
      agentArmyId:'intel-researcher'
    }
  }]);
});

test('M5 专用阶段执行只转发当前 Paperclip 身份，不接受 toolId、Case 或业务参数', async () => {
  const requests = [];
  const client = new AgentArmyClient({
    fetchImpl:async (url, options = {}) => {
      requests.push({
        path:new URL(url).pathname,
        method:options.method,
        body:JSON.parse(options.body),
      });
      return response(200, { result:{ status:'succeeded' } });
    },
  });

  await client.executeM5Stage({
    issueId:'issue-voice',
    runId:'run-voice',
    paperclipAgentId:'agent-voice',
    agentArmyId:'content-creator',
    toolId:'publisher.fake_publish',
    caseId:'caller-case',
    parameters:{ token:'not-forwarded' },
  });

  assert.deepEqual(requests, [{
    path:'/api/mcp/m5-stage-execute',
    method:'POST',
    body:{
      issueId:'issue-voice',
      runId:'run-voice',
      paperclipAgentId:'agent-voice',
      agentArmyId:'content-creator',
    },
  }]);
});

test('AgentArmyClient rejects non-loopback base URLs', () => {
  assert.throws(
    () => new AgentArmyClient({ baseUrl:'https://example.com' }),
    (error) => error instanceof AgentArmyClientError && /loopback/.test(error.message)
  );
});

test('AgentArmyClient creates one idempotent mission with explicit employee dependencies', async () => {
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
      if (key === 'POST /api/mcp/completion-watches') return response(200, { registered:true });
      if (key === 'GET /api/overview') return response(200, {
        ...overview,
        tasks:[
          {
            taskId:missionId, taskType:'army.cross-agent-mission', assigneeAgentId:'ajun',
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
    items:[{
      title:'研究公开资料',
      taskType:'research.intel-report',
      agentId:'intel-researcher',
      dependsOnPrevious:true,
      evidenceMode:'preliminary',
      depth:'full',
      focus:'来源差异',
      platforms:['douyin'],
      contentGoal:'形成行动清单'
    }]
  });

  assert.equal(result.mission.taskId, missionId);
  assert.equal(result.children[0].agentId, 'intel-researcher');
  assert.equal(result.userMessage, '总任务已建立。');
  const create = requests.find((item) => item.key === 'POST /api/mcp/missions');
  assert.match(create.body.idempotencyKey, /^hermes-mission:oc_boss:/);
  assert.equal(create.body.items[0].taskType, 'research.intel-report');
  assert.equal(create.body.items[0].dependsOnPrevious, true);
  assert.equal(create.body.items[0].evidenceMode, 'preliminary');
  assert.equal(create.body.items[0].depth, 'full');
  assert.equal(create.body.items[0].focus, '来源差异');
  assert.deepEqual(create.body.items[0].platforms, ['douyin']);
  assert.equal(create.body.items[0].contentGoal, '形成行动清单');
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
              assigneeAgentId:'ajun',
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
        input:{
          description:'large internal task envelope',
          context:{
            m5Recovery:{
              schemaVersion:'agent.army/m5-plan-revision/v1',
              revisionId:'m5-plan-revision:11111111-1111-4111-8111-111111111111:r1',
              revision:1,
              failedCaseId:'22222222-2222-4222-8222-222222222222',
              failureObservation:{
                issueId:'issue-old',
                runId:'run-old',
                stageKey:'voice',
                summary:'旁白输入失败。',
                summaryHash:`sha256:${'a'.repeat(64)}`,
              },
              rejectedRoute:{ kind:'retry_same_inputs', reason:'相同输入已失败。' },
              nextRoute:{
                kind:'same_stage_rebuild_inputs',
                stageKey:'voice',
                preserveVerifiedWorkProducts:true,
                instruction:'重建输入。',
              },
            },
          },
        },
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
      currentStage:'paperclip_hermes_running',
      m5Recovery:{
        schemaVersion:'agent.army/m5-plan-revision/v1',
        revisionId:'m5-plan-revision:11111111-1111-4111-8111-111111111111:r1',
        revision:1,
        failedCaseId:'22222222-2222-4222-8222-222222222222',
        failureObservation:{
          issueId:'issue-old',
          runId:'run-old',
          stageKey:'voice',
          summary:'旁白输入失败。',
          summaryHash:`sha256:${'a'.repeat(64)}`,
        },
        rejectedRoute:{ kind:'retry_same_inputs', reason:'相同输入已失败。' },
        nextRoute:{
          kind:'same_stage_rebuild_inputs',
          stageKey:'voice',
          preserveVerifiedWorkProducts:true,
          instruction:'重建输入。',
        },
      },
    }
  });
  assert.equal(JSON.stringify(assignment).includes('must-not-leak'), false);
  assert.equal(JSON.stringify(assignment).includes('large internal task envelope'), false);
});

test('质量复核指派透传已声明标准但不暴露完整复核上下文', async () => {
  const client = new AgentArmyClient({ fetchImpl:fakeFetch({
    'POST /api/mcp/paperclip-assignment':{
      assignment:{
        issueId:'issue-review', identifier:'AGE-2000', title:'交付质量复核',
        description:'逐项复核。', agentId:'reviewer', runId:'run-review',
      },
      task:{
        taskId:'review-task', taskType:'governance.assurance-review', status:'running',
        currentStage:'paperclip_hermes_running',
        input:{ context:{
          sourceTaskId:'source-task-1234',
          reviewKind:'delivery_quality',
          qualityTier:'important',
          deliveryBrief:{
            purpose:'核对深度拆解', audience:'内容负责人', usageScenario:'决定是否进入简报',
            deliverables:['正式分析报告'],
            acceptanceCriteria:['13 个模块均有证据', '主产物可读'],
            constraints:['不得发布'], readiness:'ready',
            privateNotes:'must-not-leak',
          },
          criteria:[{ key:'artifact_usable', label:'主产物真实存在且可读', required:true, internal:'must-not-leak' }],
          artifactRefs:[{ location:'/private/path' }],
        } },
      },
    },
  }) });

  const result = await client.getPaperclipAssignment({});
  assert.deepEqual(result.task.context, {
    sourceTaskId:'source-task-1234',
    reviewKind:'delivery_quality',
    qualityTier:'important',
    deliveryBrief:{
      purpose:'核对深度拆解', audience:'内容负责人', usageScenario:'决定是否进入简报',
      deliverables:['正式分析报告'],
      acceptanceCriteria:['13 个模块均有证据', '主产物可读'],
      constraints:['不得发布'], readiness:'ready',
    },
    criteria:[{ key:'artifact_usable', label:'主产物真实存在且可读', required:true }],
  });
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
  assert.equal(JSON.stringify(result).includes('/private/path'), false);
});

test('AgentArmyClient 只通过受保护端点发送本机 AI 事件白名单', async () => {
  let request = null;
  const client = new AgentArmyClient({
    fetchImpl:async (url, options) => {
      request = { url, headers:options.headers, body:JSON.parse(options.body) };
      return response(200, { recorded:true, eventId:'event-local-ai' });
    },
  });
  const result = await client.recordPaperclipLocalAiRunEvent({
    issueId:'11111111-1111-4111-8111-111111111111',
    runId:'22222222-2222-4222-8222-222222222222',
    paperclipAgentId:'33333333-3333-4333-8333-333333333333',
    agentArmyId:'xiaod',
    taskId:'44444444-4444-4444-8444-444444444444',
    event:{
      eventType:'capability_call_started', capabilityId:'audio.transcribe',
      provider:'local-whisper', status:'running', startedAt:'2026-08-13T01:00:00.000Z',
      input:{ prompt:'不得发送' }, path:'/private/source.wav', rawResponse:'不得发送',
    },
  });
  assert.equal(result.recorded, true);
  assert.match(request.url, /\/api\/mcp\/local-ai-run-event$/);
  assert.deepEqual(Object.keys(request.body.event).sort(), [
    'capabilityId', 'eventType', 'provider', 'startedAt', 'status',
  ]);
  assert.equal(JSON.stringify(request.body).includes('不得发送'), false);
  assert.equal(JSON.stringify(request.body).includes('/private/source.wav'), false);
});

test('AgentArmyClient 只把结构化岗位草案和 Paperclip 身份交给创建官执行端点', async () => {
  const requests = [];
  const client = new AgentArmyClient({ fetchImpl:fakeFetch({
    'POST /api/mcp/agent-proposal-execute':({ body }) => {
      requests.push(body);
      return {
        result:{
          status:'succeeded',
          proposal:{ proposalId:'proposal-wechat', status:'pending_approval' }
        }
      };
    }
  }) });

  const result = await client.executeAgentProposal({
    issueId:'11111111-1111-4111-8111-111111111111',
    runId:'22222222-2222-4222-8222-222222222222',
    paperclipAgentId:'33333333-3333-4333-8333-333333333333',
    agentArmyId:'creator',
    requestedOutcome:'按指定会话和时间范围获取微信聊天',
    candidateName:'微信聊天取件员',
    agentId:'wechat-chat-reader',
    department:'信息服务部',
    responsibilities:['按批准范围导出聊天'],
    nonResponsibilities:['不读取密钥'],
    acceptedTaskTypes:['wechat.chat.export'],
    desiredSkills:['yichen-wechat-local-vault'],
    requestedCapabilities:['wechat.local-vault.chat.read'],
    acceptanceTitle:'使用脱敏夹具验证单会话导出'
  });

  assert.equal(result.result.proposal.proposalId, 'proposal-wechat');
  assert.deepEqual(requests[0].requestedCapabilities, ['wechat.local-vault.chat.read']);
  assert.equal(requests[0].agentArmyId, 'creator');
  assert.equal(JSON.stringify(requests[0]).includes('apiKey'), false);
});

test('AgentArmyClient 给架构师返回受控事实快照，不暴露任务正文或虚构路径', async () => {
  const client = new AgentArmyClient({ fetchImpl:fakeFetch({
    'POST /api/mcp/paperclip-assignment':{
      assignment:{
        issueId:'issue-architect',
        identifier:'AGE-ARCH',
        title:'评估小R',
        description:'只读评估。',
        agentId:'architect',
        runId:'run-architect',
        groundTruth:{
          schemaVersion:'agent.army/architecture-ground-truth/v1',
          snapshotId:'a'.repeat(64),
          generatedAt:'2026-07-29T01:00:00.000Z',
          limitation:'未列出的事实一律待验证。',
          agents:[{
            ref:'agent:intel-researcher',
            agentId:'intel-researcher',
            name:'小R',
            status:'active',
            acceptedTaskTypes:['research.intel-report'],
            toolAllowlist:['research.public.search'],
            repositoryRefs:['agents/intel-researcher/manifest.json']
          }],
          taskSummary:{ total:1, byStatus:{ succeeded:1 }, byTaskType:{ 'research.intel-report':1 } },
          taskEvidence:[{
            ref:'task:task-real',
            taskId:'task-real',
            taskType:'research.intel-report',
            assigneeAgentId:'intel-researcher',
            status:'succeeded',
            title:'真实研究任务',
            artifactTypes:['intel_research_report'],
            rawDescription:'must-not-leak'
          }]
        }
      },
      task:{
        taskId:'task-architect',
        taskType:'governance.architecture-review',
        status:'running',
        currentStage:'paperclip_hermes_running',
        input:{ description:'must-not-leak' }
      }
    }
  }) });
  const result = await client.getPaperclipAssignment({});
  assert.deepEqual(result.assignment.groundTruth.agents[0].acceptedTaskTypes, ['research.intel-report']);
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
  assert.equal(JSON.stringify(result).includes('agents/capability-registry.md'), false);
});

test('AgentArmyClient 分层回传架构事实、判断和候选方案，不把未来设计塞进未验证事实', async () => {
  let requestBody = null;
  const client = new AgentArmyClient({
    fetchImpl:async (_url, options = {}) => {
      requestBody = JSON.parse(options.body);
      return response(200, { task:{ taskId:'task-architect', status:'succeeded' } });
    }
  });
  await client.completePaperclipAssignment({
    issueId:'issue-architect',
    runId:'run-architect',
    paperclipAgentId:'agent-architect',
    agentArmyId:'architect',
    status:'succeeded',
    summary:'完成分层架构评估。',
    factClaims:[{ claim:'小R已上岗。', evidence_refs:['agent:intel-researcher'] }],
    architectureJudgments:[{
      judgment:'优先复用小R。',
      basis_refs:['agent:intel-researcher'],
      assumptions:['公开资料足够支持第一轮判断。'],
      confidence:'medium'
    }],
    candidateProposals:[{
      proposal:'候选新增架构试验任务。',
      problem:'当前缺少最小验证载体。',
      validation_plan:'先跑一次本机无副作用验收。',
      risks:['可能重复。'],
      non_goals:['不直接上线。']
    }],
    currentStateUnknowns:['外部资料尚未核对。']
  });
  assert.deepEqual(requestBody.factClaims[0].evidenceRefs, ['agent:intel-researcher']);
  assert.equal(requestBody.architectureJudgments[0].confidence, 'medium');
  assert.match(requestBody.candidateProposals[0].proposal, /架构试验/);
  assert.deepEqual(requestBody.currentStateUnknowns, ['外部资料尚未核对。']);
  assert.deepEqual(requestBody.unverifiedClaims, []);
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

test('task_get 只展示同一产物的最新版本，不让失败重试的旧来源污染复核', async () => {
  const client = new AgentArmyClient({ fetchImpl:fakeFetch({
    'GET /api/overview':{
      ...overview,
      tasks:[{
        ...overview.tasks[0],
        artifactRefs:[
          {
            artifactId:'intel-research:task-1', type:'intel_research_report',
            validation:{ exists:true, readable:true, nonEmpty:true },
            data:{ topic:'义乌天气', findings:['旧结果'], conclusion:'旧结论', sources:[{ title:'FedEx System Down', source:'https://irrelevant.example' }] },
          },
          {
            artifactId:'employee-role-report:run-1', type:'employee_role_report',
            validation:{ exists:true, readable:true, nonEmpty:true }, data:{ agentId:'intel-researcher', summary:'历史回报' },
          },
          {
            artifactId:'employee-role-report:run-2', type:'employee_role_report',
            validation:{ exists:true, readable:true, nonEmpty:true },
            data:{ agentId:'intel-researcher', reportedStatus:'succeeded', summary:'最新交付简报', evidence:'runtime://task/intel-research-report', remainingRisks:'天气会变化' },
          },
          {
            artifactId:'intel-research:task-1', type:'intel_research_report',
            validation:{ exists:true, readable:true, nonEmpty:true },
            data:{
              topic:'义乌天气',
              findings:['资料记录：巴黎 罗马 伦敦 纽约 > 义乌 - 今天 小雨 25℃ - 明天 小雨转多云 33℃ / 24℃'],
              conclusion:'最新结论',
              sources:[{
                title:'义乌7天天气预报', source:'https://www.weather.com.cn/weather/101210904.shtml',
                summary:'热门城市 巴黎 罗马 伦敦 纽约 > 义乌 - 今天 小雨 25℃ - 明天 小雨转多云 33℃ / 24℃',
              }],
            },
          },
        ],
      }],
    },
    'POST /api/feishu/task-status':{ terminal:false, message:'待复核。' },
  }) });

  const task = await client.getTask('11111111-1111-1111-1111-111111111111');
  assert.deepEqual(task.artifactHistory, { total:4, current:2, superseded:2 });
  assert.equal(task.artifacts.length, 2);
  assert.equal(task.artifacts[1].report.conclusion, '最新结论');
  assert.equal(task.artifacts[0].ref, 'employee-role-report:run-2');
  assert.equal(task.artifacts[0].report.summary, '最新交付简报');
  assert.equal(JSON.stringify(task).includes('历史回报'), false);
  assert.equal(JSON.stringify(task).includes('FedEx System Down'), false);
  assert.equal(JSON.stringify(task).includes('巴黎'), false);
  assert.match(task.artifacts[1].report.sources[0].summary, /^> 义乌 - 今天/);
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
    if (!(key in routes)) return response(404, { error:`missing ${key}` });
    const route = routes[key];
    const body = options.body ? JSON.parse(options.body) : null;
    return response(200, typeof route === 'function' ? await route({ url, options, body }) : route);
  };
}

function response(status, body) {
  return { ok:status >= 200 && status < 300, status, async json() { return body; } };
}

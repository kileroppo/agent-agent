import assert from 'node:assert/strict';
import test from 'node:test';
import { FeishuCommander, FeishuCommanderValidationError } from '../src/feishu-commander.js';

function setup() {
  const calls = { tasks: [], proposals: [] };
  const task = (input) => ({ taskId: `task-${calls.tasks.length}`, input: { sourceUrl: input.title.match(/https?:\/\/\S+/)?.[0] || null }, artifactRefs: input.taskType === 'operations.health-review' ? [{ type: 'health_report', data: { overall: 'healthy' } }] : input.taskType === 'army.intake' ? [{ type: 'task_intake_record', data: { nextAction: '请补充交付物。' } }] : input.taskType === 'governance.architecture-review' ? [{ type:'architecture_review', data:{ workEvidence:{ frequentPatterns:[{ title:'整理竞品动态', count:3 }] }, roleOpportunities:[{ title:'竞品动态专员' }] } }] : [] });
  const commander = new FeishuCommander({
    tasks: { async create(input) { calls.tasks.push(input); return task(input); } },
    proposals: { async create(input, options) { calls.proposals.push({ input, options }); return { proposalId: 'proposal-1', status: 'draft' }; }, async submit() { return { proposalId: 'proposal-1', status: 'pending_approval', candidateManifest: { name: '公开资料助手' }, governance: { paperclipApprovalId: 'paperclip-approval-1' } }; } }
  });
  return { commander, calls };
}

test('飞书军团总管将系统检查直接路由给运维官，且不创建 Paperclip 语义', async () => {
  const { commander, calls } = setup();
  const result = await commander.handle({ text: '检查系统状态', sourceEventRef: 'feishu:health-1', requesterRef: 'user-safe-ref' });
  assert.equal(calls.tasks[0].taskType, 'operations.health-review');
  assert.equal(calls.tasks[0].source.channel, 'feishu');
  assert.equal(calls.tasks[0].idempotencyKey, 'feishu:feishu:health-1');
  assert.match(result.reply, /【运维官检查结果】/);
});

test('重试小D任务不会落入普通对话，而是返回当前任务链真相', async () => {
  const records = [{ taskId:'media-root', taskType:'media.transcribe-and-refine', status:'failed', source:{ channel:'feishu', chatRef:'chat-retry' }, updatedAt:'2026-07-23T07:00:00.000Z' }];
  const commander = new FeishuCommander({
    tasks:{ async notificationStatus(taskId, chatRef) { assert.equal(taskId, 'media-root'); assert.equal(chatRef, 'chat-retry'); return { status:'recovery_pending', terminal:false, message:'运维官正在接手这项任务。' }; } },
    proposals:{}, store:{ async list() { return records; } }
  });
  const result = await commander.handle({ text:'重试小 D 任务', sourceEventRef:'feishu:retry-command-1', chatRef:'chat-retry' });
  assert.equal(result.kind, 'xiaod_retry');
  assert.match(result.reply, /运维官正在接手/);
});

test('正常中文会先交给 AI 理解，而不是先被关键词规则截走', async () => {
  const { commander, calls } = setup();
  let plannerCalls = 0;
  commander.planner = {
    async decide() {
      plannerCalls += 1;
      return { intent:'army_overview' };
    }
  };
  commander.tasks.overview = async () => ({ agents:[], tasks:[] });
  const result = await commander.handle({ text:'帮我检查一下军团现在有没有问题', sourceEventRef:'feishu:ai-first-1' });
  assert.equal(plannerCalls, 1);
  assert.equal(result.kind, 'army_overview');
  assert.equal(calls.tasks.length, 0);
});

test('要求判断卡住原因和安全接手时，不能被 AI 误答成军团概览', async () => {
  const { commander, calls } = setup();
  commander.planner = { async decide() { return { intent:'army_overview' }; } };
  const result = await commander.handle({
    text:'我怀疑军团有任务卡住了。你先判断有没有异常；如果不能安全处理，告诉我该由谁接手和我需要做什么。',
    sourceEventRef:'feishu:operations-triage-1'
  });
  assert.equal(calls.tasks.length, 1);
  assert.equal(calls.tasks[0].taskType, 'operations.health-review');
  assert.match(result.reply, /【运维官检查结果】/);
  assert.match(result.reply, /接手：运维官已完成检查/);
  assert.match(result.reply, /你现在要做：/);
  assert.doesNotMatch(result.reply, /【军团情况】/);
});

test('从运维官自己的飞书智能体进入时，直接执行运维检查而不经过总管概览', async () => {
  const { commander, calls } = setup();
  let agentId = null;
  commander.planner = { async decide(_text, input) { agentId = input.agentId; return { intent:'health_check' }; } };
  const result = await commander.handle({ text:'我怀疑有任务卡住，请检查。', sourceEventRef:'feishu:operator-direct-1', targetAgentId:'operator' });
  assert.equal(calls.tasks.length, 1);
  assert.equal(agentId, 'operator');
  assert.equal(calls.tasks[0].agentId, 'operator');
  assert.equal(calls.tasks[0].taskType, 'operations.health-review');
  assert.match(result.reply, /【运维官检查结果】/);
});

test('从技术专家自己的飞书智能体进入时，先索要故障证据，不直接修改系统', async () => {
  const { commander, calls } = setup();
  const result = await commander.handle({ text:'帮我修一下', sourceEventRef:'feishu:expert-direct-1', targetAgentId:'technical-expert' });
  assert.equal(calls.tasks.length, 0);
  assert.match(result.reply, /故障任务号/);
});

test('从技术专家自己的飞书智能体提供故障任务号时，只读判断真实任务链', async () => {
  const taskId = '42a09df2-ed2f-49a1-81f1-255b7912af54';
  const retryTaskId = '53461521-7da1-4835-8c99-ddddd22fc179';
  const records = [
    { taskId, taskType:'media.transcribe-and-refine', status:'failed', currentStage:'xiaod_failed', input:{ title:'整理公开视频' }, error:{ code:'xiaod_job_failed', stage:'failed', retryable:true } },
    { taskId:retryTaskId, parentTaskId:taskId, taskType:'media.transcribe-and-refine', status:'succeeded', recovery:{ rootTaskId:taskId }, updatedAt:'2026-07-24T08:12:00.000Z' }
  ];
  const commander = new FeishuCommander({
    tasks:{ async create() { throw new Error('只读判断不应创建修复任务'); } },
    proposals:{},
    store:{ async list() { return records; } }
  });
  const result = await commander.handle({ text:`只读判断任务 ${taskId} 的故障范围，不要修改系统。`, sourceEventRef:'feishu:expert-direct-2', targetAgentId:'technical-expert' });
  assert.equal(result.kind, 'technical_triage');
  assert.match(result.reply, /【技术专家只读判断】/);
  assert.match(result.reply, /xiaod_job_failed/);
  assert.match(result.reply, new RegExp(retryTaskId));
  assert.match(result.reply, /没有修改系统/);
});

test('已退役的任务协调官入口不会再创建任务', async () => {
  const { commander, calls } = setup();
  commander.planner = { async decide(_text, input) { assert.equal(input.agentId, 'task-coordinator'); return { intent:'army_intake' }; } };
  await commander.handle({ text:'请协调现有员工检查军团状态。', sourceEventRef:'feishu:coordinator-direct-1', targetAgentId:'task-coordinator' });
  assert.equal(calls.tasks.length, 0);
});

test('从审核官入口可按自然语言审查小G、小R草案，不要求负责人先提供内部编号', async () => {
  const calls = [];
  const commander = new FeishuCommander({
    tasks:{ async create() { throw new Error('审核草案不应创建普通业务任务'); } },
    proposals:{ async reviewRegisteredDrafts(text) {
      calls.push(text);
      return [
        { proposalId:'proposal-g', trialReadiness:{ message:'等待负责人确认受限测试。' }, requestedCapabilities:['github.public.search', 'github.public.read'], candidateManifest:{ name:'小G', dataScopes:[{ scope:'public-github-metadata', access:'read' }], nonResponsibilities:['不登录'], qualityGates:[{ gate:'sources-have-public-url-and-fetched-at' }] }, reviewRefs:[{ role:'reviewer', result:'human_owner_decision_required' }] },
        { proposalId:'proposal-r', trialReadiness:{ message:'等待负责人确认受限测试。' }, requestedCapabilities:['content.public.fetch'], candidateManifest:{ name:'小R', dataScopes:[{ scope:'public-research-sources', access:['read'] }], nonResponsibilities:['不外发'], qualityGates:[{ gate:'research-report-has-required-structure' }] }, reviewRefs:[{ role:'reviewer', result:'human_owner_decision_required' }] }
      ];
    } },
    planner:{ async decide() { throw new Error('明确的草案审查不应等待模型判断'); } }
  });
  const result = await commander.handle({ text:'审核一下小G和小R这两个新员工草案', sourceEventRef:'feishu:review-drafts-1', targetAgentId:'reviewer' });
  assert.equal(result.kind, 'registered_draft_review');
  assert.deepEqual(calls, ['审核一下小G和小R这两个新员工草案']);
  assert.match(result.reply, /【审核官 · 小G】/);
  assert.match(result.reply, /【审核官 · 小R】/);
  assert.match(result.reply, /github\.public\.search/);
  assert.match(result.reply, /草案号：proposal-r/);
});

test('AI 临时不可用时，已有安全路由仍能接住明确的系统检查', async () => {
  const { commander, calls } = setup();
  commander.planner = { async decide() { throw new Error('model unavailable'); } };
  const result = await commander.handle({ text:'检查系统状态', sourceEventRef:'feishu:ai-fallback-health-1' });
  assert.equal(calls.tasks[0].taskType, 'operations.health-review');
  assert.match(result.reply, /【运维官检查结果】/);
});

test('用户问总管是谁时直接格式化回答，不等待 AI、不登记任务', async () => {
  const { commander, calls } = setup();
  commander.planner = { async decide() { throw new Error('身份介绍不应等待 AI'); } };
  const result = await commander.handle({ text:'你是谁？', sourceEventRef:'feishu:identity-1' });
  assert.equal(result.kind, 'identity');
  assert.equal(calls.tasks.length, 0);
  assert.match(result.reply, /【我是 A君·军团总管】/);
  assert.match(result.reply, /你不用记指令/);
});

test('用户点名问小D最近做了什么时，只返回小D的真实近况，不展开全团也不新建任务', async () => {
  const calls = [];
  const commander = new FeishuCommander({
    tasks: {
      async overview() { return { agents:[{ agentId:'xiaod', name:'小D', status:'active', acceptedTaskTypes:['media.transcribe-and-refine'] }, { agentId:'public-reporter', name:'公开资料报告员', status:'active', acceptedTaskTypes:['report.public-material'] }], tasks:[
        { taskId:'xiaod-link', assigneeAgentId:'xiaod', status:'needs_input', updatedAt:'2026-07-22T09:00:00.000Z', input:{ title:'补充链接验证' } },
        { taskId:'public-report', assigneeAgentId:'public-reporter', status:'running', updatedAt:'2026-07-22T09:05:00.000Z', input:{ title:'整理公开网页' } }
      ] }; },
      async create(input) { calls.push(input); return null; }
    },
    proposals:{},
    planner:{ async decide() { return { intent:'employee_status', agentId:'xiaod' }; } }
  });
  const result = await commander.handle({ text:'看下小D最近干了啥', sourceEventRef:'feishu:xiaod-recent-1' });
  assert.equal(result.kind, 'employee_status');
  assert.equal(calls.length, 0);
  assert.match(result.reply, /【小D最近情况】/);
  assert.match(result.reply, /补充链接验证/);
  assert.doesNotMatch(result.reply, /公开资料报告员|整理公开网页/);
});

test('员工近况识别执行者字段，并如实显示已完成任务', async () => {
  const commander = new FeishuCommander({
    tasks:{ async overview() { return { agents:[{ agentId:'xiaod', name:'小D', status:'active' }], tasks:[{ taskId:'media-finished', taskType:'media.transcribe-and-refine', status:'succeeded', execution:{ executor:'xiaod' }, updatedAt:'2026-07-24T06:46:21.000Z', input:{ title:'验收公开视频' } }] }; } },
    proposals:{}, planner:{ async decide() { return { intent:'employee_status', agentId:'xiaod' }; } }
  });
  const result = await commander.handle({ text:'看下小D最近干了啥', sourceEventRef:'feishu:xiaod-finished-1' });
  assert.match(result.reply, /验收公开视频.*已完成/);
  assert.doesNotMatch(result.reply, /暂时没有完成/);
});

test('用户问“小D目前在干嘛”时，即使 AI 想追问也必须读取真实任务状态', async () => {
  let plannerCalls = 0;
  const commander = new FeishuCommander({
    tasks:{
      async overview() {
        return {
          agents:[{ agentId:'xiaod', name:'小D', status:'active' }],
          tasks:[{
            taskId:'e5ee60cf-71e4-4fd0-9dcb-e891448783b6',
            taskType:'media.transcribe-and-refine',
            status:'running',
            execution:{ executor:'xiaod' },
            updatedAt:'2026-07-25T07:17:00.000Z',
            input:{ title:'整理小红书视频' }
          }]
        };
      }
    },
    proposals:{},
    planner:{ async decide() { plannerCalls += 1; return { intent:'clarify' }; } }
  });
  const result = await commander.handle({ text:'小D目前在干嘛', sourceEventRef:'feishu:xiaod-current-1', chatRef:'chat-xiaod-current' });
  assert.equal(result.kind, 'employee_status');
  assert.equal(plannerCalls, 0);
  assert.match(result.reply, /【小D最近情况】/);
  assert.match(result.reply, /整理小红书视频.*正在处理/);
});

test('AI 把仅含员工名字的工作短句误判为员工状态时，总管会安全追问链接，不重复派活', async () => {
  const { commander, calls } = setup();
  commander.planner = { async decide() { return { intent:'employee_status', agentId:'xiaod' }; } };
  const result = await commander.handle({ text:'小D补充链接验证', sourceEventRef:'feishu:xiaod-status-guard-1' });
  assert.equal(result.kind, 'clarify');
  assert.equal(result.reply, '请提供需要小D补充或验证的具体链接。');
  assert.equal(calls.tasks.length, 0);
});

test('AI 听不清的聊天会自然追问，不创建泛任务或报登记失败', async () => {
  const { commander, calls } = setup();
  commander.planner = { async decide() { return { intent:'clarify', reply:'你是想查看哪一项工作的明细？' }; } };
  const result = await commander.handle({ text:'哪几项？', sourceEventRef:'feishu:clarify-1' });
  assert.equal(result.kind, 'clarify');
  assert.equal(result.reply, '你是想查看哪一项工作的明细？');
  assert.equal(calls.tasks.length, 0);
});

test('用户只说小D补充链接验证时，AI 要链接而不是重复展示小D状态或新建工作', async () => {
  const { commander, calls } = setup();
  commander.planner = { async decide() { return { intent:'clarify', reply:'请把需要验证的链接发给我。' }; } };
  const result = await commander.handle({ text:'小D补充链接验证', sourceEventRef:'feishu:xiaod-link-clarify-1' });
  assert.equal(result.kind, 'clarify');
  assert.equal(result.reply, '请把需要验证的链接发给我。');
  assert.equal(calls.tasks.length, 0);
});

test('小D要求链接后，下一条公开链接会按原意交给小D，而不是丢失上下文', async () => {
  const contexts = new Map();
  const created = [];
  const commander = new FeishuCommander({
    tasks: {
      async create(input) { created.push(input); return { taskId:'xiaod-link-1', status:'queued', input:{ sourceUrl:input.title.match(/https?:\/\/\S+/)?.[0] || null }, artifactRefs:[] }; }
    },
    proposals: {},
    store: {
      async getConversationContext(chatRef) { return contexts.get(chatRef) || null; },
      async setConversationContext(chatRef, context) { contexts.set(chatRef, context); return context; }
    },
    planner: { async decide() { return { intent:'employee_status', agentId:'xiaod' }; } }
  });
  const first = await commander.handle({ text:'小D补充链接验证', sourceEventRef:'feishu:pending-link-1', chatRef:'chat-pending-link' });
  assert.equal(first.kind, 'clarify');
  assert.equal(contexts.get('chat-pending-link').kind, 'awaiting_link');
  const result = await commander.handle({ text:'https://www.xiaohongshu.com/explore/example', sourceEventRef:'feishu:pending-link-2', chatRef:'chat-pending-link' });
  assert.equal(created.length, 1);
  assert.equal(created[0].taskType, 'media.transcribe-and-refine');
  assert.equal(created[0].agentId, 'xiaod');
  assert.equal(result.kind, 'media_task');
});

test('链接卡片只传来标题时，不会被错误当成上一轮用量明细', async () => {
  const contexts = new Map([['chat-link-title', { kind:'usage_report', expiresAt:new Date(Date.now() + 60_000).toISOString(), recordedTaskCount:25, actualToolCalls:3 }]]);
  const commander = new FeishuCommander({
    tasks: { async create() { throw new Error('标题不能创建任务'); } }, proposals: {},
    store: {
      async getConversationContext(chatRef) { return contexts.get(chatRef) || null; },
      async setConversationContext(chatRef, context) { contexts.set(chatRef, context); return context; }
    },
    planner: { async decide() { return { intent:'clarify', reply:'你想让我怎么处理这条内容？' }; } },
    conversationAdvisor: { async decide() { throw new Error('链接标题不应被当成用量追问'); } }
  });
  const result = await commander.handle({ text:'微妙的恶意 - 小红书', sourceEventRef:'feishu:link-title-1', chatRef:'chat-link-title' });
  assert.equal(result.kind, 'clarify');
  assert.doesNotMatch(result.reply, /本机执行记录|使用情况/);
});

test('AI 临时不可用时，闲聊不会被误登记为泛任务', async () => {
  const { commander, calls } = setup();
  commander.planner = { async decide() { throw new Error('AI 临时不可用'); } };
  const result = await commander.handle({ text:'然后呢？', sourceEventRef:'feishu:clarify-fallback-1' });
  assert.equal(result.kind, 'clarify');
  assert.equal(calls.tasks.length, 0);
});

test('飞书军团总管将小D请求保留为同一飞书事件任务', async () => {
  const { commander, calls } = setup();
  commander.tasks.create = async (input) => {
    calls.tasks.push(input);
    return { taskId:'task-1', taskType:input.taskType, status:'running', assigneeAgentId:'xiaod', execution:{ executor:'xiaod' }, input:{ sourceUrl:'https://example.com/demo.mp4' }, artifactRefs:[] };
  };
  const result = await commander.handle({ text: '整理视频 https://example.com/demo.mp4', sourceEventRef: 'feishu:media-1' });
  assert.equal(calls.tasks[0].taskType, 'media.transcribe-and-refine');
  assert.equal(calls.tasks[0].source.eventRef, 'feishu:media-1');
  assert.equal(result.task.assigneeAgentId, 'xiaod');
  assert.equal(result.task.execution.executor, 'xiaod');
  assert.match(result.reply, /已交给小D/);
});

test('从新的 A君智能体入口发来视频任务时，A君只调度，不会占用小D岗位', async () => {
  const { commander, calls } = setup();
  commander.tasks.create = async (input) => {
    calls.tasks.push(input);
    return { taskId:'xiaod-running', taskType:input.taskType, status:'running', assigneeAgentId:'xiaod', execution:{ executor:'xiaod' }, input:{ sourceUrl:'https://example.com/video.mp4' }, artifactRefs:[] };
  };
  const result = await commander.handle({
    text:'转录这个视频 https://example.com/video.mp4',
    sourceEventRef:'feishu:ajun-smart-media-1',
    chatRef:'chat-ajun-smart',
    targetAgentId:'ajun'
  });
  assert.equal(calls.tasks.length, 1);
  assert.equal(calls.tasks[0].taskType, 'media.transcribe-and-refine');
  assert.equal(calls.tasks[0].agentId, undefined);
  assert.match(result.reply, /已交给小D/);
});

test('小D没有真正接单时，A君如实说明未开始，不假装已交办', async () => {
  const { commander } = setup();
  commander.tasks.create = async () => ({
    taskId:'media-unrouted', taskType:'media.transcribe-and-refine', status:'needs_input',
    input:{ sourceUrl:'https://example.com/video.mp4' }, routing:{ reason:'没有岗位声明支持该任务类型。' }, artifactRefs:[]
  });
  const result = await commander.handle({ text:'转录 https://example.com/video.mp4', sourceEventRef:'feishu:media-unrouted-1' });
  assert.match(result.reply, /小D尚未开始处理/);
  assert.doesNotMatch(result.reply, /^已交给小D/);
});

test('从指定员工的飞书入口进来的工作，会保留该员工身份交给同一套军团记录处理', async () => {
  const { commander, calls } = setup();
  await commander.handle({ text:'整理视频 https://example.com/demo.mp4', sourceEventRef:'feishu:direct-xiaod-1', targetAgentId:'xiaod' });
  assert.equal(calls.tasks[0].agentId, 'xiaod');
  assert.equal(calls.tasks[0].source.targetAgentId, 'xiaod');
});

test('公开资料员工的飞书入口使用稳定名字，不依赖试用时生成的内部编号', async () => {
  const { commander, calls } = setup();
  commander.tasks.overview = async () => ({ agents:[{ agentId:'candidate-lf1e0f', status:'active', acceptedTaskTypes:['report.public-material'] }] });
  await commander.handle({ text:'整理网页 https://example.com/article', sourceEventRef:'feishu:direct-report-1', targetAgentId:'public-reporter' });
  assert.equal(calls.tasks[0].agentId, 'candidate-lf1e0f');
  assert.equal(calls.tasks[0].source.targetAgentId, 'public-reporter');
});

test('飞书入口携带的非法员工身份不会影响正常路由', async () => {
  const { commander, calls } = setup();
  await commander.handle({ text:'整理视频 https://example.com/demo.mp4', sourceEventRef:'feishu:direct-invalid-1', targetAgentId:'xiaod;bad' });
  assert.equal(calls.tasks[0].agentId, undefined);
  assert.equal(calls.tasks[0].source.targetAgentId, undefined);
});

test('飞书军团总管把普通公开网页交给已上岗的网页摘要员工，而不是误交给小D', async () => {
  const { commander, calls } = setup();
  const result = await commander.handle({ text: '帮我整理这篇网页 https://example.com/article', sourceEventRef: 'feishu:web-1' });
  assert.equal(calls.tasks[0].taskType, 'report.public-material');
  assert.match(result.reply, /公开网页摘要员工/);
});

test('GitHub 意图路由到小R，并保留公开仓库输入和回执', async () => {
  const { commander, calls } = setup();
  commander.planner = { async decide() { return { intent:'github_search' }; } };
  commander.tasks.create = async (input) => {
    calls.tasks.push(input);
    return { taskId:'github-1', taskType:input.taskType, status:'running', assigneeAgentId:'intel-researcher', input:{ repo:input.repo }, artifactRefs:[] };
  };
  const result = await commander.handle({ text:'读 openai/example 的 README，说明它怎么实现 Agent', sourceEventRef:'feishu:github-1' });
  assert.equal(calls.tasks[0].taskType, 'research.github-search');
  assert.equal(calls.tasks[0].agentId, 'intel-researcher');
  assert.equal(calls.tasks[0].repo, 'openai/example');
  assert.match(result.reply, /已交给小R/);
});

test('中文 Agent 治理检索会转成 GitHub 可检索的核心查询', async () => {
  const { commander, calls } = setup();
  commander.planner = { async decide() { return { intent:'github_search' }; } };
  await commander.handle({ text:'帮我在 GitHub 找几个做 Agent 治理的开源项目，比较 star、语言、最近更新时间和适用场景。', sourceEventRef:'feishu:github-governance-1' });
  assert.equal(calls.tasks[0].taskType, 'research.github-search');
  assert.equal(calls.tasks[0].agentId, 'intel-researcher');
  assert.equal(calls.tasks[0].query, 'agent governance');
  assert.match(calls.tasks[0].title, /Agent 治理/);
});

test('主题研究意图路由到小R，并保留主题与原会话回执', async () => {
  const { commander, calls } = setup();
  commander.planner = { async decide() { return { intent:'intel_research' }; } };
  commander.tasks.create = async (input) => {
    calls.tasks.push(input);
    return { taskId:'intel-1', taskType:input.taskType, status:'running', assigneeAgentId:'intel-researcher', input:{ topic:input.topic }, artifactRefs:[] };
  };
  const result = await commander.handle({ text:'帮我研究 Agent 运行时这个主题，给结论和行动建议', sourceEventRef:'feishu:intel-1', chatRef:'chat-intel' });
  assert.equal(calls.tasks[0].taskType, 'research.intel-report');
  assert.equal(calls.tasks[0].agentId, 'intel-researcher');
  assert.match(calls.tasks[0].topic, /Agent 运行时/);
  assert.match(result.reply, /已交给小R研究/);
});

test('办公材料整理意图路由到办公执行助理并返回真实汇报摘要', async () => {
  const calls = [];
  const commander = new FeishuCommander({
    tasks:{ async create(input) {
      calls.push(input);
      return {
        taskId:'office-task-1',
        taskType:input.taskType,
        status:'succeeded',
        input:{ title:input.title, description:input.description },
        artifactRefs:[{ type:'office_briefing_package', data:{ title:'本周工作｜办公汇报包', summary:'已整理三项工作。', sourceTasks:[{ taskId:'a' }, { taskId:'b' }, { taskId:'c' }], openItems:[], nextAction:'请审阅。', markdown:'# 汇报包' } }]
      };
    } },
    proposals:{},
    planner:{ async decide() { return { intent:'office_briefing' }; } }
  });
  const result = await commander.handle({ text:'把这周的工作结果整理成办公汇报包', sourceEventRef:'feishu:office-1', chatRef:'chat-office' });
  assert.equal(calls[0].taskType, 'office.briefing-package');
  assert.equal(calls[0].agentId, 'office-assistant');
  assert.equal(calls[0].description, '把这周的工作结果整理成办公汇报包');
  assert.match(result.reply, /办公执行助理已完成/);
  assert.match(result.reply, /已核对 3 项关联工作/);
});

test('从办公执行助理自己的飞书入口派活时保留员工身份和同一任务记录', async () => {
  const calls = [];
  const commander = new FeishuCommander({
    tasks:{ async create(input) {
      calls.push(input);
      return { taskId:'office-direct-1', taskType:input.taskType, status:'needs_input', input:{ title:input.title }, artifactRefs:[], error:{ userMessage:'请提供需要整理的材料。' } };
    } },
    proposals:{},
    planner:{ async decide(_text, context) { assert.equal(context.agentId, 'office-assistant'); return { intent:'office_briefing' }; } }
  });
  const result = await commander.handle({ text:'整理', sourceEventRef:'feishu:office-direct-1', chatRef:'chat-office', targetAgentId:'office-assistant' });
  assert.equal(calls[0].agentId, 'office-assistant');
  assert.equal(calls[0].taskType, 'office.briefing-package');
  assert.equal(calls[0].source.targetAgentId, 'office-assistant');
  assert.match(result.reply, /请提供需要整理的材料/);
});

test('公开资料超过单次上限时，总管如实要求分批，不假装已经派活', async () => {
  const commander = new FeishuCommander({
    tasks: { async create() { return { taskId:'web-limit', status:'needs_input', input:{ sourceUrl:'https://example.com/1' }, error:{ userMessage:'一次最多对比五条公开网页链接；请分两次发送。' }, artifactRefs:[] }; } },
    proposals: {}
  });
  const result = await commander.handle({ text:'对比六条公开网页 https://example.com/1', sourceEventRef:'feishu:web-limit-1' });
  assert.match(result.reply, /最多对比五条/);
  assert.doesNotMatch(result.reply, /已交给公开网页摘要员工/);
});

test('总管能直接听懂带链接的自然网页请求，不要求用户背固定口令', async () => {
  const { commander, calls } = setup();
  await commander.handle({ text:'请用适合新手的方式，帮我解释这项公开资料工作：https://example.com/guide', sourceEventRef:'feishu:free-wording-1' });
  assert.equal(calls.tasks[0].taskType, 'report.public-material');
});

test('AI 判断为公开资料工作时，没有链接也可以交给公开资料员工自行搜索', async () => {
  const { commander, calls } = setup();
  commander.tasks.overview = async () => ({ agents:[{ agentId:'public-reporter', name:'公开资料报告员', status:'active', acceptedTaskTypes:['report.public-material'] }] });
  commander.planner = { async decide() { return { intent:'route_task', taskType:'report.public-material', agentId:'public-reporter' }; } };
  await commander.handle({ text:'帮我研究三个公开竞品，最后给我中文行动清单', sourceEventRef:'feishu:competitor-no-link-1' });
  assert.equal(calls.tasks[0].taskType, 'report.public-material');
  assert.equal(calls.tasks[0].agentId, 'public-reporter');
});

test('AI 把明确公开资料请求保守归成普通待办时，仍会交给公开资料员工', async () => {
  const { commander, calls } = setup();
  commander.tasks.overview = async () => ({ agents:[{ agentId:'public-reporter', name:'公开资料报告员', status:'active', acceptedTaskTypes:['report.public-material'] }] });
  commander.planner = { async decide() { return { intent:'intake' }; } };
  await commander.handle({ text:'查找三个公开竞品资料，给我中文重点和行动清单', sourceEventRef:'feishu:competitor-fallback-1' });
  assert.equal(calls.tasks[0].taskType, 'report.public-material');
});

test('管家问题也先由 AI 理解，再只读取本机真实状态回答', async () => {
  const { commander, calls } = setup();
  let plannerCalled = false;
  commander.planner = { async decide() { plannerCalled = true; return { intent:'army_capabilities' }; } };
  commander.tasks.overview = async () => ({ agents:[
    { agentId:'operator', status:'active', acceptedTaskTypes:['operations.health-review'] },
    { agentId:'xiaod', status:'active', acceptedTaskTypes:['media.transcribe-and-refine'] }
  ] });
  const result = await commander.handle({ text:'你现在能干什么？', sourceEventRef:'feishu:fast-capabilities-1' });
  assert.equal(plannerCalled, true);
  assert.equal(calls.tasks.length, 0);
  assert.equal(result.kind, 'army_capabilities');
});

test('陌生但低风险的工作会自动交给架构师评估能力缺口，不要求用户再说继续', async () => {
  const continued = [];
  const commander = new FeishuCommander({
    tasks: {
      async create() { return { taskId:'intake-1', taskType:'army.intake', status:'succeeded', input:{ title:'研究竞品' }, artifactRefs:[{ type:'task_intake_record', data:{ autoContinue:true, recommendedTaskType:'governance.architecture-review', recommendedAgentId:'architect' } }] }; },
      async continueFromRecommendation(taskId) { continued.push(taskId); return { taskId:'architecture-1', taskType:'governance.architecture-review', status:'succeeded', input:{ title:'研究竞品' }, artifactRefs:[{ type:'architecture_review', data:{ workEvidence:{ frequentPatterns:[] }, roleOpportunities:[], nextAction:'先用公开资料验证最小工作范围。' } }] }; }
    }, proposals:{}
  });
  const result = await commander.handle({ text:'规划一个需要付费投放的竞品项目', sourceEventRef:'feishu:unknown-work-1' });
  assert.deepEqual(continued, ['intake-1']);
  assert.match(result.reply, /已经把这件事交给架构师/);
  assert.match(result.reply, /先用公开资料验证/);
});

test('陌生工作的架构评估优先回复具体目标、交付物和缺少材料，不混入无关历史复盘', async () => {
  const commander = new FeishuCommander({
    tasks: {
      async create() {
        return {
          taskId:'intake-complaints',
          taskType:'army.intake',
          status:'succeeded',
          input:{ title:'分类客户投诉' },
          artifactRefs:[{ type:'task_intake_record', data:{ autoContinue:true, recommendedTaskType:'governance.architecture-review', recommendedAgentId:'architect' } }]
        };
      },
      async continueFromRecommendation() {
        return {
          taskId:'architecture-complaints',
          taskType:'governance.architecture-review',
          status:'succeeded',
          input:{ title:'分类客户投诉' },
          artifactRefs:[{
            type:'architecture_review',
            data:{
              understoodRequest:{
                outcome:'把上个月客户投诉按原因分类并确定改进优先级',
                deliverable:'分类统计和改进优先级清单',
                missing:['上个月投诉原始数据', '优先级判断标准']
              },
              workEvidence:{ frequentPatterns:[{ title:'整理视频', count:12 }] },
              roleOpportunities:[],
              nextAction:'先提供一份去标识的投诉样本，再验证分类规则。'
            }
          }]
        };
      }
    },
    proposals:{}
  });
  const result = await commander.handle({ text:'帮我分类客户投诉', sourceEventRef:'feishu:unknown-complaints-1' });
  assert.match(result.reply, /目标：把上个月客户投诉按原因分类/);
  assert.match(result.reply, /交付物：分类统计和改进优先级清单/);
  assert.match(result.reply, /上个月投诉原始数据/);
  assert.doesNotMatch(result.reply, /整理视频/);
  assert.match(result.reply, /没有创建新员工、登录账号、外发或假装已经完成/);
});

test('飞书军团总管把重复工作复盘交给架构师', async () => {
  const { commander, calls } = setup();
  const result = await commander.handle({ text:'看看最近有哪些工作反复出现，是否需要新员工', sourceEventRef:'feishu:architecture-1' });
  assert.equal(calls.tasks[0].taskType, 'governance.architecture-review');
  assert.match(result.reply, /架构师复盘真实工作/);
  assert.match(result.reply, /不会自动上线/);
});

test('明确要求复盘最近工作时，不被 AI 误答成日报', async () => {
  const { commander, calls } = setup();
  commander.planner = { async decide() { return { intent:'army_report' }; } };
  const result = await commander.handle({ text:'复盘最近工作', sourceEventRef:'feishu:architecture-review-1', chatRef:'chat-safe-ref' });
  assert.equal(calls.tasks.length, 1);
  assert.equal(calls.tasks[0].taskType, 'governance.architecture-review');
  assert.equal(result.kind, 'architecture_review');
});

test('竞品研究行动清单先进入能力补齐评估，不误路由到研究员工', async () => {
  const { commander, calls } = setup();
  commander.planner = { async decide() { return { intent:'intel_research' }; } };
  const result = await commander.handle({ text:'帮我研究三个竞品并做行动清单', sourceEventRef:'feishu:capability-gap-1', chatRef:'chat-safe-ref' });
  assert.equal(calls.tasks.length, 1);
  assert.equal(calls.tasks[0].taskType, 'governance.architecture-review');
  assert.equal(result.kind, 'architecture_review');
});

test('飞书军团总管把多人协作盘点交给多人协作服务', async () => {
  const { commander, calls } = setup();
  const missionCalls = [];
  commander.missions = { async create(input) { missionCalls.push(input); return { kind:'cross_agent_mission', reply:'已安排运维官、架构师完成盘点，并汇总到 Paperclip。' }; } };
  const result = await commander.handle({ text:'组织大家一起盘点军团当前状态和下一步优化', sourceEventRef:'feishu:mission-1', chatRef:'chat-safe-ref' });
  assert.equal(calls.tasks.length, 0);
  assert.equal(missionCalls.length, 1);
  assert.equal(missionCalls[0].source.channel, 'feishu');
  assert.match(result.reply, /运维官/);
});

test('飞书军团总管把优先级安排交给多人协作，而不是回复泛泛的补充信息', async () => {
  const { commander, calls } = setup();
  commander.planner = { async decide() { return { intent:'army_planning' }; } };
  const missionCalls = [];
  commander.missions = { async create(input) { missionCalls.push(input); return { kind:'cross_agent_mission', reply:'已安排运维官、架构师协同处理这次军团盘点。' }; } };
  const result = await commander.handle({ text:'帮我判断现在最优先做什么，安排合适的人去做', sourceEventRef:'feishu:planning-1' });
  assert.equal(calls.tasks.length, 0);
  assert.equal(missionCalls.length, 1);
  assert.match(result.reply, /运维官、架构师/);
});

test('A君派给小D后返回受限完成监听信息，供原飞书会话主动收结果', async () => {
  const commander = new FeishuCommander({
    tasks: { async create(input) { return { taskId:'media-task', status:'running', input:{ sourceUrl:input.title.match(/https?:\/\/\S+/)?.[0] }, execution:{ executor:'xiaod', xiaodJobId:'xiaod-job-1' }, artifactRefs:[] }; } },
    proposals: {}, ajunBaseUrl:'http://127.0.0.1:4321'
  });
  const result = await commander.handle({ text:'整理视频 https://example.com/demo.mp4', sourceEventRef:'feishu:media-watch-1', chatRef:'chat-safe-ref' });
  assert.deepEqual(result.completionWatch, { kind:'ajun_task', taskId:'media-task', baseUrl:'http://127.0.0.1:4321' });
});

test('A君不会把非本机地址交给飞书接线监听', async () => {
  const commander = new FeishuCommander({
    tasks: { async create() { return { taskId:'media-task', status:'running', input:{ sourceUrl:'https://example.com/demo.mp4' }, execution:{ executor:'xiaod', xiaodJobId:'xiaod-job-1' }, artifactRefs:[] }; } },
    proposals: {}, ajunBaseUrl:'https://example.com'
  });
  const result = await commander.handle({ text:'整理视频 https://example.com/demo.mp4', sourceEventRef:'feishu:media-watch-2' });
  assert.equal(result.completionWatch, undefined);
});

test('任何还在处理中的已上岗员工任务都能被总管跟进，不只限于小D', async () => {
  const commander = new FeishuCommander({
    tasks: { async create(input) { return { taskId:'web-task', status:'running', assigneeAgentId:'public-reporter', input:{ sourceUrl:input.title.match(/https?:\/\/\S+/)?.[0] }, artifactRefs:[] }; } },
    proposals: {}, ajunBaseUrl:'http://127.0.0.1:4321'
  });
  const result = await commander.handle({ text:'整理这个网页 https://example.com/article', sourceEventRef:'feishu:web-watch-1', chatRef:'chat-safe-ref' });
  assert.deepEqual(result.completionWatch, { kind:'ajun_task', taskId:'web-task', baseUrl:'http://127.0.0.1:4321' });
});

test('普通员工同步失败但恢复链路已接手时，仍登记原飞书会话完成监听', async () => {
  const commander = new FeishuCommander({
    tasks: { async create(input) {
      return {
        taskId:'failed-web-task',
        status:'failed',
        assigneeAgentId:'public-reporter',
        input:{ sourceUrl:input.title.match(/https?:\/\/\S+/)?.[0] },
        recovery:{ coordination:{ status:'pending' } },
        artifactRefs:[]
      };
    } },
    proposals:{},
    ajunBaseUrl:'http://127.0.0.1:4321'
  });
  const result = await commander.handle({ text:'整理这个网页 https://example.com/fail', sourceEventRef:'feishu:web-recovery-watch-1', chatRef:'chat-safe-ref' });
  assert.deepEqual(result.completionWatch, { kind:'ajun_task', taskId:'failed-web-task', baseUrl:'http://127.0.0.1:4321' });
});

test('AI理解“大家都在干嘛”后如实说明全部员工、工作与卡点，不创建泛任务', async () => {
  const { commander, calls } = setup();
  commander.planner = { async decide() { return { intent: 'army_overview' }; } };
  commander.tasks.overview = async () => ({
    agents: [{ agentId: 'creator', name: '创建官' }, { agentId: 'task-coordinator', name: '任务协调官' }, { agentId: 'xiaod', name: '小D' }, { agentId: 'operator', name: '运维官' }, { agentId: 'reviewer', name: '审核官' }, { agentId: 'architect', name: '架构师' }, { agentId: 'technical-expert', name: '技术专家' }],
    tasks: [
      { assigneeAgentId: 'xiaod', status: 'running', input: { title: '整理公开视频' } },
      { assigneeAgentId: 'operator', status: 'failed', input: { title: '检查本机状态' } },
      { assigneeAgentId: 'technical-expert', status: 'waiting_test', input: { title: '修复待测试提醒' } },
      { assigneeAgentId: 'reviewer', status: 'waiting_approval', input: { title: '确认新岗位范围' } }
    ]
  });
  const result = await commander.handle({ text: '现在大家都在干嘛，谁卡住了？', sourceEventRef: 'feishu:overview-1', chatRef: 'chat-safe-ref' });
  assert.equal(calls.tasks.length, 0);
  assert.match(result.reply, /共 8 位：7 位员工 \+ 我（A君）/);
  assert.match(result.reply, /【军团情况】/);
  assert.match(result.reply, /【直接干活的员工】/);
  assert.match(result.reply, /【后台支持】/);
  assert.match(result.reply, /【现在需要你决定的事】/);
  assert.match(result.reply, /小D：负责整理公开视频和音频；正在处理/);
  assert.match(result.reply, /\n- /);
  assert.match(result.reply, /创建官：.*当前没有待办/);
  assert.match(result.reply, /小D：.*正在处理/);
  assert.match(result.reply, /运维官：.*没有完成/);
  assert.match(result.reply, /技术专家：.*待测试/);
  assert.match(result.reply, /审核官：.*等你确认范围/);
});

test('用户问今天有什么需要自己处理时，总管只汇报待决定事项，不新建任务', async () => {
  const { commander, calls } = setup();
  commander.tasks.overview = async () => ({
    agents: [{ agentId:'xiaod', name:'小D', status:'active' }, { agentId:'reviewer', name:'审核官', status:'active' }],
    tasks: [
      { assigneeAgentId:'xiaod', status:'running', input:{ title:'整理公开视频' } },
      { assigneeAgentId:'reviewer', status:'waiting_approval', input:{ title:'确认新岗位范围' } }
    ]
  });
  const result = await commander.handle({ text:'今天有什么需要我处理？', sourceEventRef:'feishu:owner-today-1', chatRef:'chat-safe-ref' });
  assert.equal(calls.tasks.length, 0);
  assert.equal(result.kind, 'army_overview');
  assert.match(result.reply, /【现在需要你决定的事】/);
  assert.match(result.reply, /确认新岗位范围/);
});

test('用户问你能干什么时，总管直接说明当前可办的事情，不登记泛任务', async () => {
  const { commander, calls } = setup();
  commander.tasks.overview = async () => ({ agents:[
    { agentId:'operator', status:'active', acceptedTaskTypes:['operations.health-review'] },
    { agentId:'xiaod', status:'active', acceptedTaskTypes:['media.transcribe-and-refine'] },
    { agentId:'intel-researcher', status:'active', acceptedTaskTypes:['report.public-material', 'research.github-search', 'research.intel-report'] },
    { agentId:'architect', status:'active', acceptedTaskTypes:['governance.architecture-review'] }
  ] });
  const result = await commander.handle({ text:'你现在能干什么？', sourceEventRef:'feishu:capabilities-1' });
  assert.equal(calls.tasks.length, 0);
  assert.equal(result.kind, 'army_capabilities');
  assert.match(result.reply, /公开网页/);
  assert.match(result.reply, /小R.*GitHub/);
  assert.match(result.reply, /小R.*公开来源/);
  assert.match(result.reply, /固定说法/);
});

test('当前能力问题不交给模型误答成总管自我介绍', async () => {
  const { commander, calls } = setup();
  commander.planner = { async decide() { return { intent:'identity' }; } };
  commander.tasks.overview = async () => ({ agents:[{ agentId:'xiaod', status:'active', acceptedTaskTypes:['media.transcribe-and-refine'] }] });
  const result = await commander.handle({ text:'你现在能干什么？', sourceEventRef:'feishu:capability-fact-1', chatRef:'chat-safe-ref' });
  assert.equal(result.kind, 'army_capabilities');
  assert.equal(calls.tasks.length, 0);
  assert.match(result.reply, /整理公开视频/);
});

test('用户选择刚才能力菜单的编号时，总管按原菜单执行，不把数字当作陌生任务', async () => {
  const contexts = new Map();
  const calls = [];
  const commander = new FeishuCommander({
    tasks: {
      async overview() { return { agents:[{ agentId:'operator', name:'运维官', status:'active', acceptedTaskTypes:['operations.health-review'] }] }; },
      async create(input) { calls.push(input); return { taskId:'health-choice-2', status:'succeeded', input:{}, artifactRefs:[{ type:'health_report', data:{ overall:'healthy' } }] }; }
    },
    proposals: {},
    store: {
      async getConversationContext(chatRef) { return contexts.get(chatRef) || null; },
      async setConversationContext(chatRef, context) { contexts.set(chatRef, context); return context; }
    },
    planner: { async decide() { throw new Error('菜单编号不应等待 AI'); } },
    conversationAdvisor: { async decide() { throw new Error('菜单编号不应等待 AI'); } }
  });
  await commander.handle({ text:'你能干什么？', sourceEventRef:'feishu:capability-menu-1', chatRef:'chat-safe-ref' });
  const result = await commander.handle({ text:'2', sourceEventRef:'feishu:capability-choice-2', chatRef:'chat-safe-ref' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].taskType, 'operations.health-review');
  assert.match(result.reply, /【运维官检查结果】/);
});

test('用户要今天工作汇报时，总管直接给出完成、进行、卡点和待决定事项', async () => {
  const { commander, calls } = setup();
  const now = new Date().toISOString();
  commander.tasks.overview = async () => ({ tasks: [
    { taskId:'done-1', status:'succeeded', taskType:'report.public-material', input:{ title:'整理公开网页' }, updatedAt:now },
    { taskId:'running-1', status:'running', taskType:'media.transcribe-and-refine', input:{ title:'整理公开视频' }, updatedAt:now },
    { taskId:'waiting-1', status:'waiting_approval', taskType:'army.cross-agent-mission', input:{ title:'确认军团盘点范围' }, updatedAt:now },
    { taskId:'test-1', status:'waiting_test', taskType:'operations.technical-repair', input:{ title:'修复自动检查' }, updatedAt:now }
  ] });
  const result = await commander.handle({ text:'给我一份今天军团的工作汇报', sourceEventRef:'feishu:daily-report-1', chatRef:'chat-safe-ref' });
  assert.equal(calls.tasks.length, 0);
  assert.equal(result.kind, 'army_report');
  assert.match(result.reply, /今天已完成 1 项/);
  assert.match(result.reply, /正在推进 1 项/);
  assert.match(result.reply, /确认军团盘点范围.*等你确认范围/);
  assert.match(result.reply, /另有 1 项技术检查仍待测试/);
  assert.match(result.reply, /【需要你决定】/);
});

test('用户问今天花了多少时，总管只汇报已记录的实际使用，不猜费用', async () => {
  const { commander, calls } = setup();
  commander.tasks.usageOverview = async () => ({ trackedTaskCount:2, actualToolCalls:3, cost:{ reportedTaskCount:0, totals:[] } });
  const result = await commander.handle({ text:'今天花了多少？', sourceEventRef:'feishu:usage-1', chatRef:'chat-safe-ref' });
  assert.equal(calls.tasks.length, 0);
  assert.equal(result.kind, 'usage_report');
  assert.match(result.reply, /3 次本机处理/);
  assert.match(result.reply, /不会猜金额/);
});

test('用户自然追问上一轮使用记录时，总管用 AI 理解并交出真实明细，不创建泛任务', async () => {
  const contexts = new Map();
  const recordedAt = new Date().toISOString();
  const trackedTasks = [
    { taskId:'usage-1', status:'succeeded', assigneeAgentId:'operator', input:{ title:'检查本机状态' }, usage:{ schemaVersion:'agent.army/task-usage/v1', recordedAt, tools:[{ id:'local-health', calls:1 }] } },
    { taskId:'usage-2', status:'waiting_test', assigneeAgentId:'technical-expert', input:{ title:'修复飞书回话' }, usage:{ schemaVersion:'agent.army/task-usage/v1', recordedAt, tools:[{ id:'repair-check', calls:2 }] } }
  ];
  const commander = new FeishuCommander({
    tasks: { async usageOverview() { return { trackedTaskCount:2, actualToolCalls:3, cost:{ reportedTaskCount:0, totals:[] } }; }, async create() { throw new Error('不应创建泛任务'); } },
    proposals: {},
    store: {
      async list() { return trackedTasks; },
      async getConversationContext(chatRef) { return contexts.get(chatRef) || null; },
      async setConversationContext(chatRef, context) { contexts.set(chatRef, context); return context; }
    },
    conversationAdvisor: { async decide({ message, context }) { assert.equal(message, '哪两项？'); assert.equal(context.recordedTaskCount, 2); return { action:'show_last_usage_items' }; } }
  });
  await commander.handle({ text:'今天花了多少？', sourceEventRef:'feishu:usage-summary-1', chatRef:'chat-safe-ref' });
  const result = await commander.handle({ text:'哪两项？', sourceEventRef:'feishu:usage-details-1', chatRef:'chat-safe-ref' });
  assert.equal(result.kind, 'usage_details');
  assert.match(result.reply, /【你刚才问的 2 项工作记录】/);
  assert.match(result.reply, /检查本机状态/);
  assert.match(result.reply, /修复飞书回话/);
  assert.match(result.reply, /本机处理：2 次/);
});

test('使用汇总后问这到底包括什么时，直接返回同一轮真实明细', async () => {
  const contexts = new Map();
  const recordedAt = new Date().toISOString();
  const trackedTasks = [{ taskId:'usage-1', status:'succeeded', assigneeAgentId:'xiaod', input:{ title:'整理公开视频' }, usage:{ schemaVersion:'agent.army/task-usage/v1', recordedAt, tools:[{ id:'xiaod-local-api', calls:1 }] } }];
  const commander = new FeishuCommander({
    tasks: { async usageOverview() { return { trackedTaskCount:1, actualToolCalls:1, cost:{ reportedTaskCount:0, totals:[] } }; }, async create() { throw new Error('不应创建泛任务'); } },
    proposals: {},
    store: { async list() { return trackedTasks; }, async getConversationContext(chatRef) { return contexts.get(chatRef) || null; }, async setConversationContext(chatRef, context) { contexts.set(chatRef, context); return context; } },
    conversationAdvisor: { async decide() { return { action:'not_applicable' }; } }
  });
  await commander.handle({ text:'今天花了多少？', sourceEventRef:'feishu:usage-summary-include-1', chatRef:'chat-safe-ref' });
  const result = await commander.handle({ text:'这到底包括什么？', sourceEventRef:'feishu:usage-details-include-1', chatRef:'chat-safe-ref' });
  assert.equal(result.kind, 'usage_details');
  assert.match(result.reply, /整理公开视频/);
  assert.match(result.reply, /本机处理：1 次/);
});

test('日报不把多人工作的内部子项和技术修理记录逐条冒充业务成果', async () => {
  const { commander } = setup();
  const now = new Date().toISOString();
  commander.tasks.overview = async () => ({ tasks: [
    { taskId:'mission-1', status:'succeeded', taskType:'army.cross-agent-mission', input:{ title:'盘点军团状态' }, updatedAt:now },
    { taskId:'mission-health', parentTaskId:'mission-1', status:'succeeded', taskType:'operations.health-review', input:{ title:'检查军团本机运行状态' }, updatedAt:now },
    { taskId:'mission-architecture', parentTaskId:'mission-1', status:'succeeded', taskType:'governance.architecture-review', input:{ title:'复盘军团当前重复工作与能力缺口' }, updatedAt:now },
    { taskId:'repair-1', status:'waiting_test', taskType:'operations.technical-repair', input:{ title:'修复内部检查' }, updatedAt:now }
  ] });
  const result = await commander.handle({ text:'今天军团做了什么？给我工作总结', sourceEventRef:'feishu:daily-report-filter-1', chatRef:'chat-safe-ref' });
  assert.match(result.reply, /今天已完成 1 项：“盘点军团状态”/);
  assert.doesNotMatch(result.reply, /检查军团本机运行状态/);
  assert.doesNotMatch(result.reply, /修复内部检查/);
  assert.match(result.reply, /1 项技术检查仍待测试/);
});

test('用户说“需要”时，会接住同一会话里卡住的视频，而不是创建泛任务', async () => {
  const { commander, calls } = setup();
  let plannerCalled = false;
  commander.planner = { async decide() { plannerCalled = true; return { intent: 'intake' }; } };
  commander.tasks.notificationStatus = async (taskId, chatRef) => {
    assert.equal(taskId, 'media-1');
    assert.equal(chatRef, 'chat-safe-ref');
    return { status:'technical_repair', message:'“整理公开视频”仍未完成。运维官已经尝试安全恢复，现在已升级给技术专家。' };
  };
  commander.store = { async list() { return [{ taskId: 'media-1', taskType: 'media.transcribe-and-refine', status: 'failed', source: { channel: 'feishu', chatRef: 'chat-safe-ref' }, input: { title: '整理公开视频' } }]; } };
  const result = await commander.handle({ text: '需要', sourceEventRef: 'feishu:follow-up-1', chatRef: 'chat-safe-ref' });
  assert.equal(calls.tasks.length, 0);
  assert.equal(plannerCalled, false);
  assert.match(result.reply, /运维官/);
  assert.match(result.reply, /技术专家/);
});

test('飞书说暂停时，总管提交组织级确认，不会直接假装已经停下', async () => {
  const calls = [];
  const commander = new FeishuCommander({
    tasks: { async requestPause(taskId) { calls.push(taskId); return { task:{ taskId, status:'running' }, approval:{ approvalId:'pause-1', governanceMode:'paperclip', action:'pause-task', riskLevel:'high', reason:'需要确认暂停范围。', requestedScope:{ title:'整理公开视频' }, validUntil:'2026-07-23T00:00:00.000Z' } }; } },
    proposals:{}, store:{ async list(){ return [{ taskId:'media-1', status:'running', source:{ channel:'feishu', chatRef:'chat-safe-ref' }, input:{ title:'整理公开视频' }, execution:{ executor:'xiaod', xiaodJobId:'xiaod-1' } }]; } }
  });
  const result = await commander.handle({ text:'暂停刚才的视频任务', sourceEventRef:'feishu:pause-1', chatRef:'chat-safe-ref' });
  assert.deepEqual(calls, ['media-1']);
  assert.match(result.reply, /暂停确认/);
  assert.equal(result.approval.action, 'pause-task');
});

test('飞书说继续时，只对已暂停任务提交继续确认', async () => {
  const calls = [];
  const commander = new FeishuCommander({
    tasks: { async requestResume(taskId) { calls.push(taskId); return { task:{ taskId, status:'paused' }, approval:{ approvalId:'resume-1', governanceMode:'paperclip', action:'resume-task', riskLevel:'high', reason:'需要确认继续范围。', requestedScope:{ title:'整理公开视频' }, validUntil:'2026-07-23T00:00:00.000Z' } }; } },
    proposals:{}, store:{ async list(){ return [{ taskId:'media-1', status:'paused', source:{ channel:'feishu', chatRef:'chat-safe-ref' }, input:{ title:'整理公开视频' }, execution:{ executor:'xiaod', xiaodJobId:'xiaod-1' } }]; } }
  });
  const result = await commander.handle({ text:'继续刚才的任务', sourceEventRef:'feishu:resume-1', chatRef:'chat-safe-ref' });
  assert.deepEqual(calls, ['media-1']);
  assert.match(result.reply, /继续确认/);
  assert.equal(result.approval.action, 'resume-task');
});

test('飞书说继续但没有暂停任务时，仍会接住之前卡住的工作', async () => {
  const { commander, calls } = setup();
  commander.planner = { async decide() { return { intent:'intake' }; } };
  commander.tasks.notificationStatus = async () => ({ status:'recovery_pending', message:'“整理公开视频”遇到故障，正在交给运维官判断恢复办法。' });
  commander.store = { async list() { return [{ taskId:'media-1', taskType:'media.transcribe-and-refine', status:'failed', source:{ channel:'feishu', chatRef:'chat-safe-ref' }, input:{ title:'整理公开视频' } }]; } };
  const result = await commander.handle({ text:'继续', sourceEventRef:'feishu:continue-failed-1', chatRef:'chat-safe-ref' });
  assert.equal(calls.tasks.length, 0);
  assert.match(result.reply, /运维官/);
});

test('飞书说继续已经完成的小D任务时，只返回真实终态，不创建架构评估', async () => {
  const commander = new FeishuCommander({
    tasks:{ async create() { throw new Error('已完成任务不能被登记成新的架构评估'); } },
    proposals:{},
    planner:{ async decide() { return { intent:'architecture_review' }; } },
    store:{ async list() { return [{
      taskId:'media-done', taskType:'media.transcribe-and-refine', status:'succeeded',
      source:{ channel:'feishu', chatRef:'chat-safe-ref' }, input:{ title:'整理公开视频' },
      execution:{ executor:'xiaod', xiaodJobId:'xiaod-job' }, updatedAt:'2026-07-24T06:28:48.001Z'
    }]; } }
  });
  const result = await commander.handle({ text:'继续刚才的任务', sourceEventRef:'feishu:continue-done-1', chatRef:'chat-safe-ref' });
  assert.equal(result.kind, 'task_control');
  assert.match(result.reply, /已经完成/);
  assert.doesNotMatch(result.reply, /架构师/);
});

test('飞书军团总管在同一会话回答最近视频任务的进度，不再登记泛任务', async () => {
  const { commander, calls } = setup();
  commander.tasks.notificationStatus = async (taskId, chatRef) => {
    assert.equal(taskId, 'media-1');
    assert.equal(chatRef, 'chat-safe-ref');
    return { status:'recovery_pending', message:'“整理公开视频”遇到故障，正在交给运维官判断恢复办法。' };
  };
  commander.store = {
    async list() {
      return [{ taskId: 'media-1', taskType: 'media.transcribe-and-refine', status: 'failed', source: { channel: 'feishu', chatRef: 'chat-safe-ref' }, error: { code: 'executor_failed', userMessage: '小D暂时无法连接。' }, execution: { executor: 'xiaod' } }];
    }
  };
  const result = await commander.handle({ text: '任务进度如何', sourceEventRef: 'feishu:progress-1', chatRef: 'chat-safe-ref' });
  assert.equal(calls.tasks.length, 0);
  assert.match(result.reply, /运维官/);
  assert.doesNotMatch(result.reply, /已经恢复/);
});

test('短进度追问直接查询当前会话最近任务，不交给模型反问', async () => {
  const { commander, calls } = setup();
  commander.planner = { async decide() { throw new Error('进度查询不应调用模型'); } };
  commander.store = { async list() { return [{ taskId:'media-current', taskType:'media.transcribe-and-refine', status:'needs_input', source:{ channel:'feishu', chatRef:'chat-progress' }, error:{ userMessage:'小D暂时无法读取该公开视频。' } }]; } };
  commander.tasks.notificationStatus = async (taskId, chatRef) => ({ message:`任务 ${taskId} 卡在素材读取：需要更换可公开访问的链接。${chatRef ? '' : ''}` });
  const result = await commander.handle({ text:'目前啥进度', sourceEventRef:'feishu:progress-short-1', chatRef:'chat-progress' });
  assert.equal(result.task.taskId, 'media-current');
  assert.equal(calls.tasks.length, 0);
  assert.match(result.reply, /卡在素材读取/);
  assert.match(result.reply, /任务号：media-current/);
});

test('查询进度优先返回同一会话最新任务，不被旧的待补任务劫持', async () => {
  const { commander } = setup();
  commander.store = {
    async list() {
      return [
        { taskId:'older-needs-input', taskType:'media.transcribe-and-refine', status:'needs_input', source:{ channel:'feishu', chatRef:'chat-progress' }, input:{ title:'旧公开视频' }, updatedAt:'2026-07-23T04:23:03.155Z' },
        { taskId:'latest-running', taskType:'media.transcribe-and-refine', status:'running', assigneeAgentId:'xiaod', source:{ channel:'feishu', chatRef:'chat-progress' }, input:{ title:'新公开视频' }, updatedAt:'2026-07-23T04:38:31.890Z' }
      ];
    }
  };
  commander.tasks.notificationStatus = async (taskId) => ({ message:`${taskId}：正在由小D处理。` });
  const result = await commander.handle({ text:'查询进度', sourceEventRef:'feishu:progress-latest-1', chatRef:'chat-progress' });
  assert.equal(result.task.taskId, 'latest-running');
  assert.match(result.reply, /正在由小D处理/);
});

test('粘贴当前会话任务号时直接返回该任务进度，不把编号当成新问题', async () => {
  const { commander, calls } = setup();
  const taskId = 'f0cf67b0-dac8-40fc-824e-b5ce360a1b80';
  commander.planner = { async decide() { throw new Error('任务号不应调用模型'); } };
  commander.store = { async list() { return [{ taskId, taskType:'media.transcribe-and-refine', status:'needs_input', source:{ channel:'feishu', chatRef:'chat-task-id' } }]; } };
  commander.tasks.notificationStatus = async (receivedId) => ({ message:`小D尚未开始：该公开视频暂不可读取（${receivedId}）。` });
  const result = await commander.handle({ text:taskId, sourceEventRef:'feishu:progress-id-1', chatRef:'chat-task-id' });
  assert.equal(result.task.taskId, taskId);
  assert.equal(calls.tasks.length, 0);
  assert.match(result.reply, /暂不可读取/);
});

test('问小D具体进度时只查询当前会话的小D任务，不再泛泛追问', async () => {
  const { commander, calls } = setup();
  commander.planner = { async decide() { throw new Error('员工进度不应调用模型'); } };
  commander.store = { async list() { return [
    { taskId:'other-task', taskType:'report.public-material', status:'running', source:{ channel:'feishu', chatRef:'chat-xiaod' } },
    { taskId:'xiaod-task', taskType:'media.transcribe-and-refine', status:'needs_input', source:{ channel:'feishu', chatRef:'chat-xiaod' } }
  ]; } };
  commander.tasks.notificationStatus = async (taskId) => ({ message:`${taskId}：等待一个可公开访问的视频链接。` });
  const result = await commander.handle({ text:'小D的具体进度', sourceEventRef:'feishu:xiaod-progress-1', chatRef:'chat-xiaod' });
  assert.equal(result.task.taskId, 'xiaod-task');
  assert.equal(calls.tasks.length, 0);
  assert.match(result.reply, /【小D任务进度】/);
  assert.match(result.reply, /可公开访问的视频链接/);
});

test('飞书军团总管优先回答同一会话仍在进行的网页任务，不误说成小D视频任务', async () => {
  const { commander, calls } = setup();
  commander.store = {
    async list() {
      return [
        { taskId: 'old-media', taskType: 'media.transcribe-and-refine', status: 'succeeded', source: { channel: 'feishu', chatRef: 'chat-safe-ref' }, input: { title: '旧视频整理' }, updatedAt: '2026-07-22T10:00:00.000Z' },
        { taskId: 'web-1', taskType: 'report.public-material', status: 'running', source: { channel: 'feishu', chatRef: 'chat-safe-ref' }, input: { title: '整理公开网页' }, updatedAt: '2026-07-22T10:01:00.000Z' }
      ];
    }
  };
  const result = await commander.handle({ text: '刚才那件事进度怎么样', sourceEventRef: 'feishu:progress-web-1', chatRef: 'chat-safe-ref' });
  assert.equal(calls.tasks.length, 0);
  assert.equal(result.task.taskId, 'web-1');
  assert.match(result.reply, /公开资料报告员/);
  assert.match(result.reply, /完成后会回到当前飞书会话/);
});

test('飞书军团总管会在进度回复中带回已完成网页任务的真实摘要', async () => {
  const { commander } = setup();
  commander.store = {
    async list() {
      return [{ taskId: 'web-done', taskType: 'report.public-material', status: 'succeeded', source: { channel: 'feishu', chatRef: 'chat-safe-ref' }, input: { title: '整理公开网页' }, artifactRefs: [{ type: 'public_web_report', data: { summary: '这篇文章主要讲公开资料整理。' } }] }];
    }
  };
  const result = await commander.handle({ text: '结果呢', sourceEventRef: 'feishu:progress-web-2', chatRef: 'chat-safe-ref' });
  assert.match(result.reply, /公开资料报告员已完成/);
  assert.match(result.reply, /内容概览/);
  assert.match(result.reply, /来源/);
  assert.match(result.reply, /这篇文章主要讲公开资料整理/);
});

test('用户评价结果时，总管只关联同一会话最近完成的工作，不新建泛任务', async () => {
  const { commander, calls } = setup();
  const feedbackCalls = [];
  commander.store = { async list() { return [
    { taskId:'old-other-chat', status:'succeeded', source:{ channel:'feishu', chatRef:'chat-other' }, input:{ title:'旧工作' }, updatedAt:'2026-07-22T10:00:00.000Z' },
    { taskId:'done-here', status:'succeeded', source:{ channel:'feishu', chatRef:'chat-safe-ref' }, input:{ title:'整理公开网页' }, updatedAt:'2026-07-22T10:01:00.000Z' },
    { taskId:'child-here', parentTaskId:'done-here', status:'succeeded', source:{ channel:'feishu', chatRef:'chat-safe-ref' }, input:{ title:'内部修理' }, updatedAt:'2026-07-22T10:02:00.000Z' }
  ]; } };
  commander.tasks.recordFeedback = async (taskId, input) => { feedbackCalls.push({ taskId, input }); return { taskId, feedback:input }; };
  const result = await commander.handle({ text:'这次不行，需要改进', sourceEventRef:'feishu:feedback-1', chatRef:'chat-safe-ref' });
  assert.equal(calls.tasks.length, 0);
  assert.deepEqual(feedbackCalls, [{ taskId:'done-here', input:{ sentiment:'needs_improvement', note:'这次不行，需要改进' } }]);
  assert.match(result.reply, /需要改进/);
  assert.match(result.reply, /不会假装已经重做/);
});

test('没有可评价的已完成工作时，总管不新建任务也不写入评价', async () => {
  const { commander, calls } = setup();
  commander.store = { async list() { return []; } };
  commander.tasks.recordFeedback = async () => { throw new Error('must not record'); };
  const result = await commander.handle({ text:'这次做得不错', sourceEventRef:'feishu:feedback-empty-1', chatRef:'chat-safe-ref' });
  assert.equal(calls.tasks.length, 0);
  assert.match(result.reply, /没有刚完成的工作/);
});

test('创建 Agent 只提交草案审核，不创建业务任务', async () => {
  const { commander, calls } = setup();
  const result = await commander.handle({ text: '创建一个 Agent，整理公开行业报告', sourceEventRef: 'feishu:create-1' });
  assert.equal(calls.tasks.length, 0);
  assert.equal(calls.proposals[0].input.sourceEventRef, 'feishu:create-1');
  assert.equal(calls.proposals[0].options.source, 'feishu');
  assert.match(result.reply, /提交组织级审核/);
  assert.equal(result.approval.governanceMode, 'proposal');
});

test('带岗位名称的创建 Agent 请求也会提交草案审核', async () => {
  const { commander, calls } = setup();
  const result = await commander.handle({ text: '创建一个公开网页摘要 Agent：只读取公开网页，输出中文摘要报告', sourceEventRef: 'feishu:create-named-1' });
  assert.equal(calls.tasks.length, 0);
  assert.equal(calls.proposals[0].input.sourceEventRef, 'feishu:create-named-1');
  assert.equal(calls.proposals[0].input.sourceChatRef, null);
  assert.match(result.reply, /提交组织级审核/);
});

test('还没有真实执行能力的新岗位会在草案回执里说清楚，不让负责人误以为能直接上岗', async () => {
  const commander = new FeishuCommander({
    tasks: { async create() { throw new Error('不应创建业务任务'); } },
    proposals: {
      async create() { return { proposalId:'proposal-gap', status:'draft' }; },
      async submit() {
        return {
          proposalId:'proposal-gap', status:'pending_approval', candidateManifest:{ name:'视频发布员' },
          trialReadiness:{ status:'needs_capability', message:'这个岗位的草案可以先审核，但军团目前还没有对应的真实执行能力；不会进入试用，更不会上线。' },
          governance:{ paperclipApprovalId:'approval-gap' }
        };
      }
    }
  });
  const result = await commander.handle({ text:'创建一个视频发布 Agent', sourceEventRef:'feishu:create-gap-1' });
  assert.match(result.reply, /目前还没有对应的真实执行能力/);
  assert.match(result.reply, /不会进入试用，更不会上线/);
});

test('用“助手”称呼的新岗位请求也会提交草案审核', async () => {
  const { commander, calls } = setup();
  const result = await commander.handle({ text: '创建一个临时测试助手：只整理公开网页标题', sourceEventRef: 'feishu:create-helper-1' });
  assert.equal(calls.tasks.length, 0);
  assert.equal(calls.proposals[0].input.sourceEventRef, 'feishu:create-helper-1');
  assert.match(result.reply, /提交组织级审核/);
});

test('缺少飞书事件引用时拒绝登记，避免重复副作用', async () => {
  const { commander } = setup();
  await assert.rejects(() => commander.handle({ text: '检查系统状态' }), FeishuCommanderValidationError);
});

test('待审批飞书任务会返回可渲染的 local 审批卡摘要', async () => {
  const approval = { approvalId:'approval-1', status:'pending', governanceMode:'local', action:'manual-risk-review', riskLevel:'high', reason:'需要确认范围。', requestedScope:{ taskType:'operations.health-review' }, validUntil:'2030-01-01T00:00:00.000Z' };
  const commander = new FeishuCommander({
    tasks: { async create() { return { taskId:'task-approval', status:'waiting_approval', approvalRefs:['approval-1'], input:{ sourceUrl:null }, artifactRefs:[] }; } },
    proposals: {}, store: { async listApprovals() { return [approval]; } }
  });
  const result = await commander.handle({ text:'外发系统健康摘要', sourceEventRef:'feishu:approval-1', chatRef:'chat-safe-ref' });
  assert.equal(result.approval.approvalId, 'approval-1');
  assert.equal(result.approval.governanceMode, 'local');
});

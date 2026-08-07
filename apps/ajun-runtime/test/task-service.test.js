import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TaskService, ValidationError } from '../src/task-service.js';
import {
  createM5RouteExecution,
  routeDescriptorFingerprint,
} from '@agent-army/m5-kernel/route-execution';

function setup({
  agents = [],
  governance = null,
  onTaskFailed = null,
  agentChannelStates = null,
  contentGrowthWaitMs = undefined,
  m5ProviderVision = null,
  m5WorkProductValidator = async () => true,
  skillExecutionRegistry = undefined,
  executors = {},
  roleToolAdapters = {},
  officePresentationWorkspaceRoot = null,
} = {}) {
  const records = { tasks: [], approvals: [] };
  const store = { async createTask(task) { const record = { taskId: `task-${records.tasks.length + 1}`, approvalRefs: [], ...task }; records.tasks.push(record); return record; }, async createApproval(approval) { const record = { approvalId: `approval-${records.approvals.length + 1}`, status:'pending', ...approval }; records.approvals.push(record); const task = records.tasks.find((item) => item.taskId === approval.taskId); task.approvalRefs.push(record.approvalId); if (approval.holdTask !== false) { task.status='waiting_approval'; task.currentStage='approval_required'; } return record; }, async updateApproval(approvalId, patch) { const approval = records.approvals.find((item) => item.approvalId === approvalId); Object.assign(approval, patch); return approval; }, async updateTask(taskId, patch) { const task = records.tasks.find((item) => item.taskId === taskId); Object.assign(task, patch); return task; }, async list(){return records.tasks}, async listApprovals(){return records.approvals} };
  const testGovernance = governance ? {
    async assertCaseIssueLink() {},
    ...governance,
  } : governance;
  return { records, service: new TaskService({ registry: { async list(){return agents}, async get(agentId){return agents.find((agent)=>agent.agentId === agentId) || null}, async candidates(type){return agents.filter((agent)=>agent.acceptedTaskTypes.includes(type))} }, store, governance:testGovernance, executors, roleToolAdapters, officePresentationWorkspaceRoot, onTaskFailed, agentChannelStates, contentGrowthWaitMs, m5ProviderVision, m5WorkProductValidator, ...(skillExecutionRegistry ? { skillExecutionRegistry } : {}) }) };
}
const coordinator = { agentId:'ajun', name:'A君', status:'active', acceptedTaskTypes:['army.intake', 'army.route-task', 'army.cross-agent-mission'] };

test('军团路由任务统一登记到 A君', async () => {
  const { service } = setup({ agents:[coordinator] }); const task = await service.create({ title:'安排一次任务', taskType:'army.route-task' });
  assert.equal(task.assigneeAgentId, 'ajun'); assert.equal(task.status, 'queued');
});
test('小D任务保存显式账号绑定并拒绝非法连接标识', async () => {
  const mediaAgent = { agentId:'xiaod', name:'小D', status:'active', acceptedTaskTypes:['media.transcribe-and-refine'] };
  const { service } = setup({ agents:[mediaAgent] });
  const connectionId = '123e4567-e89b-42d3-a456-426614174000';
  const task = await service.create({
    title:'整理小红书素材',
    taskType:'media.transcribe-and-refine',
    agentId:'xiaod',
    sourceUrl:'https://www.xiaohongshu.com/explore/example',
    connectionId
  });
  assert.equal(task.input.connectionId, connectionId);
  await assert.rejects(() => service.create({
    title:'非法连接',
    taskType:'media.transcribe-and-refine',
    agentId:'xiaod',
    connectionId:'../wrong'
  }), ValidationError);
});
test('多人总任务标题包含老板汇报时仍保留军团父任务类型', async () => {
  const missionCoordinator = {
    agentId:'ajun',
    name:'A君',
    status:'active',
    acceptedTaskTypes:['army.cross-agent-mission']
  };
  const { service } = setup({ agents:[missionCoordinator] });
  service.executors.ajun = {
    async execute(task) {
      assert.equal(task.taskType, 'army.cross-agent-mission');
      assert.equal(task.assigneeAgentId, 'ajun');
      return { status:'running', currentStage:'mission_planned', artifactRefs:[] };
    }
  };

  const task = await service.create({
    title:'整理公开视频、核对资料并生成老板汇报',
    description:'1. 整理视频\n2. 调研资料\n3. 等待前两项后生成统一汇报',
    taskType:'army.cross-agent-mission',
    agentId:'ajun',
    context:{ businessMissionItems:[{ title:'整理视频' }, { title:'调研资料' }, { title:'统一汇报' }] }
  });

  assert.equal(task.taskType, 'army.cross-agent-mission');
  assert.equal(task.assigneeAgentId, 'ajun');
  assert.equal(task.status, 'running');
});
test('GitHub 和研究任务都由小R保留受限执行器需要的公开输入字段', async () => {
  const intel = { agentId:'intel-researcher', name:'小R', status:'active', acceptedTaskTypes:['research.github-search', 'research.intel-report'] };
  const { service } = setup({ agents:[intel] });
  const githubTask = await service.create({ title:'读公开仓库', taskType:'research.github-search', agentId:'intel-researcher', repo:'openai/example', path:'README' });
  assert.deepEqual({ repo:githubTask.input.repo, path:githubTask.input.path }, { repo:'openai/example', path:'README' });
  const githubSearchTask = await service.create({ title:'搜索并比较 3 个 GitHub 开源多智能体编排项目', taskType:'research.github-search', agentId:'intel-researcher' });
  assert.equal(githubSearchTask.input.query, 'multi-agent');
  const intelTask = await service.create({ title:'研究主题', taskType:'research.intel-report', agentId:'intel-researcher', topic:'Agent 运行时', sourceUrls:['https://example.com/a'] });
  assert.equal(intelTask.input.topic, 'Agent 运行时');
  assert.deepEqual(intelTask.input.sourceUrls, ['https://example.com/a']);
});
test('小办 PPT 任务保留受控创作字段并允许敏感材料走本地 PPTX', async () => {
  const office = { agentId:'office-assistant', name:'小办', status:'draft', acceptedTaskTypes:['office.presentation-package'] };
  const { service, records } = setup({ agents:[office] });
  const task = await service.create({
    title:'公开固定样例',
    purpose:'验证本地演示文稿交付链',
    audience:'负责人',
    taskType:'office.presentation-package',
    slideCount:2,
    designMode:'design_system',
    designTokens:{ colors:{ primary:'#2563EB' }, fonts:{ heading:'Arial Unicode MS' } },
    outline:[{ title:'结论', bullets:['本地导出'] }, { title:'验收', bullets:['WPS 打开'] }],
    outputs:['pptd', 'pptx'],
    dataClassification:'sensitive',
    externalProcessingApproved:false,
  });
  assert.equal(task.input.purpose, '验证本地演示文稿交付链');
  assert.equal(task.input.audience, '负责人');
  assert.equal(task.input.slideCount, 2);
  assert.equal(task.input.designMode, 'design_system');
  assert.deepEqual(task.input.outline.map((item) => item.title), ['结论', '验收']);
  assert.deepEqual(task.input.outputs, ['pptd', 'pptx']);
  assert.equal(task.input.dataClassification, 'sensitive');
  assert.equal(task.input.externalProcessingApproved, false);
  assert.equal(records.approvals.length, 0);
});
test('结构化 PPT 由 A君受控本地执行并把三类引用写回 Paperclip', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-presentation-task-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const office = { agentId:'office-assistant', name:'小办', status:'active', acceptedTaskTypes:['office.presentation-package'], executionOwner:'paperclip-hermes', interaction:{ runtime:'hermes-profile' } };
  const workProducts = [];
  const toolCalls = [];
  const governance = {
    async project() {
      return { status:'synced', paperclipIssueId:'issue-1', paperclipIssueIdentifier:'AGE-1' };
    },
    async update(task) {
      return { ...task.governance, status:'synced' };
    },
    async getIssueWorkProducts() {
      return workProducts;
    },
    async createIssueWorkProduct(_issueId, product) {
      workProducts.push(product);
      return product;
    },
  };
  const roleToolAdapters = {
    'ajun-task-store':async () => [],
    'open-kimi-pptd':async ({ access, workspaceRoot }) => {
      toolCalls.push({ toolId:access.toolId, workspaceRoot });
      return { ok:true };
    },
    'local-pptx':async ({ access, workspaceRoot }) => {
      toolCalls.push({ toolId:access.toolId, workspaceRoot });
      return { ok:true };
    },
  };
  const artifacts = ['office_presentation_source', 'office_presentation_qa', 'office_pptx_document'].map((type, index) => ({
    artifactId:`artifact-${index + 1}`,
    taskId:'task-1',
    type,
    title:type,
    location:`workspace://artifact-${index + 1}`,
    checksum:String(index + 1).repeat(64),
    validation:{ exists:true, readable:true, nonEmpty:true },
  }));
  const executors = {
    'office-assistant':{
      async execute(_task, { roleToolContext }) {
        await roleToolContext.execute({ toolId:'army.task.read', input:{} });
        await roleToolContext.execute({ toolId:'office.pptd.write', relativePath:'work-products/task-1/presentation/deck.pptd', input:{} });
        await roleToolContext.execute({ toolId:'office.pptx.export', relativePath:'work-products/task-1/presentation/deck.pptx', input:{} });
        return { status:'succeeded', currentStage:'office_presentation_ready', artifactRefs:artifacts };
      },
    },
  };
  const { service } = setup({
    agents:[office], governance, executors, roleToolAdapters,
    officePresentationWorkspaceRoot:root,
  });
  const task = await service.create({
    title:'公开固定样例',
    taskType:'office.presentation-package',
    slides:[{ title:'结论', bullets:['本地导出'] }],
    outputs:['pptd', 'pptx'],
    dataClassification:'public',
  });
  assert.equal(task.status, 'succeeded', JSON.stringify(task.error));
  assert.equal(task.execution.owner, 'ajun-controlled-local');
  assert.equal(task.execution.toolAccesses.length, 3);
  assert.equal(toolCalls.length, 2);
  assert.ok(toolCalls.every((item) => item.workspaceRoot.startsWith(root)));
  assert.deepEqual(workProducts.map((item) => item.metadata.artifactType).sort(), [
    'office_pptx_document',
    'office_presentation_qa',
    'office_presentation_source',
  ]);
  assert.ok(workProducts.every((item) => !('body' in item) && !('content' in item)));
});
test('开放复杂任务直接复用岗位专有执行器且不生成DAG或能力授权产物', async () => {
  const intel = {
    agentId:'intel-researcher',
    name:'小R',
    status:'active',
    manifestVersion:'0.6.0',
    acceptedTaskTypes:['research.intel-report', 'research.open-investigation'],
    toolAllowlist:['content.public.fetch'],
    runtimeCapabilities:{ mcpTools:[], skills:[] },
    openTaskPolicy:{ domain:'research', qualityGateMode:'manifest-required' }
  };
  const { service } = setup({ agents:[intel] });
  service.executors['intel-researcher'] = {
    async execute(task) {
      assert.equal(task.taskType, 'research.intel-report');
      assert.equal(task.input.context.openTaskType, 'research.open-investigation');
      assert.equal(task.input.context.controlPlane, 'paperclip');
      assert.equal(task.input.context.autonomousWorkPlan, undefined);
      return {
        status:'succeeded',
        currentStage:'intel_research_ready',
        artifactRefs:[{
          artifactId:'intel-open-report',
          type:'intel_research_report',
          validation:{ exists:true, readable:true, nonEmpty:true }
        }]
      };
    }
  };

  const task = await service.create({
    title:'比较三种智能体治理方式',
    taskType:'research.open-investigation',
    agentId:'intel-researcher',
    goalSpec:{
      outcome:'形成有证据的治理方式比较报告',
      deliverables:['比较报告'],
      acceptanceCriteria:['至少比较三种方式并区分事实和判断'],
      capabilityRequests:[{
        capabilityId:'content.public.fetch',
        purpose:'读取公开资料'
      }]
    }
  });

  assert.equal(task.status, 'succeeded');
  assert.deepEqual(task.artifactRefs.map((item) => item.type), ['intel_research_report']);
  assert.equal(task.artifactRefs.some((item) => item.type === 'autonomous_work_plan'), false);
  assert.equal(task.artifactRefs.some((item) => item.type === 'capability_discovery_report'), false);
});
test('开放任务请求Manifest外能力时直接闭锁且不产生临时授权产物', async () => {
  const intel = {
    agentId:'intel-researcher',
    name:'小R',
    status:'active',
    acceptedTaskTypes:['research.intel-report', 'research.open-investigation'],
    toolAllowlist:['content.public.fetch'],
    runtimeCapabilities:{ mcpTools:[], skills:[] },
    openTaskPolicy:{ domain:'research', qualityGateMode:'manifest-required' }
  };
  const { service } = setup({ agents:[intel] });

  const task = await service.create({
    title:'登录私有账号并研究',
    taskType:'research.open-investigation',
    agentId:'intel-researcher',
    goalSpec:{
      capabilityRequests:[{
        capabilityId:'private.account.login',
        purpose:'读取私有账号'
      }]
    }
  });

  assert.equal(task.status, 'needs_input');
  assert.equal(task.currentStage, 'manifest_capability_required');
  assert.equal(task.error.code, 'manifest_capability_required');
  assert.deepEqual(task.artifactRefs || [], []);
});
test('Paperclip投影收到开放任务的无状态岗位委托而不是本地DAG', async () => {
  const intel = {
    agentId:'intel-researcher',
    name:'小R',
    status:'active',
    acceptedTaskTypes:['research.intel-report', 'research.open-investigation'],
    toolAllowlist:['content.public.fetch'],
    runtimeCapabilities:{ mcpTools:[], skills:[] },
    openTaskPolicy:{ domain:'research', qualityGateMode:'manifest-required' },
    interaction:{ runtime:'hermes-profile' },
    executionOwner:'paperclip-hermes'
  };
  let projectedTask = null;
  const governance = {
    async project(task) {
      projectedTask = task;
      return { status:'synced', paperclipIssueId:'issue-open-research' };
    },
    async update(task) { return task.governance; }
  };
  const { service } = setup({ agents:[intel], governance });

  const task = await service.create({
    title:'比较三种智能体治理方式',
    taskType:'research.open-investigation',
    agentId:'intel-researcher',
    goalSpec:{
      capabilityRequests:[{
        capabilityId:'content.public.fetch',
        purpose:'读取公开资料'
      }]
    }
  });

  assert.equal(projectedTask.taskType, 'research.open-investigation');
  assert.equal(projectedTask.input.context.openTaskType, 'research.open-investigation');
  assert.equal(projectedTask.input.context.delegatedTaskType, 'research.intel-report');
  assert.equal(projectedTask.artifactRefs?.some((item) => item.type === 'autonomous_work_plan') || false, false);
  assert.equal(task.execution.owner, 'paperclip-hermes');
  assert.equal(task.currentStage, 'waiting_paperclip_heartbeat');
});
test('中文自然语言里的逗号不会被吞进公开链接', async () => {
  const intel = { agentId:'intel-researcher', name:'小R', status:'draft', acceptedTaskTypes:['research.intel-report'] };
  const { service } = setup({ agents:[intel] });
  const task = await service.create({
    title:'请研究 http://info.cern.ch/hypertext/WWW/TheProject.html，给我中文背景、关键发现和建议。',
    taskType:'research.intel-report',
    agentId:'intel-researcher',
    topic:'CERN 公开资料'
  });
  assert.equal(task.input.sourceUrl, 'http://info.cern.ch/hypertext/WWW/TheProject.html');
  assert.deepEqual(task.input.sourceUrls, ['http://info.cern.ch/hypertext/WWW/TheProject.html']);
});
test('多个岗位匹配时要求明确路由', async () => {
  const { service } = setup({ agents:[coordinator, {...coordinator, agentId:'backup'}] }); const task = await service.create({ title:'安排一次任务', taskType:'army.route-task' });
  assert.equal(task.assigneeAgentId, null); assert.equal(task.currentStage, 'routing_needed');
});
test('已启用的小D接到公开素材任务后，任务记录明确归属小D', async () => {
  const xiaod = { agentId:'xiaod', name:'小D', status:'active', acceptedTaskTypes:['media.transcribe-and-refine'] };
  const { service } = setup({ agents:[xiaod] });
  const task = await service.create({ title:'整理公开视频', taskType:'media.transcribe-and-refine', sourceUrl:'https://example.com/demo.mp4' });
  assert.equal(task.assigneeAgentId, 'xiaod');
  assert.equal(task.status, 'queued');
  assert.equal(task.routing.reason, '已路由到已启用的本地执行器。');
});
test('高风险描述创建待审批记录', async () => {
  const { service, records } = setup({ agents:[coordinator] }); const task = await service.create({ title:'向外发布周报', taskType:'army.route-task' });
  assert.equal(records.approvals.length, 1); assert.equal(task.status, 'waiting_approval'); assert.equal(task.currentStage, 'approval_required');
});
test('明确不外发的只读任务不触发审批', async () => {
  const reporter = { agentId:'public-reporter', name:'公开资料报告员', status:'active', acceptedTaskTypes:['report.public-material'], runtime:{ kind:'proposal-public-report' } };
  const { service, records } = setup({ agents:[reporter] });
  service.fallbackExecutor = { supports(agent) { return agent.agentId === 'public-reporter'; }, async execute() { return { status:'succeeded', currentStage:'public_report_ready', artifactRefs:[] }; } };
  const task = await service.create({ title:'整理公开网页', description:'只读公开页面，不外发、不发布、不付费。', taskType:'report.public-material', sourceUrl:'https://example.com' });
  assert.equal(records.approvals.length, 0);
  assert.equal(task.status, 'succeeded');
});
test('并列安全约束里的外发词不会被误判为高风险动作', async () => {
  const operator = { agentId:'operator', name:'运维官', status:'active', acceptedTaskTypes:['operations.health-review'] };
  const { service, records } = setup({ agents:[operator] });
  service.executors.operator = { async execute() { return { status:'succeeded', currentStage:'health_report_ready', artifactRefs:[] }; } };
  const task = await service.create({
    title:'军团健康检查',
    description:'只读健康检查，仅观察公共能力状态并返回结果，不涉及登录、外发、配置修改或执行恢复动作。',
    taskType:'operations.health-review'
  });
  assert.equal(records.approvals.length, 0);
  assert.equal(task.status, 'succeeded');
});
test('只生成草稿或知识笔记的任务不会因描述发布检查而误触外发审批', async () => {
  const office = { agentId:'office-assistant', name:'小办', status:'active', acceptedTaskTypes:['office.knowledge-summary'] };
  const { service } = setup({ agents:[office] });
  service.executors['office-assistant'] = {
    async execute() {
      return { status:'succeeded', currentStage:'knowledge_summary_archived', artifactRefs:[] };
    }
  };
  const task = await service.create({
    title:'归档草稿闭环',
    description:'记录人工发布前检查和未外发边界，只写知识笔记。',
    taskType:'office.knowledge-summary',
    agentId:'office-assistant'
  });
  assert.equal(task.status, 'succeeded');
  assert.equal(task.approvalRefs.length, 0);
});
test('一次性外发审批留在 A君，批准后只恢复原任务一次', async () => {
  const operator = { agentId:'operator', name:'运维官', status:'active', acceptedTaskTypes:['operations.health-review'] };
  let executed = 0; let projected = 0;
  const governance = { async project() { projected += 1; return { status:'synced' }; }, async health() { return { status:'ready' }; } };
  const { service, records } = setup({ agents:[operator], governance });
  service.executors.operator = { async execute() { executed += 1; return { status:'succeeded', currentStage:'health_report_ready', artifactRefs:[] }; } };
  const task = await service.create({ title:'外发本次健康摘要', taskType:'operations.health-review' });
  assert.equal(task.status, 'waiting_approval'); assert.equal(records.approvals[0].governanceMode, 'local'); assert.equal(projected, 0); assert.equal(executed, 0);
  const resumed = await service.approveApproval(records.approvals[0].approvalId, { decisionBy:'A君' });
  assert.equal(resumed.status, 'succeeded'); assert.equal(records.approvals[0].status, 'approved'); assert.equal(executed, 1);
  await assert.rejects(() => service.approveApproval(records.approvals[0].approvalId), /已经处理/);
  assert.equal(executed, 1);
});

test('微信聊天任务自动采用默认范围并且只创建一次隐私确认', async () => {
  const wechat = { agentId:'wechat-chat-retriever', name:'微信聊天取件员', status:'active', acceptedTaskTypes:['wechat.chat.retrieval'] };
  const { service, records } = setup({ agents:[wechat] });
  let executed = 0;
  service.executors['wechat-chat-retriever'] = {
    async execute(task) {
      executed += 1;
      assert.equal(task.input.wechatChat.chatSelector, 'yingz');
      assert.equal(task.input.wechatChat.maxMessages, 200);
      assert.equal(task.input.wechatChat.sameNameStrategy, 'latest-active-session');
      assert.equal(task.input.wechatChat.privateContentModelAccess, 'local-only');
      assert.equal(task.input.wechatChat.outputMode, 'local-summary');
      return { status:'succeeded', currentStage:'wechat_chat_slice_ready', artifactRefs:[] };
    }
  };

  const task = await service.create({
    title:'获取微信聊天',
    description:'群名：yingz',
    taskType:'wechat.chat.retrieval',
    agentId:'reviewer'
  });

  assert.equal(task.assigneeAgentId, 'wechat-chat-retriever');
  assert.equal(task.status, 'waiting_approval');
  assert.equal(executed, 0);
  assert.equal(records.approvals.length, 1);
  assert.equal(records.approvals[0].action, 'wechat-private-chat-read');
  assert.equal(records.approvals[0].governanceMode, 'local');
  assert.equal(records.approvals[0].requestedScope.chatSelector, 'yingz');
  assert.match(records.approvals[0].reason, /本机回环地址上的 Qwen3.5-9B/);
  assert.match(records.approvals[0].reason, /30 分钟内复用，最多 10 个任务，可随时撤销/);

  const completed = await service.approveApproval(records.approvals[0].approvalId);
  assert.equal(completed.status, 'succeeded');
  assert.equal(executed, 1);
});

test('微信聊天任务缺群名时只要求补群名，不再询问其他配置', async () => {
  const wechat = { agentId:'wechat-chat-retriever', name:'微信聊天取件员', status:'active', acceptedTaskTypes:['wechat.chat.retrieval'] };
  const { service, records } = setup({ agents:[wechat] });
  const task = await service.create({ title:'获取微信聊天', taskType:'wechat.chat.retrieval' });
  assert.equal(task.status, 'needs_input');
  assert.equal(task.error.code, 'wechat_chat_required');
  assert.match(task.error.userMessage, /只告诉我联系人或群名/);
  assert.equal(records.approvals.length, 0);
});
test('本机主人可以撤销微信临时授权，概览显示剩余次数', async () => {
  const wechat = { agentId:'wechat-chat-retriever', name:'微信聊天取件员', status:'active', acceptedTaskTypes:['wechat.chat.retrieval'], interaction:{ directFeishu:'disabled' } };
  const { service, records } = setup({ agents:[wechat] });
  service.executors['wechat-chat-retriever'] = { async execute() { return { status:'succeeded', artifactRefs:[] }; } };
  await service.create({ title:'获取微信聊天', description:'群名：yingz', taskType:'wechat.chat.retrieval' });
  const approval = records.approvals[0];
  approval.status = 'approved';
  approval.privateReadGrant = { grantId:'grant-1', maxUses:10, uses:[{ taskId:'task-1' }], expiresAt:'2099-01-01T00:00:00.000Z', revokedAt:null };
  const before = await service.overview();
  assert.equal(before.approvals[0].privateReadGrantStatus.remainingUses, 9);
  const revoked = await service.revokePrivateReadGrant(approval.approvalId);
  assert.ok(revoked.privateReadGrant.revokedAt);
  assert.equal(revoked.privateReadGrantStatus.status, 'revoked');
  assert.equal((await service.overview()).approvals[0].privateReadGrantStatus.status, 'revoked');
});
test('飞书只能从发起任务的原会话撤销微信临时授权', async () => {
  const wechat = { agentId:'wechat-chat-retriever', name:'微信聊天取件员', status:'active', acceptedTaskTypes:['wechat.chat.retrieval'], interaction:{ directFeishu:'disabled' } };
  const { service, records } = setup({ agents:[wechat] });
  service.executors['wechat-chat-retriever'] = { async execute() { return { status:'succeeded', artifactRefs:[] }; } };
  await service.create({ title:'获取微信聊天', description:'群名：yingz', taskType:'wechat.chat.retrieval', source:{ channel:'feishu', chatRef:'chat-a' } });
  const approval = records.approvals[0];
  approval.status = 'approved';
  approval.privateReadGrant = { grantId:'grant-1', maxUses:10, uses:[], expiresAt:'2099-01-01T00:00:00.000Z', revokedAt:null };
  await assert.rejects(() => service.revokePrivateReadGrant(approval.approvalId, { chatRef:'chat-b' }), /会话与原任务不一致/);
  const revoked = await service.revokePrivateReadGrant(approval.approvalId, { chatRef:'chat-a', revokedBy:'feishu-owner' });
  assert.equal(revoked.privateReadGrant.revokedBy, 'feishu-owner');
});
test('运行总览展示微信 Vault 真实健康状态而不是只看岗位 active', async () => {
  const wechat = { agentId:'wechat-chat-retriever', name:'微信聊天取件员', status:'active', acceptedTaskTypes:['wechat.chat.retrieval'], interaction:{ directFeishu:'disabled' } };
  const { service } = setup({ agents:[wechat] });
  service.executors['wechat-chat-retriever'] = {
    async health() {
      return {
        status:'degraded',
        checkedAt:'2026-07-30T06:30:00.000Z',
        requiredDatabases:{ contact:true, session:true, message:false },
        safeMessage:'本机微信只读库缺少消息库，请先安全刷新。'
      };
    }
  };

  const overview = await service.overview();
  const employee = overview.agents.find((item) => item.agentId === 'wechat-chat-retriever');
  const capability = overview.capabilities.find((item) => item.id === 'wechat-private-read');

  assert.equal(employee.runtimeHealth.status, 'degraded');
  assert.equal(capability.status, 'partial');
  assert.match(capability.detail, /缺少消息库/);
});
test('小D听审确认只生成确认稿并交回状态跟踪，不把审批点击冒充任务完成', async () => {
  const xiaod = { agentId:'xiaod', name:'小D', status:'active', acceptedTaskTypes:['media.transcribe-and-refine'] };
  const { service, records } = setup({ agents:[xiaod] });
  records.tasks.push({
    taskId:'media-review-1',
    taskType:'media.transcribe-and-refine',
    status:'waiting_approval',
    currentStage:'xiaod_awaiting_review',
    approvalRefs:['approval-review-1'],
    assigneeAgentId:'xiaod',
    input:{ title:'完整听审公开视频' },
    execution:{ executor:'xiaod', xiaodJobId:'xiaod-review-job-1', polling:{ state:'settled', consecutiveFailures:0, nextPollAt:null } }
  });
  records.approvals.push({
    approvalId:'approval-review-1',
    taskId:'media-review-1',
    status:'pending',
    governanceMode:'local',
    action:'confirm-transcript-after-complete-listen',
    requestedScope:{ taskType:'media.transcribe-and-refine', title:'完整听审公开视频', assigneeAgentId:'xiaod' },
    validUntil:'2099-01-01T00:00:00.000Z'
  });
  const confirmed = [];
  service.executors.xiaod = {
    async confirmTranscript(task, input) { confirmed.push({ taskId:task.taskId, ...input }); return { status:'completed' }; }
  };
  const updated = await service.approveApproval('approval-review-1', { decisionBy:'A君' });
  assert.deepEqual(confirmed, [{ taskId:'media-review-1', reviewerRef:'A君' }]);
  assert.equal(records.approvals[0].status, 'approved');
  assert.equal(updated.status, 'running');
  assert.equal(updated.currentStage, 'xiaod_review_confirmed');
  assert.equal(updated.execution.polling.state, 'pending');
});

test('小D听审拒绝会通知小D并关闭正式下游链路', async () => {
  const xiaod = { agentId:'xiaod', name:'小D', status:'active', acceptedTaskTypes:['media.transcribe-and-refine'] };
  const { service, records } = setup({ agents:[xiaod] });
  records.tasks.push({
    taskId:'media-review-2',
    taskType:'media.transcribe-and-refine',
    status:'waiting_approval',
    currentStage:'xiaod_awaiting_review',
    approvalRefs:['approval-review-2'],
    assigneeAgentId:'xiaod',
    input:{ title:'拒绝错误机器稿' },
    execution:{ executor:'xiaod', xiaodJobId:'xiaod-review-job-2' }
  });
  records.approvals.push({
    approvalId:'approval-review-2',
    taskId:'media-review-2',
    status:'pending',
    governanceMode:'local',
    action:'confirm-transcript-after-complete-listen',
    validUntil:'2099-01-01T00:00:00.000Z'
  });
  let rejected = 0;
  service.executors.xiaod = {
    async rejectTranscript(task, input) {
      rejected += 1;
      assert.equal(task.taskId, 'media-review-2');
      assert.equal(input.reviewerRef, 'A君');
    }
  };
  const updated = await service.rejectApproval('approval-review-2', { decisionBy:'A君', decisionReason:'听审发现缺漏。' });
  assert.equal(rejected, 1);
  assert.equal(records.approvals[0].status, 'rejected');
  assert.equal(updated.status, 'cancelled');
});
test('公开发布等组织级审批投影 Paperclip，不能由本机直接放行', async () => {
  const operator = { agentId:'operator', name:'运维官', status:'active', acceptedTaskTypes:['operations.health-review'] };
  let projected = 0;
  const governance = { async project() { projected += 1; return { status:'synced', paperclipIssueId:'issue-1' }; }, async health() { return { status:'ready' }; } };
  const { service, records } = setup({ agents:[operator], governance });
  const task = await service.create({ title:'公开发布系统摘要', taskType:'operations.health-review' });
  assert.equal(task.status, 'waiting_approval'); assert.equal(records.approvals[0].governanceMode, 'paperclip'); assert.equal(projected, 1);
  await assert.rejects(() => service.approveApproval(records.approvals[0].approvalId), /Paperclip/);
});
test('组织级飞书决定必须先回写 Paperclip，批准后才恢复原任务', async () => {
  const operator = { agentId:'operator', name:'运维官', status:'active', acceptedTaskTypes:['operations.health-review'] };
  let resolved = 0; let executed = 0;
  const governance = {
    async project() { return { status:'synced', paperclipIssueId:'issue-1', paperclipApprovalId:'paperclip-approval-1' }; },
    async resolveApproval(id, decision) { resolved += 1; assert.equal(id, 'paperclip-approval-1'); assert.equal(decision, 'approve'); return { status:'approved' }; },
    async update(task) { return task.governance; }, async health() { return { status:'ready' }; }
  };
  const { service, records } = setup({ agents:[operator], governance });
  service.executors.operator = { async execute() { executed += 1; return { status:'succeeded', currentStage:'health_report_ready', artifactRefs:[] }; } };
  const task = await service.create({ title:'公开发布系统摘要', taskType:'operations.health-review', source:{ channel:'feishu', chatRef:'chat-a' } });
  const result = await service.resolvePaperclipApproval(records.approvals[0].approvalId, 'approve', { decisionBy:'feishu-user', chatRef:'chat-a' });
  assert.equal(resolved, 1); assert.equal(executed, 1); assert.equal(records.approvals[0].status, 'approved'); assert.equal(result.status, 'succeeded');
});
test('已批准的多人总任务可以恢复安全子工作，不重复要求审批', async () => {
  const operator = { agentId:'operator', name:'运维官', status:'active', acceptedTaskTypes:['operations.health-review'] };
  const { service, records } = setup({ agents:[operator] });
  records.tasks.push(
    { taskId:'mission-1', taskType:'army.cross-agent-mission', status:'running', approvalRefs:['approval-parent'], governance:{ paperclipIssueId:'parent-issue' }, input:{ title:'受控多人工作' } },
    { taskId:'child-1', taskType:'operations.health-review', status:'waiting_approval', approvalRefs:['approval-child'], assigneeAgentId:'operator', parentTaskId:'mission-1', input:{ context:{ missionSafeOnly:true, missionTaskId:'mission-1', parentPaperclipIssueId:'parent-issue' } } }
  );
  records.approvals.push({ approvalId:'approval-parent', taskId:'mission-1', status:'approved', governanceMode:'paperclip' }, { approvalId:'approval-child', taskId:'child-1', status:'pending', governanceMode:'paperclip' });
  let executed = 0;
  service.executors.operator = { async execute(){ executed += 1; return { status:'succeeded', currentStage:'health_report_ready', artifactRefs:[] }; } };
  const result = await service.resumeApprovedMissionChild('child-1');
  assert.equal(result.status, 'succeeded');
  assert.equal(executed, 1);
  assert.equal(records.approvals.find((item) => item.approvalId === 'approval-child').status, 'superseded');
});
test('组织级拒绝先回写 Paperclip，关闭任务且不执行', async () => {
  const operator = { agentId:'operator', name:'运维官', status:'active', acceptedTaskTypes:['operations.health-review'] };
  let resolved = 0;
  const governance = { async project() { return { status:'synced', paperclipIssueId:'issue-1', paperclipApprovalId:'paperclip-approval-1' }; }, async resolveApproval(_id, decision) { resolved += 1; assert.equal(decision, 'reject'); return { status:'rejected' }; }, async update(task) { return task.governance; }, async health() { return { status:'ready' }; } };
  const { service, records } = setup({ agents:[operator], governance });
  service.executors.operator = { async execute() { throw new Error('must not run'); } };
  await service.create({ title:'公开发布系统摘要', taskType:'operations.health-review' });
  const result = await service.resolvePaperclipApproval(records.approvals[0].approvalId, 'reject');
  assert.equal(resolved, 1); assert.equal(records.approvals[0].status, 'rejected'); assert.equal(result.status, 'cancelled'); assert.equal(result.currentStage, 'governance_rejected');
});
test('暂停小D任务必须先走 Paperclip 确认，确认前不伪装成已经暂停', async () => {
  const xiaod = { agentId:'xiaod', name:'小D', status:'active', acceptedTaskTypes:['media.transcribe-and-refine'] };
  let resolved = 0; let paused = 0;
  const governance = {
    async project() { return { status:'synced', paperclipIssueId:'pause-issue-1', paperclipApprovalId:'pause-approval-1' }; },
    async resolveApproval(id, decision) { resolved += 1; assert.equal(id, 'pause-approval-1'); assert.equal(decision, 'approve'); return { status:'approved' }; },
    async update(task) { return task.governance; }, async health() { return { status:'ready' }; }
  };
  const { service, records } = setup({ agents:[xiaod], governance });
  records.tasks.push({ taskId:'media-1', taskType:'media.transcribe-and-refine', status:'running', approvalRefs:[], assigneeAgentId:'xiaod', input:{ title:'整理公开视频' }, execution:{ executor:'xiaod', xiaodJobId:'xiaod-job-1' } });
  service.executors.xiaod = { async pause() { paused += 1; return { id:'xiaod-job-1', status:'pausing', progress:45 }; } };
  const requested = await service.requestPause('media-1');
  assert.equal(requested.task.status, 'running');
  assert.equal(requested.approval.governanceMode, 'paperclip');
  assert.equal(records.approvals[0].action, 'pause-task');
  const updated = await service.resolvePaperclipApproval(requested.approval.approvalId, 'approve');
  assert.equal(resolved, 1); assert.equal(paused, 1); assert.equal(updated.status, 'pausing');
});

test('拒绝暂停小D任务不会关闭或打断原任务', async () => {
  const xiaod = { agentId:'xiaod', name:'小D', status:'active', acceptedTaskTypes:['media.transcribe-and-refine'] };
  const governance = {
    async project() { return { status:'synced', paperclipIssueId:'pause-issue-1', paperclipApprovalId:'pause-approval-1' }; },
    async resolveApproval(_id, decision) { assert.equal(decision, 'reject'); return { status:'rejected' }; },
    async update(task) { return task.governance; }, async health() { return { status:'ready' }; }
  };
  const { service, records } = setup({ agents:[xiaod], governance });
  records.tasks.push({ taskId:'media-1', taskType:'media.transcribe-and-refine', status:'running', approvalRefs:[], assigneeAgentId:'xiaod', input:{ title:'整理公开视频' }, execution:{ executor:'xiaod', xiaodJobId:'xiaod-job-1' } });
  const requested = await service.requestPause('media-1');
  const updated = await service.resolvePaperclipApproval(requested.approval.approvalId, 'reject');
  assert.equal(updated.status, 'running');
  assert.equal(records.approvals[0].status, 'rejected');
  assert.equal(updated.execution.control.status, 'rejected');
});
test('继续小D任务经确认后会重新进入总管跟进，不会只改显示状态', async () => {
  const xiaod = { agentId:'xiaod', name:'小D', status:'active', acceptedTaskTypes:['media.transcribe-and-refine'] };
  const governance = {
    async project() { return { status:'synced', paperclipIssueId:'resume-issue-1', paperclipApprovalId:'resume-approval-1' }; },
    async resolveApproval(_id, decision) { assert.equal(decision, 'approve'); return { status:'approved' }; },
    async update(task) { return task.governance; }, async health() { return { status:'ready' }; }
  };
  const { service, records } = setup({ agents:[xiaod], governance });
  records.tasks.push({ taskId:'media-1', taskType:'media.transcribe-and-refine', status:'paused', approvalRefs:[], assigneeAgentId:'xiaod', input:{ title:'整理公开视频' }, execution:{ executor:'xiaod', xiaodJobId:'xiaod-job-1' } });
  const observed = [];
  service.executors.xiaod = { async resume() { return { id:'xiaod-job-1', status:'queued', progress:45 }; }, observe(task) { observed.push(task); } };
  const requested = await service.requestResume('media-1');
  const updated = await service.resolvePaperclipApproval(requested.approval.approvalId, 'approve');
  assert.equal(updated.status, 'running');
  assert.deepEqual(observed.map((task) => task.taskId), ['media-1']);
});
test('飞书审批卡不能跨会话批准原任务', async () => {
  const operator = { agentId:'operator', name:'运维官', status:'active', acceptedTaskTypes:['operations.health-review'] };
  const { service, records } = setup({ agents:[operator] });
  const task = await service.create({ title:'外发本次健康摘要', taskType:'operations.health-review', source:{ channel:'feishu', chatRef:'chat-a' } });
  await assert.rejects(() => service.approveApproval(records.approvals[0].approvalId, { chatRef:'chat-b' }), /会话与原任务不一致/);
  assert.equal(task.status, 'waiting_approval');
});
test('本机主人拒绝审批会关闭任务，不会执行任务', async () => {
  const { service, records } = setup({ agents:[coordinator] }); const task = await service.create({ title:'向外发布周报', taskType:'army.route-task' });
  const closed = await service.rejectApproval(records.approvals[0].approvalId);
  assert.equal(records.approvals[0].status, 'rejected'); assert.equal(closed.status, 'cancelled'); assert.equal(closed.currentStage, 'approval_rejected'); assert.equal(closed.error.code, 'approval_rejected');
});
test('过期确认会自动关闭原任务，并在 Paperclip 标记为阻塞', async () => {
  const operator = { agentId:'operator', name:'运维官', status:'active', acceptedTaskTypes:['operations.health-review'] };
  const updated = [];
  const governance = { async update(task) { updated.push(task); return { ...task.governance, status:'synced' }; } };
  const { service, records } = setup({ agents:[operator], governance });
  records.tasks.push({ taskId:'old-task', taskType:'operations.health-review', status:'waiting_approval', currentStage:'approval_required', approvalRefs:['old-approval'], governance:{ paperclipIssueId:'issue-old' }, input:{ title:'发布旧周报' } });
  records.approvals.push({ approvalId:'old-approval', taskId:'old-task', status:'pending', governanceMode:'paperclip', validUntil:'2020-01-01T00:00:00.000Z' });
  const expired = await service.expirePendingApprovals();
  assert.equal(expired.length, 1);
  assert.equal(records.approvals[0].status, 'expired');
  assert.equal(records.tasks[0].status, 'cancelled');
  assert.equal(records.tasks[0].currentStage, 'approval_expired');
  assert.equal(records.tasks[0].error.code, 'approval_expired');
  assert.equal(updated.length, 1);
  await assert.rejects(() => service.resolvePaperclipApproval('old-approval', 'approve'), /已经处理/);
});
test('过期的暂停或继续确认不会关闭原来的小D工作', async () => {
  const xiaod = { agentId:'xiaod', name:'小D', status:'active', acceptedTaskTypes:['media.transcribe-and-refine'] };
  const { service, records } = setup({ agents:[xiaod] });
  records.tasks.push({ taskId:'media-1', taskType:'media.transcribe-and-refine', status:'running', approvalRefs:['control-approval'], input:{ title:'整理公开视频' }, execution:{ executor:'xiaod', xiaodJobId:'xiaod-job-1', control:{ action:'pause-task', status:'waiting_approval', approvalId:'control-approval' } } });
  records.approvals.push({ approvalId:'control-approval', taskId:'media-1', action:'pause-task', holdTask:false, status:'pending', validUntil:'2020-01-01T00:00:00.000Z' });
  await service.expirePendingApprovals();
  assert.equal(records.approvals[0].status, 'expired');
  assert.equal(records.tasks[0].status, 'running');
  assert.equal(records.tasks[0].execution.control.status, 'expired');
});
test('缺少标题拒绝创建', async () => {
  const { service } = setup({ agents:[coordinator] }); await assert.rejects(() => service.create({ taskType:'army.route-task' }), ValidationError);
});
test('治理台不可用不阻断任务登记，留下待同步记录', async () => {
  const governance = { async project() { return { status: 'sync_pending', reason: 'Paperclip 暂不可用。' }; }, async health() { return { status: 'offline' }; } };
  const { service } = setup({ agents:[coordinator], governance }); const task = await service.create({ title:'登记治理任务', taskType:'army.route-task' });
  assert.equal(task.governance.status, 'sync_pending');
});
test('简单小D业务任务不重复投影到 Paperclip，治理任务才进入组织总控', async () => {
  const xiaod = { agentId:'xiaod', name:'小D', status:'active', acceptedTaskTypes:['media.transcribe-and-refine'] };
  let projected = 0;
  const governance = { async project() { projected += 1; return { status:'synced' }; }, async health() { return { status:'ready' }; } };
  const { service } = setup({ agents:[xiaod], governance });
  service.executors.xiaod = { async execute() { return { status:'needs_input', currentStage:'source_url_required' }; } };
  const task = await service.create({ title:'整理公开视频', taskType:'media.transcribe-and-refine' });
  assert.equal(projected, 0); assert.equal(task.governance, undefined);
});
test('技术修复任务自动登记到 Paperclip', async () => {
  const expert = { agentId:'technical-expert', name:'技术专家', status:'draft', acceptedTaskTypes:['operations.technical-repair'] };
  let projected = 0;
  const governance = { async project() { projected += 1; return { status:'synced', paperclipIssueId:'issue-1' }; }, async health() { return { status:'ready' }; } };
  const { service } = setup({ agents:[expert], governance });
  const task = await service.create({ title:'修复运行时故障', taskType:'operations.technical-repair' });
  assert.equal(projected, 1); assert.equal(task.governance.paperclipIssueId, 'issue-1');
});

test('Paperclip Hermes 员工只等待同一张 heartbeat 任务，不再调用 A君本地执行器', async () => {
  const architect = {
    agentId:'architect',
    name:'架构师',
    status:'active',
    acceptedTaskTypes:['governance.architecture-review'],
    interaction:{ runtime:'hermes-profile', directFeishu:'required' },
    executionOwner:'paperclip-hermes'
  };
  let localExecutions = 0;
  const governance = {
    async project() {
      return {
        status:'synced',
        paperclipIssueId:'paperclip-issue-1',
        paperclipAssigneeAgentId:'paperclip-agent-1'
      };
    }
  };
  const { service } = setup({ agents:[architect], governance });
  service.executors.architect = { async execute() { localExecutions += 1; return { status:'succeeded' }; } };

  const task = await service.create({
    title:'评估六员工运行时边界',
    taskType:'governance.architecture-review',
    agentId:'architect'
  });

  assert.equal(task.status, 'running');
  assert.equal(task.currentStage, 'waiting_paperclip_heartbeat');
  assert.equal(task.execution.owner, 'paperclip-hermes');
  assert.equal(localExecutions, 0);
});

test('Paperclip Hermes heartbeat 会关联原 A君任务并幂等回写同一终态', async () => {
  const architect = {
    agentId:'architect',
    name:'架构师',
    status:'active',
    acceptedTaskTypes:['governance.architecture-review'],
    interaction:{ runtime:'hermes-profile', directFeishu:'required' },
    executionOwner:'paperclip-hermes'
  };
  const completions = [];
  const identity = {
    issue:{ id:'paperclip-issue-1', identifier:'AGE-101', title:'评估架构', description:'检查复用边界。' },
    run:{ id:'paperclip-run-1' },
    paperclipAgent:{ id:'paperclip-agent-1', name:'架构师' },
    agentArmyId:'architect'
  };
  const governance = {
    async project() {
      return { status:'synced', paperclipIssueId:'paperclip-issue-1', paperclipAssigneeAgentId:'paperclip-agent-1' };
    },
    async verifyHermesAssignment() { return identity; },
    async completePaperclipIssue(issueId, input) { completions.push({ issueId, input }); }
  };
  const { service } = setup({ agents:[architect], governance });
  const original = await service.create({
    title:'评估架构',
    taskType:'governance.architecture-review',
    agentId:'architect'
  });
  const input = {
    issueId:'paperclip-issue-1',
    runId:'paperclip-run-1',
    paperclipAgentId:'paperclip-agent-1',
    agentArmyId:'architect',
    status:'succeeded',
    summary:'复用 Hermes Profile Distribution 与 Paperclip hermes_local。',
    evidence:'未新增第二套运行时。',
    remainingRisks:'飞书真人回归待完成。',
    factClaims:[{
      claim:'架构师当前登记为治理评估岗位。',
      evidenceRefs:['agent:architect']
    }],
    architectureJudgments:[{
      judgment:'应优先复用现有 Paperclip/Hermes 执行链，而不是再建一套调度系统。',
      basisRefs:['agent:architect'],
      assumptions:['现有执行链的任务审计仍满足本轮目标。'],
      confidence:'medium'
    }],
    candidateProposals:[{
      proposal:'候选新增 architecture.experiment 任务类型',
      problem:'复杂架构建议缺少最小试验载体。',
      validationPlan:'先用一条不改生产配置的本机任务验证输入、产物和失败恢复。',
      risks:['可能与现有治理任务重复。'],
      nonGoals:['本轮不注册该任务类型。']
    }],
    currentStateUnknowns:['飞书真人回归待完成。']
  };
  await assert.rejects(
    service.completePaperclipAssignment({
      ...input,
      factClaims:[{
        claim:'假设存在统一能力注册表。',
        evidenceRefs:['repo:agents/capability-registry.md']
      }]
    }),
    /引用了快照中不存在的对象/
  );
  await assert.rejects(
    service.completePaperclipAssignment({
      ...input,
      architectureJudgments:[{
        judgment:'判断建立在不存在的仓库路径上。',
        basisRefs:['repo:agents/capability-registry.md'],
        assumptions:[],
        confidence:'high'
      }]
    }),
    /引用了快照中不存在的对象/
  );
  const completed = await service.completePaperclipAssignment(input);
  const duplicate = await service.completePaperclipAssignment(input);

  assert.equal(completed.task.taskId, original.taskId);
  assert.equal(completed.task.status, 'succeeded');
  assert.equal(completed.task.artifactRefs[0].type, 'employee_role_report');
  assert.equal(completed.task.artifactRefs[0].data.evidenceValidation.valid, true);
  assert.equal(completed.task.artifactRefs[0].data.factClaims[0].evidenceRefs[0], 'agent:architect');
  assert.equal(completed.task.artifactRefs[0].data.architectureJudgments[0].confidence, 'medium');
  assert.match(completed.task.artifactRefs[0].data.candidateProposals[0].proposal, /architecture\.experiment/);
  assert.deepEqual(completed.task.artifactRefs[0].data.currentStateUnknowns, ['飞书真人回归待完成。']);
  assert.equal(completions.length, 1);
  assert.equal(duplicate.duplicate, true);
});

test('创建官 heartbeat 真实写入一次岗位草案并保持任务等待最终回报', async () => {
  const creator = {
    agentId:'creator',
    name:'创建官',
    status:'active',
    acceptedTaskTypes:['governance.agent-proposal'],
    interaction:{ runtime:'hermes-profile', directFeishu:'disabled' },
    executionOwner:'paperclip-hermes'
  };
  const identity = {
    issue:{ id:'paperclip-issue-creator', identifier:'AGE-CREATE', title:'创建微信聊天取件员', description:'复用本机 yichen skill。' },
    run:{ id:'paperclip-run-creator' },
    paperclipAgent:{ id:'paperclip-agent-creator', name:'创建官' },
    agentArmyId:'creator'
  };
  const governance = {
    async project() {
      return { status:'synced', paperclipIssueId:identity.issue.id, paperclipAssigneeAgentId:identity.paperclipAgent.id };
    },
    async verifyHermesAssignment() { return identity; }
  };
  const { service } = setup({ agents:[creator], governance });
  let executions = 0;
  service.executors.creator = {
    async execute(task, { proposalInput }) {
      executions += 1;
      assert.equal(proposalInput.agentId, 'wechat-chat-reader');
      assert.deepEqual(proposalInput.requestedCapabilities, ['wechat.local-vault.chat.read']);
      return {
        status:'succeeded',
        currentStage:'agent_proposal_submitted',
        artifactRefs:[{
          artifactId:'agent-proposal:proposal-wechat',
          taskId:task.taskId,
          type:'agent_proposal',
          validation:{ exists:true, readable:true, nonEmpty:true },
          data:{ proposalId:'proposal-wechat', status:'pending_approval', reviewSubmission:{ status:'submitted' }, nextAction:'needs_capability' }
        }]
      };
    }
  };
  const original = await service.create({
    title:'创建微信聊天取件员',
    taskType:'governance.agent-proposal',
    agentId:'creator'
  });
  const input = {
    issueId:identity.issue.id,
    runId:identity.run.id,
    paperclipAgentId:identity.paperclipAgent.id,
    agentArmyId:'creator',
    requestedOutcome:'按批准范围获取本机微信聊天',
    candidateName:'微信聊天取件员',
    agentId:'wechat-chat-reader',
    department:'信息服务部',
    responsibilities:['按批准范围导出聊天'],
    nonResponsibilities:['不读取密钥'],
    acceptedTaskTypes:['wechat.chat.export'],
    desiredSkills:['yichen-wechat-local-vault'],
    requestedCapabilities:['wechat.local-vault.chat.read'],
    acceptanceTitle:'使用脱敏夹具验证单会话导出'
  };
  const first = await service.executeAgentProposalAssignment(input);
  const duplicate = await service.executeAgentProposalAssignment(input);

  assert.equal(first.task.taskId, original.taskId);
  assert.equal(first.task.status, 'running');
  assert.equal(first.task.currentStage, 'agent_proposal_submitted');
  assert.equal(first.result.proposal.proposalId, 'proposal-wechat');
  assert.equal(first.result.recommendedCompletionStatus, 'succeeded');
  assert.equal(duplicate.duplicate, true);
  assert.equal(executions, 1);
});

test('技术专家 heartbeat 把 A君已验证并带回的修复明确建议为 succeeded', async () => {
  const technicalExpert = {
    agentId:'technical-expert',
    name:'技术专家',
    status:'active',
    acceptedTaskTypes:['operations.technical-repair'],
    interaction:{ runtime:'hermes-profile', directFeishu:'required' },
    executionOwner:'paperclip-hermes'
  };
  const identity = {
    issue:{ id:'paperclip-issue-tech', identifier:'AGE-TECH', title:'修复受控故障', description:'只修改允许文件。' },
    run:{ id:'paperclip-run-tech' },
    paperclipAgent:{ id:'paperclip-agent-tech', name:'技术专家' },
    agentArmyId:'technical-expert'
  };
  const governance = {
    async project() {
      return { status:'synced', paperclipIssueId:identity.issue.id, paperclipAssigneeAgentId:identity.paperclipAgent.id };
    },
    async verifyHermesAssignment() { return identity; }
  };
  const { service } = setup({ agents:[technicalExpert], governance });
  let executions = 0;
  service.executors['technical-expert'] = {
    async execute(task) {
      executions += 1;
      assert.equal(task.taskId, 'task-1');
      return {
        status:'running',
        currentStage:'repair_promoted_awaiting_record',
        execution:{
          executor:'technical-expert',
          outcome:'promoted',
          verification:{ testsPassed:true, recoveryVerified:true }
        },
        artifactRefs:[{
          type:'technical_repair_case',
          validation:{ exists:true, readable:true, nonEmpty:true },
          data:{ nextAction:'已安全带回主工程。' }
        }]
      };
    }
  };
  const original = await service.create({
    title:'修复受控故障',
    taskType:'operations.technical-repair',
    agentId:'technical-expert'
  });
  const input = {
    issueId:identity.issue.id,
    runId:identity.run.id,
    paperclipAgentId:identity.paperclipAgent.id,
    agentArmyId:'technical-expert'
  };
  const first = await service.executeTechnicalRepairAssignment(input);
  const duplicate = await service.executeTechnicalRepairAssignment(input);

  assert.equal(first.task.taskId, original.taskId);
  assert.equal(first.task.status, 'running');
  assert.equal(first.result.currentStage, 'repair_promoted_awaiting_record');
  assert.equal(first.result.verified, true);
  assert.equal(first.result.recommendedCompletionStatus, 'succeeded');
  assert.equal(duplicate.duplicate, true);
  assert.equal(executions, 1);
});

test('技术专家 heartbeat 不把外置源码候选误报为当前 release 已修复', async () => {
  const technicalExpert = {
    agentId:'technical-expert',
    name:'技术专家',
    status:'active',
    acceptedTaskTypes:['operations.technical-repair'],
    interaction:{ runtime:'hermes-profile', directFeishu:'required' },
    executionOwner:'paperclip-hermes',
  };
  const identity = {
    issue:{ id:'paperclip-issue-candidate', identifier:'AGE-CANDIDATE', title:'修复候选源码', description:'只修改允许文件。' },
    run:{ id:'paperclip-run-candidate' },
    paperclipAgent:{ id:'paperclip-agent-tech', name:'技术专家' },
    agentArmyId:'technical-expert',
  };
  const governance = {
    async project() {
      return {
        status:'synced',
        paperclipIssueId:identity.issue.id,
        paperclipAssigneeAgentId:identity.paperclipAgent.id,
      };
    },
    async verifyHermesAssignment() { return identity; },
  };
  const { service } = setup({ agents:[technicalExpert], governance });
  service.executors['technical-expert'] = {
    async execute() {
      return {
        status:'waiting_test',
        currentStage:'repair_candidate_awaiting_release',
        execution:{
          executor:'technical-expert',
          outcome:'candidate_promoted',
          verification:{
            testsPassed:true,
            recoveryVerified:true,
            candidateOnly:true,
            runningReleaseUpdated:false,
          },
        },
        artifactRefs:[{
          type:'technical_repair_case',
          validation:{ exists:true, readable:true, nonEmpty:true },
          data:{ nextAction:'生成并验证新的不可变 release。' },
        }],
      };
    },
  };
  await service.create({
    title:'修复候选源码',
    taskType:'operations.technical-repair',
    agentId:'technical-expert',
  });
  const result = await service.executeTechnicalRepairAssignment({
    issueId:identity.issue.id,
    runId:identity.run.id,
    paperclipAgentId:identity.paperclipAgent.id,
    agentArmyId:'technical-expert',
  });
  assert.equal(result.result.status, 'waiting_test');
  assert.equal(result.result.currentStage, 'repair_candidate_awaiting_release');
  assert.equal(result.result.verified, false);
  assert.equal(result.result.recommendedCompletionStatus, 'waiting_test');
});

test('运维官 heartbeat 只执行一次确定性健康检查并复用已验证报告', async () => {
  const operator = {
    agentId:'operator',
    name:'运维官',
    status:'active',
    acceptedTaskTypes:['operations.health-review'],
    interaction:{ runtime:'hermes-profile', directFeishu:'required' },
    executionOwner:'paperclip-hermes'
  };
  const identity = {
    issue:{ id:'paperclip-issue-health', identifier:'AGE-HEALTH', title:'A君定时本机巡检', description:'只检查登记服务。' },
    run:{ id:'paperclip-run-health' },
    paperclipAgent:{ id:'paperclip-agent-health', name:'运维官' },
    agentArmyId:'operator'
  };
  const governance = {
    async project() {
      return { status:'synced', paperclipIssueId:identity.issue.id, paperclipAssigneeAgentId:identity.paperclipAgent.id };
    },
    async verifyHermesAssignment() { return identity; }
  };
  const { service } = setup({ agents:[operator], governance });
  let executions = 0;
  service.executors.operator = {
    async execute(task) {
      executions += 1;
      return {
        status:'succeeded',
        currentStage:'health_report_ready',
        execution:{ executor:'operator', mode:'local_health_review', outcome:'healthy' },
        usage:{ tools:[{ id:'deterministic-local-health-probe', calls:2 }] },
        artifactRefs:[{
          artifactId:`health-report:${task.taskId}`,
          taskId:task.taskId,
          type:'health_report',
          validation:{ exists:true, readable:true, nonEmpty:true },
          data:{ overall:'healthy', components:[{ id:'ajun-runtime', status:'healthy' }] }
        }]
      };
    }
  };
  const original = await service.create({
    title:'A君定时本机巡检',
    taskType:'operations.health-review',
    agentId:'operator'
  });
  const input = {
    issueId:identity.issue.id,
    runId:identity.run.id,
    paperclipAgentId:identity.paperclipAgent.id,
    agentArmyId:'operator'
  };
  const first = await service.executeOperationsHealthAssignment(input);
  const duplicate = await service.executeOperationsHealthAssignment(input);

  assert.equal(first.task.taskId, original.taskId);
  assert.equal(first.result.verified, true);
  assert.equal(first.result.healthStatus, 'healthy');
  assert.equal(first.result.recommendedCompletionStatus, 'succeeded');
  assert.equal(duplicate.duplicate, true);
  assert.equal(executions, 1);
});

test('Hermes 员工阶段按 M5 Routine 映射调用各自既有受控执行器', async () => {
  const cases = [
    { agentId:'ajun', routineKey:'m5-topic', taskType:'content.campaign-topic' },
    { agentId:'intel-researcher', routineKey:'m5-research', taskType:'content.campaign-research' },
    { agentId:'xiaod', routineKey:'m5-assets', taskType:'content.campaign-assets' }
  ];
  for (const [index, entry] of cases.entries()) {
    const agent = {
      agentId:entry.agentId,
      name:entry.agentId,
      status:'active',
      acceptedTaskTypes:[entry.taskType],
      interaction:{ runtime:'hermes-profile', directFeishu:'required' },
      executionOwner:'paperclip-hermes'
    };
    const identity = {
      issue:{
        id:`paperclip-issue-employee-${index}`,
        identifier:`AGE-EMPLOYEE-${index}`,
        title:`执行 ${entry.routineKey}`,
        description:`[agent-army:m5:routine:${entry.routineKey}] 处理当前阶段；当前 Case 为 12345678-abcd-4abc-8abc-1234567890ab。`
      },
      run:{ id:`paperclip-run-employee-${index}` },
      paperclipAgent:{ id:`paperclip-agent-employee-${index}`, name:entry.agentId },
      agentArmyId:entry.agentId
    };
    const governance = { async verifyHermesAssignment() { return identity; } };
    const { service, records } = setup({ agents:[agent], governance });
    let executions = 0;
    service.executors[entry.agentId] = {
      async execute(task) {
        executions += 1;
        assert.equal(task.taskType, entry.taskType);
        assert.equal(task.assigneeAgentId, entry.agentId);
        assert.equal(task.input.context.paperclipRoutineKey, entry.routineKey);
        assert.equal(task.input.context.pipelineCaseId, '12345678-abcd-4abc-8abc-1234567890ab');
        return {
          status:'succeeded',
          currentStage:`${entry.routineKey}_ready`,
          artifactRefs:[{
            artifactId:`artifact-${entry.agentId}`,
            taskId:task.taskId,
            type:'m5_stage_result',
            validation:{ exists:true, readable:true, nonEmpty:true }
          }]
        };
      }
    };
    const input = {
      issueId:identity.issue.id,
      runId:identity.run.id,
      paperclipAgentId:identity.paperclipAgent.id,
      agentArmyId:identity.agentArmyId
    };
    const first = await service.executeEmployeeAssignment(input);
    const duplicate = await service.executeEmployeeAssignment(input);
    assert.equal(first.result.verified, true);
    assert.equal(first.result.recommendedCompletionStatus, 'succeeded');
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.result.currentStage, `${entry.routineKey}_ready`);
    assert.equal(executions, 1);
    assert.equal(records.tasks.length, 1);
  }
});

test('M5 员工阶段执行异常明确回报 failed，交给有上限的 Paperclip 恢复循环', async () => {
  const agent = {
    agentId:'ajun',
    name:'A君',
    status:'active',
    acceptedTaskTypes:['content.campaign-topic'],
    interaction:{ runtime:'hermes-profile', directFeishu:'required' },
    executionOwner:'paperclip-hermes',
  };
  const identity = {
    issue:{
      id:'paperclip-issue-m5-failed-topic',
      identifier:'AGE-M5-FAILED-TOPIC',
      title:'M5 / 选题',
      description:'[agent-army:m5:routine:m5-topic] 处理当前阶段；当前 Case 为 12345678-abcd-4abc-8abc-1234567890ab。',
    },
    run:{ id:'paperclip-run-m5-failed-topic' },
    paperclipAgent:{ id:'paperclip-agent-m5-failed-topic', name:'A君' },
    agentArmyId:'ajun',
  };
  const governance = { async verifyHermesAssignment() { return identity; } };
  const { service } = setup({ agents:[agent], governance });
  service.executors.ajun = {
    async execute() {
      throw new Error('受控 fixture 执行失败');
    },
  };

  const result = await service.executeEmployeeAssignment({
    issueId:identity.issue.id,
    runId:identity.run.id,
    paperclipAgentId:identity.paperclipAgent.id,
    agentArmyId:identity.agentArmyId,
  });

  assert.equal(result.result.status, 'failed');
  assert.equal(result.result.recommendedCompletionStatus, 'failed');
  assert.equal(result.result.error.retryable, true);
  assert.match(result.result.error.userMessage, /Paperclip 恢复策略/);
});

test('M5 平台子 Case 能继承当天父 Case 的已验证本地任务产物引用', async () => {
  const campaignCaseId = '11111111-1111-4111-8111-111111111111';
  const dayCaseId = '22222222-2222-4222-8222-222222222222';
  const platformCaseId = '33333333-3333-4333-8333-333333333333';
  const agent = {
    agentId:'content-creator',
    name:'小创',
    status:'active',
    acceptedTaskTypes:['content.platform-draft'],
    interaction:{ runtime:'hermes-profile', directFeishu:'required' },
    executionOwner:'paperclip-hermes',
  };
  const identity = {
    issue:{
      id:'paperclip-issue-platform-adapt',
      identifier:'AGE-M5-PLATFORM-ADAPT',
      title:'M5 / 平台适配',
      description:`[agent-army:m5:routine:m5-platform-adapt] 处理当前阶段；当前 Case 为 ${platformCaseId}。`,
      parentCaseId:'forged-parent-case',
    },
    run:{ id:'paperclip-run-platform-adapt' },
    paperclipAgent:{ id:'paperclip-agent-content-creator', name:'小创' },
    agentArmyId:'content-creator',
  };
  const cases = new Map([
    [platformCaseId, {
      id:platformCaseId,
      parentCaseId:dayCaseId,
      stageKey:'platform_adapt',
      fields:{ platform:'douyin', scheduledDate:'2026-07-31' },
    }],
    [dayCaseId, {
      id:dayCaseId,
      parentCaseId:campaignCaseId,
      stageKey:'render',
      fields:{ theme:'AI Agent 实战' },
    }],
    [campaignCaseId, {
      id:campaignCaseId,
      parentCaseId:null,
      stageKey:'campaign',
      fields:{},
    }],
  ]);
  const governance = {
    async verifyHermesAssignment() { return identity; },
    async getPipelineCase(caseId) { return cases.get(caseId) || null; },
    async assertCaseIssueLink(caseId, issueId) {
      assert.equal(caseId, platformCaseId);
      assert.equal(issueId, identity.issue.id);
    },
  };
  const { service, records } = setup({ agents:[agent], governance });
  records.tasks.push(
    {
      taskId:'task-parent-script',
      taskType:'content.video-script-package',
      status:'succeeded',
      createdAt:'2026-07-30T01:00:00.000Z',
      governance:{ paperclipIssueId:'issue-parent-script' },
      input:{ context:{ pipelineCaseId:dayCaseId } },
      artifactRefs:[{
        type:'video_script_package',
        validation:{ exists:true, readable:true, nonEmpty:true },
      }],
    },
    {
      taskId:'task-parent-render',
      taskType:'content.campaign-render',
      status:'succeeded',
      createdAt:'2026-07-30T02:00:00.000Z',
      governance:{ paperclipIssueId:'issue-parent-render' },
      input:{ context:{ pipelineCaseId:dayCaseId } },
      artifactRefs:[{
        type:'render_package',
        validation:{ exists:true, readable:true, nonEmpty:true },
      }],
    },
    {
      taskId:'task-sibling-day',
      taskType:'content.campaign-render',
      status:'succeeded',
      createdAt:'2026-07-30T03:00:00.000Z',
      governance:{ paperclipIssueId:'issue-sibling-day' },
      input:{ context:{ pipelineCaseId:'44444444-4444-4444-8444-444444444444' } },
      artifactRefs:[],
    },
  );

  const result = await service.getPaperclipAssignment({
    issueId:identity.issue.id,
    runId:identity.run.id,
    paperclipAgentId:identity.paperclipAgent.id,
    agentArmyId:identity.agentArmyId,
  });

  assert.deepEqual(
    result.task.input.context.sourceTaskIds,
    ['task-parent-script', 'task-parent-render'],
  );
  assert.equal(result.task.input.context.pipelineCase.id, platformCaseId);
  assert.equal(result.task.input.context.pipelineCase.parentCaseId, dayCaseId);
});

test('M5 Issue 与描述中的 Case 没有真实链接时，创建和更新任务分支都失败关闭', async () => {
  const caseId = '33333333-3333-4333-8333-333333333333';
  const issueId = 'paperclip-issue-link-mismatch';
  const agent = {
    agentId:'content-creator',
    name:'小创',
    status:'active',
    acceptedTaskTypes:['content.platform-draft'],
    interaction:{ runtime:'hermes-profile', directFeishu:'required' },
    executionOwner:'paperclip-hermes',
  };
  const identity = {
    issue:{
      id:issueId,
      identifier:'AGE-M5-LINK-MISMATCH',
      title:'M5 / 平台适配',
      description:`[agent-army:m5:routine:m5-platform-adapt] 当前 Case 为 ${caseId}。`,
    },
    run:{ id:'paperclip-run-link-mismatch' },
    paperclipAgent:{ id:'paperclip-agent-content-creator', name:'小创' },
    agentArmyId:'content-creator',
  };
  let checks = 0;
  const governance = {
    async verifyHermesAssignment() { return identity; },
    async getPipelineCase() {
      return { id:caseId, parentCaseId:'real-day-case', fields:{ platform:'douyin' } };
    },
    async assertCaseIssueLink() {
      checks += 1;
      throw new Error('Case 与 Issue 没有链接。');
    },
  };
  const { service, records } = setup({ agents:[agent], governance });
  const input = {
    issueId,
    runId:identity.run.id,
    paperclipAgentId:identity.paperclipAgent.id,
    agentArmyId:identity.agentArmyId,
  };
  await assert.rejects(() => service.getPaperclipAssignment(input), /没有链接/);
  records.tasks.push({
    taskId:'existing-link-mismatch',
    taskType:'content.platform-draft',
    status:'running',
    governance:{ paperclipIssueId:issueId },
    input:{ context:{} },
  });
  await assert.rejects(() => service.getPaperclipAssignment(input), /没有链接/);
  assert.equal(checks, 2);
});

test('系统控制器 Routine 拒绝创建 Hermes 员工任务信封', async () => {
  const agent = {
    agentId:'office-assistant',
    name:'小办',
    status:'active',
    acceptedTaskTypes:['content.campaign-metrics'],
    interaction:{ runtime:'hermes-profile', directFeishu:'required' },
    executionOwner:'paperclip-hermes'
  };
  const identity = {
    issue:{
      id:'paperclip-issue-system-controller',
      title:'指标回流',
      description:'[agent-army:m5:routine:m5-metrics] 应由确定性控制器执行。'
    },
    run:{ id:'paperclip-run-system-controller' },
    paperclipAgent:{ id:'paperclip-agent-system-controller', name:'小办' },
    agentArmyId:'office-assistant'
  };
  const governance = { async verifyHermesAssignment() { return identity; } };
  const { service, records } = setup({ agents:[agent], governance });
  await assert.rejects(
    () => service.getPaperclipAssignment({
      issueId:identity.issue.id,
      runId:identity.run.id,
      paperclipAgentId:identity.paperclipAgent.id,
      agentArmyId:identity.agentArmyId
    }),
    /确定性控制器执行/,
  );
  assert.equal(records.tasks.length, 0);
});

test('M5 插件回执通过专用真实性门禁后才写入任务产物', async () => {
  const { service, records } = setup();
  records.tasks.push({
    taskId:'task-m5-voice',
    taskType:'content.campaign-voice',
    status:'running',
    currentStage:'paperclip_hermes_running',
    artifactRefs:[],
    input:{
      context:{
        paperclipRoutineKey:'m5-voice',
        pipelineCaseId:'12345678-abcd-4abc-8abc-1234567890ab',
      },
    },
  });
  const result = {
    toolId:'agent-army.content-autonomy:stepfun-tts',
    pluginId:'agent-army.content-autonomy',
    model:'stepaudio-2.5-tts',
    voice:'official-voice',
    speed:1,
    relativePath:'campaigns/test/voice.mp3',
    checksum:'a'.repeat(64),
    bytes:4096,
    actionId:'task-m5-voice:tts:v1',
    operation:'tts',
    callRecord:{
      actionId:'task-m5-voice:tts:v1',
      operation:'tts',
      model:'stepaudio-2.5-tts',
      promptChecksum:`sha256:${'b'.repeat(64)}`,
    },
    costCommit:{
      status:'confirmed',
      costEventId:'11111111-1111-4111-8111-111111111111',
      costEvent:{ provider:'stepfun', costCents:1 },
    },
  };
  const first = await service.recordM5StageExecution('task-m5-voice', result);
  const duplicate = await service.recordM5StageExecution('task-m5-voice', result);
  assert.equal(first.artifact.type, 'voice_package');
  assert.equal(first.artifact.data.relativePath, 'campaigns/test/voice.mp3');
  assert.equal(first.artifact.validation.pluginReceiptVerified, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(records.tasks[0].artifactRefs.length, 1);
});

test('M5 视觉桥只把当前Case参数和短期Run身份交给单用途Provider callback', async () => {
  const calls = [];
  const { service } = setup({
    m5ProviderVision:async (input) => {
      calls.push(input);
      return { projectId:'22222222-2222-4222-8222-222222222222', receipt:{ status:'fixture' } };
    },
  });
  const callback = service.m5ProviderVisionCallback({
    assignment:{ pipelineCaseId:'11111111-1111-4111-8111-111111111111' },
    paperclipApiKey:'short-lived-paperclip-run-jwt',
  });
  assert.equal(typeof callback, 'function');
  const result = await callback({
    actionId:'11111111-1111-4111-8111-111111111111:vision:aaaaaaaaaaaaaaaa',
    relativePath:'campaigns/case/frame.png',
    prompt:'只分析可见事实。',
  });
  assert.equal(result.receipt.status, 'fixture');
  assert.deepEqual(calls, [{
    caseId:'11111111-1111-4111-8111-111111111111',
    parameters:{
      actionId:'11111111-1111-4111-8111-111111111111:vision:aaaaaaaaaaaaaaaa',
      relativePath:'campaigns/case/frame.png',
      prompt:'只分析可见事实。',
    },
    authentication:{
      requireRunAuthentication:true,
      paperclipApiKey:'short-lived-paperclip-run-jwt',
    },
  }]);
  assert.equal(Object.hasOwn(calls[0], 'toolId'), false);
  assert.throws(
    () => callback({
      actionId:'11111111-1111-4111-8111-111111111111:vision:bbbbbbbbbbbbbbbb',
      relativePath:'campaigns/case/frame.png',
      prompt:'再次分析。',
    }),
    /已使用/,
  );
  assert.equal(calls.length, 1);
  for (const parameters of [
    {
      actionId:'11111111-1111-4111-8111-111111111111:vision:cccccccccccccccc',
      relativePath:'campaigns/case/frame.png',
      prompt:'分析。',
      toolId:'agent-army.content-autonomy:stepfun-vision',
    },
    {
      actionId:'other-case:vision:cccccccccccccccc',
      relativePath:'campaigns/case/frame.png',
      prompt:'分析。',
    },
    {
      actionId:'11111111-1111-4111-8111-111111111111:vision:cccccccccccccccc',
      relativePath:'../frame.png',
      prompt:'分析。',
    },
  ]) {
    const rejected = service.m5ProviderVisionCallback({
      assignment:{ pipelineCaseId:'11111111-1111-4111-8111-111111111111' },
      paperclipApiKey:'short-lived-paperclip-run-jwt',
    });
    assert.throws(() => rejected(parameters), /只接受|受控范围/);
  }
  assert.equal(calls.length, 1);
  assert.equal(service.m5ProviderVisionCallback({
    assignment:{ pipelineCaseId:'11111111-1111-4111-8111-111111111111' },
    paperclipApiKey:'',
  }), null);
});

test('M5 画面分析旧包、伪回执、跨Project和坏哈希不能成功或写Work Product', async () => {
  const projectId = '22222222-2222-4222-8222-222222222222';
  const invalidArtifacts = [
    {
      ...m5VisualArtifactFixture(projectId),
      data:{ schemaVersion:'agent.army/visual-analysis-package/v1', insights:[{
        finding:'旧版包',
        frameRef:'frame-001',
        timestamp:'00:00:03',
        evidenceKind:'stepfun_vision_frame',
      }] },
    },
    m5VisualArtifactFixture(projectId, {
      providerReceipt:{ callRecord:{ actionId:'forged-action' } },
    }),
    m5VisualArtifactFixture('44444444-4444-4444-8444-444444444444'),
    m5VisualArtifactFixture(projectId, {
      providerReceipt:{ sourceChecksum:'sha256:bad' },
    }),
  ];
  for (const artifact of invalidArtifacts) {
    const fixture = await m5VisualCompletionFixture({ projectId, artifact });
    await assert.rejects(
      () => fixture.service.completePaperclipAssignment({
        ...fixture.input,
        status:'succeeded',
        summary:'尝试完成画面分析。',
      }),
      /不能回报 succeeded/,
    );
    assert.equal(fixture.records.tasks[0].status, 'running');
    assert.equal(fixture.outputs.length, 0);
    assert.equal(fixture.completions.length, 0);
  }
});

test('M5 画面分析有效confirmed包按当前Project写入唯一Work Product', async () => {
  const projectId = '22222222-2222-4222-8222-222222222222';
  const fixture = await m5VisualCompletionFixture({
    projectId,
    artifact:m5VisualArtifactFixture(projectId),
  });
  const completed = await fixture.service.completePaperclipAssignment({
    ...fixture.input,
    status:'succeeded',
    summary:'已完成受控画面分析。',
  });
  assert.equal(completed.task.status, 'succeeded');
  assert.equal(fixture.outputs.length, 1);
  assert.equal(fixture.outputs[0].metadata.kind, 'VisualAnalysisPackage');
  assert.equal(fixture.completions.length, 1);
});

test('M5 画面分析已有坏Work Product不能直接replay或创建覆盖', async () => {
  const projectId = '22222222-2222-4222-8222-222222222222';
  const fixture = await m5VisualCompletionFixture({
    projectId,
    artifact:m5VisualArtifactFixture(projectId),
  });
  await fixture.service.completePaperclipAssignment({
    ...fixture.input,
    status:'succeeded',
    summary:'首次写入有效画面分析。',
  });
  fixture.outputs[0].metadata.artifact.providerReceipt.sourceChecksum = 'sha256:bad';
  await assert.rejects(
    () => fixture.service.completePaperclipAssignment({
      ...fixture.input,
      status:'succeeded',
      summary:'尝试重放已经漂移的 Work Product。',
    }),
    /Work Product.*漂移/,
  );
  assert.equal(fixture.outputs.length, 1);
  assert.equal(fixture.completions.length, 1);
});

test('M5 插件回执拒绝伪造文件哈希，机器审核拒绝单一 media-validate 冒充七项审核', async () => {
  const { service, records } = setup();
  records.tasks.push({
    taskId:'task-m5-render',
    taskType:'content.campaign-render',
    status:'running',
    artifactRefs:[],
    input:{ context:{ paperclipRoutineKey:'m5-render', pipelineCaseId:'case-render' } },
  }, {
    taskId:'task-m5-review',
    taskType:'content.campaign-machine-review',
    status:'running',
    artifactRefs:[],
    input:{ context:{ paperclipRoutineKey:'m5-machine-review', pipelineCaseId:'case-review' } },
  });
  await assert.rejects(
    () => service.recordM5StageExecution('task-m5-render', {
      toolId:'agent-army.content-autonomy:remotion-render',
      pluginId:'agent-army.content-autonomy',
      composition:'M5Master',
      outputPath:'campaigns/test/master.mp4',
      checksum:'not-a-hash',
      bytes:1,
    }),
    /缺少真实 MP4/,
  );
  await assert.rejects(
    () => service.recordM5StageExecution('task-m5-review', {
      toolId:'agent-army.content-autonomy:media-validate',
      pluginId:'agent-army.content-autonomy',
      passed:true,
      errors:[],
      relativePath:'campaigns/test/master.mp4',
      durationSeconds:45,
    }),
    /单一 media-validate 回执不能冒充完整审核/,
  );
  const passedReview = {
    status:'passed',
    checks:{
      facts:true,
      privacy:true,
      rights:true,
      media:true,
      claims:true,
      grantScope:true,
      duplicate:true,
    },
  };
  await assert.rejects(
    () => service.recordM5StageExecution('task-m5-review', {
      toolId:'agent-army.content-autonomy:media-validate',
      pluginId:'agent-army.content-autonomy',
      artifact:{
        type:'machine_review_report',
        data:{ reviewReport:passedReview },
        validation:{ exists:true, readable:true, nonEmpty:true },
      },
    }),
    /缺少已校验的固定产物包/,
  );
  const accepted = await service.recordM5StageExecution('task-m5-review', {
    toolId:'agent-army.content-autonomy:media-validate',
    pluginId:'agent-army.content-autonomy',
      artifact:{
        type:'machine_review_report',
        validation:{ exists:true, readable:true, nonEmpty:true },
        data:{
        reviewReport:{
          ...passedReview,
          evidence:{
            artifactPackage:{
              manifestPath:'campaigns/test/package/artifact-manifest.json',
              manifestChecksum:`sha256:${'e'.repeat(64)}`,
              requiredArtifacts:[
                'master.mp4',
                'douyin.mp4',
                'xiaohongshu.mp4',
                'douyin.copy.json',
                'xiaohongshu.copy.json',
                'cover.png',
                'sources.json',
                'review.json',
                'lineage.json',
              ],
            },
          },
        },
      },
    },
  });
  assert.equal(
    accepted.artifact.data.reviewReport.evidence.artifactPackage.requiredArtifacts.length,
    9,
  );
  assert.equal(records.tasks[0].artifactRefs.length, 0);
  assert.equal(records.tasks[1].artifactRefs.length, 1);
});

test('四岗执行桥拒绝 Routine 岗位错配，且不会调用岗位执行器', async () => {
  const agent = {
    agentId:'office-assistant',
    name:'小办',
    status:'active',
    acceptedTaskTypes:['content.campaign-metrics'],
    interaction:{ runtime:'hermes-profile', directFeishu:'required' },
    executionOwner:'paperclip-hermes'
  };
  const identity = {
    issue:{
      id:'paperclip-issue-wrong-role',
      title:'错误指派',
      description:'[agent-army:m5:routine:m5-research] 不应由小办执行。'
    },
    run:{ id:'paperclip-run-wrong-role' },
    paperclipAgent:{ id:'paperclip-agent-wrong-role', name:'小办' },
    agentArmyId:'office-assistant'
  };
  const governance = { async verifyHermesAssignment() { return identity; } };
  const { service } = setup({ agents:[agent], governance });
  let executions = 0;
  service.executors['office-assistant'] = { async execute() { executions += 1; } };
  await assert.rejects(
    () => service.executeEmployeeAssignment({
      issueId:identity.issue.id,
      runId:identity.run.id,
      paperclipAgentId:identity.paperclipAgent.id,
      agentArmyId:identity.agentArmyId
    }),
    /不属于当前岗位/
  );
  assert.equal(executions, 0);
});

test('小拆 heartbeat 通过受控执行桥写回真实分析产物且重复调用幂等', async () => {
  const analyst = {
    agentId:'video-content-analyst',
    name:'小拆',
    status:'active',
    acceptedTaskTypes:['content.video-benchmark-analysis'],
    interaction:{ runtime:'hermes-profile', directFeishu:'disabled' },
    executionOwner:'paperclip-hermes'
  };
  const identity = {
    issue:{ id:'paperclip-issue-content', identifier:'AGE-CONTENT', title:'正式拆解', description:'引用确认稿。' },
    run:{ id:'paperclip-run-content' },
    paperclipAgent:{ id:'paperclip-agent-content', name:'小拆' },
    agentArmyId:'video-content-analyst'
  };
  const governance = {
    async project() {
      return { status:'synced', paperclipIssueId:identity.issue.id, paperclipAssigneeAgentId:identity.paperclipAgent.id };
    },
    async verifyHermesAssignment() { return identity; }
  };
  const { service, records } = setup({ agents:[analyst], governance });
  let executions = 0;
  service.executors['video-content-analyst'] = {
    async execute(task) {
      executions += 1;
      return {
        status:'succeeded',
        currentStage:'fast_analysis_ready',
        usage:{
          model:{ provider:'openai-codex', model:'gpt-5.6-terra', inputTokens:120, outputTokens:30, apiCalls:1, cost:{ amount:0, currency:'USD' } },
          tools:[{ id:'fast-analysis-write', name:'正式拆解', calls:1 }]
        },
        artifactRefs:[{
          artifactId:`video-analysis:${task.taskId}`,
          taskId:task.taskId,
          type:'video_content_analysis_report',
          title:'正式拆解',
          validation:{ exists:true, readable:true, nonEmpty:true, semanticValidationPassed:true },
          data:{ evidenceMode:'formal', modules:[{ name:'开场钩子' }] }
        }]
      };
    }
  };
  await service.create({
    title:'正式拆解',
    taskType:'content.video-benchmark-analysis',
    agentId:'video-content-analyst',
    evidenceMode:'formal',
    depth:'full'
  });
  const input = { issueId:identity.issue.id, runId:identity.run.id, paperclipAgentId:identity.paperclipAgent.id, agentArmyId:identity.agentArmyId };
  const first = await service.executeContentGrowthAssignment(input);
  const duplicate = await service.executeContentGrowthAssignment(input);
  assert.equal(first.result.verified, true);
  assert.equal(first.result.recommendedCompletionStatus, 'succeeded');
  assert.equal(duplicate.duplicate, true);
  assert.equal(executions, 1);
  const persisted = records.tasks.find((task) => task.taskId === first.task.taskId);
  assert.equal(persisted.usage.model.status, 'reported');
  assert.equal(persisted.usage.model.apiCalls, 1);
  assert.deepEqual(persisted.usage.cost, { status:'reported', amount:0, currency:'USD' });
});

test('长视频拆解按 240 秒以内分段等待并复用同一个后台执行', async () => {
  const analyst = {
    agentId:'video-content-analyst',
    name:'小拆',
    status:'active',
    acceptedTaskTypes:['content.video-benchmark-analysis'],
    interaction:{ runtime:'hermes-profile', directFeishu:'disabled' },
    executionOwner:'paperclip-hermes'
  };
  const identity = {
    issue:{ id:'paperclip-issue-async-content', identifier:'AGE-ASYNC-CONTENT', title:'长视频正式拆解', description:'引用确认稿。' },
    run:{ id:'paperclip-run-async-content' },
    paperclipAgent:{ id:'paperclip-agent-async-content', name:'小拆' },
    agentArmyId:'video-content-analyst'
  };
  const governance = {
    async project() {
      return { status:'synced', paperclipIssueId:identity.issue.id, paperclipAssigneeAgentId:identity.paperclipAgent.id };
    },
    async verifyHermesAssignment() { return identity; }
  };
  const { service, records } = setup({ agents:[analyst], governance, contentGrowthWaitMs:5 });
  let executions = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  service.executors['video-content-analyst'] = {
    async execute(task) {
      executions += 1;
      await gate;
      return {
        status:'succeeded',
        currentStage:'full_analysis_ready',
        artifactRefs:[{
          artifactId:`video-analysis:${task.taskId}`,
          taskId:task.taskId,
          type:'video_content_analysis_report',
          title:'长视频正式拆解',
          validation:{ exists:true, readable:true, nonEmpty:true, semanticValidationPassed:true },
          data:{ evidenceMode:'formal', generationMode:'hermes_advisor', modules:[{ name:'基本信息' }] }
        }]
      };
    }
  };
  await service.create({
    title:'长视频正式拆解',
    taskType:'content.video-benchmark-analysis',
    agentId:'video-content-analyst',
    evidenceMode:'formal',
    depth:'full'
  });
  const input = { issueId:identity.issue.id, runId:identity.run.id, paperclipAgentId:identity.paperclipAgent.id, agentArmyId:identity.agentArmyId };
  const first = await service.executeContentGrowthAssignment(input);
  assert.equal(first.result.status, 'running');
  assert.equal(first.result.continuePolling, true);
  assert.equal(first.result.recommendedCompletionStatus, 'running');
  assert.equal(executions, 1);

  release();
  await new Promise((resolve) => setImmediate(resolve));
  const second = await service.executeContentGrowthAssignment(input);
  assert.equal(second.result.verified, true);
  assert.equal(second.result.recommendedCompletionStatus, 'succeeded');
  assert.equal(executions, 1);
  const persisted = records.tasks.find((task) => task.taskId === second.task.taskId);
  assert.equal(persisted.artifactRefs.length, 1);
  assert.equal(persisted.execution.contentGrowth.state, 'settled');
});

test('正式完整拆解的语义兜底不能冒充成功，迟到产物不能覆盖 Hermes 终态', async () => {
  const analyst = {
    agentId:'video-content-analyst',
    name:'小拆',
    status:'active',
    acceptedTaskTypes:['content.video-benchmark-analysis'],
    interaction:{ runtime:'hermes-profile', directFeishu:'disabled' },
    executionOwner:'paperclip-hermes'
  };
  const identity = {
    issue:{ id:'paperclip-issue-late-content', identifier:'AGE-LATE-CONTENT', title:'正式拆解', description:'引用确认稿。' },
    run:{ id:'paperclip-run-late-content' },
    paperclipAgent:{ id:'paperclip-agent-late-content', name:'小拆' },
    agentArmyId:'video-content-analyst'
  };
  const governance = {
    async project() {
      return { status:'synced', paperclipIssueId:identity.issue.id, paperclipAssigneeAgentId:identity.paperclipAgent.id };
    },
    async verifyHermesAssignment() { return identity; }
  };
  const { service, records } = setup({ agents:[analyst], governance });
  service.executors['video-content-analyst'] = {
    async execute(task) {
      const live = records.tasks.find((item) => item.taskId === task.taskId);
      live.status = 'failed';
      live.currentStage = 'paperclip_hermes_failed';
      live.error = { code:'paperclip_hermes_reported_failure', message:'Hermes 已超时。' };
      return {
        status:'succeeded',
        currentStage:'full_analysis_ready',
        artifactRefs:[{
          artifactId:`video-analysis:${task.taskId}`,
          taskId:task.taskId,
          type:'video_content_analysis_report',
          title:'兜底拆解',
          validation:{ exists:true, readable:true, nonEmpty:true, semanticValidationPassed:false },
          data:{ evidenceMode:'formal', generationMode:'deterministic_fallback', modules:[{ name:'基本信息' }] }
        }]
      };
    }
  };
  await service.create({
    title:'正式拆解',
    taskType:'content.video-benchmark-analysis',
    agentId:'video-content-analyst',
    evidenceMode:'formal',
    depth:'full'
  });
  const input = { issueId:identity.issue.id, runId:identity.run.id, paperclipAgentId:identity.paperclipAgent.id, agentArmyId:identity.agentArmyId };
  const result = await service.executeContentGrowthAssignment(input);
  const persisted = records.tasks.find((task) => task.taskId === result.task.taskId);

  assert.equal(result.result.verified, false);
  assert.equal(result.result.recommendedCompletionStatus, 'waiting_test');
  assert.equal(persisted.status, 'failed');
  assert.equal(persisted.error.code, 'paperclip_hermes_reported_failure');
  assert.equal(persisted.artifactRefs[0].validation.semanticValidationPassed, false);
});
test('相同飞书幂等键直接返回原任务，不会二次执行 Agent', async () => {
  const operator = { agentId:'operator', name:'运维官', status:'active', acceptedTaskTypes:['operations.health-review'] };
  let executed = 0;
  const { service, records } = setup({ agents:[operator] });
  service.executors.operator = { async execute() { executed += 1; return { status:'succeeded', currentStage:'health_report_ready', artifactRefs:[] }; } };
  const input = { title:'检查系统状态', taskType:'operations.health-review', idempotencyKey:'feishu:message-42', source:{ channel:'feishu', eventRef:'feishu:message-42' } };
  const first = await service.create(input); const duplicate = await service.create(input);
  assert.equal(first.taskId, duplicate.taskId);
  assert.equal(records.tasks.length, 1);
  assert.equal(executed, 1);
});
test('已启用的运维官会完成低风险健康任务并留下报告', async () => {
  const operator = { agentId:'operator', name:'运维官', status:'active', acceptedTaskTypes:['operations.health-review'] };
  const governance = { async project() { return { status: 'synced', paperclipIssueId: 'issue-1' }; }, async update(task) { return task.governance; }, async health() { return { status: 'ready', version: 'test' }; } };
  const executor = { async execute(task) { return { status:'succeeded', currentStage:'health_report_ready', artifactRefs:[{ taskId:task.taskId, type:'health_report' }] }; } };
  const { service } = setup({ agents:[operator], governance }); service.executors.operator = executor;
  const task = await service.create({ title:'检查本机健康', taskType:'operations.health-review' });
  assert.equal(task.status, 'succeeded'); assert.equal(task.artifactRefs[0].type, 'health_report');
});
test('普通员工执行报错后自动交给恢复链路，原任务不会一直卡在处理中', async () => {
  const reporter = { agentId:'public-reporter', name:'公开资料报告员', status:'active', acceptedTaskTypes:['report.public-material'], runtime:{ kind:'proposal-public-report' } };
  const failures = [];
  const { service } = setup({ agents:[reporter], onTaskFailed: async (task) => { failures.push(task); } });
  service.fallbackExecutor = { supports(){ return true; }, async execute(){ throw new Error('公开网页暂时无法读取'); } };
  const task = await service.create({ title:'整理公开网页', taskType:'report.public-material', sourceUrl:'https://example.com/article' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(task.status, 'failed');
  assert.equal(task.error.code, 'executor_failed');
  assert.equal(task.recovery.coordination.status, 'pending');
  assert.equal((await service.notificationStatus(task.taskId)).status, 'recovery_pending');
  assert.deepEqual(failures.map((item) => item.taskId), [task.taskId]);
});
test('执行器声明可重试故障时保留错误代码和可重试标记，供运维官安全决策', async () => {
  const reporter = { agentId:'public-reporter', name:'公开资料报告员', status:'active', acceptedTaskTypes:['report.public-material'], runtime:{ kind:'proposal-public-report' } };
  const { service } = setup({ agents:[reporter], onTaskFailed:async () => {} });
  service.fallbackExecutor = { supports(){ return true; }, async execute(){
    const error = new Error('受控瞬时故障');
    error.code = 'controlled_public_report_failure';
    error.category = 'transient';
    error.retryable = true;
    throw error;
  } };
  const task = await service.create({ title:'受控恢复验收', taskType:'report.public-material', sourceUrl:'https://example.com' });
  assert.equal(task.status, 'failed');
  assert.equal(task.error.code, 'controlled_public_report_failure');
  assert.equal(task.error.category, 'transient');
  assert.equal(task.error.retryable, true);
});
test('恢复任务和技术修复任务失败时不会反复自动创建新的修理任务', async () => {
  const operator = { agentId:'operator', name:'运维官', status:'active', acceptedTaskTypes:['operations.failure-recovery'] };
  const failures = [];
  const { service } = setup({ agents:[operator], onTaskFailed: async (task) => { failures.push(task); } });
  service.executors.operator = { async execute(){ throw new Error('恢复检查本身失败'); } };
  const task = await service.create({ title:'处理任务故障', taskType:'operations.failure-recovery' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(task.status, 'failed');
  assert.deepEqual(failures, []);
});
test('任务登记会保留恢复上下文和恢复次数，供治理员工协作', async () => {
  const operator = { agentId:'operator', name:'运维官', status:'active', acceptedTaskTypes:['operations.failure-recovery'] };
  const { service } = setup({ agents:[operator] });
  service.executors.operator = { async execute(task) { assert.equal(task.input.context.failedTaskId, 'failed-1'); return { status:'succeeded', currentStage:'recovery_decision_ready', artifactRefs:[] }; } };
  const task = await service.create({ title:'处理任务故障', taskType:'operations.failure-recovery', context:{ failedTaskId:'failed-1' }, recovery:{ rootTaskId:'failed-1', attempt:1 } });
  assert.deepEqual(task.input.context, { failedTaskId:'failed-1' });
  assert.deepEqual(task.recovery, { rootTaskId:'failed-1', attempt:1 });
});
test('已启用岗位不会显示为等待激活', async () => {
  const operator = { agentId:'operator', name:'运维官', status:'active', acceptedTaskTypes:['operations.health-review'] };
  const { service } = setup({ agents:[operator] }); const task = await service.create({ title:'健康检查', taskType:'operations.health-review' });
  assert.equal(task.routing.reason, '已路由到已启用的本地执行器。');
});
test('小D登记完成后才启动状态跟踪，缺少链接不会调用下游', async () => {
  const xiaod = { agentId:'xiaod', name:'小D', status:'active', acceptedTaskTypes:['media.transcribe-and-refine'] };
  let executes = 0; let observed;
  const executor = { async execute() { executes += 1; return { status:'needs_input', currentStage:'source_url_required' }; }, observe(task) { observed = task; } };
  const { service } = setup({ agents:[xiaod] }); service.executors.xiaod = executor;
  const task = await service.create({ title:'整理视频', taskType:'media.transcribe-and-refine' });
  assert.equal(task.status, 'needs_input'); assert.equal(executes, 1); assert.equal(observed, undefined);
});
test('A君会留下任务接收记录', async () => {
  const coordinator = { agentId:'ajun', name:'A君', status:'active', acceptedTaskTypes:['army.intake'] };
  const executor = { async execute(task) { return { status:'succeeded', currentStage:'intake_record_ready', artifactRefs:[{ taskId:task.taskId, type:'task_intake_record' }] }; } };
  const { service } = setup({ agents:[coordinator] }); service.executors.ajun = executor;
  const task = await service.create({ title:'先帮我判断怎么推进', taskType:'army.intake' });
  assert.equal(task.status, 'succeeded'); assert.equal(task.artifactRefs[0].type, 'task_intake_record');
});
test('默认接收高风险描述只生成审核建议，不创建审批或外部动作', async () => {
  const coordinator = { agentId:'ajun', name:'A君', status:'active', acceptedTaskTypes:['army.intake'] };
  const { service, records } = setup({ agents:[coordinator] });
  service.executors.ajun = { async execute(task) { return { status:'succeeded', currentStage:'intake_record_ready', artifactRefs:[{ taskId:task.taskId, type:'task_intake_record', data:{ recommendedTaskType:'governance.approval-review', recommendedAgentId:'reviewer', externalActionStarted:false } }] }; } };
  const task = await service.create({ title:'审核发布范围', taskType:'army.intake' });
  assert.equal(task.status, 'succeeded'); assert.equal(records.approvals.length, 0); assert.equal(task.artifactRefs[0].data.recommendedAgentId, 'reviewer');
});
test('审核任务可产生审查结论，但不创建第二个审批闸门', async () => {
  const reviewer = { agentId:'reviewer', name:'审核官', status:'active', acceptedTaskTypes:['governance.approval-review'] };
  const executor = { async execute(task) { return { status:'succeeded', currentStage:'review_report_ready', artifactRefs:[{ taskId:task.taskId, type:'review_report' }] }; } };
  const { service, records } = setup({ agents:[reviewer] }); service.executors.reviewer = executor;
  const task = await service.create({ title:'审核发布范围', description:'只审内部草稿，今天有效。', taskType:'governance.approval-review' });
  assert.equal(task.status, 'succeeded'); assert.equal(task.artifactRefs[0].type, 'review_report'); assert.equal(records.approvals.length, 0);
});
test('已启用架构师会生成评估结果，但不触发审批或外部执行', async () => {
  const architect = { agentId:'architect', name:'架构师', status:'active', acceptedTaskTypes:['governance.architecture-review'] };
  const executor = { async execute(task) { return { status:'succeeded', currentStage:'architecture_review_ready', artifactRefs:[{ taskId:task.taskId, type:'architecture_review' }] }; } };
  const { service, records } = setup({ agents:[architect] }); service.executors.architect = executor;
  const task = await service.create({ title:'评估当前岗位能力', taskType:'governance.architecture-review' });
  assert.equal(task.status, 'succeeded'); assert.equal(task.artifactRefs[0].type, 'architecture_review'); assert.equal(records.approvals.length, 0);
});
test('可按已完成的接收建议创建同一输入的子任务', async () => {
  const coordinator = { agentId:'ajun', name:'A君', status:'active', acceptedTaskTypes:['army.intake'] };
  const operator = { agentId:'operator', name:'运维官', status:'active', acceptedTaskTypes:['operations.health-review'] };
  const { service } = setup({ agents:[coordinator, operator] });
  service.executors.ajun = { async execute(task) { return { status:'succeeded', currentStage:'intake_record_ready', artifactRefs:[{ taskId:task.taskId, type:'task_intake_record', data:{ recommendedTaskType:'operations.health-review', recommendedAgentId:'operator' } }] }; } };
  service.executors.operator = { async execute(task) { return { status:'succeeded', currentStage:'health_report_ready', artifactRefs:[{ taskId:task.taskId, type:'health_report' }] }; } };
  const intake = await service.create({ title:'检查本机健康', taskType:'army.intake' }); const next = await service.continueFromRecommendation(intake.taskId);
  assert.equal(next.parentTaskId, intake.taskId); assert.equal(next.taskType, 'operations.health-review'); assert.equal(next.assigneeAgentId, 'operator'); assert.equal(next.status, 'succeeded');
});

test('自动能力评估会把 AI 已理解的目标带给架构师，不要求用户重复说明', async () => {
  const coordinator = { agentId:'ajun', name:'A君', status:'active', acceptedTaskTypes:['army.intake'] };
  const architect = { agentId:'architect', name:'架构师', status:'active', acceptedTaskTypes:['governance.architecture-review'] };
  const { service } = setup({ agents:[coordinator, architect] });
  service.executors.ajun = { async execute(task) { return { status:'succeeded', currentStage:'intake_record_ready', artifactRefs:[{ taskId:task.taskId, type:'task_intake_record', data:{ recommendedTaskType:'governance.architecture-review', recommendedAgentId:'architect', autoContinue:true, advisor:{ understanding:'研究竞品', deliverable:'竞品行动清单', missing:['竞品名称'] } } }] }; } };
  service.executors.architect = { async execute(task) { return { status:'succeeded', currentStage:'architecture_review_ready', artifactRefs:[{ taskId:task.taskId, type:'architecture_review', data:{ context:task.input.context } }] }; } };
  const intake = await service.create({ title:'研究竞品', taskType:'army.intake' });
  const next = await service.continueFromRecommendation(intake.taskId);
  assert.equal(next.input.context.autoCapabilityAssessment, true);
  assert.equal(next.input.context.intakeAdvisor.deliverable, '竞品行动清单');
});
test('小D建议缺少素材链接时不能直接继续', async () => {
  const { service, records } = setup(); records.tasks.push({ taskId:'task-1', status:'succeeded', input:{ title:'整理视频', description:'', sourceUrl:null }, artifactRefs:[{ type:'task_intake_record', data:{ recommendedTaskType:'media.transcribe-and-refine', recommendedAgentId:'xiaod' } }] });
  await assert.rejects(() => service.continueFromRecommendation('task-1'), /公开素材链接/);
});
test('默认接收入口会保留用户粘贴在描述中的公开链接', async () => {
  const coordinator = { agentId:'ajun', name:'A君', status:'active', acceptedTaskTypes:['army.intake'] };
  const { service } = setup({ agents:[coordinator] }); service.executors.ajun = { async execute() { return { status:'succeeded', currentStage:'intake_record_ready', artifactRefs:[] }; } };
  const task = await service.create({ title:'整理这条视频', description:'请处理 https://www.youtube.com/watch?v=example。', taskType:'army.intake' });
  assert.equal(task.input.sourceUrl, 'https://www.youtube.com/watch?v=example');
});
test('任务登记会保留同一请求中的多条公开链接，供公开资料报告员逐条处理', async () => {
  const reporter = { agentId:'public-reporter', name:'公开资料报告员', status:'active', acceptedTaskTypes:['report.public-material'], runtime:{ kind:'proposal-public-report' } };
  const { service } = setup({ agents:[reporter] });
  service.fallbackExecutor = { supports(){ return true; }, async execute(){ return { status:'succeeded', currentStage:'done', artifactRefs:[] }; } };
  const task = await service.create({ title:'对比 https://example.com/a 和 https://example.com/b', taskType:'report.public-material' });
  assert.deepEqual(task.input.sourceUrls, ['https://example.com/a', 'https://example.com/b']);
  assert.equal(task.input.sourceUrl, 'https://example.com/a');
});
test('局域网协作者称呼会写入任务，并在继续建议时保留', async () => {
  const coordinator = { agentId:'ajun', name:'A君', status:'active', acceptedTaskTypes:['army.intake'] };
  const operator = { agentId:'operator', name:'运维官', status:'active', acceptedTaskTypes:['operations.health-review'] };
  const { service } = setup({ agents:[coordinator, operator] });
  service.executors.ajun = { async execute(task) { return { status:'succeeded', currentStage:'intake_record_ready', artifactRefs:[{ taskId:task.taskId, type:'task_intake_record', data:{ recommendedTaskType:'operations.health-review', recommendedAgentId:'operator' } }] }; } };
  service.executors.operator = { async execute() { return { status:'succeeded', currentStage:'health_report_ready', artifactRefs:[] }; } };
  const intake = await service.create({ title:'检查本机健康', taskType:'army.intake', requesterName:'志鹏' }); const next = await service.continueFromRecommendation(intake.taskId);
  assert.deepEqual(intake.requester, { kind:'lan-collaborator', ref:'志鹏' }); assert.deepEqual(next.requester, intake.requester);
});
test('概览优先呈现待审批任务，并给出不会自动继续的下一步', async () => {
  const { service, records } = setup();
  records.tasks.push(
    { taskId:'task-done', status:'succeeded', approvalRefs:[], input:{ title:'已完成', description:'', sourceUrl:null }, updatedAt:'2026-07-20T08:00:00.000Z' },
    { taskId:'task-waiting', status:'waiting_approval', approvalRefs:['approval-1'], input:{ title:'发布周报', description:'', sourceUrl:null }, updatedAt:'2026-07-20T09:00:00.000Z' },
    { taskId:'task-running', status:'running', approvalRefs:[], input:{ title:'本机检查', description:'', sourceUrl:null }, updatedAt:'2026-07-20T10:00:00.000Z' }
  );
  records.approvals.push({ approvalId:'approval-1', taskId:'task-waiting', status:'pending' });
  const overview = await service.overview();
  const waitingAction = { taskId:'task-waiting', title:'发布周报', status:'waiting_approval', action:'请确认任务范围；在你确认前，系统不会继续执行。' };
  assert.deepEqual(overview.taskFocus, { total:3, completed:1, inProgress:1, backgroundInProgress:0, paused:0, needsInput:0, waitingApproval:1, waitingTest:0, failed:0, ownerActionable:1, reviewBacklog:0, actions:[waitingAction], next:waitingAction });
});
test('概览把等待 Mac工作间的任务列为进行中并说明自动领取', async () => {
  const { service, records } = setup();
  records.tasks.push({
    taskId:'task-waiting-worker', status:'waiting_worker', approvalRefs:[],
    input:{ title:'整理本机视频', description:'', sourceUrl:'https://example.com/video.mp4' },
    updatedAt:'2026-07-26T08:00:00.000Z'
  });
  service.setWorkerStatus(() => ({ status:'waiting', detail:'等待 Mac工作间连接。' }));
  const overview = await service.overview();
  assert.equal(overview.taskFocus.inProgress, 1);
  assert.deepEqual(overview.taskFocus.next, {
    taskId:'task-waiting-worker',
    title:'整理本机视频',
    status:'waiting_worker',
    action:'这项工作需要老板的 Mac；已安全排队，Mac 上线后会自动领取。'
  });
  assert.equal(overview.capabilities.find((item) => item.id === 'mac-worker').status, 'waiting');
});
test('概览把待测试任务明确说明为待测试，不误说成排队', async () => {
  const { service, records } = setup();
  records.tasks.push({
    taskId:'task-waiting-test', status:'waiting_test', approvalRefs:[],
    input:{ title:'核对飞书提醒', description:'', sourceUrl:null },
    error:{ userMessage:'这项检查暂时需要人工确认，已列入待测试，其他工作会继续。' },
    updatedAt:'2026-07-22T08:00:00.000Z'
  });
  const overview = await service.overview();
  assert.equal(overview.taskFocus.waitingTest, 1);
  assert.deepEqual(overview.taskFocus.next, {
    taskId:'task-waiting-test', title:'核对飞书提醒', status:'waiting_test',
    action:'这项检查暂时需要人工确认，已列入待测试，其他工作会继续。'
  });
});
test('概览不把内部 Hermes 历史验收失败当成老板下一步', async () => {
  const { service, records } = setup();
  records.tasks.push(
    {
      taskId:'internal-old', status:'needs_input', approvalRefs:[],
      source:{ channel:'army-mission', originChannel:'hermes-native' },
      input:{ title:'内部旧验收', description:'', sourceUrl:null },
      updatedAt:'2026-07-28T09:00:00.000Z'
    },
    {
      taskId:'completed-later', status:'succeeded', approvalRefs:[],
      source:{ channel:'army-mission', originChannel:'hermes-native' },
      input:{ title:'同一能力已完成', description:'', sourceUrl:null },
      updatedAt:'2026-07-28T10:00:00.000Z'
    }
  );
  const overview = await service.overview();
  assert.equal(overview.taskFocus.needsInput, 1);
  assert.equal(overview.taskFocus.next, null);
});
test('概览不再提示已被后续成功任务替代的旧失败', async () => {
  const { service, records } = setup();
  records.tasks.push(
    {
      taskId:'old-mission', taskType:'army.cross-agent-mission', status:'needs_input', approvalRefs:[],
      source:{ channel:'feishu' },
      input:{ title:'旧任务', sourceUrl:'https://example.com/video' },
      updatedAt:'2026-07-28T09:00:00.000Z'
    },
    {
      taskId:'recovered-mission', taskType:'army.cross-agent-mission', status:'succeeded', approvalRefs:[],
      source:{ channel:'feishu' },
      input:{ title:'恢复后的任务', sourceUrl:'https://example.com/video' },
      updatedAt:'2026-07-28T10:00:00.000Z'
    }
  );
  const overview = await service.overview();
  assert.equal(overview.taskFocus.needsInput, 1);
  assert.equal(overview.taskFocus.next, null);
});
test('概览保留历史未完成计数，但不把早于后续用户结果的旧问题当成当前下一步', async () => {
  const { service, records } = setup();
  records.tasks.push(
    {
      taskId:'old-input', taskType:'research.intel-report', status:'needs_input', approvalRefs:[],
      source:{ channel:'feishu' },
      input:{ title:'旧搜索需要补词' },
      updatedAt:'2026-07-28T09:00:00.000Z'
    },
    {
      taskId:'new-result', taskType:'content.video-benchmark-analysis', status:'succeeded', approvalRefs:[],
      source:{ channel:'feishu' },
      input:{ title:'后来完成的视频拆解' },
      updatedAt:'2026-07-28T10:00:00.000Z'
    }
  );
  const overview = await service.overview();
  assert.equal(overview.taskFocus.needsInput, 1);
  assert.equal(overview.taskFocus.next, null);
});
test('概览不把已经完成的接收建议冒充老板待办', async () => {
  const { service, records } = setup();
  records.tasks.push({ taskId:'task-intake', status:'succeeded', approvalRefs:[], input:{ title:'评估岗位能力', description:'', sourceUrl:null }, artifactRefs:[{ type:'task_intake_record', data:{ recommendedTaskType:'governance.architecture-review', recommendedAgentId:'architect' } }], updatedAt:'2026-07-20T10:00:00.000Z' });
  const overview = await service.overview();
  assert.equal(overview.taskFocus.ownerActionable, 0);
  assert.deepEqual(overview.taskFocus.actions, []);
  assert.equal(overview.taskFocus.next, null);
});
test('概览有业务任务运行时不让已完成的接收建议抢占下一步', async () => {
  const { service, records } = setup();
  records.tasks.push(
    {
      taskId:'task-running', status:'running', approvalRefs:[],
      input:{ title:'后台巡检', description:'', sourceUrl:null },
      updatedAt:'2026-07-20T11:00:00.000Z'
    },
    {
      taskId:'task-intake', status:'succeeded', approvalRefs:[],
      input:{ title:'评估岗位能力', description:'', sourceUrl:null },
      artifactRefs:[{ type:'task_intake_record', data:{ recommendedTaskType:'governance.architecture-review', recommendedAgentId:'architect' } }],
      updatedAt:'2026-07-20T10:00:00.000Z'
    }
  );
  const overview = await service.overview();
  assert.equal(overview.taskFocus.inProgress, 1);
  assert.equal(overview.taskFocus.ownerActionable, 0);
  assert.equal(overview.taskFocus.next.taskId, 'task-running');
});
test('概览不把早于后续用户结果的旧接收建议重新顶到当前下一步', async () => {
  const { service, records } = setup();
  records.tasks.push(
    {
      taskId:'old-intake', taskType:'army.intake', status:'succeeded', approvalRefs:[],
      source:{ channel:'feishu' },
      input:{ title:'旧建议' },
      artifactRefs:[{ type:'task_intake_record', data:{ recommendedTaskType:'operations.health-review', recommendedAgentId:'operator' } }],
      updatedAt:'2026-07-28T09:00:00.000Z'
    },
    {
      taskId:'new-result', taskType:'office.knowledge-summary', status:'succeeded', approvalRefs:[],
      source:{ channel:'hermes-native' },
      input:{ title:'新的归档结果' },
      updatedAt:'2026-07-28T10:00:00.000Z'
    }
  );
  const overview = await service.overview();
  assert.equal(overview.taskFocus.next, null);
});

test('概览把 Paperclip 定时巡检留在记录里但不算业务进行中', async () => {
  const { service, records } = setup();
  records.tasks.push({
    taskId:'scheduled-health', taskType:'operations.health-review', status:'running', approvalRefs:[],
    source:{ channel:'paperclip' },
    input:{ title:'A君定时本机巡检', description:'agent-army:operations-health-v1\n只读检查。' },
    updatedAt:'2026-08-02T07:00:00.000Z'
  });
  const overview = await service.overview();
  assert.equal(overview.tasks.length, 1);
  assert.equal(overview.taskFocus.inProgress, 0);
  assert.equal(overview.taskFocus.backgroundInProgress, 1);
  assert.equal(overview.taskFocus.next, null);
});

test('概览最多返回五条真正需要老板处理的待办', async () => {
  const { service, records } = setup();
  for (let index = 0; index < 7; index += 1) {
    records.tasks.push({
      taskId:`task-approval-${index}`, status:'waiting_approval', approvalRefs:[],
      source:{ channel:'feishu' }, input:{ title:`待确认 ${index}` },
      updatedAt:`2026-08-02T07:0${index}:00.000Z`
    });
  }
  const overview = await service.overview();
  assert.equal(overview.taskFocus.ownerActionable, 7);
  assert.equal(overview.taskFocus.actions.length, 5);
  assert.equal(overview.taskFocus.next.taskId, overview.taskFocus.actions[0].taskId);
});

test('概览如实区分已能收发飞书与尚未接入的外部账号写入动作', async () => {
  const { service } = setup();
  const overview = await service.overview();
  const feishu = overview.capabilities.find((item) => item.id === 'feishu-channel');
  const external = overview.capabilities.find((item) => item.id === 'external-execution');
  assert.equal(feishu.status, 'partial');
  assert.match(feishu.detail, /私聊与审批卡已可用/);
  assert.match(feishu.detail, /默认关闭/);
  assert.equal(external.status, 'planned');
  assert.match(external.detail, /尚未接入/);
  const authorizedRead = overview.capabilities.find((item) => item.id === 'authorized-content-read');
  assert.equal(authorizedRead.status, 'partial');
  assert.match(authorizedRead.detail, /具体任务验证/);
});

test('概览如实显示小办 PPTD 与本地 PPTX 均可用', async () => {
  const skillExecutionRegistry = {
    async overview() {
      return [{
        slug:'open-kimi-ppt',
        status:'ready',
        modes:{
          compose:{ status:'ready' },
          visualQa:{ status:'ready' },
          export:{ status:'ready' },
        },
        recovery:null,
      }];
    },
  };
  const { service } = setup({ skillExecutionRegistry });
  const overview = await service.overview();
  const presentation = overview.capabilities.find((item) => item.id === 'office-presentation');
  assert.equal(presentation.status, 'ready');
  assert.match(presentation.detail, /PPTD 可用/);
  assert.match(presentation.detail, /PPTX 可用/);
});

test('概览会如实显示官方飞书入口已经连接，不把等待状态冒充成已连接', async () => {
  const { service } = setup();
  service.setFeishuChannelStatus(() => ({ status:'connected', message:'已连接' }));
  const overview = await service.overview();
  const feishu = overview.capabilities.find((item) => item.id === 'feishu-channel');
  assert.equal(feishu.status, 'ready');
  assert.match(feishu.detail, /已连接/);
});

test('概览把 Hermes 原生飞书入口显示为已就绪', async () => {
  const { service } = setup();
  service.setFeishuChannelStatus(() => ({ status:'external', message:'A君飞书入口已交由 Hermes 原生 Gateway。' }));
  const overview = await service.overview();
  const feishu = overview.capabilities.find((item) => item.id === 'feishu-channel');
  assert.equal(feishu.status, 'ready');
  assert.match(feishu.detail, /Hermes 原生 Gateway/);
});

test('概览优先显示独立飞书应用的实时连接状态，不把静态 Profile 当成入口真相', async () => {
  const operator = {
    agentId:'operator', name:'运维官', status:'active', acceptedTaskTypes:['operations.health-review'],
    independentRuntime:{ state:'channel_pending' }
  };
  const { service } = setup({
    agents:[operator],
    agentChannelStates:() => ({ operator:{ agentId:'operator', status:'connected', message:'运维官飞书智能体应用已连接。' } })
  });
  const overview = await service.overview();
  assert.deepEqual(overview.agents[0].feishuChannel, {
    status:'connected', message:'运维官飞书智能体应用已连接。'
  });
  assert.equal(overview.agents[0].independentRuntime.state, 'channel_pending');
});

test('后台按需岗位即使残留外部 Gateway 状态也不显示独立飞书入口', async () => {
  const architect = {
    agentId:'architect',
    name:'架构师',
    status:'active',
    acceptedTaskTypes:['governance.architecture-review'],
    interaction:{ directFeishu:'disabled', visibility:'on-demand' }
  };
  const { service } = setup({
    agents:[architect],
    agentChannelStates:() => ({
      architect:{ status:'external', message:'旧 Gateway 环境仍有残留。' }
    })
  });
  const overview = await service.overview();
  assert.equal(overview.agents[0].feishuChannel, undefined);
  assert.equal(overview.onDemandAgents[0].agentId, 'architect');
});

test('概览只在独立飞书入口已有终态任务证据时标记为已验证', async () => {
  const operator = { agentId:'operator', name:'运维官', status:'active', acceptedTaskTypes:['operations.health-review'] };
  const { service, records } = setup({
    agents:[operator],
    agentChannelStates:() => ({ operator:{ status:'connected', message:'运维官飞书智能体应用已连接。' } })
  });
  records.tasks.push({ taskId:'operator-feishu-1', status:'succeeded', source:{ channel:'feishu', targetAgentId:'operator' }, input:{ title:'检查军团状态' } });
  const overview = await service.overview();
  assert.equal(overview.agents[0].feishuChannel.verified, true);
});

test('Hermes 接管的独立员工已有飞书终态任务时也标记为已验证', async () => {
  const employee = { agentId:'intel-researcher', name:'小R', status:'active', acceptedTaskTypes:['research.intel-report'] };
  const { service, records } = setup({
    agents:[employee],
    agentChannelStates:() => ({ 'intel-researcher':{ status:'external', message:'已由独立 Hermes Profile Gateway 接管。' } })
  });
  records.tasks.push({ taskId:'intel-feishu-1', status:'succeeded', source:{ channel:'feishu', targetAgentId:'intel-researcher' }, input:{ title:'研究公开资料' } });
  const overview = await service.overview();
  assert.equal(overview.agents[0].feishuChannel.status, 'external');
  assert.equal(overview.agents[0].feishuChannel.verified, true);
});

test('飞书跟进在小D完成并确认文档权限后返回真实交付链接', async () => {
  const { service, records } = setup();
  records.tasks.push({ taskId:'task-media', taskType:'media.transcribe-and-refine', status:'succeeded', source:{ chatRef:'chat-a' }, input:{ title:'整理公开视频' }, updatedAt:'2026-07-21T10:00:00.000Z', artifactRefs:[{ type:'xiaod_media_delivery', data:{ larkUrl:'https://example.feishu.cn/docx/example', larkPermissionGranted:true } }] });
  const result = await service.notificationStatus('task-media', 'chat-a');
  assert.equal(result.terminal, true);
  assert.equal(result.status, 'succeeded');
  assert.match(result.message, /交付文档/);
  assert.match(result.message, /example\.feishu\.cn/);
});

test('后台按需员工运行中和完成时按真实岗位回话，不误报为小D', async () => {
  const reviewer = { agentId:'reviewer', name:'审核官', status:'active', acceptedTaskTypes:['governance.approval-review'] };
  const { service, records } = setup({ agents:[reviewer] });
  records.tasks.push({
    taskId:'task-review', taskType:'governance.approval-review', assigneeAgentId:'reviewer',
    status:'running', source:{ chatRef:'chat-a' }, input:{ title:'核对实施边界' },
    updatedAt:'2026-07-27T09:00:00.000Z', artifactRefs:[]
  });
  const running = await service.notificationStatus('task-review', 'chat-a');
  assert.match(running.message, /正在由审核官处理/);
  assert.doesNotMatch(running.message, /小D/);

  records.tasks[0].status = 'succeeded';
  records.tasks[0].artifactRefs = [{ type:'employee_role_report', data:{ summary:'边界符合本轮只读审核要求。' } }];
  const completed = await service.notificationStatus('task-review', 'chat-a');
  assert.match(completed.message, /审核官已完成/);
  assert.match(completed.message, /边界符合/);
  assert.doesNotMatch(completed.message, /小D/);
});

test('飞书跟进会返回运维官的结构化健康报告，不误报成小D文档交付', async () => {
  const { service, records } = setup();
  records.tasks.push({
    taskId:'task-health', taskType:'operations.health-review', status:'succeeded',
    source:{ chatRef:'chat-a' }, input:{ title:'军团健康检查' }, updatedAt:'2026-07-26T02:29:51.710Z',
    artifactRefs:[{ type:'health_report', data:{
      overall:'healthy',
      components:[{ id:'ajun-runtime', name:'A君运行台', status:'healthy', detail:'运行正常。' }],
      recommendedAction:'无需恢复动作。'
    } }]
  });
  const result = await service.notificationStatus('task-health', 'chat-a');
  assert.equal(result.terminal, true);
  assert.match(result.message, /【运维官健康检查】/);
  assert.match(result.message, /整体：正常/);
  assert.match(result.message, /A君运行台：正常/);
  assert.doesNotMatch(result.message, /小D|飞书文档权限/);
});

test('飞书跟进会按公开资料报告员的真实摘要回话，不冒充是小D完成', async () => {
  const { service, records } = setup();
  records.tasks.push({ taskId:'task-web', taskType:'report.public-material', status:'succeeded', source:{ chatRef:'chat-a' }, input:{ title:'整理公开网页' }, updatedAt:'2026-07-22T10:00:00.000Z', artifactRefs:[{ type:'public_web_report', data:{ summary:'这是一份可读的公开网页摘要。' } }] });
  const result = await service.notificationStatus('task-web', 'chat-a');
  assert.equal(result.terminal, true);
  assert.match(result.message, /公开资料报告员/);
  assert.match(result.message, /内容概览/);
  assert.match(result.message, /来源/);
  assert.doesNotMatch(result.message, /小D/);
});

test('飞书跟进会把小R的 GitHub 和主题研究产物回到原会话', async () => {
  const { service, records } = setup();
  records.tasks.push(
    { taskId:'github-result', taskType:'research.github-search', status:'succeeded', source:{ chatRef:'chat-a' }, input:{ title:'找开源项目' }, updatedAt:'2026-07-23T10:00:00.000Z', artifactRefs:[{ type:'research_github_report', data:{ query:'agent', results:[{ fullName:'openai/example', stars:100, language:'JavaScript', assessment:'近三个月仍有更新。', url:'https://github.com/openai/example' }] } }] },
    { taskId:'intel-result', taskType:'research.intel-report', status:'succeeded', source:{ chatRef:'chat-a' }, input:{ title:'研究主题' }, updatedAt:'2026-07-23T10:01:00.000Z', artifactRefs:[{ type:'intel_research_report', data:{ topic:'Agent 运行时', background:'公开背景', findings:['公开发现'], conclusion:'公开结论', recommendations:['先验证'], openQuestions:['还需来源'], sources:[{ title:'资料', source:'https://example.com/a' }] } }] }
  );
  const github = await service.notificationStatus('github-result', 'chat-a');
  assert.match(github.message, /小R/);
  assert.match(github.message, /https:\/\/github\.com\/openai\/example/);
  const intel = await service.notificationStatus('intel-result', 'chat-a');
  assert.match(intel.message, /【小R 研究报告】/);
  assert.match(intel.message, /公开结论/);
  assert.match(intel.message, /https:\/\/example\.com\/a/);
});

test('飞书跟进会把办公执行助理的真实汇报包摘要回到原会话', async () => {
  const { service, records } = setup();
  records.tasks.push({
    taskId:'task-office',
    taskType:'office.briefing-package',
    status:'succeeded',
    source:{ chatRef:'chat-office' },
    input:{ title:'整理三项员工结果' },
    artifactRefs:[{
      type:'office_briefing_package',
      validation:{ exists:true, readable:true, nonEmpty:true },
      data:{ title:'三项员工结果｜办公汇报包', summary:'已核对三项工作。', sourceTasks:[{ taskId:'a' }, { taskId:'b' }, { taskId:'c' }], openItems:['小D还缺链接'], nextAction:'补充链接后生成最终版。', markdown:'# 汇报包' }
    }]
  });
  const result = await service.notificationStatus('task-office', 'chat-office');
  assert.equal(result.status, 'succeeded');
  assert.match(result.message, /办公执行助理已完成/);
  assert.match(result.message, /已核对 3 项关联工作/);
  assert.match(result.message, /小D还缺链接/);
});

test('飞书跟进会把老板多人任务作为一个总任务汇报，而不是误报成小D交付', async () => {
  const { service, records } = setup();
  records.tasks.push({
    taskId:'mission-business',
    taskType:'army.cross-agent-mission',
    status:'succeeded',
    source:{ chatRef:'chat-boss' },
    input:{ title:'完成老板本周内容任务' },
    artifactRefs:[{
      type:'cross_agent_mission_summary',
      validation:{ exists:true, readable:true, nonEmpty:true, allSubtasksCompleted:true },
      data:{
        kind:'business',
        summary:'完成老板本周内容任务',
        completed:true,
        terminal:true,
        statuses:[
          { title:'整理公开视频', employeeId:'xiaod', status:'succeeded' },
          { title:'研究公开资料', employeeId:'intel-researcher', status:'succeeded' },
          { title:'整理老板汇报', employeeId:'office-assistant', status:'succeeded' }
        ],
        decision:{ briefing:{ summary:'三项工作已核对并汇总。', openItems:[], nextAction:'请老板审阅最终汇报。' } }
      }
    }]
  });
  const result = await service.notificationStatus('mission-business', 'chat-boss');
  assert.equal(result.terminal, true);
  assert.equal(result.status, 'succeeded');
  assert.match(result.message, /【A君总任务】/);
  assert.match(result.message, /3\/3 项完成/);
  assert.match(result.message, /小D：已完成/);
  assert.match(result.message, /小R：已完成/);
  assert.match(result.message, /办公执行助理：已完成/);
  assert.match(result.message, /三项工作已核对并汇总/);
  assert.doesNotMatch(result.message, /飞书文档权限/);
});

test('老板多人任务仍在推进时只回真实阶段，不提前宣布完成', async () => {
  const { service, records } = setup();
  records.tasks.push({
    taskId:'mission-running',
    taskType:'army.cross-agent-mission',
    status:'running',
    source:{ chatRef:'chat-boss' },
    input:{ title:'完成老板本周内容任务' },
    artifactRefs:[{
      type:'cross_agent_mission_summary',
      validation:{ exists:true, readable:true, nonEmpty:true, allSubtasksCompleted:false },
      data:{
        kind:'business',
        summary:'完成老板本周内容任务',
        completed:false,
        terminal:false,
        statuses:[
          { title:'整理公开视频', employeeId:'xiaod', status:'running' },
          { title:'研究公开资料', employeeId:'intel-researcher', status:'succeeded' },
          { title:'整理老板汇报', employeeId:'office-assistant', status:'planned' }
        ]
      }
    }]
  });
  const result = await service.notificationStatus('mission-running', 'chat-boss');
  assert.equal(result.terminal, false);
  assert.match(result.message, /1\/3 项完成/);
  assert.match(result.message, /不需要你分别追问/);
});

test('内容总任务完成时直接交付小拆的真实 13 模块报告而不是只报 2/2', async () => {
  const { service, records } = setup();
  const modules = Array.from({ length:13 }, (_, index) => ({
    name:`模块${index + 1}`,
    finding:`判断${index + 1}`,
    evidence:{ timestamp:`00:${String(index).padStart(2, '0')}`, fragment:`原文片段${index + 1}` }
  }));
  records.tasks.push({
    taskId:'mission-content-done',
    taskType:'army.cross-agent-mission',
    status:'succeeded',
    source:{ channel:'feishu', chatRef:'chat-content' },
    input:{ title:'完整拆解公开视频' },
    artifactRefs:[{
      type:'cross_agent_mission_summary',
      validation:{ exists:true, readable:true, nonEmpty:true, allSubtasksCompleted:true },
      data:{
        summary:'完整拆解公开视频',
        statuses:[
          { title:'获取并完整听审', employeeId:'xiaod', taskId:'content-done-xiaod', status:'succeeded' },
          { title:'正式拆解', employeeId:'video-content-analyst', taskId:'content-done-analysis', status:'succeeded' }
        ]
      }
    }]
  });
  records.tasks.push({
    taskId:'content-done-analysis',
    parentTaskId:'mission-content-done',
    taskType:'content.video-benchmark-analysis',
    assigneeAgentId:'video-content-analyst',
    status:'succeeded',
    artifactRefs:[{
      type:'video_content_analysis_report',
      validation:{ exists:true, readable:true,nonEmpty:true },
      data:{ evidenceLabel:'人工确认稿', summary:'已完成深度拆解。', generationMode:'hermes_advisor', modules, actionItems:['先验证开头。'] }
    }]
  });
  const result = await service.notificationStatus('mission-content-done', 'chat-content');
  assert.equal(result.terminal, true);
  assert.match(result.message, /小拆：已完成/);
  assert.match(result.message, /Hermes 深度分析/);
  assert.match(result.message, /13\. 模块13/);
  assert.match(result.message, /行动清单/);
  assert.doesNotMatch(result.message, /只用“完成”状态/);
});

test('内容总任务等待小D完整听审时向原飞书会话暴露审批阶段', async () => {
  const { service, records } = setup();
  records.tasks.push({
    taskId:'mission-content-review',
    taskType:'army.cross-agent-mission',
    status:'running',
    source:{ channel:'feishu', chatRef:'chat-content' },
    input:{ title:'拆解公开视频' },
    artifactRefs:[{
      type:'cross_agent_mission_summary',
      validation:{ exists:true, readable:true, nonEmpty:true, allSubtasksCompleted:false },
      data:{
        kind:'business',
        summary:'拆解公开视频',
        completed:false,
        terminal:false,
        statuses:[
          { title:'获取并完整听审', employeeId:'xiaod', status:'waiting_approval' },
          { title:'正式拆解', employeeId:'video-content-analyst', status:'planned' }
        ]
      }
    }]
  });
  records.tasks.push({
    taskId:'content-review-child',
    parentTaskId:'mission-content-review',
    taskType:'media.transcribe-and-refine',
    assigneeAgentId:'xiaod',
    status:'waiting_approval',
    source:{ channel:'army-mission' },
    input:{ title:'获取并完整听审' },
    execution:{ executor:'xiaod', xiaodJobId:'xiaod-review-job' },
    approvalRefs:['approval-content-review'],
    artifactRefs:[]
  });
  records.approvals.push({
    approvalId:'approval-content-review',
    taskId:'content-review-child',
    status:'pending',
    action:'confirm-transcript-after-complete-listen'
  });
  service.executors.xiaod = {
    async getJob(jobId) {
      assert.equal(jobId, 'xiaod-review-job');
      return {
        output:{
          larkUrl:'https://example.feishu.cn/docx/review',
          larkPermissionGranted:true
        }
      };
    }
  };
  const result = await service.notificationStatus('mission-content-review', 'chat-content');
  assert.equal(result.terminal, false);
  assert.equal(result.status, 'waiting_approval');
  assert.match(result.message, /小D：等待批准/);
  assert.match(result.message, /正式拆解/);
  assert.match(result.message, /https:\/\/example\.feishu\.cn\/docx\/review/);
  assert.match(result.message, /我已完整听审并确认/);
  assert.match(result.message, /未确认前不会启动小拆/);
});

test('飞书跟进会越过第一次失败，继续等待运维官发起的重试', async () => {
  const { service, records } = setup();
  records.tasks.push(
    { taskId:'task-media', taskType:'media.transcribe-and-refine', status:'failed', source:{ chatRef:'chat-a' }, input:{ title:'整理公开视频' }, recovery:{ coordination:{ status:'retrying' } }, updatedAt:'2026-07-21T10:00:00.000Z' },
    { taskId:'task-retry', parentTaskId:'task-media', taskType:'media.transcribe-and-refine', status:'running', source:{ chatRef:'chat-a' }, input:{ title:'整理公开视频' }, recovery:{ rootTaskId:'task-media', attempt:1 }, updatedAt:'2026-07-21T10:01:00.000Z' }
  );
  const result = await service.notificationStatus('task-media', 'chat-a');
  assert.equal(result.terminal, false);
  assert.equal(result.status, 'running');
  assert.match(result.message, /运维官已自动重试/);
});

test('飞书跟进不会在运维官接手前过早宣布任务失败', async () => {
  const { service, records } = setup();
  records.tasks.push({ taskId:'task-media', taskType:'media.transcribe-and-refine', status:'failed', source:{ chatRef:'chat-a' }, input:{ title:'整理公开视频' }, error:{ retryable:true }, updatedAt:'2026-07-21T10:00:00.000Z' });
  const result = await service.notificationStatus('task-media', 'chat-a');
  assert.equal(result.terminal, false);
  assert.equal(result.status, 'recovery_pending');
});

test('安全重试已登记但子任务尚未读到时，飞书先回执运维官接手', async () => {
  const { service, records } = setup();
  records.tasks.push({ taskId:'task-media', taskType:'media.transcribe-and-refine', status:'failed', source:{ chatRef:'chat-a' }, input:{ title:'整理公开视频' }, recovery:{ coordination:{ status:'retrying' } }, updatedAt:'2026-07-21T10:00:00.000Z' });
  const result = await service.notificationStatus('task-media', 'chat-a');
  assert.equal(result.terminal, false);
  assert.equal(result.status, 'recovery_pending');
  assert.match(result.message, /运维官已接手/);
});

test('飞书跟进在技术专家接手后给出明确结论', async () => {
  const { service, records } = setup();
  records.tasks.push(
    { taskId:'task-media', taskType:'media.transcribe-and-refine', status:'failed', source:{ chatRef:'chat-a' }, input:{ title:'整理公开视频' }, updatedAt:'2026-07-21T10:00:00.000Z' },
    { taskId:'task-tech', parentTaskId:'task-media', taskType:'operations.technical-repair', status:'succeeded', input:{ title:'修复内容获取故障' }, updatedAt:'2026-07-21T10:02:00.000Z' }
  );
  const result = await service.notificationStatus('task-media', 'chat-a');
  assert.equal(result.terminal, true);
  assert.equal(result.status, 'technical_repair');
  assert.match(result.message, /技术专家/);
});

test('技术专家仍在处理时，飞书跟进会继续等待最终结果', async () => {
  const { service, records } = setup();
  records.tasks.push(
    { taskId:'task-media', taskType:'media.transcribe-and-refine', status:'failed', source:{ chatRef:'chat-a' }, input:{ title:'整理公开视频' }, updatedAt:'2026-07-22T10:00:00.000Z' },
    { taskId:'task-tech', parentTaskId:'task-media', taskType:'operations.technical-repair', status:'running', input:{ title:'修复内容获取故障' }, updatedAt:'2026-07-22T10:01:00.000Z' }
  );
  const result = await service.notificationStatus('task-media', 'chat-a');
  assert.equal(result.terminal, false);
  assert.equal(result.status, 'technical_repair');
  assert.match(result.message, /技术专家/);
});

test('技术专家自动检查卡住时，飞书会明确通知待测试并停止重复等待', async () => {
  const { service, records } = setup();
  records.tasks.push(
    { taskId:'task-media', taskType:'media.transcribe-and-refine', status:'failed', source:{ chatRef:'chat-a' }, input:{ title:'整理公开视频' }, updatedAt:'2026-07-22T10:00:00.000Z' },
    { taskId:'task-tech', parentTaskId:'task-media', taskType:'operations.technical-repair', status:'waiting_test', input:{ title:'修复内容获取故障' }, artifactRefs:[{ type:'technical_repair_evidence', data:{ nextAction:'等待下一轮受控检查。' } }], updatedAt:'2026-07-22T10:01:00.000Z' }
  );
  const result = await service.notificationStatus('task-media', 'chat-a');
  assert.equal(result.terminal, true);
  assert.equal(result.status, 'waiting_test');
  assert.match(result.message, /待测试/);
  assert.match(result.message, /其他工作会继续推进/);
  assert.match(result.message, /等待下一轮受控检查/);
});

test('同一件事多次交给技术专家时，飞书只报告最新一次的真实状态', async () => {
  const { service, records } = setup();
  records.tasks.push(
    { taskId:'task-media', taskType:'media.transcribe-and-refine', status:'failed', source:{ chatRef:'chat-a' }, input:{ title:'整理公开视频' }, updatedAt:'2026-07-22T10:00:00.000Z' },
    { taskId:'task-tech-old', parentTaskId:'task-media', taskType:'operations.technical-repair', status:'succeeded', artifactRefs:[{ type:'technical_repair_evidence', validation:{ testsPassed:true, recoveryVerified:true } }], updatedAt:'2026-07-22T10:01:00.000Z' },
    { taskId:'task-tech-new', parentTaskId:'task-media', taskType:'operations.technical-repair', status:'waiting_test', artifactRefs:[{ type:'technical_repair_evidence', data:{ nextAction:'等待新的受控检查。' } }], updatedAt:'2026-07-22T10:02:00.000Z' }
  );
  const result = await service.notificationStatus('task-media', 'chat-a');
  assert.equal(result.status, 'waiting_test');
  assert.match(result.message, /等待新的受控检查/);
  assert.doesNotMatch(result.message, /已经修复/);
});

test('普通任务被标为待测试时，飞书不会无限轮询或误报完成', async () => {
  const { service, records } = setup();
  records.tasks.push({ taskId:'task-web', taskType:'report.public-material', status:'waiting_test', source:{ chatRef:'chat-a' }, input:{ title:'核对网页摘要验收' }, updatedAt:'2026-07-22T10:00:00.000Z' });
  const result = await service.notificationStatus('task-web', 'chat-a');
  assert.equal(result.terminal, true);
  assert.equal(result.status, 'waiting_test');
  assert.match(result.message, /待测试/);
  assert.doesNotMatch(result.message, /已经完成/);
});

test('技术专家有完整修复证据后，飞书跟进如实返回已经验证', async () => {
  const registry = { async list(){ return []; } };
  const root = { taskId:'root-repair-ok', taskType:'media.transcribe-and-refine', status:'failed', input:{ title:'整理视频' }, source:{ chatRef:'chat-1' }, createdAt:'2026-07-21T10:00:00.000Z', updatedAt:'2026-07-21T10:00:00.000Z' };
  const repair = { taskId:'repair-ok', parentTaskId:'root-repair-ok', taskType:'operations.technical-repair', status:'succeeded', artifactRefs:[{ type:'technical_repair_evidence', validation:{ testsPassed:true, recoveryVerified:true } }], createdAt:'2026-07-21T10:01:00.000Z', updatedAt:'2026-07-21T10:02:00.000Z' };
  const store = { async list(){ return [repair, root]; }, async listApprovals(){ return []; } };
  const service = new TaskService({ registry, store, executors:{} });
  const result = await service.notificationStatus('root-repair-ok', 'chat-1');
  assert.equal(result.terminal, true);
  assert.equal(result.status, 'repair_verified');
  assert.match(result.message, /修复/);
  assert.match(result.message, /测试/);
});

test('飞书跟进拒绝其他会话读取任务', async () => {
  const { service, records } = setup();
  records.tasks.push({ taskId:'task-media', taskType:'media.transcribe-and-refine', status:'running', source:{ chatRef:'chat-a' }, input:{ title:'整理公开视频' } });
  await assert.rejects(() => service.notificationStatus('task-media', 'chat-b'), /当前会话不能读取/);
});

test('只给已结束工作记录结果评价，不会伪造重新执行', async () => {
  const { service, records } = setup();
  records.tasks.push(
    { taskId:'done-1', status:'succeeded', input:{ title:'整理公开网页' } },
    { taskId:'running-1', status:'running', input:{ title:'正在整理公开视频' } }
  );
  const recorded = await service.recordFeedback('done-1', { sentiment:'needs_improvement', note:'  重点不够清楚  ' });
  assert.equal(recorded.status, 'succeeded');
  assert.equal(recorded.feedback.sentiment, 'needs_improvement');
  assert.equal(recorded.feedback.note, '重点不够清楚');
  await assert.rejects(() => service.recordFeedback('running-1', { sentiment:'useful' }), /还没有结束/);
  await assert.rejects(() => service.recordFeedback('done-1', { sentiment:'unknown' }), /无效/);
});

test('任务执行会保存实际报告的使用记录，概览只汇总当天已记录部分', async () => {
  const operator = { agentId:'operator', name:'运维官', status:'active', acceptedTaskTypes:['operations.health-review'] };
  const { service } = setup({ agents:[operator] });
  service.executors.operator = { async execute() { return { status:'succeeded', currentStage:'done', execution:{ executor:'operator', outcome:'done' }, usage:{ tools:[{ id:'local-check', name:'本机检查', calls:1 }] }, artifactRefs:[] }; } };
  const task = await service.create({ title:'检查本机状态', taskType:'operations.health-review' });
  assert.equal(task.usage.schemaVersion, 'agent.army/task-usage/v1');
  assert.equal(task.usage.tools[0].calls, 1);
  const usage = await service.usageOverview();
  assert.equal(usage.trackedTaskCount, 1);
  assert.equal(usage.actualToolCalls, 1);
  assert.equal(usage.cost.reportedTaskCount, 0);
});

test('M5 Hermes 阶段必须把专用产物写回同一 Case 后才能完成 Issue', async () => {
  const caseId = '12345678-abcd-4abc-8abc-1234567890ab';
  const outputs = [];
  const completions = [];
  let workProductValidations = 0;
  const identity = {
    issue:{
      id:'paperclip-issue-m5-topic',
      identifier:'AGE-M5-TOPIC',
      title:'M5 / 选题',
      description:`[agent-army:m5:routine:m5-topic] 处理选题阶段；当前 Case 为 ${caseId}，版本为 1。`,
    },
    run:{ id:'paperclip-run-m5-topic' },
    paperclipAgent:{ id:'paperclip-agent-m5-ajun', name:'A君' },
    agentArmyId:'ajun',
  };
  const governance = {
    async verifyHermesAssignment() { return identity; },
    async getPipelineCase() {
      return {
        id:caseId,
        stageKey:'topic',
        fields:{ theme:'AI Agent 真实失败恢复', scheduledDate:'2026-07-31' },
      };
    },
    async getPipelineCaseOutputs() { return outputs; },
    async createIssueWorkProduct(issueId, product) {
      assert.equal(issueId, identity.issue.id);
      outputs.push({ kind:'work_product', ...product });
      return product;
    },
    async completePaperclipIssue(issueId, input) {
      completions.push({ issueId, input });
    },
  };
  const agent = {
    agentId:'ajun',
    name:'A君',
    status:'active',
    acceptedTaskTypes:['content.campaign-topic'],
    interaction:{ runtime:'hermes-profile', directFeishu:'required' },
    executionOwner:'paperclip-hermes',
  };
  const { service } = setup({
    agents:[agent],
    governance,
    m5WorkProductValidator:async ({ product, targetCaseId, task }) => {
      workProductValidations += 1;
      assert.equal(product, outputs[0]);
      assert.equal(targetCaseId, caseId);
      assert.equal(product.metadata.sourceTaskId, task.taskId);
    },
  });
  service.executors.ajun = {
    async execute(task) {
      return {
        status:'succeeded',
        currentStage:'campaign_topic_selected',
        artifactRefs:[{
          artifactId:`topic-selection:${task.taskId}`,
          taskId:task.taskId,
          type:'topic_selection',
          title:'M5 选题',
          validation:{ exists:true, readable:true, nonEmpty:true },
          data:{
            schemaVersion:'agent.army/topic-selection/v1',
            theme:task.input.topic,
            requiredSources:{ minimum:2 },
          },
        }],
      };
    },
  };
  const input = {
    issueId:identity.issue.id,
    runId:identity.run.id,
    paperclipAgentId:identity.paperclipAgent.id,
    agentArmyId:'ajun',
  };
  await service.executeEmployeeAssignment(input);
  const completed = await service.completePaperclipAssignment({
    ...input,
    status:'succeeded',
    summary:'已选择当日主题并声明证据门禁。',
  });

  assert.equal(completed.task.status, 'succeeded');
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].provider, 'agent-army.ajun-runtime');
  assert.equal(outputs[0].metadata.schemaVersion, 'agent.army/topic-selection/v1');
  assert.equal(outputs[0].metadata.kind, 'TopicSelection');
  assert.equal(outputs[0].metadata.artifact.theme, 'AI Agent 真实失败恢复');
  assert.match(outputs[0].metadata.artifactHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(completions.length, 1);

  const duplicate = await service.completePaperclipAssignment({
    ...input,
    status:'succeeded',
    summary:'重复回报。',
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(outputs.length, 1);
  assert.equal(completions.length, 2);
  assert.equal(workProductValidations, 2);
});

test('M5 同key弱Work Product不能压住真实写入或冒充写后回读成功', async () => {
  const caseId = '32345678-abcd-4abc-8abc-1234567890ab';
  const taskId = 'task-m5-weak-duplicate';
  const artifactId = `topic-selection:${taskId}`;
  const outputs = [{
    kind:'work_product',
    type:'artifact',
    provider:'forged.provider',
    sourceTrust:null,
    status:'active',
    healthStatus:'healthy',
    metadata:{
      schemaVersion:'agent.army/topic-selection/v1',
      kind:'TopicSelection',
      stageKey:'topic',
      sourceTaskId:taskId,
      sourceArtifactId:artifactId,
      artifactHash:`sha256:${'a'.repeat(64)}`,
      artifact:{ theme:'伪造占位产物' },
    },
  }];
  let creates = 0;
  let validations = 0;
  const governance = {
    async getPipelineCaseOutputs() { return outputs; },
    async getPaperclipIssueRuns() { return { runs:[] }; },
    async createIssueWorkProduct() {
      creates += 1;
      throw new Error('弱候选存在时不应创建或覆盖');
    },
  };
  const { service } = setup({
    governance,
    m5WorkProductValidator:async () => {
      validations += 1;
      return true;
    },
  });
  const task = {
    taskId,
    taskType:'content.campaign-topic',
    artifactRefs:[{
      artifactId,
      taskId,
      type:'topic_selection',
      validation:{ exists:true, readable:true, nonEmpty:true },
      data:{ theme:'真实选题' },
    }],
  };
  const assignment = {
    routineKey:'m5-topic',
    pipelineCaseId:caseId,
    projectId:'22222222-2222-4222-8222-222222222222',
    issueId:'paperclip-issue-m5-weak-duplicate',
    runId:'paperclip-run-m5-weak-duplicate',
  };

  await assert.rejects(
    () => service.syncM5StageWorkProducts({ task, assignment }),
    /Work Product 漂移：结构、Provider 或状态不符合阶段契约/,
  );
  assert.equal(validations, 1);
  assert.equal(creates, 0);
  assert.equal(outputs.length, 1);
});

test('M5 写回入口同阶段合法加漂移、两个合法都硬停，无关阶段输出不影响幂等回读', async (t) => {
  const caseId = '42345678-abcd-4abc-8abc-1234567890ab';
  const taskId = 'task-m5-candidate-selection';
  const artifactId = `topic-selection:${taskId}`;
  const task = {
    taskId,
    taskType:'content.campaign-topic',
    artifactRefs:[{
      artifactId,
      taskId,
      type:'topic_selection',
      validation:{ exists:true, readable:true, nonEmpty:true },
      data:{ theme:'真实选题' },
    }],
  };
  const assignment = {
    routineKey:'m5-topic',
    pipelineCaseId:caseId,
    projectId:'22222222-2222-4222-8222-222222222222',
    issueId:'paperclip-issue-m5-candidate-selection',
    runId:'paperclip-run-m5-candidate-selection',
  };
  const validProduct = (id) => ({
    id,
    kind:'work_product',
    type:'artifact',
    provider:'agent-army.ajun-runtime',
    sourceTrust:null,
    status:'active',
    healthStatus:'healthy',
    metadata:{
      schemaVersion:'agent.army/topic-selection/v1',
      kind:'TopicSelection',
      stageKey:'topic',
      sourceTaskId:taskId,
      sourceArtifactId:artifactId,
      artifactHash:`sha256:${'b'.repeat(64)}`,
      artifact:{ theme:'真实选题' },
    },
  });
  for (const variant of ['valid-plus-drift', 'drift-plus-valid', 'two-valid', 'unrelated']) {
    await t.test(variant, async () => {
      const valid = validProduct('work-product-valid');
      const extra = validProduct(`work-product-${variant}`);
      if (variant.includes('drift')) {
        extra.provider = 'forged.provider';
      } else if (variant === 'unrelated') {
        extra.metadata.stageKey = 'research';
        extra.metadata.schemaVersion = 'agent.army/evidence-package/v1';
        extra.metadata.kind = 'EvidencePackage';
      }
      const outputs = variant === 'drift-plus-valid' ? [extra, valid] : [valid, extra];
      let creates = 0;
      const governance = {
        async getPipelineCaseOutputs() { return outputs; },
        async getPaperclipIssueRuns() { return { runs:[] }; },
        async createIssueWorkProduct() { creates += 1; },
      };
      const { service } = setup({
        governance,
        m5WorkProductValidator:async () => true,
      });
      if (variant === 'unrelated') {
        const result = await service.syncM5StageWorkProducts({ task, assignment });
        assert.equal(result.replayed, true);
      } else {
        await assert.rejects(
          () => service.syncM5StageWorkProducts({ task, assignment }),
          /重复 Work Product|未解决漂移/,
        );
      }
      assert.equal(creates, 0);
      assert.equal(outputs.length, 2);
    });
  }
});

test('M5 写后回读发现并发漂移候选时不把创建成功冒充为阶段完成', async () => {
  const caseId = '52345678-abcd-4abc-8abc-1234567890ab';
  const taskId = 'task-m5-post-write-drift';
  const artifactId = `topic-selection:${taskId}`;
  const outputs = [];
  let creates = 0;
  const governance = {
    async getPipelineCaseOutputs() { return outputs; },
    async getPaperclipIssueRuns() { return { runs:[] }; },
    async createIssueWorkProduct(_issueId, product) {
      creates += 1;
      const persisted = { id:'work-product-created', kind:'work_product', ...product };
      outputs.push(persisted, {
        ...structuredClone(persisted),
        id:'work-product-concurrent-drift',
        provider:'forged.provider',
      });
    },
  };
  const { service } = setup({
    governance,
    m5WorkProductValidator:async () => true,
  });
  await assert.rejects(
    () => service.syncM5StageWorkProducts({
      task:{
        taskId,
        taskType:'content.campaign-topic',
        artifactRefs:[{
          artifactId,
          taskId,
          type:'topic_selection',
          validation:{ exists:true, readable:true, nonEmpty:true },
          data:{ theme:'真实选题' },
        }],
      },
      assignment:{
        routineKey:'m5-topic',
        pipelineCaseId:caseId,
        projectId:'22222222-2222-4222-8222-222222222222',
        issueId:'paperclip-issue-m5-post-write-drift',
        runId:'paperclip-run-m5-post-write-drift',
      },
    }),
    /写回后存在重复 Work Product|未解决漂移/,
  );
  assert.equal(creates, 1);
  assert.equal(outputs.length, 2);
});

test('M5 Hermes 阶段失败从 Paperclip Case 恢复状态安排重试且同 Run 重放幂等', async () => {
  const caseId = '87654321-abcd-4abc-8abc-1234567890ab';
  const identity = {
    issue:{
      id:'paperclip-issue-m5-voice',
      identifier:'AGE-M5-VOICE',
      title:'M5 / 配音',
      description:`[agent-army:m5:routine:m5-voice] 处理配音阶段；当前 Case 为 ${caseId}，版本为 1。`,
      status:'in_progress',
    },
    run:{ id:'paperclip-run-m5-voice-1' },
    paperclipAgent:{ id:'paperclip-agent-m5-creator', name:'小创' },
    agentArmyId:'content-creator',
  };
  let caseItem = {
    id:caseId,
    version:1,
    parentCaseId:null,
    caseKey:'m5-fixture:2026-07-30',
    stageKey:'voice',
    fields:{
      campaignId:'m5-fixture',
      scheduledDate:'2026-07-30',
    },
  };
  const issueUpdates = [];
  let casePatches = 0;
  const governance = {
    async verifyHermesAssignment() { return identity; },
    async getPipelineCase() { return structuredClone(caseItem); },
    async getPaperclipIssue() { return identity.issue; },
    async getPaperclipIssueRuns() {
      return [{ id:identity.run.id, status:'failed' }];
    },
    async getPipelineCaseEvents() { return []; },
    async getPipelineCaseOutputs() { return []; },
    async patchPipelineCaseFields(_caseId, { expectedVersion, fields }) {
      assert.equal(expectedVersion, caseItem.version);
      caseItem = { ...caseItem, version:caseItem.version + 1, fields:structuredClone(fields) };
      casePatches += 1;
    },
    async reopenM5StageIssue(_issueId, { comment }) {
      issueUpdates.push({ status:'todo', comment });
    },
    async blockM5StageIssue(_issueId, { comment }) {
      issueUpdates.push({ status:'blocked', comment });
    },
    async completeM5RecoveredStageIssue(_issueId, { comment }) {
      issueUpdates.push({ status:'done', comment });
    },
  };
  const agent = {
    agentId:'content-creator',
    name:'小创',
    status:'active',
    acceptedTaskTypes:['content.campaign-voice'],
    interaction:{ runtime:'hermes-profile', directFeishu:'background' },
    executionOwner:'paperclip-hermes',
  };
  const { service } = setup({ agents:[agent], governance });
  const input = {
    issueId:identity.issue.id,
    runId:identity.run.id,
    paperclipAgentId:identity.paperclipAgent.id,
    agentArmyId:identity.agentArmyId,
    status:'failed',
    summary:'受控配音阶段 fixture 失败。',
  };

  const first = await service.completePaperclipAssignment(input);
  assert.equal(first.task.status, 'running');
  assert.equal(first.task.currentStage, 'm5_stage_retry_scheduled');
  assert.equal(first.recovery.action, 'retry');
  const recoveryKey = `${caseId}:voice`;
  assert.equal(caseItem.fields.m5ContentRecovery.stageRecoveries[recoveryKey].stageAttempt, 1);
  assert.equal(issueUpdates.at(-1).status, 'todo');
  assert.equal(casePatches, 1);

  const replay = await service.completePaperclipAssignment(input);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.recovery.replayed, true);
  assert.equal(casePatches, 1);
  assert.equal(caseItem.fields.m5ContentRecovery.stageRecoveries[recoveryKey].history.length, 1);

  const revisionId = `m5-plan-revision:${caseId}:r1`;
  const rejectedExecution = {
    strategy:'default:m5_stage_execute',
    toolIds:['m5_stage_execute'],
    inputHash:`sha256:${'c'.repeat(64)}`,
  };
  caseItem.fields.m5ContentRecovery.activePlanRevision = {
    schemaVersion:'agent.army/m5-plan-revision/v1',
    revisionId,
    contentCaseId:caseId,
    revision:1,
    failedCaseId:caseId,
    failureObservation:{
      issueId:identity.issue.id,
      runId:identity.run.id,
      stageKey:'voice',
      summary:'前一路线的旁白输入无法通过验证。',
      summaryHash:`sha256:${'a'.repeat(64)}`,
    },
    rejectedRoute:{
      kind:'retry_same_inputs',
      reason:'相同输入已失败。',
      execution:rejectedExecution,
      routeFingerprint:routeDescriptorFingerprint(rejectedExecution),
    },
    nextRoute:{
      kind:'same_stage_rebuild_inputs',
      stageKey:'voice',
      preserveVerifiedWorkProducts:true,
      instruction:'保留已验证产物，重建旁白输入。',
    },
    createdAt:'2026-07-30T12:00:00.000Z',
  };
  identity.run.id = 'paperclip-run-m5-voice-2';
  const nextInput = { ...input, runId:identity.run.id };
  const nextAssignment = await service.getPaperclipAssignment(nextInput);
  assert.equal(nextAssignment.task.input.context.m5Recovery.revisionId, revisionId);
  await assert.rejects(
    service.completePaperclipAssignment({
      ...nextInput,
      status:'failed',
      summary:'重规划后仍需继续恢复。',
    }),
    /精确回报已消费的 PlanRevision ID/,
  );
  await assert.rejects(
    service.completePaperclipAssignment({
      ...nextInput,
      status:'failed',
      summary:'模型自行宣称已经换路。',
      consumedRevisionId:revisionId,
      routeChanged:true,
      routeSummary:'这段文字不是执行器回执。',
    }),
    /执行器生成的 PlanRevision 消费回执/,
  );
  const actualRoute = createM5RouteExecution({
    runId:identity.run.id,
    stageKey:'voice',
    recovery:nextAssignment.task.input.context.m5Recovery,
    strategy:'same_stage_rebuild_inputs',
    toolIds:['m5_stage_execute'],
    inputs:{ text:'重建后的旁白输入。' },
  });
  await service.store.updateTask(nextAssignment.task.taskId, {
    execution:{
      ...nextAssignment.task.execution,
      m5RouteExecution:actualRoute,
    },
  });
  const consumed = await service.completePaperclipAssignment({
    ...nextInput,
    status:'failed',
    summary:'重规划后仍需继续恢复。',
    consumedRevisionId:revisionId,
    routeChanged:true,
    routeSummary:'已读取失败 Observation，并改为重建旁白输入参数后再执行。',
  });
  assert.equal(consumed.task.execution.m5PlanRevisionReceipt.consumedRevisionId, revisionId);
  assert.equal(consumed.task.execution.m5PlanRevisionReceipt.routeChanged, true);
});

function m5VisualArtifactFixture(projectId, overrides = {}) {
  const actionId = '12345678-abcd-4abc-8abc-1234567890ab:vision:aaaaaaaaaaaaaaaa';
  const receipt = {
    actionId,
    operation:'vision',
    model:'step-1o-turbo-vision',
    sourcePath:'campaigns/assets/frame-001.png',
    sourceChecksum:`sha256:${'a'.repeat(64)}`,
    observationChecksum:`sha256:${'b'.repeat(64)}`,
    callRecord:{
      actionId,
      operation:'vision',
      model:'step-1o-turbo-vision',
      promptChecksum:`sha256:${'c'.repeat(64)}`,
      costEvent:{ provider:'stepfun', projectId },
    },
    costCommit:{
      status:'confirmed',
      costEventId:'33333333-3333-4333-8333-333333333333',
      costEvent:{ provider:'stepfun', projectId, costCents:1 },
    },
  };
  const receiptOverride = overrides.providerReceipt || {};
  const providerReceipt = {
    ...receipt,
    ...receiptOverride,
    callRecord:{
      ...receipt.callRecord,
      ...(receiptOverride.callRecord || {}),
    },
    costCommit:{
      ...receipt.costCommit,
      ...(receiptOverride.costCommit || {}),
      costEvent:{
        ...receipt.costCommit.costEvent,
        ...(receiptOverride.costCommit?.costEvent || {}),
      },
    },
  };
  return {
    artifactId:'visual-analysis:test',
    type:'visual_analysis_package',
    title:'M5 画面分析包',
    validation:{ exists:true, readable:true, nonEmpty:true },
    data:{
      schemaVersion:'agent.army/visual-analysis-package/v1',
      providerReceipt,
      insights:[{
        finding:'状态卡位于画面中央。',
        frameRef:'frame-001',
        timestamp:'00:00:03',
        evidenceKind:'stepfun_vision_frame',
      }],
    },
    ...overrides,
    data:overrides.data || {
      schemaVersion:'agent.army/visual-analysis-package/v1',
      providerReceipt,
      insights:[{
        finding:'状态卡位于画面中央。',
        frameRef:'frame-001',
        timestamp:'00:00:03',
        evidenceKind:'stepfun_vision_frame',
      }],
    },
  };
}

async function m5VisualCompletionFixture({ projectId, artifact }) {
  const caseId = '12345678-abcd-4abc-8abc-1234567890ab';
  const outputs = [];
  const completions = [];
  const identity = {
    issue:{
      id:'paperclip-issue-m5-visual',
      identifier:'AGE-M5-VISUAL',
      title:'M5 / 画面分析',
      description:`[agent-army:m5:routine:m5-visual-analysis] 处理画面分析阶段；当前 Case 为 ${caseId}，版本为 1。`,
      projectId,
    },
    run:{ id:'paperclip-run-m5-visual' },
    paperclipAgent:{ id:'paperclip-agent-m5-visual', name:'小拆' },
    agentArmyId:'video-content-analyst',
  };
  const governance = {
    async verifyHermesAssignment() { return identity; },
    async getPipelineCase() {
      return {
        id:caseId,
        projectId,
        stageKey:'visual_analysis',
        fields:{ theme:'AI Agent 实战', scheduledDate:'2026-07-31' },
      };
    },
    async getPipelineCaseOutputs() { return outputs; },
    async createIssueWorkProduct(_issueId, product) {
      outputs.push({ kind:'work_product', ...product });
      return product;
    },
    async completePaperclipIssue(issueId, input) {
      completions.push({ issueId, input });
    },
  };
  const agent = {
    agentId:'video-content-analyst',
    name:'小拆',
    status:'active',
    acceptedTaskTypes:['content.campaign-visual-analysis'],
    interaction:{ runtime:'hermes-profile', directFeishu:'background' },
    executionOwner:'paperclip-hermes',
  };
  const fixture = setup({ agents:[agent], governance });
  const input = {
    issueId:identity.issue.id,
    runId:identity.run.id,
    paperclipAgentId:identity.paperclipAgent.id,
    agentArmyId:identity.agentArmyId,
  };
  const assigned = await fixture.service.getPaperclipAssignment(input);
  assigned.task.artifactRefs = [artifact];
  return {
    ...fixture,
    input,
    outputs,
    completions,
  };
}

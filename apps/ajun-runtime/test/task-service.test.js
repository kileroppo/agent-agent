import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskService, ValidationError } from '../src/task-service.js';

function setup({ agents = [], governance = null, onTaskFailed = null, agentChannelStates = null, contentGrowthWaitMs = undefined } = {}) {
  const records = { tasks: [], approvals: [] };
  const store = { async createTask(task) { const record = { taskId: `task-${records.tasks.length + 1}`, approvalRefs: [], ...task }; records.tasks.push(record); return record; }, async createApproval(approval) { const record = { approvalId: `approval-${records.approvals.length + 1}`, status:'pending', ...approval }; records.approvals.push(record); const task = records.tasks.find((item) => item.taskId === approval.taskId); task.approvalRefs.push(record.approvalId); if (approval.holdTask !== false) { task.status='waiting_approval'; task.currentStage='approval_required'; } return record; }, async updateApproval(approvalId, patch) { const approval = records.approvals.find((item) => item.approvalId === approvalId); Object.assign(approval, patch); return approval; }, async updateTask(taskId, patch) { const task = records.tasks.find((item) => item.taskId === taskId); Object.assign(task, patch); return task; }, async list(){return records.tasks}, async listApprovals(){return records.approvals} };
  return { records, service: new TaskService({ registry: { async list(){return agents}, async get(agentId){return agents.find((agent)=>agent.agentId === agentId) || null}, async candidates(type){return agents.filter((agent)=>agent.acceptedTaskTypes.includes(type))} }, store, governance, onTaskFailed, agentChannelStates, contentGrowthWaitMs }) };
}
const coordinator = { agentId:'ajun', name:'A君', status:'active', acceptedTaskTypes:['army.intake', 'army.route-task', 'army.cross-agent-mission'] };

test('军团路由任务统一登记到 A君', async () => {
  const { service } = setup({ agents:[coordinator] }); const task = await service.create({ title:'安排一次任务', taskType:'army.route-task' });
  assert.equal(task.assigneeAgentId, 'ajun'); assert.equal(task.status, 'queued');
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
    remainingRisks:'飞书真人回归待完成。'
  };
  const completed = await service.completePaperclipAssignment(input);
  const duplicate = await service.completePaperclipAssignment(input);

  assert.equal(completed.task.taskId, original.taskId);
  assert.equal(completed.task.status, 'succeeded');
  assert.equal(completed.task.artifactRefs[0].type, 'employee_role_report');
  assert.equal(completions.length, 1);
  assert.equal(duplicate.duplicate, true);
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
  assert.deepEqual(overview.taskFocus, { total:3, completed:1, inProgress:1, paused:0, needsInput:0, waitingApproval:1, waitingTest:0, failed:0, next:{ taskId:'task-waiting', title:'发布周报', status:'waiting_approval', action:'请确认任务范围；在你确认前，系统不会继续执行。' } });
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
test('概览把尚未继续的接收建议当作当前下一步，而不是误报全部完成', async () => {
  const { service, records } = setup();
  records.tasks.push({ taskId:'task-intake', status:'succeeded', approvalRefs:[], input:{ title:'评估岗位能力', description:'', sourceUrl:null }, artifactRefs:[{ type:'task_intake_record', data:{ recommendedTaskType:'governance.architecture-review', recommendedAgentId:'architect' } }], updatedAt:'2026-07-20T10:00:00.000Z' });
  const overview = await service.overview();
  assert.deepEqual(overview.taskFocus.next, { taskId:'task-intake', title:'评估岗位能力', status:'succeeded', action:'A君已经给出下一步建议；确认后可按建议创建后续任务。' });
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

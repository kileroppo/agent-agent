import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskService, ValidationError } from '../src/task-service.js';

function setup({ agents = [], governance = null } = {}) {
  const records = { tasks: [], approvals: [] };
  const store = { async createTask(task) { const record = { taskId: `task-${records.tasks.length + 1}`, approvalRefs: [], ...task }; records.tasks.push(record); return record; }, async createApproval(approval) { const record = { approvalId: `approval-${records.approvals.length + 1}`, status:'pending', ...approval }; records.approvals.push(record); const task = records.tasks.find((item) => item.taskId === approval.taskId); task.approvalRefs.push(record.approvalId); task.status='waiting_approval'; task.currentStage='approval_required'; return record; }, async updateApproval(approvalId, patch) { const approval = records.approvals.find((item) => item.approvalId === approvalId); Object.assign(approval, patch); return approval; }, async updateTask(taskId, patch) { const task = records.tasks.find((item) => item.taskId === taskId); Object.assign(task, patch); return task; }, async list(){return records.tasks}, async listApprovals(){return records.approvals} };
  return { records, service: new TaskService({ registry: { async list(){return agents}, async candidates(type){return agents.filter((agent)=>agent.acceptedTaskTypes.includes(type))} }, store, governance }) };
}
const coordinator = { agentId:'task-coordinator', name:'任务协调官', status:'draft', acceptedTaskTypes:['army.route-task'] };

test('唯一岗位匹配时登记到该岗位，但草稿岗位不冒充执行', async () => {
  const { service } = setup({ agents:[coordinator] }); const task = await service.create({ title:'安排一次任务', taskType:'army.route-task' });
  assert.equal(task.assigneeAgentId, 'task-coordinator'); assert.equal(task.status, 'needs_input'); assert.equal(task.currentStage, 'waiting_for_agent_activation');
});
test('多个岗位匹配时要求明确路由', async () => {
  const { service } = setup({ agents:[coordinator, {...coordinator, agentId:'backup'}] }); const task = await service.create({ title:'安排一次任务', taskType:'army.route-task' });
  assert.equal(task.assigneeAgentId, null); assert.equal(task.currentStage, 'routing_needed');
});
test('高风险描述创建待审批记录', async () => {
  const { service, records } = setup({ agents:[coordinator] }); const task = await service.create({ title:'向外发布周报', taskType:'army.route-task' });
  assert.equal(records.approvals.length, 1); assert.equal(task.status, 'waiting_approval'); assert.equal(task.currentStage, 'approval_required');
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
test('公开发布等组织级审批投影 Paperclip，不能由本机直接放行', async () => {
  const operator = { agentId:'operator', name:'运维官', status:'active', acceptedTaskTypes:['operations.health-review'] };
  let projected = 0;
  const governance = { async project() { projected += 1; return { status:'synced', paperclipIssueId:'issue-1' }; }, async health() { return { status:'ready' }; } };
  const { service, records } = setup({ agents:[operator], governance });
  const task = await service.create({ title:'公开发布系统摘要', taskType:'operations.health-review' });
  assert.equal(task.status, 'waiting_approval'); assert.equal(records.approvals[0].governanceMode, 'paperclip'); assert.equal(projected, 1);
  await assert.rejects(() => service.approveApproval(records.approvals[0].approvalId), /Paperclip/);
});
test('本机主人拒绝审批会关闭任务，不会执行任务', async () => {
  const { service, records } = setup({ agents:[coordinator] }); const task = await service.create({ title:'向外发布周报', taskType:'army.route-task' });
  const closed = await service.rejectApproval(records.approvals[0].approvalId);
  assert.equal(records.approvals[0].status, 'rejected'); assert.equal(closed.status, 'cancelled'); assert.equal(closed.currentStage, 'approval_rejected'); assert.equal(closed.error.code, 'approval_rejected');
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
test('已启用协调官会留下任务接收记录', async () => {
  const coordinator = { agentId:'task-coordinator', name:'任务协调官', status:'active', acceptedTaskTypes:['army.intake'] };
  const executor = { async execute(task) { return { status:'succeeded', currentStage:'intake_record_ready', artifactRefs:[{ taskId:task.taskId, type:'task_intake_record' }] }; } };
  const { service } = setup({ agents:[coordinator] }); service.executors['task-coordinator'] = executor;
  const task = await service.create({ title:'先帮我判断怎么推进', taskType:'army.intake' });
  assert.equal(task.status, 'succeeded'); assert.equal(task.artifactRefs[0].type, 'task_intake_record');
});
test('默认接收高风险描述只生成审核建议，不创建审批或外部动作', async () => {
  const coordinator = { agentId:'task-coordinator', name:'任务协调官', status:'active', acceptedTaskTypes:['army.intake'] };
  const { service, records } = setup({ agents:[coordinator] });
  service.executors['task-coordinator'] = { async execute(task) { return { status:'succeeded', currentStage:'intake_record_ready', artifactRefs:[{ taskId:task.taskId, type:'task_intake_record', data:{ recommendedTaskType:'governance.approval-review', recommendedAgentId:'reviewer', externalActionStarted:false } }] }; } };
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
  const coordinator = { agentId:'task-coordinator', name:'任务协调官', status:'active', acceptedTaskTypes:['army.intake'] };
  const operator = { agentId:'operator', name:'运维官', status:'active', acceptedTaskTypes:['operations.health-review'] };
  const { service } = setup({ agents:[coordinator, operator] });
  service.executors['task-coordinator'] = { async execute(task) { return { status:'succeeded', currentStage:'intake_record_ready', artifactRefs:[{ taskId:task.taskId, type:'task_intake_record', data:{ recommendedTaskType:'operations.health-review', recommendedAgentId:'operator' } }] }; } };
  service.executors.operator = { async execute(task) { return { status:'succeeded', currentStage:'health_report_ready', artifactRefs:[{ taskId:task.taskId, type:'health_report' }] }; } };
  const intake = await service.create({ title:'检查本机健康', taskType:'army.intake' }); const next = await service.continueFromRecommendation(intake.taskId);
  assert.equal(next.parentTaskId, intake.taskId); assert.equal(next.taskType, 'operations.health-review'); assert.equal(next.assigneeAgentId, 'operator'); assert.equal(next.status, 'succeeded');
});
test('小D建议缺少素材链接时不能直接继续', async () => {
  const { service, records } = setup(); records.tasks.push({ taskId:'task-1', status:'succeeded', input:{ title:'整理视频', description:'', sourceUrl:null }, artifactRefs:[{ type:'task_intake_record', data:{ recommendedTaskType:'media.transcribe-and-refine', recommendedAgentId:'xiaod' } }] });
  await assert.rejects(() => service.continueFromRecommendation('task-1'), /公开素材链接/);
});
test('默认接收入口会保留用户粘贴在描述中的公开链接', async () => {
  const coordinator = { agentId:'task-coordinator', name:'任务协调官', status:'active', acceptedTaskTypes:['army.intake'] };
  const { service } = setup({ agents:[coordinator] }); service.executors['task-coordinator'] = { async execute() { return { status:'succeeded', currentStage:'intake_record_ready', artifactRefs:[] }; } };
  const task = await service.create({ title:'整理这条视频', description:'请处理 https://www.youtube.com/watch?v=example。', taskType:'army.intake' });
  assert.equal(task.input.sourceUrl, 'https://www.youtube.com/watch?v=example');
});
test('局域网协作者称呼会写入任务，并在继续建议时保留', async () => {
  const coordinator = { agentId:'task-coordinator', name:'任务协调官', status:'active', acceptedTaskTypes:['army.intake'] };
  const operator = { agentId:'operator', name:'运维官', status:'active', acceptedTaskTypes:['operations.health-review'] };
  const { service } = setup({ agents:[coordinator, operator] });
  service.executors['task-coordinator'] = { async execute(task) { return { status:'succeeded', currentStage:'intake_record_ready', artifactRefs:[{ taskId:task.taskId, type:'task_intake_record', data:{ recommendedTaskType:'operations.health-review', recommendedAgentId:'operator' } }] }; } };
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
  assert.deepEqual(overview.taskFocus, { total:3, completed:1, inProgress:1, needsInput:0, waitingApproval:1, failed:0, next:{ taskId:'task-waiting', title:'发布周报', status:'waiting_approval', action:'请确认任务范围；在你确认前，系统不会继续执行。' } });
});
test('概览把尚未继续的接收建议当作当前下一步，而不是误报全部完成', async () => {
  const { service, records } = setup();
  records.tasks.push({ taskId:'task-intake', status:'succeeded', approvalRefs:[], input:{ title:'评估岗位能力', description:'', sourceUrl:null }, artifactRefs:[{ type:'task_intake_record', data:{ recommendedTaskType:'governance.architecture-review', recommendedAgentId:'architect' } }], updatedAt:'2026-07-20T10:00:00.000Z' });
  const overview = await service.overview();
  assert.deepEqual(overview.taskFocus.next, { taskId:'task-intake', title:'评估岗位能力', status:'succeeded', action:'A君已经给出下一步建议；确认后可按建议创建后续任务。' });
});

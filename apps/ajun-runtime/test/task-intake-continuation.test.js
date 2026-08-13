import assert from 'node:assert/strict';
import test from 'node:test';
import {
  setupTaskService,
  verifiedArtifact,
  verifiedHealthReport,
  verifiedIntakeRecord,
} from './support/task-service-fixture.js';

test('TaskIntakeContinuation 根据已完成的接收建议创建同一 workflow 子任务', async () => {
  const coordinator = { agentId:'ajun', name:'A君', status:'active', acceptedTaskTypes:['army.intake'] };
  const operator = { agentId:'operator', name:'运维官', status:'active', acceptedTaskTypes:['operations.health-review'] };
  const { service } = setupTaskService({ agents:[coordinator, operator] });
  service.executors.ajun = { async execute(task) { return { status:'succeeded', currentStage:'intake_record_ready', artifactRefs:[verifiedIntakeRecord(task, { recommendedTaskType:'operations.health-review', recommendedAgentId:'operator' })] }; } };
  service.executors.operator = { async execute(task) { return { status:'succeeded', currentStage:'health_report_ready', artifactRefs:[verifiedHealthReport(task)] }; } };
  const intake = await service.create({ title:'检查本机健康', taskType:'army.intake' });
  const next = await service.continueFromRecommendation(intake.taskId);
  assert.equal(next.parentTaskId, intake.taskId);
  assert.equal(next.taskType, 'operations.health-review');
  assert.equal(next.assigneeAgentId, 'operator');
  assert.equal(next.status, 'succeeded');
});

test('TaskIntakeContinuation 保留自动能力评估上下文', async () => {
  const coordinator = { agentId:'ajun', name:'A君', status:'active', acceptedTaskTypes:['army.intake'] };
  const architect = { agentId:'architect', name:'架构师', status:'active', acceptedTaskTypes:['governance.architecture-review'] };
  const { service } = setupTaskService({ agents:[coordinator, architect] });
  service.executors.ajun = { async execute(task) { return { status:'succeeded', currentStage:'intake_record_ready', artifactRefs:[verifiedIntakeRecord(task, { recommendedTaskType:'governance.architecture-review', recommendedAgentId:'architect', autoContinue:true, advisor:{ understanding:'研究竞品', deliverable:'竞品行动清单', missing:['竞品名称'] } })] }; } };
  service.executors.architect = { async execute(task) { return { status:'succeeded', currentStage:'architecture_review_ready', artifactRefs:[verifiedArtifact(task, 'architecture_review', { context:task.input.context })] }; } };
  const intake = await service.create({ title:'研究竞品', taskType:'army.intake' });
  const next = await service.continueFromRecommendation(intake.taskId);
  assert.equal(next.input.context.autoCapabilityAssessment, true);
  assert.equal(next.input.context.intakeAdvisor.deliverable, '竞品行动清单');
});

test('TaskIntakeContinuation 拒绝缺少公开素材链接的小D建议', async () => {
  const { service, records } = setupTaskService();
  records.tasks.push({ taskId:'task-1', status:'succeeded', input:{ title:'整理视频', description:'', sourceUrl:null }, artifactRefs:[{ type:'task_intake_record', data:{ recommendedTaskType:'media.transcribe-and-refine', recommendedAgentId:'xiaod' } }] });
  await assert.rejects(() => service.continueFromRecommendation('task-1'), /公开素材链接/);
});

test('TaskIntakeContinuation 保留局域网协作者称呼', async () => {
  const coordinator = { agentId:'ajun', name:'A君', status:'active', acceptedTaskTypes:['army.intake'] };
  const operator = { agentId:'operator', name:'运维官', status:'active', acceptedTaskTypes:['operations.health-review'] };
  const { service } = setupTaskService({ agents:[coordinator, operator] });
  service.executors.ajun = { async execute(task) { return { status:'succeeded', currentStage:'intake_record_ready', artifactRefs:[verifiedIntakeRecord(task, { recommendedTaskType:'operations.health-review', recommendedAgentId:'operator' })] }; } };
  service.executors.operator = { async execute(task) { return { status:'succeeded', currentStage:'health_report_ready', artifactRefs:[verifiedHealthReport(task)] }; } };
  const intake = await service.create({ title:'检查本机健康', taskType:'army.intake', requesterName:'志鹏' });
  const next = await service.continueFromRecommendation(intake.taskId);
  assert.deepEqual(intake.requester, { kind:'lan-collaborator', ref:'志鹏' });
  assert.deepEqual(next.requester, intake.requester);
});

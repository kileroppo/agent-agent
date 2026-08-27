import assert from 'node:assert/strict';
import test from 'node:test';
import { setupTaskService, verifiedHealthReport } from './support/task-service-fixture.js';

function approvedMissionFixture(agent) {
  const fixture = setupTaskService({ agents:[agent] });
  fixture.records.tasks.push(
    { taskId:'mission-1', taskType:'army.cross-agent-mission', status:'running', approvalRefs:['approval-parent'], governance:{ paperclipIssueId:'parent-issue' } },
    { taskId:'child-1', taskType:'operations.health-review', status:'waiting_approval', approvalRefs:['approval-child'], assigneeAgentId:agent.agentId, parentTaskId:'mission-1', input:{ context:{ missionSafeOnly:true, missionTaskId:'mission-1', parentApprovalId:'approval-parent', parentPaperclipIssueId:'parent-issue' } } },
  );
  fixture.records.approvals.push(
    { approvalId:'approval-parent', taskId:'mission-1', status:'approved', action:'manual-risk-review', governanceMode:'paperclip', requestedScope:{ taskType:'army.cross-agent-mission' } },
    { approvalId:'approval-child', taskId:'child-1', status:'pending', governanceMode:'paperclip' },
  );
  return fixture;
}

test('MissionApprovalInheritance 恢复已获批多人任务中岗位真实接受的子工作', async () => {
  const operator = { agentId:'operator', status:'active', acceptedTaskTypes:['operations.health-review'] };
  const { service, records } = approvedMissionFixture(operator);
  let executed = 0;
  service.executors.operator = { async execute(task) { executed += 1; return { status:'succeeded', currentStage:'health_report_ready', artifactRefs:[verifiedHealthReport(task)] }; } };
  const result = await service.resumeApprovedMissionChild('child-1');
  assert.equal(result.status, 'succeeded');
  assert.equal(executed, 1);
  assert.equal(records.approvals.find((item) => item.approvalId === 'approval-child').status, 'superseded');
});

test('MissionApprovalInheritance 拒绝岗位未声明或任务定义未允许继承的子工作', async () => {
  const operator = { agentId:'operator', status:'active', acceptedTaskTypes:['governance.architecture-review'] };
  const { service } = approvedMissionFixture(operator);
  await assert.rejects(
    () => service.resumeApprovedMissionChild('child-1'),
    /没有可继承的组织级批准/,
  );
  const wrongAction = approvedMissionFixture({ agentId:'operator', status:'active', acceptedTaskTypes:['operations.health-review'] });
  wrongAction.records.approvals[0].action = 'publish-content';
  await assert.rejects(
    () => wrongAction.service.resumeApprovedMissionChild('child-1'),
    /没有可继承的组织级批准/,
  );
});

test('MissionApprovalInheritance 支持 local 本地确认模式并支持小D媒体转录任务继承', async () => {
  const xiaod = { agentId:'xiaod', status:'active', acceptedTaskTypes:['media.transcribe-and-refine'] };
  const fixture = setupTaskService({ agents:[xiaod] });
  fixture.records.tasks.push(
    { taskId:'mission-2', taskType:'army.cross-agent-mission', status:'running', approvalRefs:['approval-local-parent'] },
    { taskId:'child-2', taskType:'media.transcribe-and-refine', status:'waiting_approval', approvalRefs:['approval-local-child'], assigneeAgentId:'xiaod', parentTaskId:'mission-2', input:{ context:{ missionTaskId:'mission-2', parentApprovalId:'approval-local-parent' } } },
  );
  fixture.records.approvals.push(
    { approvalId:'approval-local-parent', taskId:'mission-2', status:'approved', action:'manual-risk-review', governanceMode:'local', requestedScope:{ taskType:'army.cross-agent-mission' } },
    { approvalId:'approval-local-child', taskId:'child-2', status:'pending', governanceMode:'local' },
  );
  let executed = 0;
  fixture.service.executors.xiaod = { async execute() { executed += 1; return { status:'waiting_test', currentStage:'media_ready' }; } };
  const result = await fixture.service.resumeApprovedMissionChild('child-2');
  assert.equal(result.status, 'waiting_test');
  assert.equal(executed, 1);
  assert.equal(fixture.records.approvals.find((item) => item.approvalId === 'approval-local-child').status, 'superseded');
});


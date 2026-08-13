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
  const risky = { agentId:'operator', status:'active', acceptedTaskTypes:['operations.incident-response'] };
  const riskyFixture = approvedMissionFixture(risky);
  riskyFixture.records.tasks.find((task) => task.taskId === 'child-1').taskType = 'operations.incident-response';
  await assert.rejects(
    () => riskyFixture.service.resumeApprovedMissionChild('child-1'),
    /没有可继承的组织级批准/,
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { FeishuAgentProvisioningPlanError, FeishuAgentProvisioningPlanner } from '../src/feishu-agent-provisioning-plan.ts';

const planner = new FeishuAgentProvisioningPlanner();

test('小D的飞书应用草案只准备最小收发与卡片能力，不会创建外部应用', () => {
  const plan = planner.plan({ agentId:'xiaod', name:'小D', role:'整理公开视频', status:'active', acceptedTaskTypes:['media.transcribe-and-refine'] });

  assert.equal(plan.status, 'owner_review_required');
  assert.equal(plan.externalActionTaken, false);
  assert.deepEqual(plan.requiredEvents, ['im.message.receive_v1', 'card.action.trigger']);
  assert.match(plan.nextAction, /扫码确认/);
  assert.ok(plan.safety.some((item) => item.includes('凭据')));
});

test('具备真实交付能力的公开资料员工可准备协作群接力草案', () => {
  const plan = planner.plan({ agentId:'public-reporter', name:'公开资料报告员', role:'整理公开网页', status:'active', acceptedTaskTypes:['report.public-material'] }, { collaborationGroup:true });

  assert.ok(plan.requiredEvents.includes('im.message.group_at_msg.include_bot'));
  assert.ok(plan.requiredPermissions.some((item) => item.includes('协作群')));
});

test('已上岗的后台治理岗位也可准备独立飞书智能体应用，且只申请消息最小权限', () => {
  const plan = planner.plan({ agentId:'architect', name:'架构师', role:'评估能力边界', status:'active', acceptedTaskTypes:['governance.architecture-review'] });
  assert.equal(plan.registerApp.createOnly, true);
  assert.equal(plan.registerApp.addons.preset, false);
  assert.deepEqual(plan.registerApp.addons.events.items.tenant, ['im.message.receive_v1']);
  assert.deepEqual(plan.registerApp.addons.scopes.tenant, ['im:message.p2p_msg:readonly', 'im:message:send_as_bot']);
});

test('未正式上岗的岗位不能准备飞书应用', () => {
  assert.throws(
    () => planner.plan({ agentId:'candidate', name:'候选员工', role:'整理网页', status:'draft', acceptedTaskTypes:['report.public-material'] }),
    FeishuAgentProvisioningPlanError
  );
});

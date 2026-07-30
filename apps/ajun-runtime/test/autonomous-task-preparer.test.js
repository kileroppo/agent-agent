import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AutonomousTaskPreparer,
  adaptOpenTaskForExecutor,
  advanceAutonomousPlan
} from '../src/autonomous-task-preparer.js';
import { CapabilityGrantStore, MemoryCapabilityGrantAdapter } from '../src/capability-grant-store.js';

const now = () => new Date('2026-07-29T08:00:00.000Z');
const agent = {
  agentId:'intel-researcher',
  manifestVersion:'0.6.0',
  status:'active',
  acceptedTaskTypes:['research.intel-report', 'research.open-investigation'],
  toolAllowlist:['content.public.fetch'],
  runtimeCapabilities:{ mcpTools:['task_get'], skills:['public-research'] },
  openTaskPolicy:{ domain:'research', qualityGateMode:'manifest-required' }
};

test('legacy迁移模块仍可读取历史GoalSpec、DAG和任务级能力授权', async () => {
  const grants = new CapabilityGrantStore({ adapter:new MemoryCapabilityGrantAdapter(), clock:now });
  const preparer = new AutonomousTaskPreparer({ capabilityGrants:grants, now });
  const task = {
    taskId:'11111111-1111-4111-8111-111111111111',
    taskType:'research.open-investigation',
    input:{
      title:'研究智能体治理方案',
      goalSpec:{
        outcome:'形成有来源的智能体治理比较报告',
        deliverables:['比较报告'],
        acceptanceCriteria:['至少两类证据，并区分事实、判断和未知'],
        capabilityRequests:[{
          capabilityId:'content.public.fetch',
          purpose:'读取公开资料'
        }]
      }
    }
  };

  const prepared = await preparer.prepare(task, agent);

  assert.equal(prepared.blocked, false);
  assert.equal(prepared.plan.steps.length, 3);
  assert.equal(prepared.capabilityResults[0].status, 'active');
  assert.equal((await grants.get('content.public.fetch')).source.kind, 'agent-manifest');
  assert.equal(prepared.artifacts[0].type, 'autonomous_work_plan');
  assert.equal(prepared.artifacts[1].validation.allRequestedCapabilitiesActive, true);
});

test('legacy迁移模块读取未知能力时仍保持闭锁', async () => {
  const preparer = new AutonomousTaskPreparer({
    capabilityGrants:new CapabilityGrantStore({ adapter:new MemoryCapabilityGrantAdapter(), clock:now }),
    now
  });
  const task = {
    taskId:'22222222-2222-4222-8222-222222222222',
    taskType:'research.open-investigation',
    input:{
      title:'研究私有平台',
      goalSpec:{
        capabilityRequests:[{
          capabilityId:'private.account.login',
          purpose:'登录私有账号'
        }]
      }
    }
  };

  const prepared = await preparer.prepare(task, agent);

  assert.equal(prepared.blocked, true);
  assert.deepEqual(prepared.missingCapabilities, ['private.account.login']);
  assert.equal(prepared.capabilityResults[0].status, 'needs_capability');
});

test('legacy迁移模块仍可解释历史计划检查点', () => {
  const task = {
    taskId:'33333333-3333-4333-8333-333333333333',
    taskType:'research.open-investigation',
    input:{ title:'开放研究' },
    artifactRefs:[]
  };
  const normalizedGoal = {
    schemaVersion:'agent.army/goal-spec/v1',
    goalId:`goal:${task.taskId}`,
    objective:'开放研究',
    deliverables:['报告'],
    constraints:[],
    acceptanceCriteria:['报告非空'],
    priority:'normal',
    requestedPermissions:[],
    createdAt:now().toISOString()
  };
  const preparer = new AutonomousTaskPreparer({ now });

  return preparer.prepare({ ...task, input:{ ...task.input, goalSpec:{ deliverables:['报告'], acceptanceCriteria:['报告非空'] } } }, agent)
    .then((prepared) => {
      const withPlan = { ...task, artifactRefs:prepared.artifacts };
      const adapted = adaptOpenTaskForExecutor(withPlan);
      assert.equal(adapted.taskType, 'research.intel-report');
      assert.equal(adapted.input.context.openTaskType, 'research.open-investigation');
      const advanced = advanceAutonomousPlan(withPlan, {
        status:'succeeded',
        artifactRefs:[{
          artifactId:'report-1',
          type:'intel_research_report',
          validation:{ exists:true, readable:true, nonEmpty:true }
        }]
      }, { now:now() });
      assert.equal(advanced.data.plan.status, 'completed');
      assert.equal(advanced.validation.planCompleted, true);
      assert.equal(advanced.data.plan.goalSpec.schemaVersion, normalizedGoal.schemaVersion);
    });
});

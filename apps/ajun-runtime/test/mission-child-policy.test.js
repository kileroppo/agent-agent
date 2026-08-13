import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MissionChildPolicy, normalizedProductMaturityContext } from '../src/workflow/mission-child-policy.ts';

const items = [
  {
    key:'creator', taskType:'governance.agent-proposal', agentId:'creator', title:'创建草案',
    description:'只创建草案。', acceptance:'保持 draft_only。', proposalOnly:true, draftOnly:true,
    context:{ proposalOnly:true, draftOnly:true },
  },
  {
    key:'technical-expert', taskType:'operations.technical-repair', agentId:'technical-expert', title:'修复夹具',
    description:'只修复受控夹具。', acceptance:'只修改一个文件。', dependsOn:['creator'],
    deterministicAcceptanceRepair:true, context:{
      deterministicAcceptanceRepair:true,
      acceptanceWorkspaceRoot:'/tmp/project/work/acceptance-runs',
      failure:{ code:'acceptance_fixture_failure', category:'code_defect', stage:'test', retryable:false },
      repairScope:{
        files:['docs/acceptance-fixtures/technical-repair-sandbox/calculator.js'],
        testSupportFiles:['docs/acceptance-fixtures/technical-repair-sandbox/calculator.test.js', 'docs/acceptance-fixtures/technical-repair-sandbox/package.json'],
        testCommand:'node --test docs/acceptance-fixtures/technical-repair-sandbox/calculator.test.js',
        recoveryCheck:'确认 add(2, 3) 返回 5。',
      },
    },
  },
  {
    key:'content-creator', taskType:'content.video-script-package', agentId:'content-creator', title:'生成待审脚本',
    description:'只使用固定来源。', acceptance:'保持 draft_only。', dependsOn:['technical-expert'],
    platforms:['douyin'], contentGoal:'解释已有观点。', researchMode:'off', approvedForUse:false,
    context:{
      researchMode:'off', approvedForUse:false,
      modelPolicy:{ maxCalls:0, maxCostUsd:0, costKnown:true },
      sourceTaskIds:['source-transcript', 'source-analysis'],
      requiredSourceTaskIds:['source-transcript', 'source-analysis'],
    },
  },
];

test('产品成熟度授权只允许三个固定子任务并可跨实例校验', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mission-policy-'));
  const keyPath = path.join(root, 'policy.key');
  const first = await MissionChildPolicy.open({ keyPath });
  const authorization = first.issue('maturity-11111111-1111-4111-8111-111111111111', items);
  const second = await MissionChildPolicy.open({ keyPath });
  const batchId = 'maturity-11111111-1111-4111-8111-111111111111';
  const mission = { taskId:'mission-11111111-1111-4111-8111-111111111111', idempotencyKey:'product-maturity-validation:batch-1', input:{ context:{ productMaturityBatchId:batchId } } };
  const payload = second.assertAuthorized({ mission, subtask:{ ...items[0], context:{ ...items[0].context, productMaturityAuthorization:authorization } } });
  assert.equal(payload.maxModelCalls, 4);
  assert.equal(payload.maxCostUsd, 0.08);
  assert.throws(() => second.assertAuthorized({ mission, subtask:{ ...items[0], agentId:'reviewer', context:{ ...items[0].context, productMaturityAuthorization:authorization } } }), /超出固定授权范围/);
  const task = {
    taskId:'technical-task-11111111-1111-4111-8111-111111111111',
    taskType:'operations.technical-repair',
    assigneeAgentId:'technical-expert',
    parentTaskId:mission.taskId,
    idempotencyKey:`${mission.idempotencyKey}:technical-expert`,
    source:{ eventRef:batchId, missionTaskId:mission.taskId },
    workflow:{ step:{ key:'technical-expert' } },
    input:{ title:'修复夹具', description:'只修复受控夹具。\n来自多人协作分工。验收：只修改一个文件。', platforms:[], contentGoal:null, context:{ missionTaskId:mission.taskId, dependsOn:['creator'], ...items[1].context, productMaturityAuthorization:authorization } },
  };
  assert.deepEqual(second.verifyTaskAuthorization({ mission, task }), {
    batchId,
    stepKey:'technical-expert',
    taskType:'operations.technical-repair',
    agentId:'technical-expert',
    maxModelCalls:0,
    maxCostUsd:0,
    costKnown:true,
    executionMode:'deterministic_fixture',
    sourceTaskIds:[],
    requiredSourceTaskIds:[],
  });
  assert.throws(() => second.verifyTaskAuthorization({ mission, task:{ ...task, input:{ ...task.input, context:{ ...task.input.context, repairScope:{ ...task.input.context.repairScope, testCommand:'node --test other.test.js' } } } } }), /确定性夹具修复/);
  assert.throws(() => second.verifyTaskAuthorization({ mission, task:{ ...task, input:{ ...task.input, context:{ ...task.input.context, paperclipRoutineKey:'m5-publish' } } } }), /合同之外/);
  assert.throws(() => second.verifyTaskAuthorization({ mission, task:{ ...task, assigneeAgentId:'reviewer' } }), /步骤、类型或岗位/);
  assert.throws(() => second.verifyTaskAuthorization({ mission, task:{ ...task, workflow:{ step:{ key:'creator' } } } }), /步骤、类型或岗位/);
  assert.throws(() => second.verifyTaskAuthorization({ mission, task:{ ...task, source:{ eventRef:'maturity-22222222-2222-4222-8222-222222222222' } } }), /不属于当前批次或总任务/);
  assert.throws(() => second.verifyTaskAuthorization({ mission, task:{ ...task, taskId:'parallel-sibling', idempotencyKey:`${mission.idempotencyKey}:technical-expert-replay` } }), /唯一分工标识/);
  const tampered = { ...authorization, token:`${authorization.token.split('.')[0]}.invalid` };
  assert.throws(() => second.verifyTaskAuthorization({ mission, task:{ ...task, input:{ context:{ ...task.input.context, productMaturityAuthorization:tampered } } } }), /签名无效/);
  assert.throws(() => second.assertAuthorized({ mission, subtask:{ key:'extra', taskType:'operations.health-review', agentId:'operator' } }), /第四个子任务/);
  assert.equal(second.assertAuthorized({ mission:{ input:{ context:{} } }, subtask:items[0] }), null);
});

test('普通业务上下文不能伪造产品成熟度授权字段', () => {
  assert.equal(normalizedProductMaturityContext({ repairScope:{ files:['a.js'] } }), undefined);
  assert.deepEqual(normalizedProductMaturityContext({ productMaturityAuthorization:{ kind:'product-maturity-validation', token:'signed' }, sourceTaskIds:['a', 'b', 'c'], requiredSourceTaskIds:[' source-a ', 'source-a', 'source-b', 'source-c'] }), {
    productMaturityAuthorization:{ kind:'product-maturity-validation', token:'signed' },
    sourceTaskIds:['a', 'b'],
    requiredSourceTaskIds:['source-a', 'source-b'],
  });
});

test('产品成熟度总任务只接受 A君 固定幂等键和三个同签名分工', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mission-root-policy-'));
  try {
    const policy = await MissionChildPolicy.open({ keyPath:path.join(root, 'policy.key') });
    const batchId = 'maturity-33333333-3333-4333-8333-333333333333';
    const authorization = policy.issue(batchId, items);
    const missionItems = items.map((item) => ({
      ...item,
      context:{ ...item.context, productMaturityAuthorization:authorization },
    }));
    const mission = {
      taskId:'mission-root-33333333-3333-4333-8333-333333333333',
      taskType:'army.cross-agent-mission',
      assigneeAgentId:'ajun',
      idempotencyKey:`product-maturity-validation:${batchId}`,
      source:{ channel:'product-maturity-validation', eventRef:batchId },
      input:{ title:'产品成熟度受控验证', context:{
        productMaturityBatchId:batchId,
        businessMissionItems:missionItems,
        businessMissionSummary:'产品成熟度受控验证',
        missionSafeOnly:true,
      } },
    };
    assert.deepEqual(policy.verifyMissionAuthorization(mission), {
      batchId,
      executionMode:'mission_plan',
      maxModelCalls:0,
      maxCostUsd:0,
      costKnown:true,
    });
    assert.throws(() => policy.verifyMissionAuthorization({ ...mission, assigneeAgentId:'creator' }), /总任务信封/);
    assert.throws(() => policy.verifyMissionAuthorization({ ...mission, idempotencyKey:'maturity:loose' }), /总任务信封/);
    assert.throws(() => policy.verifyMissionAuthorization({
      ...mission,
      input:{ ...mission.input, context:{ ...mission.input.context, businessMissionItems:missionItems.slice(0, 2) } },
    }), /三个固定签名分工/);
    assert.throws(() => policy.verifyMissionAuthorization({
      ...mission,
      input:{ ...mission.input, context:{
        ...mission.input.context,
        businessMissionItems:[...missionItems.slice(0, 2), {
          ...missionItems[2],
          context:{ ...missionItems[2].context, productMaturityAuthorization:{ ...authorization, token:`${authorization.token}x` } },
        }],
      } },
    }), /签名无效/);
  } finally {
    await fs.rm(root, { recursive:true, force:true });
  }
});

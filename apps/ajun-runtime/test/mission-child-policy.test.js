import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MissionChildPolicy, normalizedProductMaturityContext } from '../src/workflow/mission-child-policy.ts';

const items = [
  { key:'creator', taskType:'governance.agent-proposal', agentId:'creator' },
  { key:'technical-expert', taskType:'operations.technical-repair', agentId:'technical-expert' },
  { key:'content-creator', taskType:'content.video-script-package', agentId:'content-creator' },
];

test('产品成熟度授权只允许三个固定子任务并可跨实例校验', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mission-policy-'));
  const keyPath = path.join(root, 'policy.key');
  const first = await MissionChildPolicy.open({ keyPath });
  const authorization = first.issue('maturity-11111111-1111-4111-8111-111111111111', items);
  const second = await MissionChildPolicy.open({ keyPath });
  const batchId = 'maturity-11111111-1111-4111-8111-111111111111';
  const mission = { taskId:'mission-11111111-1111-4111-8111-111111111111', idempotencyKey:'product-maturity-validation:batch-1', input:{ context:{ productMaturityBatchId:batchId } } };
  const payload = second.assertAuthorized({ mission, subtask:{ ...items[0], context:{ productMaturityAuthorization:authorization } } });
  assert.equal(payload.maxModelCalls, 4);
  assert.equal(payload.maxCostUsd, 0.08);
  assert.throws(() => second.assertAuthorized({ mission, subtask:{ ...items[0], agentId:'reviewer', context:{ productMaturityAuthorization:authorization } } }), /超出固定授权范围/);
  const task = {
    taskId:'technical-task-11111111-1111-4111-8111-111111111111',
    taskType:'operations.technical-repair',
    assigneeAgentId:'technical-expert',
    parentTaskId:mission.taskId,
    idempotencyKey:`${mission.idempotencyKey}:technical-expert`,
    source:{ eventRef:batchId, missionTaskId:mission.taskId },
    workflow:{ step:{ key:'technical-expert' } },
    input:{ context:{ missionTaskId:mission.taskId, productMaturityAuthorization:authorization } },
  };
  assert.deepEqual(second.verifyTaskAuthorization({ mission, task }), {
    batchId,
    stepKey:'technical-expert',
    taskType:'operations.technical-repair',
    agentId:'technical-expert',
    maxModelCalls:4,
    maxCostUsd:0.08,
  });
  assert.throws(() => second.verifyTaskAuthorization({ mission, task:{ ...task, assigneeAgentId:'reviewer' } }), /步骤、类型或岗位/);
  assert.throws(() => second.verifyTaskAuthorization({ mission, task:{ ...task, workflow:{ step:{ key:'creator' } } } }), /步骤、类型或岗位/);
  assert.throws(() => second.verifyTaskAuthorization({ mission, task:{ ...task, source:{ eventRef:'maturity-22222222-2222-4222-8222-222222222222' } } }), /不属于当前批次或总任务/);
  assert.throws(() => second.verifyTaskAuthorization({ mission, task:{ ...task, taskId:'parallel-sibling', idempotencyKey:`${mission.idempotencyKey}:technical-expert-replay` } }), /唯一分工标识/);
  const tampered = { ...authorization, token:`${authorization.token.split('.')[0]}.invalid` };
  assert.throws(() => second.verifyTaskAuthorization({ mission, task:{ ...task, input:{ context:{ ...task.input.context, productMaturityAuthorization:tampered } } } }), /签名无效/);
});

test('普通业务上下文不能伪造产品成熟度授权字段', () => {
  assert.equal(normalizedProductMaturityContext({ repairScope:{ files:['a.js'] } }), undefined);
  assert.deepEqual(normalizedProductMaturityContext({ productMaturityAuthorization:{ kind:'product-maturity-validation', token:'signed' }, sourceTaskIds:['a', 'b', 'c'], requiredSourceTaskIds:[' source-a ', 'source-a', 'source-b', 'source-c'] }), {
    productMaturityAuthorization:{ kind:'product-maturity-validation', token:'signed' },
    sourceTaskIds:['a', 'b'],
    requiredSourceTaskIds:['source-a', 'source-b'],
  });
});

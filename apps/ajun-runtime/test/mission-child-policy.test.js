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
  const mission = { input:{ context:{ productMaturityBatchId:'maturity-11111111-1111-4111-8111-111111111111' } } };
  const payload = second.assertAuthorized({ mission, subtask:{ ...items[0], context:{ productMaturityAuthorization:authorization } } });
  assert.equal(payload.maxModelCalls, 4);
  assert.equal(payload.maxCostUsd, 0.08);
  assert.throws(() => second.assertAuthorized({ mission, subtask:{ ...items[0], agentId:'reviewer', context:{ productMaturityAuthorization:authorization } } }), /超出固定授权范围/);
});

test('普通业务上下文不能伪造产品成熟度授权字段', () => {
  assert.equal(normalizedProductMaturityContext({ repairScope:{ files:['a.js'] } }), undefined);
  assert.deepEqual(normalizedProductMaturityContext({ productMaturityAuthorization:{ kind:'product-maturity-validation', token:'signed' }, sourceTaskIds:['a', 'b', 'c'] }), {
    productMaturityAuthorization:{ kind:'product-maturity-validation', token:'signed' },
    sourceTaskIds:['a', 'b'],
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkHermesBusinessProfileHomes,
  evaluateHermesBusinessProfilePolicy,
} from '../scripts/check-hermes-business-profile-policy.mjs';

const compliantConfig = {
  display:{ platforms:{ feishu:{ memory_notifications:false } } },
  memory:{ nudge_interval:0, write_approval:true },
  skills:{ creation_nudge_interval:0, write_approval:true },
  curator:{ enabled:false },
};

test('正式业务 Profile 关闭隐式自改并保留显式审批', () => {
  assert.deepEqual(evaluateHermesBusinessProfilePolicy(compliantConfig), {
    compliant:true,
    violations:[],
  });
});

test('缺少字段和危险默认值都报告为漂移', () => {
  const result = evaluateHermesBusinessProfilePolicy({
    memory:{ nudge_interval:10, write_approval:false },
    skills:{ creation_nudge_interval:15 },
  });
  assert.equal(result.compliant, false);
  assert.deepEqual(
    result.violations.map((item) => item.key),
    [
      'display.platforms.feishu.memory_notifications',
      'memory.nudge_interval',
      'memory.write_approval',
      'skills.creation_nudge_interval',
      'skills.write_approval',
      'curator.enabled',
    ],
  );
});

test('检查器只读取明确指定的 Hermes Home', async () => {
  const reads = [];
  const results = await checkHermesBusinessProfileHomes(['/profiles/ajun'], {
    readFile:async (candidate) => {
      reads.push(candidate);
      return `
display:
  platforms:
    feishu:
      memory_notifications: false
memory:
  nudge_interval: 0
  write_approval: true
skills:
  creation_nudge_interval: 0
  write_approval: true
curator:
  enabled: false
`;
    },
  });
  assert.deepEqual(reads, ['/profiles/ajun/config.yaml']);
  assert.equal(results[0].compliant, true);
});

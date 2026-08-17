import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRuntimeHealth } from '../src/runtime-health.ts';
import { TaskOverview } from '../src/task-overview.ts';

test('可选能力 disabled 或 limited 不会把核心健康误判为 degraded', () => {
  const health = buildRuntimeHealth({
    checkedAt:'2026-08-17T00:00:00.000Z',
    core:[
      { id:'runtime', status:'healthy' },
      { id:'paperclip', status:'ready' },
    ],
    optional:[
      { id:'m5', status:'disabled', detail:'按需开启' },
      { id:'boom-monitor', status:'limited', detail:'自动扫描关闭' },
      { id:'publisher', status:'unavailable', detail:'未启动' },
    ],
    summary:{ employeeCount:17 },
  });

  assert.equal(health.status, 'healthy');
  assert.equal(health.core.status, 'healthy');
  assert.deepEqual(health.optional.components.map((item) => item.status), ['disabled', 'limited', 'unavailable']);
  assert.ok(Buffer.byteLength(JSON.stringify(health)) < 10 * 1024);
});

test('核心治理连接故障会明确降级，同时不回显底层异常', async () => {
  const overview = new TaskOverview({
    registry:{ list:async () => [{ agentId:'operator' }] },
    store:{},
    governance:{ async health() { throw new Error('secret token in transport'); } },
    skillExecutionRegistry:{},
  });

  const health = await overview.health({ optionalModules:[{ id:'m5', status:'disabled' }] });

  assert.equal(health.status, 'degraded');
  assert.equal(health.core.status, 'unavailable');
  assert.equal(health.core.components.find((item) => item.id === 'paperclip').status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(health), /secret token/);
  assert.ok(Buffer.byteLength(JSON.stringify(health)) < 10 * 1024);
});

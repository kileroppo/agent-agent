import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalHealthOperator } from '../src/local-health-operator.js';

test('运维官把A君、小D和总控的真实巡检结果合并成一份健康报告', async () => {
  const operator = new LocalHealthOperator({
    governance:{ async health() { return { status:'ready', version:'test' }; } },
    runtimeProbe:{ async check() { return [
      { id:'ajun-runtime', name:'A君运行台', status:'healthy', detail:'正常' },
      { id:'xiaod', name:'小D素材处理', status:'degraded', detail:'暂时不可用' }
    ]; } },
    now:() => new Date('2026-07-22T12:00:00.000Z')
  });
  const result = await operator.execute({ taskId:'health-1', input:{}, execution:{} });
  const report = result.artifactRefs[0].data;
  assert.equal(report.overall, 'degraded');
  assert.deepEqual(report.components.map((item) => item.id), ['ajun-runtime', 'xiaod', 'paperclip']);
  assert.match(report.recommendedAction, /先检查 Paperclip/);
  assert.equal(result.usage.tools.reduce((total, tool) => total + tool.calls, 0), 3);
});

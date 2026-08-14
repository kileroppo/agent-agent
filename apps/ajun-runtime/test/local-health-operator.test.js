import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalHealthOperator } from '../src/local-health-operator.ts';

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

test('运维官按登记依赖关联事件、选择安全恢复剧本并给出恢复后验证和回滚', async () => {
  const operator = new LocalHealthOperator({
    governance:{ async health() { return { status:'ready' }; } },
    componentRegistry:[
      { id:'ajun-runtime', dependencies:[], recoveryPlaybooks:['observe'] },
      { id:'xiaod', dependencies:['ajun-runtime'], recoveryPlaybooks:['retry_from_checkpoint'] }
    ],
    now:() => new Date('2026-07-29T12:00:00.000Z')
  });
  const result = await operator.execute({
    taskId:'recovery-1',
    taskType:'operations.failure-recovery',
    parentTaskId:'failed-1',
    input:{ context:{
      failedTaskId:'failed-1',
      componentId:'xiaod',
      sourceUrl:'https://example.com/video',
      attempt:0,
      maxAutomaticRetries:1,
      failure:{ code:'xiaod_job_failed', category:'transient_external_dependency', retryable:true },
      incidentEvents:[
        { eventId:'event-dependency', componentId:'ajun-runtime', code:'upstream_timeout', occurredAt:'2026-07-29T11:55:00.000Z' },
        { eventId:'event-old', componentId:'xiaod', code:'xiaod_job_failed', occurredAt:'2026-07-29T10:00:00.000Z' }
      ]
    } },
    execution:{}
  });
  const decision = result.artifactRefs[0].data;
  assert.equal(decision.action, 'retry_once');
  assert.equal(decision.component.registered, true);
  assert.deepEqual(decision.component.dependencies, ['ajun-runtime']);
  assert.equal(decision.incidentCorrelation.relatedEventCount, 1);
  assert.equal(decision.incidentCorrelation.relatedEvents[0].relation, 'dependency');
  assert.equal(decision.playbook.playbookId, 'retry_from_checkpoint');
  assert.equal(decision.postRecoveryVerification.length, 4);
  assert.match(decision.rollbackRecommendation, /停止继续尝试/);
  assert.equal(decision.unknownOrHighRiskActionExecuted, false);
});

test('运维官不对未登记组件或高风险故障执行未知恢复动作', async () => {
  const operator = new LocalHealthOperator({ governance:{ async health() { return { status:'ready' }; } } });
  const decision = (await operator.execute({
    taskId:'recovery-risk',
    taskType:'operations.failure-recovery',
    input:{ context:{
      componentId:'unknown-payment-service',
      sourceUrl:'https://example.com',
      attempt:0,
      maxAutomaticRetries:3,
      failure:{ code:'credential_denied', category:'authorization_or_permission', retryable:true, highRisk:true }
    } },
    execution:{}
  })).artifactRefs[0].data;
  assert.equal(decision.action, 'escalate_technical_expert');
  assert.equal(decision.executionAuthorized, false);
  assert.equal(decision.component.registered, false);
  assert.equal(decision.playbook.externalSideEffects, false);
  assert.match(decision.rollbackRecommendation, /不执行未知恢复动作/);
});

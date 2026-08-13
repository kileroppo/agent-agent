import test from 'node:test';
import assert from 'node:assert/strict';
import { orchestrateDeliveryQuality } from '../src/workflow/delivery-quality-orchestrator.ts';

function completedResearch(overrides = {}) {
  return {
    taskId:'research-task-1',
    taskType:'research.intel-report',
    status:'succeeded',
    input:{ title:'比较公开方案' },
    artifactRefs:[
      { artifactId:'report-v1', type:'intel_research_report', validation:{ sha256:'hash-v1' }, data:{ privateBody:'不得透传' } },
    ],
    ...overrides,
  };
}

function reviewerResult(overrides = {}) {
  return {
    reviewerAgentId:'reviewer',
    sourceTaskId:'research-task-1',
    status:'passed',
    evidenceRefs:['artifact:report-v1'],
    ...overrides,
  };
}

test('重要任务生成可创建且幂等的独立 reviewer 子任务请求', () => {
  const task = completedResearch({
    artifactRefs:[
      { artifactId:'report-v2', type:'report', contentHash:'hash-v2' },
      { artifactId:'report-v1', type:'report', contentHash:'hash-v1', data:{ privateBody:'secret' } },
    ],
  });
  const first = orchestrateDeliveryQuality({ completedTask:task });
  const replay = orchestrateDeliveryQuality({
    completedTask:{ ...task, artifactRefs:[...task.artifactRefs].reverse() },
  });

  assert.equal(first.action, 'request_review');
  assert.equal(first.reviewTaskRequest.taskType, 'governance.assurance-review');
  assert.equal(first.reviewTaskRequest.agentId, 'reviewer');
  assert.equal(first.reviewTaskRequest.parentTaskId, task.taskId);
  assert.equal(first.reviewTaskRequest.idempotencyKey, replay.reviewTaskRequest.idempotencyKey);
  assert.equal(first.idempotencyKey, replay.idempotencyKey);
  assert.deepEqual(first.reviewTaskRequest.context.artifactRefs.map((item) => item.artifactId), ['report-v1', 'report-v2']);
  assert.doesNotMatch(JSON.stringify(first), /privateBody|secret/);
});

test('标准任务完成岗位自检后等待采用，不虚构独立复核', () => {
  const result = orchestrateDeliveryQuality({
    completedTask:{
      taskId:'media-task-1',
      taskType:'media.transcribe-and-refine',
      status:'succeeded',
      input:{ title:'整理音频转录稿' },
      sourceUrl:'https://example.com/audio',
      artifactRefs:[{ artifactId:'transcript-v1', type:'transcript' }],
    },
  });

  assert.equal(result.action, 'accept');
  assert.equal(result.workflowStatus, 'waiting_acceptance');
  assert.equal(result.reviewTaskRequest, null);
});

test('通过的独立复核绑定原任务后进入等待采用', () => {
  const result = orchestrateDeliveryQuality({
    completedTask:completedResearch(),
    reviewResult:reviewerResult(),
  });

  assert.equal(result.action, 'accept');
  assert.equal(result.review.status, 'passed');
  assert.equal(result.revisionDecision.action, 'accept');
  assert.equal(result.workflowStatus, 'waiting_acceptance');
});

test('失败项只触发定向返工并保留全部旧产物引用', () => {
  const task = completedResearch({
    rootTaskId:'research-root-1',
    artifactRefs:[
      { artifactId:'report-v1', type:'report', data:{ body:'old version' } },
      { artifactId:'source-index-v1', type:'source_index' },
    ],
  });
  const result = orchestrateDeliveryQuality({
    completedTask:task,
    reviewResult:reviewerResult({
      status:'revise',
      failedCriteria:['claims_evidence_bound'],
    }),
    revisionRound:0,
  });

  assert.equal(result.action, 'revise');
  assert.equal(result.revisionDirective.revisionRound, 1);
  assert.deepEqual(result.revisionDirective.failedCriteria, ['claims_evidence_bound']);
  assert.equal(result.revisionDirective.preservePassedContent, true);
  assert.deepEqual(result.revisionDirective.sourceArtifactRefs, [
    { artifactId:'report-v1', type:'report' },
    { artifactId:'source-index-v1', type:'source_index' },
  ]);
  assert.doesNotMatch(JSON.stringify(result.revisionDirective), /old version/);
});

test('最多两轮返工，额度耗尽后安全停止并保留可用版本', () => {
  const input = {
    completedTask:completedResearch(),
    reviewResult:reviewerResult({ status:'revise', failedCriteria:['counter_evidence_checked'] }),
  };
  const first = orchestrateDeliveryQuality({ ...input, revisionRound:0 });
  const second = orchestrateDeliveryQuality({ ...input, revisionRound:1 });
  const exhausted = orchestrateDeliveryQuality({ ...input, revisionRound:2 });

  assert.equal(first.revisionDirective.revisionRound, 1);
  assert.equal(second.revisionDirective.revisionRound, 2);
  assert.equal(exhausted.action, 'stop');
  assert.equal(exhausted.workflowStatus, 'partial');
  assert.equal(exhausted.revisionDirective, null);
  assert.match(exhausted.reason, /两轮/);
});

test('跨任务或非 reviewer 的复核不能放行，也不能触发自动返工', () => {
  for (const reviewResult of [
    reviewerResult({ sourceTaskId:'another-task' }),
    reviewerResult({ reviewerAgentId:'creator' }),
  ]) {
    const result = orchestrateDeliveryQuality({
      completedTask:completedResearch(),
      reviewResult,
    });
    assert.equal(result.action, 'stop');
    assert.equal(result.workflowStatus, 'waiting_validation');
    assert.equal(result.revisionDirective, null);
    assert.match(result.reason, /独立 reviewer/);
  }
});

test('未完成、缺少 taskId、缺少产物或复核 pending 都保守停止', () => {
  const cases = [
    orchestrateDeliveryQuality({ completedTask:completedResearch({ status:'running' }) }),
    orchestrateDeliveryQuality({ completedTask:completedResearch({ taskId:undefined }) }),
    orchestrateDeliveryQuality({ completedTask:completedResearch({ artifactRefs:[] }) }),
    orchestrateDeliveryQuality({ completedTask:completedResearch(), reviewResult:reviewerResult({ status:'pending' }) }),
  ];
  assert.deepEqual(cases.map((item) => item.action), ['stop', 'stop', 'stop', 'stop']);
  assert.deepEqual(cases.map((item) => item.workflowStatus), [
    'waiting_validation',
    'waiting_validation',
    'waiting_validation',
    'partial',
  ]);
});

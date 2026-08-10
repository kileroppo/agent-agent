import test from 'node:test';
import assert from 'node:assert/strict';
import { buildValidationCampaign } from '../src/workflow/validation-campaign.ts';

const verifiedArtifact = Object.freeze({
  validation:{ exists:true, readable:true, nonEmpty:true },
});

test('验证组汇总晚于当前失败的最新已验证任务证据', () => {
  const campaign = buildValidationCampaign([
    {
      taskId:'research-failure',
      taskType:'research.intel-report',
      status:'failed',
      assigneeAgentId:'legacy-researcher',
      updatedAt:'2026-08-01T00:00:00.000Z',
    },
    {
      taskId:'research-success-old',
      taskType:'research.intel-report',
      status:'succeeded',
      assigneeAgentId:'current-researcher',
      updatedAt:'2026-08-02T00:00:00.000Z',
      artifactRefs:[verifiedArtifact],
    },
    {
      taskId:'research-success-latest',
      taskType:'research.intel-report',
      status:'succeeded',
      assigneeAgentId:'current-researcher',
      updatedAt:'2026-08-03T00:00:00.000Z',
      artifactRefs:[verifiedArtifact],
    },
    {
      taskId:'excluded-acceptance-failure',
      taskType:'research.intel-report',
      status:'failed',
      source:{ channel:'test' },
      updatedAt:'2026-08-04T00:00:00.000Z',
    },
  ]);

  assert.deepEqual(campaign.groups[0].evidence, {
    verifiedSuccessCount:2,
    latestVerifiedTaskId:'research-success-latest',
    latestVerifiedAt:'2026-08-03T00:00:00.000Z',
    latestFailureTaskId:'research-failure',
    latestFailureAt:'2026-08-01T00:00:00.000Z',
    freshness:'later_than_latest_failure',
  });
});

test('已验证成功缺少可比较时间时不猜测证据新鲜度', () => {
  const campaign = buildValidationCampaign([
    {
      taskId:'analysis-failure',
      taskType:'content.video-benchmark-analysis',
      status:'failed',
      updatedAt:'2026-08-05T00:00:00.000Z',
    },
    {
      taskId:'analysis-success-without-time',
      taskType:'content.video-benchmark-analysis',
      status:'succeeded',
      artifactRefs:[verifiedArtifact],
    },
    {
      taskId:'analysis-configured-only',
      taskType:'content.video-benchmark-analysis',
      status:'succeeded',
      updatedAt:'2026-08-06T00:00:00.000Z',
      artifactRefs:[],
      configuration:{ enabled:true },
    },
  ]);

  assert.deepEqual(campaign.groups[0].evidence, {
    verifiedSuccessCount:1,
    latestVerifiedTaskId:null,
    latestVerifiedAt:null,
    latestFailureTaskId:'analysis-failure',
    latestFailureAt:'2026-08-05T00:00:00.000Z',
    freshness:'none',
  });
});

test('自动化验收与 fixture 成功记录不能冒充 live 验证证据', () => {
  const campaign = buildValidationCampaign([
    {
      taskId:'draft-failure',
      taskType:'content.platform-draft',
      status:'failed',
      assigneeAgentId:'legacy-creator',
      updatedAt:'2026-08-01T00:00:00.000Z',
      input:{ context:{ sourceTaskIds:['source-task'] } },
    },
    {
      taskId:'acceptance-success',
      taskType:'content.platform-draft',
      status:'succeeded',
      assigneeAgentId:'test-runner',
      source:{ channel:'acceptance-suite' },
      updatedAt:'2026-08-02T00:00:00.000Z',
      artifactRefs:[verifiedArtifact],
    },
    {
      taskId:'fixture-success',
      taskType:'content.platform-draft',
      status:'succeeded',
      assigneeAgentId:'test-runner',
      idempotencyKey:'fixture:content-draft',
      updatedAt:'2026-08-03T00:00:00.000Z',
      artifactRefs:[verifiedArtifact],
    },
  ]);

  assert.deepEqual(campaign.groups[0].evidence, {
    verifiedSuccessCount:0,
    latestVerifiedTaskId:null,
    latestVerifiedAt:null,
    latestFailureTaskId:'draft-failure',
    latestFailureAt:'2026-08-01T00:00:00.000Z',
    freshness:'none',
  });
});

test('fallback 验证组只统计同任务类型的已验证成功证据', () => {
  const campaign = buildValidationCampaign([
    {
      taskId:'custom-failure',
      taskType:'custom.data-cleanup',
      status:'failed',
      updatedAt:'2026-08-05T00:00:00.000Z',
    },
    {
      taskId:'custom-success',
      taskType:'custom.data-cleanup',
      status:'succeeded',
      updatedAt:'2026-08-01T00:00:00.000Z',
      artifactRefs:[verifiedArtifact],
    },
    {
      taskId:'unrelated-live-success',
      taskType:'research.intel-report',
      status:'succeeded',
      updatedAt:'2026-08-06T00:00:00.000Z',
      artifactRefs:[verifiedArtifact],
    },
    {
      taskId:'custom-tests-only',
      taskType:'custom.data-cleanup',
      status:'succeeded',
      updatedAt:'2026-08-07T00:00:00.000Z',
      artifactRefs:[{ validation:{ testsPassed:true } }],
      configuration:{ enabled:true },
    },
  ]);

  assert.deepEqual(campaign.groups[0].evidence, {
    verifiedSuccessCount:1,
    latestVerifiedTaskId:'custom-success',
    latestVerifiedAt:'2026-08-01T00:00:00.000Z',
    latestFailureTaskId:'custom-failure',
    latestFailureAt:'2026-08-05T00:00:00.000Z',
    freshness:'predates_latest_failure',
  });
});

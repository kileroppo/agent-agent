import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkflowLink } from '../src/workflow/contracts.ts';
import { decideCapability } from '../src/workflow/capability-policy.ts';
import { CapabilityExecutionEngine } from '../src/workflow/capability-execution.ts';
import { evaluateWorkflow, evaluateWorkflowTasks } from '../src/workflow/evaluation.ts';
import { agentCapabilityTruth } from '../src/workflow/capability-truth.ts';
import { summarizeBacklog } from '../src/workflow/backlog-classification.ts';
import { buildValidationCampaign } from '../src/workflow/validation-campaign.ts';
import { createLocalAiCapabilityAdapter } from '../src/adapters/local-ai-capability-adapter.ts';

function capabilityRequest(overrides = {}) {
  return {
    requestId:'request-1',
    workflowId:'workflow-1',
    stepId:'step-analysis',
    taskId:'task-1',
    agentId:'video-content-analyst',
    capabilityId:'vision.analyze',
    dataClass:'local-controlled',
    sideEffect:'read',
    maxCostUsd:0,
    costKnown:true,
    crossDevice:false,
    requiresCredentials:false,
    ...overrides,
  };
}

const policy = {
  manifestCapabilities:['vision.analyze'],
  taskBudgetUsd:5,
  agentApprovalThresholdUsd:5,
  projectBudgetRemainingUsd:20,
  companyBudgetRemainingUsd:100,
};

test('业务任务获得稳定Workflow与步骤身份，旧任务类型保持兼容', () => {
  const first = createWorkflowLink({
    taskType:'content.video-benchmark-analysis',
    idempotencyKey:'feishu:event-1',
  });
  const replay = createWorkflowLink({
    taskType:'content.video-benchmark-analysis',
    idempotencyKey:'feishu:event-1',
  });
  assert.deepEqual(first, replay);
  assert.equal(first.workflowType, 'content-production');
  assert.equal(first.step.key, 'analysis');
});

test('Policy只自动允许已登记、同机只读且预算内的能力', () => {
  assert.equal(decideCapability(capabilityRequest(), policy).outcome, 'auto_allow');
  assert.equal(decideCapability(capabilityRequest({ capabilityId:'image.generate' }), policy).outcome, 'deny');
  assert.equal(decideCapability(capabilityRequest({ dataClass:'private' }), policy).outcome, 'human_local');
  assert.equal(decideCapability(capabilityRequest({ crossDevice:true }), policy).outcome, 'human_local');
  assert.equal(decideCapability(capabilityRequest({ sideEffect:'external-write' }), policy).outcome, 'human_paperclip');
  assert.equal(decideCapability(capabilityRequest({ maxCostUsd:6 }), policy).outcome, 'human_paperclip');
  assert.equal(decideCapability(capabilityRequest({ maxCostUsd:1, costKnown:false }), policy).outcome, 'human_paperclip');
});

test('受控能力执行只做一次恢复和一次重试，并生成不含原始输入的凭证', async () => {
  let calls = 0;
  let recoveries = 0;
  const engine = new CapabilityExecutionEngine({
    adapter:{
      adapterId:'local-ai',
      async invoke() {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('暂时不可用'), { code:'local_model_failed' });
        return { output:{ text:'已识别画面' }, provider:'local-qwen', costUsd:0 };
      },
      async recover() {
        recoveries += 1;
        return 'recovered';
      },
    },
    now:() => new Date('2026-08-10T00:00:00.000Z'),
  });
  const result = await engine.invoke({
    request:capabilityRequest(),
    policy,
    payload:{ imagePaths:['/private/example.jpg'], prompt:'识别' },
  });
  assert.equal(calls, 2);
  assert.equal(recoveries, 1);
  assert.equal(result.receipt.attempts, 2);
  assert.equal(result.receipt.recovered, true);
  assert.equal(result.receipt.costUsd, 0);
  assert.doesNotMatch(JSON.stringify(result.receipt), /private\/example/);
});

test('本机 AI Adapter 固定同机、禁止桌面回退且不伪造人工批准', async () => {
  const invokes = [];
  const controls = [];
  const adapter = createLocalAiCapabilityAdapter({
    async invoke(input) { invokes.push(input); return { provider:'local-qwen', result:{ text:'ok' } }; },
    async controlService(serviceId, action) { controls.push([serviceId, action]); return {}; },
  });
  await adapter.invoke({ request:capabilityRequest({ capabilityId:'vision.analyze' }), payload:{ imagePaths:['/private/frame.jpg'] }, options:{}, attempt:1 });
  assert.equal(invokes[0].approved, false);
  assert.deepEqual(invokes[0].options, { preferredNode:'mac', allowDesktopFallback:false });
  assert.equal(await adapter.recover({ request:capabilityRequest({ capabilityId:'vision.analyze' }), errorCode:'local_ai_gateway_unavailable' }), 'recovered');
  assert.deepEqual(controls, [['gateway', 'start'], ['qwen35', 'restart']]);
});

test('Workflow成功必须同时有可验证产物，质量任务随后等待人工验收', () => {
  const workflow = createWorkflowLink({ taskType:'research.intel-report', idempotencyKey:'research-1' });
  const evaluations = evaluateWorkflowTasks([{
    taskId:'task-research',
    taskType:'research.intel-report',
    assigneeAgentId:'intel-researcher',
    status:'succeeded',
    workflow,
    artifactRefs:[{
      artifactId:'report-1',
      type:'intel_research_report',
      validation:{ exists:true, readable:true, nonEmpty:true },
    }],
  }]);
  assert.equal(evaluations[0].status, 'waiting_acceptance');
  assert.equal(evaluations[0].requiredStepsComplete, true);
  assert.equal(evaluations[0].ownerAction, '验收已经生成的业务产物');
});

test('研究产物的多路搜索或反证门禁失败时不能冒充 Workflow 已验证', () => {
  const workflow = createWorkflowLink({ taskType:'research.intel-report', idempotencyKey:'research-gate' });
  const evaluation = evaluateWorkflow(workflow.workflowId, [{
    taskId:'research-gate', taskType:'research.intel-report', status:'succeeded', workflow,
    artifactRefs:[{
      artifactId:'report-1', type:'intel_research_report',
      validation:{ exists:true, readable:true, nonEmpty:true, claimEvidenceBound:true, searchDiversityMet:false, counterEvidenceSearched:true },
    }],
  }]);
  assert.equal(evaluation.requiredStepsComplete, false);
  assert.equal(evaluation.verifiedArtifactCount, 0);
  assert.equal(evaluation.status, 'waiting_acceptance');
});

test('Agent状态从真实任务证据派生，Manifest active本身不等于已验证', () => {
  const agent = {
    agentId:'intel-researcher',
    status:'active',
    acceptedTaskTypes:['research.intel-report'],
    runtimeCapabilities:{ modelSelection:{ model:'deepseek-v4-flash' } },
  };
  const unverified = agentCapabilityTruth({ agent, tasks:[] });
  assert.equal(unverified.overall, 'configured');
  assert.equal(unverified.verified, false);
  const verified = agentCapabilityTruth({ agent, tasks:[{
    taskId:'task-1',
    assigneeAgentId:'intel-researcher',
    status:'succeeded',
    updatedAt:'2026-08-10T00:00:00.000Z',
    artifactRefs:[{ validation:{ exists:true, readable:true, nonEmpty:true } }],
  }] });
  assert.equal(verified.verified, true);
  assert.equal(verified.evidenceTaskId, 'task-1');
});

test('历史任务拆分为归档取消、待复验和仍失败，并识别后来成功的同源任务', () => {
  const summary = summarizeBacklog([
    { taskId:'a', status:'running', taskType:'research.intel-report' },
    { taskId:'b', status:'needs_input', taskType:'office.presentation-package' },
    { taskId:'c', status:'failed', taskType:'content.campaign-visual-analysis' },
    { taskId:'d', status:'failed', taskType:'research.github-search' },
    { taskId:'e', status:'cancelled', taskType:'governance.architecture-review' },
    { taskId:'f', status:'waiting_test', taskType:'operations.health-review' },
    { taskId:'g-old', status:'failed', taskType:'media.transcribe-and-refine', input:{ sourceUrl:'https://example.com/video' }, updatedAt:'2026-08-01T00:00:00.000Z' },
    { taskId:'g-new', status:'succeeded', taskType:'media.transcribe-and-refine', input:{ sourceUrl:'https://example.com/video' }, updatedAt:'2026-08-02T00:00:00.000Z' },
    { taskId:'h-old', status:'failed', taskType:'governance.architecture-review', assigneeAgentId:'architect', updatedAt:'2026-08-01T00:00:00.000Z' },
    { taskId:'h-new', status:'succeeded', taskType:'governance.architecture-review', assigneeAgentId:'architect', updatedAt:'2026-08-02T00:00:00.000Z', artifactRefs:[{ validation:{ exists:true, readable:true, nonEmpty:true } }] },
    { taskId:'i-old', status:'failed', taskType:'report.public-material', assigneeAgentId:'candidate', updatedAt:'2026-08-01T00:00:00.000Z' },
    { taskId:'i-new', status:'succeeded', taskType:'report.public-material', assigneeAgentId:'candidate', updatedAt:'2026-08-02T00:00:00.000Z', artifactRefs:[{ validation:{ exists:true, readable:true, nonEmpty:false } }] },
    { taskId:'j', status:'failed', taskType:'report.public-material', error:{ code:'controlled_public_report_failure' } },
    { taskId:'k', status:'waiting_test', taskType:'content.platform-draft', input:{ title:'M5 8分：真实StepFun多模态付费探针' } },
  ]);
  assert.equal(summary.counts.current, 1);
  assert.equal(summary.counts.needs_human, 1);
  assert.equal(summary.counts.intentionally_disabled, 1);
  assert.equal(summary.counts.archived_cancelled, 1);
  assert.equal(summary.counts.needs_reverification, 1);
  assert.equal(summary.counts.superseded, 1);
  assert.equal(summary.counts.validated_by_later_evidence, 1);
  assert.equal(summary.counts.expected_acceptance_failure, 2);
  assert.equal(summary.counts.unresolved_failure, 2);
  assert.equal(summary.counts.unresolved, 0);
  assert.equal(summary.reviewBacklog, 3);
  assert.equal(summary.verificationBacklog, 1);
  assert.equal(summary.unresolvedFailures, 2);
  assert.equal(summary.historicalArchived, 4);
  assert.equal(summary.validatedByLaterEvidence, 1);
  assert.equal(summary.ownerActionable, 1);
});

test('正式委托任务和已激活岗位草案可作为旧验证任务的后续证据', () => {
  const summary = summarizeBacklog([
    { taskId:'incident-old', status:'waiting_test', taskType:'operations.incident-response', assigneeAgentId:'operator', updatedAt:'2026-08-01T00:00:00.000Z' },
    { taskId:'health-new', status:'succeeded', taskType:'operations.health-review', assigneeAgentId:'operator', updatedAt:'2026-08-02T00:00:00.000Z', artifactRefs:[{ validation:{ exists:true, readable:true, nonEmpty:true } }] },
    { taskId:'proposal-old', status:'failed', taskType:'governance.agent-proposal', assigneeAgentId:'creator', input:{ title:'创建微信聊天取件员岗位草案' }, updatedAt:'2026-08-01T00:00:00.000Z' },
  ], {
    taskTypeDelegates:{ 'operations.incident-response':'operations.health-review' },
    proposals:[{ status:'active', updatedAt:'2026-08-03T00:00:00.000Z', candidateManifest:{ name:'微信聊天取件员' } }],
  });
  assert.equal(summary.counts.validated_by_later_evidence, 2);
  assert.equal(summary.reviewBacklog, 0);
  assert.equal(summary.validatedByLaterEvidence, 2);
});

test('待验证任务按能力链路生成 AI 与人工结合的可执行验证账本', () => {
  const campaign = buildValidationCampaign([
    { taskId:'research', status:'failed', taskType:'research.intel-report' },
    { taskId:'mission', status:'failed', taskType:'army.cross-agent-mission', input:{ title:'公开视频精华拆解' } },
    { taskId:'analysis', status:'failed', taskType:'content.video-benchmark-analysis' },
    { taskId:'draft', status:'failed', taskType:'content.platform-draft' },
    { taskId:'recovery', status:'failed', taskType:'operations.failure-recovery' },
    { taskId:'repair', status:'failed', taskType:'operations.technical-repair' },
    { taskId:'done', status:'succeeded', taskType:'content.platform-draft' },
  ]);
  assert.equal(campaign.taskCount, 6);
  assert.equal(campaign.groupCount, 5);
  assert.equal(campaign.readyForAutomation, 2);
  assert.equal(campaign.requiresExplicitAuthority, 4);
  assert.deepEqual(campaign.groups.find((item) => item.id === 'video-analysis')?.taskIds, ['mission', 'analysis']);
  assert.match(campaign.groups.find((item) => item.id === 'technical-repair')?.failureAction || '', /停止修改/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { setupTaskService as setup } from './support/task-service-fixture.js';

test('M5 Hermes 阶段必须把专用产物写回同一 Case 后才能完成 Issue', async () => {
  const caseId = '12345678-abcd-4abc-8abc-1234567890ab';
  const outputs = [];
  const completions = [];
  let workProductValidations = 0;
  const identity = {
    issue:{
      id:'paperclip-issue-m5-topic',
      identifier:'AGE-M5-TOPIC',
      title:'M5 / 选题',
      description:`[agent-army:m5:routine:m5-topic] 处理选题阶段；当前 Case 为 ${caseId}，版本为 1。`,
    },
    run:{ id:'paperclip-run-m5-topic' },
    paperclipAgent:{ id:'paperclip-agent-m5-ajun', name:'A君' },
    agentArmyId:'ajun',
  };
  const governance = {
    async verifyHermesAssignment() { return identity; },
    async getPipelineCase() {
      return {
        id:caseId,
        stageKey:'topic',
        fields:{ theme:'AI Agent 真实失败恢复', scheduledDate:'2026-07-31' },
      };
    },
    async getPipelineCaseOutputs() { return outputs; },
    async createIssueWorkProduct(issueId, product) {
      assert.equal(issueId, identity.issue.id);
      outputs.push({ kind:'work_product', ...product });
      return product;
    },
    async completePaperclipIssue(issueId, input) {
      completions.push({ issueId, input });
    },
  };
  const agent = {
    agentId:'ajun',
    name:'A君',
    status:'active',
    acceptedTaskTypes:['content.campaign-topic'],
    interaction:{ runtime:'hermes-profile', directFeishu:'required' },
    executionOwner:'paperclip-hermes',
  };
  const { service } = setup({
    agents:[agent],
    governance,
    m5WorkProductValidator:async ({ product, targetCaseId, task }) => {
      workProductValidations += 1;
      assert.equal(product, outputs[0]);
      assert.equal(targetCaseId, caseId);
      assert.equal(product.metadata.sourceTaskId, task.taskId);
    },
  });
  service.executors.ajun = {
    async execute(task) {
      return {
        status:'succeeded',
        currentStage:'campaign_topic_selected',
        artifactRefs:[{
          artifactId:`topic-selection:${task.taskId}`,
          taskId:task.taskId,
          type:'topic_selection',
          title:'M5 选题',
          validation:{ exists:true, readable:true, nonEmpty:true },
          data:{
            schemaVersion:'agent.army/topic-selection/v1',
            theme:task.input.topic,
            requiredSources:{ minimum:2 },
          },
        }],
      };
    },
  };
  const input = {
    issueId:identity.issue.id,
    runId:identity.run.id,
    paperclipAgentId:identity.paperclipAgent.id,
    agentArmyId:'ajun',
  };
  await service.executeEmployeeAssignment(input);
  const completed = await service.completePaperclipAssignment({
    ...input,
    status:'succeeded',
    summary:'已选择当日主题并声明证据门禁。',
  });

  assert.equal(completed.task.status, 'waiting_test');
  assert.equal(completed.task.currentStage, 'delivery_quality_review_start_failed');
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].provider, 'agent-army.ajun-runtime');
  assert.equal(outputs[0].metadata.schemaVersion, 'agent.army/topic-selection/v1');
  assert.equal(outputs[0].metadata.kind, 'TopicSelection');
  assert.equal(outputs[0].metadata.artifact.theme, 'AI Agent 真实失败恢复');
  assert.match(outputs[0].metadata.artifactHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(completions.length, 0);

  const duplicate = await service.completePaperclipAssignment({
    ...input,
    status:'succeeded',
    summary:'重复回报。',
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(outputs.length, 1);
  assert.equal(completions.length, 1);
  assert.equal(workProductValidations, 2);
});

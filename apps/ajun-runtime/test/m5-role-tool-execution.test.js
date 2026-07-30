import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskService } from '../src/task-service.js';

const IDS = Object.freeze({
  issue:'11111111-1111-4111-8111-111111111111',
  run:'22222222-2222-4222-8222-222222222222',
  agent:'33333333-3333-4333-8333-333333333333',
  project:'44444444-4444-4444-8444-444444444444',
  workspace:'55555555-5555-4555-8555-555555555555',
  case:'66666666-6666-4666-8666-666666666666',
});

test('employee_assignment_execute 从已核验 Paperclip run 编译岗位 grant 并只走注入适配器', async () => {
  const calls = [];
  const fixture = setup({
    adapters:{
      'ajun-public-fetch':async ({ access }) => {
        calls.push(access);
        return { ok:true };
      },
    },
    executor:{
      async execute(_task, { roleToolContext }) {
        await roleToolContext.execute({
          toolId:'content.public.fetch',
          externalSideEffect:'network-read',
          url:'https://example.com/public',
        });
        return succeeded();
      },
    },
  });
  const result = await fixture.service.executeEmployeeAssignment(identityInput());
  assert.equal(result.result.recommendedCompletionStatus, 'succeeded');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executionWorkspaceId, IDS.workspace);
  assert.equal(calls[0].url, 'https://example.com/public');
});

test('executor 只 authorize 后旁路执行不再成立：未调用适配器即失败关闭', async () => {
  let directCalls = 0;
  const fixture = setup({
    adapters:{ 'ajun-public-fetch':async () => ({ ok:true }) },
    executor:{
      async execute() {
        directCalls += 1;
        return succeeded();
      },
    },
  });
  const result = await fixture.service.executeEmployeeAssignment(identityInput());
  assert.equal(directCalls, 1);
  assert.equal(result.result.recommendedCompletionStatus, 'failed');
  assert.equal(result.result.error.code, 'role_tool_not_enforced');
});

test('声明的适配器未注入时不执行任何旁路网络调用', async () => {
  let bypassCalls = 0;
  const fixture = setup({
    adapters:{},
    executor:{
      async execute(_task, { roleToolContext }) {
        await roleToolContext.execute({
          toolId:'content.public.fetch',
          externalSideEffect:'network-read',
          url:'https://example.com/public',
        });
        bypassCalls += 1;
        return succeeded();
      },
    },
  });
  const result = await fixture.service.executeEmployeeAssignment(identityInput());
  assert.equal(bypassCalls, 0);
  assert.equal(result.result.recommendedCompletionStatus, 'failed');
  assert.equal(result.result.error.code, 'role_tool_adapter_unavailable');
});

test('缺少 Paperclip execution workspace 时在进入岗位执行器前拒绝', async () => {
  let executions = 0;
  const fixture = setup({
    run:{ id:IDS.run },
    adapters:{ 'ajun-public-fetch':async () => ({ ok:true }) },
    executor:{ async execute() { executions += 1; return succeeded(); } },
  });
  await assert.rejects(
    fixture.service.executeEmployeeAssignment(identityInput()),
    /executionWorkspaceId 必须来自 Paperclip 当前指派/,
  );
  assert.equal(executions, 0);
});

function setup({
  adapters,
  executor,
  run = {
    id:IDS.run,
    environmentLease:{ executionWorkspaceId:IDS.workspace },
  },
} = {}) {
  const manifest = {
    schemaVersion:'agent.army/v1',
    agentId:'intel-researcher',
    status:'active',
    acceptedTaskTypes:['content.campaign-research'],
    interaction:{ runtime:'hermes-profile', directFeishu:'required' },
    executionOwner:'paperclip-hermes',
    runtimeProfileRef:'integrations/hermes/profiles/intel-researcher.profile.json',
    toolAllowlist:['content.public.fetch'],
    toolExecutionPolicy:{
      unknownToolDecision:'deny',
      workspace:{ scope:'paperclip-execution-workspace', pathMode:'relative-only' },
      grants:{
        'content.public.fetch':{
          adapter:'ajun-public-fetch',
          access:'read',
          externalSideEffect:'network-read',
        },
      },
    },
  };
  const profile = {
    profileId:'intel-researcher',
    agentManifestRef:'agents/intel-researcher/manifest.json',
    toolAllowlist:['content.public.fetch'],
    localProfile:{ skillsSeeded:false },
  };
  const tasks = [];
  const store = {
    async list() { return tasks; },
    async createTask(input) {
      const task = { taskId:`task-${tasks.length + 1}`, artifactRefs:[], ...input };
      tasks.push(task);
      return task;
    },
    async updateTask(taskId, patch) {
      const task = tasks.find((item) => item.taskId === taskId);
      Object.assign(task, patch);
      return task;
    },
  };
  const identity = {
    issue:{
      id:IDS.issue,
      projectId:IDS.project,
      title:'M5 / 研究',
      description:`[agent-army:m5:routine:m5-research] 当前 Case 为 ${IDS.case}。`,
    },
    run,
    paperclipAgent:{ id:IDS.agent, name:'小R' },
    agentArmyId:'intel-researcher',
  };
  const governance = {
    async verifyHermesAssignment() { return identity; },
    async getPipelineCase() {
      return { id:IDS.case, projectId:IDS.project, fields:{ theme:'公开 Agent 治理' } };
    },
    async getExecutionWorkspace(workspaceId) {
      assert.equal(workspaceId, IDS.workspace);
      return { id:workspaceId, cwd:'/tmp/agent-army-role-tool-fixture' };
    },
  };
  const registry = {
    async get(agentId) { return agentId === manifest.agentId ? manifest : null; },
    async list() { return [manifest]; },
    async runtimeProfile() { return profile; },
  };
  return {
    service:new TaskService({
      registry,
      store,
      governance,
      roleToolAdapters:adapters,
      executors:{ 'intel-researcher':executor },
    }),
  };
}

function identityInput() {
  return {
    issueId:IDS.issue,
    runId:IDS.run,
    paperclipAgentId:IDS.agent,
    agentArmyId:'intel-researcher',
  };
}

function succeeded() {
  return {
    status:'succeeded',
    currentStage:'campaign_research_ready',
    artifactRefs:[{
      artifactId:'campaign-research:fixture',
      type:'campaign_research_report',
      validation:{ exists:true, readable:true, nonEmpty:true },
    }],
  };
}

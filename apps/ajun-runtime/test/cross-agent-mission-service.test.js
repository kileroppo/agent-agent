import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CrossAgentMissionService } from '../src/cross-agent-mission-service.js';
import { LocalAjunCoordinator } from '../src/local-ajun-coordinator.ts';
import { MissionChildPolicy } from '../src/workflow/mission-child-policy.ts';

test('安全的多人盘点会建立总任务、两项分工和汇总', async () => {
  const created = [];
  let parent = null;
  const tasks = {
    async create(input) {
      created.push(input);
      if (input.taskType === 'army.cross-agent-mission') {
        parent = { taskId:'mission-1', status:'running', currentStage:'mission_planned', governance:{ paperclipIssueId:'paperclip-parent-1' }, artifactRefs:[{ type:'cross_agent_mission_plan', data:{ subtasks:[
          { key:'health', agentId:'operator', taskType:'operations.health-review', title:'检查军团本机运行状态', acceptance:'健康结论' },
          { key:'architecture', agentId:'architect', taskType:'governance.architecture-review', title:'复盘军团当前重复工作与能力缺口', acceptance:'改进建议' }
        ] } }] };
        return parent;
      }
      if (input.taskType === 'operations.health-review') return { taskId:`child-${created.length}`, status:'succeeded', assigneeAgentId:input.agentId, taskType:input.taskType, artifactRefs:[{ type:'health_report', data:{ overall:'healthy', components:[] } }] };
      return { taskId:`child-${created.length}`, status:'succeeded', assigneeAgentId:input.agentId, taskType:input.taskType, artifactRefs:[{ type:'architecture_review', data:{ nextAction:'优先加强公开资料报告员处理反复出现工作的稳定性。' } }] };
    }
  };
  const updates = [];
  const store = { async updateTask(id, patch) { updates.push({ id, patch }); parent = { ...parent, ...patch }; return parent; } };
  const governance = { async update(task) { return { ...task.governance, status:'synced' }; } };
  const service = new CrossAgentMissionService({ tasks, store, governance });
  const result = await service.create({ title:'组织大家一起盘点军团', requester:{ kind:'feishu-user', ref:'u' }, source:{ channel:'feishu', chatRef:'chat-1' }, idempotencyKey:'feishu:e-1' });
  assert.equal(created.length, 3);
  assert.equal(created[1].source.channel, 'army-mission');
  assert.equal(created[1].context.parentPaperclipIssueId, 'paperclip-parent-1');
  assert.doesNotMatch(created[1].description, /预算|费用|付费/);
  assert.equal(created[2].agentId, 'architect');
  assert.equal(result.mission.status, 'succeeded');
  assert.equal(result.mission.artifactRefs.at(-1).validation.allSubtasksCompleted, true);
  assert.match(result.reply, /本机运行正常/);
  assert.match(result.reply, /优先加强公开资料报告员/);
  assert.match(result.reply, /现在没有必须由你决定/);
});

test('盘点发现本机异常时，如实说明卡点并只要求人工处理必要事项', async () => {
  let mission = { taskId:'mission-degraded-1', status:'running', artifactRefs:[{ type:'cross_agent_mission_plan', data:{ subtasks:[
    { key:'health', agentId:'operator', taskType:'operations.health-review', title:'检查本机', acceptance:'健康结论' },
    { key:'architecture', agentId:'architect', taskType:'governance.architecture-review', title:'复盘工作', acceptance:'改进建议' }
  ] } }] };
  const tasks = { async create(input) {
    if (input.taskType === 'operations.health-review') return { taskId:'health-child', status:'succeeded', assigneeAgentId:'operator', taskType:input.taskType, artifactRefs:[{ type:'health_report', data:{ overall:'degraded', components:[{ name:'Paperclip 治理台', status:'degraded' }] } }] };
    return { taskId:'architecture-child', status:'succeeded', assigneeAgentId:'architect', taskType:input.taskType, artifactRefs:[{ type:'architecture_review', data:{ nextAction:'先检查治理台本机服务。' } }] };
  } };
  const store = { async list(){ return []; }, async updateTask(_id, patch){ mission = { ...mission, ...patch }; return mission; } };
  const result = await new CrossAgentMissionService({ tasks, store, governance:{} }).dispatch(mission);
  assert.match(result.reply, /Paperclip 治理台/);
  assert.match(result.reply, /先检查治理台本机服务/);
  assert.match(result.reply, /不会自行重置/);
});

test('包含费用的多人工作只创建等待确认的总任务，不安排员工执行', async () => {
  const tasks = { async create(){ return { taskId:'mission-budget-1', status:'waiting_approval', approvalRefs:['approval-budget-1'], artifactRefs:[] }; } };
  const store = { async listApprovals(){ return [{ approvalId:'approval-budget-1', status:'pending', governanceMode:'paperclip', action:'manual-risk-review', riskLevel:'high', reason:'费用范围需要确认。', requestedScope:{ taskType:'army.cross-agent-mission' }, validUntil:'2030-01-01T00:00:00.000Z' }]; } };
  const service = new CrossAgentMissionService({ tasks, store, governance:{} });
  const result = await service.create({ title:'组织多人协作，预算 100 元', requester:{}, source:{}, idempotencyKey:'budget-1' });
  assert.equal(result.children.length, 0);
  assert.equal(result.approval.governanceMode, 'paperclip');
  assert.match(result.reply, /不会安排员工开始/);
});

test('已经汇总的多人工作不会被重复分派', async () => {
  let creates = 0;
  const mission = { taskId:'mission-done-1', status:'succeeded', artifactRefs:[{ type:'cross_agent_mission_summary', data:{} }] };
  const service = new CrossAgentMissionService({ tasks:{ async create(){ creates += 1; return mission; } }, store:{ async list(){ return [mission]; } }, governance:{} });
  const result = await service.dispatch('mission-done-1');
  assert.equal(creates, 0);
  assert.equal(result.children.length, 0);
  assert.match(result.reply, /不会重复安排/);
});

test('父任务已批准时，会恢复此前被重复审批拦住的安全子工作', async () => {
  let mission = {
    taskId:'mission-recover-1', status:'running', idempotencyKey:'mission:recover', governance:{ paperclipIssueId:'paperclip-parent-1' },
    artifactRefs:[{ type:'cross_agent_mission_plan', data:{ subtasks:[{ key:'health', agentId:'operator', taskType:'operations.health-review', title:'检查军团本机运行状态', acceptance:'健康结论' }] } }]
  };
  const child = { taskId:'child-recover-1', parentTaskId:'mission-recover-1', idempotencyKey:'mission:recover:health', status:'waiting_approval', assigneeAgentId:'operator' };
  const resumed = [];
  const service = new CrossAgentMissionService({
    tasks:{ async create(){ throw new Error('不应重复创建'); }, async resumeApprovedMissionChild(taskId){ resumed.push(taskId); return { ...child, status:'succeeded' }; } },
    store:{ async list(){ return [mission, child]; }, async updateTask(_id, patch){ mission = { ...mission, ...patch }; return mission; } },
    governance:{ async update(task){ return task.governance; } }
  });
  const result = await service.dispatch(mission);
  assert.deepEqual(resumed, ['child-recover-1']);
  assert.equal(result.mission.status, 'succeeded');
});

test('老板多人任务按顺序分派三名员工并由办公助理统一汇总', async () => {
  const created = [];
  let mission = null;
  const allTasks = [];
  const tasks = {
    async create(input) {
      created.push(input);
      if (input.taskType === 'army.cross-agent-mission') {
        mission = {
          taskId:'mission-business-1',
          idempotencyKey:input.idempotencyKey,
          requester:input.requester,
          source:input.source,
          status:'running',
          artifactRefs:[{
            type:'cross_agent_mission_plan',
            data:{
              kind:'business',
              safeOnly:true,
              summary:input.title,
              subtasks:input.context.businessMissionItems
            }
          }]
        };
        allTasks.push(mission);
        return mission;
      }
      const child = {
        taskId:`business-child-${created.length}`,
        idempotencyKey:input.idempotencyKey,
        parentTaskId:input.parentTaskId,
        assigneeAgentId:input.agentId,
        taskType:input.taskType,
        status:'succeeded',
        artifactRefs:[{
          type:input.agentId === 'office-assistant' ? 'office_briefing_package' : `${input.agentId}_delivery`,
          validation:{ exists:true, readable:true, nonEmpty:true },
          data:input.agentId === 'office-assistant'
            ? { title:'老板周报', summary:'三项工作已汇总。', openItems:[], nextAction:'请审阅。' }
            : {}
        }]
      };
      allTasks.push(child);
      return child;
    }
  };
  const store = {
    async list(){ return allTasks; },
    async updateTask(_id, patch){ mission = { ...mission, ...patch }; allTasks[0] = mission; return mission; }
  };
  const result = await new CrossAgentMissionService({ tasks, store, governance:{} }).createBusinessMission({
    title:'完成老板本周内容任务',
    requester:{ kind:'local-owner', ref:'A君' },
    source:{ channel:'hermes-native' },
    idempotencyKey:'hermes-mission:week-1',
    items:[
      { title:'整理公开视频', taskType:'media.transcribe-and-refine', agentId:'xiaod', sourceUrls:['https://example.com/video'], reviewPolicy:'required' },
      { title:'研究公开资料', taskType:'research.intel-report', agentId:'intel-researcher' },
      { title:'等待前两项完成后整理老板汇报', taskType:'research.intel-report', agentId:'intel-researcher' }
    ]
  });

  assert.equal(created.length, 4);
  assert.equal(created[1].sourceUrls[0], 'https://example.com/video');
  assert.equal(created[1].reviewPolicy, 'required');
  assert.equal(created[3].agentId, 'office-assistant');
  assert.equal(created[3].taskType, 'office.briefing-package');
  assert.equal(result.mission.status, 'succeeded');
  assert.equal(result.mission.artifactRefs.at(-1).data.kind, 'business');
  assert.equal(result.mission.artifactRefs.at(-1).data.statuses.length, 3);
  assert.equal(result.mission.artifactRefs.at(-1).data.decision.briefing.summary, '三项工作已汇总。');
  assert.match(result.reply, /均已交付/);
});

test('模型误选小R时仍会把最终汇报规范为依赖任务并等待前置员工', async () => {
  const created = [];
  const allTasks = [];
  let mission = null;
  const service = new CrossAgentMissionService({
    tasks:{
      async create(input) {
        created.push(input);
        if (input.taskType === 'army.cross-agent-mission') {
          mission = {
            taskId:'mission-canonical-1',
            idempotencyKey:input.idempotencyKey,
            requester:input.requester,
            source:input.source,
            status:'running',
            artifactRefs:[{
              type:'cross_agent_mission_plan',
              data:{
                kind:'business',
                safeOnly:true,
                summary:input.title,
                subtasks:input.context.businessMissionItems
              }
            }]
          };
          allTasks.push(mission);
          return mission;
        }
        const child = {
          taskId:`canonical-child-${created.length}`,
          idempotencyKey:input.idempotencyKey,
          parentTaskId:input.parentTaskId,
          assigneeAgentId:input.agentId,
          taskType:input.taskType,
          status:'running',
          artifactRefs:[]
        };
        allTasks.push(child);
        return child;
      }
    },
    store:{
      async list(){ return allTasks; },
      async updateTask(_id, patch){ mission = { ...mission, ...patch }; allTasks[0] = mission; return mission; }
    },
    governance:{}
  });

  const result = await service.createBusinessMission({
    title:'完成内容整理和老板汇报',
    requester:{ kind:'local-owner', ref:'A君' },
    source:{ channel:'hermes-native' },
    idempotencyKey:'hermes-mission:canonical-1',
    items:[
      { title:'整理公开视频', taskType:'media.transcribe-and-refine', agentId:'xiaod' },
      { title:'研究公开资料', taskType:'research.intel-report', agentId:'intel-researcher' },
      { title:'等待前两项结果后生成最终老板汇报', taskType:'research.intel-report', agentId:'intel-researcher' }
    ]
  });

  const plan = result.mission.artifactRefs.find((item) => item.type === 'cross_agent_mission_plan').data;
  assert.equal(plan.subtasks[2].agentId, 'office-assistant');
  assert.equal(plan.subtasks[2].taskType, 'office.briefing-package');
  assert.equal(plan.subtasks[2].dependsOnPrevious, true);
  assert.equal(created.filter((item) => item.taskType !== 'army.cross-agent-mission').length, 2);
  assert.equal(result.mission.status, 'running');
  assert.equal(result.mission.artifactRefs.at(-1).data.statuses[2].status, 'planned');
});

test('办公助理会等待仍在运行的前置员工，不提前生成汇报', async () => {
  let mission = {
    taskId:'mission-wait-1',
    idempotencyKey:'mission:wait-1',
    status:'running',
    artifactRefs:[{
      type:'cross_agent_mission_plan',
      data:{
        kind:'business',
        safeOnly:true,
        summary:'完成两项工作',
        subtasks:[
          { key:'media', title:'整理视频', taskType:'media.transcribe-and-refine', agentId:'xiaod' },
          { key:'brief', title:'统一汇报', taskType:'office.briefing-package', agentId:'office-assistant', dependsOnPrevious:true }
        ]
      }
    }]
  };
  const created = [];
  const service = new CrossAgentMissionService({
    tasks:{ async create(input){ created.push(input); return { taskId:'media-running-1', idempotencyKey:input.idempotencyKey, parentTaskId:mission.taskId, assigneeAgentId:'xiaod', taskType:input.taskType, status:'running', artifactRefs:[] }; } },
    store:{ async list(){ return [mission]; }, async updateTask(_id, patch){ mission = { ...mission, ...patch }; return mission; } },
    governance:{}
  });

  const result = await service.dispatch(mission);
  assert.equal(created.length, 1);
  assert.equal(result.children.length, 1);
  assert.equal(result.mission.status, 'running');
  assert.equal(result.mission.artifactRefs.at(-1).data.statuses[1].status, 'planned');
});

test('多人任务按显式依赖图推进且同时创建不超过四项', async () => {
  let active = 0;
  let maxActive = 0;
  let mission;
  const allTasks = [];
  const service = new CrossAgentMissionService({
    tasks:{
      async create(input) {
        if (input.taskType === 'army.cross-agent-mission') {
          mission = {
            taskId:'mission-dag-1',
            idempotencyKey:input.idempotencyKey,
            requester:input.requester,
            source:input.source,
            status:'running',
            artifactRefs:[{
              type:'cross_agent_mission_plan',
              data:{ kind:'business', safeOnly:true, summary:input.title, subtasks:input.context.businessMissionItems }
            }]
          };
          allTasks.push(mission);
          return mission;
        }
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        const child = {
          taskId:`dag-child-${allTasks.length}`,
          idempotencyKey:input.idempotencyKey,
          parentTaskId:input.parentTaskId,
          assigneeAgentId:input.agentId,
          taskType:input.taskType,
          status:'succeeded',
          artifactRefs:[{ type:'verified_result', validation:{ exists:true, readable:true, nonEmpty:true } }]
        };
        allTasks.push(child);
        return child;
      }
    },
    store:{
      async list(){ return allTasks; },
      async updateTask(_id, patch){ mission = { ...mission, ...patch }; allTasks[0] = mission; return mission; }
    },
    governance:{}
  });

  const result = await service.createBusinessMission({
    title:'完成六项并行研究后统一交付',
    idempotencyKey:'mission:dag',
    items:[
      ...Array.from({ length:6 }, (_, index) => ({
        key:`research-${index + 1}`,
        title:`研究 ${index + 1}`,
        taskType:'research.intel-report',
        agentId:'intel-researcher'
      })),
      {
        key:'brief',
        title:'统一交付',
        taskType:'office.briefing-package',
        agentId:'office-assistant',
        dependsOn:['research-2', 'research-5']
      }
    ]
  });

  assert.equal(maxActive, 4);
  assert.equal(result.children.length, 7);
  assert.equal(result.mission.status, 'succeeded');
});

test('多人任务拒绝循环或不存在的依赖', async () => {
  const service = new CrossAgentMissionService({ tasks:{}, store:{}, governance:{} });
  await assert.rejects(
    service.createBusinessMission({
      title:'循环任务',
      items:[
        { key:'a', title:'A', taskType:'research.intel-report', agentId:'intel-researcher', dependsOn:['b'] },
        { key:'b', title:'B', taskType:'research.intel-report', agentId:'intel-researcher', dependsOn:['a'] }
      ]
    }),
    /不能形成循环/
  );
  await assert.rejects(
    service.createBusinessMission({
      title:'缺失依赖',
      items:[
        { key:'a', title:'A', taskType:'research.intel-report', agentId:'intel-researcher', dependsOn:['missing'] }
      ]
    }),
    /依赖必须引用/
  );
});

test('多人任务已持久化但计划仍在异步生成时返回已受理而不是抛错', async () => {
  const mission = {
    taskId:'mission-async-plan',
    taskType:'army.cross-agent-mission',
    status:'running',
    currentStage:'paperclip_hermes_running',
    artifactRefs:[],
  };
  const service = new CrossAgentMissionService({
    tasks:{ async create(){ return mission; } },
    store:{ async listApprovals(){ return []; } },
    governance:{},
  });

  const result = await service.createBusinessMission({
    title:'先获取视频再完成精华提炼',
    items:[
      { key:'media', title:'获取视频', taskType:'media.transcribe-and-refine', agentId:'xiaod' },
      { key:'analysis', title:'精华提炼', taskType:'content.video-benchmark-analysis', agentId:'video-content-analyst', dependsOn:['media'] },
    ],
  });

  assert.equal(result.mission.taskId, 'mission-async-plan');
  assert.deepEqual(result.children, []);
  assert.match(result.reply, /已经登记|计划生成后/);
});

test('依赖任务创建时分离固定内容来源与依赖编号并保留无固定来源的旧行为', async () => {
  const created = [];
  let mission = null;
  const allTasks = [];
  const service = new CrossAgentMissionService({
    tasks:{
      async create(input) {
        created.push(input);
        if (input.taskType === 'army.cross-agent-mission') {
          mission = {
            taskId:'mission-evidence',
            taskType:'army.cross-agent-mission',
            status:'running',
            idempotencyKey:'mission:evidence',
            requester:{ kind:'local-owner', ref:'A君' },
            source:{ channel:'feishu', chatRef:'oc_evidence' },
            governance:{ paperclipIssueId:'paperclip-evidence' },
            artifactRefs:[{
              type:'cross_agent_mission_plan',
              data:{ kind:'business', safeOnly:true, summary:'视频精华提炼', subtasks:input.context.businessMissionItems },
            }],
          };
          allTasks.push(mission);
          return mission;
        }
        const dependencyTaskIds = {
          'dependency-b':'dependency-task-b',
          'dependency-a':'dependency-task-a',
          'dependency-b-copy':'dependency-task-b',
        };
        const child = {
          taskId:dependencyTaskIds[input.stepKey] || `${input.stepKey}-evidence`,
          taskType:input.taskType,
          assigneeAgentId:input.agentId,
          parentTaskId:input.parentTaskId,
          idempotencyKey:input.idempotencyKey,
          status:'succeeded',
          artifactRefs:[{ type:'verified-result', validation:{ exists:true, nonEmpty:true } }],
        };
        allTasks.push(child);
        return child;
      },
    },
    store:{
      async list(){ return allTasks; },
      async updateTask(_id, patch){ mission = { ...mission, ...patch }; allTasks[0] = mission; return mission; },
    },
    governance:{ async update(){ return {}; } },
  });

  await service.createBusinessMission({
    title:'视频精华提炼',
    idempotencyKey:'mission:evidence',
    items:[
      { key:'dependency-b', title:'获取视频 B', taskType:'media.transcribe-and-refine', agentId:'xiaod' },
      { key:'dependency-a', title:'研究资料 A', taskType:'research.intel-report', agentId:'intel-researcher' },
      { key:'dependency-b-copy', title:'复核视频 B', taskType:'media.transcribe-and-refine', agentId:'xiaod' },
      {
        key:'analysis-fixed',
        title:'精华提炼',
        taskType:'content.video-benchmark-analysis',
        agentId:'video-content-analyst',
        dependsOn:['dependency-b', 'dependency-a', 'dependency-b-copy'],
        context:{
          productMaturityAuthorization:{ kind:'product-maturity-validation', token:'fixed-test-token' },
          sourceTaskIds:['formal-source-task', 'confirmed-source-task'],
        },
      },
      {
        key:'analysis-legacy',
        title:'兼容旧分析',
        taskType:'content.video-script-package',
        agentId:'content-creator',
        dependsOn:['dependency-b', 'dependency-a', 'dependency-b-copy'],
      },
    ],
  });

  const fixed = created.find((input) => input.stepKey === 'analysis-fixed');
  assert.deepEqual(fixed.context.sourceTaskIds, ['formal-source-task', 'confirmed-source-task']);
  assert.deepEqual(fixed.context.dependencyTaskIds, ['dependency-task-b', 'dependency-task-a']);
  assert.equal(fixed.context.dependsOnPrevious, true);

  const legacy = created.find((input) => input.stepKey === 'analysis-legacy');
  assert.deepEqual(legacy.context.sourceTaskIds, ['dependency-task-b', 'dependency-task-a']);
  assert.deepEqual(legacy.context.dependencyTaskIds, ['dependency-task-b', 'dependency-task-a']);
});

test('产品成熟度真实 create→A君 plan→dispatch 保留全部签名 guard 字段', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maturity-plan-dispatch-'));
  const policy = await MissionChildPolicy.open({ keyPath:path.join(root, 'policy.key') });
  const batchId = 'maturity-11111111-1111-4111-8111-111111111111';
  const acceptanceWorkspaceRoot = path.join(root, 'work', 'acceptance-runs');
  const items = maturityItems(acceptanceWorkspaceRoot);
  const authorization = policy.issue(batchId, items);
  const allTasks = [];
  const createdChildren = [];
  let mission = null;
  const tasks = {
    async create(input) {
      if (input.taskType === 'army.cross-agent-mission') {
        mission = {
          taskId:'mission-maturity-real-plan', taskType:input.taskType, assigneeAgentId:'ajun',
          idempotencyKey:input.idempotencyKey, requester:input.requester, source:input.source,
          input:{ title:input.title, description:input.description, context:input.context },
          status:'running', artifactRefs:[],
        };
        const planned = await new LocalAjunCoordinator().execute(mission);
        mission = { ...mission, ...planned };
        allTasks.push(mission);
        return mission;
      }
      createdChildren.push(input);
      const child = {
        taskId:`child-${input.stepKey}`, taskType:input.taskType, assigneeAgentId:input.agentId,
        idempotencyKey:input.idempotencyKey, parentTaskId:input.parentTaskId, status:'succeeded',
        artifactRefs:[{ type:'verified_output', validation:{ exists:true, readable:true, nonEmpty:true } }],
      };
      allTasks.push(child);
      return child;
    },
  };
  const store = {
    async list() { return allTasks; },
    async updateTask(_id, patch) { mission = { ...mission, ...patch }; allTasks[0] = mission; return mission; },
  };
  const service = new CrossAgentMissionService({ tasks, store, governance:{}, missionChildPolicy:policy });
  const result = await service.createBusinessMission({
    title:'产品成熟度受控验证', items:items.map((item) => ({
      ...item, context:{ ...item.context, productMaturityAuthorization:authorization },
    })),
    requester:{ kind:'local-owner', ref:'A君' },
    source:{ channel:'product-maturity-validation', eventRef:batchId },
    idempotencyKey:`product-maturity-validation:${batchId}`,
    productMaturityBatchId:batchId,
  });
  assert.equal(result.children.length, 3);
  assert.equal(createdChildren[0].context.proposalOnly, true);
  assert.equal(createdChildren[0].context.draftOnly, true);
  assert.equal(createdChildren[1].context.deterministicAcceptanceRepair, true);
  assert.equal(createdChildren[1].context.repairScope.testCommand, 'node --test docs/acceptance-fixtures/technical-repair-sandbox/calculator.test.js');
  assert.equal(createdChildren[2].researchMode, 'off');
  assert.equal(createdChildren[2].approvedForUse, false);
  assert.deepEqual(createdChildren[2].context.modelPolicy, { maxCalls:0, maxCostUsd:0, costKnown:true });
});

function maturityItems(acceptanceWorkspaceRoot) {
  return [
    { key:'creator', agentId:'creator', taskType:'governance.agent-proposal', title:'创建草案', description:'只创建草案。', acceptance:'保持 draft_only。', proposalOnly:true, draftOnly:true, context:{ proposalOnly:true, draftOnly:true } },
    { key:'technical-expert', agentId:'technical-expert', taskType:'operations.technical-repair', title:'修复夹具', description:'只修复夹具。', acceptance:'只修改一个文件。', dependsOn:['creator'], deterministicAcceptanceRepair:true, context:{ deterministicAcceptanceRepair:true, acceptanceWorkspaceRoot, failure:{ code:'acceptance_fixture_failure', category:'code_defect', stage:'test', retryable:false }, repairScope:{ files:['docs/acceptance-fixtures/technical-repair-sandbox/calculator.js'], testSupportFiles:['docs/acceptance-fixtures/technical-repair-sandbox/calculator.test.js', 'docs/acceptance-fixtures/technical-repair-sandbox/package.json'], testCommand:'node --test docs/acceptance-fixtures/technical-repair-sandbox/calculator.test.js', recoveryCheck:'确认 add(2, 3) 返回 5。' } } },
    { key:'content-creator', agentId:'content-creator', taskType:'content.video-script-package', title:'生成待审脚本', description:'只使用固定来源。', acceptance:'保持 draft_only。', dependsOn:['technical-expert'], platforms:['douyin'], contentGoal:'解释已有观点。', researchMode:'off', approvedForUse:false, context:{ researchMode:'off', approvedForUse:false, modelPolicy:{ maxCalls:0, maxCostUsd:0, costKnown:true }, sourceTaskIds:['source-transcript', 'source-analysis'], requiredSourceTaskIds:['source-transcript', 'source-analysis'] } },
  ];
}

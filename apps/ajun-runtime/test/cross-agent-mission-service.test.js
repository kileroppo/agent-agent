import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { CrossAgentMissionService } from '../src/cross-agent-mission-service.js';
import { CrossAgentMissionReconciler } from '../src/cross-agent-mission-reconciler.ts';
import { LocalAjunCoordinator } from '../src/local-ajun-coordinator.ts';
import { LocalCreator } from '../src/local-creator.ts';
import { MaturityExecutionGuard } from '../src/maturity-execution-guard.ts';
import { TaskService } from '../src/task-service.js';
import { TaskStore } from '../src/task-store.js';
import { MissionChildPolicy } from '../src/workflow/mission-child-policy.ts';

const execFile = promisify(execFileCallback);

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

test('普通多人任务的 queued 子任务不会进入产品成熟度恢复接缝', async () => {
  const mission = {
    taskId:'ordinary-mission', taskType:'army.cross-agent-mission', status:'running', idempotencyKey:'ordinary:mission',
    artifactRefs:[{ type:'cross_agent_mission_plan', data:{ subtasks:[{ key:'ordinary', taskType:'operations.health-review', agentId:'operator', title:'普通检查' }] } }],
  };
  const child = { taskId:'ordinary-child', parentTaskId:mission.taskId, idempotencyKey:'ordinary:mission:ordinary', status:'queued' };
  let recoveryCalls = 0;
  const service = new CrossAgentMissionService({
    tasks:{ async resumeVerifiedQueuedMissionChild() { recoveryCalls += 1; } },
    store:{ async list() { return [mission, child]; }, async updateTask(_id, patch) { return { ...mission, ...patch }; } },
    governance:{},
  });
  const result = await service.dispatch(mission);
  assert.equal(recoveryCalls, 0);
  assert.equal(result.children[0].status, 'queued');
});

test('产品成熟度同一固定幂等键出现重复子任务时 fail closed', async () => {
  const batchId = 'maturity-33333333-3333-4333-8333-333333333333';
  const mission = {
    taskId:'duplicate-maturity-mission', taskType:'army.cross-agent-mission', status:'running',
    idempotencyKey:`product-maturity-validation:${batchId}`, input:{ context:{ productMaturityBatchId:batchId } },
    artifactRefs:[{ type:'cross_agent_mission_plan', data:{ subtasks:[{ key:'creator', taskType:'governance.agent-proposal', agentId:'creator', title:'草案' }] } }],
  };
  const duplicate = { parentTaskId:mission.taskId, idempotencyKey:`${mission.idempotencyKey}:creator`, status:'queued' };
  let recoveryCalls = 0;
  const service = new CrossAgentMissionService({
    tasks:{ async resumeVerifiedQueuedMissionChild() { recoveryCalls += 1; } },
    store:{ async list() { return [mission, { ...duplicate, taskId:'duplicate-1' }, { ...duplicate, taskId:'duplicate-2' }]; } },
    governance:{},
  });
  await assert.rejects(() => service.dispatch(mission), /重复幂等任务/);
  assert.equal(recoveryCalls, 0);
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

test('产品成熟度 queued 子任务并发恢复只执行一次且 reconcile 后正好三个终态子任务', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maturity-queued-recovery-'));
  try {
    const store = new TaskStore(path.join(root, 'runtime.json'));
    const policy = await MissionChildPolicy.open({ keyPath:path.join(root, 'policy.key') });
    const batchId = 'maturity-22222222-2222-4222-8222-222222222222';
    const acceptanceWorkspaceRoot = path.join(root, 'work', 'acceptance-runs');
    const fixtureRoot = path.join(acceptanceWorkspaceRoot, 'fixture-run');
    await prepareTechnicalFixture(fixtureRoot);
    const items = maturityItems(acceptanceWorkspaceRoot);
    const authorization = policy.issue(batchId, items);
    const agents = maturityAgents();
    const registry = {
      async list() { return agents; },
      async get(agentId) { return agents.find((agent) => agent.agentId === agentId) || null; },
      async candidates(taskType) { return agents.filter((agent) => agent.acceptedTaskTypes.includes(taskType)); },
    };
    let technicalExecutions = 0;
    let governanceCalls = 0;
    const governance = {
      async project() { governanceCalls += 1; return { paperclipIssueId:'forbidden' }; },
      async projectChild() { governanceCalls += 1; return { paperclipIssueId:'forbidden' }; },
      async update() { governanceCalls += 1; return { paperclipIssueId:'forbidden' }; },
      async assertCaseIssueLink() {},
    };
    const creator = new LocalCreator({
      proposals:{
        async create() {
          return { proposalId:'maturity-draft', status:'draft', candidateManifest:{ name:'成熟度待审岗位草案' } };
        },
        async submit() { throw new Error('成熟度 draft_only 不应提交'); },
      },
    });
    const technical = {
      workspace:{ async prepare() { return { workspace:fixtureRoot, reused:false }; } },
      async execute(task) {
        technicalExecutions += 1;
        const prepared = await this.workspace.prepare(task);
        const run = await this.runner.run(task, prepared.workspace);
        return {
          status:'succeeded', currentStage:'acceptance_fixture_verified',
          execution:{ executor:'technical-expert', outcome:'acceptance_verified_in_isolated_workspace', verification:{ testsPassed:true, recoveryVerified:true, acceptanceOnly:true } },
          artifactRefs:[{ type:'technical_repair_case', validation:{ exists:true, readable:true, nonEmpty:true }, data:run.evidence }],
        };
      },
    };
    const content = maturityContentExecutor();
    const tasks = new TaskService({
      registry,
      store,
      governance,
      missionChildPolicy:policy,
      executors:{ ajun:new LocalAjunCoordinator(), creator, 'technical-expert':technical, 'content-creator':content },
    });
    const guard = new MaturityExecutionGuard({ store, policy });
    tasks.maturityExecutionGuard = guard;
    tasks.executionCoordinator.maturityExecutionGuard = guard;
    tasks.intake.maturityExecutionGuard = guard;

    const executeTask = tasks.executeTask.bind(tasks);
    let leaveTechnicalQueued = true;
    tasks.executeTask = async (task, agent) => {
      if (leaveTechnicalQueued && task.taskType === 'operations.technical-repair') {
        leaveTechnicalQueued = false;
        return task;
      }
      return executeTask(task, agent);
    };
    const missions = new CrossAgentMissionService({ tasks, store, governance, missionChildPolicy:policy });
    const created = await missions.createBusinessMission({
      title:'产品成熟度受控验证',
      items:items.map((item) => ({ ...item, context:{ ...item.context, productMaturityAuthorization:authorization } })),
      requester:{ kind:'local-owner', ref:'A君' },
      source:{ channel:'product-maturity-validation', eventRef:batchId },
      idempotencyKey:`product-maturity-validation:${batchId}`,
      productMaturityBatchId:batchId,
    });
    const queued = created.children.find((task) => task.taskType === 'operations.technical-repair');
    const creatorChild = created.children.find((task) => task.taskType === 'governance.agent-proposal');
    assert.equal(queued.status, 'queued');
    assert.equal(created.children.length, 2);

    const recover = () => tasks.resumeVerifiedQueuedMissionChild({
      missionTaskId:created.mission.taskId,
      taskId:queued.taskId,
      idempotencyKey:queued.idempotencyKey,
    });
    const polluteTechnicalSources = async (sourceTaskIds) => {
      const current = (await store.list()).find((task) => task.taskId === queued.taskId);
      return store.updateTask(queued.taskId, {
        ...(current.status === 'waiting_test' ? {
          status:'queued', attempt:current.attempt + 1, currentStage:'queued_for_execution',
          execution:undefined, error:undefined,
        } : {}),
        input:{ ...current.input, context:{ ...current.input.context, sourceTaskIds } },
      });
    };
    await polluteTechnicalSources([creatorChild.taskId, 'unexpected-extra-source']);
    const extraBlocked = await recover();
    assert.equal(extraBlocked.status, 'waiting_test');
    assert.equal(extraBlocked.currentStage, 'maturity_execution_blocked');
    assert.equal(extraBlocked.error.code, 'maturity_execution_guard_rejected');
    assert.equal(technicalExecutions, 0);
    assert.deepEqual((await store.list()).find((task) => task.taskId === queued.taskId).input.context.sourceTaskIds, [creatorChild.taskId, 'unexpected-extra-source']);
    await new CrossAgentMissionReconciler({ store, missions }).reconcile();
    assert.equal((await store.list()).filter((task) => task.parentTaskId === created.mission.taskId).length, 2);

    await polluteTechnicalSources(['wrong-creator-task-id']);
    const wrongBlocked = await recover();
    assert.equal(wrongBlocked.status, 'waiting_test');
    assert.equal(wrongBlocked.currentStage, 'maturity_execution_blocked');
    assert.equal(wrongBlocked.error.code, 'maturity_execution_guard_rejected');
    assert.equal(technicalExecutions, 0);
    assert.deepEqual((await store.list()).find((task) => task.taskId === queued.taskId).input.context.sourceTaskIds, ['wrong-creator-task-id']);

    await polluteTechnicalSources([creatorChild.taskId]);
    const recovered = await Promise.all(Array.from({ length:8 }, recover));
    assert.equal(technicalExecutions, 1);
    assert.ok(recovered.every((task) => task.taskId === queued.taskId));
    const migratedTechnical = (await store.list()).find((task) => task.taskId === queued.taskId);
    assert.equal(migratedTechnical.input.context.sourceTaskIds, undefined);
    assert.deepEqual(migratedTechnical.input.context.dependencyTaskIds, [creatorChild.taskId]);
    await assert.rejects(() => tasks.resumeVerifiedQueuedMissionChild({
      missionTaskId:created.mission.taskId,
      taskId:queued.taskId,
      idempotencyKey:`${queued.idempotencyKey}:forged`,
    }), /幂等键不一致/);
    assert.equal(technicalExecutions, 1);

    await new CrossAgentMissionReconciler({ store, missions }).reconcile();
    const records = await store.list();
    const mission = records.find((task) => task.taskId === created.mission.taskId);
    const children = records.filter((task) => task.parentTaskId === mission.taskId);
    assert.equal(mission.status, 'succeeded');
    assert.equal(children.length, 3);
    assert.equal(new Set(children.map((task) => task.idempotencyKey)).size, 3);
    assert.ok(children.every((task) => task.status === 'succeeded'));
    assert.equal(children.filter((task) => task.idempotencyKey === queued.idempotencyKey).length, 1);
    assert.equal(governanceCalls, 0);
  } finally {
    await fs.rm(root, { recursive:true, force:true });
  }
});

function maturityAgents() {
  return [
    ['ajun', 'army.cross-agent-mission'],
    ['creator', 'governance.agent-proposal'],
    ['technical-expert', 'operations.technical-repair'],
    ['content-creator', 'content.video-script-package'],
  ].map(([agentId, taskType]) => ({
    agentId, name:agentId, status:'active', acceptedTaskTypes:[taskType],
    interaction:{ runtime:'hermes-profile' }, executionOwner:'paperclip-hermes',
  }));
}

async function prepareTechnicalFixture(root) {
  const dir = path.join(root, 'docs/acceptance-fixtures/technical-repair-sandbox');
  await fs.mkdir(dir, { recursive:true });
  await fs.writeFile(path.join(dir, 'calculator.js'), 'export function add(left, right) {\n  return left - right;\n}\n');
  await fs.writeFile(path.join(dir, 'calculator.test.js'), "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { add } from './calculator.js';\ntest('add', () => assert.equal(add(2, 3), 5));\n");
  await fs.writeFile(path.join(dir, 'package.json'), '{"type":"module"}\n');
  await execFile('git', ['init', '-q'], { cwd:root });
  await execFile('git', ['add', '.'], { cwd:root });
  await execFile('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture'], { cwd:root });
}

function maturityContentExecutor() {
  const scriptPackage = {
    async execute(task) {
      const sourceTaskIds = task.input.context.requiredSourceTaskIds;
      const sourceRefs = ['artifact-source-transcript', 'artifact-source-analysis'];
      return {
        status:'succeeded', currentStage:'video_script_package_ready',
        execution:{ executor:'content-creator', outcome:'draft_ready' },
        artifactRefs:[{
          type:'video_script_package', sourceRefs,
          validation:{ exists:true, readable:true, nonEmpty:true, fileCount:5, onePrimaryDraft:true, externalSideEffects:0 },
          data:{
            fullScript:'这是只使用固定来源生成的待审脚本。', publishingStatus:'draft_only',
            generationMode:'deterministic_fallback', researchStatus:'not_required',
            templateLifecycle:{ approvedForUse:false },
            productionFiles:['script', 'shots', 'subtitles', 'sources', 'manifest'].map((id) => ({ id })),
            sourceTaskIds,
            sourceTaskBindings:sourceTaskIds.map((taskId, index) => ({ taskId, artifactIds:[sourceRefs[index]] })),
          },
        }],
      };
    },
  };
  return { scriptPackage, async execute(task, options) { return this.scriptPackage.execute(task, options); } };
}

function maturityItems(acceptanceWorkspaceRoot) {
  return [
    { key:'creator', agentId:'creator', taskType:'governance.agent-proposal', title:'创建草案', description:'只创建草案。', acceptance:'保持 draft_only。', proposalOnly:true, draftOnly:true, context:{ proposalOnly:true, draftOnly:true } },
    { key:'technical-expert', agentId:'technical-expert', taskType:'operations.technical-repair', title:'修复夹具', description:'只修复夹具。', acceptance:'只修改一个文件。', dependsOn:['creator'], deterministicAcceptanceRepair:true, context:{ deterministicAcceptanceRepair:true, acceptanceWorkspaceRoot, failure:{ code:'acceptance_fixture_failure', category:'code_defect', stage:'test', retryable:false }, repairScope:{ files:['docs/acceptance-fixtures/technical-repair-sandbox/calculator.js'], testSupportFiles:['docs/acceptance-fixtures/technical-repair-sandbox/calculator.test.js', 'docs/acceptance-fixtures/technical-repair-sandbox/package.json'], testCommand:'node --test docs/acceptance-fixtures/technical-repair-sandbox/calculator.test.js', recoveryCheck:'确认 add(2, 3) 返回 5。' } } },
    { key:'content-creator', agentId:'content-creator', taskType:'content.video-script-package', title:'生成待审脚本', description:'只使用固定来源。', acceptance:'保持 draft_only。', dependsOn:['technical-expert'], platforms:['douyin'], contentGoal:'解释已有观点。', researchMode:'off', approvedForUse:false, context:{ researchMode:'off', approvedForUse:false, modelPolicy:{ maxCalls:0, maxCostUsd:0, costKnown:true }, sourceTaskIds:['source-transcript', 'source-analysis'], requiredSourceTaskIds:['source-transcript', 'source-analysis'] } },
  ];
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { CrossAgentMissionService } from '../src/cross-agent-mission-service.js';

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
      { title:'整理公开视频', taskType:'media.transcribe-and-refine', agentId:'xiaod', sourceUrls:['https://example.com/video'] },
      { title:'研究公开资料', taskType:'research.intel-report', agentId:'intel-researcher' },
      { title:'等待前两项完成后整理老板汇报', taskType:'research.intel-report', agentId:'intel-researcher' }
    ]
  });

  assert.equal(created.length, 4);
  assert.equal(created[1].sourceUrls[0], 'https://example.com/video');
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

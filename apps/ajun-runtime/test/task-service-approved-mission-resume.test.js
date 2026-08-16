import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskService } from '../src/task-service.ts';

test('已批准总任务在本机只生成确定性分工，不重新进入旧 Paperclip 运行', async () => {
  let task = {
    taskId:'mission-approved-stalled',
    taskType:'army.cross-agent-mission',
    assigneeAgentId:'ajun',
    status:'queued',
    currentStage:'approval_approved',
    approvalRefs:['approval-1'],
    artifactRefs:[],
    input:{ title:'爆款候选拆解｜晕肉了' },
  };
  let localPlanCalls = 0;
  const service = Object.assign(Object.create(TaskService.prototype), {
    approvedMissionResumeRuns:new Map(),
    store:{
      async getTask(taskId) { return taskId === task.taskId ? task : null; },
      async listApprovals() {
        return [{ approvalId:'approval-1', taskId:task.taskId, status:'approved', action:'manual-risk-review' }];
      },
      async updateTask(_taskId, patch) { task = { ...task, ...patch }; return task; },
    },
    registry:{ async get() { return { agentId:'ajun', status:'active' }; } },
    executors:{
      ajun:{
        async execute(planning) {
          localPlanCalls += 1;
          assert.equal(planning.currentStage, 'approval_resume_planning');
          return {
            status:'running',
            currentStage:'mission_planned',
            artifactRefs:[{ type:'cross_agent_mission_plan', data:{ subtasks:[] } }],
          };
        },
      },
    },
    capabilityCatalog:{ executor(agentId, executors) { return executors[agentId]; } },
    taskLifecycleEvents:{ recordPersisted() {} },
    async executeTask() { throw new Error('不应重新进入 Paperclip 执行路径'); },
  });

  const resumed = await service.resumeApprovedMission(task.taskId);

  assert.equal(localPlanCalls, 1);
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.currentStage, 'mission_planned');
  assert.deepEqual(resumed.artifactRefs.map((item) => item.type), ['cross_agent_mission_plan']);
});

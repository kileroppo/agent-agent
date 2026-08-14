import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertPaperclipEmployeeExecutorAssignment,
  paperclipRoutineKey,
  resolvePaperclipAssignmentTaskType,
} from '../src/paperclip-employee-assignment.ts';

test('M5 Routine marker 映射到当前岗位声明的专用任务类型和 Case', () => {
  const issue = {
    title:'M5 / 研究：主题 1',
    description:'[agent-army:m5:routine:m5-research] 处理研究；当前 Case 为 12345678-abcd-4abc-8abc-1234567890ab，版本为 2。',
  };
  const result = resolvePaperclipAssignmentTaskType({
    agent:{
      agentId:'intel-researcher',
      acceptedTaskTypes:['research.intel-report', 'content.campaign-research'],
    },
    issue,
  });
  assert.deepEqual(result, {
    taskType:'content.campaign-research',
    routineKey:'m5-research',
    pipelineCaseId:'12345678-abcd-4abc-8abc-1234567890ab',
  });
  assert.equal(paperclipRoutineKey(issue), 'm5-research');
});

test('Routine 岗位错配或任务类型未声明时失败关闭', () => {
  assert.throws(
    () => resolvePaperclipAssignmentTaskType({
      agent:{ agentId:'office-assistant', acceptedTaskTypes:['content.campaign-research'] },
      issue:{ description:'[agent-army:m5:routine:m5-research]' },
    }),
    /不属于当前岗位/,
  );
  assert.throws(
    () => resolvePaperclipAssignmentTaskType({
      agent:{ agentId:'intel-researcher', acceptedTaskTypes:['research.intel-report'] },
      issue:{ description:'[agent-army:m5:routine:m5-research]' },
    }),
    /尚未声明任务类型/,
  );
});

test('员工执行器同时核验允许岗位、任务承接人和任务类型', () => {
  const agent = {
    agentId:'xiaod',
    acceptedTaskTypes:['content.campaign-assets'],
  };
  assert.deepEqual(
    assertPaperclipEmployeeExecutorAssignment({
      agent,
      task:{ assigneeAgentId:'xiaod', taskType:'content.campaign-assets' },
    }),
    { agentId:'xiaod', taskType:'content.campaign-assets' },
  );
  assert.throws(
    () => assertPaperclipEmployeeExecutorAssignment({
      agent,
      task:{ assigneeAgentId:'intel-researcher', taskType:'content.campaign-assets' },
    }),
    /身份不一致/,
  );
  assert.throws(
    () => assertPaperclipEmployeeExecutorAssignment({
      agent:{ agentId:'reviewer', acceptedTaskTypes:['content.campaign-assets'] },
      task:{ assigneeAgentId:'reviewer', taskType:'content.campaign-assets' },
    }),
    /不允许调用/,
  );
});

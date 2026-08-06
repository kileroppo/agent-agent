import assert from 'node:assert/strict';
import test from 'node:test';
import { buildArchitectureGroundTruth, validateArchitectureEvidenceRefs } from '../src/architecture-evidence.js';

test('架构事实快照只暴露真实岗位、任务类型、受控路径和脱敏任务证据', () => {
  const snapshot = buildArchitectureGroundTruth({
    agents:[{
      agentId:'intel-researcher',
      name:'小R',
      status:'active',
      acceptedTaskTypes:['research.intel-report'],
      toolAllowlist:['research.public.search'],
      promptRef:'agents/intel-researcher/prompts/system.md',
      runtimeProfileRef:'integrations/hermes/profiles/intel-researcher.profile.json'
    }],
    tasks:[{
      taskId:'task-real-1',
      taskType:'research.intel-report',
      assigneeAgentId:'intel-researcher',
      status:'succeeded',
      input:{ title:'研究 https://example.com/?token=secret' },
      artifactRefs:[{ type:'intel_research_report' }],
      updatedAt:'2026-07-29T01:00:00.000Z'
    }],
    generatedAt:'2026-07-29T01:01:00.000Z'
  });
  assert.deepEqual(snapshot.agents[0].acceptedTaskTypes, ['research.intel-report']);
  assert.equal(snapshot.taskEvidence[0].title.includes('secret'), false);
  assert.deepEqual(snapshot.taskEvidence[0].artifactTypes, ['intel_research_report']);
  assert.deepEqual(snapshot.taskTypes, [{
    ref:'task-type:research.intel-report',
    taskType:'research.intel-report',
    agentIds:['intel-researcher'],
    taskCount:1
  }]);
  assert.equal(snapshot.agents[0].repositoryRefs.includes('agents/capability-registry.md'), false);
  assert.equal(snapshot.snapshotId.length, 64);
});

test('架构结论只有引用快照中的真实对象才能通过事实门禁', () => {
  const snapshot = buildArchitectureGroundTruth({
    agents:[{ agentId:'architect', acceptedTaskTypes:['governance.architecture-review'] }],
    tasks:[{ taskId:'task-real-1', taskType:'governance.architecture-review', status:'succeeded' }]
  });
  const valid = validateArchitectureEvidenceRefs([
    { ref:'agent:architect', claim:'架构师只接受治理复盘任务。' },
    { ref:'task-type:governance.architecture-review', claim:'这是当前已登记任务类型。' },
    { ref:'task:task-real-1', claim:'已有一条完成记录。' }
  ], snapshot);
  assert.equal(valid.valid, true);
  const invented = validateArchitectureEvidenceRefs([
    { ref:'repo:agents/capability-registry.md', claim:'能力已注册。' }
  ], snapshot);
  assert.equal(invented.valid, false);
  assert.deepEqual(invented.invalidRefs, ['repo:agents/capability-registry.md']);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTaskContextCapsule } from '../src/task-context-capsule.ts';

test('任务上下文胶囊只保留目标、结果、已验证产物和一个下一步', () => {
  const capsule = buildTaskContextCapsule({
    taskId:'task-1',
    taskType:'research.intel-report',
    status:'succeeded',
    createdAt:'2026-08-13T01:00:00Z',
    updatedAt:'2026-08-13T02:00:00Z',
    input:{
      title:'研究任务',
      description:'整理公开资料并给出结论',
      context:{ keyDecisions:['只使用公开来源'], openItems:['等待负责人采用'] },
    },
    artifactRefs:[
      {
        artifactId:'report-1', type:'intel_research_report', title:'研究报告',
        location:'runtime://task-1/report', checksum:'a'.repeat(64),
        validation:{ exists:true, readable:true, nonEmpty:true },
        data:{ summary:'已完成三条公开来源对比。', rawBody:'不应进入上下文' },
      },
      {
        artifactId:'draft-1', type:'draft', title:'未采用草稿',
        validation:{ exists:true, readable:true, nonEmpty:false },
        data:{ summary:'不应保存' },
      },
    ],
  });
  assert.equal(capsule.schemaVersion, 'agent.army/task-context-capsule/v1');
  assert.equal(capsule.goal, '整理公开资料并给出结论');
  assert.equal(capsule.result, '已完成三条公开来源对比。');
  assert.deepEqual(capsule.keyDecisions, ['只使用公开来源']);
  assert.deepEqual(capsule.unfinishedItems, ['等待负责人采用']);
  assert.equal(capsule.adoptedArtifactRefs.length, 1);
  assert.equal(capsule.adoptedArtifactRefs[0].artifactId, 'report-1');
  assert.equal(JSON.stringify(capsule).includes('rawBody'), false);
  assert.equal(JSON.stringify(capsule).includes('未采用草稿'), false);
});

test('任务上下文胶囊限制数量和长度并脱敏秘密', () => {
  const capsule = buildTaskContextCapsule({
    taskId:'task-2', taskType:'operations.health', status:'failed',
    input:{
      description:`token=secret-value ${'目标'.repeat(400)}`,
      context:{ keyDecisions:Array.from({ length:8 }, (_, index) => `决定${index}`) },
    },
    error:{ userMessage:'authorization=Bearer-bad 调用失败' },
    artifactRefs:Array.from({ length:15 }, (_, index) => ({
      artifactId:`artifact-${index}`, type:'evidence', title:`证据${index}`,
      validation:{ exists:true, readable:true, nonEmpty:true },
    })),
  });
  assert.ok(capsule.goal.length <= 300);
  assert.match(capsule.goal, /token=\[已脱敏\]/);
  assert.equal(capsule.keyDecisions.length, 5);
  assert.equal(capsule.adoptedArtifactRefs.length, 10);
  assert.equal(capsule.evidenceRefs.length, 10);
  assert.doesNotMatch(JSON.stringify(capsule), /secret-value|Bearer-bad/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalArchitect } from '../src/local-architect.ts';

test('架构师基于真实岗位清单给出能力与缺口，不改变边界', async () => {
  const registry = { async list() { return [
    { agentId:'operator', name:'运维官', status:'active', acceptedTaskTypes:['operations.health-review'] },
    { agentId:'future', name:'未来岗位', status:'draft', acceptedTaskTypes:['future.task'] }
  ]; } };
  const architect = new LocalArchitect({ registry, now: () => new Date('2026-07-20T08:00:00.000Z') });
  const result = await architect.execute({ taskId:'task-1', createdAt:'2026-07-20T07:00:00.000Z', input:{ title:'评估现有军团', description:'只评估本地岗位' }, execution:{} });
  const report = result.artifactRefs[0].data;
  assert.equal(result.status, 'succeeded'); assert.equal(result.artifactRefs[0].type, 'architecture_review');
  assert.equal(report.currentCapabilities[0].agentId, 'operator'); assert.equal(report.capabilityGaps[0].agentId, 'future');
  assert.equal(report.externalActionStarted, false); assert.equal(report.architectureChanged, false);
});

test('架构师从真实重复工作中形成带证据的新岗位草案，但不自动创建岗位', async () => {
  const registry = { async list() { return [{ agentId:'operator', name:'运维官', status:'active', acceptedTaskTypes:['operations.health-review'] }]; } };
  const store = { async list() { return [
    { taskId:'1', taskType:'army.intake', status:'needs_input', assigneeAgentId:null, input:{ title:'整理竞品动态' } },
    { taskId:'2', taskType:'army.intake', status:'needs_input', assigneeAgentId:null, input:{ title:'整理竞品动态' } },
    { taskId:'3', taskType:'army.intake', status:'needs_input', assigneeAgentId:null, input:{ title:'整理竞品动态' } }
  ]; } };
  const architect = new LocalArchitect({ registry, store, now:() => new Date('2026-07-21T08:00:00.000Z') });
  const result = await architect.execute({ taskId:'task-architecture', input:{ title:'看看有哪些重复工作', description:'' }, execution:{} });
  const report = result.artifactRefs[0].data;
  assert.equal(report.workEvidence.frequentPatterns[0].count, 3);
  assert.equal(report.roleOpportunities[0].kind, 'new_role_draft');
  assert.equal(report.roleOpportunities[0].evidenceCount, 3);
  assert.equal(report.roleOpportunities[0].status, 'draft_only');
  assert.equal(report.factClaims.some((item) => item.evidenceRefs.includes('task:1')), true);
  assert.equal(report.architectureJudgments[0].confidence, 'medium');
  assert.equal(report.candidateProposals[0].validationPlan.length > 0, true);
  assert.match(report.candidateProposals[0].nonGoals[0], /不在本次评估中创建岗位/);
  assert.equal(report.architectureChanged, false);
});

test('架构师会把用户说需要改进的重复工作排到复盘优先级，不自动新建岗位', async () => {
  const registry = { async list() { return [{ agentId:'public-reporter', name:'公开资料报告员', status:'active', acceptedTaskTypes:['report.public-material'] }]; } };
  const store = { async list() { return [
    { taskId:'1', taskType:'report.public-material', status:'succeeded', assigneeAgentId:'public-reporter', input:{ title:'整理公开网页' }, feedback:{ sentiment:'needs_improvement' } },
    { taskId:'2', taskType:'report.public-material', status:'succeeded', assigneeAgentId:'public-reporter', input:{ title:'整理公开网页' }, feedback:{ sentiment:'useful' } }
  ]; } };
  const architect = new LocalArchitect({ registry, store, now:() => new Date('2026-07-22T08:00:00.000Z') });
  const result = await architect.execute({ taskId:'task-feedback-review', input:{ title:'复盘用户反馈', description:'' }, execution:{} });
  const report = result.artifactRefs[0].data;
  assert.equal(report.workEvidence.frequentPatterns[0].negativeFeedback, 1);
  assert.equal(report.workEvidence.frequentPatterns[0].usefulFeedback, 1);
  assert.match(report.nextAction, /优先复盘/);
  assert.match(report.nextAction, /不急着新建员工/);
});

test('架构师接手陌生低风险工作时，会按已理解目标说明缺少材料和现有员工的下一步', async () => {
  const registry = { async list() { return [
    { agentId:'architect', name:'架构师', status:'active', acceptedTaskTypes:['governance.architecture-review'] },
    { agentId:'candidate-public-researcher', name:'公开资料报告员', status:'active', acceptedTaskTypes:['report.public-material'] }
  ]; } };
  const architect = new LocalArchitect({ registry, store:{ async list() { return []; } }, now:() => new Date('2026-07-22T08:00:00.000Z') });
  const report = (await architect.execute({ taskId:'gap-1', input:{ title:'帮我研究三个竞品', context:{ autoCapabilityAssessment:true, intakeAdvisor:{ understanding:'研究竞品并形成行动清单', deliverable:'中文竞品行动清单', missing:['三个竞品名称或公开链接'] } } }, execution:{} })).artifactRefs[0].data;
  assert.equal(report.understoodRequest.deliverable, '中文竞品行动清单');
  assert.match(report.nextAction, /三个竞品名称或公开链接/);
  assert.match(report.nextAction, /公开资料报告员/);
  assert.match(report.nextAction, /不新建员工/);
});

test('架构师聚合任务关系、失败、成本、产物验证和反馈，并只引用groundTruth合法证据', async () => {
  const registry = { async list() { return [{ agentId:'xiaod', name:'小D', status:'active', acceptedTaskTypes:['media.transcribe-and-refine'] }]; } };
  const store = { async list() { return [
    {
      taskId:'root-1', taskType:'media.transcribe-and-refine', status:'failed', assigneeAgentId:'xiaod',
      input:{ title:'整理公开视频', context:{ failure:{ code:'xiaod_job_failed', category:'transient_external_dependency' } } },
      usage:{ model:{ apiCalls:2, cost:{ amount:0.2, currency:'USD' } }, tools:[{ calls:3 }] },
      artifactRefs:[{ type:'draft', validation:{ exists:true, readable:false, nonEmpty:true } }],
      feedback:{ sentiment:'needs_improvement' },
      updatedAt:'2026-07-29T08:00:00.000Z'
    },
    {
      taskId:'retry-1', parentTaskId:'root-1', taskType:'media.transcribe-and-refine', status:'succeeded', assigneeAgentId:'xiaod',
      input:{ title:'整理公开视频' }, recovery:{ rootTaskId:'root-1', attempt:1 },
      usage:{ model:{ apiCalls:1, cost:{ amount:0.1, currency:'USD' } }, tools:[{ calls:2 }] },
      artifactRefs:[{ type:'confirmed_manuscript', validation:{ exists:true, readable:true, nonEmpty:true } }],
      feedback:{ sentiment:'useful' },
      updatedAt:'2026-07-29T08:10:00.000Z'
    }
  ]; } };
  const report = (await new LocalArchitect({ registry, store, now:() => new Date('2026-07-29T09:00:00.000Z') })
    .execute({ taskId:'architecture-evidence', input:{ title:'复盘任务系统', description:'只读评估' }, execution:{} })).artifactRefs[0].data;
  assert.equal(report.systemEvidence.relations.childTasks, 1);
  assert.equal(report.systemEvidence.relations.recoveryTasks, 1);
  assert.equal(report.systemEvidence.failures.byCategory.transient_external_dependency, 1);
  assert.equal(report.systemEvidence.usage.modelCalls, 3);
  assert.equal(report.systemEvidence.usage.costByCurrency.USD, 0.3);
  assert.equal(report.systemEvidence.artifacts.invalid, 1);
  assert.equal(report.systemEvidence.artifacts.validated, 1);
  assert.equal(report.systemEvidence.feedback.needsImprovement, 1);
  assert.equal(report.evidenceValidation.valid, true);
  assert.deepEqual(report.evidenceValidation.invalidRefs, []);
  assert.equal(report.candidateProposals.some((item) => item.validationPlan && item.rollback && item.evidenceRefs?.length), true);
  assert.equal(report.architectureChanged, false);
});

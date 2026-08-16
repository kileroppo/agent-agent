import assert from 'node:assert/strict';
import test from 'node:test';
import { CrossAgentMissionReconciler } from '../src/cross-agent-mission-reconciler.ts';

test('批准后已生成计划的多人工作会自动继续分派', async () => {
  const mission = { taskId:'mission-approved-1', taskType:'army.cross-agent-mission', status:'running', currentStage:'mission_planned', artifactRefs:[{ type:'cross_agent_mission_plan', data:{} }] };
  const calls = [];
  const reconciler = new CrossAgentMissionReconciler({ store:{ async list(){ return [mission]; } }, missions:{ async dispatch(task){ calls.push(task.taskId); } } });
  await reconciler.reconcile();
  assert.deepEqual(calls, ['mission-approved-1']);
});

test('未批准或已经汇总的多人工作不会被自动分派', async () => {
  const calls = [];
  const reconciler = new CrossAgentMissionReconciler({ store:{ async list(){ return [
    { taskId:'waiting', taskType:'army.cross-agent-mission', status:'waiting_approval', currentStage:'approval_required', artifactRefs:[] },
    { taskId:'done', taskType:'army.cross-agent-mission', status:'running', currentStage:'mission_planned', artifactRefs:[{ type:'cross_agent_mission_plan', data:{} }, { type:'cross_agent_mission_summary', data:{ completed:true } }] }
  ]; } }, missions:{ async dispatch(task){ calls.push(task.taskId); } } });
  await reconciler.reconcile();
  assert.deepEqual(calls, []);
});

test('已批准但卡在规划前的多人工作会自动续接并继续分派', async () => {
  let mission = {
    taskId:'mission-approved-stalled', taskType:'army.cross-agent-mission', status:'queued',
    currentStage:'approval_approved', approvalRefs:['approval-1'], artifactRefs:[],
  };
  const calls = [];
  const store = {
    async list() { return [mission]; },
    async listApprovals() { return [{ approvalId:'approval-1', taskId:mission.taskId, status:'approved', action:'manual-risk-review' }]; },
  };
  const reconciler = new CrossAgentMissionReconciler({ store, missions:{
    async resumeApprovedMission(task) {
      calls.push(['resume', task.taskId]);
      mission = { ...mission, status:'running', currentStage:'mission_planned', artifactRefs:[{ type:'cross_agent_mission_plan' }] };
      return mission;
    },
    async dispatch(task) { calls.push(['dispatch', task.taskId]); },
  } });

  await reconciler.reconcile();
  assert.deepEqual(calls, [
    ['resume', mission.taskId],
    ['dispatch', mission.taskId],
  ]);
});

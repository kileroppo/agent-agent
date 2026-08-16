import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { dispatchBoomSignal } from '../../../integrations/boom-monitor/ajun-intake.ts';
import { AgentRegistry } from '../src/agent-registry.ts';
import { createBoomMonitorService } from '../src/boom-monitor/index.ts';
import { CrossAgentMissionReconciler } from '../src/cross-agent-mission-reconciler.ts';
import { CrossAgentMissionService } from '../src/cross-agent-mission-service.ts';
import { LocalAjunCoordinator } from '../src/local-ajun-coordinator.ts';
import { TaskService } from '../src/task-service.ts';
import { TaskStore } from '../src/task-store.ts';

test('公开作品链接从雷达评分进入真实任务存储，依次完成小D取证、小拆分析和总任务汇总', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'boom-real-flow-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));

  const agentsDir = path.join(root, 'agents');
  await Promise.all([
    writeAgent(agentsDir, {
      agentId:'ajun', name:'A君', kind:'manager', status:'active',
      acceptedTaskTypes:['army.cross-agent-mission'],
    }),
    writeAgent(agentsDir, {
      agentId:'xiaod', name:'小D', status:'active',
      acceptedTaskTypes:['media.transcribe-and-refine'],
    }),
    writeAgent(agentsDir, {
      agentId:'video-content-analyst', name:'小拆', status:'active',
      acceptedTaskTypes:['content.video-benchmark-analysis'],
    }),
    writeAgent(agentsDir, {
      agentId:'reviewer', name:'审核官', status:'active',
      acceptedTaskTypes:['governance.assurance-review'],
    }),
  ]);

  const registry = new AgentRegistry({ agentsDir, snapshotCache:null });
  const store = new TaskStore(path.join(root, 'runtime.json'));
  const executionOrder = [];
  const tasks = new TaskService({
    registry,
    store,
    executors:{
      ajun:new LocalAjunCoordinator({ registry }),
      xiaod:{
        async execute(task) {
          executionOrder.push('xiaod');
          return {
            status:'succeeded', currentStage:'media_evidence_ready',
            execution:{ executor:'xiaod', outcome:'local_fixture_completed' },
            artifactRefs:[
              {
                artifactId:`confirmed-transcript:${task.taskId}`, taskId:task.taskId,
                type:'confirmed_transcript', location:`runtime://${task.taskId}/confirmed-transcript`,
                validation:{ exists:true, readable:true, nonEmpty:true, confirmationMode:'automatic' },
              },
              {
                artifactId:`xiaod-delivery:${task.taskId}`, taskId:task.taskId,
                type:'xiaod_media_delivery', location:`runtime://${task.taskId}/delivery`,
                validation:{ exists:true, readable:true, nonEmpty:true, qualityPassed:true },
                data:{ larkUrl:`runtime://${task.taskId}/delivery`, larkPermissionGranted:true, currentTranscriptDelivered:true },
              },
            ],
          };
        },
      },
      reviewer:{
        async execute(task) {
          executionOrder.push('reviewer');
          const evidenceRef = task.input.context.artifactRefs[0].artifactId;
          return {
            status:'succeeded', currentStage:'quality_review_ready',
            execution:{ executor:'reviewer', outcome:'local_fixture_completed' },
            artifactRefs:[{
              artifactId:`quality-review:${task.taskId}`, taskId:task.taskId,
              type:'employee_role_report', location:`runtime://${task.taskId}/quality-review`,
              validation:{ exists:true, readable:true, nonEmpty:true },
              data:{ qualityReview:{ status:'passed', failedCriteria:[], evidenceRefs:[evidenceRef], safeSummary:'素材产物可读且证据绑定正确。' } },
            }],
          };
        },
      },
      'video-content-analyst':{
        async execute(task) {
          const records = await store.list();
          const dependencyIds = task.input?.context?.dependencyTaskIds || [];
          assert.equal(dependencyIds.length, 1);
          assert.equal(records.find((item) => item.taskId === dependencyIds[0])?.status, 'succeeded');
          executionOrder.push('video-content-analyst');
          return {
            status:'succeeded', currentStage:'analysis_report_ready',
            execution:{ executor:'video-content-analyst', outcome:'local_fixture_completed' },
            artifactRefs:[{
              artifactId:`video-analysis:${task.taskId}`, taskId:task.taskId,
              type:'video_content_analysis_report', location:`runtime://${task.taskId}/analysis`,
              validation:{
                exists:true, readable:true, nonEmpty:true,
                modeStructurePassed:true, semanticValidationPassed:true, formalSourceConfirmed:true,
              },
              data:{ modules:[{ key:'hook', conclusion:'开场先给结果，再解释依据。' }] },
            }],
          };
        },
      },
    },
  });
  const missions = new CrossAgentMissionService({ tasks, store, governance:null });
  const dataDir = path.join(root, 'boom');
  const boom = createBoomMonitorService({
    dbPath:path.join(dataDir, 'boom.sqlite'),
    dataDir,
    collectMetrics:async ({ url, historyLimit }) => {
      assert.equal(url, 'https://example.com/target');
      assert.equal(historyLimit, 20);
      return collectedBundle();
    },
    dispatchBoomSignal:(signal) => dispatchBoomSignal(signal, { missions }),
    getMissionSnapshot:async (taskId) => {
      const records = await store.list();
      return {
        mission:records.find((item) => item.taskId === taskId) || null,
        children:records.filter((item) => item.parentTaskId === taskId),
      };
    },
  });
  t.after(() => boom.close());

  boom.updateSettings({ analysis_auto_enabled:true, analysis_auto_grades:'T1' });
  const collected = await boom.collectUrl({ url:'https://example.com/target', history_limit:20 });
  assert.equal(collected.score.grade, 'T1');
  assert.equal((await store.list()).length, 0);

  const dispatched = await boom.runAnalysisWorker();
  assert.equal(dispatched.processed, 1);
  let records = await store.list();
  const resolvedReviewIds = new Set();
  const reconciler = new CrossAgentMissionReconciler({ store, missions });
  for (let round = 0; round < 4; round += 1) {
    const completedReviews = records.filter((item) => item.taskType === 'governance.assurance-review'
      && item.status === 'succeeded'
      && !resolvedReviewIds.has(item.taskId));
    for (const review of completedReviews) {
      await tasks.deliveryQuality.resolveReview(
        review,
        review.artifactRefs.find((item) => item.type === 'employee_role_report').data.qualityReview,
      );
      resolvedReviewIds.add(review.taskId);
    }
    await reconciler.reconcile();
    records = await store.list();
    if (records.find((item) => item.taskType === 'army.cross-agent-mission')?.status === 'succeeded') break;
  }
  await boom.refreshAnalysisStatuses();

  records = await store.list();
  const mission = records.find((item) => item.taskType === 'army.cross-agent-mission');
  const children = records.filter((item) => item.parentTaskId === mission.taskId);
  const analysis = children.find((item) => item.taskType === 'content.video-benchmark-analysis');
  assert.deepEqual(
    executionOrder,
    ['xiaod', 'reviewer', 'video-content-analyst', 'reviewer'],
    JSON.stringify(records.map((item) => ({ taskType:item.taskType, status:item.status, stage:item.currentStage, error:item.error }))),
  );
  assert.equal(records.length, 5);
  assert.equal(mission.status, 'succeeded');
  assert.equal(children.length, 2);
  assert.ok(children.every((item) => item.status === 'succeeded'));
  assert.equal(resolvedReviewIds.size, 2);
  assert.equal((await store.listApprovals()).length, 0);
  assert.equal(analysis.input.context.boomSignal.workId, 'target');
  assert.equal(analysis.artifactRefs.some((item) => item.type === 'video_content_analysis_report'), true);
  assert.equal(mission.artifactRefs.some((item) => item.type === 'cross_agent_mission_summary'), true);
  assert.equal(boom.listAnalysis().items[0].status, 'completed');
  assert.equal(boom.listAnalysis().items[0].army_task_id, mission.taskId);
});

async function writeAgent(agentsDir, manifest) {
  const directory = path.join(agentsDir, manifest.agentId);
  await fs.mkdir(directory, { recursive:true });
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest), 'utf8');
}

function collectedBundle() {
  return {
    schemaVersion:'agent.army/boom-metrics-bundle/v1', status:'collected', platform:'xiaohongshu',
    sourceUrl:'https://example.com/target', observedAt:'2026-08-15T12:00:00.000Z',
    creator:{ id:'creator-1', name:'作者', followerCount:2_147 },
    currentWork:{ id:'target', title:'端到端测试作品', sourceUrl:'https://example.com/target', likes:93, favorites:34, shares:24, comments:7, plays:null },
    historyWorks:Array.from({ length:12 }, (_, index) => ({ id:`history-${index}`, likes:8, favorites:2, shares:0, comments:0 })),
    historyOrder:'creator_feed_desc', sampleCount:12,
  };
}

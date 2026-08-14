import assert from 'node:assert/strict';
import test from 'node:test';
import { PaperclipHermesTaskReconciler } from '../src/paperclip-hermes-task-reconciler.ts';

function setup({ issueStatus, artifactRefs = [], taskType = 'governance.architecture-review', input = {}, error = null, issueError = null, fallback = null, taskPatch = {} }) {
  let task = {
    taskId:'task-1',
    taskType,
    status:'running',
    currentStage:'paperclip_hermes_running',
    execution:{ owner:'paperclip-hermes' },
    governance:{ paperclipIssueId:'issue-1' },
    input,
    artifactRefs,
    error,
    ...taskPatch,
  };
  const store = {
    async list() { return [task]; },
    async updateTask(taskId, patch) {
      assert.equal(taskId, task.taskId);
      task = { ...task, ...patch };
      return task;
    }
  };
  const governance = {
    async getPaperclipIssue() {
      if (issueError) throw issueError;
      return { status:issueStatus };
    }
  };
  const reconciler = new PaperclipHermesTaskReconciler({
    store,
    governance,
    fallback,
    now:() => Date.parse('2026-07-28T10:00:00.000Z')
  });
  return { reconciler, get task() { return task; } };
}

test('Paperclip 已取消的 Hermes 任务会收口为已取消', async () => {
  const fixture = setup({ issueStatus:'cancelled' });
  await fixture.reconciler.reconcile();
  assert.equal(fixture.task.status, 'cancelled');
  assert.equal(fixture.task.currentStage, 'paperclip_hermes_cancelled');
  assert.equal(fixture.task.execution.outcome, 'cancelled_in_paperclip');
});

test('Paperclip 已阻塞且没有本地产物时如实记为失败', async () => {
  const fixture = setup({ issueStatus:'blocked' });
  await fixture.reconciler.reconcile();
  assert.equal(fixture.task.status, 'failed');
  assert.equal(fixture.task.currentStage, 'paperclip_hermes_failed');
  assert.equal(fixture.task.error.code, 'paperclip_hermes_failed');
});

test('视频分析的 Hermes 外层失败时只接受本机证据化报告兜底', async () => {
  const calls = [];
  const fixture = setup({
    issueStatus:'blocked',
    taskType:'content.video-benchmark-analysis',
    input:{ analysisIntent:'digest', evidenceMode:'formal' },
    artifactRefs:[{
      artifactId:'employee-report-1',
      type:'employee_role_report',
      validation:{ exists:true, readable:true, nonEmpty:true },
    }],
    fallback:async (task) => {
      calls.push(task.taskId);
      return {
        status:'succeeded',
        currentStage:'digest_analysis_ready',
        artifactRefs:[{
          type:'video_content_analysis_report',
          sourceRefs:['confirmed-transcript-1'],
          validation:{
            exists:true,
            readable:true,
            nonEmpty:true,
            modeStructurePassed:true,
            claimsEvidenceLinked:true,
            formalSourceConfirmed:true,
            analysisIntent:'digest',
            reportVersion:'video-analysis/v2'
          },
          data:{
            analysisIntent:'digest',
            reportVersion:'video-analysis/v2',
            generationMode:'deterministic_fallback',
            sourceTranscriptArtifactId:'confirmed-transcript-1'
          }
        }]
      };
    }
  });

  await fixture.reconciler.reconcile();

  assert.deepEqual(calls, ['task-1']);
  assert.equal(fixture.task.status, 'succeeded');
  assert.equal(fixture.task.currentStage, 'local_evidence_fallback_ready');
  assert.equal(fixture.task.execution.outcome, 'local_evidence_fallback_ready');
  assert.equal(fixture.task.artifactRefs.some((artifact) => artifact.type === 'employee_role_report'), true);
  assert.equal(
    fixture.task.artifactRefs.find((artifact) => artifact.type === 'video_content_analysis_report').data.reportVersion,
    'video-analysis/v2',
  );
});

test('正式深度拆解的本机兜底只进入待测试，不冒充模型深度分析成功', async () => {
  const fixture = setup({
    issueStatus:'failed',
    taskType:'content.video-benchmark-analysis',
    input:{ analysisIntent:'deep', evidenceMode:'formal' },
    fallback:async () => ({
      status:'succeeded',
      artifactRefs:[{
        type:'video_content_analysis_report',
        sourceRefs:['confirmed-transcript-1'],
        validation:{
          exists:true,
          readable:true,
          nonEmpty:true,
          modeStructurePassed:true,
          claimsEvidenceLinked:true,
          formalSourceConfirmed:true,
          analysisIntent:'deep',
          reportVersion:'video-analysis/v2'
        },
        data:{
          analysisIntent:'deep',
          reportVersion:'video-analysis/v2',
          generationMode:'deterministic_fallback',
          sourceTranscriptArtifactId:'confirmed-transcript-1'
        }
      }]
    })
  });

  await fixture.reconciler.reconcile();

  assert.equal(fixture.task.status, 'waiting_test');
  assert.equal(fixture.task.currentStage, 'local_evidence_fallback_waiting_test');
  assert.equal(fixture.task.error.code, 'local_evidence_fallback_requires_review');
});

test('本机兜底报告缺少证据校验或模式不匹配时仍如实失败', async () => {
  const fixture = setup({
    issueStatus:'blocked',
    taskType:'content.video-benchmark-analysis',
    input:{ analysisIntent:'style', evidenceMode:'formal' },
    fallback:async () => ({
      status:'succeeded',
      artifactRefs:[{
        type:'video_content_analysis_report',
        validation:{ exists:true, readable:true, nonEmpty:true, modeStructurePassed:true },
        data:{ analysisIntent:'digest', reportVersion:'video-analysis/v2', generationMode:'deterministic_fallback' }
      }]
    })
  });

  await fixture.reconciler.reconcile();

  assert.equal(fixture.task.status, 'failed');
  assert.equal(fixture.task.currentStage, 'paperclip_hermes_failed');
});

test('非视频任务不调用本机视频分析兜底', async () => {
  let calls = 0;
  const fixture = setup({
    issueStatus:'blocked',
    fallback:async () => {
      calls += 1;
      return null;
    }
  });

  await fixture.reconciler.reconcile();

  assert.equal(calls, 0);
  assert.equal(fixture.task.status, 'failed');
});

test('Paperclip 已阻塞但留有可读产物时转为待测试而不冒充成功', async () => {
  const priorError = { code:'paperclip_hermes_reported_failure', userMessage:'员工回报失败。' };
  const fixture = setup({
    issueStatus:'blocked',
    error:priorError,
    artifactRefs:[{
      type:'video_content_analysis_report',
      validation:{ exists:true, readable:true, nonEmpty:true, semanticValidationPassed:false }
    }]
  });
  await fixture.reconciler.reconcile();
  assert.equal(fixture.task.status, 'waiting_test');
  assert.equal(fixture.task.currentStage, 'paperclip_hermes_waiting_test');
  assert.equal(fixture.task.error, priorError);
});

test('Paperclip 标记完成但缺少本地证据时转为待测试', async () => {
  const fixture = setup({ issueStatus:'done' });
  await fixture.reconciler.reconcile();
  assert.equal(fixture.task.status, 'waiting_test');
  assert.equal(fixture.task.currentStage, 'paperclip_hermes_evidence_missing');
});

test('Paperclip 标记视频任务完成但只有泛化岗位回报时仍转为待测试', async () => {
  const fixture = setup({
    issueStatus:'done',
    taskType:'content.video-benchmark-analysis',
    input:{ analysisIntent:'digest', evidenceMode:'formal' },
    artifactRefs:[{
      type:'employee_role_report',
      validation:{ exists:true, readable:true, nonEmpty:true },
      data:{ summary:'已处理。' }
    }]
  });

  await fixture.reconciler.reconcile();

  assert.equal(fixture.task.status, 'waiting_test');
  assert.equal(fixture.task.currentStage, 'paperclip_hermes_evidence_missing');
});

test('Paperclip 标记视频任务完成且正式报告通过对应门禁时才收口成功', async () => {
  const fixture = setup({
    issueStatus:'done',
    taskType:'content.video-benchmark-analysis',
    input:{ analysisIntent:'digest', evidenceMode:'formal' },
    artifactRefs:[{
      type:'video_content_analysis_report',
      validation:{
        exists:true,
        readable:true,
        nonEmpty:true,
        modeStructurePassed:true,
        claimsEvidenceLinked:true,
        formalSourceConfirmed:true,
        analysisIntent:'digest',
        reportVersion:'video-analysis/v2'
      },
      data:{
        analysisIntent:'digest',
        reportVersion:'video-analysis/v2',
        modules:[{ name:'定位与受众' }]
      }
    }]
  });

  await fixture.reconciler.reconcile();

  assert.equal(fixture.task.status, 'succeeded');
  assert.equal(fixture.task.currentStage, 'paperclip_hermes_completed');
});

test('Paperclip 暂时不可用时不刷新或改写任务真相', async () => {
  const fixture = setup({ issueError:new Error('connect refused') });
  await fixture.reconciler.reconcile();
  assert.equal(fixture.task.status, 'running');
  assert.equal(fixture.task.currentStage, 'paperclip_hermes_running');
});

test('重启后会把 Paperclip 已生效的待确认终态收口为 confirmed', async () => {
  const fixture = setup({
    issueStatus:'blocked',
    taskPatch:{
      status:'waiting_test',
      currentStage:'paperclip_hermes_waiting_test',
      governance:{
        paperclipIssueId:'issue-1',
        completionSync:{
          status:'pending',
          paperclipIssueId:'issue-1',
          paperclipRunId:'run-1',
          taskStatus:'waiting_test',
          expectedIssueStatus:'blocked',
          requestedAt:'2026-07-28T09:59:00.000Z'
        }
      }
    }
  });
  await fixture.reconciler.reconcile();
  assert.equal(fixture.task.status, 'waiting_test');
  assert.equal(fixture.task.governance.completionSync.status, 'confirmed');
  assert.equal(fixture.task.governance.completionSync.paperclipRunId, 'run-1');
  assert.equal(fixture.task.governance.syncedAt, '2026-07-28T10:00:00.000Z');
});

test('重启后外部终态尚未生效或不可读时保留 pending，不伪造同步完成', async (t) => {
  for (const [name, issueStatus, issueError] of [
    ['仍在运行', 'in_progress', null],
    ['Paperclip 不可读', null, new Error('temporarily unavailable')]
  ]) {
    await t.test(name, async () => {
      const fixture = setup({
        issueStatus,
        issueError,
        taskPatch:{
          status:'failed',
          currentStage:'paperclip_hermes_failed',
          governance:{
            paperclipIssueId:'issue-1',
            completionSync:{
              status:'pending',
              paperclipIssueId:'issue-1',
              paperclipRunId:'run-1',
              taskStatus:'failed',
              expectedIssueStatus:'blocked',
              requestedAt:'2026-07-28T09:59:00.000Z'
            }
          }
        }
      });
      await fixture.reconciler.reconcile();
      assert.equal(fixture.task.status, 'failed');
      assert.equal(fixture.task.governance.completionSync.status, 'pending');
    });
  }
});

test('技术修复任务继续交由专用收口器处理', async () => {
  const fixture = setup({ issueStatus:'blocked', taskType:'operations.technical-repair' });
  await fixture.reconciler.reconcile();
  assert.equal(fixture.task.status, 'running');
});

export class LocalTechnicalExpert {
  constructor({ now = () => new Date(), workspace = null, runner = null, promotion = null } = {}) { this.now = now; this.workspace = workspace; this.runner = runner; this.promotion = promotion; }

  async execute(task) {
    const createdAt = this.now().toISOString();
    const context = task.input?.context || {};
    const failure = context.failure || {};
    const diagnosis = context.diagnosis || null;
    const classification = context.failureClassification || null;
    const engineeringAssigned = Boolean(task.governance?.paperclipAssigneeAgentId);
    const preparedWorkspace = this.workspace ? await this.workspace.prepare(task) : null;
    const run = preparedWorkspace && this.runner ? await this.runner.run(task, preparedWorkspace.workspace) : null;
    const promotion = run?.status === 'evidence_ready' && this.promotion ? await this.promotion.promote({ ...task, execution:{ ...(task.execution || {}), workspace:{ path:preparedWorkspace.workspace } } }, run.evidence) : null;
    const verification = verifiedRepairEvidence(task, run, promotion);
    const caseRecord = {
      failedTaskId: context.failedTaskId || task.parentTaskId || null,
      failure: {
        code: String(failure.code || 'unknown_failure'),
        category: String(failure.category || 'manual'),
        stage: String(failure.stage || 'unknown'),
        retryable: failure.retryable === true
      },
      diagnosis: diagnosisFor(failure),
      diagnosisDetail:diagnosis ? {
        status:diagnosis.status || null,
        failureClass:diagnosis.failureClass || classification?.failureClass || 'unknown',
        summary:diagnosis.summary || diagnosis.reason || null,
        evidence:Array.isArray(diagnosis.evidence) ? diagnosis.evidence : [],
        nextAction:diagnosis.nextAction || null,
        route:context.technicalRoute || classification?.route || null
      } : classification,
      nextAction: !context.repairScope
        ? diagnosis?.nextAction || diagnosis?.reason || classification?.reason || '补充最小诊断证据后再决定是否进入代码修复。'
        : nextActionFor(preparedWorkspace, run, promotion, engineeringAssigned),
      implementationStarted: ['evidence_ready', 'evidence_missing', 'failed', 'waiting_for_test'].includes(run?.status),
      engineeringAssigned,
      workspacePrepared: Boolean(preparedWorkspace),
      ...(verification ? { verification } : {}),
      paperclipIssueRef: task.governance?.paperclipIssueIdentifier || null,
      createdAt
    };
    return {
      status: !context.repairScope || requiresFollowUpTest(run, promotion) ? 'waiting_test' : preparedWorkspace || engineeringAssigned ? 'running' : 'succeeded',
      currentStage: !context.repairScope ? 'technical_diagnosis_ready' : stageFor(preparedWorkspace, run, promotion, engineeringAssigned),
      execution: {
        executor: 'technical-expert',
        mode: run ? 'isolated_technical_repair' : preparedWorkspace ? 'isolated_repair_workspace_prepared' : 'technical_repair_triage',
        startedAt: task.execution?.startedAt || createdAt,
        finishedAt: this.now().toISOString(),
        outcome: !context.repairScope ? 'diagnosis_only' : promotion?.status || run?.status || (preparedWorkspace ? 'workspace_prepared' : engineeringAssigned ? 'engineering_assigned' : 'repair_required'),
        ...(verification ? { verification } : {}),
        ...(run?.reason ? { runnerError:run.reason } : {}),
        ...(preparedWorkspace ? { workspace:{ path:preparedWorkspace.workspace, reused:preparedWorkspace.reused } } : {})
      },
      artifactRefs: [{
        artifactId: `technical-repair:${task.taskId}`,
        taskId: task.taskId,
        type: 'technical_repair_case',
        title: '技术专家修复任务',
        location: `runtime://${task.taskId}/technical-repair`,
        mimeType: 'application/json',
        accessScope: 'local-owner',
        validation: { exists: true, readable: true, nonEmpty: true },
        createdAt,
        data: caseRecord
      }, ...(!context.repairScope ? [{
        artifactId:`technical-diagnosis:${task.taskId}`,
        taskId:task.taskId,
        type:'technical_diagnosis_report',
        title:'技术专家根因分流报告',
        location:`runtime://${task.taskId}/technical-diagnosis`,
        mimeType:'application/json',
        accessScope:'local-owner',
        validation:{ exists:true, readable:true,nonEmpty:true, codeRepairAttempted:false },
        createdAt,
        data:{
          failedTaskId:caseRecord.failedTaskId,
          failureClass:diagnosis?.failureClass || classification?.failureClass || 'unknown',
          route:context.technicalRoute || classification?.route || 'diagnose_before_action',
          summary:diagnosis?.summary || diagnosis?.reason || classification?.reason || caseRecord.diagnosis,
          evidence:Array.isArray(diagnosis?.evidence) ? diagnosis.evidence : [],
          nextAction:diagnosis?.nextAction || classification?.reason || '补充最小诊断证据后再决定是否进入代码修复。',
          codeRepairAttempted:false
        }
      }] : []), ...(preparedWorkspace ? [{
        artifactId:`repair-workspace:${task.taskId}`, taskId:task.taskId, type:'isolated_repair_workspace', title:'本次修复的独立副本已准备',
        location:`file://${preparedWorkspace.workspace}`, mimeType:'application/json', accessScope:'local-owner', validation:{ exists:true, readable:true, nonEmpty:true }, createdAt,
        data:{ workspace:preparedWorkspace.workspace, reused:preparedWorkspace.reused, mainDirectoryUntouched:true }
      }] : [])]
    };
  }
}

function verifiedRepairEvidence(task, run, promotion) {
  if (promotion?.status !== 'promoted') return null;
  const proof = run?.evidence?.metadata?.agentArmyRepairEvidence || {};
  if (proof.testsPassed !== true || proof.recoveryVerified !== true) return null;
  return {
    verified:true,
    changedFiles:Array.isArray(promotion.changedFiles) ? promotion.changedFiles : [],
    testsPassed:true,
    testCommand:String(task.input?.context?.repairScope?.testCommand || '').slice(0, 1000),
    testSummary:String(proof.testSummary || '').slice(0, 2000),
    recoveryVerified:true,
    recoveryCheck:String(task.input?.context?.repairScope?.recoveryCheck || '').slice(0, 1000),
    recoverySummary:String(proof.recoverySummary || '').slice(0, 2000),
    remainingTests:Array.isArray(proof.remainingTests) ? proof.remainingTests.slice(0, 20).map((item) => String(item || '').slice(0, 500)) : []
  };
}

function requiresFollowUpTest(run, promotion) {
  return ['waiting_for_test', 'waiting_for_scope', 'evidence_missing', 'failed'].includes(run?.status)
    || ['rejected', 'conflict'].includes(promotion?.status);
}

function stageFor(workspace, run, promotion, engineeringAssigned) {
  if (promotion?.status === 'promoted') return 'repair_promoted_awaiting_record';
  if (promotion?.status === 'conflict') return 'repair_promotion_conflict';
  if (promotion?.status === 'rejected') return 'repair_promotion_rejected';
  if (run?.status === 'evidence_ready') return 'repair_evidence_ready';
  if (run?.status === 'evidence_missing') return 'repair_evidence_missing';
  if (run?.status === 'waiting_for_test') return 'repair_waiting_for_test';
  if (run?.status === 'waiting_for_scope') return 'repair_scope_pending';
  if (run?.status === 'failed') return 'technical_repair_runner_failed';
  if (workspace) return 'isolated_workspace_ready';
  return engineeringAssigned ? 'paperclip_engineering_assigned' : 'technical_repair_case_ready';
}

function nextActionFor(workspace, run, promotion, engineeringAssigned) {
  if (promotion?.status === 'promoted') return 'A君 已核对范围、自动检查和恢复检查，并安全带回主工程；等待治理记录完成。';
  if (promotion?.status === 'conflict') return `主工程出现同时改动，A君 未覆盖：${promotion.reason}`;
  if (promotion?.status === 'rejected') return `A君 未带回本轮改动：${promotion.reason}`;
  if (run?.status === 'evidence_ready') return '技术专家已在独立副本留下修复结果；A君 将核对修改、测试和恢复检查后再决定是否带回主工程。';
  if (run?.status === 'evidence_missing') return '技术专家已执行，但没有留下完整修复结果；任务保持处理中，不会带回主工程。';
  if (run?.status === 'waiting_for_test') return '本轮自动检查超时，任务已标记为待测试；独立副本和现有记录已保留，A君可以继续处理其他任务。';
  if (run?.status === 'waiting_for_scope') return '技术诊断尚未给出可安全执行的修复范围，任务已标记为待测试；不会猜测改动主工程。';
  if (run?.status === 'failed') return `技术专家本轮没有完成：${run.reason || '原因未明'}。任务和独立副本已保留。`;
  if (workspace) return 'A君已为本次修复准备单独修理副本；主运行目录不会被直接修改。等待技术专家在该副本完成修改、测试和复核证据。';
  return engineeringAssigned ? 'Paperclip 已登记技术专家修复工作；等待 A君 建立独立修理副本后再开始修改。' : '需要技术专家接入受控工程执行器后实施修复；当前已保留问题、来源任务和恢复记录。';
}

function diagnosisFor(failure) {
  if (failure.code === 'xiaod_status_unavailable') return '小D状态通道连续不可用，安全重试已用尽，需要检查本机服务、启动配置和状态查询链路。';
  if (failure.code === 'xiaod_job_failed') return '小D业务任务在执行阶段失败，自动重试未能解决，需要按失败阶段检查内容获取或处理链路。';
  if (failure.code === 'executor_failed') return '本机执行器抛出未处理错误，需要定位对应员工执行器并补回归测试。';
  return '现有自动恢复规则无法安全处理该故障，需要技术专家进一步定位。';
}

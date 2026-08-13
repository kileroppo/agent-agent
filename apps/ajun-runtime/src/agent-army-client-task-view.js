import { presentTask } from './task-presentation.js';

export function agentArmyTaskView(task = {}, approvals = [], detailBaseUrl = '') {
  const taskApprovals = (approvals || []).filter((approval) => (task.approvalRefs || []).includes(approval.approvalId));
  return {
    taskId:task.taskId,
    title:safeText(task.input?.title, 500),
    taskType:safeText(task.taskType, 120),
    agentId:safeText(task.assigneeAgentId || task.routing?.requestedAgentId, 80) || null,
    status:safeText(task.status, 60),
    currentStage:safeText(task.currentStage, 120),
    updatedAt:task.updatedAt || null,
    progress:task.execution?.xiaodProgress ?? null,
    requiresApproval:taskApprovals.some((approval) => approval.status === 'pending'),
    approvals:taskApprovals.map(agentArmyApprovalView),
    error:task.error ? {
      code:safeText(task.error.code, 120),
      category:safeText(task.error.category, 80),
      retryable:task.error.retryable === true,
      userMessage:safeText(task.error.userMessage, 1000)
    } : null,
    artifacts:(task.artifactRefs || []).map(artifactView),
    presentation:presentTask(task, { approvals:taskApprovals, detailBaseUrl })
  };
}

export function agentArmyApprovalView(approval = {}) {
  return {
    approvalId:approval.approvalId,
    taskId:approval.taskId || null,
    status:safeText(approval.status, 40),
    governanceMode:safeText(approval.governanceMode, 40),
    action:safeText(approval.action, 100),
    riskLevel:safeText(approval.riskLevel, 40),
    reason:safeText(approval.reason, 700),
    requestedScope:approval.requestedScope ? {
      title:safeText(approval.requestedScope.title, 500),
      taskType:safeText(approval.requestedScope.taskType, 120),
      assigneeAgentId:safeText(approval.requestedScope.assigneeAgentId, 80) || null
    } : null,
    validUntil:approval.validUntil || null,
    privateReadGrantStatus:approval.privateReadGrantStatus ? {
      status:safeText(approval.privateReadGrantStatus.status, 40),
      remainingUses:Number(approval.privateReadGrantStatus.remainingUses) || 0,
      expiresAt:approval.privateReadGrantStatus.expiresAt || null
    } : null
  };
}

function artifactView(artifact = {}) {
  const validation = artifact.validation || {};
  const view = {
    type:safeText(artifact.type, 120),
    ref:safeText(artifact.ref || artifact.url || artifact.location || artifact.data?.larkUrl, 1000) || null,
    verified:artifact.data?.larkPermissionGranted === true
      || artifact.verified === true
      || (validation.exists === true && validation.readable === true && validation.nonEmpty === true)
  };
  if (artifact.type === 'health_report' && artifact.data) {
    view.report = {
      checkedAt:artifact.data.checkedAt || null,
      overall:safeText(artifact.data.overall, 40),
      components:(Array.isArray(artifact.data.components) ? artifact.data.components : []).slice(0, 12).map((item) => ({
        id:safeText(item?.id, 80),
        name:safeText(item?.name, 120),
        status:safeText(item?.status, 40),
        detail:safeText(item?.detail, 500)
      })),
      recommendedAction:safeText(artifact.data.recommendedAction, 500)
    };
  }
  if (artifact.type === 'intel_research_report' && artifact.data) {
    view.report = {
      topic:safeText(artifact.data.topic, 500),
      background:safeText(artifact.data.background, 1200),
      findings:safeStringList(artifact.data.findings, 8, 800),
      conclusion:safeText(artifact.data.conclusion, 1200),
      recommendations:safeStringList(artifact.data.recommendations, 8, 800),
      openQuestions:safeStringList(artifact.data.openQuestions, 8, 800),
      sources:(Array.isArray(artifact.data.sources) ? artifact.data.sources : []).slice(0, 5).map((item) => ({
        title:safeText(item?.title, 300),
        source:safeText(item?.source, 1000),
        summary:safeText(item?.summary, 900)
      }))
    };
  }
  if (artifact.type === 'office_briefing_package' && artifact.data) {
    view.report = {
      title:safeText(artifact.data.title, 500),
      summary:safeText(artifact.data.summary, 1200),
      sourceTasks:(Array.isArray(artifact.data.sourceTasks) ? artifact.data.sourceTasks : []).slice(0, 10).map((item) => ({
        taskId:safeText(item?.taskId, 100),
        title:safeText(item?.title, 500),
        employeeId:safeText(item?.employeeId, 80) || null,
        status:safeText(item?.status, 60)
      })),
      openItems:safeStringList(artifact.data.openItems, 8, 600),
      nextAction:safeText(artifact.data.nextAction, 800)
    };
  }
  if (artifact.type === 'autonomous_work_plan' && artifact.data?.plan) {
    const plan = artifact.data.plan;
    view.report = {
      status:safeText(plan.status, 60),
      version:Number.isSafeInteger(plan.version) ? plan.version : null,
      steps:(Array.isArray(plan.steps) ? plan.steps : []).slice(0, 20).map((step) => ({
        stepId:safeText(step?.stepId, 128),
        objective:safeText(step?.objective, 500),
        status:safeText(step?.status, 60),
        dependsOn:safeStringList(step?.dependsOn, 20, 128)
      })),
      budget:{
        maxDurationMs:Number(plan.budget?.hardLimits?.maxDurationMs) || null,
        maxModelCalls:Number(plan.budget?.hardLimits?.maxModelCalls) || null,
        maxConcurrency:Number(plan.budget?.hardLimits?.maxConcurrency) || null,
        maxDelegationDepth:Number(plan.budget?.hardLimits?.maxDelegationDepth) || null,
        approvalThresholdUsd:Number(plan.budget?.approvalThresholdUsd) || 0
      }
    };
  }
  if (artifact.type === 'capability_discovery_report' && artifact.data) {
    view.report = {
      requestedCount:Number(artifact.data.requestedCount) || 0,
      activeCount:Number(artifact.data.activeCount) || 0,
      results:(Array.isArray(artifact.data.results) ? artifact.data.results : []).slice(0, 20).map((item) => ({
        capabilityId:safeText(item?.capabilityId, 120),
        status:safeText(item?.status, 60),
        reason:safeText(item?.reason, 500)
      }))
    };
  }
  if (artifact.type === 'cross_agent_mission_summary' && artifact.data) {
    view.report = {
      kind:safeText(artifact.data.kind, 60),
      summary:safeText(artifact.data.summary, 1000),
      completed:artifact.data.completed === true,
      terminal:artifact.data.terminal === true,
      statuses:(Array.isArray(artifact.data.statuses) ? artifact.data.statuses : []).slice(0, 11).map((item) => ({
        title:safeText(item?.title, 500),
        employeeId:safeText(item?.employeeId, 80) || null,
        taskId:safeText(item?.taskId, 100) || null,
        status:safeText(item?.status, 60),
        artifactTypes:safeStringList(item?.artifactTypes, 10, 120)
      })),
      outcome:safeText(artifact.data.decision?.outcome, 60),
      briefing:artifact.data.decision?.briefing ? {
        title:safeText(artifact.data.decision.briefing.title, 500),
        summary:safeText(artifact.data.decision.briefing.summary, 1000),
        openItems:safeStringList(artifact.data.decision.briefing.openItems, 5, 500),
        nextAction:safeText(artifact.data.decision.briefing.nextAction, 500)
      } : null
    };
  }
  return view;
}

function safeText(value, limit = 500) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function safeStringList(value, maxItems, maxChars) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return [...new Set(values.map((item) => safeText(item, maxChars)).filter(Boolean))].slice(0, maxItems);
}

import { DeterministicLocalHealthProbe } from './deterministic-local-health-probe.js';

const DEFAULT_COMPONENT_REGISTRY = [
  { id:'ajun-runtime', name:'A君运行台', dependencies:[], owner:'operator', recoveryPlaybooks:['observe_then_restart_known_service'] },
  { id:'xiaod', name:'小D素材处理', dependencies:['ajun-runtime'], owner:'operator', recoveryPlaybooks:['retry_from_checkpoint', 'escalate_technical_expert'] },
  { id:'paperclip', name:'Paperclip 治理台', dependencies:[], owner:'operator', recoveryPlaybooks:['verify_local_service', 'escalate_technical_expert'] }
];

export class LocalHealthOperator {
  constructor({ governance, runtimeProbe = new DeterministicLocalHealthProbe(), componentRegistry = DEFAULT_COMPONENT_REGISTRY, now = () => new Date() } = {}) {
    this.governance = governance; this.runtimeProbe = runtimeProbe; this.componentRegistry = normalizeRegistry(componentRegistry); this.now = now;
  }

  async execute(task) {
    if (task.taskType === 'operations.failure-recovery') return this.reviewFailure(task);
    const checkedAt = this.now().toISOString();
    const [governance, runtimeComponents] = await Promise.all([this.governance.health(), this.runtimeProbe.check()]);
    const components = [
      ...runtimeComponents,
      { id: 'paperclip', name: 'Paperclip 治理台', status: governance.status === 'ready' ? 'healthy' : 'degraded', detail: governance.status === 'ready' ? `本机连接正常（${governance.version || '版本未知'}）。` : '暂时无法确认本机治理台；任务和结果仍保留在 A君运行台。' }
    ].map((component) => attachDependencies(component, this.componentRegistry));
    const overall = components.every((item) => item.status === 'healthy') ? 'healthy' : 'degraded';
    const incidents = correlateHealthIncidents(components, this.componentRegistry);
    const report = {
      schemaVersion:'agent.army/operations-health/v1',
      checkedAt,
      overall,
      components,
      dependencyGraph:this.componentRegistry.map((item) => ({ componentId:item.id, dependencies:item.dependencies })),
      incidents,
      recoveryPolicy:{ unknownOrHighRiskAction:'escalate_technical_expert', directUnknownActionAllowed:false },
      recommendedAction: overall === 'healthy'
        ? '无需恢复动作。'
        : `先检查 Paperclip 本机服务，并按登记依赖逐项验证：${incidents.map((item) => item.componentId).join('、') || '异常组件'}；不要尝试重置账号、凭据或外部连接。`
    };
    return {
      status: 'succeeded', currentStage: 'health_report_ready',
      execution: { executor: 'operator', mode: 'local_health_review', startedAt: task.execution?.startedAt || checkedAt, finishedAt: this.now().toISOString(), outcome: overall },
      usage: { tools:[{ id:'deterministic-local-health-probe', name:'登记服务只读健康检查', calls:2 }, { id:'paperclip-health', name:'治理台健康检查', calls:1 }] },
      artifactRefs: [{ artifactId: `health-report:${task.taskId}`, taskId: task.taskId, type: 'health_report', title: '本地运行健康报告', location: `runtime://${task.taskId}/health-report`, mimeType: 'application/json', accessScope: 'local-owner', validation: { exists: true, readable: true, nonEmpty: true }, createdAt: checkedAt, data: report }]
    };
  }

  async reviewFailure(task) {
    const checkedAt = this.now().toISOString();
    const context = task.input?.context || {};
    const failure = context.failure || {};
    const registry = this.componentRegistry;
    const componentId = String(context.componentId || failure.componentId || '').trim() || inferComponentId(failure);
    const component = registry.find((item) => item.id === componentId) || null;
    const incidentCorrelation = correlateFailureEvents({
      componentId,
      failure,
      events:Array.isArray(context.incidentEvents) ? context.incidentEvents : [],
      registry,
      checkedAt
    });
    const highRisk = failure.highRisk === true || ['authorization_or_permission', 'data_loss', 'security'].includes(String(context.failureClassification?.failureClass || failure.category || ''));
    const canRetry = failure.retryable === true
      && Boolean(context.sourceUrl)
      && Number(context.attempt || 0) < Number(context.maxAutomaticRetries || 0)
      && !highRisk
      && Boolean(component);
    const playbook = selectRecoveryPlaybook({ canRetry, component, failure, highRisk });
    const decision = {
      schemaVersion:'agent.army/recovery-decision/v1',
      failedTaskId: context.failedTaskId || task.parentTaskId || null,
      action: canRetry ? 'retry_once' : 'escalate_technical_expert',
      reason: canRetry ? '故障被标记为可重试，原始公开来源仍存在，且尚未超过自动重试上限。' : '故障不可安全自动恢复，或自动重试次数已经用尽。',
      component:{ componentId, registered:Boolean(component), dependencies:component?.dependencies || [] },
      incidentCorrelation,
      playbook,
      postRecoveryVerification:postRecoveryChecks({ component, failure, context }),
      rollbackRecommendation:canRetry
        ? '若重试后健康探测、任务状态或产物验证任一未恢复，停止继续尝试，保留原 checkpoint 并升级技术专家。'
        : '不执行未知恢复动作；保留现有状态、日志引用和 checkpoint，由技术专家在隔离范围提出可回滚修复。',
      executionAuthorized:canRetry,
      unknownOrHighRiskActionExecuted:false,
      automaticRetryLimit: Number(context.maxAutomaticRetries || 0),
      attempt: Number(context.attempt || 0),
      checkedAt
    };
    return {
      status: 'succeeded', currentStage: 'recovery_decision_ready',
      execution: { executor: 'operator', mode: 'failure_recovery_review', startedAt: task.execution?.startedAt || checkedAt, finishedAt: this.now().toISOString(), outcome: decision.action },
      artifactRefs: [{ artifactId: `recovery-decision:${task.taskId}`, taskId: task.taskId, type: 'recovery_decision', title: '运维官恢复决定', location: `runtime://${task.taskId}/recovery-decision`, mimeType: 'application/json', accessScope: 'local-owner', validation: { exists: true, readable: true, nonEmpty: true }, createdAt: checkedAt, data: decision }]
    };
  }
}

function selectRecoveryPlaybook({ canRetry, component, failure, highRisk }) {
  if (!component) return { playbookId:'unregistered_component_escalation', selectedFromRegistry:false, steps:['登记组件及依赖', '由技术专家在隔离环境诊断'], externalSideEffects:false };
  if (highRisk) return { playbookId:'high_risk_escalation', selectedFromRegistry:true, steps:['冻结自动恢复', '保留脱敏证据', '升级技术专家和负责人'], externalSideEffects:false };
  if (canRetry) return {
    playbookId:component.recoveryPlaybooks.includes('retry_from_checkpoint') ? 'retry_from_checkpoint' : 'registered_safe_retry',
    selectedFromRegistry:true,
    steps:['确认原始公开来源仍可读取', '从已登记 checkpoint 仅重试一次', '执行恢复后验证'],
    externalSideEffects:false
  };
  return { playbookId:'registered_component_escalation', selectedFromRegistry:true, steps:['停止自动重试', '收集组件和依赖事件', '升级技术专家'], externalSideEffects:false };
}

function correlateHealthIncidents(components, registry) {
  const statusById = new Map(components.map((item) => [item.id, item.status]));
  return components.filter((item) => item.status !== 'healthy').map((item) => {
    const registered = registry.find((entry) => entry.id === item.id);
    const unhealthyDependencies = (registered?.dependencies || []).filter((dependency) => statusById.get(dependency) !== 'healthy');
    const affectedDependents = registry.filter((entry) => entry.dependencies.includes(item.id)).map((entry) => entry.id);
    return {
      incidentId:`health:${item.id}`,
      componentId:item.id,
      status:item.status,
      likelyDependencyIncident:unhealthyDependencies.length > 0,
      unhealthyDependencies,
      affectedDependents
    };
  });
}

function correlateFailureEvents({ componentId, failure, events, registry, checkedAt }) {
  const now = Date.parse(checkedAt);
  const dependencyIds = new Set(registry.find((item) => item.id === componentId)?.dependencies || []);
  const related = events.filter((event) => {
    const occurredAt = Date.parse(event?.occurredAt || '');
    const closeInTime = Number.isFinite(occurredAt) && Number.isFinite(now) && Math.abs(now - occurredAt) <= 15 * 60 * 1000;
    const sameComponent = String(event?.componentId || '') === componentId;
    const dependencyEvent = dependencyIds.has(String(event?.componentId || ''));
    const sameCode = failure.code && String(event?.code || '') === String(failure.code);
    return closeInTime && (sameComponent || dependencyEvent || sameCode);
  }).slice(-12).map((event) => ({
    eventId:String(event.eventId || ''),
    componentId:String(event.componentId || ''),
    code:String(event.code || 'unknown'),
    occurredAt:String(event.occurredAt || ''),
    relation:String(event.componentId || '') === componentId ? 'same_component' : dependencyIds.has(String(event.componentId || '')) ? 'dependency' : 'same_failure_code'
  }));
  return { windowMinutes:15, relatedEventCount:related.length, relatedEvents:related };
}

function postRecoveryChecks({ component, failure, context }) {
  return [
    { checkId:'component_health', required:true, description:`${component?.name || '目标组件'}健康探测恢复为 healthy。` },
    { checkId:'original_failure_absent', required:true, description:`原故障 ${failure.code || 'unknown_failure'} 不再出现。` },
    { checkId:'task_checkpoint_continuity', required:true, description:'任务从原 checkpoint 继续且没有重复副作用步骤。' },
    { checkId:'artifact_validation', required:true, description:context.expectedArtifactType ? `产物 ${context.expectedArtifactType} 通过 exists/readable/nonEmpty 验证。` : '任务产物通过 exists/readable/nonEmpty 验证。' }
  ];
}

function attachDependencies(component, registry) {
  const registered = registry.find((item) => item.id === component.id);
  return { ...component, registered:Boolean(registered), dependencies:registered?.dependencies || [] };
}
function normalizeRegistry(value) {
  return (Array.isArray(value) ? value : []).filter((item) => item?.id).map((item) => ({
    id:String(item.id),
    name:String(item.name || item.id),
    dependencies:[...new Set((Array.isArray(item.dependencies) ? item.dependencies : []).map(String))],
    owner:String(item.owner || 'operator'),
    recoveryPlaybooks:[...new Set((Array.isArray(item.recoveryPlaybooks) ? item.recoveryPlaybooks : []).map(String))]
  }));
}
function inferComponentId(failure) {
  const value = `${failure.code || ''} ${failure.stage || ''}`;
  if (/xiaod/i.test(value)) return 'xiaod';
  if (/paperclip/i.test(value)) return 'paperclip';
  if (/ajun|executor/i.test(value)) return 'ajun-runtime';
  return 'unknown';
}

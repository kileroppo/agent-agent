import crypto from 'node:crypto';
import { normalizeGoalSpec } from './goal-spec.js';
import {
  createWorkPlan,
  recordAutonomyUsage,
  recordWorkPlanCheckpoint
} from './autonomous-work-planner.js';
import { OPEN_TASK_DELEGATES } from './open-task-routing.js';

// Legacy migration helper only. Production routing lives in open-task-routing.js
// and Paperclip owns plans, budgets, approvals and recovery.

export class AutonomousTaskPreparer {
  constructor({ capabilityGrants = null, now = () => new Date() } = {}) {
    this.capabilityGrants = capabilityGrants;
    this.now = now;
  }

  supports(task, agent) {
    return Boolean(
      task
      && agent?.openTaskPolicy
      && OPEN_TASK_DELEGATES[task.taskType]
      && agent.acceptedTaskTypes?.includes(task.taskType)
    );
  }

  async prepare(task, agent) {
    if (!this.supports(task, agent)) return { task, blocked:false, artifacts:[] };
    const raw = task.input?.goalSpec || {};
    const goalSpec = normalizeGoalSpec({
      goalId:`goal:${task.taskId}`,
      objective:raw.objective || raw.outcome || task.input?.title,
      deliverables:nonEmptyList(raw.deliverables, [task.input?.title || '任务交付物']),
      constraints:nonEmptyList(raw.constraints, task.input?.description ? [task.input.description] : []),
      acceptanceCriteria:nonEmptyList(raw.acceptanceCriteria, ['交付物存在、可读、非空，并明确未完成项与下一步。']),
      priority:raw.priority || 'normal',
      requestedPermissions:Array.isArray(raw.requestedPermissions) ? raw.requestedPermissions : []
    }, {
      allowedPermissions:registeredCapabilities(agent),
      now:this.now()
    });
    const requestedCapabilities = normalizeCapabilityRequests(raw.capabilityRequests);
    const capabilityResults = await this.grantCapabilities(task, agent, requestedCapabilities);
    const missing = capabilityResults.filter((item) => item.status !== 'active');
    const capabilityStep = requestedCapabilities.length ? [{
      stepId:'acquire-capabilities',
      objective:'取得本任务需要且已通过审计的最小能力授权。',
      dependsOn:[],
      requiredCapabilities:requestedCapabilities.map((item) => item.capabilityId),
      risk:'low',
      acceptanceCriteria:['每项能力都有来源、版本、哈希、审计、沙箱和回退记录；敏感请求保持未授权。']
    }] : [];
    const plan = createWorkPlan({
      goalSpec,
      budget:raw.budget,
      steps:[
        ...capabilityStep,
        {
          stepId:'execute-goal',
          objective:goalSpec.objective,
          dependsOn:capabilityStep.length ? ['acquire-capabilities'] : [],
          requiredCapabilities:requestedCapabilities.map((item) => item.capabilityId),
          risk:'low',
          acceptanceCriteria:goalSpec.acceptanceCriteria
        },
        {
          stepId:'verify-deliverables',
          objective:'按验收标准核对交付物并如实记录缺口。',
          dependsOn:['execute-goal'],
          requiredCapabilities:[],
          risk:'low',
          acceptanceCriteria:goalSpec.acceptanceCriteria
        }
      ],
      now:this.now()
    });
    const artifacts = [
      planArtifact(task, plan, this.now()),
      capabilityArtifact(task, capabilityResults, this.now())
    ];
    return {
      task,
      goalSpec,
      plan,
      capabilityResults,
      blocked:missing.length > 0,
      missingCapabilities:missing.map((item) => item.capabilityId),
      artifacts
    };
  }

  async grantCapabilities(task, agent, requests) {
    const available = new Set(registeredCapabilities(agent));
    const results = [];
    for (const request of requests) {
      if (!available.has(request.capabilityId)) {
        results.push({
          capabilityId:request.capabilityId,
          status:'needs_capability',
          reason:'能力不在该岗位正式 Manifest 或已安装 Hermes 能力清单中，未自动安装或扩权。'
        });
        continue;
      }
      if (!this.capabilityGrants) {
        results.push({
          capabilityId:request.capabilityId,
          status:'needs_capability',
          reason:'能力授权存储未启用，未产生不可审计的临时授权。'
        });
        continue;
      }
      const locator = `agents/${agent.agentId}/manifest.json#${request.capabilityId}`;
      const grant = await this.capabilityGrants.upsert({
        capabilityId:request.capabilityId,
        source:{ kind:'agent-manifest', locator },
        version:String(agent.manifestVersion || '1'),
        hash:`sha256:${crypto.createHash('sha256').update(`${agent.agentId}:${request.capabilityId}:${agent.manifestVersion || '1'}`).digest('hex')}`,
        permissions:[request.capabilityId],
        risk:'low',
        audit:{ status:'passed', evidenceRefs:[locator] },
        sandbox:{ status:'passed', evidenceRefs:[`registered-runtime:${agent.agentId}`] },
        requiresCredentials:false,
        externalWrite:false,
        rollbackRef:`task:${task.taskId}:revoke-capability`
      }, { allowedPermissions:[request.capabilityId], now:this.now() });
      results.push({
        capabilityId:request.capabilityId,
        status:grant.status,
        grant,
        purpose:request.purpose
      });
    }
    return results;
  }
}

export function adaptOpenTaskForExecutor(task) {
  const delegatedTaskType = OPEN_TASK_DELEGATES[task?.taskType];
  if (!delegatedTaskType) return task;
  return {
    ...task,
    taskType:delegatedTaskType,
    input:{
      ...(task.input || {}),
      context:{
        ...(task.input?.context || {}),
        openTaskType:task.taskType,
        autonomousWorkPlan:true
      }
    }
  };
}

export function advanceAutonomousPlan(task, result, { now = new Date() } = {}) {
  const artifact = (task?.artifactRefs || []).find((item) => item.type === 'autonomous_work_plan');
  if (!artifact?.data?.plan) return null;
  let plan = artifact.data.plan;
  const hasCapabilityStep = plan.steps.some((step) => step.stepId === 'acquire-capabilities');
  if (hasCapabilityStep) {
    plan = checkpoint(plan, 'acquire-capabilities', 'running', { authorized:true }, [], now);
    plan = checkpoint(plan, 'acquire-capabilities', 'completed', { authorized:true }, [], now);
  }
  plan = checkpoint(plan, 'execute-goal', 'running', { stage:'executor_started' }, [], now);
  const resultArtifacts = Array.isArray(result?.artifactRefs) ? result.artifactRefs : [];
  const verifiedRefs = resultArtifacts
    .filter((item) => item?.validation?.exists === true && item?.validation?.nonEmpty === true)
    .map((item) => item.artifactId || item.location || item.type)
    .filter(Boolean);
  if (result?.status === 'succeeded') {
    plan = checkpoint(plan, 'execute-goal', 'completed', { status:'succeeded' }, verifiedRefs, now);
    plan = checkpoint(plan, 'verify-deliverables', 'running', { artifactCount:verifiedRefs.length }, verifiedRefs, now);
    plan = checkpoint(
      plan,
      'verify-deliverables',
      verifiedRefs.length ? 'completed' : 'failed',
      verifiedRefs.length ? { verified:true } : { verified:false, reason:'没有通过存在性与非空校验的产物。' },
      verifiedRefs,
      now
    );
  } else {
    const stepStatus = ['needs_input', 'waiting_test'].includes(result?.status) ? 'blocked' : 'failed';
    plan = checkpoint(plan, 'execute-goal', stepStatus, {
      status:result?.status || 'failed',
      reason:result?.error?.userMessage || result?.error?.message || '执行未完成。'
    }, verifiedRefs, now);
  }
  const usage = summarizeUsage(result?.usage);
  return {
    ...artifact,
    validation:{
      ...(artifact.validation || {}),
      planCompleted:plan.status === 'completed',
      checkedAt:asIso(now)
    },
    data:{
      ...(artifact.data || {}),
      plan:recordAutonomyUsage(plan, usage, { now }).plan
    }
  };
}

function checkpoint(plan, stepId, status, checkpointData, artifactRefs, now) {
  return recordWorkPlanCheckpoint(plan, {
    stepId,
    status,
    checkpoint:checkpointData,
    artifactRefs,
    now
  });
}

function planArtifact(task, plan, now) {
  const createdAt = asIso(now);
  return {
    artifactId:`autonomous-plan:${task.taskId}`,
    taskId:task.taskId,
    type:'autonomous_work_plan',
    title:'自主工作计划与检查点',
    location:`runtime://${task.taskId}/autonomous-work-plan`,
    mimeType:'application/json',
    accessScope:'local-owner',
    validation:{ exists:true, readable:true, nonEmpty:true, dagValid:true },
    createdAt,
    data:{ plan }
  };
}

function capabilityArtifact(task, results, now) {
  const createdAt = asIso(now);
  return {
    artifactId:`capability-discovery:${task.taskId}`,
    taskId:task.taskId,
    type:'capability_discovery_report',
    title:'能力发现、审计与任务级授权',
    location:`runtime://${task.taskId}/capability-discovery`,
    mimeType:'application/json',
    accessScope:'local-owner',
    validation:{
      exists:true,
      readable:true,
      nonEmpty:true,
      allRequestedCapabilitiesActive:results.every((item) => item.status === 'active')
    },
    createdAt,
    data:{
      requestedCount:results.length,
      activeCount:results.filter((item) => item.status === 'active').length,
      results
    }
  };
}

function registeredCapabilities(agent) {
  return [...new Set([
    ...(Array.isArray(agent?.toolAllowlist) ? agent.toolAllowlist : []),
    ...(Array.isArray(agent?.runtimeCapabilities?.mcpTools) ? agent.runtimeCapabilities.mcpTools : []),
    ...(Array.isArray(agent?.runtimeCapabilities?.skills) ? agent.runtimeCapabilities.skills : [])
  ].map((item) => String(item || '').trim()).filter(Boolean))];
}

function normalizeCapabilityRequests(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.map((item) => ({
    capabilityId:String(item?.capabilityId || '').trim(),
    purpose:String(item?.purpose || '').replace(/\s+/g, ' ').trim().slice(0, 500),
    source:String(item?.source || 'registered-catalog').trim()
  })).filter((item) => {
    if (!item.capabilityId || !item.purpose || seen.has(item.capabilityId)) return false;
    seen.add(item.capabilityId);
    return true;
  }).slice(0, 12);
}

function nonEmptyList(value, fallback) {
  const normalized = Array.isArray(value)
    ? value.map((item) => String(item || '').replace(/\s+/g, ' ').trim()).filter(Boolean)
    : [];
  return normalized.length ? [...new Set(normalized)] : fallback.filter(Boolean);
}

function summarizeUsage(usage) {
  const modelCalls = Array.isArray(usage?.models)
    ? usage.models.reduce((sum, item) => sum + Math.max(0, Number(item?.calls) || 0), 0)
    : 0;
  const actualCostUsd = Number(usage?.actualCostUsd || usage?.costUsd || 0);
  return {
    modelCalls,
    actualCostUsd:Number.isFinite(actualCostUsd) && actualCostUsd > 0 ? actualCostUsd : 0,
    activeChildren:0,
    delegationDepth:0
  };
}

function asIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

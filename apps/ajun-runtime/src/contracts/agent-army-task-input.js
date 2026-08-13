import crypto from 'node:crypto';
import { z } from 'zod';

import { resolveAnalysisIntent } from '../analysis-intent.ts';
import { canonicalizeBusinessAssignment } from '../business-task-routing.ts';
import { normalizeCompletionDelivery } from '../source-completion-watch.ts';
import { DEFAULT_TASK_DEFINITION_REGISTRY } from '../task-definition-registry.js';

const analysisIntentSchema = z.enum(['digest', 'deep', 'template', 'style']);
const depthSchema = z.enum(['fast', 'full']);
const evidenceModeSchema = z.enum(['preliminary', 'formal']);
const reviewPolicySchema = z.enum(['optional', 'required']);
const visualModeSchema = z.enum(['auto', 'off', 'required']);
export const httpUrlSchema = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === 'http:' || protocol === 'https:';
}, '只支持 HTTP(S) 链接');

const missionItemSchema = z.object({
  key:z.string().min(1).max(80).optional(),
  title:z.string().min(1).max(500),
  task_type:z.string().min(1).max(120).describe('必须来自 capabilities'),
  agent_id:z.string().min(1).max(80).describe('必须是支持该 task_type 的已上岗员工'),
  description:z.string().max(2000).optional(),
  acceptance:z.string().max(500).optional(),
  source_urls:z.array(httpUrlSchema).max(5).optional(),
  review_policy:reviewPolicySchema.optional().describe('默认自动质量确认；用户明确要求人工完整听审时传 required'),
  evidence_mode:evidenceModeSchema.optional(),
  analysis_intent:analysisIntentSchema.optional(),
  depth:depthSchema.optional(),
  visual_mode:visualModeSchema.optional(),
  focus:z.string().max(500).optional(),
  platforms:z.array(z.string().min(1).max(40)).max(3).optional(),
  content_goal:z.string().max(500).optional(),
  depends_on_previous:z.boolean().optional().describe('兼容字段：等待列表中所有前置分工结束或明确卡点'),
  depends_on:z.array(z.string().min(1).max(80)).max(10).optional().describe('当前分工依赖的 item key，可表达非线性的依赖关系'),
});

const completionDeliverySchema = z.object({
  mode:z.literal('dynamic_card'),
  owner:z.literal('hermes_gateway'),
});

export const taskCreateToolInputSchema = z.object({
  title:z.string().min(1).max(500).describe('用户要得到的可验证结果'),
  task_type:z.string().min(1).max(120).describe('必须来自 capabilities 返回的 acceptedTaskTypes'),
  agent_id:z.string().max(80).optional().describe('仅在需要点名且 capabilities 已确认支持时提供'),
  description:z.string().max(2000).optional(),
  source_urls:z.array(httpUrlSchema).max(5).optional(),
  connection_id:z.string().uuid().optional().describe('可选；仅在需要覆盖平台默认账号时传入 A君 返回的连接编号'),
  source_task_ids:z.array(z.string().min(8).max(100)).max(20).optional().describe('需要引用的既有任务编号；可拍脚本未提供时会自动匹配参考案例'),
  review_policy:reviewPolicySchema.optional().describe('默认 optional：质量合格时系统自动确认，异常时转人工；只有用户明确要求完整听审时使用 required'),
  evidence_mode:evidenceModeSchema.optional(),
  analysis_intent:analysisIntentSchema.optional().describe('视频分析模式：精华提炼、深度拆解、模板学习或风格探索'),
  depth:depthSchema.optional(),
  visual_mode:visualModeSchema.optional().describe('默认 auto：快速模式最多 12 帧，完整模式最多 48 帧；off 只分析文字；required 缺少画面时要求补充素材'),
  focus:z.string().max(500).optional(),
  platforms:z.array(z.string().min(1).max(40)).max(10).optional(),
  content_goal:z.string().max(500).optional(),
  duration_seconds:z.number().min(15).max(600).optional(),
  research_mode:z.enum(['auto', 'off']).optional(),
  approved_for_use:z.boolean().optional().describe('仅当用户明确回复“用这版”时为 true'),
  source_script_task_id:z.string().min(8).max(100).optional(),
  metrics:z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  goal:z.string().min(1).max(1000).optional().describe('开放型或复杂任务的最终结果；提供后系统会建立可审计的自主工作计划'),
  deliverables:z.array(z.string().min(1).max(500)).max(12).optional(),
  constraints:z.array(z.string().min(1).max(500)).max(20).optional(),
  acceptance_criteria:z.array(z.string().min(1).max(500)).max(20).optional(),
  capability_requests:z.array(z.object({
    capability_id:z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/).max(120),
    purpose:z.string().min(1).max(500),
    source:z.string().max(500).optional(),
  })).max(12).optional().describe('只申请完成目标必需的能力；凭据、外发、扩权和高成本能力仍会停在审批'),
  autonomy_budget:z.object({
    max_duration_minutes:z.number().int().min(1).max(60).optional(),
    max_model_calls:z.number().int().min(1).max(20).optional(),
    max_concurrent_subtasks:z.number().int().min(1).max(4).optional(),
    max_dependency_depth:z.number().int().min(1).max(2).optional(),
    max_cost_usd:z.number().min(0).max(5).optional(),
  }).optional(),
  chat_ref:z.string().max(240).optional().describe('当前 Hermes 会话上下文中可见的原飞书 chat id；用于任务归属和恢复'),
  request_ref:z.string().max(240).optional().describe('当前消息或稳定请求引用；有则用于严格幂等'),
  completion_delivery:completionDeliverySchema.optional().describe('由 Hermes Gateway 唯一管理任务动态卡时声明；未声明时保持原文本回告'),
});

export const missionCreateToolInputSchema = z.object({
  title:z.string().min(1).max(500).describe('整组工作的总目标'),
  items:z.array(missionItemSchema).min(1).max(11),
  chat_ref:z.string().max(240).optional(),
  request_ref:z.string().max(240).optional(),
  completion_delivery:completionDeliverySchema.optional().describe('由 Hermes Gateway 唯一管理总任务动态卡时声明'),
});

export class AgentArmyTaskInputError extends Error {}

export function taskClientInputFromTool(input, scope = {}) {
  assertSingleTaskRequest(input);
  const assignment = canonicalizeBusinessAssignment({
    title:input.title,
    taskType:input.task_type,
    agentId:input.agent_id,
    description:input.description,
    dependsOnPrevious:Array.isArray(input.source_task_ids) && input.source_task_ids.length > 0,
  });
  assertTaskScope(assignment, scope);
  return {
    title:assignment.title,
    taskType:assignment.taskType,
    agentId:assignment.agentId || onlyValue(scope.agentIds),
    description:assignment.description,
    sourceUrls:input.source_urls,
    connectionId:input.connection_id,
    sourceTaskIds:input.source_task_ids,
    reviewPolicy:input.review_policy,
    evidenceMode:input.evidence_mode,
    analysisIntent:input.analysis_intent,
    depth:input.depth,
    visualMode:input.visual_mode,
    focus:input.focus,
    platforms:input.platforms,
    contentGoal:input.content_goal,
    durationSeconds:input.duration_seconds,
    researchMode:input.research_mode,
    approvedForUse:input.approved_for_use,
    sourceScriptTaskId:input.source_script_task_id,
    metrics:input.metrics,
    goalSpec:goalSpecFromTool(input),
    chatRef:input.chat_ref,
    requestRef:input.request_ref,
    sourceAgentId:onlyValue(scope.agentIds),
    sourceProfileId:scope.profileId || onlyValue(scope.agentIds),
    taskCardPolicy:scope.taskCardPolicy,
    completionDelivery:input.completion_delivery,
  };
}

export function missionClientInputFromTool(input, scope = {}) {
  if (!scope.allowMissions) {
    throw new AgentArmyTaskInputError('当前员工身份不能创建多人总任务；请交给 A君。');
  }
  const assignments = input.items.map((item, index) => canonicalizeBusinessAssignment({
    key:item.key,
    title:item.title,
    taskType:item.task_type,
    agentId:item.agent_id,
    description:item.description,
    acceptance:item.acceptance,
    sourceUrls:item.source_urls,
    reviewPolicy:item.review_policy,
    evidenceMode:item.evidence_mode,
    analysisIntent:item.analysis_intent,
    depth:item.depth,
    visualMode:item.visual_mode,
    focus:item.focus,
    platforms:item.platforms,
    contentGoal:item.content_goal,
    dependsOnPrevious:item.depends_on_previous === true,
    dependsOn:item.depends_on,
  }, { index }));
  for (const assignment of assignments) assertTaskScope(assignment, scope);
  return {
    title:input.title,
    items:assignments,
    chatRef:input.chat_ref,
    requestRef:input.request_ref,
    sourceAgentId:onlyValue(scope.agentIds),
    sourceProfileId:scope.profileId || onlyValue(scope.agentIds),
    taskCardPolicy:scope.taskCardPolicy,
    completionDelivery:input.completion_delivery,
    waitForTerminal:true,
  };
}

export function prepareTaskCreateRequest(input = {}, { now = Date.now } = {}) {
  const title = safeText(input.title, 500);
  const taskType = safeText(input.taskType, 120);
  if (!title) throw new AgentArmyTaskInputError('请说明要完成什么。');
  if (!taskType) throw new AgentArmyTaskInputError('请提供任务类型；不确定时先调用 capabilities。');
  const description = safeText(input.description, 2000);
  const chatRef = safeText(input.chatRef, 240);
  const requestRef = safeText(input.requestRef, 240);
  const sourceAgentId = safeText(input.sourceAgentId, 80);
  const sourceProfileId = safeText(input.sourceProfileId, 80);
  const taskCardPolicy = safeText(input.taskCardPolicy, 40);
  const sourceUrls = validHttpUrls(input.sourceUrls, 5);
  const sourceTaskIds = safeStringList(input.sourceTaskIds, 20, 100);
  const connectionId = optionalConnectionId(input.connectionId);
  const goalSpec = normalizeGoalSpecInput(input.goalSpec);
  const completionDelivery = completionDeliveryInput(input.completionDelivery);
  const evidenceMode = input.evidenceMode === 'preliminary' ? 'preliminary' : 'formal';
  const analysis = resolveTaskAnalysis({ ...input, title, taskType, description });
  const visualMode = input.visualMode === undefined
    ? taskType === 'content.video-benchmark-analysis' ? 'auto' : 'off'
    : normalizeVisualMode(input.visualMode);
  if (taskType === 'content.video-benchmark-analysis' && sourceUrls.length && !sourceTaskIds.length) {
    return {
      kind:'mission',
      chatRef,
      completionDelivery,
      missionInput:videoAnalysisMissionInput({
        ...input,
        title,
        description,
        chatRef,
        requestRef,
        sourceUrls,
        connectionId,
        completionDelivery,
        evidenceMode,
        visualMode,
        ...analysis,
      }),
    };
  }
  const idempotencyKey = requestRef
    ? `hermes:${requestRef}`
    : `hermes:${chatRef || 'local'}:${shortHash([title, taskType, input.agentId || '', Math.floor(now() / 30_000)].join('|'))}`;
  const source = sourceEnvelope({ chatRef, requestRef, sourceAgentId, sourceProfileId, taskCardPolicy });
  return {
    kind:'task',
    chatRef,
    sourceAgentId,
    sourceProfileId,
    completionDelivery,
    body:{
      title,
      description,
      taskType,
      agentId:safeText(input.agentId, 80) || undefined,
      sourceUrls,
      connectionId,
      reviewPolicy:input.reviewPolicy === 'required' ? 'required' : 'optional',
      evidenceMode,
      depth:analysis.depth,
      analysisIntent:analysis.analysisIntent,
      visualMode,
      focus:safeText(input.focus, 500) || undefined,
      platforms:safeStringList(input.platforms, 10, 40),
      contentGoal:safeText(input.contentGoal, 500) || undefined,
      durationSeconds:optionalDurationSeconds(input.durationSeconds),
      researchMode:input.researchMode === 'off' ? 'off' : 'auto',
      approvedForUse:input.approvedForUse === true,
      sourceScriptTaskId:safeText(input.sourceScriptTaskId, 100) || undefined,
      metrics:safeMetrics(input.metrics),
      requester:{ kind:'local-owner', ref:'A君' },
      requesterName:'A君',
      source,
      goalSpec:goalSpec || undefined,
      context:{
        ...(sourceTaskIds.length ? { sourceTaskIds, dependsOnPrevious:true } : {}),
        ...(goalSpec ? { autonomousOpenTask:true } : {}),
      },
      ...(completionDelivery ? { completionDelivery } : {}),
      idempotencyKey,
    },
  };
}

export function prepareMissionCreateRequest(input = {}, { now = Date.now } = {}) {
  const title = safeText(input.title, 500);
  const items = normalizeMissionItems(input.items);
  if (!title) throw new AgentArmyTaskInputError('请说明这组工作的总目标。');
  if (!items.length) {
    throw new AgentArmyTaskInputError('多人任务必须包含 1 到 11 项有效员工分工，并且依赖项必须引用同一任务中的 key。');
  }
  const chatRef = safeText(input.chatRef, 240);
  const requestRef = safeText(input.requestRef, 240);
  const sourceAgentId = safeText(input.sourceAgentId, 80);
  const sourceProfileId = safeText(input.sourceProfileId, 80);
  const taskCardPolicy = safeText(input.taskCardPolicy, 40);
  const completionDelivery = completionDeliveryInput(input.completionDelivery);
  const idempotencyKey = requestRef
    ? `hermes-mission:${requestRef}`
    : `hermes-mission:${chatRef || 'local'}:${shortHash([title, JSON.stringify(items), Math.floor(now() / 30_000)].join('|'))}`;
  return {
    title,
    items,
    chatRef,
    completionDelivery,
    body:{
      title,
      items,
      requester:{ kind:'local-owner', ref:'A君' },
      source:sourceEnvelope({ chatRef, requestRef, sourceAgentId, sourceProfileId, taskCardPolicy }),
      ...(completionDelivery ? { completionDelivery } : {}),
      idempotencyKey,
    },
  };
}

function goalSpecFromTool(input) {
  if (!input.goal) return undefined;
  return {
    outcome:input.goal,
    deliverables:input.deliverables,
    constraints:input.constraints,
    acceptanceCriteria:input.acceptance_criteria,
    capabilityRequests:(input.capability_requests || []).map((request) => ({
      capabilityId:request.capability_id,
      purpose:request.purpose,
      source:request.source,
    })),
    budget:input.autonomy_budget ? {
      maxDurationMinutes:input.autonomy_budget.max_duration_minutes,
      maxModelCalls:input.autonomy_budget.max_model_calls,
      maxConcurrentSubtasks:input.autonomy_budget.max_concurrent_subtasks,
      maxDependencyDepth:input.autonomy_budget.max_dependency_depth,
      maxCostUsd:input.autonomy_budget.max_cost_usd,
    } : undefined,
  };
}

function assertTaskScope({ taskType, agentId }, scope) {
  const targetAgent = String(agentId || onlyValue(scope.agentIds) || '').trim();
  if (scope.agentIds?.length && (!targetAgent || !scope.agentIds.includes(targetAgent))) {
    throw new AgentArmyTaskInputError('当前员工身份不能把任务交给其他岗位。');
  }
  if (scope.taskTypes?.length && !scope.taskTypes.includes(String(taskType || '').trim())) {
    throw new AgentArmyTaskInputError('当前员工身份不能创建这种任务。');
  }
}

function assertSingleTaskRequest({ title, description }) {
  const text = `${String(title || '')}\n${String(description || '')}`;
  const numberedItems = [...text.matchAll(/(?:^|\n)\s*([1-3])[.、)]\s+\S/g)].map((match) => match[1]);
  const distinctItems = new Set(numberedItems);
  const explicitlyGrouped = /(总任务|多人任务|[两二三3]\s*项工作|前两项|统一汇报)/.test(text);
  if (distinctItems.has('1') && distinctItems.has('2') && explicitlyGrouped) {
    throw new AgentArmyTaskInputError(
      '检测到负责人一次交办多项工作，禁止压成单员工任务。请改用 mission_create，并把每项工作分别映射到已上岗员工。'
    );
  }
}

function sourceEnvelope({ chatRef, requestRef, sourceAgentId, sourceProfileId, taskCardPolicy }) {
  if (!chatRef) return { channel:'hermes-native' };
  return {
    channel:'feishu',
    chatRef,
    messageRef:requestRef || undefined,
    ...(sourceAgentId ? { targetAgentId:sourceAgentId } : {}),
    ...(sourceProfileId ? { profileId:sourceProfileId } : {}),
    ...(taskCardPolicy ? { taskCardPolicy } : {}),
  };
}

function resolveTaskAnalysis(input) {
  const analysis = input.taskType === 'content.video-benchmark-analysis'
    ? resolveAnalysisIntent({
        analysisIntent:input.analysisIntent,
        title:input.title,
        description:input.description,
        focus:input.focus,
        depth:input.depth,
      })
    : { error:null, analysisIntent:undefined, depth:input.depth === 'full' ? 'full' : 'fast' };
  if (analysis.error === 'invalid_analysis_intent') {
    throw new AgentArmyTaskInputError('分析模式无效；请选择精华提炼、深度拆解、模板学习或风格探索。');
  }
  if (analysis.error === 'analysis_intent_conflict') {
    throw new AgentArmyTaskInputError('检测到多个分析模式，请只选择一种：精华提炼、深度拆解、模板学习或风格探索。');
  }
  return analysis;
}

function videoAnalysisMissionInput(input) {
  const acquisitionTaskType = DEFAULT_TASK_DEFINITION_REGISTRY.prerequisiteTaskType(input.taskType);
  const acquisitionAgentId = DEFAULT_TASK_DEFINITION_REGISTRY.defaultAgentId(acquisitionTaskType);
  const analysisAgentId = DEFAULT_TASK_DEFINITION_REGISTRY.defaultAgentId(input.taskType);
  if (!acquisitionTaskType || !acquisitionAgentId || !analysisAgentId) {
    throw new AgentArmyTaskInputError('视频分析任务定义缺少受控获取链路。');
  }
  return {
    title:`${input.title}｜受控获取与拆解`,
    chatRef:input.chatRef,
    requestRef:input.requestRef,
    completionDelivery:input.completionDelivery,
    waitForTerminal:false,
    items:[
      {
        key:'acquire-transcript',
        title:`获取并整理：${input.title}`,
        taskType:acquisitionTaskType,
        agentId:acquisitionAgentId,
        description:'只能通过内容获取中心获取公开或已授权素材；优先复用字幕，必要时才转录。',
        acceptance:input.evidenceMode === 'formal'
          ? input.reviewPolicy === 'required'
            ? '生成来源证据、质量报告和机器稿，并按用户要求等待真人完整听审确认。'
            : '生成来源证据和质量报告；质量门禁通过时自动生成系统确认稿，异常时才等待人工听审。'
          : '生成来源证据、质量报告和可供初步分析使用的机器稿。',
        sourceUrls:input.sourceUrls,
        connectionId:input.connectionId,
        reviewPolicy:input.reviewPolicy === 'required' ? 'required' : 'optional',
        visualMode:input.visualMode,
        depth:input.depth,
        analysisIntent:input.analysisIntent,
      },
      {
        key:'analyze-video',
        title:input.title,
        taskType:input.taskType,
        agentId:analysisAgentId,
        description:input.description,
        acceptance:input.evidenceMode === 'formal'
          ? '只在系统质量确认稿或人工确认稿存在后生成带证据的正式拆解。'
          : '基于机器稿生成明确降级的初步拆解。',
        dependsOnPrevious:true,
        evidenceMode:input.evidenceMode,
        depth:input.depth,
        analysisIntent:input.analysisIntent,
        visualMode:input.visualMode,
        focus:safeText(input.focus, 500),
      },
    ],
  };
}

function normalizeMissionItems(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 11) return [];
  const items = value.map((item, index) => {
    const analysis = resolveMissionAnalysisIntent(item);
    return {
      key:safeText(item?.key, 80) || `work-${index + 1}`,
      title:safeText(item?.title, 500),
      taskType:safeText(item?.taskType, 120),
      agentId:safeText(item?.agentId, 80),
      description:safeText(item?.description, 2000),
      acceptance:safeText(item?.acceptance, 500),
      sourceUrls:validHttpUrls(item?.sourceUrls, 5),
      connectionId:optionalConnectionId(item?.connectionId),
      reviewPolicy:item?.reviewPolicy === 'required' ? 'required' : 'optional',
      evidenceMode:item?.evidenceMode === 'preliminary' ? 'preliminary' : 'formal',
      analysisIntent:analysis.analysisIntent,
      depth:analysis.depth,
      visualMode:normalizeVisualMode(item?.visualMode),
      focus:safeText(item?.focus, 500),
      platforms:safeStringList(item?.platforms, 3, 40),
      contentGoal:safeText(item?.contentGoal, 500),
      dependsOnPrevious:item?.dependsOnPrevious === true,
      dependsOn:safeStringList(item?.dependsOn, 10, 80),
    };
  });
  const keys = new Set(items.map((item) => item.key));
  return items.every((item) => (
    item.title
    && item.taskType
    && item.agentId
    && item.dependsOn.every((key) => keys.has(key) && key !== item.key)
  )) ? items : [];
}

function resolveMissionAnalysisIntent(item) {
  if (item?.taskType !== 'content.video-benchmark-analysis') {
    return {
      error:null,
      analysisIntent:['digest', 'deep', 'template', 'style'].includes(item?.analysisIntent) ? item.analysisIntent : undefined,
      depth:item?.depth === 'full' ? 'full' : 'fast',
    };
  }
  const analysis = resolveAnalysisIntent({
    analysisIntent:item?.analysisIntent,
    title:item?.title,
    description:item?.description,
    focus:item?.focus,
    depth:item?.depth,
  });
  if (analysis.error) {
    throw new AgentArmyTaskInputError(analysis.error === 'analysis_intent_conflict'
      ? '多人任务中的视频分析分工命中了多个分析模式，请只保留一种。'
      : '多人任务中的视频分析模式无效。');
  }
  return analysis;
}

function normalizeGoalSpecInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const outcome = safeText(value.outcome || value.goal, 1000);
  if (!outcome) return null;
  const budget = value.budget && typeof value.budget === 'object' && !Array.isArray(value.budget)
    ? {
        maxDurationMinutes:boundedDuration(value.budget.maxDurationMinutes, 1, 60, 60),
        maxModelCalls:boundedDuration(value.budget.maxModelCalls, 1, 20, 20),
        maxConcurrentSubtasks:boundedDuration(value.budget.maxConcurrentSubtasks, 1, 4, 4),
        maxDependencyDepth:boundedDuration(value.budget.maxDependencyDepth, 1, 2, 2),
        maxCostUsd:Number.isFinite(Number(value.budget.maxCostUsd))
          ? Math.max(0, Math.min(5, Number(value.budget.maxCostUsd)))
          : 5,
      }
    : undefined;
  return {
    outcome,
    deliverables:safeStringList(value.deliverables, 12, 500),
    constraints:safeStringList(value.constraints, 20, 500),
    acceptanceCriteria:safeStringList(value.acceptanceCriteria, 20, 500),
    capabilityRequests:(Array.isArray(value.capabilityRequests) ? value.capabilityRequests : []).slice(0, 12).map((request) => ({
      capabilityId:safeText(request?.capabilityId, 120),
      purpose:safeText(request?.purpose, 500),
      source:safeText(request?.source, 500) || 'registered-catalog',
    })).filter((request) => request.capabilityId && request.purpose),
    ...(budget ? { budget } : {}),
  };
}

function completionDeliveryInput(value) {
  if (value === undefined || value === null) return null;
  const normalized = normalizeCompletionDelivery(value);
  if (!normalized) {
    throw new AgentArmyTaskInputError('完成投递契约无效；动态卡片只能由 Hermes Gateway 统一持有生命周期。');
  }
  return normalized;
}

function optionalConnectionId(value) {
  const id = safeText(value, 100);
  if (!id) return undefined;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new AgentArmyTaskInputError('账号连接标识格式不正确。');
  }
  return id;
}

function validHttpUrls(value, maxItems) {
  const urls = safeStringList(value, maxItems, 2000);
  for (const url of urls) {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol');
    } catch {
      throw new AgentArmyTaskInputError('素材链接格式不正确。');
    }
  }
  return urls;
}

function optionalDurationSeconds(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration < 15 || duration > 600) {
    throw new AgentArmyTaskInputError('视频时长必须在 15 到 600 秒之间。');
  }
  return duration;
}

function safeMetrics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value).slice(0, 20).map(([key, item]) => [
    safeText(key, 80),
    typeof item === 'number' || typeof item === 'boolean' ? item : safeText(item, 120),
  ]).filter(([key, item]) => key && item !== ''));
}

function safeText(value, limit = 500) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function safeStringList(value, maxItems, maxChars) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return [...new Set(values.map((item) => safeText(item, maxChars)).filter(Boolean))].slice(0, maxItems);
}

function normalizeVisualMode(value) {
  return value === 'off' || value === 'required' ? value : 'auto';
}

function boundedDuration(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}

function shortHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function onlyValue(values = []) {
  return values.length === 1 ? values[0] : undefined;
}

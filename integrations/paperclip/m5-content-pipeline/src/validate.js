import {
  createGoalSchema,
  createProjectSchema,
  createRoutineSchema,
  createRoutineTriggerSchema,
  pipelineStageConfigSchema,
  pipelineStageKindSchema,
  upsertBudgetPolicySchema,
} from '@paperclipai/shared';
import { z } from 'zod';

const keySchema = z.string().trim().min(1).max(120).regex(/^[a-z][a-z0-9_-]*$/);

const reviewSchema = z.object({
  approveTo: keySchema,
  requestChangesTo: keySchema,
  rejectTo: keySchema,
}).strict();

const stageSchema = z.object({
  key: keySchema,
  name: z.string().trim().min(1).max(200),
  kind: pipelineStageKindSchema,
  owner: keySchema,
  routineKey: keySchema.optional(),
  review: reviewSchema.optional(),
}).strict();

const definitionSchema = z.object({
  schemaVersion: z.literal(1),
  paperclipVersion: z.literal('2026.722.0'),
  key: keySchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1),
  goal: z.object({
    key: keySchema,
    title: z.string().trim().min(1),
    description: z.string(),
    level: z.enum(['company', 'team', 'agent', 'task']),
    status: z.enum(['planned', 'active', 'achieved', 'cancelled']),
  }).strict(),
  project: z.object({
    key: keySchema,
    name: z.string().trim().min(1),
    description: z.string(),
    status: z.enum(['backlog', 'planned', 'in_progress', 'completed', 'cancelled']),
    targetDays: z.literal(7),
  }).strict(),
  budget: z.object({
    scope: z.literal('project'),
    metric: z.literal('billed_cents'),
    windowKind: z.literal('lifetime'),
    warnPercent: z.number().int().min(1).max(99),
    hardStopEnabled: z.literal(true),
    requireExplicitAmountAtApply: z.literal(true),
  }).strict(),
  executionPolicy: z.object({
    maxConcurrency: z.literal(4),
    maxStageRetries: z.literal(2),
    maxReplansPerContent: z.literal(3),
    schedule: z.object({
      cronExpression: z.string().trim().min(1),
      timezone: z.literal('Asia/Shanghai'),
      concurrencyPolicy: z.literal('skip_if_active'),
      catchUpPolicy: z.literal('skip_missed'),
      durationDays: z.literal(7),
    }).strict(),
  }).strict(),
  stages: z.array(stageSchema).length(16),
}).strict();

export function validateDefinition(definition) {
  const parsed = definitionSchema.parse(definition);
  const stageKeys = new Set();
  const routineKeys = new Set();
  let doneCount = 0;
  let cancelledCount = 0;

  for (const stage of parsed.stages) {
    if (stageKeys.has(stage.key)) throw new Error(`重复阶段 key: ${stage.key}`);
    stageKeys.add(stage.key);
    if (stage.kind === 'done') doneCount += 1;
    if (stage.kind === 'cancelled') cancelledCount += 1;
    if (stage.kind === 'review' && !stage.review) {
      throw new Error(`review 阶段缺少 review 路由: ${stage.key}`);
    }
    if (stage.kind !== 'review' && stage.review) {
      throw new Error(`非 review 阶段不能声明 review 路由: ${stage.key}`);
    }
    if (!['draft', 'campaign_active'].includes(stage.key)
      && !['done', 'cancelled'].includes(stage.kind)
      && !stage.routineKey) {
      throw new Error(`工作阶段缺少 onEnter Routine: ${stage.key}`);
    }
    if (stage.routineKey) {
      if (routineKeys.has(stage.routineKey)) throw new Error(`重复 Routine key: ${stage.routineKey}`);
      routineKeys.add(stage.routineKey);
    }
  }
  if (doneCount !== 1 || cancelledCount !== 1) {
    throw new Error('Paperclip流水线必须且只能声明一个done和一个cancelled终态');
  }
  if (
    parsed.stages[0]?.key !== 'draft'
    || parsed.stages[0]?.kind !== 'working'
    || parsed.stages[0]?.routineKey
  ) {
    throw new Error('Pipeline首阶段必须是无onEnter Routine的draft系统阶段');
  }
  if (
    parsed.stages[1]?.key !== 'campaign_active'
    || parsed.stages[1]?.kind !== 'working'
    || parsed.stages[1]?.routineKey
  ) {
    throw new Error('Pipeline第二阶段必须是无onEnter Routine的campaign_active活动控制阶段');
  }
  if (
    parsed.stages[2]?.key !== 'topic'
    || parsed.stages[3]?.key !== 'parallel_join_gate'
    || parsed.stages[4]?.key !== 'script'
    || parsed.stages[5]?.key !== 'render'
  ) {
    throw new Error('M5 主线必须是 topic → parallel_join_gate → script → render，研究、素材和配音只走子 Case。');
  }
  if (
    parsed.stages.at(-4)?.key !== 'retrospective'
    || parsed.stages.at(-4)?.kind !== 'working'
    || parsed.stages.at(-4)?.routineKey !== 'm5-retrospective'
    || parsed.stages.at(-3)?.key !== 'learning'
    || parsed.stages.at(-3)?.kind !== 'working'
    || parsed.stages.at(-3)?.routineKey !== 'm5-learning'
    || parsed.stages.at(-2)?.key !== 'done'
    || parsed.stages.at(-2)?.kind !== 'done'
    || parsed.stages.at(-1)?.kind !== 'cancelled'
  ) {
    throw new Error('前置业务阶段之后必须依次声明可执行复盘、学习灰度、done和cancelled终态');
  }
  for (const stage of parsed.stages.filter((item) => item.review)) {
    for (const destination of Object.values(stage.review)) {
      if (!stageKeys.has(destination)) throw new Error(`review 路由指向未知阶段: ${destination}`);
    }
  }

  return parsed;
}

export function validateCompiledStage(stage) {
  pipelineStageKindSchema.parse(stage.kind);
  pipelineStageConfigSchema.parse(stage.config);
  return stage;
}

export function validateRoutinePayload(payload) {
  return createRoutineSchema.parse(payload);
}

export function validateTriggerPayload(payload) {
  return createRoutineTriggerSchema.parse(payload);
}

export function validateGoalPayload(payload) {
  return createGoalSchema.parse(payload);
}

export function validateProjectPayload(payload) {
  return createProjectSchema.parse(payload);
}

export function validateBudgetPayload(payload) {
  return upsertBudgetPolicySchema.parse(payload);
}

import { z } from 'zod';

// @ts-expect-error -- transitional JS contract Module; removed with the task-input contract batch.
import { AgentArmyTaskInputError, httpUrlSchema } from './agent-army-task-input.js';

const taskHttpInputSchema = z.object({
  title:z.string().min(1).max(500),
  taskType:z.string().min(1).max(120),
  sourceUrl:httpUrlSchema.optional(),
  sourceUrls:z.array(httpUrlSchema).max(5).optional(),
  durationSeconds:z.number().min(15).max(600).optional(),
}).passthrough();

const missionHttpInputSchema = z.object({
  title:z.string().min(1).max(500),
  items:z.array(z.object({
    title:z.string().min(1).max(500),
    taskType:z.string().min(1).max(120),
    agentId:z.string().min(1).max(80),
    sourceUrls:z.array(httpUrlSchema).max(5).optional(),
  }).passthrough()).min(1).max(11),
}).passthrough();

export type TaskHttpInput = z.infer<typeof taskHttpInputSchema>;
export type MissionHttpInput = z.infer<typeof missionHttpInputSchema>;

export function normalizeTaskHttpInput(input: unknown): TaskHttpInput {
  const parsed = taskHttpInputSchema.safeParse(input);
  if (!parsed.success) throw new AgentArmyTaskInputError('任务输入不符合统一契约。');
  return parsed.data;
}

export function normalizeMissionHttpInput(input: unknown): MissionHttpInput {
  const parsed = missionHttpInputSchema.safeParse(input);
  if (!parsed.success) throw new AgentArmyTaskInputError('多人任务输入不符合统一契约。');
  return parsed.data;
}

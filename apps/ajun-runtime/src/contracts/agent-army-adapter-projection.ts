import {
  registerSourceCompletionWatch,
  type CompletionWatcher,
} from '../source-completion-watch.ts';
import { presentTaskCard } from '../task-card-presentation.ts';
import { projectTaskNotification } from '../task-notification-projection.ts';
import { formatTaskPresentation } from '../task-presentation.ts';

type JsonRecord = Record<string, unknown>;
type CreateService = Readonly<{ create(input: JsonRecord): Promise<unknown> }>;
type MissionService = Readonly<{ createBusinessMission(input: JsonRecord): Promise<unknown> }>;

export async function createTaskHttpResult(
  input: JsonRecord,
  { tasks, completionWatcher }: Readonly<{
    tasks: CreateService;
    completionWatcher?: CompletionWatcher | null;
  }>,
) {
  const task = await tasks.create(input);
  const completionWatch = await registerSourceCompletionWatch(task, completionWatcher, {
    completionDelivery:input.completionDelivery,
  });
  return { task, completionWatch };
}

export async function createMissionHttpResult(
  input: JsonRecord,
  { missions, completionWatcher }: Readonly<{
    missions: MissionService;
    completionWatcher?: CompletionWatcher | null;
  }>,
) {
  const result = await missions.createBusinessMission(input);
  const completionWatch = await registerSourceCompletionWatch(result, completionWatcher, {
    completionDelivery:input.completionDelivery,
  });
  return { ...(recordOf(result) || {}), completionWatch };
}

export function presentCommanderReply(
  payload: unknown,
  detailBaseUrl: string,
  taskCardContext: JsonRecord = {},
): unknown {
  const value = recordOf(payload);
  if (!value) return payload;
  const task = recordOf(value.task) || recordOf(value.mission);
  if (!task?.taskId) return payload;
  const projection = projectTaskNotification(task, {
    detailBaseUrl,
    reply:value.reply,
  }) as JsonRecord;
  return {
    ...value,
    reply:projection.reply,
    presentation:projection.presentation,
    taskCard:presentTaskCard(projection.task, taskCardContext),
  };
}

export function presentTaskStatus(
  notification: unknown,
  task: unknown,
  taskCardContext: JsonRecord = {},
): unknown {
  const taskRecord = recordOf(task);
  if (!taskRecord?.taskId) return notification;
  const notificationRecord = recordOf(notification) || {};
  const { projectionTruth = null, ...publicNotification } = notificationRecord;
  const projection = projectTaskNotification(task, {
    status:notificationRecord.status,
    projectionTruth,
  });
  return {
    ...publicNotification,
    taskCard:presentTaskCard(projection.task, taskCardContext),
  };
}

export function projectMcpToolValue(value: unknown) {
  return {
    content:[{ type:'text', text:humanReadableToolText(value) }],
    structuredContent:jsonObject(value),
  };
}

function humanReadableToolText(value: unknown): string {
  const record = recordOf(value);
  const presentation = recordOf(record?.presentation);
  if (record?.viewKind === 'army_status' && typeof presentation?.summary === 'string') {
    return presentation.summary;
  }
  const direct = formatTaskPresentation(value);
  if (direct) return direct;
  if (Array.isArray(value)) {
    const tasks = value.map(formatTaskPresentation).filter(Boolean);
    if (tasks.length === value.length && tasks.length) return tasks.join('\n\n');
    if (!value.length) return '当前没有符合条件的任务。';
  }
  if (record?.mission) {
    const mission = formatTaskPresentation(record.mission);
    const children = Array.isArray(record.children)
      ? record.children.map(formatTaskPresentation).filter(Boolean)
      : [];
    if (mission || children.length) return [mission, ...children].filter(Boolean).join('\n\n');
  }
  if (record?.task) {
    const task = formatTaskPresentation(record.task);
    if (task) return task;
  }
  if (typeof record?.manualText === 'string') return record.manualText;
  if (Array.isArray(record?.employees) && Array.isArray(record.capabilities)) {
    const employees = record.employees
      .map(recordOf)
      .filter((item): item is JsonRecord => Boolean(item))
      .map((item) => `${item.name || item.agentId}：${truthText(item.capabilityTruth)}；${item.role || '岗位职责已登记'}`)
      .join('\n');
    const capabilities = record.capabilities
      .map(recordOf)
      .filter((item): item is JsonRecord => Boolean(item))
      .map((item) => `${item.name || item.id}：${truthText(item.truth)}；${item.detail || item.status || '状态待核对'}`)
      .join('\n');
    return [`岗位登记（不等于业务已验证）：\n${employees || '暂无岗位登记。'}`, `能力实证：\n${capabilities || '暂无能力记录。'}`].join('\n\n');
  }
  return JSON.stringify(value, null, 2);
}

function truthText(value: unknown): string {
  const truth = recordOf(value);
  const labels: Readonly<Record<string, string>> = {
    human_accepted:'人工已验收',
    verified:'真实任务已验证',
    live:'运行可达，待业务验证',
    configured:'已配置，待运行验证',
    declared:'仅已声明',
    not_declared:'尚未接入',
  };
  return labels[String(truth?.overall || '')] || '状态待核对';
}

function jsonObject(value: unknown): JsonRecord {
  const record = recordOf(value);
  if (record) return record;
  return { items:Array.isArray(value) ? value : [value] };
}

function recordOf(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

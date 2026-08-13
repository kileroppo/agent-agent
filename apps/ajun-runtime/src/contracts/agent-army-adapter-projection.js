import { registerSourceCompletionWatch } from '../source-completion-watch.js';
import { presentTaskCard } from '../task-card-presentation.js';
import { projectTaskNotification } from '../task-notification-projection.js';
import { formatTaskPresentation } from '../task-presentation.js';

export async function createTaskHttpResult(input, { tasks, completionWatcher }) {
  const task = await tasks.create(input);
  const completionWatch = await registerSourceCompletionWatch(task, completionWatcher, {
    completionDelivery:input.completionDelivery,
  });
  return { task, completionWatch };
}

export async function createMissionHttpResult(input, { missions, completionWatcher }) {
  const result = await missions.createBusinessMission(input);
  const completionWatch = await registerSourceCompletionWatch(result, completionWatcher, {
    completionDelivery:input.completionDelivery,
  });
  return { ...result, completionWatch };
}

export function presentCommanderReply(payload, detailBaseUrl, taskCardContext = {}) {
  if (!payload || typeof payload !== 'object') return payload;
  const task = payload.task || payload.mission || null;
  if (!task?.taskId) return payload;
  const projection = projectTaskNotification(task, { detailBaseUrl, reply:payload.reply });
  return {
    ...payload,
    reply:projection.reply,
    presentation:projection.presentation,
    taskCard:presentTaskCard(projection.task, taskCardContext),
  };
}

export function presentTaskStatus(notification, task, taskCardContext = {}) {
  if (!task?.taskId) return notification;
  const { projectionTruth = null, ...publicNotification } = notification || {};
  const projection = projectTaskNotification(task, {
    status:notification?.status,
    projectionTruth,
  });
  return {
    ...publicNotification,
    taskCard:presentTaskCard(projection.task, taskCardContext),
  };
}

export function projectMcpToolValue(value) {
  return {
    content:[{ type:'text', text:humanReadableToolText(value) }],
    structuredContent:jsonObject(value),
  };
}

function humanReadableToolText(value) {
  if (value?.viewKind === 'army_status' && typeof value?.presentation?.summary === 'string') {
    return value.presentation.summary;
  }
  const direct = formatTaskPresentation(value);
  if (direct) return direct;
  if (Array.isArray(value)) {
    const tasks = value.map(formatTaskPresentation).filter(Boolean);
    if (tasks.length === value.length && tasks.length) return tasks.join('\n\n');
    if (!value.length) return '当前没有符合条件的任务。';
  }
  if (value?.mission) {
    const mission = formatTaskPresentation(value.mission);
    const children = (value.children || []).map(formatTaskPresentation).filter(Boolean);
    if (mission || children.length) return [mission, ...children].filter(Boolean).join('\n\n');
  }
  if (value?.task) {
    const task = formatTaskPresentation(value.task);
    if (task) return task;
  }
  if (typeof value?.manualText === 'string') return value.manualText;
  if (Array.isArray(value?.employees) && Array.isArray(value?.capabilities)) {
    const employees = value.employees
      .map((item) => `${item.name || item.agentId}：${truthText(item.capabilityTruth)}；${item.role || '岗位职责已登记'}`)
      .join('\n');
    const capabilities = value.capabilities
      .map((item) => `${item.name || item.id}：${truthText(item.truth)}；${item.detail || item.status || '状态待核对'}`)
      .join('\n');
    return [`岗位登记（不等于业务已验证）：\n${employees || '暂无岗位登记。'}`, `能力实证：\n${capabilities || '暂无能力记录。'}`].join('\n\n');
  }
  return JSON.stringify(value, null, 2);
}

function truthText(value) {
  return ({
    human_accepted:'人工已验收',
    verified:'真实任务已验证',
    live:'运行可达，待业务验证',
    configured:'已配置，待运行验证',
    declared:'仅已声明',
    not_declared:'尚未接入',
  })[value?.overall] || '状态待核对';
}

function jsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  return { items:Array.isArray(value) ? value : [value] };
}

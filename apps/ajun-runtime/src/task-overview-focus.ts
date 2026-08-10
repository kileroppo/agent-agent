import { summarizeBacklog } from './workflow/backlog-classification.ts';

export function buildTaskFocus(tasks: readonly any[], approvals: readonly any[], evidenceContext = {}) {
  const backlog = summarizeBacklog(tasks, evidenceContext);
  const counts = Object.fromEntries(
    ['queued', 'running', 'waiting_worker', 'pausing', 'paused', 'waiting_approval', 'waiting_test', 'needs_input', 'succeeded', 'failed']
      .map((status) => [status, tasks.filter((task) => task.status === status).length]),
  );
  const ownerPriority = ['waiting_approval', 'needs_input', 'paused', 'failed', 'waiting_test'];
  const systemPriority = ['pausing', 'running', 'waiting_worker', 'queued'];
  const ownerActionableTasks = ownerPriority.flatMap((status) =>
    tasks.filter((task) => task.status === status && isOwnerActionableTask(task, tasks))
  );
  const businessInProgressTasks = systemPriority.flatMap((status) =>
    tasks.filter((task) => task.status === status && !isBackgroundSystemTask(task))
  );
  const backgroundInProgress = systemPriority.reduce((total, status) =>
    total + tasks.filter((task) => task.status === status && isBackgroundSystemTask(task)).length
  , 0);
  const current = ownerActionableTasks[0] || businessInProgressTasks[0] || null;
  const focusItem = (task: any) => {
    const approval = approvals.find((item) =>
      task.approvalRefs?.includes(item.approvalId) && item.status === 'pending');
    return {
      taskId:task.taskId,
      title:task.input?.title || '未命名任务',
      status:task.status,
      action:nextActionFor(task, approval),
    };
  };
  const actions = ownerActionableTasks.slice(0, 5).map(focusItem);
  return {
    total:tasks.length,
    completed:counts.succeeded,
    inProgress:businessInProgressTasks.length,
    backgroundInProgress,
    paused:counts.paused,
    needsInput:counts.needs_input,
    waitingApproval:counts.waiting_approval,
    waitingTest:counts.waiting_test,
    failed:counts.failed,
    ownerActionable:ownerActionableTasks.length,
    reviewBacklog:backlog.reviewBacklog,
    verificationBacklog:backlog.verificationBacklog,
    unresolvedFailures:backlog.unresolvedFailures,
    historicalArchived:backlog.historicalArchived,
    validatedByLaterEvidence:backlog.validatedByLaterEvidence,
    backlog:backlog.counts,
    actions,
    next:current ? focusItem(current) : null,
  };
}

function isBackgroundSystemTask(task: any) {
  if (task?.taskType !== 'operations.health-review' || task?.source?.channel !== 'paperclip') return false;
  const title = String(task.input?.title || '').trim();
  const description = String(task.input?.description || '').trim();
  return title === 'A君定时本机巡检' || description.startsWith('agent-army:operations-health-v1');
}

export function isOwnerActionableTask(task: any, tasks: readonly any[]) {
  if (!['needs_input', 'failed', 'waiting_test'].includes(task.status)) return true;
  if (isSupersededBySuccess(task, tasks)) return false;
  const channel = String(task.source?.channel || '').trim();
  const originChannel = String(task.source?.originChannel || '').trim();
  if (!channel && !originChannel) return true;
  if (hasLaterUserOutcome(task, tasks)) return false;
  return channel === 'feishu'
    || originChannel === 'feishu'
    || channel === 'local-ui'
    || channel === 'hermes-native';
}

function isSupersededBySuccess(task: any, tasks: readonly any[]) {
  const sourceUrl = String(task.input?.sourceUrl || '').trim();
  if (!sourceUrl) return false;
  const taskTime = Date.parse(task.updatedAt || task.createdAt || '') || 0;
  return tasks.some((candidate) =>
    candidate.taskId !== task.taskId
    && candidate.status === 'succeeded'
    && candidate.taskType === task.taskType
    && String(candidate.input?.sourceUrl || '').trim() === sourceUrl
    && (Date.parse(candidate.updatedAt || candidate.createdAt || '') || 0) > taskTime
  );
}

function hasLaterUserOutcome(task: any, tasks: readonly any[]) {
  const taskTime = Date.parse(task.updatedAt || task.createdAt || '') || 0;
  return tasks.some((candidate) => {
    if (!['succeeded', 'cancelled'].includes(candidate.status)) return false;
    const candidateChannel = String(candidate.source?.channel || '').trim();
    const candidateOrigin = String(candidate.source?.originChannel || '').trim();
    const userFacing = candidateChannel === 'feishu'
      || candidateOrigin === 'feishu'
      || candidateChannel === 'local-ui'
      || candidateChannel === 'hermes-native';
    return userFacing && (Date.parse(candidate.updatedAt || candidate.createdAt || '') || 0) > taskTime;
  });
}

function nextActionFor(task: any, approval: any) {
  if (approval) return '请确认任务范围；在你确认前，系统不会继续执行。';
  if (task.status === 'needs_input') return task.error?.userMessage || '请补充目标、范围或必要素材后再继续。';
  if (task.status === 'waiting_test') return task.error?.userMessage || '自动检查没有在本轮完成；已保留为待测试，不影响其他任务继续。';
  if (task.status === 'pausing') return '正在暂停，会在当前步骤完成后的安全位置停下。';
  if (task.status === 'paused') return '这项任务已暂停，确认继续前不会开始新的处理步骤。';
  if (task.status === 'waiting_worker') return '这项工作需要老板的 Mac；已安全排队，Mac 上线后会自动领取。';
  if (task.status === 'failed') return task.error?.userMessage || '这项任务未完成，请根据错误信息决定是否重试或补充信息。';
  if (task.status === 'running') return '任务正在处理，等待新的进度或结果。';
  return '任务已排队，等待本地执行器开始处理。';
}

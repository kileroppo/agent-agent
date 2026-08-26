export type MissionSubtaskPlan = {
  key: string;
  title: string;
  required?: boolean;
  role?: string;
};

export type ChildTaskResult = {
  taskId: string;
  key?: string;
  status: string;
  title?: string;
  summary?: string;
  artifactRefs?: Array<{ type: string; uri?: string; data?: any }>;
  error?: { code?: string; message?: string };
};

export type MissionSynthesisResult = {
  status: 'succeeded' | 'partial_success' | 'failed' | 'in_progress';
  completedCount: number;
  failedCount: number;
  totalCount: number;
  summary: string;
  succeededDeliverables: Array<{
    key: string;
    title: string;
    taskId: string;
    summary?: string;
    artifacts: any[];
  }>;
  failedItems: Array<{
    key: string;
    title: string;
    taskId: string;
    errorCode?: string;
    errorMessage?: string;
  }>;
};

export function evaluateMissionPartialSuccess(
  children: ChildTaskResult[],
  plan: { subtasks: MissionSubtaskPlan[] }
): MissionSynthesisResult {
  const subtasks = plan?.subtasks || [];
  const totalCount = subtasks.length;
  const childByKey = new Map<string, ChildTaskResult>();

  for (const child of children) {
    const key = child.key || (child as any).input?.context?.subtaskKey || child.taskId;
    childByKey.set(key, child);
  }

  const succeededDeliverables: MissionSynthesisResult['succeededDeliverables'] = [];
  const failedItems: MissionSynthesisResult['failedItems'] = [];
  let inProgressCount = 0;

  for (const subtask of subtasks) {
    const child = childByKey.get(subtask.key);
    if (!child) {
      inProgressCount += 1;
      continue;
    }

    if (child.status === 'succeeded') {
      succeededDeliverables.push({
        key: subtask.key,
        title: subtask.title || child.title || subtask.key,
        taskId: child.taskId,
        summary: child.summary,
        artifacts: child.artifactRefs || [],
      });
    } else if (['failed', 'cancelled'].includes(child.status)) {
      failedItems.push({
        key: subtask.key,
        title: subtask.title || child.title || subtask.key,
        taskId: child.taskId,
        errorCode: child.error?.code || 'subtask_failed',
        errorMessage: child.error?.message || '子任务未能完成',
      });
    } else {
      inProgressCount += 1;
    }
  }

  if (inProgressCount > 0) {
    return {
      status: 'in_progress',
      completedCount: succeededDeliverables.length,
      failedCount: failedItems.length,
      totalCount,
      summary: `多人协作任务正在执行中（已完成 ${succeededDeliverables.length}/${totalCount} 项）...`,
      succeededDeliverables,
      failedItems,
    };
  }

  if (succeededDeliverables.length === totalCount) {
    return {
      status: 'succeeded',
      completedCount: succeededDeliverables.length,
      failedCount: 0,
      totalCount,
      summary: `全部 ${totalCount} 项分工已全部顺利完成。`,
      succeededDeliverables,
      failedItems: [],
    };
  }

  if (succeededDeliverables.length > 0) {
    const deliverablesList = succeededDeliverables.map((d) => `✅ ${d.title}`).join('\n');
    const failuresList = failedItems.map((f) => `⚠️ ${f.title}（原因：${f.errorMessage}）`).join('\n');

    return {
      status: 'partial_success',
      completedCount: succeededDeliverables.length,
      failedCount: failedItems.length,
      totalCount,
      summary: `多人协作已按事实完成部分交付（${succeededDeliverables.length}/${totalCount} 项就绪）：\n\n已完成成果：\n${deliverablesList}\n\n未完成项：\n${failuresList}\n\n已汇总可用成果并保留单独重试入口。`,
      succeededDeliverables,
      failedItems,
    };
  }

  return {
    status: 'failed',
    completedCount: 0,
    failedCount: failedItems.length,
    totalCount,
    summary: `所有 ${totalCount} 项分工均未能成功完成。`,
    succeededDeliverables: [],
    failedItems,
  };
}

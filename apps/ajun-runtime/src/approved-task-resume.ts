export async function resumeApprovedTask(service: any, approvedTask: any): Promise<any> {
  const agent = typeof service.registry.get === 'function'
    ? await service.registry.get(approvedTask.assigneeAgentId)
    : (await service.registry.list({ includeManagers:true }))
      .find((item: any) => item.agentId === approvedTask.assigneeAgentId) || null;
  if (!agent || agent.status !== 'active') {
    return failResume(service, approvedTask, '审批已通过，但当前找不到可用的承接员工。');
  }
  const resumed = await service.executeTask(approvedTask, agent);
  if (resumed?.status === 'queued' && resumed?.currentStage === 'approval_approved') {
    return failResume(service, resumed, '审批已通过，但承接员工当前没有可用执行器。');
  }
  service.taskLifecycleEvents?.recordPersisted(resumed, { previousTask:approvedTask });
  return resumed;
}

async function failResume(service: any, task: any, message: string): Promise<any> {
  const failed = await service.store.updateTask(task.taskId, {
    status:'failed',
    currentStage:'approval_resume_executor_unavailable',
    error:{
      code:'approval_resume_executor_unavailable',
      message,
      userMessage:`${message}任务没有继续执行，可在任务详情请求安全恢复。`,
      category:'configuration',
      stage:'approval_resume',
      retryable:true,
      occurredAt:new Date().toISOString(),
    },
  });
  service.taskLifecycleEvents?.recordPersisted(failed, { previousTask:task });
  return failed;
}

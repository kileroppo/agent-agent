import { usesPaperclipHermesExecution } from './governance-hermes-runtime.js';
import { routeOpenTaskForExecutor } from './open-task-routing.js';
import { recordTaskUsage } from './task-usage.js';

export class TaskExecutionCoordinator {
  constructor({
    store,
    governance = null,
    capabilityCatalog,
    executorResolver = null,
    fallbackExecutor = null,
    fallbackExecutorResolver = null,
    markFailureRecoveryPending = async (task) => task,
    startFailureRecovery = () => {},
  } = {}) {
    this.store = store;
    this.governance = governance;
    this.capabilityCatalog = capabilityCatalog;
    this.executorResolver = executorResolver || ((agentId) => capabilityCatalog.executor(agentId));
    this.fallbackExecutor = fallbackExecutor;
    this.fallbackExecutorResolver = fallbackExecutorResolver || (() => this.fallbackExecutor);
    this.markFailureRecoveryPending = markFailureRecoveryPending;
    this.startFailureRecovery = startFailureRecovery;
  }

  async execute(task, agent) {
    if (usesPaperclipHermesExecution(agent) && task.status !== 'waiting_approval') {
      return this.delegateToPaperclip(task, agent);
    }
    const fallbackExecutor = this.fallbackExecutorResolver();
    const executor = agent?.status === 'active'
      ? this.executorResolver(agent.agentId)
        || (fallbackExecutor?.supports(agent) ? fallbackExecutor : null)
      : null;
    if (!executor || task.status === 'waiting_approval') return task;

    const executionStartedAt = new Date();
    let updated = await this.store.updateTask(task.taskId, {
      status:'running',
      currentStage:'starting',
      execution:{ executor:agent.agentId, startedAt:executionStartedAt.toISOString() },
    });
    updated = await this.syncGovernance(updated);
    try {
      const result = await executor.execute(routeOpenTaskForExecutor(updated, agent));
      updated = await this.store.updateTask(updated.taskId, {
        ...result,
        usage:recordTaskUsage({ task:updated, result, startedAt:executionStartedAt }),
      });
      if (updated.status === 'running' && typeof executor.observe === 'function') executor.observe(updated);
    } catch (error) {
      const result = executionFailure(updated, error);
      updated = await this.store.updateTask(updated.taskId, {
        ...result,
        usage:recordTaskUsage({ task:updated, result, startedAt:executionStartedAt }),
      });
    }
    updated = await this.syncGovernance(updated);
    updated = await this.markFailureRecoveryPending(updated);
    this.startFailureRecovery(updated);
    return updated;
  }

  delegateToPaperclip(task, agent) {
    const projected = Boolean(task.governance?.paperclipIssueId);
    return this.store.updateTask(task.taskId, {
      status:projected ? 'running' : 'needs_input',
      currentStage:projected ? 'waiting_paperclip_heartbeat' : 'waiting_governance',
      execution:{
        ...(task.execution || {}),
        owner:'paperclip-hermes',
        hermesProfileId:agent.agentId,
        paperclipIssueId:task.governance?.paperclipIssueId || null,
        delegatedAt:new Date().toISOString(),
      },
      ...(!projected ? {
        error:{
          code:'paperclip_projection_required',
          message:task.governance?.reason || 'Paperclip 任务投影尚未建立。',
          userMessage:'这名员工由 Paperclip 唤醒；治理总控恢复前不会改走本地重复执行器。',
          category:'governance',
          stage:'paperclip_projection',
          retryable:true,
          occurredAt:new Date().toISOString(),
        },
      } : { error:undefined }),
    });
  }

  async syncGovernance(task) {
    if (!this.governance || !task.governance?.paperclipIssueId) return task;
    return this.store.updateTask(task.taskId, { governance:await this.governance.update(task) });
  }
}

function executionFailure(task, error) {
  return {
    status:'failed',
    currentStage:'execution_failed',
    execution:{ ...(task.execution || {}), finishedAt:new Date().toISOString(), outcome:'failed' },
    error:{
      code:String(error?.code || 'executor_failed').slice(0, 120),
      message:String(error?.message || '执行器失败。').slice(0, 500),
      userMessage:'本地任务未能完成，请查看安全诊断。',
      category:String(error?.category || 'manual').slice(0, 80),
      stage:'execution',
      retryable:error?.retryable === true,
      occurredAt:new Date().toISOString(),
    },
  };
}

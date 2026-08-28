import { usesPaperclipHermesExecution } from './governance-hermes-runtime.ts';
import { routeOpenTaskForExecutor } from './open-task-routing.ts';
import { recordTaskUsage } from './task-usage.ts';
import { validateTaskCompletion } from './task-completion-contract.ts';
import { isTrustedReadOnlyDiagnosisTask } from './read-only-diagnosis-contract.ts';

export class TaskExecutionCoordinator {
  store: any;
  governance: any;
  capabilityCatalog: any;
  executorResolver: (agentId: string) => any;
  fallbackExecutor: any;
  fallbackExecutorResolver: () => any;
  markFailureRecoveryPending: (task: any) => Promise<any>;
  startFailureRecovery: (task: any) => void;
  prepareCompletion: (task: any, result: any) => any;
  maturityExecutionGuard: any;

  constructor({
    store,
    governance = null,
    capabilityCatalog,
    executorResolver = null,
    fallbackExecutor = null,
    fallbackExecutorResolver = null,
    markFailureRecoveryPending = async (task: any) => task,
    startFailureRecovery = () => {},
    prepareCompletion = (_task: any, result: any) => result,
    maturityExecutionGuard = null,
  }: any = {}) {
    this.store = store;
    this.governance = governance;
    this.capabilityCatalog = capabilityCatalog;
    this.executorResolver = executorResolver || ((agentId: string) => capabilityCatalog.executor(agentId));
    this.fallbackExecutor = fallbackExecutor;
    this.fallbackExecutorResolver = fallbackExecutorResolver || (() => this.fallbackExecutor);
    this.markFailureRecoveryPending = markFailureRecoveryPending;
    this.startFailureRecovery = startFailureRecovery;
    this.prepareCompletion = prepareCompletion;
    this.maturityExecutionGuard = maturityExecutionGuard;
  }

  async execute(task: any, agent: any) {
    if (!this.maturityExecutionGuard && await signalsProductMaturity(task, this.store)) {
      return this.store.updateTask(task.taskId, {
        status:'needs_input',
        currentStage:'maturity_execution_guard_unavailable',
        error:{
          code:'maturity_execution_guard_unavailable',
          message:'产品成熟度任务执行门禁未装配。',
          userMessage:'产品成熟度任务缺少统一执行门禁，已停止且没有唤醒岗位或外部治理执行器。',
          category:'governance',
          stage:'maturity_execution_guard',
          retryable:false,
          occurredAt:new Date().toISOString(),
        },
      });
    }
    let maturityAuthorization = null;
    if (this.maturityExecutionGuard) {
      try {
        maturityAuthorization = await this.maturityExecutionGuard.verifyOrBlock(task);
      } catch (error: any) {
        if (error?.blockedTask) return error.blockedTask;
        throw error;
      }
    }
    if (!maturityAuthorization && usesPaperclipHermesExecution(agent)
      && task.taskType !== 'army.cross-agent-mission'
      && !isTrustedReadOnlyDiagnosisTask(task)
      && task.status !== 'waiting_approval') {
      if (!task.governance?.paperclipIssueId && typeof this.governance?.project === 'function') {
        try {
          const projection = await this.governance.project(task);
          if (projection?.paperclipIssueId) {
            task = await this.store.updateTask(task.taskId, { governance: projection });
          }
        } catch {
          // ignore error and proceed to check local fallback
        }
      }
      if (task.governance?.paperclipIssueId) {
        return this.delegateToPaperclip(task, agent);
      }
      const fallbackExecutor = this.fallbackExecutorResolver();
      const localExecutor = agent?.status === 'active'
        ? this.executorResolver(agent.agentId)
          || (fallbackExecutor?.supports(agent) ? fallbackExecutor : null)
        : null;
      if (!localExecutor) {
        return this.delegateToPaperclip(task, agent);
      }
      task = await this.store.updateTask(task.taskId, {
        governance: {
          ...(task.governance || {}),
          status: 'local_fallback',
          governanceMode: 'local_fallback',
          reason: 'Paperclip 治理总控工单未建立，转由受控本地执行器接续。',
        },
      });
    }
    const fallbackExecutor = this.fallbackExecutorResolver();
    const executor = agent?.status === 'active'
      ? this.executorResolver(agent.agentId)
        || (fallbackExecutor?.supports(agent) ? fallbackExecutor : null)
      : null;
    if (!executor || task.status === 'waiting_approval') {
      if (maturityAuthorization) {
        try {
          await this.maturityExecutionGuard.execute(task, executor);
        } catch (error: any) {
          if (error?.blockedTask) return error.blockedTask;
          throw error;
        }
      }
      return task;
    }

    const executionStartedAt = new Date();
    const startPatch = {
      currentStage:'starting',
      execution:{ executor:agent.agentId, startedAt:executionStartedAt.toISOString() },
    };
    const claim = typeof this.store.claimTaskExecution === 'function'
      ? await this.store.claimTaskExecution(task.taskId, startPatch)
      : { claimed:true, task:await this.store.updateTask(task.taskId, { ...startPatch, status:'running' }) };
    if (!claim.claimed) return claim.task;
    let updated = claim.task;
    if (!maturityAuthorization) updated = await this.syncGovernance(updated);
    try {
      const routedTask = routeOpenTaskForExecutor(updated, agent);
      const rawResult = this.maturityExecutionGuard
        ? await this.maturityExecutionGuard.execute(routedTask, executor)
        : await executor.execute(routedTask);
      const result = await this.prepareCompletion(updated, enforceCompletionContract(updated, rawResult));
      updated = await this.store.updateTask(updated.taskId, {
        ...result,
        usage:recordTaskUsage({ task:updated, result, startedAt:executionStartedAt }),
      });
      if (updated.status === 'running' && typeof executor.observe === 'function') executor.observe(updated);
    } catch (error: any) {
      if (error?.blockedTask) {
        updated = error.blockedTask;
      } else {
        const result = executionFailure(updated, error);
        updated = await this.store.updateTask(updated.taskId, {
          ...result,
          usage:recordTaskUsage({ task:updated, result, startedAt:executionStartedAt }),
        });
      }
    }
    if (!maturityAuthorization) updated = await this.syncGovernance(updated);
    updated = await this.markFailureRecoveryPending(updated);
    this.startFailureRecovery(updated);
    return updated;
  }

  delegateToPaperclip(task: any, agent: any) {
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

  async syncGovernance(task: any) {
    if (!this.governance || !task.governance?.paperclipIssueId) return task;
    return this.store.updateTask(task.taskId, { governance:await this.governance.update(task) });
  }
}

async function signalsProductMaturity(task: any, store: any) {
  const directSignal = task?.input?.context?.productMaturityAuthorization?.kind === 'product-maturity-validation'
    || /^maturity-[0-9a-f-]{36}$/i.test(String(task?.source?.eventRef || ''))
    || /^maturity-[0-9a-f-]{36}$/i.test(String(task?.input?.context?.productMaturityBatchId || ''));
  if (directSignal) return true;
  const parentTaskId = String(task?.parentTaskId || '');
  if (!parentTaskId || typeof store?.list !== 'function') return false;
  const parent = (await store.list()).find((item: any) => item.taskId === parentTaskId);
  return parent?.taskType === 'army.cross-agent-mission'
    && (/^maturity-[0-9a-f-]{36}$/i.test(String(parent?.input?.context?.productMaturityBatchId || ''))
      || /^maturity-[0-9a-f-]{36}$/i.test(String(parent?.source?.eventRef || '')));
}

function executionFailure(task: any, error: any) {
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

function enforceCompletionContract(task: any, result: any = {}) {
  if (result?.status !== 'succeeded') return result;
  const artifacts = Array.isArray(result.artifactRefs)
    ? result.artifactRefs
    : task.artifactRefs || [];
  const completion = validateTaskCompletion(task, artifacts);
  if (completion.valid) return result;
  const finishedAt = result.execution?.finishedAt || new Date().toISOString();
  return {
    ...result,
    status:'waiting_test',
    currentStage:'completion_evidence_invalid',
    execution:{
      ...(result.execution || {}),
      finishedAt,
      outcome:'completion_evidence_invalid',
      completionValidation:{
        reportedStatus:'succeeded',
        valid:false,
        expectedArtifactTypes:completion.expectedArtifactTypes,
      },
    },
    error:{
      code:'completion_evidence_invalid',
      message:completion.reason,
      userMessage:'执行器已经停止运行，但完成产物没有通过对应任务门禁；已转为待测试，不冒充成功。',
      category:'manual',
      stage:'completion_validation',
      retryable:false,
      occurredAt:finishedAt,
    },
  };
}

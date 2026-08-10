const TERMINAL_FAILURES = new Set(['blocked', 'cancelled', 'failed']);

export class PaperclipRepairReconciler {
  store: any; governance: any; evidenceRelay: any; now: () => number; intervalMs: number;
  timer: ReturnType<typeof setInterval> | null; running: Promise<any> | null;
  constructor({ store, governance, evidenceRelay = null, now = () => Date.now(), intervalMs = 10_000 }: any = {}) {
    this.store = store;
    this.governance = governance;
    this.evidenceRelay = evidenceRelay;
    this.now = now;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.running = null;
  }

  start() {
    if (this.timer) return;
    void this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async reconcile() {
    if (this.running) return this.running;
    this.running = this.reconcileOnce().finally(() => { this.running = null; });
    return this.running;
  }

  async reconcileOnce() {
    const tasks = await this.store.list();
    await Promise.all(tasks.filter(isDelegatedRepair).map((task: any) => this.reconcileTask(task)));
  }

  async reconcileTask(task: any) {
    try {
      const issueId = task.governance.paperclipIssueId;
      let issue = await this.governance.getPaperclipIssue(issueId);
      let products = await this.governance.getIssueWorkProducts(issueId);
      let evidence = products.find(validatedRepairEvidence);
      if (!evidence && this.evidenceRelay) {
        const relayed = await this.evidenceRelay.relay(task);
        if (relayed.status === 'relayed') {
          evidence = relayed.product;
          issue = await this.governance.getPaperclipIssue(issueId);
        }
      }
      if (issue.status === 'done') {
        if (!evidence) {
          await this.store.updateTask(task.taskId, {
            status: 'running', currentStage: 'repair_evidence_missing',
            execution: { ...task.execution, updatedAt: new Date(this.now()).toISOString(), outcome: 'awaiting_verified_evidence' }
          });
          return;
        }
        const proof = evidence.metadata.agentArmyRepairEvidence;
        await this.store.updateTask(task.taskId, {
          status: 'succeeded', currentStage: 'repair_verified',
          execution: { ...task.execution, finishedAt: new Date(this.now()).toISOString(), outcome: 'repair_verified' },
          artifactRefs: [...(task.artifactRefs || []), repairArtifact(task, evidence, proof, this.now())]
        });
        return;
      }
      if (TERMINAL_FAILURES.has(issue.status)) {
        await this.store.updateTask(task.taskId, {
          status: 'failed', currentStage: 'paperclip_repair_failed',
          execution: { ...task.execution, finishedAt: new Date(this.now()).toISOString(), outcome: 'repair_failed' },
          error: { code:'paperclip_repair_failed', message:'Paperclip 技术修复任务未完成。', userMessage:'技术专家没有完成修复，故障和记录已保留，等待下一轮处理。', category:'manual', stage:'technical_repair', occurredAt:new Date(this.now()).toISOString() }
        });
      }
    } catch (error: any) {
      await this.store.updateTask(task.taskId, {
        status:'running', currentStage:'paperclip_repair_status_unavailable',
        execution:{ ...task.execution, updatedAt:new Date(this.now()).toISOString(), polling:{ state:'backoff', reason:String(error?.message || 'Paperclip 暂不可用。').slice(0, 180) } }
      });
    }
  }
}

function isDelegatedRepair(task: any) {
  return task.taskType === 'operations.technical-repair' && task.status === 'running' && Boolean(task.governance?.paperclipAssigneeAgentId) && Boolean(task.governance?.paperclipIssueId);
}

function validatedRepairEvidence(product: any) {
  const proof = product?.metadata?.agentArmyRepairEvidence;
  return ['approved', 'merged'].includes(product?.status) && proof?.testsPassed === true && proof?.recoveryVerified === true && Array.isArray(proof.changedFiles) && proof.changedFiles.length > 0;
}

function repairArtifact(task: any, evidence: any, proof: any, now: number) {
  return {
    artifactId:`paperclip-repair:${evidence.id || task.taskId}`, taskId:task.taskId,
    type:'technical_repair_evidence', title:'技术专家修复与验证证据',
    location:evidence.url || `paperclip://${task.governance.paperclipIssueIdentifier || task.governance.paperclipIssueId}/work-products/${evidence.id || 'verified'}`,
    mimeType:'application/json', accessScope:'local-owner',
    validation:{ exists:true, readable:true, nonEmpty:true, testsPassed:true, recoveryVerified:true },
    createdAt:new Date(now).toISOString(),
    data:{ changedFiles:proof.changedFiles.map((item: any) => String(item).slice(0, 240)), testSummary:String(proof.testSummary || '相关测试已通过。').slice(0, 500), recoverySummary:String(proof.recoverySummary || '恢复检查已通过。').slice(0, 500), remainingTests:Array.isArray(proof.remainingTests) ? proof.remainingTests.map((item: any) => String(item).slice(0, 240)) : [] }
  };
}

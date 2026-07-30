import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export class TaskStore {
  constructor(filePath) { this.filePath = filePath; this.pendingMutation = Promise.resolve(); }

  async list() { await this.pendingMutation; return (await this.read()).tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  async listApprovals() { await this.pendingMutation; return (await this.read()).approvals.sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  async listProposals() { await this.pendingMutation; return (await this.read()).proposals.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  async listTestInstances() { await this.pendingMutation; return (await this.read()).testInstances.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  async getConversationContext(chatRef) { await this.pendingMutation; return (await this.read()).conversationContexts[String(chatRef || '')] || null; }

  async setConversationContext(chatRef, context) {
    const key = String(chatRef || '').trim().slice(0, 240);
    if (!key) return null;
    return this.mutate(async () => {
      const data = await this.read();
      data.conversationContexts[key] = { schemaVersion:'agent.army/conversation-context/v1', updatedAt:new Date().toISOString(), ...context };
      await this.write(data); return data.conversationContexts[key];
    });
  }

  async createTask(task) {
    return this.mutate(async () => {
      const data = await this.read(); const now = new Date().toISOString();
      if (task.idempotencyKey) {
        const existing = data.tasks.find((item) => item.idempotencyKey === task.idempotencyKey);
        if (existing) return existing;
      }
      const record = { schemaVersion: 'agent.army/task/v1', taskId: crypto.randomUUID(), attempt: 1, priority: 'normal', artifactRefs: [], approvalRefs: [], createdAt: now, updatedAt: now, ...task };
      data.tasks.push(record); await this.write(data); return record;
    });
  }

  async createApproval(approval) {
    return this.mutate(async () => {
      const data = await this.read(); const now = new Date().toISOString();
      const record = { schemaVersion: 'agent.army/approval/v1', approvalId: crypto.randomUUID(), status: 'pending', createdAt: now, ...approval };
      data.approvals.push(record); const task = data.tasks.find((item) => item.taskId === approval.taskId);
      if (task) {
        task.approvalRefs.push(record.approvalId);
        if (approval.holdTask !== false) { task.status = 'waiting_approval'; task.currentStage = 'approval_required'; }
        task.updatedAt = now;
      }
      await this.write(data); return record;
    });
  }

  async updateTask(taskId, patch) {
    return this.mutate(async () => {
      const data = await this.read(); const task = data.tasks.find((item) => item.taskId === taskId);
      if (!task) throw new Error('找不到要更新的任务。');
      Object.assign(task, patch, { updatedAt: new Date().toISOString() });
      await this.write(data); return task;
    });
  }

  async claimWorkerTask({ workerId, taskTypes, leaseMs = 120_000, now = Date.now() }) {
    return this.mutate(async () => {
      const data = await this.read();
      const allowedTypes = new Set(Array.isArray(taskTypes) ? taskTypes.map((item) => String(item || '').trim()).filter(Boolean) : []);
      const candidates = data.tasks
        .filter((task) => allowedTypes.has(task.taskType) && (
          task.status === 'waiting_worker'
          || (task.status === 'running'
            && task.execution?.mode === 'mac_worker'
            && Date.parse(task.execution?.worker?.leaseExpiresAt || '') <= now)
        ))
        .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
      const task = candidates[0];
      if (!task) return null;
      const leasedAt = new Date(now).toISOString();
      const leaseId = crypto.randomUUID();
      task.status = 'running';
      task.currentStage = 'mac_worker_claimed';
      task.execution = {
        ...(task.execution || {}),
        executor:'xiaod',
        mode:'mac_worker',
        worker:{
          state:'leased',
          workerId:String(workerId),
          leaseId,
          leasedAt,
          lastHeartbeatAt:leasedAt,
          leaseExpiresAt:new Date(now + leaseMs).toISOString()
        }
      };
      task.updatedAt = leasedAt;
      await this.write(data);
      return task;
    });
  }

  async updateWorkerTask(taskId, { workerId, leaseId, patch, leaseMs = 120_000, now = Date.now(), extendLease = false }) {
    return this.mutate(async () => {
      const data = await this.read();
      const task = data.tasks.find((item) => item.taskId === taskId);
      if (!task) throw new Error('找不到这条 Mac 工作间任务。');
      const lease = task.execution?.worker;
      if (task.execution?.mode !== 'mac_worker' || lease?.workerId !== workerId || lease?.leaseId !== leaseId) {
        const error = new Error('Mac 工作间租约不匹配，未更新任务。');
        error.code = 'worker_lease_mismatch';
        throw error;
      }
      const at = new Date(now).toISOString();
      const worker = {
        ...lease,
        ...(extendLease ? { state:'working', lastHeartbeatAt:at, leaseExpiresAt:new Date(now + leaseMs).toISOString() } : {}),
        ...(patch?.execution?.worker || {})
      };
      Object.assign(task, patch, {
        execution:{ ...(task.execution || {}), ...(patch?.execution || {}), mode:'mac_worker', worker },
        updatedAt:at
      });
      await this.write(data);
      return task;
    });
  }

  async updateApproval(approvalId, patch) {
    return this.mutate(async () => {
      const data = await this.read(); const approval = data.approvals.find((item) => item.approvalId === approvalId);
      if (!approval) throw new Error('找不到要更新的审批。');
      Object.assign(approval, patch); await this.write(data); return approval;
    });
  }

  async createProposal(proposal) {
    return this.mutate(async () => {
      const data = await this.read(); const now = new Date().toISOString();
      if (proposal.sourceEventRef) {
        const existing = data.proposals.find((item) => item.sourceEventRef === proposal.sourceEventRef);
        if (existing) return existing;
      }
      const record = { schemaVersion: 'agent.army/proposal/v1', proposalId: crypto.randomUUID(), version: 1, reviewRefs: [], audit: [], createdAt: now, updatedAt: now, ...proposal };
      data.proposals.push(record); await this.write(data); return record;
    });
  }

  async updateProposal(proposalId, patch) {
    return this.mutate(async () => {
      const data = await this.read(); const proposal = data.proposals.find((item) => item.proposalId === proposalId);
      if (!proposal) throw new Error('找不到 Agent 草案。');
      Object.assign(proposal, patch, { updatedAt: new Date().toISOString() });
      await this.write(data); return proposal;
    });
  }

  async createTestInstance(instance) {
    return this.mutate(async () => {
      const data = await this.read(); const now = new Date().toISOString();
      const record = { schemaVersion: 'agent.army/test-instance/v1', testInstanceId: crypto.randomUUID(), createdAt: now, updatedAt: now, ...instance };
      data.testInstances.push(record); await this.write(data); return record;
    });
  }

  async updateTestInstance(testInstanceId, patch) {
    return this.mutate(async () => {
      const data = await this.read(); const instance = data.testInstances.find((item) => item.testInstanceId === testInstanceId);
      if (!instance) throw new Error('找不到受限测试实例。');
      Object.assign(instance, patch, { updatedAt: new Date().toISOString() });
      await this.write(data); return instance;
    });
  }

  async mutate(operation) {
    const previous = this.pendingMutation;
    let release;
    this.pendingMutation = new Promise((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); }
    finally { release(); }
  }

  async read() {
    try {
      const data = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      return { tasks: [], approvals: [], proposals: [], testInstances: [], conversationContexts: {}, ...data };
    }
    catch (error) { if (error.code === 'ENOENT') return { tasks: [], approvals: [], proposals: [], testInstances: [], conversationContexts: {} }; throw error; }
  }

  async write(data) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { flag:'wx', mode:0o600 });
      await fs.rename(temporary, this.filePath);
      await fs.chmod(this.filePath, 0o600);
    } catch (error) {
      await fs.rm(temporary, { force:true }).catch(() => {});
      throw error;
    }
  }
}

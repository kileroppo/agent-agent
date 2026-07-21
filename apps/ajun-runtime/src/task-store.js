import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export class TaskStore {
  constructor(filePath) { this.filePath = filePath; this.pendingMutation = Promise.resolve(); }

  async list() { await this.pendingMutation; return (await this.read()).tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  async listApprovals() { await this.pendingMutation; return (await this.read()).approvals.sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  async listProposals() { await this.pendingMutation; return (await this.read()).proposals.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  async listTestInstances() { await this.pendingMutation; return (await this.read()).testInstances.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }

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
      if (task) { task.approvalRefs.push(record.approvalId); task.status = 'waiting_approval'; task.currentStage = 'approval_required'; task.updatedAt = now; }
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
      return { tasks: [], approvals: [], proposals: [], testInstances: [], ...data };
    }
    catch (error) { if (error.code === 'ENOENT') return { tasks: [], approvals: [], proposals: [], testInstances: [] }; throw error; }
  }

  async write(data) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`); await fs.rename(temporary, this.filePath);
  }
}

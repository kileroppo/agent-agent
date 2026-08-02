import {
  consumeM5SystemControllerPlanRevision,
  isRecoverableM5SystemControllerFailure,
  markM5SystemControllerFailure,
  recoverM5SystemControllerFailure,
} from './m5-system-controller-recovery.js';

export class PaperclipHeartbeatHandler {
  constructor({ operator, governance, now = () => new Date() } = {}) {
    this.operator = operator;
    this.governance = governance;
    this.now = now;
    this.inFlightIssues = new Map();
  }

  async handle(payload) {
    const runId = String(payload?.runId || '').trim();
    const agentId = String(payload?.agentId || '').trim();
    const issueId = String(payload?.context?.taskId || '').trim();
    if (!runId || !agentId) throw new PaperclipHeartbeatError('Paperclip heartbeat 缺少运行或岗位标识。');
    if (!issueId) return { accepted: true, skipped: true, reason: '当前 heartbeat 没有分配任务。' };

    if (this.inFlightIssues.has(issueId)) return this.inFlightIssues.get(issueId);

    const execution = this.executeIssue({ issueId, runId, agentId });
    this.inFlightIssues.set(issueId, execution);
    try { return await execution; } finally { this.inFlightIssues.delete(issueId); }
  }

  async executeIssue({ issueId, runId, agentId }) {
    const current = await this.governance.getPaperclipIssue(issueId);
    if (current.status === 'done') return { accepted: true, skipped: true, issueId, reason: '任务已完成，不重复执行。' };

    const task = {
      taskId: issueId,
      input: { title: 'Paperclip 指派的本机健康检查' },
      execution: { executor: 'paperclip-http-adapter', paperclipRunId: runId, paperclipAgentId: agentId, startedAt: this.now().toISOString() }
    };

    try {
      const result = await this.operator.execute(task);
      await this.governance.completePaperclipIssue(issueId, {
        runId,
        agentId,
        result,
        hideFromDashboard:true,
      });
      return { accepted: true, issueId, stage: result.currentStage, status: result.status };
    } catch (error) {
      await this.governance.failPaperclipIssue(issueId, { runId, agentId, error }).catch(() => undefined);
      throw error;
    }
  }
}

export class PaperclipCampaignDailyHandler {
  constructor({ governance, campaignActivator, now = () => new Date() } = {}) {
    this.governance = governance;
    this.campaignActivator = campaignActivator;
    this.now = now;
    this.inFlightIssues = new Map();
  }

  async handle(payload) {
    assertNoDailySelectionParameters(payload);
    const runId = String(payload?.runId || '').trim();
    const agentId = String(payload?.agentId || '').trim();
    const issueId = String(payload?.context?.taskId || '').trim();
    if (!runId || !agentId || !issueId) {
      throw new PaperclipHeartbeatError('M5 每日 HTTP heartbeat 缺少运行、控制器或任务标识。');
    }
    if (this.inFlightIssues.has(issueId)) return this.inFlightIssues.get(issueId);
    const execution = this.executeIssue({ issueId, runId, agentId });
    this.inFlightIssues.set(issueId, execution);
    try { return await execution; } finally { this.inFlightIssues.delete(issueId); }
  }

  async executeIssue({ issueId, runId, agentId }) {
    if (typeof this.campaignActivator !== 'function') {
      throw new PaperclipHeartbeatError('M5 每日 HTTP heartbeat 缺少确定性活动执行器。');
    }
    if (typeof this.governance?.verifySystemAssignment !== 'function') {
      throw new PaperclipHeartbeatError('M5 每日入口缺少 Paperclip 运行身份核验。');
    }
    const { issue } = await this.governance.verifySystemAssignment({
      issueId,
      runId,
      paperclipAgentId:agentId,
      systemRole:'m5-daily-controller',
    });
    if (issue.status === 'done') {
      return { accepted:true, skipped:true, issueId, reason:'当日入口任务已完成，不重复执行。' };
    }
    if (!String(issue.description || '').includes('[agent-army:m5:routine:m5-daily-campaign]')) {
      throw new PaperclipHeartbeatError('HTTP 控制器只接受 M5 每日 Routine 的固定任务。');
    }

    try {
      const activatedAt = this.now().toISOString();
      const activation = await this.campaignActivator();
      const result = {
        status:'succeeded',
        currentStage:activation.activated ? 'campaign_day_activated' : 'campaign_day_already_active',
        execution:{
          executor:'m5-daily-http-controller',
          mode:'paperclip_daily_case_activation',
          paperclipRunId:runId,
          paperclipAgentId:agentId,
          startedAt:activatedAt,
          finishedAt:activatedAt,
          outcome:activation.activated ? 'activated' : 'idempotent_replay',
        },
        artifactRefs:[{
          artifactId:`campaign-daily-activation:${issueId}`,
          taskId:issueId,
          type:'campaign_daily_activation',
          title:'M5 当日内容 Case 激活结果',
          location:`paperclip://${issueId}/campaign-daily-activation`,
          mimeType:'application/json',
          accessScope:'local-owner',
          validation:{
            exists:true,
            readable:true,
            nonEmpty:true,
            deterministic:true,
            externalSideEffects:false,
          },
          createdAt:activatedAt,
          data:activation,
        }],
      };
      await this.governance.completePaperclipIssue(issueId, { runId, agentId, result });
      return {
        accepted:true,
        issueId,
        stage:result.currentStage,
        status:result.status,
        activation,
      };
    } catch (error) {
      await this.governance.failPaperclipIssue(issueId, { runId, agentId, error }).catch(() => undefined);
      throw error;
    }
  }
}

export class PaperclipParallelWorkHandler {
  constructor({ governance, reconcileParallelWork, now = () => new Date() } = {}) {
    this.governance = governance;
    this.reconcileParallelWork = reconcileParallelWork;
    this.now = now;
    this.inFlightIssues = new Map();
  }

  async handle(payload) {
    const runId = String(payload?.runId || '').trim();
    const agentId = String(payload?.agentId || '').trim();
    const issueId = String(payload?.context?.taskId || '').trim();
    if (!runId || !agentId || !issueId) {
      throw new PaperclipHeartbeatError('M5 并行控制器 heartbeat 缺少运行、控制器或任务标识。');
    }
    if (this.inFlightIssues.has(issueId)) return this.inFlightIssues.get(issueId);
    const execution = this.executeIssue({ issueId, runId, agentId });
    this.inFlightIssues.set(issueId, execution);
    try {
      return await execution;
    } catch (error) {
      if (!isRecoverableM5SystemControllerFailure(error)) throw error;
      try {
        return await recoverM5SystemControllerFailure({
          governance:this.governance,
          issueId,
          runId,
          agentId,
          routineKey:'m5-parallel-join',
          systemRole:'m5-parallel-controller',
          error,
        });
      } catch {
        throw error;
      }
    } finally {
      this.inFlightIssues.delete(issueId);
    }
  }

  async executeIssue({ issueId, runId, agentId }) {
    if (typeof this.reconcileParallelWork !== 'function') {
      throw new PaperclipHeartbeatError('M5 并行控制器缺少确定性协调器。');
    }
    const { issue } = await this.governance.verifySystemAssignment({
      issueId,
      runId,
      paperclipAgentId:agentId,
      systemRole:'m5-parallel-controller',
    });
    if (issue.status === 'done') {
      return { accepted:true, skipped:true, issueId, reason:'并行门禁任务已完成。' };
    }
    const text = `${String(issue.title || '')}\n${String(issue.description || '')}`;
    if (!text.includes('[agent-army:m5:routine:m5-parallel-join]')) {
      throw new PaperclipHeartbeatError('并行控制器只接受 m5-parallel-join Routine。');
    }
    const caseId = text.match(/当前 Case 为 ([0-9a-f-]{8,80})/i)?.[1] || '';
    if (!caseId) throw new PaperclipHeartbeatError('并行门禁任务缺少可信日期 Case。');
    if (typeof this.governance.assertCaseIssueLink !== 'function') {
      throw new PaperclipHeartbeatError('并行控制器缺少 Paperclip Case/Issue 绑定核验。');
    }
    await this.governance.assertCaseIssueLink(caseId, issueId);
    await consumeM5SystemControllerPlanRevision({
      governance:this.governance,
      pipelineCaseId:caseId,
      runId,
      routineKey:'m5-parallel-join',
      systemRole:'m5-parallel-controller',
    });

    try {
      const result = await this.reconcileParallelWork(caseId);
      const completedAt = this.now().toISOString();
      if (!result.joined && result.dayCase?.stageKey === 'parallel_join_gate') {
        return { accepted:true, issueId, joined:false, waiting:true, result };
      }
      await this.governance.completePaperclipIssue(issueId, {
        runId,
        agentId,
        result:{
          status:'succeeded',
          currentStage:result.joined ? 'parallel_join_completed' : 'parallel_join_waiting',
          execution:{
            owner:'m5-parallel-controller',
            outcome:result.joined ? 'joined' : 'waiting',
            finishedAt:completedAt,
          },
          artifactRefs:[{
            type:'parallel_work_observation',
            validation:{ exists:true, readable:true, nonEmpty:true },
            data:{
              dayCaseId:caseId,
              joined:result.joined,
              dispatched:result.dispatched,
              waiting:result.waiting,
            },
          }],
        },
      });
      return { accepted:true, issueId, joined:result.joined, result };
    } catch (error) {
      throw markM5SystemControllerFailure(error);
    }
  }
}

export class PaperclipHeartbeatError extends Error {}

function assertNoDailySelectionParameters(payload) {
  const denied = new Set(['campaignId', 'scheduledDate', 'caseId', 'platform', 'contentVersion']);
  const queue = [payload];
  while (queue.length) {
    const value = queue.pop();
    if (!value || typeof value !== 'object') continue;
    for (const [key, child] of Object.entries(value)) {
      if (denied.has(key)) {
        throw new PaperclipHeartbeatError(`M5 每日 HTTP heartbeat 不接受调用方指定 ${key}。`);
      }
      if (child && typeof child === 'object') queue.push(child);
    }
  }
}

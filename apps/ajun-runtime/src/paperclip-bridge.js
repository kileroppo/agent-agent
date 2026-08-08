import crypto from 'node:crypto';
import { paperclipHermesAdapterConfig, usesPaperclipHermesExecution } from './governance-hermes-runtime.js';
import { PaperclipHttpTransport } from '@agent-army/paperclip-client';
import { PaperclipTaskProjector } from './paperclip-task-projector.js';

const DEFAULT_URL = 'http://127.0.0.1:3100';
const M5_GRAY_DAY_ALLOWED_STAGES = new Set([
  'topic',
  'parallel_join_gate',
  'script',
  'render',
]);
const M5_GRAY_DENIED_STATES = new Set([
  'blocked',
  'cancelled',
  'done',
  'failed',
  'terminated',
]);
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const PUBLISHER_APPROVAL_KIND = 'publisher_connector_approval_v1';
const PUBLISHER_APPROVAL_SCHEMA = 'agent.army/publisher-connector-approvals/v1';
const PUBLISHER_AUTHORIZATION_SCHEMA = 'agent.army/publisher-authorization/v1';
const PUBLISHER_COST_RECORD_SCHEMA = 'agent.army/publisher-cost-record/v1';
const PUBLISHER_ACTION_ROLES = Object.freeze({
  'publisher.publish':'m5-publisher-controller',
  'publisher.read_own_metrics':'m5-metrics-controller',
  'publisher.reconcile_stale_attempt':'m5-metrics-controller',
});
const PUBLISHER_ACTION_STAGES = Object.freeze({
  'publisher.publish':'publish',
  'publisher.read_own_metrics':'metrics',
  'publisher.reconcile_stale_attempt':'metrics',
});
const PUBLISHER_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const PUBLISHER_SECRET_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const PUBLISHER_CONNECTOR_MODE = /^real:[a-z0-9][a-z0-9_-]{0,127}$/;
const PUBLISHER_BUDGET_OPERATIONS = new Set(['publish', 'read_own_metrics']);
const PUBLISHER_COST_OPERATIONS = Object.freeze({
  publish:new Set(['upload_video', 'create_video', 'query_video_basic_info', 'publish']),
  read_own_metrics:new Set(['read_video_metrics', 'read_own_metrics']),
});

export class PaperclipBridge {
  constructor({
    baseUrl = process.env.PAPERCLIP_URL || DEFAULT_URL,
    fetchImpl = fetch,
    publisherRunCredentialProvider = null,
    clock = () => new Date(),
  } = {}) {
    this.transport = new PaperclipHttpTransport({ baseUrl, allowRemote:false, fetchImpl, timeoutMs:2500 });
    this.taskProjector = new PaperclipTaskProjector({ endpoint:this.transport, clock });
    this.baseUrl = this.transport.baseUrl;
    this.fetch = fetchImpl;
    this.publisherRunCredentialProvider = publisherRunCredentialProvider;
    this.clock = clock;
  }

  async project(task, approval) {
    return this.taskProjector.project(task, approval);
  }

  async projectChild(task, parentIssueId) {
    return this.taskProjector.projectChild(task, parentIssueId);
  }

  async health() {
    try {
      const status = await this.request('/api/health');
      return { status: status.status === 'ok' ? 'ready' : 'degraded', version: status.version || null };
    } catch { return { status: 'offline', version: null }; }
  }

  async syncRoster(manifests) {
    try {
      const company = await this.companyForRuntime();
      const existing = await this.request(`/api/companies/${company.id}/agents`);
      const roster = (Array.isArray(manifests) ? manifests : []).filter((manifest) => manifest?.agentId && manifest?.name && manifest.status === 'active');
      const desiredAgentIds = new Set(roster.map((manifest) => manifest.agentId));
      const synced = [];
      for (const manifest of roster) {
        const current = existing.find((agent) => agent.metadata?.agentArmyId === manifest.agentId && agent.status !== 'terminated')
          || (manifest.agentId === 'operator' ? existing.find((agent) => agent.name === 'A君本机健康官' && agent.adapterType === 'http' && agent.status !== 'terminated') : null);
        if (current) {
          const desired = paperclipRosterEntry(manifest);
          if (manifest.agentId === 'operator' && current.metadata?.agentArmyId !== 'operator' && !usesPaperclipHermesExecution(manifest)) {
            await this.request(`/api/agents/${encodeURIComponent(current.id)}`, {
              method:'PATCH',
              body:{ metadata:{ ...(current.metadata || {}), agentArmyId:'operator', agentArmyRole:manifest.role, agentArmyManagedOnly:false } }
            });
          } else if (rosterNeedsRefresh(current, manifest)) {
            const hermesOwned = usesPaperclipHermesExecution(manifest);
            await this.request(`/api/agents/${encodeURIComponent(current.id)}`, {
              method:'PATCH', body:{
                name:desired.name, role:desired.role, title:desired.title, icon:desired.icon, capabilities:desired.capabilities,
                ...(hermesOwned ? {
                  adapterType:desired.adapterType,
                  adapterConfig:desired.adapterConfig
                } : {}),
                ...(['paused', 'error'].includes(current.status) && hermesOwned ? { status:'idle' } : {}),
                metadata:{ ...(current.metadata || {}), ...desired.metadata }
              }
            });
          }
          if (usesPaperclipHermesExecution(manifest)) {
            await this.syncAgentSkills(current.id, manifest.runtimeCapabilities?.skills);
          }
          synced.push({ agentArmyId:manifest.agentId, paperclipAgentId:current.id, name:current.name, created:false });
          continue;
        }
        const created = await this.request(`/api/companies/${company.id}/agents`, { method:'POST', body:paperclipRosterEntry(manifest) });
        const configured = await this.request(`/api/agents/${encodeURIComponent(created.id)}`, {
          method:'PATCH',
          body:{ status:usesPaperclipHermesExecution(manifest) ? 'idle' : 'paused' }
        });
        existing.push(configured);
        if (usesPaperclipHermesExecution(manifest)) {
          await this.syncAgentSkills(configured.id, manifest.runtimeCapabilities?.skills);
        }
        synced.push({ agentArmyId:manifest.agentId, paperclipAgentId:configured.id, name:configured.name, created:true });
      }
      const retired = [];
      for (const current of existing) {
        const agentArmyId = String(current?.metadata?.agentArmyId || '').trim();
        if (!agentArmyId
          || desiredAgentIds.has(agentArmyId)
          || current.status === 'terminated'
          || current.metadata?.agentArmyManagedOnly !== true) continue;
        await this.request(`/api/agents/${encodeURIComponent(current.id)}/terminate`, { method:'POST' });
        retired.push({ agentArmyId, paperclipAgentId:current.id, name:current.name });
      }
      return { status:'synced', companyId:company.id, agents:synced, retired, syncedAt:new Date().toISOString() };
    } catch (error) {
      return { status:'sync_pending', reason:safeError(error), syncedAt:new Date().toISOString() };
    }
  }

  async projectProposal(proposal) {
    try {
      const company = await this.companyForRuntime();
      const issue = await this.request(`/api/companies/${company.id}/issues`, {
        method: 'POST', body: {
          title: `招聘审核：${proposal.candidateManifest.name}`,
          description: describeProposal(proposal), status: 'blocked', priority: 'medium'
        }
      });
      const approval = await this.request(`/api/companies/${company.id}/approvals`, {
        method: 'POST', body: {
          type: 'request_board_approval', issueIds: [issue.id],
          payload: { source: 'ajun-runtime', proposalId: proposal.proposalId, candidateAgentId: proposal.candidateManifest.agentId, requestedCapabilities: proposal.requestedCapabilities, desiredSkills: proposal.desiredSkills, budgetPolicy: proposal.budgetPolicy }
        }
      });
      return { status: 'synced', paperclipIssueId: issue.id, paperclipIssueIdentifier: issue.identifier, paperclipApprovalId: approval.id, syncedAt: new Date().toISOString() };
    } catch (error) { return { status: 'sync_pending', reason: safeError(error), syncedAt: new Date().toISOString() }; }
  }

  async syncAgentSkills(paperclipAgentId, skills = []) {
    const desiredSkills = [...new Set((Array.isArray(skills) ? skills : []).map((item) => String(item || '').trim()).filter(Boolean))];
    return this.request(`/api/agents/${encodeURIComponent(paperclipAgentId)}/skills/sync`, {
      method:'POST',
      body:{ desiredSkills }
    });
  }

  async updateProposal(proposal) {
    const projection = proposal.governance;
    if (!projection?.paperclipIssueId) return projection || { status: 'not_projected' };
    try {
      const evidence = (proposal.audit || []).filter((item) => item.action === 'test_evidence_recorded').at(-1);
      await this.request(`/api/issues/${encodeURIComponent(projection.paperclipIssueId)}`, {
        method: 'PATCH', body: { status: proposal.status === 'active' ? 'done' : proposal.status === 'needs_revision' || proposal.status === 'rejected' ? 'blocked' : 'backlog', comment: `A君创建闭环状态：${proposal.status}。草案 ID：${proposal.proposalId}${evidence ? `\n${evidence.detail}` : ''}` }
      });
      return { ...projection, status: 'synced', syncedAt: new Date().toISOString() };
    } catch (error) { return { ...projection, status: 'sync_pending', reason: safeError(error), syncedAt: new Date().toISOString() }; }
  }

  async approveProposal(proposal, decisionNote = '负责人批准受限测试；不代表生产上线。') {
    const approvalId = proposal.governance?.paperclipApprovalId;
    if (!approvalId) throw new Error('Paperclip 审核投影不存在，不能绕过组织级批准。');
    await this.request(`/api/approvals/${encodeURIComponent(approvalId)}/approve`, { method: 'POST', body: { decisionNote } });
    return { ...proposal.governance, status: 'synced', paperclipApprovalStatus: 'approved', syncedAt: new Date().toISOString() };
  }

  async rejectProposal(proposal, decisionNote = '负责人拒绝该草案；未启动测试或生产运行。') {
    const approvalId = proposal.governance?.paperclipApprovalId;
    if (!approvalId) throw new Error('Paperclip 审核投影不存在，不能绕过组织级拒绝。');
    await this.request(`/api/approvals/${encodeURIComponent(approvalId)}/reject`, { method: 'POST', body: { decisionNote } });
    return { ...proposal.governance, status: 'synced', paperclipApprovalStatus: 'rejected', syncedAt: new Date().toISOString() };
  }

  async resolveApproval(approvalId, decision, decisionNote = '由飞书组织级审批卡确认。') {
    const normalized = String(decision || '').trim().toLowerCase();
    if (!['approve', 'reject'].includes(normalized)) throw new Error('组织级审批决定无效。');
    const approval = await this.request(`/api/approvals/${encodeURIComponent(String(approvalId || ''))}/${normalized}`, { method: 'POST', body: { decisionNote } });
    const expected = normalized === 'approve' ? 'approved' : 'rejected';
    if (approval.status !== expected) throw new Error(`Paperclip 审批未进入预期状态：${approval.status || 'unknown'}。`);
    return approval;
  }

  async getApproval(approvalId) {
    const normalized = String(approvalId || '').trim();
    if (!normalized) throw new Error('Paperclip 审批 ID 不能为空。');
    return this.request(`/api/approvals/${encodeURIComponent(normalized)}`);
  }

  async update(task) {
    const projection = task.governance;
    if (!projection?.paperclipIssueId) return projection || { status: 'not_projected' };
    if (task.taskType === 'operations.technical-repair' && projection.paperclipAssigneeAgentId && task.status !== 'waiting_test') {
      return { ...projection, status:'delegated', syncedAt:new Date().toISOString() };
    }
    try {
      await this.request(`/api/issues/${projection.paperclipIssueId}`, {
        method: 'PATCH', body: { status: issueStatusFor(task.status), comment: `A君状态更新：${task.status}${task.currentStage ? ` / ${task.currentStage}` : ''}` }
      });
      return { ...projection, status: 'synced', syncedAt: new Date().toISOString() };
    } catch (error) {
      return { ...projection, status: 'sync_pending', reason: safeError(error), syncedAt: new Date().toISOString() };
    }
  }

  async completePaperclipIssue(issueId, {
    runId,
    agentId,
    apiKey,
    result,
    hideFromDashboard = false,
  }) {
    const report = result.artifactRefs?.find((item) => item.type === 'health_report')?.data;
    const employeeReport = result.artifactRefs?.find((item) => item.type === 'employee_role_report')?.data;
    const outcome = report?.overall || employeeReport?.summary || result.execution?.outcome || 'unknown';
    const succeeded = result.status === 'succeeded';
    await this.request(`/api/issues/${encodeURIComponent(issueId)}`, {
      method: 'PATCH', runId, apiKey, body: {
        status: succeeded ? 'done' : 'blocked',
        ...(hideFromDashboard && succeeded ? { hiddenAt:new Date().toISOString() } : {}),
        comment: [
          result.execution?.owner === 'paperclip-hermes'
            ? '员工 Hermes Profile 执行回报。'
            : 'A君本机执行回报（Paperclip HTTP Adapter）。',
          `运行：${runId}`,
          `岗位：${agentId}`,
          `阶段：${result.currentStage || 'unknown'}`,
          `结果：${outcome}`,
          ...(hideFromDashboard && succeeded
            ? ['系统巡检已归档：保留运行与任务证据，不进入老板大盘。']
            : []),
        ].join('\n')
      }
    });
  }

  async getPaperclipIssue(issueId) {
    return this.request(`/api/issues/${encodeURIComponent(issueId)}`);
  }

  async getPaperclipIssueRuns(issueId) {
    return this.request(`/api/issues/${encodeURIComponent(issueId)}/runs`);
  }

  async getPaperclipIssueActiveRun(issueId) {
    return this.request(`/api/issues/${encodeURIComponent(issueId)}/active-run`);
  }

  async getPaperclipHeartbeatRun(runId) {
    return this.request(`/api/heartbeat-runs/${encodeURIComponent(runId)}`);
  }

  async getPipelineCaseOutputs(caseId) {
    return this.request(`/api/cases/${encodeURIComponent(caseId)}/outputs`);
  }

  async getPipelineCase(caseId) {
    return this.request(`/api/cases/${encodeURIComponent(caseId)}`);
  }

  async getPipelineCaseEvents(caseId) {
    return this.request(`/api/cases/${encodeURIComponent(caseId)}/events?limit=100&order=desc`);
  }

  async patchPipelineCaseFields(caseId, {
    expectedVersion,
    fields,
    runId,
  } = {}) {
    return this.request(`/api/cases/${encodeURIComponent(caseId)}`, {
      method:'PATCH',
      runId,
      body:{
        expectedVersion,
        fields,
      },
    });
  }

  async reopenM5StageIssue(issueId, { runId, comment } = {}) {
    return this.request(`/api/issues/${encodeURIComponent(issueId)}`, {
      method:'PATCH',
      runId,
      body:{
        status:'todo',
        comment,
      },
    });
  }

  async blockM5StageIssue(issueId, { runId, comment } = {}) {
    return this.request(`/api/issues/${encodeURIComponent(issueId)}`, {
      method:'PATCH',
      runId,
      body:{
        status:'blocked',
        comment,
      },
    });
  }

  async completeM5RecoveredStageIssue(issueId, { runId, comment } = {}) {
    return this.request(`/api/issues/${encodeURIComponent(issueId)}`, {
      method:'PATCH',
      runId,
      body:{
        status:'done',
        comment,
      },
    });
  }

  async getRetrospectiveMetricOutputs(caseId) {
    const detail = await this.getPipelineCase(caseId);
    const item = detail?.case ?? detail;
    const pipelineId = item?.pipelineId || detail?.pipeline?.id;
    if (!pipelineId) throw new Error('M5 复盘 Case 缺少可信 Pipeline 绑定。');
    const rows = await this.request(`/api/pipelines/${encodeURIComponent(pipelineId)}/cases`);
    const cases = Array.isArray(rows) ? rows : Array.isArray(rows?.items) ? rows.items : [];
    const outputs = await Promise.all(cases.map((entry) => {
      const linkedCase = entry?.case ?? entry;
      if (!linkedCase?.id) return [];
      return this.getPipelineCaseOutputs(linkedCase.id)
        .then((value) => Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : []);
    }));
    return { items:outputs.flat() };
  }

  async getNextM5GrayTargetCase(caseId) {
    const detail = await this.getPipelineCase(caseId);
    const current = detail?.case ?? detail;
    const pipelineId = current?.pipelineId || detail?.pipeline?.id;
    const currentDate = String(current?.fields?.scheduledDate || '');
    if (!pipelineId || !/^\d{4}-\d{2}-\d{2}$/.test(currentDate)) return null;
    const rows = await this.request(`/api/pipelines/${encodeURIComponent(pipelineId)}/cases`);
    const candidates = (Array.isArray(rows) ? rows : Array.isArray(rows?.items) ? rows.items : [])
      .map((entry) => {
        const item = entry?.case ?? entry;
        return {
          ...item,
          stageKey:item?.stageKey ?? entry?.stage?.key ?? item?.stage?.key ?? null,
        };
      })
      .filter((item) =>
        item?.id
        && item?.fields?.scheduledDate > currentDate
        && item?.fields?.platform === 'douyin'
        && item?.parentCaseId
        && !item?.fields?.workBranch
        && !item?.fields?.parallelJoin
        && item?.stageKey === 'machine_review')
      .sort((left, right) =>
        left.fields.scheduledDate.localeCompare(right.fields.scheduledDate)
        || String(left.id).localeCompare(String(right.id)));
    if (candidates.length === 0) return null;
    const selected = candidates[0];
    const dayDetail = await this.getPipelineCase(selected.parentCaseId);
    const day = dayDetail?.case ?? dayDetail;
    const dayStageKey = day?.stageKey ?? dayDetail?.stage?.key ?? day?.stage?.key ?? null;
    const scheduledDate = String(selected.fields.scheduledDate || '');
    const campaignId = String(selected.fields?.campaignId || '');
    const currentCampaignId = String(current?.fields?.campaignId || '');
    const dayCampaignId = String(day?.fields?.campaignId || '');
    const currentProjectId = m5CaseProjectId(detail, current);
    const dayProjectId = m5CaseProjectId(dayDetail, day);
    if (
      day?.id !== selected.parentCaseId
      || !day?.parentCaseId
      || selected.pipelineId !== pipelineId
      || day?.pipelineId !== pipelineId
      || String(day?.fields?.scheduledDate || '') !== scheduledDate
      || day?.fields?.platform
      || day?.fields?.workBranch
      || day?.fields?.parallelJoin
      || !campaignId
      || campaignId !== currentCampaignId
      || campaignId !== dayCampaignId
      || !currentProjectId
      || currentProjectId !== dayProjectId
      || !M5_GRAY_DAY_ALLOWED_STAGES.has(dayStageKey)
      || m5GrayCaseInactive(selected)
      || m5GrayCaseInactive(dayDetail)
    ) {
      throw new Error('M5 灰度平台 Case 的父日期 Case 链、日期、项目、活动或可执行状态复核失败。');
    }
    return {
      caseId:selected.id,
      dayCaseId:day.id,
      scheduledDate,
      platform:'douyin',
    };
  }

  async transitionPipelineCase(caseId, payload, { runId } = {}) {
    return this.request(`/api/cases/${encodeURIComponent(caseId)}/transition`, {
      method:'POST',
      runId,
      body:payload,
    });
  }

  async assertCaseIssueLink(caseId, issueId) {
    const rows = await this.request(`/api/cases/${encodeURIComponent(caseId)}/issue-links`);
    const links = Array.isArray(rows) ? rows : Array.isArray(rows?.items) ? rows.items : [];
    if (!links.some((item) => (item.issue?.id || item.issueId) === issueId)) {
      throw new Error('M5 系统控制器任务与声明的 Pipeline Case 没有关联。');
    }
    return { caseId, issueId };
  }

  async verifyHermesAssignment({ issueId, runId, paperclipAgentId, agentArmyId } = {}) {
    const safeIssueId = requiredIdentifier(issueId, 'Paperclip 任务标识缺失。');
    const safeRunId = requiredIdentifier(runId, 'Paperclip 运行标识缺失。');
    const safePaperclipAgentId = requiredIdentifier(paperclipAgentId, 'Paperclip 员工标识缺失。');
    const safeAgentArmyId = String(agentArmyId || '').trim();
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(safeAgentArmyId)) throw new Error('军团员工标识无效。');
    const [issue, paperclipAgent, runDocument] = await Promise.all([
      this.getPaperclipIssue(safeIssueId),
      this.getPaperclipAgent(safePaperclipAgentId),
      this.getPaperclipIssueRuns(safeIssueId)
    ]);
    if (!paperclipAgent || paperclipAgent.metadata?.agentArmyId !== safeAgentArmyId) {
      throw new Error('Paperclip 员工与 Hermes Profile 身份不一致。');
    }
    if (issue.assigneeAgentId !== paperclipAgent.id) throw new Error('该任务没有指派给当前员工。');
    const runs = Array.isArray(runDocument) ? runDocument : Array.isArray(runDocument?.runs) ? runDocument.runs : [];
    const rawRun = runs.find((item) => (item?.id || item?.runId) === safeRunId && (!item.agentId || item.agentId === paperclipAgent.id));
    if (!rawRun) throw new Error('Paperclip 当前运行与任务指派不一致。');
    const run = { ...rawRun, id:rawRun.id || rawRun.runId };
    return { issue, run, paperclipAgent, agentArmyId:safeAgentArmyId };
  }

  async verifySystemAssignment({
    issueId,
    runId,
    paperclipAgentId,
    systemRole,
  } = {}) {
    const safeIssueId = requiredIdentifier(issueId, 'Paperclip 任务标识缺失。');
    const safeRunId = requiredIdentifier(runId, 'Paperclip 运行标识缺失。');
    const safePaperclipAgentId = requiredIdentifier(paperclipAgentId, 'Paperclip 控制器标识缺失。');
    const safeSystemRole = String(systemRole || '').trim();
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(safeSystemRole)) throw new Error('Paperclip 系统控制器角色无效。');
    const [issue, paperclipAgent, activeRun, heartbeatRun] = await Promise.all([
      this.getPaperclipIssue(safeIssueId),
      this.getPaperclipAgent(safePaperclipAgentId),
      this.getPaperclipIssueActiveRun(safeIssueId),
      this.getPaperclipHeartbeatRun(safeRunId),
    ]);
    if (!paperclipAgent || paperclipAgent.metadata?.agentArmySystemRole !== safeSystemRole) {
      throw new Error('Paperclip HTTP 系统控制器身份不一致。');
    }
    if (issue.assigneeAgentId !== paperclipAgent.id) {
      throw new Error('该任务没有指派给当前 HTTP 系统控制器。');
    }
    if (
      issue.status !== 'in_progress'
      || activeRun?.id !== safeRunId
      || activeRun?.status !== 'running'
      || activeRun?.agentId !== paperclipAgent.id
    ) {
      throw new Error('Paperclip 当前活跃运行与 HTTP 系统控制器指派不一致。');
    }
    if (
      heartbeatRun?.id !== safeRunId
      || heartbeatRun?.status !== 'running'
      || heartbeatRun?.agentId !== paperclipAgent.id
      || !issue.companyId
      || heartbeatRun.companyId !== issue.companyId
      || paperclipAgent.companyId !== issue.companyId
    ) {
      throw new Error('Paperclip 当前活跃运行身份无效。');
    }
    return { issue, run:heartbeatRun, paperclipAgent, systemRole:safeSystemRole };
  }

  async authorizePublisherRequest(input = {}) {
    const context = await this.publisherAuthorizationContext(input);
    const existing = publisherAuthorizationRecord(
      context.targetCase.fields?.m5PublisherAuthorizations?.[input.authorizationId],
    );
    const canonical = {
      schemaVersion:PUBLISHER_AUTHORIZATION_SCHEMA,
      action:input.action,
      authorizationId:input.authorizationId,
      runId:input.runId,
      issueId:input.issueId,
      agentId:input.agentId,
      campaignId:input.campaignId,
    };
    if (existing) {
      if (!samePublisherAuthorization(existing, canonical)) {
        throw new Error('Publisher 授权幂等标识与已有 Paperclip 记录冲突。');
      }
      return { ...canonical, authorized:true, replayed:true };
    }
    const expectedVersion = integerVersion(context.targetCase.version);
    const records = boundedRecordMap(
      context.targetCase.fields?.m5PublisherAuthorizations,
      input.authorizationId,
      {
        ...canonical,
        consumedAt:validClock(this.clock()).toISOString(),
      },
    );
    const updated = normalizeM5Case(await this.patchPipelineCaseFields(
      context.targetCase.id,
      {
        expectedVersion,
        runId:context.credential.runId,
        fields:{
          ...context.targetCase.fields,
          m5PublisherAuthorizations:records,
        },
      },
    ));
    const persisted = publisherAuthorizationRecord(
      updated.fields?.m5PublisherAuthorizations?.[input.authorizationId],
    );
    if (!persisted || !samePublisherAuthorization(persisted, canonical)) {
      throw new Error('Publisher 一次性授权没有在 Paperclip Case 中回读确认。');
    }
    return { ...canonical, authorized:true, replayed:false };
  }

  async getPublisherConnectorApprovalSnapshot(input = {}) {
    const context = await this.publisherAuthorizationContext(input);
    const approvals = await this.publisherConnectorApprovals(context);
    if (approvals.length === 0) {
      throw new Error('Paperclip 中没有当前 Campaign 可用的 Publisher connector 批准。');
    }
    const publicApprovals = approvals
      .map((approval) => ({
        status:'approved',
        approvalRef:`paperclip:approval:${approval.id}`,
        platform:approval.platform,
        capability:approval.capability,
        connectorKind:approval.connectorKind,
        expiresAt:approval.expiresAt,
      }))
      .sort((left, right) => (
        `${left.platform}:${left.capability}`.localeCompare(
          `${right.platform}:${right.capability}`,
        )
      ));
    const snapshotHash = crypto.createHash('sha256')
      .update(stableJson(publicApprovals))
      .digest('hex');
    return {
      schemaVersion:PUBLISHER_APPROVAL_SCHEMA,
      source:'paperclip',
      snapshotId:`paperclip:publisher-approvals:${snapshotHash}`,
      capturedAt:validClock(this.clock()).toISOString(),
      approvals:publicApprovals,
    };
  }

  async resolvePublisherCredentialReference(input = {}) {
    assertExactKeys(input, ['accountRef', 'platform', 'purpose'], 'Publisher 凭据请求');
    const platform = publisherPlatform(input.platform);
    const purpose = publisherCapability(input.purpose);
    const accountRef = publisherReference(input.accountRef, 'Publisher accountRef 无效。');
    const context = await this.publisherRunContextForConnector();
    if (purpose !== context.controllerCapability) {
      throw new Error('Publisher 当前控制器不能读取另一类 connector 凭据。');
    }
    const approval = uniquePublisherApproval(
      await this.publisherConnectorApprovals(context),
      { platform, capability:purpose, accountRef },
    );
    if (!PUBLISHER_SECRET_KEY.test(String(approval.secretKey || ''))) {
      throw new Error('Publisher connector 批准没有绑定可按 Run 读取的 Paperclip Secret key。');
    }
    let response;
    try {
      response = await this.request(
        `/api/agents/me/secrets/${encodeURIComponent(approval.secretKey)}/value`,
        {
          method:'POST',
          runId:context.credential.runId,
          apiKey:context.credential.apiKey,
        },
      );
    } catch {
      throw new Error('Paperclip 未向当前 Publisher Run 提供已批准的账号凭据。');
    }
    return parsePublisherCredential(response?.value);
  }

  async verifyPublisherAccountIdentity(input = {}) {
    assertExactKeys(
      input,
      ['platform', 'accountRef', 'providerIdentity'],
      'Publisher 账号身份核验请求',
    );
    const platform = publisherPlatform(input.platform);
    const accountRef = publisherReference(input.accountRef, 'Publisher accountRef 无效。');
    const identity = publisherIdentity(input.providerIdentity);
    const context = await this.publisherRunContextForConnector();
    const approvals = (await this.publisherConnectorApprovals(context)).filter(
      (approval) => (
        approval.platform === platform
        && approval.accountRef === accountRef
        && approval.capability === context.controllerCapability
      ),
    );
    if (approvals.length === 0 || approvals.some(
      (approval) => !samePublisherIdentity(approval.providerIdentity, identity),
    )) {
      throw new Error('Paperclip 无法确认 Publisher accountRef 与平台账号身份一致。');
    }
    return {
      verified:true,
      platform,
      accountRef,
      providerIdentity:identity,
      verificationRef:`paperclip:approval:${approvals[0].id}:account-identity`,
    };
  }

  async assertPublisherCampaignBudget(input = {}) {
    assertExactKeys(
      input,
      ['campaignId', 'connectorMode', 'operation', 'checkedAt'],
      'Publisher 预算请求',
    );
    const campaignId = publisherReference(input.campaignId, 'Publisher Campaign 标识无效。');
    const connectorMode = String(input.connectorMode || '');
    const operation = String(input.operation || '');
    if (
      !PUBLISHER_CONNECTOR_MODE.test(connectorMode)
      || !PUBLISHER_BUDGET_OPERATIONS.has(operation)
    ) {
      throw new Error('Publisher connector 模式或预算操作无效。');
    }
    validClock(input.checkedAt);
    const context = await this.publisherRunContextForConnector(campaignId);
    if (operation !== context.controllerCapability) {
      throw new Error('Publisher 预算操作与当前控制器能力不一致。');
    }
    const overview = await this.request(
      `/api/companies/${encodeURIComponent(context.credential.companyId)}/budgets/overview`,
      {
        runId:context.credential.runId,
        apiKey:context.credential.apiKey,
      },
    );
    const scopes = [
      ['company', context.credential.companyId],
      ['agent', context.credential.agentId],
      ['project', context.projectId],
    ];
    const policies = Array.isArray(overview?.policies) ? overview.policies : [];
    const matched = scopes.map(([scopeType, scopeId]) => {
      const rows = policies.filter((policy) => (
        policy?.scopeType === scopeType
        && policy?.scopeId === scopeId
        && policy?.metric === 'billed_cents'
        && policy?.isActive !== false
      ));
      if (rows.length !== 1 || rows[0]?.hardStopEnabled !== true) {
        throw new Error(`Paperclip ${scopeType} Publisher 预算没有唯一硬停策略。`);
      }
      const remainingAmount = Number(rows[0].remainingAmount);
      if (!Number.isFinite(remainingAmount) || remainingAmount < 0) {
        throw new Error(`Paperclip ${scopeType} Publisher 剩余预算无效。`);
      }
      return { ...rows[0], remainingAmount };
    });
    const projectPolicy = matched.find((policy) => policy.scopeType === 'project');
    if (
      !Number.isInteger(Number(projectPolicy?.amount))
      || Number(projectPolicy.amount) !== Number(context.campaignGrant.budgetCents)
    ) {
      throw new Error('Paperclip Project 预算与 CampaignGrant 不一致。');
    }
    const allowed = matched.every((policy) => (
      policy.paused !== true
      && ['ok', 'warning'].includes(policy.status)
      && policy.remainingAmount >= 1
    ));
    return {
      campaignId,
      allowed,
      hardStopEnabled:true,
      remainingAmountUsd:Math.min(...matched.map((policy) => policy.remainingAmount)) / 100,
    };
  }

  async recordPublisherConnectorAttempt(input = {}) {
    assertExactKeys(input, [
      'costRecordId',
      'campaignId',
      'connectorMode',
      'operation',
      'providerRequestId',
      'receiptRef',
      'amountUsd',
      'occurredAt',
    ], 'Publisher 费用记录');
    const costRecordId = publisherReference(input.costRecordId, 'Publisher 费用幂等标识无效。');
    const campaignId = publisherReference(input.campaignId, 'Publisher Campaign 标识无效。');
    const connectorMode = String(input.connectorMode || '');
    const operation = String(input.operation || '');
    const amountUsd = Number(input.amountUsd);
    const occurredAt = validClock(input.occurredAt).toISOString();
    if (
      !PUBLISHER_CONNECTOR_MODE.test(connectorMode)
      || !/^[a-z][a-z0-9_]{1,63}$/.test(operation)
      || !Number.isFinite(amountUsd)
      || amountUsd < 0
      || amountUsd > 10_000
      || (input.providerRequestId ? 1 : 0) + (input.receiptRef ? 1 : 0) !== 1
    ) {
      throw new Error('Publisher 费用来源、金额或唯一回执引用无效。');
    }
    const sourceRef = publisherReference(
      input.providerRequestId || input.receiptRef,
      'Publisher 费用来源引用无效。',
    );
    const context = await this.publisherRunContextForConnector(campaignId);
    if (!PUBLISHER_COST_OPERATIONS[context.controllerCapability]?.has(operation)) {
      throw new Error('Publisher 费用步骤与当前控制器能力不一致。');
    }
    const canonical = {
      schemaVersion:PUBLISHER_COST_RECORD_SCHEMA,
      costRecordId,
      campaignId,
      connectorMode,
      operation,
      sourceRef,
      amountUsd,
      occurredAt,
    };
    const existing = publisherCostRecord(
      context.targetCase.fields?.m5PublisherCostRecords?.[costRecordId],
    );
    if (existing) {
      if (!samePublisherCost(existing, canonical)) {
        throw new Error('Publisher 费用幂等标识与已有 Paperclip 记录冲突。');
      }
      if (existing.state !== 'reported' || !UUID.test(String(existing.costEventId || ''))) {
        throw new Error('Publisher 费用上报状态未决，禁止自动重试。');
      }
      return { reportRef:`paperclip:cost-event:${existing.costEventId}` };
    }
    let targetCase = await this.patchPublisherCostRecord(context, canonical, {
      state:'submitting',
      claimedAt:validClock(this.clock()).toISOString(),
    });
    let created;
    try {
      created = await this.request(
        `/api/companies/${encodeURIComponent(context.credential.companyId)}/cost-events`,
        {
          method:'POST',
          runId:context.credential.runId,
          apiKey:context.credential.apiKey,
          body:{
            agentId:context.credential.agentId,
            issueId:context.credential.issueId,
            projectId:context.projectId,
            heartbeatRunId:context.credential.runId,
            provider:connectorMode === 'real:douyin_official_api' ? 'douyin' : 'agent-army.local-cua',
            biller:connectorMode === 'real:douyin_official_api' ? 'douyin' : 'agent-army',
            billingType:connectorMode === 'real:douyin_official_api' ? 'metered_api' : 'fixed',
            billingCode:`m5:publisher:${operation}`,
            model:connectorMode,
            inputTokens:0,
            cachedInputTokens:0,
            outputTokens:0,
            costCents:Math.round(amountUsd * 100),
            occurredAt,
          },
        },
      );
    } catch {
      throw new Error('Publisher 费用提交结果未确认，Paperclip 记录保持 submitting。');
    }
    if (
      !UUID.test(String(created?.id || ''))
      || created.agentId !== context.credential.agentId
      || created.projectId !== context.projectId
      || created.heartbeatRunId !== context.credential.runId
      || created.costCents !== Math.round(amountUsd * 100)
    ) {
      throw new Error('Paperclip Publisher 费用回执与提交上下文不一致。');
    }
    targetCase = await this.patchPublisherCostRecord(
      { ...context, targetCase },
      canonical,
      {
        state:'reported',
        costEventId:created.id,
        reportedAt:validClock(this.clock()).toISOString(),
      },
    );
    const confirmed = publisherCostRecord(
      targetCase.fields?.m5PublisherCostRecords?.[costRecordId],
    );
    if (confirmed?.state !== 'reported' || confirmed.costEventId !== created.id) {
      throw new Error('Publisher 费用事件没有在 Paperclip Case 中回读确认。');
    }
    return { reportRef:`paperclip:cost-event:${created.id}` };
  }

  async patchPublisherCostRecord(context, canonical, patch) {
    const records = boundedRecordMap(
      context.targetCase.fields?.m5PublisherCostRecords,
      canonical.costRecordId,
      { ...canonical, ...patch },
    );
    return normalizeM5Case(await this.patchPipelineCaseFields(
      context.targetCase.id,
      {
        expectedVersion:integerVersion(context.targetCase.version),
        runId:context.credential.runId,
        fields:{
          ...context.targetCase.fields,
          m5PublisherCostRecords:records,
        },
      },
    ));
  }

  async publisherAuthorizationContext(input = {}) {
    assertExactKeys(
      input,
      ['action', 'runId', 'issueId', 'campaignId', 'agentId', 'authorizationId'],
      'Publisher 授权请求',
    );
    const action = String(input.action || '');
    const expectedRole = PUBLISHER_ACTION_ROLES[action];
    if (!expectedRole) throw new Error('Publisher action 不属于批准的系统控制器动作。');
    const credential = await this.currentPublisherRunCredential();
    for (const field of ['runId', 'issueId', 'agentId']) {
      if (input[field] !== credential[field]) {
        throw new Error('Publisher 请求与当前 Paperclip Run 身份不一致。');
      }
    }
    publisherReference(input.campaignId, 'Publisher Campaign 标识无效。');
    assertPublisherAuthorizationId(input, credential);
    const verified = await this.verifySystemAssignment({
      issueId:credential.issueId,
      runId:credential.runId,
      paperclipAgentId:credential.agentId,
      systemRole:expectedRole,
    });
    if (verified.issue.companyId !== credential.companyId) {
      throw new Error('Publisher 当前 Run 的公司身份与 Paperclip Issue 不一致。');
    }
    return this.publisherCampaignContext({
      credential,
      issue:verified.issue,
      campaignId:input.campaignId,
      expectedStage:PUBLISHER_ACTION_STAGES[action],
    });
  }

  async publisherRunContextForConnector(campaignId = null) {
    const credential = await this.currentPublisherRunCredential();
    const roles = Object.values(PUBLISHER_ACTION_ROLES);
    let verified = null;
    for (const systemRole of [...new Set(roles)]) {
      try {
        verified = await this.verifySystemAssignment({
          issueId:credential.issueId,
          runId:credential.runId,
          paperclipAgentId:credential.agentId,
          systemRole,
        });
        break;
      } catch {
        // 只接受两个固定 Publisher 系统控制器之一；都不匹配时统一失败。
      }
    }
    if (!verified || verified.issue.companyId !== credential.companyId) {
      throw new Error('当前 Paperclip Run 不属于 Publisher 或 Metrics 系统控制器。');
    }
    const expectedStage = verified.systemRole === 'm5-publisher-controller' ? 'publish' : 'metrics';
    const context = await this.publisherCampaignContext({
      credential,
      issue:verified.issue,
      campaignId,
      expectedStage,
    });
    return {
      ...context,
      controllerCapability:verified.systemRole === 'm5-publisher-controller'
        ? 'publish'
        : 'read_own_metrics',
    };
  }

  async publisherCampaignContext({ credential, issue, campaignId, expectedStage }) {
    const targetCaseId = publisherIssueCaseId(issue);
    await this.assertCaseIssueLink(targetCaseId, credential.issueId);
    const targetDetail = await this.getPipelineCase(targetCaseId);
    const targetCase = normalizeM5Case(targetDetail);
    if (targetCase.stageKey !== expectedStage || !targetCase.parentCaseId) {
      throw new Error(`Publisher 当前 Case 不在 ${expectedStage} 阶段。`);
    }
    const dayCase = normalizeM5Case(await this.getPipelineCase(targetCase.parentCaseId));
    if (!dayCase.parentCaseId) throw new Error('Publisher 日期 Case 缺少活动父 Case。');
    const campaignCase = normalizeM5Case(await this.getPipelineCase(dayCase.parentCaseId));
    const canonicalCampaignId = String(campaignCase.id || '');
    if (
      campaignCase.parentCaseId
      || campaignCase.stageKey !== 'campaign_active'
      || (campaignId && canonicalCampaignId !== campaignId)
      || targetCase.pipelineId !== dayCase.pipelineId
      || targetCase.pipelineId !== campaignCase.pipelineId
    ) {
      throw new Error('Publisher Case 不属于当前 active Campaign。');
    }
    const campaignGrant = campaignCase.fields?.campaignGrant;
    const now = validClock(this.clock()).getTime();
    const startsAt = Date.parse(campaignGrant?.startsAt);
    const expiresAt = Date.parse(campaignGrant?.expiresAt);
    if (
      campaignGrant?.status !== 'active'
      || !Number.isFinite(startsAt)
      || !Number.isFinite(expiresAt)
      || startsAt > now
      || expiresAt <= now
    ) {
      throw new Error('Publisher CampaignGrant 未激活或已经过期。');
    }
    const projectId = m5CaseProjectId(targetDetail, targetCase)
      || m5CaseProjectId({}, campaignCase);
    if (!UUID.test(projectId)) throw new Error('Publisher Campaign 缺少可信 Paperclip Project。');
    return {
      credential,
      issue,
      targetCase,
      dayCase,
      campaignCase,
      campaignGrant:structuredClone(campaignGrant),
      projectId,
    };
  }

  async publisherConnectorApprovals(context) {
    const payload = await this.request(
      `/api/companies/${encodeURIComponent(context.credential.companyId)}/approvals`,
      {
        runId:context.credential.runId,
        apiKey:context.credential.apiKey,
      },
    );
    const approvals = Array.isArray(payload) ? payload : Array.isArray(payload?.items) ? payload.items : [];
    const now = validClock(this.clock()).getTime();
    const grant = context.campaignGrant;
    return approvals
      .filter((approval) => approval?.status === 'approved')
      .map((approval) => normalizePublisherConnectorApproval(approval))
      .filter(Boolean)
      .filter((approval) => (
        approval.campaignId === context.campaignCase.id
        && Date.parse(approval.expiresAt) > now
        && approval.accountRef === grant.accountRefs?.[approval.platform]
        && grant.platforms?.includes(approval.platform)
        && (
          approval.capability === 'publish'
            ? grant.allowedActions?.includes('schedule_or_publish')
            : grant.allowedActions?.includes('read_own_metrics')
        )
      ));
  }

  async currentPublisherRunCredential() {
    if (typeof this.publisherRunCredentialProvider !== 'function') {
      throw new Error('Publisher 缺少当前 Paperclip Run 凭据提供器。');
    }
    let value;
    try {
      value = await this.publisherRunCredentialProvider();
    } catch {
      throw new Error('Publisher 当前 Paperclip Run 凭据不可用。');
    }
    const credential = value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : {};
    for (const field of ['runId', 'issueId', 'agentId', 'companyId']) {
      if (!UUID.test(String(credential[field] || ''))) {
        throw new Error('Publisher 当前 Paperclip Run 身份结构无效。');
      }
    }
    if (!String(credential.apiKey || '').trim()) {
      throw new Error('Publisher 当前 Paperclip Run JWT 缺失。');
    }
    return Object.freeze({
      apiKey:String(credential.apiKey).trim(),
      runId:credential.runId,
      issueId:credential.issueId,
      agentId:credential.agentId,
      companyId:credential.companyId,
      ...(UUID.test(String(credential.approvalId || ''))
        ? { approvalId:credential.approvalId }
        : {}),
    });
  }

  async getExecutionWorkspace(workspaceId) {
    return this.request(`/api/execution-workspaces/${encodeURIComponent(workspaceId)}`);
  }

  async getPaperclipAgent(agentId) {
    const company = await this.companyForRuntime();
    const agents = await this.request(`/api/companies/${company.id}/agents`);
    return agents.find((agent) => agent.id === agentId) || null;
  }

  async updateIssueExecutionPolicy(issueId, { runId, executionPolicy } = {}) {
    return this.request(`/api/issues/${encodeURIComponent(issueId)}`, {
      method:'PATCH',
      runId,
      body:{ executionPolicy },
    });
  }

  async createIssueWorkProduct(issueId, product, { runId, apiKey } = {}) {
    return this.request(`/api/issues/${encodeURIComponent(issueId)}/work-products`, {
      method:'POST',
      runId,
      apiKey,
      body:product,
    });
  }

  async getIssueWorkProducts(issueId, { runId } = {}) {
    return this.request(`/api/issues/${encodeURIComponent(issueId)}/work-products`, {
      runId,
    });
  }

  async completeMetricMonitorIssue(issueId, {
    runId,
    executionPolicy,
    comment,
  } = {}) {
    return this.request(`/api/issues/${encodeURIComponent(issueId)}`, {
      method:'PATCH',
      runId,
      body:{
        status:'done',
        executionPolicy,
        comment,
      },
    });
  }

  async completeRetrospectiveIssue(issueId, { runId, comment } = {}) {
    return this.request(`/api/issues/${encodeURIComponent(issueId)}`, {
      method:'PATCH',
      runId,
      body:{
        status:'done',
        comment,
      },
    });
  }

  async updateLearningIssue(issueId, {
    runId,
    status,
    comment,
  } = {}) {
    if (!['in_progress', 'in_review', 'done'].includes(status)) {
      throw new Error('M5 学习任务状态无效。');
    }
    return this.request(`/api/issues/${encodeURIComponent(issueId)}`, {
      method:'PATCH',
      runId,
      body:{ status, comment },
    });
  }

  async completePublisherIssue(issueId, {
    runId,
    comment,
  } = {}) {
    return this.request(`/api/issues/${encodeURIComponent(issueId)}`, {
      method:'PATCH',
      runId,
      body:{
        status:'done',
        comment,
      },
    });
  }

  async completeTechnicalRepairIssue(issueId, title) {
    return this.request(`/api/issues/${encodeURIComponent(issueId)}`, {
      method:'PATCH', body:{ status:'done', comment:`A君已代为登记技术专家在受控工作区留下的修复证据：${String(title || '修复与验证证据')}。专家本身未被授予网络访问权限。` }
    });
  }

  async failPaperclipIssue(issueId, { runId, agentId, error }) {
    await this.request(`/api/issues/${encodeURIComponent(issueId)}`, {
      method: 'PATCH', body: {
        status: 'blocked',
        comment: [
          'A君本机执行失败（Paperclip HTTP Adapter）。',
          `运行：${runId}`,
          `岗位：${agentId}`,
          `原因：${safeError(error)}`
        ].join('\n')
      }
    });
  }

  async companyForRuntime() {
    return this.taskProjector.companyForRuntime();
  }

  async managedAgent(agentArmyId, companyId = null) {
    return this.taskProjector.managedAgent(agentArmyId, companyId);
  }

  async request(path, options = {}) {
    return this.transport.request(options.method || 'GET', path, options);
  }
}

function m5CaseProjectId(detail, item) {
  return String(
    item?.projectId
    || item?.fields?.projectId
    || item?.pipeline?.projectId
    || detail?.pipeline?.projectId
    || '',
  );
}

function m5GrayCaseInactive(value) {
  const item = value?.case ?? value;
  const stage = value?.stage ?? item?.stage;
  const activeWork = value?.activeWork ?? item?.activeWork;
  const terminalKind = String(item?.terminalKind || value?.terminalKind || '').trim();
  const states = [
    item?.status,
    item?.stageKey,
    stage?.key,
    stage?.kind,
    activeWork?.status,
    item?.fields?.m5StageRecovery?.status,
  ].map((state) => String(state || '').trim().toLowerCase());
  const stageRecoveries = Object.values(
    item?.fields?.m5ContentRecovery?.stageRecoveries || {},
  );
  return (
    !item?.id
    || item?.blocked === true
    || item?.terminal === true
    || terminalKind.length > 0
    || states.some((state) => M5_GRAY_DENIED_STATES.has(state))
    || stageRecoveries.some((entry) =>
      M5_GRAY_DENIED_STATES.has(String(entry?.status || '').trim().toLowerCase()))
  );
}

function normalizeM5Case(value) {
  const item = value?.case ?? value;
  if (!item || typeof item !== 'object' || Array.isArray(item) || !item.id) {
    throw new Error('Paperclip Publisher Case 结构无效。');
  }
  return {
    ...item,
    fields:item.fields && typeof item.fields === 'object' ? item.fields : {},
    stageKey:item.stageKey || value?.stage?.key || item.stage?.key || null,
    pipelineId:item.pipelineId || value?.pipeline?.id || item.pipeline?.id || null,
    projectId:item.projectId || value?.pipeline?.projectId || item.pipeline?.projectId || null,
  };
}

function publisherIssueCaseId(issue) {
  const value = String(issue?.description || '').match(
    /当前 Case 为 ([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/i,
  )?.[1];
  if (!value) throw new Error('Publisher 系统任务缺少固定 Case 绑定。');
  return value;
}

function assertPublisherAuthorizationId(input, credential) {
  const value = publisherReference(
    input.authorizationId,
    'Publisher authorizationId 无效。',
  );
  if (input.action === 'publisher.publish') {
    if (value !== `paperclip:${credential.runId}:${credential.issueId}:publisher.publish`) {
      throw new Error('Publisher 发布授权标识与当前 Run 不一致。');
    }
    return;
  }
  if (input.action === 'publisher.read_own_metrics') {
    const prefix = `paperclip:${credential.runId}:${credential.issueId}:publisher.read_own_metrics:`;
    if (!value.startsWith(prefix) || !['2h', '24h', '72h'].includes(value.slice(prefix.length))) {
      throw new Error('Publisher 指标授权标识与当前 Run 或检查点不一致。');
    }
    return;
  }
  if (
    input.action !== 'publisher.reconcile_stale_attempt'
    || !credential.approvalId
    || value !== `paperclip:approval:${credential.approvalId}:metric-recovery`
  ) {
    throw new Error('Publisher 恢复授权标识与当前 Paperclip Approval 不一致。');
  }
}

function normalizePublisherConnectorApproval(value) {
  const payload = value?.payload;
  if (
    !UUID.test(String(value?.id || ''))
    || !payload
    || typeof payload !== 'object'
    || Array.isArray(payload)
    || payload.governanceKind !== PUBLISHER_APPROVAL_KIND
  ) return null;
  try {
    const platform = publisherPlatform(payload.platform);
    const capability = publisherCapability(payload.capability || 'publish');
    const connectorKind = String(payload.connectorKind || '');
    if (
      !['douyin_official_api', 'cua', 'xhs_own_metrics_cua'].includes(connectorKind)
      || (capability === 'publish' && connectorKind === 'xhs_own_metrics_cua')
      || (
        capability === 'read_own_metrics'
        && !['douyin_official_api', 'xhs_own_metrics_cua'].includes(connectorKind)
      )
    ) return null;
    const expiresAt = validClock(payload.expiresAt).toISOString();
    const approval = {
      id:value.id,
      campaignId:publisherReference(payload.campaignId, 'Campaign 无效。'),
      platform,
      capability,
      connectorKind,
      accountRef:publisherReference(payload.accountRef, 'accountRef 无效。'),
      expiresAt,
    };
    if (payload.secretKey != null) approval.secretKey = String(payload.secretKey);
    if (payload.providerIdentity != null) {
      approval.providerIdentity = publisherIdentity(payload.providerIdentity);
    }
    return approval;
  } catch {
    return null;
  }
}

function uniquePublisherApproval(approvals, expected) {
  const rows = approvals.filter((approval) => (
    approval.platform === expected.platform
    && approval.capability === expected.capability
    && approval.accountRef === expected.accountRef
  ));
  if (rows.length !== 1) {
    throw new Error('Paperclip Publisher connector 批准缺失或不唯一。');
  }
  return rows[0];
}

function parsePublisherCredential(value) {
  if (typeof value !== 'string' || value.length < 2 || value.length > 64_000) {
    throw new Error('Paperclip Publisher Secret 不是受支持的结构化凭据。');
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Paperclip Publisher Secret 不是受支持的结构化凭据。');
  }
  assertExactKeys(parsed, ['accessToken', 'openId'], 'Publisher Secret');
  const accessToken = String(parsed.accessToken || '').trim();
  const openId = String(parsed.openId || '').trim();
  if (!accessToken || accessToken.length > 16_384 || !openId || openId.length > 1_024) {
    throw new Error('Paperclip Publisher Secret 缺少受支持的账号凭据字段。');
  }
  return Object.freeze({ accessToken, openId });
}

function publisherIdentity(value) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).some((key) => !['kind', 'value'].includes(key))
    || value.kind !== 'open_id_sha256'
    || !/^sha256:[0-9a-f]{64}$/.test(String(value.value || ''))
  ) {
    throw new Error('Publisher 平台账号身份哈希无效。');
  }
  return Object.freeze({ kind:value.kind, value:value.value });
}

function samePublisherIdentity(left, right) {
  return left?.kind === right?.kind && left?.value === right?.value;
}

function publisherPlatform(value) {
  const platform = String(value || '');
  if (!['douyin', 'xiaohongshu'].includes(platform)) {
    throw new Error('Publisher 平台无效。');
  }
  return platform;
}

function publisherCapability(value) {
  const capability = String(value || '');
  if (!['publish', 'read_own_metrics'].includes(capability)) {
    throw new Error('Publisher connector 能力无效。');
  }
  return capability;
}

function publisherReference(value, message) {
  const normalized = String(value || '').trim();
  if (!PUBLISHER_REFERENCE.test(normalized)) throw new Error(message);
  return normalized;
}

function publisherAuthorizationRecord(value) {
  return value?.schemaVersion === PUBLISHER_AUTHORIZATION_SCHEMA ? value : null;
}

function samePublisherAuthorization(left, right) {
  return [
    'schemaVersion',
    'action',
    'authorizationId',
    'runId',
    'issueId',
    'agentId',
    'campaignId',
  ].every((field) => left?.[field] === right?.[field]);
}

function publisherCostRecord(value) {
  return value?.schemaVersion === PUBLISHER_COST_RECORD_SCHEMA ? value : null;
}

function samePublisherCost(left, right) {
  return [
    'schemaVersion',
    'costRecordId',
    'campaignId',
    'connectorMode',
    'operation',
    'sourceRef',
    'amountUsd',
    'occurredAt',
  ].every((field) => left?.[field] === right?.[field]);
}

function boundedRecordMap(existing, key, value) {
  const entries = Object.entries(
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? existing
      : {},
  ).filter(([entryKey]) => entryKey !== key).slice(-63);
  return Object.fromEntries([...entries, [key, value]]);
}

function integerVersion(value) {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 0) {
    throw new Error('Paperclip Publisher Case 缺少可用于原子写入的版本号。');
  }
  return version;
}

function validClock(value) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Publisher 时间无效。');
  return date;
}

function assertExactKeys(value, allowedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}必须是结构化对象。`);
  }
  const extra = Object.keys(value).find((key) => !allowedKeys.includes(key));
  if (extra) throw new Error(`${label}包含未授权字段 ${extra}。`);
}

function describeProposal(proposal) {
  return [
    '由飞书/A君创建入口生成的 Agent 草案。此条仅用于组织级审核；不包含原始聊天、凭据、Cookie 或业务素材。',
    `草案 ID：${proposal.proposalId}`,
    `候选岗位：${proposal.candidateManifest.name}（${proposal.candidateManifest.agentId}）`,
    `目标：${proposal.requestedOutcome}`,
    `能力：${proposal.requestedCapabilities.join('、') || '无外部能力'}`,
    `Skills：${proposal.desiredSkills.join('、') || '无'}`,
    `验收：${proposal.acceptanceTask.title}`
  ].join('\n\n');
}

function issueStatusFor(status) { return ({ running:'backlog', pausing:'backlog', paused:'blocked', succeeded:'done', failed:'blocked', cancelled:'blocked', expired:'blocked', needs_input:'blocked', waiting_approval:'blocked', waiting_test:'blocked' })[status] || 'backlog'; }
function safeError(error) { return String(error?.message || 'Paperclip 暂不可用。').slice(0, 240); }

function paperclipRosterEntry(manifest) {
  const hermesOwned = usesPaperclipHermesExecution(manifest);
  return {
    name:manifest.name,
    role:paperclipRoleFor(manifest),
    title:manifest.role,
    icon:paperclipIconFor(manifest),
    capabilities:(manifest.responsibilities || []).join('；') || manifest.role,
    adapterType:hermesOwned ? 'hermes_local' : 'http',
    adapterConfig:hermesOwned ? paperclipHermesAdapterConfig(manifest) : {},
    budgetMonthlyCents:0,
    permissions:{ canCreateAgents:false, canCreateSkills:false, canAssignTasks:false },
    metadata:{
      agentArmyId:manifest.agentId,
      agentArmyRole:manifest.role,
      agentArmyManagedOnly:true,
      executionOwner:manifest.executionOwner || 'ajun-local',
      hermesProfileId:hermesOwned ? manifest.agentId : null
    }
  };
}

function paperclipRoleFor(manifest) {
  const agentId = manifest?.agentId;
  if (manifest?.acceptedTaskTypes?.includes('report.public-material')) return 'researcher';
  return ({ creator:'pm', reviewer:'security', architect:'cto', xiaod:'researcher', operator:'devops', 'technical-expert':'engineer' })[agentId] || 'general';
}

function paperclipIconFor(manifest) {
  const agentId = manifest?.agentId;
  if (manifest?.acceptedTaskTypes?.includes('report.public-material')) return 'search';
  return ({ creator:'sparkles', reviewer:'shield', architect:'brain', xiaod:'file-code', operator:'cog', 'technical-expert':'wrench' })[agentId] || 'bot';
}

function rosterNeedsRefresh(current, manifest) {
  const desired = paperclipRosterEntry(manifest);
  const hermesOwned = usesPaperclipHermesExecution(manifest);
  if (!hermesOwned && current.metadata?.agentArmyManagedOnly !== true) return false;
  return current.name !== desired.name
    || current.role !== desired.role
    || current.title !== desired.title
    || current.icon !== desired.icon
    || current.capabilities !== desired.capabilities
    || (hermesOwned && current.adapterType !== desired.adapterType)
    || (hermesOwned && stableJson(current.adapterConfig || {}) !== stableJson(desired.adapterConfig || {}))
    || current.metadata?.agentArmyRole !== desired.metadata.agentArmyRole
    || current.metadata?.executionOwner !== desired.metadata.executionOwner
    || current.metadata?.hermesProfileId !== desired.metadata.hermesProfileId
    || (['paused', 'error'].includes(current.status) && usesPaperclipHermesExecution(manifest));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function requiredIdentifier(value, message) {
  const identifier = String(value || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(identifier)) throw new Error(message);
  return identifier;
}

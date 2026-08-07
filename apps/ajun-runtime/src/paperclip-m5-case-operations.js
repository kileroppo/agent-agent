import {
  m5CaseProjectId,
} from './paperclip-publisher-contract.js';

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

export const paperclipM5CaseMethods = {
  async getPipelineCaseOutputs(caseId) {
    return this.request(`/api/cases/${encodeURIComponent(caseId)}/outputs`);
  },

  async getPipelineCase(caseId) {
    return this.request(`/api/cases/${encodeURIComponent(caseId)}`);
  },

  async getPipelineCaseEvents(caseId) {
    return this.request(`/api/cases/${encodeURIComponent(caseId)}/events?limit=100&order=desc`);
  },

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
  },

  async reopenM5StageIssue(issueId, { runId, comment } = {}) {
    return this.request(`/api/issues/${encodeURIComponent(issueId)}`, {
      method:'PATCH',
      runId,
      body:{
        status:'todo',
        comment,
      },
    });
  },

  async blockM5StageIssue(issueId, { runId, comment } = {}) {
    return this.request(`/api/issues/${encodeURIComponent(issueId)}`, {
      method:'PATCH',
      runId,
      body:{
        status:'blocked',
        comment,
      },
    });
  },

  async completeM5RecoveredStageIssue(issueId, { runId, comment } = {}) {
    return this.request(`/api/issues/${encodeURIComponent(issueId)}`, {
      method:'PATCH',
      runId,
      body:{
        status:'done',
        comment,
      },
    });
  },

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
  },

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
  },

  async transitionPipelineCase(caseId, payload, { runId } = {}) {
    return this.request(`/api/cases/${encodeURIComponent(caseId)}/transition`, {
      method:'POST',
      runId,
      body:payload,
    });
  },

  async assertCaseIssueLink(caseId, issueId) {
    const rows = await this.request(`/api/cases/${encodeURIComponent(caseId)}/issue-links`);
    const links = Array.isArray(rows) ? rows : Array.isArray(rows?.items) ? rows.items : [];
    if (!links.some((item) => (item.issue?.id || item.issueId) === issueId)) {
      throw new Error('M5 系统控制器任务与声明的 Pipeline Case 没有关联。');
    }
    return { caseId, issueId };
  },

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
  },

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
};

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

function requiredIdentifier(value, message) {
  const identifier = String(value || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(identifier)) throw new Error(message);
  return identifier;
}

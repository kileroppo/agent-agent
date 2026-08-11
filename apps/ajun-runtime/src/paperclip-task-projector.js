import { PaperclipOrganizationClient } from '@agent-army/paperclip-client';

const COMPANY_NAME = 'Agent军团';
const REVIEW_SUBJECT_MARKER = '[agent-army:review-subject:v1]';

export class PaperclipTaskProjector {
  constructor({ endpoint, clock = () => new Date() } = {}) {
    this.client = new PaperclipOrganizationClient({ endpoint });
    this.clock = clock;
    this.company = null;
  }

  async project(task, approval) {
    try {
      const company = await this.companyForRuntime();
      const deterministicPresentation = task.taskType === 'office.presentation-package';
      const managedAgent = task.assigneeAgentId
        ? await this.managedAgent(task.assigneeAgentId, company.id)
        : null;
      const issue = await this.client.createIssue(company.id, {
        title:task.input.title,
        description:describeTask(task),
        status:approval
          ? 'blocked'
          : deterministicPresentation
            ? 'backlog'
            : managedAgent
              ? 'todo'
              : 'backlog',
        priority:priorityFor(task.priority),
        ...(task.taskType === 'operations.technical-repair' && managedAgent?.metadata?.paperclipProjectId
          ? { projectId:managedAgent.metadata.paperclipProjectId }
          : {}),
        ...(managedAgent && !deterministicPresentation ? { assigneeAgentId:managedAgent.id } : {}),
      });
      const result = {
        status:'synced',
        paperclipIssueId:issue.id,
        paperclipIssueIdentifier:issue.identifier,
        ...(managedAgent && !deterministicPresentation ? {
          paperclipAssigneeAgentId:managedAgent.id,
          paperclipAssigneeName:managedAgent.name,
        } : {}),
        syncedAt:this.clock().toISOString(),
      };
      if (approval) {
        const governanceApproval = await this.client.createApproval(company.id, {
          type:'request_board_approval',
          issueIds:[issue.id],
          payload:{
            source:'ajun-runtime',
            taskId:task.taskId,
            action:approval.action,
            riskLevel:approval.riskLevel,
            reason:approval.reason,
            requestedScope:approval.requestedScope,
          },
        });
        result.paperclipApprovalId = governanceApproval.id;
      }
      return result;
    } catch (error) {
      return { status:'sync_pending', reason:safeError(error), syncedAt:this.clock().toISOString() };
    }
  }

  async projectChild(task, parentIssueId) {
    try {
      const company = await this.companyForRuntime();
      const managedAgent = task.assigneeAgentId
        ? await this.managedAgent(task.assigneeAgentId, company.id)
        : null;
      const issue = await this.client.createChildIssue(parentIssueId, {
        title:task.input.title,
        description:describeTask(task),
        status:'todo',
        priority:priorityFor(task.priority),
        blockParentUntilDone:true,
        ...(managedAgent ? { assigneeAgentId:managedAgent.id } : {}),
      });
      return {
        status:'synced',
        paperclipIssueId:issue.id,
        paperclipIssueIdentifier:issue.identifier,
        paperclipParentIssueId:parentIssueId,
        ...(managedAgent ? {
          paperclipAssigneeAgentId:managedAgent.id,
          paperclipAssigneeName:managedAgent.name,
        } : {}),
        syncedAt:this.clock().toISOString(),
      };
    } catch (error) {
      return {
        status:'sync_pending',
        paperclipParentIssueId:parentIssueId,
        reason:safeError(error),
        syncedAt:this.clock().toISOString(),
      };
    }
  }

  async companyForRuntime() {
    if (this.company) return this.company;
    const companies = await this.client.listCompanies();
    const company = companies.find((item) => item.name === COMPANY_NAME);
    if (!company) throw new Error(`Paperclip 中未找到“${COMPANY_NAME}”组织。`);
    this.company = company;
    return company;
  }

  async managedAgent(agentArmyId, companyId = null) {
    const company = companyId ? { id:companyId } : await this.companyForRuntime();
    const agents = await this.client.listAgents(company.id);
    return agents.find((agent) =>
      agent.metadata?.agentArmyId === agentArmyId && agent.status !== 'terminated') || null;
  }
}

function describeTask(task) {
  const parts = [
    '由 A君运行台创建的过渡任务投影。正式军团任务由 Paperclip 统一调度；A君只执行本机业务适配。',
    `A君任务 ID：${task.taskId}`,
    `任务类型：${task.taskType}`,
    `运行时状态：${task.status}`,
    `承接岗位：${task.assigneeAgentId || '待路由'}`,
  ];
  if (task.input.description) parts.push(`说明：${task.input.description}`);
  const context = task.input?.context;
  if (task.taskType === 'governance.approval-review') {
    const reviewSubject = safeReviewSubject(context);
    if (reviewSubject) parts.push(`${REVIEW_SUBJECT_MARKER}\n${JSON.stringify(reviewSubject)}`);
  }
  if (context?.failure) {
    parts.push([
      '脱敏故障信息：',
      `代码：${String(context.failure.code || 'unknown')}`,
      `阶段：${String(context.failure.stage || 'unknown')}`,
      `类别：${String(context.failure.category || 'manual')}`,
      `是否允许安全重试：${context.failure.retryable === true ? '是' : '否'}`,
    ].join('\n'));
  }
  if (task.taskType === 'operations.technical-repair') {
    parts.push('工程要求：先复现和定位；只能修改当前项目；必须运行相关测试；没有证据不得宣称修好；禁止读取凭据、登录、外发、付费、扩权或发布。');
  }
  return parts.join('\n\n');
}

function safeReviewSubject(context) {
  const root = plainObject(context);
  const nested = plainObject(root.reviewSubject || root.proposal || root.candidate);
  const manifest = plainObject(nested.candidateManifest || root.candidateManifest);
  const source = Object.keys(nested).length ? nested : root;
  const result = {};
  const scope = safeScope(source.scope ?? root.scope);
  const dataScopes = safeDataScopes(source.dataScopes ?? manifest.dataScopes ?? root.dataScopes);
  const toolAllowlist = safeStrings(source.toolAllowlist ?? manifest.toolAllowlist ?? root.toolAllowlist, 20, 120);
  const budget = safeBudget(source.budget ?? source.budgetPolicy ?? manifest.budgetPolicy ?? root.budget ?? root.budgetPolicy);
  const validUntil = safeText(source.validUntil ?? root.validUntil, 80);
  const externalSideEffects = safeStrings(source.externalSideEffects ?? root.externalSideEffects, 12, 120);
  const capabilityAudit = safeCapabilityAudit(source.capabilityAudit ?? source.capabilityAudits ?? root.capabilityAudit ?? root.capabilityAudits);
  const approvalPolicies = safeApprovalPolicies(source.approvalPolicies ?? manifest.approvalPolicies ?? root.approvalPolicies);
  if (scope) result.scope = scope;
  if (dataScopes.length) result.dataScopes = dataScopes;
  if (toolAllowlist.length) result.toolAllowlist = toolAllowlist;
  if (budget) result.budget = budget;
  if (validUntil) result.validUntil = validUntil;
  if (externalSideEffects.length) result.externalSideEffects = externalSideEffects;
  if (capabilityAudit.length) result.capabilityAudit = capabilityAudit;
  if (approvalPolicies.length) result.approvalPolicies = approvalPolicies;
  return Object.keys(result).length ? result : null;
}

function safeScope(value) {
  if (typeof value === 'string') return safeText(value, 500) || null;
  const scope = plainObject(value);
  const result = {};
  for (const key of ['goal', 'outcome', 'description', 'boundary', 'deliverable']) {
    const text = safeText(scope[key], 500);
    if (text) result[key] = text;
  }
  const constraints = safeStrings(scope.constraints, 12, 300);
  if (constraints.length) result.constraints = constraints;
  return Object.keys(result).length ? result : null;
}

function safeDataScopes(value) {
  return asArray(value).slice(0, 12).flatMap((item) => {
    const row = plainObject(item);
    const scope = safeText(row.scope, 120);
    const access = safeStrings(row.access, 8, 40);
    const boundary = safeText(row.boundary, 500);
    return scope && access.length && boundary ? [{ scope, access, boundary }] : [];
  });
}

function safeBudget(value) {
  const source = plainObject(value);
  const result = {};
  for (const key of ['maxRuns', 'maxModelCalls', 'maxTokens', 'maxWallClockSeconds', 'maxCostUsd']) {
    const number = Number(source[key]);
    if (Number.isFinite(number) && number >= 0) result[key] = number;
  }
  if (typeof source.externalSpendAllowed === 'boolean') result.externalSpendAllowed = source.externalSpendAllowed;
  return Object.keys(result).length ? result : null;
}

function safeCapabilityAudit(value) {
  return asArray(value).slice(0, 20).flatMap((item) => {
    const row = plainObject(item);
    const capabilityId = safeText(row.capabilityId || row.capability || row.toolId, 120);
    const status = safeText(row.status || row.result, 40);
    return capabilityId && status ? [{ capabilityId, status }] : [];
  });
}

function safeApprovalPolicies(value) {
  return asArray(value).slice(0, 12).flatMap((item) => {
    const row = plainObject(item);
    const action = safeText(row.action || row.sideEffect, 120);
    const riskLevel = safeText(row.riskLevel, 40);
    const decision = safeText(row.decision || row.result, 80);
    return action && decision ? [{ action, ...(riskLevel ? { riskLevel } : {}), decision }] : [];
  });
}

function safeStrings(value, limit, maxLength) {
  return [...new Set(asArray(value).map((item) => safeText(
    typeof item === 'string' ? item : item?.id || item?.name,
    maxLength,
  )).filter(Boolean))].slice(0, limit);
}

function safeText(value, maxLength) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function priorityFor(priority) {
  return ({ low:'low', high:'high', urgent:'urgent' })[priority] || 'medium';
}

function safeError(error) {
  return String(error?.message || 'Paperclip 暂不可用。').slice(0, 240);
}

import { createHash } from 'node:crypto';

import { asPaperclipList, validDate } from './paperclip-loopback-client.mjs';

const ROUTINE_TITLE = 'A君定时本机巡检';
const ROUTINE_MARKER = 'agent-army:operations-health-v2';
const ARCHIVE_ROUTINE_MARKER = 'agent-army:operations-health-v1';
const ROUTINE_CONTRACT_MARKER = '[agent-army:operations-health:routine]';
const ROUTINE_MARKER_PATTERN = /agent-army:operations-health-v\d+/;
const CONTROLLER_ROLE = 'operations-health-controller';
const CONTROLLER_URL = 'http://127.0.0.1:4321/api/paperclip/heartbeat';
const TRIGGER_LABEL = '每半小时巡检一次';
const TRIGGER_CRON = '*/30 * * * *';
const TRIGGER_TIMEZONE = 'Asia/Shanghai';
const PAGE_SIZE = 200;
const MAX_PENDING_ITEMS = 5000;
const PENDING_STATUSES = ['blocked', 'in_review', 'todo', 'backlog'];
const RULES_VERSION = 'paperclip-blocked-pending-v1';
const ARCHIVE_PLAN_VERSION = 'paperclip-historical-acceptance-archive-v1';
const ARCHIVE_CONFIRM_PREFIX = 'ARCHIVE:';
const HEALTH_ARCHIVE_CONFIRM_PREFIX = 'ARCHIVE_OPERATIONS_HEALTH:';
const MAX_ARCHIVE_ITEMS = 25;
const HISTORICAL_AFTER_MS = 24 * 60 * 60 * 1000;
const CLASSIFIER_LIST_ENVELOPES = ['items', 'actions'];

const ACCEPTANCE_PATTERN = /(?:验收|回归|测试|演练|沙箱|合成数据|acceptance|regression|test(?:ing)?|drill|sandbox|synthetic|dry[\s_-]?run|canary)/i;
const INCIDENT_PATTERN = /(?:故障|事故|失败|异常|崩溃|超时|不可用|恢复|incident|outage|failure|failed|error|crash|timeout|unavailable|recovery)/i;
const DECISION_PATTERN = /(?:待审批|待审核|待确认|需决定|需要决定|人工决定|approval|decision[\s_-]?required|human[\s_-]?review)/i;
const LIVE_EXECUTION_STATES = new Set(['queued', 'running', 'in_progress', 'active', 'retrying', 'recovering']);

export class PaperclipOperationsHealthCatalog {
  constructor({ client = null, companyName = 'Agent军团', pageSize = PAGE_SIZE } = {}) {
    if (!Number.isInteger(pageSize) || pageSize <= 0) {
      throw new Error('Paperclip issue pageSize 必须是正整数');
    }
    this.client = client;
    this.companyName = companyName;
    this.pageSize = pageSize;
  }

  get routine() {
    return {
      title: ROUTINE_TITLE,
      marker: ROUTINE_MARKER,
      archiveMarker: ARCHIVE_ROUTINE_MARKER,
      contractMarker: ROUTINE_CONTRACT_MARKER,
    };
  }

  get pendingStatuses() {
    return [...PENDING_STATUSES];
  }

  get rulesVersion() {
    return RULES_VERSION;
  }

  list(payload, envelopeKeys = ['items']) {
    return asPaperclipList(payload, envelopeKeys);
  }

  async requireCompany(envelopeKeys = ['items']) {
    const companies = this.list(
      await this.requireClient().request('GET', '/api/companies'),
      envelopeKeys,
    );
    const company = companies.find((item) => item.name === this.companyName);
    if (!company) throw new Error(`Paperclip 中未找到公司：${this.companyName}`);
    if (!company.id) throw new Error('companyId 必填');
    return company;
  }

  controllerBody() {
    return {
      name: '本机健康确定性控制器',
      role: 'devops',
      title: '每半小时执行登记服务的无模型只读健康检查',
      icon: 'radar',
      capabilities: '无模型、无自由参数；只读检查登记的本机健康接口，异常时才派发运维事故。',
      adapterType: 'http',
      adapterConfig: { url: CONTROLLER_URL },
      budgetMonthlyCents: 0,
      permissions: { canCreateAgents:false, canCreateSkills:false, canAssignTasks:false },
      metadata: {
        agentArmySystemRole: CONTROLLER_ROLE,
        agentArmyManagedOnly: false,
        executionOwner: 'ajun-runtime-deterministic',
      },
    };
  }

  findController(agents) {
    const matching = this.list(agents).filter((agent) =>
      agent.status !== 'terminated' && agent.metadata?.agentArmySystemRole === CONTROLLER_ROLE
    );
    if (matching.length > 1) {
      throw new Error(`Paperclip 本机健康控制器必须唯一，当前为 ${matching.length} 个。`);
    }
    return matching[0] ?? null;
  }

  controllerNeedsUpdate(current, desired = this.controllerBody()) {
    return current.status !== 'idle'
      || current.adapterType !== desired.adapterType
      || current.adapterConfig?.url !== desired.adapterConfig.url
      || current.metadata?.executionOwner !== desired.metadata.executionOwner;
  }

  routineBody(controllerId) {
    return {
      title: ROUTINE_TITLE,
      description: `${ROUTINE_MARKER}\n${ROUTINE_CONTRACT_MARKER}\n由无模型 HTTP 控制器只读检查 A君、小D 与 Paperclip 的本机运行状态；正常时不调用任何大模型。只有发现异常时才幂等派发运维事故；不登录、不外发、不修改业务数据。`,
      assigneeAgentId: controllerId,
      priority: 'low',
      status: 'active',
      concurrencyPolicy: 'skip_if_active',
      catchUpPolicy: 'skip_missed',
    };
  }

  findRoutine(routines) {
    return this.list(routines).find((item) =>
      item.title === ROUTINE_TITLE || ROUTINE_MARKER_PATTERN.test(String(item.description || ''))
    ) ?? null;
  }

  triggerBody() {
    return {
      label: TRIGGER_LABEL,
      enabled: true,
      cronExpression: TRIGGER_CRON,
      timezone: TRIGGER_TIMEZONE,
    };
  }

  findTrigger(triggers) {
    return this.list(triggers).find((item) =>
      item.kind === 'schedule'
      && (item.label === TRIGGER_LABEL || item.cronExpression === TRIGGER_CRON)
    ) ?? null;
  }

  async listIssues({
    companyId,
    statuses,
    maxItems = Number.POSITIVE_INFINITY,
    sortField = 'updated',
    sortDir = 'desc',
    envelopeKeys = ['items'],
  }) {
    if (!companyId) throw new Error('companyId 必填');
    if (!Array.isArray(statuses) || statuses.length === 0 || statuses.some((status) => !status)) {
      throw new Error('Paperclip issue statuses 必须是非空列表');
    }
    if (!(maxItems > 0)) throw new Error('Paperclip issue maxItems 必须大于 0');
    const items = [];
    while (items.length < maxItems) {
      const remaining = maxItems - items.length;
      const pageSize = Number.isFinite(remaining)
        ? Math.min(this.pageSize, remaining)
        : this.pageSize;
      const query = new URLSearchParams({
        status: statuses.join(','),
        limit: String(pageSize),
        offset: String(items.length),
        sortField,
        sortDir,
      });
      const page = this.list(
        await this.requireClient().request(
          'GET',
          `/api/companies/${encodeURIComponent(companyId)}/issues?${query}`,
        ),
        envelopeKeys,
      );
      items.push(...page);
      if (page.length < pageSize || page.length === 0) {
        return { items, possiblyTruncated:false };
      }
    }
    return { items, possiblyTruncated:true };
  }

  normalizePendingLimit(value) {
    const number = Number(value);
    if (!Number.isInteger(number) || number <= 0) throw new Error('limit 必须是正整数');
    return Math.min(number, MAX_PENDING_ITEMS);
  }

  classifyIssue(issue, { agentsById = new Map(), now = new Date() } = {}) {
    if (!issue?.id) throw new Error('issue.id 必填');
    const normalizedNow = normalizeDate(now, 'now');
    const titleText = stringifyForMatch(issue.title);
    const classificationText = [issue.title, issue.originKind]
      .filter(Boolean)
      .map(stringifyForMatch)
      .join(' ');
    const pendingApproval = issue.status === 'in_review' || DECISION_PATTERN.test(titleText);
    const activeRecovery = issue.activeRecoveryAction ?? null;
    const liveExecution = hasLiveExecutionState(issue.executionState);
    const fresh = isFresh(issue.updatedAt ?? issue.createdAt, normalizedNow);
    const incidentSignal = Boolean(activeRecovery)
      || liveExecution
      || (issue.status === 'blocked' && fresh && INCIDENT_PATTERN.test(titleText));
    const historicalAcceptance = !incidentSignal
      && ACCEPTANCE_PATTERN.test(classificationText)
      && !isFresh(issue.updatedAt ?? issue.createdAt, normalizedNow);

    let classification = 'unresolved';
    const evidence = [];
    if (pendingApproval) {
      classification = 'decision_required';
      evidence.push(issue.status === 'in_review' ? 'status_in_review' : 'explicit_decision_signal');
    } else if (incidentSignal) {
      classification = 'active_incident';
      if (activeRecovery) evidence.push('active_recovery_action');
      if (liveExecution) evidence.push('live_execution_state');
      if (!activeRecovery && !liveExecution) evidence.push('fresh_incident_signal');
    } else if (historicalAcceptance) {
      classification = 'historical_acceptance';
      evidence.push('acceptance_signal', 'inactive_over_24h');
    } else {
      evidence.push('no_active_recovery_or_decision_evidence');
    }

    const owner = resolveOwner(issue, activeRecovery, agentsById);
    return {
      issueId: issue.id,
      identifier: issue.identifier ?? null,
      title: redactDisplayText(issue.title ?? '(无标题)'),
      status: issue.status ?? 'unknown',
      classification,
      owner,
      recoveryAction: buildRecoveryAction(classification, owner),
      evidence,
      updatedAt: issue.updatedAt ?? null,
    };
  }

  buildHistoricalAcceptanceArchivePlan(classificationResult, { identifiers } = {}) {
    if (classificationResult?.mode !== 'dry-run' || classificationResult?.readOnly !== true) {
      throw new Error('归档计划只能基于只读 dry-run 结果生成');
    }
    const selected = normalizeIdentifiers(identifiers);
    if (selected.length > MAX_ARCHIVE_ITEMS) {
      throw new Error(`单次归档最多 ${MAX_ARCHIVE_ITEMS} 条，拒绝扩大批量范围`);
    }
    const byIdentifier = new Map(
      classificationResult.items.map((item) => [item.identifier, item]),
    );
    const items = selected.map((identifier) => {
      const item = byIdentifier.get(identifier);
      if (!item) throw new Error(`待归档 Issue 不在当前 blocked/pending 快照中：${identifier}`);
      if (item.classification !== 'historical_acceptance') {
        throw new Error(`只允许归档 historical_acceptance：${identifier} 当前为 ${item.classification}`);
      }
      if (item.status === 'in_review' || item.evidence.includes('active_recovery_action')) {
        throw new Error(`待归档 Issue 仍有审批或恢复信号：${identifier}`);
      }
      return {
        issueId: item.issueId,
        identifier: item.identifier,
        expectedStatus: item.status,
        expectedUpdatedAt: item.updatedAt,
        classification: item.classification,
        action: 'cancel_and_hide_from_pending',
      };
    });
    const digestValue = digest({
      planVersion: ARCHIVE_PLAN_VERSION,
      rulesVersion: classificationResult.rulesVersion,
      companyId: classificationResult.company.id,
      items,
    });
    return {
      mode: 'archive-plan',
      planVersion: ARCHIVE_PLAN_VERSION,
      rulesVersion: classificationResult.rulesVersion,
      generatedAt: classificationResult.generatedAt,
      company: classificationResult.company,
      items,
      digest: digestValue,
      requiredConfirmation: `${ARCHIVE_CONFIRM_PREFIX}${digestValue}`,
      safety: {
        explicitIdentifiersRequired: true,
        maxItems: MAX_ARCHIVE_ITEMS,
        deletesRecords: false,
        preservesCommentsAndIssueHistory: true,
        applyRequiresFreshSnapshotMatch: true,
      },
    };
  }

  buildOperationsHealthArchivePlan({ company, issues, minSuccessors }) {
    if (!company?.id) throw new Error('companyId 必填');
    if (!Array.isArray(issues)) throw new Error('Paperclip issues 必须是列表');
    if (!Number.isInteger(minSuccessors) || minSuccessors < 0) {
      throw new Error('minSuccessors 必须是非负整数');
    }
    const health = issues
      .filter((issue) => this.isOperationsHealthIssue(issue))
      .filter((issue) => !issue.hiddenAt)
      .sort((left, right) => timestamp(left.createdAt) - timestamp(right.createdAt));
    const items = health.flatMap((issue, index) => {
      if (issue.status === 'done') return [archiveItem(issue, 'completed_system_check')];
      if (issue.status !== 'blocked') return [];
      const laterSuccesses = health.slice(index + 1)
        .filter((candidate) => candidate.status === 'done').length;
      return laterSuccesses >= minSuccessors
        ? [archiveItem(issue, 'superseded_failure', { laterSuccesses })]
        : [];
    });
    const digestValue = digest({
      schemaVersion: 1,
      companyId: company.id,
      minSuccessors,
      items,
    });
    return {
      mode: 'plan',
      readOnly: true,
      company: { id:company.id, name:company.name },
      routine: { title:ROUTINE_TITLE, marker:ARCHIVE_ROUTINE_MARKER },
      minSuccessors,
      summary: {
        visibleHealthIssues: health.length,
        archiveCount: items.length,
        completedSystemChecks: items.filter((item) => item.reason === 'completed_system_check').length,
        supersededFailures: items.filter((item) => item.reason === 'superseded_failure').length,
        retainedFailures: health.filter((item) => item.status === 'blocked').length
          - items.filter((item) => item.reason === 'superseded_failure').length,
      },
      items,
      digest: digestValue,
      requiredConfirmation: `${HEALTH_ARCHIVE_CONFIRM_PREFIX}${digestValue}`,
      safety: {
        deletesRecords: false,
        changesIssueStatus: false,
        resolvesRecoveryActions: false,
        reversibleWithHiddenAtNull: true,
        failedOrRecentChecksRemainVisible: true,
      },
    };
  }

  isOperationsHealthIssue(issue) {
    return issue?.title === ROUTINE_TITLE
      && String(issue.description || '').includes(ARCHIVE_ROUTINE_MARKER);
  }

  requireClient() {
    if (!this.client) throw new Error('Paperclip client 必填');
    return this.client;
  }
}

function archiveItem(issue, reason, extra = {}) {
  return {
    issueId: String(issue.id),
    identifier: String(issue.identifier || ''),
    status: String(issue.status),
    expectedUpdatedAt: String(issue.updatedAt || ''),
    reason,
    ...extra,
  };
}

function timestamp(value) {
  const result = validDate(value);
  if (!result) throw new Error('Paperclip Issue 时间无效');
  return result.getTime();
}

function resolveOwner(issue, activeRecovery, agentsById) {
  if (activeRecovery?.ownerAgentId) return agentOwner(activeRecovery.ownerAgentId, agentsById, 'active_recovery_action');
  if (activeRecovery?.ownerUserId) return userOwner(activeRecovery.ownerUserId, 'active_recovery_action');
  if (issue.responsibleUserId) return userOwner(issue.responsibleUserId, 'responsible_user');
  if (issue.assigneeUserId) return userOwner(issue.assigneeUserId, 'assignee_user');
  if (issue.assigneeAgentId) return agentOwner(issue.assigneeAgentId, agentsById, 'assignee_agent');
  return { kind:'agent_role', id:'ajun', label:'A君（待分派）', source:'triage_fallback' };
}

function buildRecoveryAction(classification, owner) {
  const ownerLabel = owner.label;
  const actions = {
    historical_acceptance: {
      code: 'review_historical_acceptance',
      instruction: `${ownerLabel} 对照原验收证据确认“已完成”或“需要重测”，只提交处置结论，不归档、不删除。`,
    },
    active_incident: {
      code: 'inspect_active_recovery',
      instruction: `${ownerLabel} 核对最新运行与恢复证据，只选择一次安全恢复或升级技术专家，不自动重试。`,
    },
    decision_required: {
      code: 'complete_pending_decision',
      instruction: `${ownerLabel} 完成当前审批或人工决定；决定前保持任务、权限和状态不变。`,
    },
    unresolved: {
      code: 'assign_owner_and_one_action',
      instruction: `${ownerLabel} 指定唯一执行负责人和一个可验证恢复动作；本次 dry-run 不改变状态。`,
    },
  };
  return { ...actions[classification], writesLive:false };
}

function agentOwner(agentId, agentsById, source) {
  const agent = agentsById.get(agentId);
  return {
    kind: 'agent',
    id: agentId,
    label: redactDisplayText(agent?.name ?? `Agent ${shortId(agentId)}`),
    source,
  };
}

function userOwner(userId, source) {
  return { kind:'user', id:userId, label:`负责人 ${shortId(userId)}`, source };
}

function normalizeDate(value, field) {
  const result = validDate(value);
  if (!result) throw new Error(`${field} 必须是有效时间`);
  return result;
}

function isFresh(value, now) {
  if (!value) return false;
  const date = validDate(value);
  if (!date) return false;
  const age = now.getTime() - date.getTime();
  return age >= 0 && age < HISTORICAL_AFTER_MS;
}

function stringifyForMatch(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value) ?? ''; } catch { return ''; }
}

function hasLiveExecutionState(value) {
  if (!value) return false;
  if (typeof value === 'string') return LIVE_EXECUTION_STATES.has(value.trim().toLowerCase());
  if (typeof value !== 'object') return false;
  return [value.status, value.state, value.runStatus, value.executionStatus]
    .some((state) => typeof state === 'string' && LIVE_EXECUTION_STATES.has(state.trim().toLowerCase()));
}

function redactDisplayText(value) {
  return String(value)
    .replace(/\b(authorization|token|secret|password|cookie|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\/Users\/[^/\s]+/g, '/Users/[REDACTED]');
}

function shortId(value) {
  const text = String(value);
  return text.length > 8 ? text.slice(0, 8) : text;
}

function normalizeIdentifiers(value) {
  const items = Array.isArray(value) ? value : String(value ?? '').split(',');
  const normalized = items.map((item) => String(item).trim()).filter(Boolean);
  if (normalized.length === 0) throw new Error('必须显式提供至少一个 Issue identifier');
  if (new Set(normalized).size !== normalized.length) throw new Error('Issue identifier 不得重复');
  if (normalized.some((item) => !/^[A-Za-z][A-Za-z0-9_-]*-\d+$/.test(item))) {
    throw new Error('Issue identifier 格式无效');
  }
  return normalized;
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

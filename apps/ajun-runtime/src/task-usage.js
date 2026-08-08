const MAX_TOOL_CALLS = 10_000;

export function recordTaskUsage({ task, result, startedAt, finishedAt = new Date() } = {}) {
  const reported = result?.usage || {};
  const started = asDate(startedAt || task?.execution?.startedAt);
  const finished = asDate(finishedAt) || new Date();
  return {
    schemaVersion: 'agent.army/task-usage/v1',
    recordedAt: finished.toISOString(),
    execution: {
      executor: String(result?.execution?.executor || task?.assigneeAgentId || task?.execution?.executor || 'unknown'),
      durationMs: started ? Math.max(0, finished.getTime() - started.getTime()) : null,
      outcome: String(result?.execution?.outcome || result?.status || 'unknown')
    },
    tools: normalizeTools(reported.tools),
    model: normalizeModel(reported.model),
    cost: normalizeCost(reported.cost || reported.model?.cost)
  };
}

export function summarizeTaskUsage(tasks, { since = null } = {}) {
  const after = asDate(since);
  const selected = (Array.isArray(tasks) ? tasks : []).filter((task) => {
    const recordedAt = asDate(task.usage?.recordedAt || task.updatedAt || task.createdAt);
    return !after || (recordedAt && recordedAt >= after);
  });
  const tracked = selected.filter((task) => task.usage?.schemaVersion === 'agent.army/task-usage/v1');
  const tools = new Map();
  let actualToolCalls = 0;
  let modelReportedTasks = 0;
  let modelApiCalls = 0;
  let modelInputTokens = 0;
  let modelOutputTokens = 0;
  const costByCurrency = new Map();
  let costReportedTasks = 0;
  for (const task of tracked) {
    const usage = task.usage;
    if (usage.model?.status === 'reported') {
      modelReportedTasks += 1;
      modelApiCalls += Number(usage.model.apiCalls || 0);
      modelInputTokens += Number(usage.model.inputTokens || 0);
      modelOutputTokens += Number(usage.model.outputTokens || 0);
    }
    for (const tool of usage.tools || []) {
      actualToolCalls += tool.calls;
      const current = tools.get(tool.id) || { id:tool.id, name:tool.name, calls:0 };
      current.calls += tool.calls;
      tools.set(tool.id, current);
    }
    if (usage.cost?.status === 'reported') {
      costReportedTasks += 1;
      costByCurrency.set(usage.cost.currency, (costByCurrency.get(usage.cost.currency) || 0) + usage.cost.amount);
    }
  }
  return {
    taskCount: selected.length,
    trackedTaskCount: tracked.length,
    actualToolCalls,
    tools: [...tools.values()].sort((left, right) => right.calls - left.calls),
    model: {
      reportedTaskCount:modelReportedTasks,
      notReportedTaskCount:tracked.length - modelReportedTasks,
      apiCalls:modelApiCalls,
      inputTokens:modelInputTokens,
      outputTokens:modelOutputTokens,
    },
    cost: { reportedTaskCount:costReportedTasks, totals:[...costByCurrency.entries()].map(([currency, amount]) => ({ currency, amount })) }
  };
}

export function reconcileUsageBilling(tasks, ledger, { since = null } = {}) {
  const after = asDate(since);
  const taskEntries = (Array.isArray(tasks) ? tasks : [])
    .filter((task) => task.usage?.schemaVersion === 'agent.army/task-usage/v1')
    .filter((task) => {
      const recordedAt = asDate(task.usage?.recordedAt || task.updatedAt || task.createdAt);
      return !after || (recordedAt && recordedAt >= after);
    })
    .filter((task) => task.usage?.model?.status === 'reported')
    .map(taskBillingEntry);
  const claimedLedgerRefs = new Set();
  const entries = (Array.isArray(ledger?.entries) ? ledger.entries : []).map((entry) => {
    const match = closestTaskUsageMatch(taskEntries, entry, claimedLedgerRefs);
    if (!match) return { ...entry, attribution:{ status:'unattributed' } };
    claimedLedgerRefs.add(entry.ledgerRef);
    match.ledgerRef = entry.ledgerRef;
    return {
      ...entry,
      attribution:{
        status:'task',
        taskId:match.taskId,
        taskTitle:match.taskTitle,
        taskRef:shortTaskRef(match.taskId),
      },
    };
  });
  return {
    schemaVersion:'agent.army/usage-billing-view/v1',
    status:String(ledger?.status || 'unavailable'),
    period:ledger?.period || null,
    totals:ledger?.totals || emptyLedgerTotals(),
    profiles:Array.isArray(ledger?.profiles) ? ledger.profiles : [],
    entries,
    attribution:{
      attributedEntryCount:entries.filter((entry) => entry.attribution.status === 'task').length,
      unattributedEntryCount:entries.filter((entry) => entry.attribution.status !== 'task').length,
      taskModelRecordCount:taskEntries.length,
      unmatchedTaskRecordCount:taskEntries.filter((entry) => !entry.ledgerRef).length,
    },
    taskEntries,
    limitations:Array.isArray(ledger?.limitations) ? ledger.limitations : [],
    unavailableProfiles:Array.isArray(ledger?.unavailableProfiles) ? ledger.unavailableProfiles : [],
    truncatedEntryCount:Number(ledger?.truncatedEntryCount || 0),
  };
}

function taskBillingEntry(task) {
  const usage = task.usage;
  return {
    taskId:String(task.taskId || ''),
    taskRef:shortTaskRef(task.taskId),
    taskTitle:String(task.input?.title || task.title || '未命名任务').replace(/\s+/g, ' ').trim().slice(0, 160),
    agentId:String(usage.execution?.executor || task.assigneeAgentId || '').trim(),
    recordedAt:String(usage.recordedAt || task.updatedAt || task.createdAt || ''),
    provider:usage.model.provider || null,
    model:usage.model.model || null,
    apiCalls:Number(usage.model.apiCalls || 0),
    inputTokens:Number(usage.model.inputTokens || 0),
    outputTokens:Number(usage.model.outputTokens || 0),
    cost:usage.cost,
    ledgerRef:null,
  };
}

function closestTaskUsageMatch(taskEntries, ledgerEntry, claimedLedgerRefs) {
  if (claimedLedgerRefs.has(ledgerEntry.ledgerRef)) return null;
  const occurredAt = Date.parse(ledgerEntry.occurredAt);
  const candidates = taskEntries.filter((task) => !task.ledgerRef
    && task.agentId === ledgerEntry.agentId
    && (!task.provider || task.provider === ledgerEntry.provider)
    && (!task.model || task.model === ledgerEntry.model)
    && task.apiCalls === Number(ledgerEntry.apiCalls || 0)
    && task.inputTokens === Number(ledgerEntry.tokens?.input || 0)
    && task.outputTokens === Number(ledgerEntry.tokens?.output || 0));
  candidates.sort((left, right) => Math.abs(Date.parse(left.recordedAt) - occurredAt) - Math.abs(Date.parse(right.recordedAt) - occurredAt));
  const match = candidates[0] || null;
  if (!match) return null;
  const distance = Math.abs(Date.parse(match.recordedAt) - occurredAt);
  return Number.isFinite(distance) && distance <= 15 * 60 * 1000 ? match : null;
}

function shortTaskRef(taskId) {
  const compact = String(taskId || '').replace(/[^0-9a-z]/gi, '').slice(0, 8).toUpperCase();
  return compact ? `#${compact}` : '#未编号';
}

function emptyLedgerTotals() {
  return {
    entryCount:0,
    sessionCount:0,
    apiCalls:0,
    tokens:{ input:0, output:0, cacheRead:0, cacheWrite:0, reasoning:0, total:0 },
    cost:{ actualUsd:0, estimatedUsd:0, knownUsd:0, actualEntryCount:0, estimatedEntryCount:0, includedEntryCount:0, unknownEntryCount:0 },
  };
}

function normalizeTools(value) {
  return (Array.isArray(value) ? value : []).map((tool) => {
    const id = String(tool?.id || '').trim().slice(0, 80);
    const name = String(tool?.name || id).trim().slice(0, 120);
    const calls = Math.max(0, Math.min(MAX_TOOL_CALLS, Number(tool?.calls || 0)));
    return id && calls ? { id, name:name || id, calls } : null;
  }).filter(Boolean);
}

function normalizeModel(value) {
  if (!value || typeof value !== 'object') return { status:'not_reported' };
  const inputTokens = nonNegativeInteger(value.inputTokens);
  const outputTokens = nonNegativeInteger(value.outputTokens);
  const apiCalls = nonNegativeInteger(value.apiCalls);
  if (inputTokens === null && outputTokens === null) return { status:'not_reported' };
  return {
    status:'reported',
    ...(String(value.provider || '').trim() ? { provider:String(value.provider).trim().slice(0, 80) } : {}),
    ...(String(value.model || '').trim() ? { model:String(value.model).trim().slice(0, 120) } : {}),
    ...(inputTokens !== null ? { inputTokens } : {}),
    ...(outputTokens !== null ? { outputTokens } : {}),
    ...(apiCalls !== null ? { apiCalls } : {})
  };
}

function normalizeCost(value) {
  if (!value || typeof value !== 'object') return { status:'not_reported' };
  const amount = Number(value.amount);
  const currency = String(value.currency || '').trim().toUpperCase();
  if (!Number.isFinite(amount) || amount < 0 || !currency || currency.length > 8) return { status:'not_reported' };
  return { status:'reported', amount, currency };
}

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value || 0);
  return Number.isNaN(date.getTime()) || date.getTime() === 0 ? null : date;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

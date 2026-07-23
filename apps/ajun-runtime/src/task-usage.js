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
  const costByCurrency = new Map();
  let costReportedTasks = 0;
  for (const task of tracked) {
    const usage = task.usage;
    if (usage.model?.status === 'reported') modelReportedTasks += 1;
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
    model: { reportedTaskCount:modelReportedTasks, notReportedTaskCount:tracked.length - modelReportedTasks },
    cost: { reportedTaskCount:costReportedTasks, totals:[...costByCurrency.entries()].map(([currency, amount]) => ({ currency, amount })) }
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
  if (inputTokens === null && outputTokens === null) return { status:'not_reported' };
  return {
    status:'reported',
    ...(String(value.provider || '').trim() ? { provider:String(value.provider).trim().slice(0, 80) } : {}),
    ...(String(value.model || '').trim() ? { model:String(value.model).trim().slice(0, 120) } : {}),
    ...(inputTokens !== null ? { inputTokens } : {}),
    ...(outputTokens !== null ? { outputTokens } : {})
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

const MAX_TOOL_CALLS: any = 10000;
export function recordTaskUsage({ task, result, startedAt, finishedAt = new Date() }: any = {}): any {
    const reported: any = result?.usage || {};
    const started: any = asDate(startedAt || task?.execution?.startedAt);
    const finished: any = asDate(finishedAt) || new Date();
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
        cost: normalizeCost(reported.cost || reported.model?.cost),
        attribution: normalizeTaskAttribution(task),
    };
}
export function summarizeTaskUsage(tasks: any, { since = null, until = null }: any = {}): any {
    const after: any = asDate(since);
    const before: any = asDate(until);
    const selected: any = (Array.isArray(tasks) ? tasks : []).filter((task: any): any => {
        const recordedAt: any = asDate(task.usage?.recordedAt || task.updatedAt || task.createdAt);
        return (!after || (recordedAt && recordedAt >= after))
            && (!before || (recordedAt && recordedAt < before));
    });
    const tracked: any = selected.filter((task: any): any => task.usage?.schemaVersion === 'agent.army/task-usage/v1');
    const tools: any = new Map();
    let actualToolCalls: any = 0;
    let modelReportedTasks: any = 0;
    let modelApiCalls: any = 0;
    let modelInputTokens: any = 0;
    let modelOutputTokens: any = 0;
    let modelCacheReadTokens: any = 0;
    let modelCacheWriteTokens: any = 0;
    let modelReasoningTokens: any = 0;
    let modelProviderAttempts: any = 0;
    let modelRateLimitRejections: any = 0;
    const costByCurrency: any = new Map();
    let costReportedTasks: any = 0;
    for (const task of tracked) {
        const usage: any = task.usage;
        if (usage.model?.status === 'reported') {
            modelReportedTasks += 1;
            modelApiCalls += Number(usage.model.apiCalls || 0);
            modelInputTokens += Number(usage.model.inputTokens || 0);
            modelOutputTokens += Number(usage.model.outputTokens || 0);
            modelCacheReadTokens += Number(usage.model.cacheReadTokens || 0);
            modelCacheWriteTokens += Number(usage.model.cacheWriteTokens || 0);
            modelReasoningTokens += Number(usage.model.reasoningTokens || 0);
            modelProviderAttempts += Number(usage.model.providerAttempts || 0);
            modelRateLimitRejections += Number(usage.model.rateLimitRejections || 0);
        }
        for (const tool of usage.tools || []) {
            actualToolCalls += tool.calls;
            const current: any = tools.get(tool.id) || { id: tool.id, name: tool.name, calls: 0 };
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
        tools: [...tools.values()].sort((left: any, right: any): any => right.calls - left.calls),
        model: {
            reportedTaskCount: modelReportedTasks,
            notReportedTaskCount: tracked.length - modelReportedTasks,
            apiCalls: modelApiCalls,
            inputTokens: modelInputTokens,
            outputTokens: modelOutputTokens,
            cacheReadTokens: modelCacheReadTokens,
            cacheWriteTokens: modelCacheWriteTokens,
            reasoningTokens: modelReasoningTokens,
            totalTokens: modelInputTokens + modelOutputTokens + modelCacheReadTokens + modelCacheWriteTokens,
            providerAttempts: modelProviderAttempts,
            rateLimitRejections: modelRateLimitRejections,
        },
        cost: { reportedTaskCount: costReportedTasks, totals: [...costByCurrency.entries()].map(([currency, amount]: any): any => ({ currency, amount })) }
    };
}
export function reconcileUsageBilling(tasks: any, ledger: any, { since = null, until = null, providerSnapshot = null }: any = {}): any {
    const after: any = asDate(since);
    const before: any = asDate(until);
    const taskEntries: any = (Array.isArray(tasks) ? tasks : [])
        .filter((task: any): any => task.usage?.schemaVersion === 'agent.army/task-usage/v1')
        .filter((task: any): any => {
        const recordedAt: any = asDate(task.usage?.recordedAt || task.updatedAt || task.createdAt);
        return (!after || (recordedAt && recordedAt >= after))
            && (!before || (recordedAt && recordedAt < before));
    })
        .filter((task: any): any => task.usage?.model?.status === 'reported')
        .map(taskBillingEntry);
    const claimedLedgerRefs: any = new Set();
    const entries: any = (Array.isArray(ledger?.entries) ? ledger.entries : []).map((entry: any): any => {
        const match: any = closestTaskUsageMatch(taskEntries, entry, claimedLedgerRefs);
        if (!match)
            return { ...entry, attribution: classifyUnmatchedLedgerEntry(entry) };
        claimedLedgerRefs.add(entry.ledgerRef);
        match.ledgerRefs.push(entry.ledgerRef);
        match.ledgerRef ||= entry.ledgerRef;
        return {
            ...entry,
            attribution: {
                status: 'task',
                taskId: match.taskId,
                taskTitle: match.taskTitle,
                taskRef: shortTaskRef(match.taskId),
                workflowId: match.workflowId,
                stepId: match.stepId,
                sourceChannel: match.sourceChannel,
            },
        };
    });
    const attributionCounts: any = Object.fromEntries(['task', 'system', 'agent_session', 'unattributed'].map((status: any): any => [
        status,
        entries.filter((entry: any): any => entry.attribution.status === status).length,
    ]));
    const totals: any = ledger?.totals || emptyLedgerTotals();
    const providerReconciliation: any = reconcileProviderSnapshot(totals, providerSnapshot);
    const incompleteTaskRecords: any = taskEntries.filter((entry: any): any => !entry.taskId
        || !entry.agentId || !entry.provider || !entry.model);
    const credentialAliasMissingCount: any = taskEntries.filter((entry: any): any => entry.apiCalls > 0 && !entry.credentialAlias).length;
    return {
        schemaVersion: 'agent.army/usage-billing-view/v1',
        status: String(ledger?.status || 'unavailable'),
        period: ledger?.period || null,
        totals,
        profiles: Array.isArray(ledger?.profiles) ? ledger.profiles : [],
        entries,
        attribution: {
            attributedEntryCount: attributionCounts.task,
            taskEntryCount: attributionCounts.task,
            systemEntryCount: attributionCounts.system,
            agentSessionEntryCount: attributionCounts.agent_session,
            unattributedEntryCount: attributionCounts.unattributed,
            taskApiCalls: sumApiCalls(entries, 'task'),
            systemApiCalls: sumApiCalls(entries, 'system'),
            agentSessionApiCalls: sumApiCalls(entries, 'agent_session'),
            unattributedApiCalls: sumApiCalls(entries, 'unattributed'),
            taskModelRecordCount: taskEntries.length,
            unmatchedTaskRecordCount: taskEntries.filter((entry: any): any => entry.ledgerRefs.length === 0).length,
            incompleteTaskModelRecordCount: incompleteTaskRecords.length,
            credentialAliasMissingCount,
        },
        coverage: {
            scope: 'managed_hermes_profiles',
            providerAccountIncluded: ['matched', 'gap', 'mismatch'].includes(providerReconciliation.status),
            externalClientsIncluded: ['matched', 'gap', 'mismatch'].includes(providerReconciliation.status),
            canAssertAccountTotal: providerReconciliation.status === 'matched',
            taskModelRecordsComplete: incompleteTaskRecords.length === 0,
            credentialAliasesComplete: credentialAliasMissingCount === 0,
        },
        providerReconciliation,
        efficiency: {
            inputTokensByAttribution: Object.fromEntries(['task', 'system', 'agent_session', 'unattributed'].map((status: any): any => [
                status,
                sumTokens(entries, status, 'input'),
            ])),
            memoryWriteCount: sumRecordedToolCalls(tasks, 'memory'),
            sessionSearchCount: sumRecordedToolCalls(tasks, 'session_search'),
            budgetStopCount: (Array.isArray(tasks) ? tasks : []).filter((task: any): any => /(?:budget|limit|hard_stop|max_turn)/i.test(String(task?.error?.code || ''))).length,
            toolCountCoverage: 'task_usage_only',
        },
        taskEntries,
        limitations: Array.isArray(ledger?.limitations) ? ledger.limitations : [],
        unavailableProfiles: Array.isArray(ledger?.unavailableProfiles) ? ledger.unavailableProfiles : [],
        truncatedEntryCount: Number(ledger?.truncatedEntryCount || 0),
    };
}
function taskBillingEntry(task: any): any {
    const usage: any = task.usage;
    return {
        taskId: String(task.taskId || ''),
        taskRef: shortTaskRef(task.taskId),
        taskTitle: String(task.input?.title || task.title || '未命名任务').replace(/\s+/g, ' ').trim().slice(0, 160),
        agentId: String(usage.execution?.executor || task.assigneeAgentId || '').trim(),
        recordedAt: String(usage.recordedAt || task.updatedAt || task.createdAt || ''),
        provider: usage.model.provider || null,
        model: usage.model.model || null,
        apiCalls: Number(usage.model.apiCalls || 0),
        inputTokens: Number(usage.model.inputTokens || 0),
        outputTokens: Number(usage.model.outputTokens || 0),
        cacheReadTokens: Number(usage.model.cacheReadTokens || 0),
        cacheWriteTokens: Number(usage.model.cacheWriteTokens || 0),
        reasoningTokens: Number(usage.model.reasoningTokens || 0),
        providerAttempts: Number(usage.model.providerAttempts || 0),
        rateLimitRejections: Number(usage.model.rateLimitRejections || 0),
        credentialAlias: usage.model.credentialAlias || null,
        requestClass: usage.model.requestClass || null,
        purpose: usage.model.purpose || null,
        cost: usage.cost,
        sessionIds: normalizedSessionIds(usage.model),
        workflowId: String(task.workflow?.workflowId || usage.attribution?.workflowId || '').trim() || null,
        stepId: String(task.workflow?.step?.stepId || usage.attribution?.stepId || '').trim() || null,
        sourceChannel: String(task.source?.channel || usage.attribution?.sourceChannel || '').trim() || null,
        ledgerRef: null,
        ledgerRefs: [],
    };
}
function closestTaskUsageMatch(taskEntries: any, ledgerEntry: any, claimedLedgerRefs: any): any {
    if (claimedLedgerRefs.has(ledgerEntry.ledgerRef))
        return null;
    const occurredAt: any = Date.parse(ledgerEntry.occurredAt);
    const explicitSessionCandidates: any = taskEntries.filter((task: any): any => task.sessionIds.includes(String(ledgerEntry.sessionId || ''))
        && task.agentId === ledgerEntry.agentId
        && (!task.provider || task.provider === ledgerEntry.provider)
        && (!task.model || task.model === ledgerEntry.model));
    if (explicitSessionCandidates.length) {
        return explicitSessionCandidates.sort((left: any, right: any): any => Math.abs(Date.parse(left.recordedAt) - occurredAt) - Math.abs(Date.parse(right.recordedAt) - occurredAt))[0];
    }
    const candidates: any = taskEntries.filter((task: any): any => task.ledgerRefs.length === 0
        && task.agentId === ledgerEntry.agentId
        && (!task.provider || task.provider === ledgerEntry.provider)
        && (!task.model || task.model === ledgerEntry.model)
        && task.apiCalls === Number(ledgerEntry.apiCalls || 0)
        && task.inputTokens === Number(ledgerEntry.tokens?.input || 0)
        && task.outputTokens === Number(ledgerEntry.tokens?.output || 0));
    candidates.sort((left: any, right: any): any => Math.abs(Date.parse(left.recordedAt) - occurredAt) - Math.abs(Date.parse(right.recordedAt) - occurredAt));
    const match: any = candidates[0] || null;
    if (!match)
        return null;
    const distance: any = Math.abs(Date.parse(match.recordedAt) - occurredAt);
    return Number.isFinite(distance) && distance <= 15 * 60 * 1000 ? match : null;
}
function shortTaskRef(taskId: any): any {
    const compact: any = String(taskId || '').replace(/[^0-9a-z]/gi, '').slice(0, 8).toUpperCase();
    return compact ? `#${compact}` : '#未编号';
}
function emptyLedgerTotals(): any {
    return {
        entryCount: 0,
        sessionCount: 0,
        apiCalls: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 },
        cost: { actualUsd: 0, estimatedUsd: 0, knownUsd: 0, actualEntryCount: 0, estimatedEntryCount: 0, includedEntryCount: 0, unknownEntryCount: 0 },
    };
}
function normalizeTools(value: any): any {
    return (Array.isArray(value) ? value : []).map((tool: any): any => {
        const id: any = String(tool?.id || '').trim().slice(0, 80);
        const name: any = String(tool?.name || id).trim().slice(0, 120);
        const calls: any = Math.max(0, Math.min(MAX_TOOL_CALLS, Number(tool?.calls || 0)));
        return id && calls ? { id, name: name || id, calls } : null;
    }).filter(Boolean);
}
function normalizeModel(value: any): any {
    if (!value || typeof value !== 'object')
        return { status: 'not_reported' };
    const inputTokens: any = nonNegativeInteger(value.inputTokens);
    const outputTokens: any = nonNegativeInteger(value.outputTokens);
    const apiCalls: any = nonNegativeInteger(value.apiCalls);
    const cacheReadTokens: any = nonNegativeInteger(value.cacheReadTokens ?? value.cachedInputTokens);
    const cacheWriteTokens: any = nonNegativeInteger(value.cacheWriteTokens);
    const reasoningTokens: any = nonNegativeInteger(value.reasoningTokens);
    const providerAttempts: any = nonNegativeInteger(value.providerAttempts);
    const rateLimitRejections: any = nonNegativeInteger(value.rateLimitRejections);
    if (inputTokens === null && outputTokens === null && apiCalls === null)
        return { status: 'not_reported' };
    const credentialAlias: any = safeCredentialAlias(value.credentialAlias);
    const requestClass: any = safeIdentifier(value.requestClass, 80);
    const purpose: any = safeText(value.purpose, 160);
    return {
        status: 'reported',
        ...(String(value.provider || '').trim() ? { provider: String(value.provider).trim().slice(0, 80) } : {}),
        ...(String(value.model || '').trim() ? { model: String(value.model).trim().slice(0, 120) } : {}),
        ...normalizeSessionFields(value),
        ...(inputTokens !== null ? { inputTokens } : {}),
        ...(outputTokens !== null ? { outputTokens } : {}),
        ...(cacheReadTokens !== null ? { cacheReadTokens } : {}),
        ...(cacheWriteTokens !== null ? { cacheWriteTokens } : {}),
        ...(reasoningTokens !== null ? { reasoningTokens } : {}),
        ...(apiCalls !== null ? { apiCalls } : {}),
        ...(providerAttempts !== null ? { providerAttempts } : {}),
        ...(rateLimitRejections !== null ? { rateLimitRejections } : {}),
        ...(credentialAlias ? { credentialAlias } : {}),
        ...(requestClass ? { requestClass } : {}),
        ...(purpose ? { purpose } : {}),
    };
}
function normalizeTaskAttribution(task: any): any {
    return {
        taskId: String(task?.taskId || '').trim() || null,
        workflowId: String(task?.workflow?.workflowId || '').trim() || null,
        stepId: String(task?.workflow?.step?.stepId || '').trim() || null,
        sourceChannel: String(task?.source?.channel || '').trim() || null,
    };
}
function normalizeSessionFields(value: any): any {
    const sessionIds: any = normalizedSessionIds(value);
    if (sessionIds.length > 1)
        return { sessionIds };
    return sessionIds.length === 1 ? { sessionId: sessionIds[0] } : {};
}
function normalizedSessionIds(value: any): any {
    const raw: any[] = [value?.sessionId, ...(Array.isArray(value?.sessionIds) ? value.sessionIds : [])];
    return [...new Set(raw.map((item: any): any => String(item || '').replace(/[^A-Za-z0-9:._-]/g, '').slice(0, 160)).filter(Boolean))];
}
function classifyUnmatchedLedgerEntry(entry: any): any {
    const source: any = String(entry?.source || '').trim().toLowerCase();
    const usageClass: any = String(entry?.usageClass || '').trim().toLowerCase();
    if (['system', 'routine', 'cron', 'health'].includes(source)
        || ['system', 'routine', 'cron', 'health', 'health_check'].includes(usageClass)) {
        return { status: 'system', systemClass: usageClass || source || 'system' };
    }
    const agentId: any = String(entry?.agentId || '').trim();
    const sessionId: any = String(entry?.sessionId || '').trim();
    if (agentId && sessionId)
        return { status: 'agent_session', agentId, sessionId, source: source || 'unknown' };
    return { status: 'unattributed' };
}
function sumApiCalls(entries: any, status: any): any {
    return entries.filter((entry: any): any => entry.attribution.status === status)
        .reduce((total: any, entry: any): any => total + Number(entry.apiCalls || 0), 0);
}
function sumTokens(entries: any, status: any, field: any): any {
    return entries.filter((entry: any): any => entry.attribution.status === status)
        .reduce((total: any, entry: any): any => total + Number(entry.tokens?.[field] || 0), 0);
}
function sumRecordedToolCalls(tasks: any, toolId: any): any {
    return (Array.isArray(tasks) ? tasks : []).reduce((total: any, task: any): any => total
        + (Array.isArray(task?.usage?.tools) ? task.usage.tools : [])
            .filter((tool: any): any => tool?.id === toolId)
            .reduce((count: any, tool: any): any => count + Number(tool.calls || 0), 0), 0);
}
function normalizeCost(value: any): any {
    if (!value || typeof value !== 'object')
        return { status: 'not_reported' };
    const amount: any = Number(value.amount);
    const currency: any = String(value.currency || '').trim().toUpperCase();
    if (!Number.isFinite(amount) || amount < 0 || !currency || currency.length > 8)
        return { status: 'not_reported' };
    const basis: any = normalizeCostBasis(value.basis || value.status);
    const source: any = String(value.source || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    return {
        status: 'reported',
        amount,
        currency,
        basis,
        ...(source ? { source } : {}),
    };
}
function normalizeCostBasis(value: any): any {
    const normalized: any = String(value || '').trim().toLowerCase();
    if (['estimated', 'actual', 'included', 'mixed'].includes(normalized))
        return normalized;
    return 'task_usage_reported';
}
function asDate(value: any): any {
    const date: any = value instanceof Date ? value : new Date(value || 0);
    return Number.isNaN(date.getTime()) || date.getTime() === 0 ? null : date;
}
function nonNegativeInteger(value: any): any {
    const number: any = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function reconcileProviderSnapshot(managedTotals: any, snapshot: any): any {
    if (!snapshot || typeof snapshot !== 'object') {
        return {
            status: 'not_configured',
            provider: null,
            source: null,
            managedApiCalls: nonNegativeInteger(managedTotals?.apiCalls) || 0,
            providerApiCalls: null,
            untrackedApiCalls: null,
            managedTokens: totalTokens(managedTotals?.tokens),
            providerTokens: null,
            untrackedTokens: null,
        };
    }
    if (snapshot.status !== 'ready') {
        return {
            status: 'invalid',
            provider: safeIdentifier(snapshot.provider, 80) || null,
            source: safeIdentifier(snapshot.source, 120) || null,
            managedApiCalls: nonNegativeInteger(managedTotals?.apiCalls) || 0,
            providerApiCalls: null,
            untrackedApiCalls: null,
            managedTokens: totalTokens(managedTotals?.tokens),
            providerTokens: null,
            untrackedTokens: null,
        };
    }
    const providerApiCalls: any = nonNegativeInteger(snapshot?.totals?.apiCalls);
    const providerTokens: any = totalTokens(snapshot?.totals?.tokens);
    if (providerApiCalls === null || providerTokens === null) {
        return {
            status: 'invalid',
            provider: safeIdentifier(snapshot.provider, 80) || null,
            source: safeIdentifier(snapshot.source, 120) || null,
            managedApiCalls: nonNegativeInteger(managedTotals?.apiCalls) || 0,
            providerApiCalls: null,
            untrackedApiCalls: null,
            managedTokens: totalTokens(managedTotals?.tokens),
            providerTokens: null,
            untrackedTokens: null,
        };
    }
    const managedApiCalls: any = nonNegativeInteger(managedTotals?.apiCalls) || 0;
    const managedTokens: any = totalTokens(managedTotals?.tokens) || 0;
    const apiCallDifference: any = providerApiCalls - managedApiCalls;
    const tokenDifference: any = providerTokens - managedTokens;
    const status: any = apiCallDifference === 0 && tokenDifference === 0
        ? 'matched'
        : apiCallDifference >= 0 && tokenDifference >= 0 ? 'gap' : 'mismatch';
    return {
        status,
        provider: safeIdentifier(snapshot.provider, 80) || null,
        source: safeIdentifier(snapshot.source, 120) || null,
        observedAt: asDate(snapshot.observedAt)?.toISOString() || null,
        managedApiCalls,
        providerApiCalls,
        apiCallDifference,
        untrackedApiCalls: Math.max(0, apiCallDifference),
        managedTokens,
        providerTokens,
        tokenDifference,
        untrackedTokens: Math.max(0, tokenDifference),
    };
}

function totalTokens(tokens: any): any {
    if (!tokens || typeof tokens !== 'object')
        return null;
    const explicit: any = nonNegativeInteger(tokens.total);
    if (explicit !== null)
        return explicit;
    const fields: any[] = ['input', 'output', 'cacheRead', 'cacheWrite'];
    const values: any[] = fields.map((field: any): any => nonNegativeInteger(tokens[field]));
    return values.some((value: any): any => value !== null)
        ? values.reduce((sum: any, value: any): any => sum + Number(value || 0), 0)
        : null;
}

function safeIdentifier(value: any, limit: any): any {
    return String(value || '').replace(/[^A-Za-z0-9:._-]/g, '').slice(0, limit);
}

function safeText(value: any, limit: any): any {
    return String(value || '')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/\b(authorization|cookie|token|api[_-]?key|password|secret)\b\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, '$1=[已脱敏]')
        .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [已脱敏]')
        .trim()
        .slice(0, limit);
}

function safeCredentialAlias(value: any): any {
    const raw: any = String(value || '').trim();
    if (/^(?:sk|api)[-_][A-Za-z0-9_=-]{12,}$/i.test(raw) || /^bearer\s+/i.test(raw))
        return '';
    return safeIdentifier(raw, 120);
}

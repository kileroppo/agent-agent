import { createHash } from 'node:crypto';
import { INTEL_RESEARCH_OPEN_TASK_EXECUTION_CONTRACT } from '@agent-army/m5-kernel/routine-execution-contract';
import { openTaskRoutingPolicy } from './open-task-routing-policy.ts';
import { openTaskResearchState } from './open-task-research-state.ts';
const CONTROLLED_SOURCE_MATERIAL: any = Symbol.for('agent.army.openResearch.controlledSourceMaterial');
const { decide: decideIntelResearchOpenTask, } = openTaskRoutingPolicy;
const { recover: recoverIntelResearchOpenTaskState, sources: { addVerified: addVerifiedSourceObservation, publicUrl: publicResearchUrl, validTimestamp: validTimestampText, validHash: validHashText, }, report: { verifyArtifact: verifiedResearchReportArtifact, workProduct: openResearchReportWorkProduct, completedObservation: completedReportObservation, completedResult: completedOpenResearchResult, }, progress: { canonicalBudget: canonicalOpenResearchBudget, assertToolBudget: assertOpenResearchToolBudget, }, } = openTaskResearchState;
function initialResearchTool(task: any): any {
    const sourceUrl: any = openResearchSourceUrl(task);
    if (!sourceUrl)
        return 'content.public.search';
    if (/\.pdf(?:$|[?#])/i.test(sourceUrl))
        return 'content.public.pdf.read';
    if (/^https?:\/\/(?:www\.)?github\.com\//i.test(sourceUrl))
        return 'github.public.read';
    return 'content.public.fetch';
}
function assertManifestResearchTool(toolId: any, agent: any): any {
    const contract: any = INTEL_RESEARCH_OPEN_TASK_EXECUTION_CONTRACT;
    const manifestTools: any = new Set((Array.isArray(agent?.toolAllowlist) ? agent.toolAllowlist : [])
        .map((item: any): any => String(item || '').trim())
        .filter(Boolean));
    if (!contract.toolIds.includes(toolId) || !manifestTools.has(toolId)) {
        throw new Error(`小R Manifest 未授权 ${toolId}。`);
    }
}
async function executeIntelResearchOpenTaskStep({ task, agent, assignment, executionPolicy, paperclipWorkProducts, roleToolContext, reportExecutor, writeStepWorkProduct, readWorkProducts, now = (): any => new Date(), }: any = {}): Promise<any> {
    const issueId: any = String(assignment?.issueId || '').trim();
    const runId: any = String(assignment?.runId || '').trim();
    if (task?.taskType !== INTEL_RESEARCH_OPEN_TASK_EXECUTION_CONTRACT.taskType
        || agent?.agentId !== INTEL_RESEARCH_OPEN_TASK_EXECUTION_CONTRACT.agentId
        || !issueId
        || !runId) {
        throw new Error('当前 Paperclip assignment 不是小R开放研究任务。');
    }
    if (typeof roleToolContext?.execute !== 'function') {
        throw new Error('小R开放研究缺少经岗位 Manifest 编译的工具执行上下文。');
    }
    if (typeof writeStepWorkProduct !== 'function') {
        throw new Error('小R开放研究缺少 Paperclip Observation Work Product 写回能力。');
    }
    if (typeof readWorkProducts !== 'function') {
        throw new Error('小R开放研究缺少 Paperclip Work Product 回读能力。');
    }
    const priorState: any = recoverIntelResearchOpenTaskState({
        workProducts: paperclipWorkProducts,
        issueId,
        runId,
    });
    if (priorState?.completedReport) {
        return completedOpenResearchResult({
            report: priorState.completedReport,
            issueId,
            runId,
            progress: priorState.progress,
            budget: priorState.budget,
            now,
            reusedReport: true,
        });
    }
    if (task?.execution?.openResearch && !priorState) {
        throw new Error('Paperclip 缺少小R开放研究 Work Product；拒绝把本地投影当成任务真相。');
    }
    let progress: any = priorState?.progress || {
        stepsUsed: 0,
        safeRetriesUsed: 0,
        replansUsed: 0,
    };
    let budget: any = priorState?.budget || canonicalOpenResearchBudget(executionPolicy);
    let observation: any = priorState?.lastObservation || null;
    const sourceObservations: any[] = [...(priorState?.sourceObservations || [])];
    const sourceCheckpointPersisted: any = sourceObservations.length >= 2;
    let initialToolId: any = null;
    if (!observation) {
        assertOpenResearchToolBudget(progress, budget);
        initialToolId = initialResearchTool(task);
        assertManifestResearchTool(initialToolId, agent);
        observation = await executeObservedResearchTool({
            task,
            assignment,
            roleToolContext,
            toolId: initialToolId,
            stepNumber: progress.stepsUsed + 1,
            now,
        });
        progress = {
            ...progress,
            stepsUsed: progress.stepsUsed + 1,
        };
        budget = {
            ...budget,
            remainingUnits: budget.remainingUnits - budget.estimatedNextStepUnits,
        };
        addVerifiedSourceObservation(sourceObservations, observation, {
            issueId,
            runId,
        });
    }
    const canGenerateRecoveredReport: any = sourceCheckpointPersisted
        && progress.stepsUsed < INTEL_RESEARCH_OPEN_TASK_EXECUTION_CONTRACT.maxSteps
        && budget.remainingUnits >= budget.estimatedNextStepUnits;
    let decision: any = canGenerateRecoveredReport
        ? priorState?.lastDecision
        : decideIntelResearchOpenTask({
            task,
            agent,
            observation,
            progress,
            budget,
            now,
        });
    if (canGenerateRecoveredReport && !decision?.decisionId) {
        throw new Error('Paperclip 来源检查点缺少小R受控决策。');
    }
    let nextObservation: any = null;
    if (!canGenerateRecoveredReport && decision.selectedToolId) {
        nextObservation = await executeObservedResearchTool({
            task,
            assignment,
            roleToolContext,
            toolId: decision.selectedToolId,
            stepNumber: progress.stepsUsed + 1,
            priorObservation: observation,
            now,
        });
        progress = {
            stepsUsed: progress.stepsUsed + 1,
            safeRetriesUsed: progress.safeRetriesUsed + (decision.action === 'safe_retry' ? 1 : 0),
            replansUsed: progress.replansUsed,
        };
        budget = {
            ...budget,
            remainingUnits: decision.budget.remainingUnitsAfterDecision,
        };
        addVerifiedSourceObservation(sourceObservations, nextObservation, {
            issueId,
            runId,
        });
    }
    else if (!canGenerateRecoveredReport
        && decision.action === 'request_replan'
        && decision.replanAllowed) {
        progress = {
            ...progress,
            replansUsed: progress.replansUsed + 1,
        };
    }
    let completedReport: any = null;
    if (sourceObservations.length >= 2
        && decision.action !== 'request_replan'
        && progress.stepsUsed < INTEL_RESEARCH_OPEN_TASK_EXECUTION_CONTRACT.maxSteps
        && budget.remainingUnits >= budget.estimatedNextStepUnits) {
        if (!sourceCheckpointPersisted) {
            const sourceCheckpoint: any = openResearchStepWorkProduct({
                task,
                assignment,
                initialToolId,
                observation,
                decision,
                nextObservation,
                progress,
                budget,
                now,
            });
            const writtenCheckpoint: any = await writeStepWorkProduct(sourceCheckpoint);
            if (!String(writtenCheckpoint?.id || '').trim()) {
                throw new Error('Paperclip 未返回小R来源 Observation Work Product ID。');
            }
        }
        if (typeof reportExecutor?.synthesizeVerifiedReport !== 'function') {
            throw new Error('小R受控研究报告执行器不可用。');
        }
        const artifact: any = await reportExecutor.synthesizeVerifiedReport({
            task,
            issueId,
            runId,
            sourceObservations,
        });
        const verifiedArtifact: any = verifiedResearchReportArtifact({
            artifact,
            task,
            issueId,
            runId,
            sourceObservations,
        });
        progress = {
            ...progress,
            stepsUsed: progress.stepsUsed + 1,
        };
        budget = {
            ...budget,
            remainingUnits: budget.remainingUnits - budget.estimatedNextStepUnits,
        };
        const reportProduct: any = openResearchReportWorkProduct({
            task,
            assignment,
            artifact: verifiedArtifact,
            sourceObservations,
            progress,
            budget,
            now,
        });
        const writtenReport: any = await writeStepWorkProduct(reportProduct);
        if (!String(writtenReport?.id || '').trim()) {
            throw new Error('Paperclip 未返回小R ResearchReport Work Product ID。');
        }
        const refreshed: any = recoverIntelResearchOpenTaskState({
            workProducts: await readWorkProducts(),
            issueId,
            runId,
        });
        if (!refreshed?.completedReport) {
            throw new Error('小R ResearchReport 写回后无法从当前 Run 回读健康 Work Product。');
        }
        completedReport = refreshed.completedReport;
        const completionObservation: any = completedReportObservation({
            assignment,
            report: completedReport,
            stepNumber: progress.stepsUsed,
            now,
        });
        decision = decideIntelResearchOpenTask({
            task,
            agent,
            observation: completionObservation,
            progress,
            budget,
            now,
        });
        nextObservation = completionObservation;
    }
    const product: any = openResearchStepWorkProduct({
        task,
        assignment,
        initialToolId,
        observation,
        decision,
        nextObservation,
        progress,
        budget,
        now,
    });
    const written: any = await writeStepWorkProduct(product);
    const workProductId: any = String(written?.id || '').trim();
    if (!workProductId) {
        throw new Error('Paperclip 未返回小R Observation Work Product ID。');
    }
    const terminalObservation: any = nextObservation || observation;
    const executionStatus: any = completedReport && decision.action === 'complete'
        ? 'succeeded'
        : decision.action === 'request_replan'
            ? 'waiting_test'
            : 'running';
    return {
        status: executionStatus,
        currentStage: decision.action === 'complete'
            ? 'open_research_complete'
            : decision.action === 'request_replan'
                ? 'open_research_replan_required'
                : 'open_research_observation_ready',
        artifactRefs: completedReport ? [completedReport.artifact] : [],
        execution: {
            openResearch: {
                schemaVersion: 'agent.army/open-research-runtime-state/v1',
                issueId,
                runId,
                lastObservation: terminalObservation,
                lastDecision: decision,
                progress,
                budget,
                lastWorkProductId: workProductId,
                projectionSource: 'paperclip_work_product',
                updatedAt: now().toISOString(),
            },
        },
        openResearch: {
            observation,
            decision,
            nextObservation,
            workProductId,
            ...(completedReport ? {
                reportWorkProductId: completedReport.id,
                sourceObservationIds: completedReport.sourceObservationIds,
                reusedReport: false,
            } : {}),
        },
        ...(executionStatus === 'waiting_test' ? {
            error: {
                code: decision.replanAllowed
                    ? 'open_research_replan_required'
                    : 'open_research_replan_limit_exhausted',
                message: decision.replanAllowed
                    ? '小R已根据真实 Observation 请求 Paperclip 重规划。'
                    : '小R已耗尽三次重规划上限，任务保持阻塞。',
                userMessage: '开放研究没有继续扩大工具调用；请查看当前 Observation 和恢复动作。',
                category: 'governance',
                stage: 'open_research_observation_loop',
                retryable: false,
                occurredAt: now().toISOString(),
            },
        } : {}),
    };
}
async function executeObservedResearchTool({ task, assignment, roleToolContext, toolId, stepNumber, priorObservation = null, now, }: any = {}): Promise<any> {
    const sourceUrl: any = researchToolSourceUrl({ task, toolId, priorObservation });
    const request: any = researchToolRequest({ task, toolId, sourceUrl });
    let output: any = null;
    let failure: any = null;
    try {
        output = await roleToolContext.execute(request);
    }
    catch (error: any) {
        failure = error;
    }
    return trustedAdapterObservation({
        assignment,
        toolId,
        stepNumber,
        sourceUrl,
        output,
        failure,
        task,
        now,
    });
}
function researchToolRequest({ task, toolId, sourceUrl }: any = {}): any {
    if (toolId === 'content.public.search') {
        return {
            toolId,
            externalSideEffect: 'network-read',
            url: 'https://html.duckduckgo.com/html/',
            input: {
                query: String(task?.input?.topic
                    || task?.input?.title
                    || task?.input?.goalSpec?.objective
                    || '').trim().slice(0, 300),
                limit: 3,
            },
        };
    }
    const safeUrl: any = publicResearchUrl(sourceUrl);
    if (!safeUrl)
        throw new Error('小R开放研究缺少可核验的公开来源 URL。');
    return {
        toolId,
        externalSideEffect: 'network-read',
        url: safeUrl,
        input: {
            sourceUrl: safeUrl,
            ...(toolId.startsWith('github.') ? { operation: 'read' } : {}),
        },
    };
}
function researchToolSourceUrl({ task, toolId, priorObservation }: any = {}): any {
    if (toolId === 'content.public.search' || toolId === 'github.public.search')
        return null;
    const observed: any = publicResearchUrl(priorObservation?.result?.sourceUrl);
    if (observed
        && priorObservation?.classification === 'source_verified'
        && !['content.public.search', 'github.public.search'].includes(priorObservation?.toolId)) {
        const urls: any = openResearchSourceUrls(task);
        const currentIndex: any = urls.indexOf(observed);
        if (currentIndex >= 0 && urls[currentIndex + 1])
            return urls[currentIndex + 1];
    }
    return observed || openResearchSourceUrl(task);
}
function openResearchSourceUrl(task: any): any {
    return openResearchSourceUrls(task)[0] || null;
}
function openResearchSourceUrls(task: any): any {
    const candidates: any[] = [
        ...(Array.isArray(task?.input?.sourceUrls) ? task.input.sourceUrls : []),
        task?.input?.sourceUrl,
    ];
    return [...new Set(candidates.map(publicResearchUrl).filter(Boolean))];
}
function trustedAdapterObservation({ assignment, toolId, stepNumber, sourceUrl, output, failure, task, now, }: any = {}): any {
    const errorCode: any = String(failure?.code || '').trim().toLowerCase();
    const errorText: any = String(failure?.message || '').toLowerCase();
    const contentType: any = String(output?.contentType || output?.mimeType || '').toLowerCase();
    const discoveredUrl: any = Array.isArray(output?.results)
        ? output.results.map((item: any): any => publicResearchUrl(item?.url)).find(Boolean)
        : null;
    const actualSourceUrl: any = publicResearchUrl(output?.sourceRef || output?.url || discoveredUrl || sourceUrl);
    const fetchedAt: any = validTimestampText(output?.fetchedAt || output?.searchedAt);
    const contentHash: any = validHashText(output?.contentHash);
    let outcome: any = failure ? 'failed' : 'succeeded';
    let classification: any = 'source_verified';
    let error: any = null;
    if (toolId === 'content.public.fetch'
        && (contentType.includes('application/pdf')
            || errorCode.includes('pdf')
            || errorText.includes('pdf'))) {
        outcome = 'failed';
        classification = 'pdf_detected';
        error = { code: 'content_type_pdf', retryable: false };
    }
    else if (toolId === 'content.public.fetch'
        && (output?.requiresDynamic === true
            || errorCode.includes('dynamic')
            || errorText.includes('javascript'))) {
        outcome = 'failed';
        classification = 'dynamic_page_required';
        error = { code: 'client_render_required', retryable: false };
    }
    else if (failure) {
        classification = 'transport_unavailable';
        error = {
            code: String(failure?.code || 'adapter_failed').slice(0, 120),
            retryable: failure?.retryable === true,
        };
    }
    const observation: Record<string, any> = {
        schemaVersion: 'agent.army/tool-observation/v1',
        observationId: `${assignment.runId}:open-research:${stepNumber}`,
        issueId: assignment.issueId,
        runId: assignment.runId,
        toolId,
        outcome,
        classification,
        provenance: 'trusted_role_tool_adapter',
        result: {
            sourceUrl: actualSourceUrl,
            contentType: contentType || null,
            fetchedAt,
            contentHash,
            evidenceSourceCount: outcome === 'succeeded' ? 1 : 0,
            acceptanceSatisfied: false,
            nextToolId: deterministicNextResearchTool({ task, toolId, actualSourceUrl }),
            ...(outcome === 'succeeded'
                && !['content.public.search', 'github.public.search'].includes(toolId)
                && actualSourceUrl
                && fetchedAt
                && contentHash
                ? {
                    sourceEvidence: trustedSourceEvidence({
                        toolId,
                        actualSourceUrl,
                        fetchedAt,
                        contentHash,
                        title: output?.title,
                    }),
                }
                : {}),
        },
        ...(error ? { error } : {}),
        recordedAt: now().toISOString(),
    };
    const sourceSummary: any = controlledSourceSummary(output?.text || output?.summary);
    if (observation.result.sourceEvidence && sourceSummary) {
        Object.defineProperty(observation, CONTROLLED_SOURCE_MATERIAL, {
            value: Object.freeze({ summary: sourceSummary }),
            enumerable: false,
            configurable: false,
            writable: false,
        });
    }
    return observation;
}
function trustedSourceEvidence({ toolId, actualSourceUrl, fetchedAt, contentHash, title, }: any = {}): any {
    const sourceId: any = `source-${createHash('sha256')
        .update(`${actualSourceUrl}|${contentHash}`)
        .digest('hex')
        .slice(0, 16)}`;
    const safeTitle: any = String(title || '未提供标题的公开来源')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300);
    const fragmentId: any = `${sourceId}-provenance`;
    return {
        sourceId,
        title: safeTitle,
        url: actualSourceUrl,
        fetchedAt,
        contentHash,
        kind: toolId === 'content.public.pdf.read'
            ? 'public_pdf'
            : toolId === 'content.public.dynamic.read'
                ? 'public_dynamic_web'
                : toolId.startsWith('github.')
                    ? 'github_public'
                    : 'public_web',
        evidenceFragment: {
            fragmentId,
            text: `受控适配器已读取公开来源《${safeTitle}》，抓取时间 ${fetchedAt}，正文校验值 ${contentHash}。`,
        },
    };
}
function controlledSourceSummary(value: any): any {
    const compact: any = String(value || '').replace(/\s+/g, ' ').trim();
    if (!compact)
        return null;
    if (/(?:\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|[?&](?:token|api[_-]?key|secret|password)=)/i.test(compact)
        || /(?:^|[\s"'=:])\/(?:Users|home|private|tmp|var|opt|etc)(?:\/|$)/i.test(compact))
        return null;
    return (compact.split(/(?<=[。！？.!?])\s*/).find(Boolean) || compact).slice(0, 900);
}
function deterministicNextResearchTool({ task, toolId, actualSourceUrl }: any = {}): any {
    const urls: any = [
        ...(Array.isArray(task?.input?.sourceUrls) ? task.input.sourceUrls : []),
        task?.input?.sourceUrl,
    ].map(publicResearchUrl).filter(Boolean);
    const currentIndex: any = urls.indexOf(actualSourceUrl);
    const nextUrl: any = currentIndex >= 0 ? urls[currentIndex + 1] : null;
    if (nextUrl) {
        if (/\.pdf(?:$|[?#])/i.test(nextUrl))
            return 'content.public.pdf.read';
        if (/^https?:\/\/(?:www\.)?github\.com\//i.test(nextUrl))
            return 'github.public.read';
        return 'content.public.fetch';
    }
    if (toolId === 'content.public.search')
        return 'content.public.fetch';
    return 'content.public.search';
}
function openResearchStepWorkProduct({ task, assignment, initialToolId, observation, decision, nextObservation, progress, budget, now, }: any = {}): any {
    const idempotencyKey: any = `open-research-step:${decision.decisionId}`;
    return {
        type: 'artifact',
        provider: 'agent-army.intel-researcher',
        externalId: idempotencyKey,
        title: `小R开放研究步骤 ${progress.stepsUsed}`,
        status: 'active',
        reviewState: 'none',
        isPrimary: false,
        healthStatus: 'healthy',
        summary: '受控公开研究步骤已写回；正文不复制到控制面。',
        createdByRunId: assignment.runId,
        metadata: {
            kind: 'OpenResearchStep',
            schemaVersion: 'agent.army/open-research-step/v1',
            idempotencyKey,
            taskId: String(task?.taskId || '').trim() || null,
            issueId: assignment.issueId,
            runId: assignment.runId,
            initialToolId,
            observation,
            decision,
            nextObservation,
            progress,
            budget,
            recordedAt: now().toISOString(),
        },
    };
}
export const openTaskResearchExecution: any = Object.freeze({
    execute: executeIntelResearchOpenTaskStep,
});

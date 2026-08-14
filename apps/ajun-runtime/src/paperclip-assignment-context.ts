import { ValidationError } from './task-validation-error.ts';
export async function preparePaperclipAssignmentContext({ governance, tasks, assignmentTask, pipelineCase, activePlanRevision, }: any = {}): Promise<any> {
    const pipelineCaseId: any = assignmentTask?.pipelineCaseId;
    const relatedCaseIds: any = await m5PipelineCaseChainIds({
        governance,
        pipelineCaseId,
        pipelineCase,
    });
    const related: any = m5RelatedTaskContext(tasks, relatedCaseIds, pipelineCase);
    return {
        createTaskInput({ identity, assignmentProjectId }: any = {}): any {
            const caseFields: any = normalizedCaseFields(pipelineCase);
            return {
                title: String(identity.issue.title || 'Paperclip 指派任务').slice(0, 500),
                description: String(identity.issue.description || '').slice(0, 4000),
                topic: caseFields.theme || null,
                contentGoal: caseFields.theme || null,
                platforms: caseFields.platform ? [caseFields.platform] : [],
                sourceUrl: related.sourceUrls[0] || null,
                sourceUrls: related.sourceUrls,
                context: {
                    paperclipIssueIdentifier: identity.issue.identifier || null,
                    ...(assignmentTask?.routineKey ? { paperclipRoutineKey: assignmentTask.routineKey } : {}),
                    ...(pipelineCaseId ? { pipelineCaseId } : {}),
                    ...(assignmentProjectId ? { paperclipProjectId: assignmentProjectId } : {}),
                    ...(activePlanRevision ? {
                        m5Recovery: m5PlanRevisionExecutionContext(activePlanRevision),
                    } : {}),
                    ...(related.sourceTaskIds.length ? { sourceTaskIds: related.sourceTaskIds } : {}),
                    ...(pipelineCase ? { pipelineCase: pipelineCaseContext(pipelineCase, pipelineCaseId, caseFields) } : {}),
                },
            };
        },
        refreshTaskInput(input: any, { assignmentProjectId }: any = {}): any {
            return {
                ...(input || {}),
                context: {
                    ...(input?.context || {}),
                    m5Recovery: activePlanRevision
                        ? m5PlanRevisionExecutionContext(activePlanRevision)
                        : null,
                    ...(assignmentProjectId ? { paperclipProjectId: assignmentProjectId } : {}),
                    ...(related.sourceTaskIds.length ? { sourceTaskIds: related.sourceTaskIds } : {}),
                    ...(pipelineCase ? {
                        pipelineCase: pipelineCaseContext(pipelineCase, pipelineCaseId, normalizedCaseFields(pipelineCase)),
                    } : {}),
                },
            };
        },
        scopeRoleToolGrant(baseRoleToolGrant: any, { task, identity }: any = {}): any {
            if (!baseRoleToolGrant)
                return null;
            return Object.freeze({
                ...baseRoleToolGrant,
                trustedScope: trustedRoleToolScope({
                    tasks,
                    task,
                    relatedTaskIds: related.sourceTaskIds,
                    paperclipIssueId: identity.issue.id,
                    paperclipRunId: identity.run.id,
                    pipelineCaseId,
                }),
            });
        },
        assignmentRecoveryFields(): any {
            return activePlanRevision
                ? { m5Recovery: m5PlanRevisionExecutionContext(activePlanRevision) }
                : {};
        },
    };
}
function normalizedCaseFields(pipelineCase: any): any {
    return paperclipCaseContextFields(pipelineCase?.case?.fields || pipelineCase?.fields || {});
}
function pipelineCaseContext(pipelineCase: any, pipelineCaseId: any, fields: any): any {
    return {
        id: pipelineCase.case?.id || pipelineCase.id || pipelineCaseId,
        parentCaseId: pipelineCase.case?.parentCaseId || pipelineCase.parentCaseId || null,
        caseKey: pipelineCase.case?.caseKey || pipelineCase.caseKey || null,
        title: pipelineCase.case?.title || pipelineCase.title || null,
        stageKey: pipelineCase.case?.stageKey || pipelineCase.stageKey || null,
        fields,
    };
}
export function paperclipCaseContextFields(fields: any): any {
    const source: any = fields && typeof fields === 'object' ? fields : {};
    const allowed: any[] = [
        'campaignId',
        'scheduledDate',
        'theme',
        'platform',
        'contentVersion',
        'contentVersionId',
        'assetRightsBasis',
    ];
    return Object.fromEntries(allowed.flatMap((key: any): any => {
        const value: any = source[key];
        if (typeof value === 'string' && value.trim())
            return [[key, value.trim().slice(0, 500)]];
        if (Number.isInteger(value))
            return [[key, value]];
        return [];
    }));
}
export function m5PlanRevisionExecutionContext(revision: any): any {
    return {
        schemaVersion: revision.schemaVersion,
        revisionId: revision.revisionId,
        revision: revision.revision,
        failedCaseId: revision.failedCaseId,
        failureObservation: {
            issueId: revision.failureObservation?.issueId || null,
            runId: revision.failureObservation?.runId || null,
            stageKey: revision.failureObservation?.stageKey || null,
            summary: revision.failureObservation?.summary || '',
            summaryHash: revision.failureObservation?.summaryHash || null,
        },
        rejectedRoute: {
            kind: revision.rejectedRoute?.kind || null,
            reason: revision.rejectedRoute?.reason || '',
            routeFingerprint: revision.rejectedRoute?.routeFingerprint || null,
            execution: revision.rejectedRoute?.execution || null,
        },
        nextRoute: {
            kind: revision.nextRoute?.kind,
            stageKey: revision.nextRoute?.stageKey,
            preserveVerifiedWorkProducts: revision.nextRoute?.preserveVerifiedWorkProducts === true,
            instruction: revision.nextRoute?.instruction || '',
        },
    };
}
export function trustedRoleToolScope({ tasks, task, relatedTaskIds, paperclipIssueId = null, paperclipRunId = null, pipelineCaseId = null, }: any = {}): any {
    const relatedIds: any = new Set((Array.isArray(relatedTaskIds) ? relatedTaskIds : [])
        .map((item: any): any => String(item || '').trim())
        .filter(Boolean));
    const parentTaskId: any = String(task?.parentTaskId || '').trim();
    const currentTaskId: any = String(task?.taskId || '').trim();
    const allowedTaskIds: any = (Array.isArray(tasks) ? tasks : []).filter((candidate: any): any => candidate?.taskId !== currentTaskId
        && (relatedIds.has(String(candidate?.taskId || ''))
            || (parentTaskId && candidate?.parentTaskId === parentTaskId))).map((candidate: any): any => candidate.taskId);
    return Object.freeze({
        currentTaskId: currentTaskId || null,
        currentAgentId: String(task?.assigneeAgentId || '').trim() || null,
        currentWorkflowId: String(task?.workflow?.workflowId || '').trim() || null,
        currentStepId: String(task?.workflow?.step?.stepId || task?.currentStage || '').trim() || null,
        allowedTaskIds: Object.freeze(allowedTaskIds),
        paperclipIssueId: String(paperclipIssueId || '').trim() || null,
        paperclipRunId: String(paperclipRunId || '').trim() || null,
        pipelineCaseId: String(pipelineCaseId || '').trim() || null,
    });
}
export async function m5PipelineCaseChainIds({ governance, pipelineCaseId, pipelineCase }: any): Promise<any> {
    const firstId: any = String(pipelineCaseId || '').trim();
    if (!firstId)
        return [];
    const caseIds: any[] = [];
    const visited: any = new Set();
    let current: any = pipelineCase?.case || pipelineCase || { id: firstId };
    for (let depth: any = 0; depth < 32; depth += 1) {
        const currentId: any = String(current?.id || (depth === 0 ? firstId : '')).trim();
        if (!currentId || visited.has(currentId)) {
            throw new ValidationError('M5 Pipeline Case 父子链无效或存在循环。');
        }
        caseIds.push(currentId);
        visited.add(currentId);
        const parentCaseId: any = String(current?.parentCaseId || '').trim();
        if (!parentCaseId)
            return caseIds;
        if (typeof governance?.getPipelineCase !== 'function') {
            throw new ValidationError('M5 Pipeline Case 缺少父级读取能力，无法绑定前置产物。');
        }
        const parent: any = await governance.getPipelineCase(parentCaseId);
        current = parent?.case || parent;
        if (!current)
            throw new ValidationError('M5 Pipeline Case 父级不存在，无法绑定前置产物。');
    }
    throw new ValidationError('M5 Pipeline Case 父子链超过安全深度。');
}
export function m5RelatedTaskContext(tasks: any, pipelineCaseIds: any, pipelineCase: any = null): any {
    const allowedCaseIds: any = new Set((Array.isArray(pipelineCaseIds) ? pipelineCaseIds : [pipelineCaseIds])
        .map((item: any): any => String(item || '').trim())
        .filter(Boolean));
    if (!allowedCaseIds.size)
        return { sourceTaskIds: [], sourceUrls: [] };
    const currentFields: any = paperclipCaseContextFields(pipelineCase?.case?.fields || pipelineCase?.fields || {});
    const sameContentDay: any = (candidate: any): any => {
        const fields: any = candidate?.input?.context?.pipelineCase?.fields || {};
        return Boolean(currentFields.campaignId
            && currentFields.scheduledDate
            && fields.campaignId === currentFields.campaignId
            && fields.scheduledDate === currentFields.scheduledDate
            && String(fields.contentVersion || 'v1') === String(currentFields.contentVersion || 'v1'));
    };
    const related: any = (Array.isArray(tasks) ? tasks : [])
        .filter((item: any): any => (allowedCaseIds.has(String(item?.input?.context?.pipelineCaseId || '').trim())
        || sameContentDay(item))
        && item?.governance?.paperclipIssueId
        && !['failed', 'cancelled'].includes(item.status))
        .sort((left: any, right: any): any => Date.parse(left.createdAt || left.updatedAt || 0) - Date.parse(right.createdAt || right.updatedAt || 0));
    const sourceUrls: any = related.flatMap((item: any): any => (item.artifactRefs || []).flatMap((artifact: any): any => {
        if (artifact?.validation?.publicReadOnly !== true)
            return [];
        const sources: any = Array.isArray(artifact.data?.sources) ? artifact.data.sources : [];
        return sources.map((source: any): any => String(source.source || source.url || '').trim())
            .filter((value: any): any => /^https?:\/\//i.test(value));
    }));
    return {
        sourceTaskIds: [...new Set(related.map((item: any): any => item.taskId).filter(Boolean))].slice(-20),
        sourceUrls: [...new Set(sourceUrls)].slice(0, 5),
    };
}

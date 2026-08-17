import { presentTask } from './task-presentation.ts';
import { sanitizeFailureText } from './technical-failure-classifier.ts';
import { queryTaskRecordsInMemory } from './task-record-query.ts';
import { buildWorkflowAcceptanceTarget } from './workflow-acceptance-projection.ts';
export class TaskRecordService {
    store: any;
    taskDetailBaseUrl: any;
    taskRecovery: any;
    paperclipBaseUrl: any;
    capabilityCatalog: any;
    constructor({ store, taskDetailBaseUrl = '', taskRecovery = null, capabilityCatalog = null, paperclipBaseUrl = process.env.PAPERCLIP_URL || 'http://127.0.0.1:3100' }: any) {
        this.store = store;
        this.taskDetailBaseUrl = taskDetailBaseUrl;
        this.taskRecovery = taskRecovery;
        this.capabilityCatalog = capabilityCatalog;
        this.paperclipBaseUrl = safeHttpBaseUrl(paperclipBaseUrl);
    }
    async list(query: any = {}): Promise<any> {
        const exactBacklogCategory: any = String(query.backlogCategory || '').trim();
        const [tasksOrPage, approvals, proposals, workflowAcceptances] = await Promise.all([
            exactBacklogCategory ? this.store.list() : this.store.queryTasks(query),
            this.store.listApprovals(),
            exactBacklogCategory && typeof this.store.listProposals === 'function' ? this.store.listProposals() : [],
            exactBacklogCategory && typeof this.store.listWorkflowAcceptances === 'function' ? this.store.listWorkflowAcceptances() : [],
        ]);
        const page: any = exactBacklogCategory
            ? queryTaskRecordsInMemory(tasksOrPage, query, {
                proposals,
                taskTypeDelegates: this.capabilityCatalog?.openTaskDelegates?.() || {},
                approvals,
                workflowAcceptances,
            })
            : tasksOrPage;
        return {
            ...page,
            items: page.items.map((task: any): any => presentRecordSummary(
                task,
                approvals,
                this.taskDetailBaseUrl,
                exactBacklogCategory ? tasksOrPage : [],
                workflowAcceptances,
            )),
        };
    }
    async detail(taskId: any, { audience = 'lan' }: any = {}): Promise<any> {
        const [task, approvals] = await Promise.all([
            this.store.getTask(taskId),
            this.store.listApprovals(),
        ]);
        if (!task)
            return null;
        const recoveryView: any = typeof this.taskRecovery?.view === 'function'
            ? await this.taskRecovery.view(task, { audience })
            : null;
        let acceptanceTarget: any = null;
        if (audience === 'local-owner' && task?.workflow?.workflowId) {
            const workflowId: any = task.workflow.workflowId;
            const [workflowTasks, acceptance] = await Promise.all([
                typeof this.store.listWorkflowTasks === 'function'
                    ? this.store.listWorkflowTasks(workflowId)
                    : this.store.list().then((items: any[]): any => items.filter((item: any): any => item?.workflow?.workflowId === workflowId)),
                typeof this.store.getWorkflowAcceptance === 'function'
                    ? this.store.getWorkflowAcceptance(workflowId)
                    : null,
            ]);
            acceptanceTarget = buildWorkflowAcceptanceTarget(task, workflowTasks, acceptance);
        }
        return presentRecord(task, approvals, this.taskDetailBaseUrl, recoveryView, audience, this.paperclipBaseUrl, acceptanceTarget);
    }
}
function presentRecordSummary(task: any, approvals: any, detailBaseUrl: any, tasks: any[] = [], acceptances: any[] = []): any {
    const workflowId: any = String(task?.workflow?.workflowId || '').trim();
    const acceptanceTarget: any = workflowId && tasks.length
        ? buildWorkflowAcceptanceTarget(task, tasks, acceptances.find((item: any): any => item?.workflowId === workflowId) || null)
        : null;
    return {
        taskId: task.taskId,
        status: task.status,
        taskType: task.taskType,
        assigneeAgentId: task.assigneeAgentId,
        input: { title: task.input?.title || '' },
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        currentStage: task.currentStage || '',
        recordView: task.recordView,
        recordSummary: true,
        presentation: presentTask(task, { approvals, detailBaseUrl }),
        ...(acceptanceTarget ? { acceptanceTarget } : {}),
    };
}
function presentRecord(task: any, approvals: any, detailBaseUrl: any, recoveryView: any = null, audience: any = 'lan', paperclipBaseUrl: any = '', acceptanceTarget: any = null): any {
    const pendingApproval: any = approvals.find((approval: any): any => approval?.status === 'pending' && (task.approvalRefs || []).includes(approval.approvalId));
    const common: Record<string, any> = {
        taskId: cleanText(task.taskId, 120),
        title: safeText(task.input?.title || task.title, 300) || '未命名任务',
        status: cleanText(task.status, 80) || 'unknown',
        createdAt: safeDate(task.createdAt),
        updatedAt: safeDate(task.updatedAt),
        completedAt: safeDate(task.completedAt || task.execution?.finishedAt),
        artifactRefs: safeArtifactMetadata(task.artifactRefs),
        presentation: presentTask(task, { approvals, detailBaseUrl, recoveryView }),
        pendingApproval: safePendingApproval(pendingApproval),
    };
    if (audience !== 'local-owner')
        return common;
    return {
        ...common,
        paperclipIssue: safePaperclipIssue(task, paperclipBaseUrl),
        taskType: cleanText(task.taskType, 120) || null,
        assigneeAgentId: cleanText(task.assigneeAgentId, 120) || null,
        parentTaskId: cleanText(task.parentTaskId, 120) || null,
        currentStage: cleanText(task.currentStage, 120) || null,
        recordView: cleanText(task.recordView, 80) || null,
        input: safeOwnerInput(task.input),
        error: safeOwnerError(task.error),
        recovery: safeOwnerRecovery(task.recovery),
        paperclipRun: safePaperclipRun(task.execution?.paperclipRun, task.execution, task),
        acceptanceTarget,
    };
}
function safePaperclipRun(value: any, execution: any = {}, task: any = {}): any {
    const run = value && typeof value === 'object' ? value : {};
    const runId: any = cleanText(run.runId || execution?.paperclipRunId, 120);
    if (!/^[a-z0-9][a-z0-9-]{0,119}$/i.test(runId))
        return null;
    return {
        runId,
        status: cleanText(run.status, 80) || paperclipRunStatusFromExecution(execution, task.status),
        startedAt: safeDate(run.startedAt),
        finishedAt: safeDate(run.finishedAt || execution?.finishedAt || task.completedAt),
    };
}
function paperclipRunStatusFromExecution(execution: any, taskStatus: any): any {
    const outcome = cleanText(execution?.outcome, 80);
    if (['succeeded', 'verified_artifact_ready'].includes(outcome))
        return 'succeeded';
    if (['failed', 'paperclip_hermes_failed', 'paperclip_process_exited_without_completion'].includes(outcome))
        return 'failed';
    const status = cleanText(taskStatus, 80);
    if (status === 'succeeded')
        return 'succeeded';
    if (['failed', 'cancelled', 'expired'].includes(status))
        return 'failed';
    return execution?.finishedAt ? 'unknown' : 'running';
}
function safePaperclipIssue(task: any, baseUrl: any): any {
    const issueId: any = safePaperclipIssueRef(task?.governance?.paperclipIssueId);
    const identifier: any = safePaperclipIssueRef(task?.governance?.paperclipIssueIdentifier);
    const ref: any = identifier || issueId;
    if (!ref || !baseUrl)
        return null;
    return {
        identifier: identifier || null,
        detailUrl: new URL(`/issues/${encodeURIComponent(ref)}`, `${baseUrl}/`).toString(),
    };
}
function safePaperclipIssueRef(value: any): any {
    const text: any = cleanText(value, 120);
    return /^[a-z0-9][a-z0-9-]{0,119}$/i.test(text) ? text : '';
}
function safeHttpBaseUrl(value: any): any {
    try {
        const url: any = new URL(String(value || '').trim());
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
            return '';
        url.pathname = '/';
        url.search = '';
        url.hash = '';
        return url.toString().replace(/\/$/, '');
    }
    catch {
        return '';
    }
}
function safeArtifactMetadata(value: any): any {
    if (!Array.isArray(value))
        return [];
    return value.flatMap((artifact: any): any => {
        if (!artifact || typeof artifact !== 'object')
            return [];
        return [{
                artifactId: cleanText(artifact.artifactId, 240) || null,
                type: cleanText(artifact.type, 120) || null,
                title: safeText(artifact.title, 300) || null,
                mimeType: cleanText(artifact.mimeType, 120) || null,
                accessScope: cleanText(artifact.accessScope, 80) || null,
                createdAt: safeDate(artifact.createdAt),
                validation: safeArtifactValidation(artifact.validation),
            }];
    });
}
function safeArtifactValidation(value: any): any {
    if (!value || typeof value !== 'object')
        return null;
    const projected: Record<string, any> = {};
    for (const key of ['exists', 'readable', 'nonEmpty', 'semanticValidationPassed', 'structuralQaPassed', 'testsPassed', 'recoveryVerified']) {
        if (typeof value[key] === 'boolean')
            projected[key] = value[key];
    }
    return Object.keys(projected).length ? projected : null;
}
function safePendingApproval(approval: any): any {
    if (!approval)
        return null;
    const scope: any = safeApprovalScope(approval.requestedScope);
    return {
        approvalId: cleanText(approval.approvalId, 120) || null,
        reason: safeText(approval.reason, 500),
        requestedScope: scope,
    };
}
function safeApprovalScope(value: any): any {
    if (!value || typeof value !== 'object')
        return null;
    const fields: Record<string, any> = {
        title: safeText(value.title, 300) || null,
        taskType: cleanText(value.taskType, 120) || null,
        assigneeAgentId: cleanText(value.assigneeAgentId, 120) || null,
        mode: cleanText(value.mode, 80) || null,
        targets: Array.isArray(value.targets)
            ? value.targets.map((item: any): any => safeText(item, 200)).filter(Boolean).slice(0, 20)
            : null,
    };
    const projected: any = Object.fromEntries(Object.entries(fields).filter(([, item]: any): any => item !== null));
    return Object.keys(projected).length ? projected : null;
}
function safeOwnerInput(value: any): any {
    if (!value || typeof value !== 'object')
        return null;
    return {
        title: safeText(value.title, 300),
        description: safeText(value.description, 2000),
        sourceUrl: safeText(value.sourceUrl, 1000) || null,
        sourceUrls: Array.isArray(value.sourceUrls)
            ? value.sourceUrls.map((item: any): any => safeText(item, 1000)).filter(Boolean).slice(0, 20)
            : [],
        evidenceMode: cleanText(value.evidenceMode, 80) || null,
        analysisIntent: cleanText(value.analysisIntent, 80) || null,
        depth: cleanText(value.depth, 80) || null,
        focus: safeText(value.focus, 500) || null,
        visualMode: cleanText(value.visualMode, 80) || null,
    };
}
function safeOwnerError(value: any): any {
    if (!value || typeof value !== 'object')
        return null;
    return {
        code: cleanText(value.code, 120) || null,
        userMessage: safeText(value.userMessage, 800) || null,
        category: cleanText(value.category, 80) || null,
        stage: cleanText(value.stage, 120) || null,
        retryable: typeof value.retryable === 'boolean' ? value.retryable : null,
        occurredAt: safeDate(value.occurredAt),
    };
}
function safeOwnerRecovery(value: any): any {
    if (!value || typeof value !== 'object')
        return null;
    const coordination: any = value.coordination && typeof value.coordination === 'object'
        ? {
            status: cleanText(value.coordination.status, 80) || null,
            actionKey: cleanText(value.coordination.actionKey, 120) || null,
            retryTaskId: cleanText(value.coordination.retryTaskId, 120) || null,
            technicalTaskId: cleanText(value.coordination.technicalTaskId, 120) || null,
            operatorTaskId: cleanText(value.coordination.operatorTaskId, 120) || null,
            requestedAt: safeDate(value.coordination.requestedAt),
            reason: safeText(value.coordination.reason, 800) || null,
        }
        : null;
    return {
        rootTaskId: cleanText(value.rootTaskId, 120) || null,
        attempt: Number.isSafeInteger(value.attempt) && value.attempt >= 0 ? value.attempt : null,
        mode: cleanText(value.mode, 80) || null,
        coordination,
    };
}
function safeText(value: any, limit: any): any {
    return sanitizeFailureText(value).slice(0, limit);
}
function cleanText(value: any, limit: any): any {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}
function safeDate(value: any): any {
    const text: any = String(value || '').trim();
    return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : null;
}

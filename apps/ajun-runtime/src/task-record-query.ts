import { isOwnerActionableTask } from './task-overview-focus.ts';
import { taskOutcomePolicy } from './task-status-policy.ts';
import { classifyTaskBacklog } from './workflow/backlog-classification.ts';
import { evaluateWorkflowTasks } from './workflow/evaluation.ts';
const VIEW_STATUSES: any = Object.freeze({
    needs_action: new Set(['failed', 'needs_input', 'pending_approval', 'waiting_approval', 'waiting_test', 'paused', 'blocked', 'error']),
    completed: new Set(['succeeded', 'cancelled', 'rejected', 'stopped']),
});
export const TASK_RECORD_VIEWS: any = Object.freeze(['needs_action', 'active', 'completed', 'all']);
export const TASK_BACKLOG_CATEGORIES: any = Object.freeze([
    'owner_actionable',
    'business_active',
    'needs_reverification',
    'unresolved_failures',
    'validated_by_later_evidence',
    'historical_archived',
]);
export function taskRecordView(status: any): any {
    const normalized: any = String(status || '').trim();
    if (VIEW_STATUSES.needs_action.has(normalized))
        return 'needs_action';
    if (VIEW_STATUSES.completed.has(normalized))
        return 'completed';
    return 'active';
}
export function isRoutineHealthTask(task: any): any {
    if (task?.taskType !== 'operations.health-review' || task?.source?.channel !== 'paperclip')
        return false;
    const title: any = String(task.input?.title || '').trim();
    const description: any = String(task.input?.description || '').trim();
    return title === 'A君定时本机巡检' || description.startsWith('agent-army:operations-health-v1');
}
export function isHiddenRoutineTask(task: any, includeRoutine: any = false): any {
    return !includeRoutine && isRoutineHealthTask(task);
}
export function isInternalDiagnosticTask(task: any, tasks: any = []): any {
    if (isReadOnlyDiagnosisTask(task))
        return true;
    if (task?.taskType !== 'governance.assurance-review')
        return false;
    const parentTaskId: any = String(task?.parentTaskId || '').trim();
    return Boolean(parentTaskId) && tasks.some((candidate: any): any => candidate?.taskId === parentTaskId && isReadOnlyDiagnosisTask(candidate));
}
export function taskRecordViewForTask(task: any, tasks: any = []): any {
    if (VIEW_STATUSES.completed.has(task?.status))
        return 'completed';
    if (['pending_approval', 'waiting_approval', 'paused', 'blocked', 'error'].includes(task?.status))
        return 'needs_action';
    if (isApprovedMissionWaitingToResume(task))
        return 'needs_action';
    if (['failed', 'needs_input', 'waiting_test'].includes(task?.status)
        && isOwnerActionableTask(task, tasks))
        return 'needs_action';
    if (['queued', 'running', 'pausing', 'waiting_worker', 'recovery_pending', 'technical_repair'].includes(task?.status))
        return 'active';
    return 'archived';
}
export function isApprovedMissionWaitingToResume(task: any): any {
    return task?.taskType === 'army.cross-agent-mission'
        && task?.status === 'queued'
        && task?.currentStage === 'approval_approved'
        && !task?.artifactRefs?.some((item: any): any => item?.type === 'cross_agent_mission_plan');
}
export function normalizeTaskRecordQuery(input: any = {}): any {
    const requestedView: any = String(input.view || 'needs_action').trim();
    const view: any = TASK_RECORD_VIEWS.includes(requestedView) ? requestedView : 'needs_action';
    const limit: any = Math.max(1, Math.min(Number.parseInt(input.limit, 10) || 24, 50));
    const since: any = validIso(input.since);
    const until: any = validIso(input.until);
    return {
        view,
        backlogCategory: TASK_BACKLOG_CATEGORIES.includes(String(input.backlogCategory || '').trim())
            ? String(input.backlogCategory).trim()
            : '',
        status: clean(input.status, 80),
        q: clean(input.q, 160).toLocaleLowerCase('zh-CN'),
        agentId: clean(input.agentId, 80),
        taskType: clean(input.taskType, 160),
        since,
        until,
        includeRoutine: input.includeRoutine === true || input.includeRoutine === 'true' || input.includeRoutine === '1',
        limit,
        cursor: decodeTaskRecordCursor(input.cursor),
    };
}
export function queryTaskRecordsInMemory(tasks: any, input: any = {}, evidenceContext: any = {}): any {
    const query: any = normalizeTaskRecordQuery(input);
    const ordered: any = [...(Array.isArray(tasks) ? tasks : [])].sort(compareTaskRecords);
    const baseMatches: any = ordered.filter((task: any): any => matchesBaseQuery(task, query));
    const categoryTaskIds: any = backlogCategoryTaskIds(ordered, query.backlogCategory, evidenceContext);
    const exactCategory: any = Boolean(query.backlogCategory);
    const hiddenRoutine: any = exactCategory ? [] : baseMatches.filter((task: any): any => isHiddenRoutineTask(task, query.includeRoutine));
    const visible: any = baseMatches.filter((task: any): any => (exactCategory
        ? categoryTaskIds.has(task.taskId)
        : !isHiddenRoutineTask(task, query.includeRoutine) && !isInternalDiagnosticTask(task, ordered)));
    const counts: any = Object.fromEntries(TASK_RECORD_VIEWS.map((view: any): any => [
        view,
        visible.filter((task: any): any => view === 'all' || taskRecordViewForTask(task, ordered) === view).length,
    ]));
    const selected: any = visible.filter((task: any): any => query.view === 'all' || taskRecordViewForTask(task, ordered) === query.view);
    const afterCursor: any = query.cursor
        ? selected.filter((task: any): any => isAfterCursor(task, query.cursor))
        : selected;
    const page: any = afterCursor.slice(0, query.limit + 1);
    const hasMore: any = page.length > query.limit;
    const items: any = (hasMore ? page.slice(0, query.limit) : page).map((task: any): any => ({
        ...task,
        recordView: taskRecordViewForTask(task, ordered),
    }));
    return {
        items,
        total: counts[query.view],
        counts,
        nextCursor: hasMore ? encodeTaskRecordCursor(items.at(-1)) : null,
        revision: recordRevision(selected, counts),
        routineSummary: routineSummary(hiddenRoutine),
        query: { ...query, cursor: query.cursor ? input.cursor : null },
    };
}
function backlogCategoryTaskIds(tasks: any, category: any, evidenceContext: any): any {
    const ids: any = new Set();
    if (!category)
        return ids;
    if (category === 'owner_actionable') {
        const seenWorkflows: any = new Set();
        for (const task of tasks) {
            if (['waiting_approval', 'needs_input', 'paused', 'failed', 'waiting_test'].includes(task?.status)
                && isOwnerActionableTask(task, tasks)) {
                const workflowId: any = String(task?.workflow?.workflowId || '').trim();
                if (workflowId && seenWorkflows.has(workflowId))
                    continue;
                ids.add(task.taskId);
                if (workflowId)
                    seenWorkflows.add(workflowId);
            }
        }
        for (const workflow of evaluateWorkflowTasks(tasks, evidenceContext.workflowAcceptances || [])) {
            const outcome: any = taskOutcomePolicy(workflow.status);
            if (workflow.workKind !== 'business' || !outcome.ownerActionable || !workflow.ownerAction
                || seenWorkflows.has(workflow.workflowId))
                continue;
            const step: any = workflow.steps.find((item: any): any => item.taskId === workflow.acceptanceTaskId);
            if (step)
                ids.add(step.taskId);
            seenWorkflows.add(workflow.workflowId);
        }
        return ids;
    }
    if (category === 'business_active') {
        for (const task of tasks) {
            if (['pausing', 'running', 'waiting_worker', 'queued'].includes(task?.status) && !isRoutineHealthTask(task))
                ids.add(task.taskId);
        }
        return ids;
    }
    for (const task of tasks) {
        const classification: any = classifyTaskBacklog(task, tasks, evidenceContext);
        const matches: any = category === 'unresolved_failures'
            ? ['unresolved_failure', 'unresolved'].includes(classification)
            : category === 'historical_archived'
                ? ['archived_cancelled', 'superseded', 'expected_acceptance_failure', 'expected_boundary_rejection'].includes(classification)
                : classification === category;
        if (matches)
            ids.add(task.taskId);
    }
    return ids;
}
function isReadOnlyDiagnosisTask(task: any): any {
    return task?.taskType === 'operations.failure-recovery'
        && task?.source?.channel === 'internal-recovery'
        && task?.recovery?.mode === 'read_only_diagnosis'
        && task?.input?.context?.diagnosisOnly === true;
}
export function encodeTaskRecordCursor(task: any): any {
    if (!task)
        return null;
    return Buffer.from(JSON.stringify([
        String(task.updatedAt || task.createdAt || ''),
        String(task.taskId || ''),
    ])).toString('base64url');
}
export function decodeTaskRecordCursor(value: any): any {
    const encoded: any = String(value || '').trim();
    if (!encoded)
        return null;
    try {
        const [updatedAt, taskId] = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
        if (!validIso(updatedAt) || !String(taskId || '').trim())
            return null;
        return { updatedAt, taskId: String(taskId) };
    }
    catch {
        return null;
    }
}
export function taskRecordStatusSets(): any {
    return {
        needsAction: [...VIEW_STATUSES.needs_action],
        completed: [...VIEW_STATUSES.completed],
    };
}
function matchesBaseQuery(task: any, query: any): any {
    const updatedAt: any = String(task.updatedAt || task.createdAt || '');
    if (query.since && updatedAt < query.since)
        return false;
    if (query.until && updatedAt > query.until)
        return false;
    if (query.agentId && String(task.assigneeAgentId || '') !== query.agentId)
        return false;
    if (query.taskType && String(task.taskType || '') !== query.taskType)
        return false;
    if (query.status) {
        if (query.status === 'needs_action') {
            if (!['failed', 'needs_input', 'pending_approval', 'waiting_approval', 'waiting_test', 'paused', 'blocked', 'error'].includes(task.status))
                return false;
        } else if (String(task.status || '') !== query.status) {
            return false;
        }
    }
    if (!query.q)
        return true;
    const haystack: any = [
        task.taskId,
        task.input?.title,
        task.input?.description,
        task.assigneeAgentId,
        task.taskType,
        task.status,
    ].map((value: any): any => String(value || '').toLocaleLowerCase('zh-CN')).join('\n');
    return query.q.split(/\s+/).every((term: any): any => haystack.includes(term));
}
function isAfterCursor(task: any, cursor: any): any {
    const updatedAt: any = String(task.updatedAt || task.createdAt || '');
    return updatedAt < cursor.updatedAt || (updatedAt === cursor.updatedAt && String(task.taskId || '') < cursor.taskId);
}
function compareTaskRecords(left: any, right: any): any {
    const byTime: any = String(right.updatedAt || right.createdAt || '').localeCompare(String(left.updatedAt || left.createdAt || ''));
    return byTime || String(right.taskId || '').localeCompare(String(left.taskId || ''));
}
function recordRevision(tasks: any, counts: any): any {
    const first: any = tasks[0];
    return [first?.updatedAt || first?.createdAt || '', first?.taskId || '', counts.all || 0].join(':');
}
function routineSummary(tasks: any): any {
    const today: any = new Date().toISOString().slice(0, 10);
    return {
        hidden: tasks.length,
        today: tasks.filter((task: any): any => String(task.updatedAt || task.createdAt || '').startsWith(today)).length,
        attention: tasks.filter((task: any): any => taskRecordView(task.status) === 'needs_action').length,
        latestUpdatedAt: tasks[0]?.updatedAt || tasks[0]?.createdAt || null,
    };
}
function validIso(value: any): any {
    const text: any = String(value || '').trim();
    return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : '';
}
function clean(value: any, limit: any): any {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

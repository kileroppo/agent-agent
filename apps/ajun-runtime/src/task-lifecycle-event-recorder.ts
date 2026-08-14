import crypto from 'node:crypto';
import { taskLifecycleEventPolicy } from './task-status-policy.ts';
export class TaskLifecycleEventRecorder {
    eventStore: any;
    constructor({ eventStore = null }: any = {}) {
        this.eventStore = eventStore;
    }
    recordCreated(task: any, startedAt: any): any {
        if (!this.eventStore)
            return;
        const occurredAt: any = timestamp(task.createdAt || startedAt);
        this.append({
            ...identityFor(task),
            eventId: `task-received:${task.taskId}`,
            eventType: 'task_received',
            status: task.status,
            startedAt: occurredAt,
        });
        this.append({
            ...identityFor(task),
            eventId: `delivery-brief:${task.taskId}`,
            eventType: 'delivery_brief_resolved',
            status: task.deliveryBrief?.readiness,
            startedAt: offset(occurredAt, 1),
        });
        this.recordPersisted(task, { startedAt: offset(occurredAt, 2), force: true });
    }
    recordPersisted(task: any, { previousTask = null, startedAt = null, force = false }: any = {}): any {
        if (!this.eventStore || !task?.taskId)
            return;
        const occurredAt: any = timestamp(startedAt || task.updatedAt || task.execution?.updatedAt || task.createdAt);
        const artifactRefs: any = artifactIds(task);
        const previousArtifacts: any = artifactIds(previousTask);
        if (artifactRefs.length && (force || !sameValues(artifactRefs, previousArtifacts))) {
            this.append({
                ...identityFor(task),
                eventId: `artifacts:${task.taskId}:${digest(artifactRefs)}`,
                eventType: 'artifact_committed',
                status: 'recorded',
                startedAt: occurredAt,
                artifactRefs,
                retentionClass: 'audit',
            });
        }
        if (!force && sameLifecycleState(previousTask, task))
            return;
        const eventPolicy: any = taskLifecycleEventPolicy(task.status);
        this.append({
            ...identityFor(task),
            eventId: `workflow-state:${task.taskId}:${digest(lifecycleIdentity(task))}`,
            eventType: eventPolicy.eventType,
            status: task.status,
            startedAt: offset(occurredAt, artifactRefs.length ? 1 : 0),
            errorCode: task.error?.code || null,
            safeSummary: task.currentStage,
            retentionClass: eventPolicy.retentionClass,
        });
    }
    append(event: any): any {
        try {
            this.eventStore.appendTaskRunEvent(event);
        }
        catch (error: any) {
            if (error?.code !== 'task_run_event_exists')
                void error;
        }
    }
}
function identityFor(task: any): any {
    return {
        taskId: task.taskId,
        workflowId: task.workflow?.workflowId || null,
        stepId: task.workflow?.stepId || null,
        agentId: task.assigneeAgentId || task.execution?.executor || null,
        attempt: task.recovery?.attempt ?? task.attempt ?? null,
    };
}
function lifecycleIdentity(task: any): any {
    return [
        task.status || '',
        task.currentStage || '',
        task.error?.code || '',
        task.execution?.outcome || '',
        task.deliveryQualityRuntime?.status || '',
        task.recovery?.attempt ?? task.attempt ?? '',
    ];
}
function sameLifecycleState(left: any, right: any): any {
    if (!left)
        return false;
    return sameValues(lifecycleIdentity(left), lifecycleIdentity(right));
}
function artifactIds(task: any): any {
    return [...new Set((task?.artifactRefs || []).map((item: any): any => String(item?.artifactId || '').trim()).filter(Boolean))].sort();
}
function sameValues(left: any, right: any): any {
    return left.length === right.length && left.every((value: any, index: any): any => value === right[index]);
}
function digest(values: any): any {
    return crypto.createHash('sha256').update(values.join('|')).digest('hex').slice(0, 20);
}
function timestamp(value: any): any {
    const time: any = Date.parse(value || '');
    return Number.isFinite(time) ? new Date(time).toISOString() : new Date().toISOString();
}
function offset(value: any, milliseconds: any): any {
    return new Date(Date.parse(value) + milliseconds).toISOString();
}

import crypto from 'node:crypto';

const BLOCKED_STATUSES = new Set(['failed', 'waiting_test', 'needs_input', 'waiting_approval', 'paused']);

export class TaskLifecycleEventRecorder {
  constructor({ eventStore = null } = {}) {
    this.eventStore = eventStore;
  }

  recordCreated(task, startedAt) {
    if (!this.eventStore) return;
    const occurredAt = timestamp(task.createdAt || startedAt);
    this.append({
      ...identityFor(task),
      eventId:`task-received:${task.taskId}`,
      eventType:'task_received',
      status:task.status,
      startedAt:occurredAt,
    });
    this.append({
      ...identityFor(task),
      eventId:`delivery-brief:${task.taskId}`,
      eventType:'delivery_brief_resolved',
      status:task.deliveryBrief?.readiness,
      startedAt:offset(occurredAt, 1),
    });
    this.recordPersisted(task, { startedAt:offset(occurredAt, 2), force:true });
  }

  recordPersisted(task, { previousTask = null, startedAt = null, force = false } = {}) {
    if (!this.eventStore || !task?.taskId) return;
    const occurredAt = timestamp(startedAt || task.updatedAt || task.execution?.updatedAt || task.createdAt);
    const artifactRefs = artifactIds(task);
    const previousArtifacts = artifactIds(previousTask);
    if (artifactRefs.length && (force || !sameValues(artifactRefs, previousArtifacts))) {
      this.append({
        ...identityFor(task),
        eventId:`artifacts:${task.taskId}:${digest(artifactRefs)}`,
        eventType:'artifact_committed',
        status:'recorded',
        startedAt:occurredAt,
        artifactRefs,
        retentionClass:'audit',
      });
    }

    if (!force && sameLifecycleState(previousTask, task)) return;
    this.append({
      ...identityFor(task),
      eventId:`workflow-state:${task.taskId}:${digest(lifecycleIdentity(task))}`,
      eventType:eventTypeFor(task.status),
      status:task.status,
      startedAt:offset(occurredAt, artifactRefs.length ? 1 : 0),
      errorCode:task.error?.code || null,
      safeSummary:task.currentStage,
      retentionClass:task.status === 'succeeded' || BLOCKED_STATUSES.has(task.status)
        ? 'audit'
        : 'transient',
    });
  }

  append(event) {
    try {
      this.eventStore.appendTaskRunEvent(event);
    } catch (error) {
      if (error?.code !== 'task_run_event_exists') void error;
    }
  }
}

function identityFor(task) {
  return {
    taskId:task.taskId,
    workflowId:task.workflow?.workflowId || null,
    stepId:task.workflow?.stepId || null,
    agentId:task.assigneeAgentId || task.execution?.executor || null,
  };
}

function eventTypeFor(status) {
  if (status === 'succeeded') return 'workflow_completed';
  if (BLOCKED_STATUSES.has(status)) return 'workflow_blocked';
  return 'workflow_state_changed';
}

function lifecycleIdentity(task) {
  return [
    task.status || '',
    task.currentStage || '',
    task.error?.code || '',
    task.execution?.outcome || '',
    task.deliveryQualityRuntime?.status || '',
  ];
}

function sameLifecycleState(left, right) {
  if (!left) return false;
  return sameValues(lifecycleIdentity(left), lifecycleIdentity(right));
}

function artifactIds(task) {
  return [...new Set((task?.artifactRefs || []).map((item) => String(item?.artifactId || '').trim()).filter(Boolean))].sort();
}

function sameValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function digest(values) {
  return crypto.createHash('sha256').update(values.join('|')).digest('hex').slice(0, 20);
}

function timestamp(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? new Date(time).toISOString() : new Date().toISOString();
}

function offset(value, milliseconds) {
  return new Date(Date.parse(value) + milliseconds).toISOString();
}

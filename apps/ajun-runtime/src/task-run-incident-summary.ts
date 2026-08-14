import crypto from 'node:crypto';
const INCIDENT_EVENT_TYPES: any = new Set([
    'capability_call_failed', 'capability_result_ambiguous', 'workflow_blocked',
]);
const INCIDENT_STATUSES: any = new Set(['failed', 'ambiguous', 'blocked', 'error']);
export function isIncidentTaskRunEvent(event: any): any {
    return INCIDENT_EVENT_TYPES.has(event?.eventType)
        || INCIDENT_STATUSES.has(event?.status)
        || Boolean(event?.errorCode);
}
export function buildTaskRunIncidentSummary(taskId: any, events: any, { now = new Date().toISOString() }: any = {}): any {
    const ordered: any = [...events].sort((left: any, right: any): any => left.startedAt.localeCompare(right.startedAt) || left.eventId.localeCompare(right.eventId));
    const incidents: any = ordered.filter(isIncidentTaskRunEvent);
    if (incidents.length === 0)
        return null;
    const routes: any = ordered.filter((event: any): any => event.routeId).map((event: any): any => ({
        capabilityId: event.capabilityId || null,
        routeId: event.routeId,
        provider: event.provider || null,
        status: event.status || null,
    }));
    const final: any = ordered.at(-1);
    return Object.freeze({
        schemaVersion: 'agent.army/task-run-incident-summary/v1',
        incidentId: crypto.createHash('sha256').update(`task-run-incident:${taskId}`).digest('hex').slice(0, 32),
        taskId,
        firstOccurredAt: incidents[0].startedAt,
        lastOccurredAt: incidents.at(-1).finishedAt || incidents.at(-1).startedAt,
        generatedAt: new Date(now).toISOString(),
        errorCodes: [...new Set(incidents.map((event: any): any => event.errorCode).filter(Boolean))],
        capabilityIds: [...new Set(incidents.map((event: any): any => event.capabilityId).filter(Boolean))],
        routePath: dedupeRoutePath(routes).slice(0, 24),
        finalStatus: final?.status || null,
        finalEventType: final?.eventType || null,
        artifactRefs: [...new Set(ordered.flatMap((event: any): any => event.artifactRefs || []))].slice(0, 24),
        eventCount: ordered.length,
        incidentEventCount: incidents.length,
    });
}
function dedupeRoutePath(routes: any): any {
    return routes.filter((route: any, index: any): any => index === 0
        || JSON.stringify(route) !== JSON.stringify(routes[index - 1]));
}

import { ValidationError } from './task-service-execution-support.ts';
const EVENT_STATUSES: any = Object.freeze({
    capability_call_started: 'running',
    capability_call_succeeded: 'success',
    capability_call_failed: 'failed',
    capability_result_ambiguous: 'ambiguous',
});
export class TaskLocalAiRunEventRecorder {
    eventStore: any;
    registry: any;
    resolveAssignment: any;
    constructor({ eventStore, registry, resolveAssignment }: any) {
        this.eventStore = eventStore;
        this.registry = registry;
        this.resolveAssignment = resolveAssignment;
    }
    async record(input: any = {}): Promise<any> {
        if (!this.eventStore?.appendTaskRunEvent)
            throw new ValidationError('任务运行事件存储不可用。');
        const { task, assignment } = await this.resolveAssignment(input);
        if (!task?.taskId || String(input.taskId || '').trim() !== task.taskId) {
            throw new ValidationError('本机 AI 运行事件没有绑定当前真实指派任务，已拒绝写入。');
        }
        const event: any = recordValue(input.event);
        const eventType: any = String(event.eventType || '').trim();
        if (!EVENT_STATUSES[eventType] || event.status !== EVENT_STATUSES[eventType]) {
            throw new ValidationError('本机 AI 运行事件类型或状态无效。');
        }
        const capabilityId: any = String(event.capabilityId || '').trim();
        const agent: any = await this.registry.get(assignment.agentId);
        if (!agent?.runtimeCapabilities?.localAiCapabilities?.includes(capabilityId)) {
            throw new ValidationError('当前岗位没有这项本机 AI 能力，拒绝写入运行事件。');
        }
        const provider: any = String(event.provider || 'local-ai').trim().slice(0, 120) || 'local-ai';
        const saved: any = this.eventStore.appendTaskRunEvent({
            taskId: task.taskId,
            workflowId: task.workflow?.workflowId || null,
            stepId: 'paperclip-local-ai',
            agentId: assignment.agentId,
            traceId: `paperclip:${assignment.runId}`,
            spanId: String(event.spanId || '').trim().slice(0, 120) || null,
            eventType,
            capabilityId,
            routeId: 'local-ai-gateway',
            provider,
            attempt: Number.isInteger(task.recovery?.attempt)
                ? task.recovery.attempt
                : Number.isInteger(task.attempt) ? task.attempt : 1,
            status: EVENT_STATUSES[eventType],
            startedAt: String(event.startedAt || '').trim(),
            finishedAt: String(event.finishedAt || '').trim() || null,
            durationMs: Number.isSafeInteger(event.durationMs) && event.durationMs >= 0 ? event.durationMs : null,
            receiptId: String(event.receiptId || '').trim().slice(0, 160) || null,
            errorCode: ['capability_call_failed', 'capability_result_ambiguous'].includes(eventType)
                ? String(event.errorCode || 'local_ai_failed').trim().slice(0, 120)
                : null,
            safeSummary: eventSummary(eventType, capabilityId, provider),
        });
        return { recorded: true, eventId: saved.eventId, taskId: task.taskId };
    }
}
function recordValue(value: any): any {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function eventSummary(eventType: any, capabilityId: any, provider: any): any {
    if (eventType === 'capability_call_started')
        return `${capabilityId} 已开始调用本机登记路线。`;
    if (eventType === 'capability_call_succeeded')
        return `${capabilityId} 已由 ${provider} 返回确认回执。`;
    if (eventType === 'capability_result_ambiguous')
        return `${capabilityId} 的本机调用结果无法确认；已停止，不会自动重试。`;
    return `${capabilityId} 的本机登记路线确认失败；未执行自动重试。`;
}

import { getM5RoutineExecutionContract } from '@agent-army/m5-kernel/routine-execution-contract';
export const PAPERCLIP_EMPLOYEE_EXECUTOR_AGENT_IDS: any = Object.freeze([
    'ajun',
    'intel-researcher',
    'xiaod',
    'office-assistant',
]);
const PAPERCLIP_EMPLOYEE_EXECUTOR_AGENT_ID_SET: any = new Set(PAPERCLIP_EMPLOYEE_EXECUTOR_AGENT_IDS);
export function resolvePaperclipAssignmentTaskType({ agent, issue, projectedTask = null }: any = {}): any {
    const agentId: any = String(agent?.agentId || '').trim();
    const routineKey: any = paperclipRoutineKey(issue);
    if (!routineKey)
        return {
            taskType: resolveGeneralPaperclipTaskType(agent, issue, projectedTask),
            routineKey: null,
            pipelineCaseId: null,
        };
    const assignment: any = getM5RoutineExecutionContract(routineKey);
    if (!assignment) {
        throw new Error(`当前 M5 Routine 尚未登记任务类型映射：${routineKey}。`);
    }
    if (assignment.executionMode !== 'hermes') {
        throw new Error(`M5 Routine ${routineKey} 由 ${assignment.systemController} 确定性控制器执行，不能创建 Hermes 员工任务。`);
    }
    if (assignment.agentId !== agentId) {
        throw new Error(`M5 Routine ${routineKey} 不属于当前岗位 ${agentId || 'unknown'}。`);
    }
    if (!agent.acceptedTaskTypes?.includes(assignment.taskType)) {
        throw new Error(`岗位 ${agentId} 尚未声明任务类型 ${assignment.taskType}。`);
    }
    return {
        taskType: assignment.taskType,
        routineKey,
        pipelineCaseId: paperclipPipelineCaseId(issue),
    };
}
function resolveGeneralPaperclipTaskType(agent: any, issue: any, projectedTask: any): any {
    const accepted: any[] = Array.isArray(agent?.acceptedTaskTypes)
        ? agent.acceptedTaskTypes.map((value: any): any => String(value || '').trim()).filter(Boolean)
        : [];
    const projectedTaskType: any = String(projectedTask?.taskType || '').trim();
    if (projectedTaskType) {
        if (!accepted.includes(projectedTaskType)) {
            throw new Error(`A君投影任务类型 ${projectedTaskType} 未获当前岗位声明。`);
        }
        return projectedTaskType;
    }
    if (String(agent?.agentId || '').trim() !== 'intel-researcher') {
        return accepted[0] || '';
    }
    const text: any = `${String(issue?.title || '')}\n${String(issue?.description || '')}`;
    const urls: any[] = text.match(/https?:\/\/[^\s<>()\[\]{}"']+/gi) || [];
    const githubRequest: any = urls.some((url: any): any => /https?:\/\/(?:www\.)?github\.com\//i.test(url))
        || /(?:^|\s)(?:github|git hub|开源仓库|代码仓库)(?:\s|$)/i.test(text);
    if (githubRequest && accepted.includes('research.github-search')) {
        return 'research.github-search';
    }
    if (urls.length && accepted.includes('report.public-material')) {
        return 'report.public-material';
    }
    if (accepted.includes('research.intel-report')) {
        return 'research.intel-report';
    }
    return accepted[0] || '';
}
export function assertPaperclipEmployeeExecutorAssignment({ agent, task }: any = {}): any {
    const agentId: any = String(agent?.agentId || '').trim();
    const taskType: any = String(task?.taskType || '').trim();
    if (!PAPERCLIP_EMPLOYEE_EXECUTOR_AGENT_ID_SET.has(agentId)) {
        throw new Error('当前岗位不允许调用通用员工指派执行器。');
    }
    if (task?.assigneeAgentId !== agentId) {
        throw new Error('当前 A君任务信封与 Paperclip 岗位身份不一致。');
    }
    if (!agent.acceptedTaskTypes?.includes(taskType)) {
        throw new Error(`当前岗位未获准执行任务类型 ${taskType || 'unknown'}。`);
    }
    return { agentId, taskType };
}
export function paperclipRoutineKey(issue: any): any {
    const text: any = `${String(issue?.title || '')}\n${String(issue?.description || '')}`;
    return text.match(/\[agent-army:m5:routine:([a-z0-9-]+)\]/i)?.[1]?.toLowerCase() || null;
}
function paperclipPipelineCaseId(issue: any): any {
    const text: any = String(issue?.description || '');
    return text.match(/当前 Case 为 ([0-9a-f-]{8,80})/i)?.[1] || null;
}

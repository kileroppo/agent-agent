import { DEFAULT_TASK_DEFINITION_REGISTRY } from './task-definition-registry.ts';
import { formatPublicReportReply } from './public-report-presentation.ts';
import { presentTask, shortTaskRef } from './task-presentation.ts';
export function projectTaskNotification(task: any = {}, { detailBaseUrl = '', reply, status = null, projectionTruth = null, }: any = {}): any {
    const projectedTask: any = projectTaskTruth(task, { status, projectionTruth });
    const artifacts: any = indexArtifacts(projectedTask.artifactRefs);
    const presentation: any = presentTask(projectedTask, { detailBaseUrl });
    const statusReply: any = statusMessage(projectedTask, artifacts);
    return {
        task: projectedTask,
        artifacts,
        presentation,
        statusReply,
        reply: composeReply(reply, projectedTask.taskId, presentation),
    };
}
function projectTaskTruth(task: any, { status, projectionTruth }: any): any {
    if (!status)
        return task;
    if (!projectionTruth)
        return { ...task, status };
    return {
        ...task,
        status,
        updatedAt: latestTruthTimestamp(task.updatedAt, projectionTruth.updatedAt),
        presentationRevision: [
            task.presentationRevision ?? task.revision ?? '0', projectionTruth.taskId,
            projectionTruth.revision ?? '0', projectionTruth.status, status,
        ].map((value: any): any => String(value || '')).join(':'),
    };
}
function indexArtifacts(artifactRefs: any): any {
    const indexed: any = Object.create(null);
    for (const artifact of Array.isArray(artifactRefs) ? artifactRefs : []) {
        const type: any = String(artifact?.type || '').trim();
        if (type && !indexed[type])
            indexed[type] = artifact;
    }
    return indexed;
}
function statusMessage(task: any, artifacts: any): any {
    const worker: any = DEFAULT_TASK_DEFINITION_REGISTRY.workerName(task) || '负责的员工';
    const titleText: any = shortTitle(task);
    const title: any = `“${titleText}”`;
    const publicReport: any = artifacts.public_web_report?.data;
    if (task.status === 'running' || task.status === 'queued')
        return `${title}正在由${worker}处理。完成后会回到当前飞书会话。`;
    if (task.status === 'succeeded' && publicReport?.summary)
        return formatPublicReportReply(publicReport, { taskTitle: titleText });
    if (task.status === 'succeeded')
        return `${title}已经完成，结果已发回当前飞书会话。`;
    if (task.status === 'failed' && task.error?.code === 'executor_failed' && !task.execution?.xiaodJobId) {
        return '这条任务当时没能交到小D处理，现在已经恢复。请重新发送同一个视频链接，我会重新处理。';
    }
    if (task.status === 'failed')
        return `${title}暂时没有完成：${task.error?.userMessage || `${worker}处理时遇到问题`}。我已保留原因并继续跟进。`;
    if (task.status === 'waiting_test')
        return `${title}现在是待测试，测试项已记录；其他工作会继续推进。`;
    if (task.status === 'needs_input')
        return task.error?.userMessage || `${title}还缺少必要信息，暂时不能继续。`;
    if (task.status === 'waiting_approval')
        return `${title}正在等你确认范围；确认前不会继续。`;
    if (task.status === 'pausing')
        return `${title}正在暂停，会在当前步骤结束后的安全位置停下。`;
    if (task.status === 'paused')
        return `${title}已经暂停，确认继续前不会开始新的处理步骤。`;
    return `${title}已收到，正在等待开始处理。`;
}
function composeReply(value: any, taskId: any, presentation: any): any {
    const normalizedTaskId: any = String(taskId || '').trim();
    const link: any = presentation.detailUrl
        ? `[查看任务 ${shortTaskRef(normalizedTaskId)}](${presentation.detailUrl})`
        : `任务 ${shortTaskRef(normalizedTaskId)}`;
    const nextAction: any = String(presentation.nextAction || '').trim();
    let reply: any = String(value || '').trim() || String(presentation.summary || '').trim();
    if (normalizedTaskId && reply.includes(normalizedTaskId))
        reply = reply.replaceAll(normalizedTaskId, link);
    const hasTaskReference: any = reply.includes(presentation.detailUrl || '\0')
        || reply.includes(shortTaskRef(normalizedTaskId));
    const hasExplicitNextAction: any = /(?:^|\n)(?:下一步|你现在要做)\s*[：:]/m.test(reply);
    const alreadyStatesNextAction: any = nextAction && normalizeReplyText(reply).includes(normalizeReplyText(nextAction));
    const footer: any[] = [];
    if (nextAction && !hasExplicitNextAction && !alreadyStatesNextAction)
        footer.push(`下一步：${nextAction}`);
    if (!hasTaskReference)
        footer.push(link);
    return footer.length ? `${reply}\n\n${footer.join('\n')}` : reply;
}
function latestTruthTimestamp(...values: any): any {
    return values
        .map((value: any): any => String(value || '').trim())
        .filter((value: any): any => value && Number.isFinite(Date.parse(value)))
        .map((value: any): any => new Date(value).toISOString())
        .sort()
        .at(-1) || null;
}
function normalizeReplyText(value: any): any {
    return String(value || '').replace(/\s+/g, '').replace(/[。；;，,！!？?]/g, '');
}
function shortTitle(task: any): any { return String(task.input?.title || '未命名任务').replace(/\s+/g, ' ').slice(0, 48); }

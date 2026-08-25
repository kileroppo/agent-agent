import { confirmedTranscriptFor, confirmedTranscriptOnlyEligible, uniqueStrings } from './task-recovery-policy.ts';

export async function resumeApprovedMissionRecovery({ task, requestId, requestedBy, resumeApprovedMission, record, clock, errorFactory }: any): Promise<any> {
    if (typeof resumeApprovedMission !== 'function')
        throw errorFactory('已批准任务的继续入口暂不可用，任务没有被更改。', 'approved_mission_resume_unavailable', 503);
    const resumedTask: any = await resumeApprovedMission(task);
    const attempt: any = Number(task.recovery?.attempt || 0) + 1;
    await record(task.taskId, {
        status: 'completed', actionKey: 'resume_approved_mission', requestId, requestedBy, attempt, reason: '已从批准后的规划阶段继续处理。',
    }, {
        event: 'resumed', actionKey: 'resume_approved_mission', requestId, attempt, actor: requestedBy, occurredAt: clock().toISOString(),
    });
    return { resumedTask };
}

export async function useConfirmedTranscriptOnlyRecovery({ task, tasks, requestId, requestedBy, createTask, record, clock, errorFactory }: any): Promise<any> {
    if (typeof createTask !== 'function')
        throw errorFactory('确认稿恢复入口暂不可用，未创建子任务。', 'task_recovery_unavailable', 503);
    const transcript: any = confirmedTranscriptFor(task, tasks);
    if (!transcript || !confirmedTranscriptOnlyEligible(task, tasks))
        throw errorFactory('没有找到可核验确认稿，或当前任务不允许关闭视觉后重试。', 'confirmed_transcript_recovery_not_allowed', 422);
    const paperclipIssueId: any = String(task.governance?.paperclipIssueId || '').trim();
    if (!paperclipIssueId)
        throw errorFactory('原 Paperclip 任务关联不存在，未创建无审计关联的重试。', 'paperclip_parent_issue_required', 503);
    const sourceTaskIds: any = uniqueStrings([...(task.input?.context?.sourceTaskIds || []), transcript.taskId]);
    const rootTaskId: any = task.recovery?.rootTaskId || task.taskId;
    const retryTask: any = await createTask({
        title: `${task.input?.title || '视频内容拆解'}（仅使用确认稿）`,
        description: '按本机主人明确选择，仅使用已核验确认稿完成文本拆解；关闭视觉分析，不读取图片、不调用视觉 Provider。',
        taskType: 'content.video-benchmark-analysis',
        agentId: task.assigneeAgentId,
        requester: { kind: 'local-owner', ref: requestedBy.ref },
        source: { channel: 'internal-recovery', parentChannel: task.source?.channel || null, chatRef: task.source?.chatRef || null },
        parentTaskId: task.taskId,
        sourceUrl: task.input?.sourceUrl,
        sourceUrls: task.input?.sourceUrls,
        evidenceMode: 'formal',
        analysisIntent: task.input?.analysisIntent,
        depth: task.input?.depth,
        focus: task.input?.focus,
        visualMode: 'off',
        context: {
            ...(task.input?.context || {}),
            sourceTaskIds,
            parentPaperclipIssueId: paperclipIssueId,
            recoveryFromTaskId: task.taskId,
            confirmedTranscriptTaskId: transcript.taskId,
            confirmedTranscriptArtifactId: transcript.artifact.artifactId || null,
        },
        idempotencyKey: `recovery-confirmed-transcript:${task.taskId}`,
        recovery: { rootTaskId, attempt: Number(task.recovery?.attempt || 0) + 1, triggeredByTaskId: task.taskId, mode: 'confirmed_transcript_only', requestId },
    });
    await record(task.taskId, {
        status: 'retrying', actionKey: 'use_confirmed_transcript_only', requestId, requestedBy, retryTaskId: retryTask.taskId, attempt: Number(task.recovery?.attempt || 0) + 1, reason: '已创建仅使用确认稿且 visualMode=off 的 Paperclip 子任务。',
    }, {
        event: 'child_created', actionKey: 'use_confirmed_transcript_only', requestId, attempt: Number(task.recovery?.attempt || 0) + 1, actor: requestedBy, taskId: retryTask.taskId, occurredAt: clock().toISOString(),
    });
    return { retryTask };
}

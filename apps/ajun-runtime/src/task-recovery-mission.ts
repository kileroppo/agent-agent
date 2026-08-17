export async function resumeApprovedMissionRecovery({
    task,
    requestId,
    requestedBy,
    resumeApprovedMission,
    record,
    clock,
    errorFactory,
}: any): Promise<any> {
    if (typeof resumeApprovedMission !== 'function')
        throw errorFactory('已批准任务的继续入口暂不可用，任务没有被更改。', 'approved_mission_resume_unavailable', 503);
    const resumedTask: any = await resumeApprovedMission(task);
    const attempt: any = Number(task.recovery?.attempt || 0) + 1;
    await record(task.taskId, {
        status: 'completed',
        actionKey: 'resume_approved_mission',
        requestId,
        requestedBy,
        attempt,
        reason: '已从批准后的规划阶段继续处理。',
    }, {
        event: 'resumed',
        actionKey: 'resume_approved_mission',
        requestId,
        attempt,
        actor: requestedBy,
        occurredAt: clock().toISOString(),
    });
    return { resumedTask };
}

import { writeLocalVideoScriptProductionPackage } from './local-video-script-production-package.ts';
export async function approveLocalVideoScriptPackage({ task, tasks, artifactsDir, now }: any): Promise<any> {
    const sourceTaskIds: any = new Set([
        clean(task.input?.sourceScriptTaskId, 120),
        ...(Array.isArray(task.input?.context?.sourceTaskIds)
            ? task.input.context.sourceTaskIds.map((item: any): any => clean(item, 120))
            : []),
    ].filter(Boolean));
    const source: any = [...tasks]
        .filter((item: any): any => sourceTaskIds.has(item.taskId)
        || (!sourceTaskIds.size && item.source?.chatRef && item.source.chatRef === task.source?.chatRef))
        .sort((left: any, right: any): any => taskTime(right) - taskTime(left))
        .flatMap((item: any): any => item.artifactRefs || [])
        .find((item: any): any => item.type === 'video_script_package'
        && item.data?.templateLifecycle?.approvedForUse !== true);
    if (!source)
        return { error: { code: 'script_package_required', userMessage: '当前会话里没有可采用的脚本，请先让我生成一版脚本。' } };
    const completedAt: any = now().toISOString();
    const artifact: any = await writeLocalVideoScriptProductionPackage({
        artifactsDir,
        task,
        data: {
            ...source.data,
            templateLifecycle: {
                caseOnly: false,
                state: 'trial',
                approvedForUse: true,
                approvedAt: completedAt,
                sourceScriptArtifactId: source.artifactId,
            },
            generatedAt: completedAt,
        },
        sources: Array.isArray(source.data?.sources) ? source.data.sources : [],
        sourceRefs: [source.artifactId, ...(source.sourceRefs || [])],
        completedAt,
    });
    return { artifact, completedAt };
}
function taskTime(task: any): any {
    return Date.parse(task?.updatedAt || task?.createdAt || 0) || 0;
}
function clean(value: any, limit: any): any {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

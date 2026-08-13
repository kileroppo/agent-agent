import { writeLocalVideoScriptProductionPackage } from './local-video-script-production-package.js';

export async function approveLocalVideoScriptPackage({ task, tasks, artifactsDir, now }) {
  const sourceTaskIds = new Set([
    clean(task.input?.sourceScriptTaskId, 120),
    ...(Array.isArray(task.input?.context?.sourceTaskIds)
      ? task.input.context.sourceTaskIds.map((item) => clean(item, 120))
      : []),
  ].filter(Boolean));
  const source = [...tasks]
    .filter((item) => sourceTaskIds.has(item.taskId)
      || (!sourceTaskIds.size && item.source?.chatRef && item.source.chatRef === task.source?.chatRef))
    .sort((left, right) => taskTime(right) - taskTime(left))
    .flatMap((item) => item.artifactRefs || [])
    .find((item) => item.type === 'video_script_package'
      && item.data?.templateLifecycle?.approvedForUse !== true);
  if (!source) return { error:{ code:'script_package_required', userMessage:'当前会话里没有可采用的脚本，请先让我生成一版脚本。' } };

  const completedAt = now().toISOString();
  const artifact = await writeLocalVideoScriptProductionPackage({
    artifactsDir,
    task,
    data:{
      ...source.data,
      templateLifecycle:{
        caseOnly:false,
        state:'trial',
        approvedForUse:true,
        approvedAt:completedAt,
        sourceScriptArtifactId:source.artifactId,
      },
      generatedAt:completedAt,
    },
    sources:Array.isArray(source.data?.sources) ? source.data.sources : [],
    sourceRefs:[source.artifactId, ...(source.sourceRefs || [])],
    completedAt,
  });
  return { artifact, completedAt };
}

function taskTime(task) {
  return Date.parse(task?.updatedAt || task?.createdAt || 0) || 0;
}

function clean(value, limit) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

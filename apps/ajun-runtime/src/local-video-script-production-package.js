import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function writeLocalVideoScriptProductionPackage({
  artifactsDir,
  task,
  data,
  sources,
  sourceRefs,
  sourceTaskBindings = [],
  completedAt,
}) {
  const directory = path.join(
    artifactsDir,
    safeSegment(task.taskId),
    'video-script-package',
  );
  await fs.mkdir(directory, { recursive:true, mode:0o700 });

  const paths = {
    script:path.join(directory, 'script.md'),
    shots:path.join(directory, 'shots.json'),
    subtitles:path.join(directory, 'subtitles.srt'),
    sources:path.join(directory, 'sources.md'),
    manifest:path.join(directory, 'manifest.json'),
  };
  const script = renderScript(data);
  const shots = `${JSON.stringify(data.shots, null, 2)}\n`;
  const subtitles = renderSrt(data.shots);
  const sourceText = renderSources(sources, sourceRefs);
  await Promise.all([
    writePrivate(paths.script, script),
    writePrivate(paths.shots, shots),
    writePrivate(paths.subtitles, subtitles),
    writePrivate(paths.sources, sourceText),
  ]);

  const files = await Promise.all([
    fileRecord('script', paths.script),
    fileRecord('shots', paths.shots),
    fileRecord('subtitles', paths.subtitles),
    fileRecord('sources', paths.sources),
  ]);
  const sourceTaskIds = [...new Set(sourceTaskBindings
    .map((binding) => String(binding?.taskId || '').trim())
    .filter(Boolean))];
  const manifest = {
    schemaVersion:'agent.army/video-script-package/v1',
    taskId:task.taskId,
    title:data.headline,
    platform:data.platform,
    aspectRatio:data.aspectRatio,
    durationSeconds:data.durationSeconds,
    publishingStatus:'draft_only',
    externalSideEffects:0,
    sourceTaskIds,
    sourceTaskBindings,
    sourceRefs,
    files,
    createdAt:completedAt,
  };
  await writePrivate(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
  const manifestFile = await fileRecord('manifest', paths.manifest);
  const scriptFile = files.find((item) => item.id === 'script');

  return {
    artifactId:`video_script_package:${task.taskId}`,
    taskId:task.taskId,
    type:'video_script_package',
    title:`${data.headline}｜可拍脚本`,
    sourceRefs,
    location:`file://${paths.script}`,
    mimeType:'text/markdown',
    checksum:scriptFile.checksum,
    accessScope:'local-owner',
    validation:{
      exists:true,
      readable:true,
      nonEmpty:true,
      fileCount:5,
      externalSideEffects:0,
      onePrimaryDraft:true,
      factualSourcesBounded:sources.length <= 5,
      approvedForUse:data.templateLifecycle?.approvedForUse === true,
    },
    createdAt:completedAt,
    data:{
      ...data,
      sources,
      sourceTaskIds,
      sourceTaskBindings,
      productionFiles:[...files, manifestFile],
    },
  };
}

function renderScript(data) {
  return [
    `# ${data.headline}`,
    '',
    `平台：${data.platform}　预计时长：${data.durationSeconds} 秒　画幅：${data.aspectRatio}`,
    '',
    '## 开场',
    '',
    data.hook,
    '',
    '## 完整口播稿',
    '',
    data.fullScript,
    '',
    '## 拍摄提示',
    '',
    ...data.shootingNotes.map((item) => `- ${item}`),
    '',
    '## 发布前检查',
    '',
    `- 事实：${data.qualityReview.factuality}`,
    `- 模仿边界：${data.qualityReview.imitation}`,
    `- 可拍性：${data.qualityReview.shootability}`,
    '',
  ].join('\n');
}

function renderSources(sources, sourceRefs) {
  const lines = ['# 来源', ''];
  if (sources.length) {
    sources.forEach((source, index) => {
      lines.push(
        `${index + 1}. ${text(source.title, 300) || '公开来源'}`,
        `   ${text(source.url || source.source, 1_000)}`,
        `   读取时间：${text(source.fetchedAt, 120) || '未提供'}`,
        `   内容哈希：${text(source.contentHash, 80) || '未提供'}`,
      );
    });
  } else {
    lines.push('本稿未使用可独立核验的外部事实；不得自行补写数字、身份或因果结论。');
  }
  if (sourceRefs.length) lines.push('', `内部参考产物：${sourceRefs.join('、')}`);
  return `${lines.join('\n')}\n`;
}

function renderSrt(shots) {
  return `${shots.map((shot, index) => [
    index + 1,
    `${srtTime(shot.startSeconds)} --> ${srtTime(shot.endSeconds)}`,
    shot.narration,
  ].join('\n')).join('\n\n')}\n`;
}

function srtTime(value) {
  const totalMs = Math.max(0, Math.round(Number(value || 0) * 1000));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  const milliseconds = totalMs % 1000;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${String(milliseconds).padStart(3, '0')}`;
}

async function writePrivate(filePath, content) {
  await fs.writeFile(filePath, content, { encoding:'utf8', mode:0o600 });
  await fs.chmod(filePath, 0o600);
}

async function fileRecord(id, filePath) {
  const content = await fs.readFile(filePath);
  return {
    id,
    fileName:path.basename(filePath),
    location:`file://${filePath}`,
    checksum:crypto.createHash('sha256').update(content).digest('hex'),
    bytes:content.byteLength,
  };
}

function text(value, limit) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function safeSegment(value) {
  return String(value || 'task').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || 'task';
}

function pad(value) {
  return String(value).padStart(2, '0');
}

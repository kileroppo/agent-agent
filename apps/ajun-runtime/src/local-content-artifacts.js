import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validM5MediaChecksum } from '@agent-army/m5-kernel/content-version';

export async function referencedArtifacts(task, store) {
  const tasks = typeof store?.list === 'function' ? await store.list() : [];
  const ids = new Set([
    ...(Array.isArray(task.input?.context?.sourceTaskIds) ? task.input.context.sourceTaskIds : []),
    ...(task.parentTaskId ? tasks.filter((item) => item.parentTaskId === task.parentTaskId && item.taskId !== task.taskId).map((item) => item.taskId) : [])
  ].map(String));
  return tasks.filter((item) => ids.has(item.taskId)).flatMap((item) => item.artifactRefs || []);
}

export function findArtifact(artifacts, type) {
  return artifacts.find((artifact) => artifact.type === type && artifact.validation?.exists === true && artifact.validation?.readable === true && artifact.validation?.nonEmpty === true) || null;
}

export async function readArtifactText(artifact, allowedRoots) {
  const location = String(artifact?.location || '');
  if (!location.startsWith('file://')) throw new Error('内容增长执行器只读取受控本机文件产物。');
  const filePath = path.resolve(fileURLToPath(location));
  const allowed = allowedRoots.some((root) => filePath === root || filePath.startsWith(`${root}${path.sep}`));
  if (!allowed) throw new Error('产物路径不在内容增长执行器允许范围内。');
  return fs.readFile(filePath, 'utf8');
}

export async function readArtifactJson(artifact, allowedRoots) {
  return JSON.parse(await readArtifactText(artifact, allowedRoots));
}

export async function readVisualEvidence(artifact, allowedRoots) {
  const payload = await readArtifactJson(artifact, allowedRoots);
  const manifestPath = controlledArtifactPath(artifact, allowedRoots);
  const baseDir = path.dirname(manifestPath);
  const frames = Array.isArray(payload?.frames) ? payload.frames : [];
  const storyboards = Array.isArray(payload?.storyboards) ? payload.storyboards : [];
  if (payload?.schemaVersion !== 'agent.army/visual-evidence/v1' || !frames.length || !storyboards.length) {
    throw new Error('关键帧证据包结构无效。');
  }
  const controlledStoryboards = storyboards.map((storyboard) => {
    const filePath = path.resolve(baseDir, String(storyboard?.localRef || ''));
    const allowed = allowedRoots.some((root) => filePath === root || filePath.startsWith(`${root}${path.sep}`));
    if (!allowed || !filePath.startsWith(`${baseDir}${path.sep}`)) throw new Error('关键帧故事板路径超出受控目录。');
    return { ...storyboard, filePath };
  });
  return { ...payload, frames, storyboards:controlledStoryboards };
}

export async function visualEvidenceFromM5AssetPackage(artifact, allowedRoots) {
  const assets = Array.isArray(artifact?.data?.assets)
    ? artifact.data.assets.slice(0, 4)
    : [];
  if (!assets.length) throw new Error('AssetPackage 没有可读取的关键帧。');
  const controlled = [];
  for (const asset of assets) {
    const frameId = clean(asset?.frameId, 120);
    const timestamp = clean(asset?.timestamp, 40);
    const relativePath = String(asset?.relativePath || '').trim().replaceAll('\\', '/');
    if (
      !frameId
      || !timestamp
      || !relativePath
      || relativePath.startsWith('/')
      || relativePath.split('/').some((part) => !part || part === '.' || part === '..')
    ) {
      throw new Error('AssetPackage 的关键帧引用、时间点或路径无效。');
    }
    let filePath = null;
    for (const root of allowedRoots) {
      const realRoot = await fs.realpath(root).catch(() => path.resolve(root));
      const candidate = path.resolve(realRoot, relativePath);
      if (candidate !== realRoot && !candidate.startsWith(`${realRoot}${path.sep}`)) continue;
      const realPath = await fs.realpath(candidate).catch(() => null);
      if (realPath && (realPath === realRoot || realPath.startsWith(`${realRoot}${path.sep}`))) {
        filePath = realPath;
        break;
      }
    }
    if (!filePath) throw new Error('AssetPackage 的关键帧不在小拆允许读取的工作区。');
    const checksum = String(asset?.checksum || '').trim().toLowerCase();
    if (!validM5MediaChecksum(checksum)) {
      throw new Error('AssetPackage 的关键帧缺少有效 sha256。');
    }
    const bytes = await fs.readFile(filePath);
    const actualChecksum = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
    if (actualChecksum !== checksum) {
      throw new Error('AssetPackage 的关键帧文件与声明 sha256 不一致。');
    }
    controlled.push({
      frameId,
      timestamp,
      reason:'M5 AssetPackage 已核验关键帧',
      relativePath,
      checksum,
      filePath,
    });
  }
  return {
    schemaVersion:'agent.army/visual-evidence/v1',
    frames:controlled.map(({ filePath:_filePath, ...frame }) => frame),
    storyboards:controlled.map((item) => ({
      frameId:item.frameId,
      localRef:path.basename(item.filePath),
      filePath:item.filePath,
    })),
    coverage:{
      firstFrameAt:controlled[0].timestamp,
      lastFrameAt:controlled.at(-1).timestamp,
    },
  };
}


function controlledArtifactPath(artifact, allowedRoots) {
  const location = String(artifact?.location || '');
  if (!location.startsWith('file://')) throw new Error('内容增长执行器只读取受控本机文件产物。');
  const filePath = path.resolve(fileURLToPath(location));
  const allowed = allowedRoots.some((root) => filePath === root || filePath.startsWith(`${root}${path.sep}`));
  if (!allowed) throw new Error('产物路径不在内容增长执行器允许范围内。');
  return filePath;
}

export async function writeArtifact({ artifactsDir, task, type, title, data, sourceRefs, validation, completedAt }) {
  const directory = path.join(artifactsDir, safeSegment(task.taskId));
  await fs.mkdir(directory, { recursive:true });
  const filePath = path.join(directory, `${type}.md`);
  const markdown = renderArtifactMarkdown({ type, title, data, sourceRefs, completedAt });
  await fs.writeFile(filePath, markdown, { encoding:'utf8', mode:0o600 });
  await fs.chmod(filePath, 0o600);
  const stat = await fs.stat(filePath);
  return {
    artifactId:`${type}:${task.taskId}`,
    taskId:task.taskId,
    type,
    title,
    sourceRefs,
    location:`file://${filePath}`,
    mimeType:'text/markdown',
    checksum:crypto.createHash('sha256').update(markdown).digest('hex'),
    accessScope:'local-owner',
    validation:{ ...validation, bytes:stat.size },
    createdAt:completedAt,
    data
  };
}

function renderArtifactMarkdown({ type, title, data, sourceRefs, completedAt }) {
  if (type === 'video_content_analysis_report') {
    return renderVideoAnalysisMarkdown({ title, data, sourceRefs, completedAt });
  }
  return [
    `# ${title}`,
    '',
    `生成时间：${completedAt}`,
    `来源产物：${sourceRefs.join('、')}`,
    '',
    '## 结构化结果',
    '',
    '```json',
    JSON.stringify(data, null, 2),
    '```',
    ''
  ].join('\n');
}

export function renderVideoAnalysisMarkdown({ title, data, sourceRefs = [], completedAt = '' } = {}) {
  const visualAnalysisUsed = wasVisualAnalysisUsed(data);
  const generation = data?.generationMode === 'hermes_advisor'
    ? 'Hermes 深度分析'
    : data?.generationMode === 'hermes_advisor_evidence_repaired'
      ? 'Hermes 深度分析（证据结构已按确认稿补齐）'
      : '本机证据化兜底（模型结果未通过正式结构校验）';
  const lines = [
    `# ${markdownText(title) || '视频内容拆解报告'}`,
    '',
    `> ${markdownText(data?.summary) || '暂无摘要。'}`,
    '',
    `- 分析方式：${generation}`,
    `- 证据来源：${markdownText(data?.evidenceLabel || data?.evidenceMode) || '未提供'}`,
    `- 分析深度：${data?.depth === 'full' ? '完整拆解' : '快速拆解'}`,
    `- 图片分析：${visualAnalysisUsed ? '已使用图片分析' : '未使用图片分析'}`,
    `- 生成时间：${markdownText(completedAt || data?.generatedAt) || '未提供'}`,
    '',
    '## 来源信息',
    '',
    `- 原标题：${markdownText(data?.sourceMetadata?.title) || '未提供'}`,
    `- 作者：${markdownText(data?.sourceMetadata?.author) || '未提供'}`,
    `- 平台：${markdownText(data?.sourceMetadata?.platform) || '未提供'}`,
    `- 时长：${Number.isFinite(data?.sourceMetadata?.durationSeconds) ? `${data.sourceMetadata.durationSeconds} 秒` : '未提供'}`,
    `- 来源：${markdownText(data?.sourceMetadata?.canonicalUrl) || '未提供'}`,
    '',
    '## 画面观察',
    ''
  ];
  const visualFindings = visualAnalysisUsed && Array.isArray(data?.visualFindings) ? data.visualFindings : [];
  if (visualFindings.length) {
    visualFindings.forEach((item) => {
      lines.push(`- [${markdownText(item?.evidence?.timestamp) || '时间点缺失'}｜${markdownText(item?.evidence?.frameRef) || '帧缺失'}] ${markdownText(item?.finding) || '无结论'}`);
    });
  } else {
    lines.push('- 本报告没有使用图片生成画面结论。');
  }
  lines.push(
    '',
    '## 行动清单',
    ''
  );
  appendBullets(lines, data?.actionItems, '暂无明确行动项。');
  lines.push('', '## 可复用模式', '');
  appendBullets(lines, data?.reusablePatterns, '暂无可复用模式。');
  lines.push('', '## 逐项拆解', '');
  const modules = Array.isArray(data?.modules) ? data.modules : [];
  modules.forEach((module, index) => appendAnalysisModule(lines, module, index));
  lines.push(
    '',
    '## 证据说明',
    '',
    data?.evidenceMode === 'formal'
      ? data?.confirmationMode === 'automatic'
        ? '- 本报告基于系统质量门禁自动确认的转录；没有冒充人工听审，重要判断仍应回到所列原文片段复核。'
        : '- 本报告基于人工确认稿；所有判断均应回到所列原文片段复核。'
      : '- 本报告基于未经确认的机器稿，只能作为初步分析。',
    modules.some((module) => module?.evidence?.timestamp)
      ? '- 报告保留了确认稿中可识别的时间点。'
      : '- 确认稿没有可校验时间码，因此证据只能按原文片段定位，不能直接作为精确剪辑点。',
    `- 来源产物：${sourceRefs.map(markdownText).filter(Boolean).join('、') || '未提供'}`,
    ''
  );
  return lines.join('\n');
}

export function wasVisualAnalysisUsed(data) {
  return data?.visualCoverage?.status === 'available'
    && data?.completeness === 'complete'
    && Array.isArray(data?.visualFindings)
    && data.visualFindings.length > 0;
}

function appendAnalysisModule(lines, module, index) {
  lines.push(`### ${index + 1}. ${markdownText(module?.name) || '未命名模块'}`, '');
  if (module?.finding) lines.push(`**结论：** ${markdownText(module.finding)}`, '');
  if (module?.metadata && typeof module.metadata === 'object') {
    lines.push('#### 可核验信息', '');
    for (const [key, value] of Object.entries(module.metadata)) {
      lines.push(`- ${metadataLabel(key)}：${markdownText(value) || '未提供'}`);
    }
    lines.push('');
  }
  if (module?.titleFormula && typeof module.titleFormula === 'object') {
    lines.push(
      '#### 标题公式',
      '',
      `- 类型：${markdownText(module.titleFormula.category) || '未匹配'}`,
      `- 公式范围：${markdownText(module.titleFormula.formulaRange) || '无'}`,
      `- 提醒：${markdownText(module.titleFormula.note) || '无'}`,
      ''
    );
  }
  appendEvidenceSection(lines, '原文分析', module?.originalAnalysis, 'claim');
  appendEvidenceSection(lines, '问题诊断', module?.diagnosis, 'issue', (item) => severityLabel(item?.severity));
  appendEvidenceSection(lines, '优化建议', module?.optimization, 'action');
  if (Array.isArray(module?.sentenceBreakdown) && module.sentenceBreakdown.length) {
    lines.push(
      '<details>',
      `<summary>展开全文作用拆解（${module.sentenceBreakdown.length} 个连续证据段）</summary>`,
      ''
    );
    module.sentenceBreakdown.forEach((item, position) => {
      lines.push(
        `${position + 1}. **${markdownText(item?.role) || '作用未标注'}**`,
        `   - 原文（${timestampLabel(item?.evidence?.timestamp ?? item?.timestamp)}）：${markdownText(item?.original) || '原文缺失'}`,
        `   - 说明：${markdownText(item?.explanation) || '未提供'}`,
        ''
      );
    });
    lines.push('</details>', '');
  }
  if (Array.isArray(module?.reusablePoints) && module.reusablePoints.length) {
    lines.push('#### 可模仿点', '');
    module.reusablePoints.forEach((item, position) => {
      lines.push(
        `${position + 1}. **${markdownText(item?.pattern) || '模式未命名'}**`,
        `   - 怎么用：${markdownText(item?.howToReuse) || '未提供'}`,
        `   - 注意：${markdownText(item?.caution) || '未提供'}`,
        `   - 证据（${timestampLabel(item?.evidence?.timestamp)}）：${markdownText(item?.evidence?.fragment) || '原文缺失'}`,
        ''
      );
    });
  }
  if (module?.structureTemplate && typeof module.structureTemplate === 'object') {
    lines.push(
      '#### 可复用结构模板',
      '',
      `- 开头：${markdownText(module.structureTemplate.opening) || '未提供'}`,
      `- 主体：${markdownText(module.structureTemplate.body) || '未提供'}`,
      `- 结尾：${markdownText(module.structureTemplate.ending) || '未提供'}`,
      `- 边界：${markdownText(module.structureTemplate.disclaimer) || '未提供'}`,
      ''
    );
  }
}

function appendEvidenceSection(lines, title, items, textKey, prefix = () => '') {
  if (!Array.isArray(items) || !items.length) return;
  lines.push(`#### ${title}`, '');
  items.forEach((item) => {
    const label = prefix(item);
    lines.push(
      `- ${label ? `${label} ` : ''}${markdownText(item?.[textKey]) || '内容缺失'}`,
      `  - 证据（${timestampLabel(item?.evidence?.timestamp)}）：${markdownText(item?.evidence?.fragment) || '原文缺失'}`
    );
  });
  lines.push('');
}

function appendBullets(lines, items, emptyText) {
  if (!Array.isArray(items) || !items.length) {
    lines.push(`- ${emptyText}`);
    return;
  }
  items.forEach((item) => lines.push(`- ${listItemText(item)}`));
}

function listItemText(value) {
  if (!value || typeof value !== 'object') return markdownText(value);
  return markdownText(value.pattern || value.action || value.title || value.finding || value.summary || '未命名条目');
}

function timestampLabel(value) {
  const timestamp = markdownText(value);
  return timestamp ? `时间点 ${timestamp}` : '时间点缺失';
}

function severityLabel(value) {
  return ({ high:'高优先级', medium:'中优先级', low:'低优先级' })[String(value || '').toLowerCase()] || '';
}

function metadataLabel(value) {
  return ({
    title:'标题',
    author:'作者',
    platform:'平台',
    publishedAt:'发布时间',
    duration:'时长',
    engagement:'互动数据'
  })[value] || markdownText(value);
}

function markdownText(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function successResult(task, artifact, completedAt, mode, modelUsage = null) {
  return {
    status:'succeeded',
    currentStage:`${mode}_ready`,
    execution:{ executor:task.assigneeAgentId, mode, startedAt:task.execution?.startedAt || completedAt, finishedAt:completedAt, outcome:'artifact_ready' },
    usage:{
      tools:[{ id:`${mode}-write`, name:artifact.title, calls:1 }],
      ...(modelUsage?.model ? { model:modelUsage.model } : {})
    },
    artifactRefs:[artifact]
  };
}

export function needsInput(now, code, userMessage) {
  const current = typeof now === 'function' ? now() : now;
  return { status:'needs_input', currentStage:code, error:{ code, userMessage, category:'needs_input', stage:'content_growth_input', occurredAt:current.toISOString() } };
}

function safeSegment(value) { return String(value || 'task').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || 'task'; }

function clean(value, limit) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit); }

import fs from 'node:fs/promises';
import path from 'node:path';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'needs_input']);

export class LocalOfficeAssistant {
  constructor({ store, artifactsDir, knowledgeArchive = null, now = () => new Date() } = {}) {
    this.store = store;
    this.artifactsDir = artifactsDir;
    this.knowledgeArchive = knowledgeArchive;
    this.now = now;
  }

  supports(agent) { return agent?.agentId === 'office-assistant'; }

  async execute(task) {
    if (task.taskType === 'office.knowledge-summary') return this.executeKnowledgeSummary(task);
    const title = clean(task?.input?.title);
    const description = clean(task?.input?.description);
    const allTasks = typeof this.store?.list === 'function' ? await this.store.list() : [];
    const sources = referencedTasks(task, allTasks);
    if (!hasUsefulInput(title, description, sources)) {
      return needsInput(this.now(), 'office_material_required', '请提供需要整理的材料，或指定已经完成的任务；办公执行助理不会用空内容生成假汇报。');
    }

    const completedAt = this.now().toISOString();
    const report = buildReport({ title, description, sources, completedAt });
    const directory = path.join(this.artifactsDir, safeSegment(task.taskId));
    const filePath = path.join(directory, '办公汇报包.md');
    await fs.mkdir(directory, { recursive:true });
    await fs.writeFile(filePath, report.markdown, 'utf8');
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size < 1) throw new Error('办公汇报包写入后为空。');

    return {
      status:'succeeded',
      currentStage:'office_briefing_ready',
      execution:{
        executor:'office-assistant',
        mode:sources.length ? 'referenced_task_briefing' : 'provided_material_briefing',
        startedAt:task.execution?.startedAt || completedAt,
        finishedAt:completedAt,
        outcome:'briefing_ready'
      },
      usage:{ tools:[{ id:'office-artifact-write', name:'办公汇报包写入', calls:1 }] },
      artifactRefs:[{
        artifactId:`office-briefing:${task.taskId}`,
        taskId:task.taskId,
        type:'office_briefing_package',
        title:report.title,
        location:`file://${filePath}`,
        mimeType:'text/markdown',
        accessScope:'local-owner',
        createdAt:completedAt,
        validation:{
          exists:true,
          readable:true,
          nonEmpty:true,
          bytes:stat.size,
          sourceTaskCount:sources.length,
          sourceStatusesTruthful:true,
          includesOpenItems:true,
          includesNextAction:true
        },
        data:{
          title:report.title,
          summary:report.summary,
          sourceTasks:report.sourceTasks,
          openItems:report.openItems,
          nextAction:report.nextAction,
          markdown:report.markdown
        }
      }]
    };
  }

  async executeKnowledgeSummary(task) {
    if (!this.knowledgeArchive) return needsInput(this.now(), 'knowledge_archive_unavailable', '统一知识库写入能力尚未配置。');
    const title = clean(task?.input?.title);
    const description = clean(task?.input?.description);
    const allTasks = typeof this.store?.list === 'function' ? await this.store.list() : [];
    const sources = referencedTasks(task, allTasks);
    if (!hasUsefulInput(title, description, sources)) {
      return needsInput(this.now(), 'knowledge_material_required', '请提供当前任务材料，或明确引用需要归档的任务。');
    }
    const generatedAt = this.now().toISOString();
    const decisions = sources.flatMap((item) => item.artifacts.map(knowledgeConclusion)).slice(0, 10);
    const openItems = [
      ...sources.filter((item) => item.status !== 'succeeded').map((item) => `${item.title}：${item.error || statusLabel(item.status)}`),
      ...sources.flatMap((item) => item.artifacts.flatMap(knowledgeArtifactOpenItems))
    ];
    const markdown = [
      `# ${title || 'Agent军团任务总结'}`,
      '',
      '## 摘要',
      '',
      sources.length ? `本笔记归档 ${sources.length} 项明确引用的军团工作和已验证产物。` : description,
      '',
      '## 关键结论',
      '',
      ...(decisions.length ? decisions.map((item) => `- ${item}`) : ['- 当前材料没有可验证的上游产物。']),
      '',
      '## 决定',
      '',
      '- 只归档当前任务明确提供或引用的脱敏材料。',
      '- 原始凭据、Cookie、私密聊天和未确认转录不进入知识笔记。',
      '',
      '## 待办',
      '',
      ...(openItems.length ? openItems.map((item) => `- ${item}`) : ['- 无。']),
      '',
      '## 来源引用',
      '',
      ...(sources.length ? sources.map((item) => `- 任务 ${item.taskId}｜${item.title}｜${statusLabel(item.status)}`) : ['- 当前任务正文。']),
      '',
      `生成时间：${generatedAt}`,
      `任务 ID：${task.taskId}`,
      ''
    ].join('\n');
    const written = await this.knowledgeArchive.write({
      taskId:task.taskId,
      idempotencyKey:task.idempotencyKey,
      title:title || 'Agent军团任务总结',
      markdown
    });
    return {
      status:'succeeded',
      currentStage:'knowledge_summary_archived',
      execution:{ executor:'office-assistant', mode:'knowledge_archive', startedAt:task.execution?.startedAt || generatedAt, finishedAt:generatedAt, outcome:'knowledge_note_ready' },
      usage:{ tools:[{ id:'knowledge-archive-write', name:'统一知识库受限写入', calls:written.duplicate ? 0 : 1 }] },
      artifactRefs:[{
        artifactId:`knowledge-summary:${task.taskId}`,
        taskId:task.taskId,
        type:'knowledge_summary_note',
        title:title || 'Agent军团任务总结',
        sourceRefs:sources.map((item) => item.taskId),
        location:`file://${written.filePath}`,
        mimeType:'text/markdown',
        checksum:written.checksum,
        accessScope:'local-owner',
        createdAt:generatedAt,
        validation:{ exists:true, readable:written.readable, nonEmpty:written.bytes > 0, bytes:written.bytes, pathRestricted:true, idempotent:true, duplicate:written.duplicate },
        data:{ title:title || 'Agent军团任务总结', summary:sources.length ? `已归档 ${sources.length} 项关联工作。` : description, sourceTasks:sources.map((item) => item.taskId), openItems, generatedAt }
      }]
    };
  }
}

export function formatOfficeBriefingReply(report) {
  const sourceCount = Array.isArray(report?.sourceTasks) ? report.sourceTasks.length : 0;
  const openItems = Array.isArray(report?.openItems) ? report.openItems.filter(Boolean) : [];
  return [
    `办公执行助理已完成：${clean(report?.title) || '办公汇报包'}`,
    clean(report?.summary) || '已按现有材料完成整理。',
    sourceCount ? `已核对 ${sourceCount} 项关联工作。` : '本次根据你提供的材料整理。',
    openItems.length ? `仍需处理：${openItems.slice(0, 3).join('；')}` : '当前没有未说明的阻塞项。',
    `下一步：${clean(report?.nextAction) || '请审阅汇报包并指出需要修改的部分。'}`
  ].join('\n');
}

function referencedTasks(task, allTasks) {
  const explicit = list(task?.input?.context?.sourceTaskIds);
  const siblingIds = task?.parentTaskId
    ? allTasks.filter((item) => item.parentTaskId === task.parentTaskId && item.taskId !== task.taskId && item.assigneeAgentId !== 'office-assistant').map((item) => item.taskId)
    : [];
  const ids = new Set([...explicit, ...siblingIds]);
  return allTasks
    .filter((item) => ids.has(item.taskId))
    .sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')))
    .map(sourceTaskSummary);
}

function sourceTaskSummary(task) {
  const artifacts = (task.artifactRefs || []).filter((artifact) => artifact?.validation?.exists === true && artifact?.validation?.nonEmpty === true);
  return {
    taskId:task.taskId,
    title:clean(task.input?.title) || '未命名工作',
    employeeId:task.assigneeAgentId || null,
    status:task.status,
    stage:task.currentStage || null,
    terminal:TERMINAL.has(task.status),
    artifacts:artifacts.map((artifact) => ({
      type:artifact.type,
      title:clean(artifact.title) || '未命名产物',
      location:safeArtifactLocation(artifact.location),
      summary:knowledgeArtifactSummary(artifact),
      publishingStatus:clean(artifact.data?.publishingStatus)
    })),
    error:task.error?.userMessage ? clean(task.error.userMessage).slice(0, 240) : null
  };
}

function knowledgeConclusion(artifact) {
  return artifact.summary
    ? `${artifact.title}：${artifact.summary}`
    : artifact.title;
}

function knowledgeArtifactSummary(artifact) {
  const data = artifact?.data || {};
  if (artifact?.type === 'platform_content_draft') {
    const platforms = list(data.platforms).join('、');
    const title = clean(data.drafts?.[0]?.titleCandidates?.[0]);
    return [
      platforms ? `已生成 ${platforms} 待审草稿` : '已生成平台待审草稿',
      title ? `首选标题“${title}”` : '',
      data.publishingStatus === 'draft_only' ? '未发布' : ''
    ].filter(Boolean).join('；');
  }
  if (artifact?.type === 'video_content_analysis_report') {
    const summary = clean(data.summary);
    const completeness = clean(data.completeness);
    return [summary, completeness ? `完整度 ${completeness}` : ''].filter(Boolean).join('；').slice(0, 360);
  }
  return clean(data.summary).slice(0, 360);
}

function knowledgeArtifactOpenItems(artifact) {
  if (artifact.type === 'platform_content_draft' && artifact.publishingStatus === 'draft_only') {
    return ['人工审阅平台草稿；确认事实、隐私和表达后，再单独决定是否发布。'];
  }
  return [];
}

function buildReport({ title, description, sources, completedAt }) {
  const reportTitle = `${title || '工作整理'}｜办公汇报包`;
  const succeeded = sources.filter((item) => item.status === 'succeeded');
  const unfinished = sources.filter((item) => item.status !== 'succeeded');
  const summary = sources.length
    ? `已核对 ${sources.length} 项关联工作：${succeeded.length} 项完成，${unfinished.length} 项尚未完整完成。`
    : '已根据当前任务中提供的材料完成结构化整理。';
  const sourceLines = sources.length
    ? sources.map((item) => `- ${statusLabel(item.status)}｜${item.title}｜负责人：${item.employeeId || '待确定'}｜任务号：${item.taskId}`)
    : ['- 当前任务未引用其他员工任务。'];
  const artifactLines = sources.flatMap((item) => item.artifacts.map((artifact) => `- ${item.title} → ${artifact.title}${artifact.location ? `（${artifact.location}）` : ''}`));
  const openItems = unfinished.map((item) => `${item.title}：${item.error || statusLabel(item.status)}`);
  if (!sources.length && !description) openItems.push('未提供独立材料正文；本次仅按任务目标整理。');
  const nextAction = openItems.length
    ? '先补齐或完成上述未决事项，再生成最终版汇报包。'
    : '请审阅汇报包；需要修改时直接在原任务中说明。';
  const markdown = [
    `# ${reportTitle}`,
    '',
    `生成时间：${completedAt}`,
    '',
    '## 执行摘要',
    '',
    summary,
    '',
    '## 任务目标与材料',
    '',
    `- 目标：${title || '未提供明确标题'}`,
    ...(description ? [`- 已提供材料：${description}`] : []),
    '',
    '## 事项明细',
    '',
    ...sourceLines,
    '',
    '## 产物索引',
    '',
    ...(artifactLines.length ? artifactLines : ['- 当前没有经过验证的关联产物。']),
    '',
    '## 未决事项',
    '',
    ...(openItems.length ? openItems.map((item) => `- ${item}`) : ['- 无。']),
    '',
    '## 下一步',
    '',
    nextAction,
    ''
  ].join('\n');
  return {
    title:reportTitle,
    summary,
    sourceTasks:sources,
    openItems,
    nextAction,
    markdown
  };
}

function hasUsefulInput(title, description, sources) {
  return description.length >= 6 || sources.length > 0 || title.length >= 12;
}
function statusLabel(status) {
  return ({ succeeded:'已完成', failed:'失败', cancelled:'已关闭', needs_input:'等待材料', running:'进行中', queued:'已排队', waiting_approval:'等待批准', waiting_worker:'等待 Mac工作间上线', paused:'已暂停' })[status] || String(status || '未知');
}
function safeArtifactLocation(value) {
  const location = String(value || '').trim();
  return /^(?:runtime|file):\/\//.test(location) || /^https:\/\/[^ ]+/.test(location) ? location.slice(0, 500) : '';
}
function safeSegment(value) { return String(value || 'task').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || 'task'; }
function list(value) { return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || '').trim()).filter(Boolean))]; }
function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function needsInput(now, code, userMessage) {
  return { status:'needs_input', currentStage:code, error:{ code, userMessage, category:'needs_input', stage:'input', occurredAt:now.toISOString() } };
}

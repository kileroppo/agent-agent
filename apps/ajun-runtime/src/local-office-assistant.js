import fs from 'node:fs/promises';
import path from 'node:path';
import { presentationOutlinePreflight } from './presentation-input-contract.ts';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'needs_input']);

export class LocalOfficeAssistant {
  constructor({ store, artifactsDir, knowledgeArchive = null, now = () => new Date() } = {}) {
    this.store = store;
    this.artifactsDir = artifactsDir;
    this.knowledgeArchive = knowledgeArchive;
    this.now = now;
  }

  supports(agent) { return agent?.agentId === 'office-assistant'; }

  async execute(task, { roleToolContext = null } = {}) {
    if (task.taskType === 'office.presentation-package') {
      return this.executePresentationPackage(task, roleToolContext);
    }
    if (task.taskType === 'office.knowledge-summary') {
      return this.executeKnowledgeSummary(task, roleToolContext);
    }
    const title = clean(task?.input?.title);
    const description = clean(task?.input?.description);
    const allTasks = roleToolContext
      ? await roleToolContext.execute({
          toolId:'army.task.read',
          input:{
            sourceTaskIds:list(task?.input?.context?.sourceTaskIds),
            parentTaskId:task?.parentTaskId || null,
            currentTaskId:task?.taskId,
          },
        })
      : typeof this.store?.list === 'function' ? await this.store.list() : [];
    const sources = referencedTasks(task, allTasks);
    if (!hasUsefulInput(title, description, sources)) {
      return needsInput(this.now(), 'office_material_required', '请提供需要整理的材料，或指定已经完成的任务；办公执行助理不会用空内容生成假汇报。');
    }

    const completedAt = this.now().toISOString();
    const report = buildReport({ title, description, sources, completedAt });
    const taskSegment = safeSegment(task.taskId);
    let filePath;
    let bytes;
    if (roleToolContext) {
      const written = await roleToolContext.execute({
        toolId:'office.artifact.write',
        relativePath:`work-products/${taskSegment}/office-briefing.md`,
        input:{ contents:report.markdown },
      });
      filePath = written.filePath;
      bytes = written.bytes;
    } else {
      const directory = path.join(this.artifactsDir, safeSegment(task.taskId));
      filePath = path.join(directory, '办公汇报包.md');
      await fs.mkdir(directory, { recursive:true, mode:0o700 });
      await fs.chmod(directory, 0o700);
      await fs.writeFile(filePath, report.markdown, { encoding:'utf8', mode:0o600 });
      await fs.chmod(filePath, 0o600);
      const stat = await fs.stat(filePath);
      if (!stat.isFile() || stat.size < 1) throw new Error('办公汇报包写入后为空。');
      bytes = stat.size;
    }

    const additionalArtifacts = roleToolContext
      ? await writeRequestedOfficeArtifacts({
          task,
          report,
          sources,
          completedAt,
          taskSegment,
          roleToolContext,
        })
      : [];
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
      usage:{
        tools:[
          { id:'office-artifact-write', name:'办公汇报包写入', calls:1 },
          ...additionalArtifacts.map((artifact) => ({
            id:artifact.data?.toolId || artifact.type,
            name:artifact.title,
            calls:artifact.data?.duplicate ? 0 : 1,
          })),
        ],
      },
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
          bytes,
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
      }, ...additionalArtifacts]
    };
  }

  async executeKnowledgeSummary(task, roleToolContext = null) {
    if (!this.knowledgeArchive) return needsInput(this.now(), 'knowledge_archive_unavailable', '统一知识库写入能力尚未配置。');
    const title = clean(task?.input?.title);
    const description = clean(task?.input?.description);
    const allTasks = roleToolContext
      ? await roleToolContext.execute({
          toolId:'army.task.read',
          input:{
            sourceTaskIds:list(task?.input?.context?.sourceTaskIds),
            parentTaskId:task?.parentTaskId || null,
            currentTaskId:task?.taskId,
          },
        })
      : typeof this.store?.list === 'function' ? await this.store.list() : [];
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
    const writeInput = {
      taskId:task.taskId,
      idempotencyKey:task.idempotencyKey,
      title:title || 'Agent军团任务总结',
      markdown,
    };
    const written = roleToolContext
      ? await roleToolContext.execute({
          toolId:'knowledge.archive.write',
          relativePath:'Agent军团',
          input:writeInput,
        })
      : await this.knowledgeArchive.write(writeInput);
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

  async executePresentationPackage(task, roleToolContext = null) {
    if (!roleToolContext) {
      return needsInput(
        this.now(),
        'presentation_workspace_required',
        '演示文稿必须在当前 Paperclip execution workspace 中生成；本次没有可验证的工作区授权。',
      );
    }
    const input = task?.input || {};
    const title = clean(input.title);
    const description = clean(input.description || input.purpose);
    if (!title) {
      return needsInput(this.now(), 'presentation_title_required', '请提供演示文稿标题。');
    }
    const preflight = presentationOutlinePreflight(input);
    if (!preflight.valid) return needsInput(this.now(), preflight.code, preflight.userMessage);
    const allTasks = await roleToolContext.execute({
      toolId:'army.task.read',
      input:{
        sourceTaskIds:list(input?.context?.sourceTaskIds || input.sourceTaskIds),
        parentTaskId:task?.parentTaskId || null,
        currentTaskId:task?.taskId,
      },
    });
    const sources = referencedTasks(task, allTasks);
    const completedAt = this.now().toISOString();
    const taskSegment = safeSegment(task.taskId);
    const projectBase = `work-products/${taskSegment}/presentation`;
    const manifestRelativePath = `${projectBase}/deck.pptd`;
    const sourceSummaries = sources.map((source) => [
      source.title,
      statusLabel(source.status),
      source.artifacts.map((artifact) => artifact.title).join('、'),
    ].filter(Boolean).join('｜'));
    const written = await roleToolContext.execute({
      toolId:'office.pptd.write',
      relativePath:manifestRelativePath,
      input:{
        title,
        purpose:description,
        audience:input.audience,
        slideCount:input.slideCount,
        designMode:input.designMode,
        designTokens:input.designTokens,
        designSourceRef:input.designSourceRef,
        templateArtifactRef:input.templateArtifactRef,
        styleArtifactRef:input.styleArtifactRef,
        slides:input.slides,
        outline:input.outline,
        media:input.media,
        dataClassification:input.dataClassification || 'internal',
        sourceSummaries,
      },
    });
    const artifacts = [
      presentationSourceArtifact(task, written, completedAt),
      presentationQaArtifact(task, written, completedAt),
    ];
    const requestedOutputs = presentationOutputs(input.outputs);
    if (!requestedOutputs.includes('pptx')) {
      return presentationResult({
        task,
        completedAt,
        artifacts,
        status:'succeeded',
        stage:'office_presentation_pptd_ready',
        outcome:'pptd_ready',
        tools:['army.task.read', 'office.pptd.write'],
      });
    }
    try {
      const pptxRelativePath = `${projectBase}/deck.pptx`;
      const exported = await roleToolContext.execute({
        toolId:'office.pptx.export',
        relativePath:pptxRelativePath,
        externalSideEffect:'none',
        input:{
          manifestRelativePath,
          dataClassification:input.dataClassification || 'internal',
        },
      });
      artifacts[1] = presentationQaArtifact(task, written, completedAt, { exported });
      artifacts.push(presentationPptxArtifact(task, exported, completedAt));
      return presentationResult({
        task,
        completedAt,
        artifacts,
        status:'succeeded',
        stage:'office_presentation_ready',
        outcome:'pptd_pptx_ready',
        tools:['army.task.read', 'office.pptd.write', 'office.pptx.export'],
      });
    } catch (error) {
      const blocked = presentationExportBlocker(error);
      artifacts[1] = presentationQaArtifact(task, written, completedAt, { blocker:blocked });
      return {
        ...presentationResult({
          task,
          completedAt,
          artifacts,
          status:'needs_input',
          stage:blocked.stage,
          outcome:'pptd_ready_export_blocked',
          tools:['army.task.read', 'office.pptd.write'],
        }),
        error:{
          code:blocked.code,
          message:String(error?.message || blocked.userMessage).slice(0, 500),
          userMessage:blocked.userMessage,
          category:blocked.category || 'manual',
          stage:blocked.stage,
          diagnosticStage:blocked.diagnosticStage || null,
          attempt:blocked.attempt || null,
          retryable:false,
          occurredAt:completedAt,
        },
      };
    }
  }
}

function presentationSourceArtifact(task, written, completedAt) {
  return {
    artifactId:`office-presentation-source:${task.taskId}`,
    taskId:task.taskId,
    type:'office_presentation_source',
    title:`${clean(task.input?.title) || '办公演示文稿'}（可编辑 PPTD）`,
    location:`workspace://${written.manifestRelativePath}`,
    mimeType:written.mimeType,
    checksum:written.checksum,
    accessScope:'local-owner',
    createdAt:completedAt,
    validation:written.validation,
    data:{
      toolId:'office.pptd.write',
      projectRelativePath:written.projectRelativePath,
      manifestRelativePath:written.manifestRelativePath,
      pageCount:written.validation?.pageCount,
      source:written.source,
    },
  };
}

function presentationQaArtifact(task, written, completedAt, { exported = null, blocker = null } = {}) {
  const visualQaPassed = exported?.validation?.visualQaPassed === true;
  return {
    artifactId:`office-presentation-qa:${task.taskId}`,
    taskId:task.taskId,
    type:'office_presentation_qa',
    title:`${clean(task.input?.title) || '办公演示文稿'}（结构质检）`,
    location:`workspace://${written.qaRelativePath}`,
    mimeType:'application/json',
    checksum:written.checksum,
    accessScope:'local-owner',
    createdAt:completedAt,
    validation:{
      exists:true,
      readable:true,
      nonEmpty:true,
      structuralQaPassed:written.validation?.structuralQaPassed === true,
      visualQaPassed,
      humanOfficeReviewRequired:true,
    },
    data:{
      stage:visualQaPassed ? 'visual' : 'structural',
      pageCount:written.validation?.pageCount,
      previewRefs:exported?.qaOverviewRelativePath
        ? [`workspace://${exported.qaOverviewRelativePath}`]
        : [],
      issues:blocker ? [{
        code:blocker.code,
        message:blocker.userMessage,
        diagnosticStage:blocker.diagnosticStage || null,
        attempt:blocker.attempt || null,
      }] : [],
      visualReviewStatus:visualQaPassed ? 'passed' : 'not_run',
    },
  };
}

function presentationPptxArtifact(task, exported, completedAt) {
  return {
    artifactId:`office-pptx:${task.taskId}`,
    taskId:task.taskId,
    type:'office_pptx_document',
    title:`${clean(task.input?.title) || '办公演示文稿'}（PPTX）`,
    location:`workspace://${exported.relativePath}`,
    mimeType:exported.mimeType,
    checksum:exported.checksum,
    accessScope:'local-owner',
    createdAt:completedAt,
    validation:exported.validation,
    data:{
      toolId:'office.pptx.export',
      relativePath:exported.relativePath,
      bytes:exported.bytes,
      durationMs:exported.durationMs,
      attempts:exported.attempts,
      pageCount:exported.validation?.pageCount,
      fadeTransitions:exported.validation?.fadeTransitions,
      transitionXmlOrderValid:exported.validation?.transitionXmlOrderValid,
      fontParts:exported.validation?.fontParts,
      fontEmbeddingVerified:exported.validation?.fontEmbeddingVerified,
    },
  };
}

function presentationResult({ task, completedAt, artifacts, status, stage, outcome, tools }) {
  return {
    status,
    currentStage:stage,
    execution:{
      executor:'office-assistant',
      mode:'presentation_package',
      startedAt:task.execution?.startedAt || completedAt,
      finishedAt:completedAt,
      outcome,
    },
    usage:{ tools:tools.map((id) => ({ id, name:id, calls:1 })) },
    artifactRefs:artifacts,
  };
}

function presentationOutputs(value) {
  if (!Array.isArray(value) || !value.length) return ['pptd', 'pptx'];
  const outputs = [...new Set(value.map((item) => String(item || '').trim().toLowerCase()))]
    .filter((item) => ['pptd', 'pptx'].includes(item));
  return outputs.length ? outputs : ['pptd', 'pptx'];
}

function presentationExportBlocker(error) {
  const code = String(error?.code || 'presentation_export_needs_capability');
  const diagnosticStage = safePresentationDiagnosticStage(error?.stage);
  const attempt = [1, 2].includes(Number(error?.attempt)) ? Number(error.attempt) : null;
  if (['external_data_processing_denied', 'presentation_external_processing_denied'].includes(code)) {
    return {
      code:'presentation_external_processing_denied',
      stage:'office_presentation_external_processing_denied',
      userMessage:'可编辑 PPTD 已生成；内部或敏感材料不能交给 Kimi 公共编辑器处理，因此没有生成 PPTX。',
    };
  }
  if (['external_data_processing_approval_required', 'presentation_external_processing_approval_required'].includes(code)) {
    return {
      code:'presentation_external_processing_approval_required',
      stage:'office_presentation_waiting_external_approval',
      userMessage:'可编辑 PPTD 已生成；PPTX 导出会使用 Kimi 公共编辑器，需要负责人明确批准本次外部处理。',
    };
  }
  if (['ETIMEDOUT', 'EPLAYWRIGHT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH'].includes(code)) {
    const location = diagnosticStage ? `（${presentationDiagnosticLabel(diagnosticStage)}）` : '';
    return {
      code:'presentation_export_waiting_test',
      stage:'office_presentation_waiting_test',
      category:'temporary_dependency',
      diagnosticStage,
      attempt,
      userMessage:`可编辑 PPTD 已生成；图片质检或 PPTX 外部导出${location}暂时失败，已停止自动重试并保留诊断阶段，等待受控复测。`,
    };
  }
  return {
    code:'presentation_export_needs_capability',
    stage:'office_presentation_export_needs_capability',
    userMessage:'可编辑 PPTD 已生成；当前缺少兼容的本地 PPTX 导出依赖，页面渲染质检尚未完成，系统没有自动安装或升级软件。',
  };
}

function safePresentationDiagnosticStage(value) {
  const stage = String(value || '').trim();
  return new Set([
    'visualQa.images', 'export.pptx', 'browser.launch', 'browser.navigation', 'deck.ready',
    'browser.viewport', 'editor.snapshot', 'editor.control', 'editor.export_dialog',
    'editor.image_format', 'visualQa.download', 'visualQa.download_wait',
    'pptx.download', 'pptx.download_wait',
  ]).has(stage) ? stage : null;
}

function presentationDiagnosticLabel(stage) {
  if (stage === 'browser.navigation') return '打开公共编辑器';
  if (stage === 'deck.ready') return '等待演示文稿就绪';
  if (stage.startsWith('editor.')) return '定位导出控件';
  if (stage.startsWith('visualQa.download')) return '下载页面图片';
  if (stage.startsWith('pptx.download')) return '下载 PPTX';
  if (stage === 'browser.launch') return '启动隔离浏览器';
  return stage === 'export.pptx' ? '生成 PPTX' : '生成页面图片';
}

async function writeRequestedOfficeArtifacts({
  task,
  report,
  sources,
  completedAt,
  taskSegment,
  roleToolContext,
}) {
  const artifacts = [];
  for (const format of officeOutputFormats(task)) {
    const toolId = `office.${format}.write`;
    const relativePath = `work-products/${taskSegment}/office-briefing.${format}`;
    const input = format === 'xlsx'
      ? { title:report.title, rows:officeSpreadsheetRows(sources, report) }
      : { title:report.title, markdown:report.markdown };
    const written = await roleToolContext.execute({ toolId, relativePath, input });
    artifacts.push({
      artifactId:`office-${format}:${task.taskId}`,
      taskId:task.taskId,
      type:`office_${format}_document`,
      title:`${report.title}（${format.toUpperCase()}）`,
      location:`workspace://${relativePath}`,
      mimeType:written.mimeType,
      checksum:written.checksum,
      accessScope:'local-owner',
      createdAt:completedAt,
      validation:written.validation,
      data:{
        toolId,
        relativePath,
        bytes:written.bytes,
      },
    });
  }
  const cadence = reportCadence(task);
  if (cadence) {
    const toolId = `office.report.${cadence}.write`;
    const relativePath = `work-products/${taskSegment}/${cadence}-report.md`;
    const written = await roleToolContext.execute({
      toolId,
      relativePath,
      input:{
        idempotencyKey:String(task.idempotencyKey || `task-${task.taskId}`).slice(0, 200),
        title:report.title,
        summary:report.summary,
        markdown:report.markdown,
        sourceTaskIds:sources.map((source) => source.taskId),
      },
    });
    artifacts.push({
      artifactId:`office-${cadence}-report:${task.taskId}`,
      taskId:task.taskId,
      type:`office_${cadence}_report_work_product`,
      title:`${report.title}（${cadence === 'daily' ? '日报' : '周报'} Work Product）`,
      location:`paperclip-work-product://${written.workProductId}`,
      checksum:written.contentHash,
      accessScope:'local-owner',
      createdAt:completedAt,
      validation:{
        exists:true,
        readable:true,
        nonEmpty:true,
        paperclipWorkProduct:true,
        workspaceRestricted:true,
      },
      data:{
        toolId,
        workProductId:written.workProductId,
        relativePath:written.relativePath,
        duplicate:written.duplicate,
      },
    });
  }
  return artifacts;
}

function officeOutputFormats(task) {
  const requested = Array.isArray(task?.input?.outputFormats)
    ? task.input.outputFormats
    : [];
  const normalized = [...new Set(requested.map((item) => String(item || '').toLowerCase().trim()))]
    .filter((item) => ['docx', 'xlsx', 'pdf'].includes(item));
  return normalized.length
    ? normalized
    : task?.taskType === 'office.deliverable-program' ? ['docx', 'xlsx', 'pdf'] : [];
}

function reportCadence(task) {
  const requested = String(task?.input?.reportCadence || '').toLowerCase().trim();
  if (['daily', 'weekly'].includes(requested)) return requested;
  return task?.taskType === 'content.campaign-metrics' ? 'daily' : null;
}

function officeSpreadsheetRows(sources, report) {
  const rows = [['任务 ID', '标题', '负责人', '状态', '阶段', '已验证产物数']];
  for (const source of sources) {
    rows.push([
      source.taskId,
      source.title,
      source.employeeId || '待确定',
      statusLabel(source.status),
      source.stage || '',
      String(source.artifacts.length),
    ]);
  }
  if (!sources.length) rows.push(['当前任务', report.title, 'office-assistant', '已整理', '', '1']);
  return rows;
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
  const explicit = list(task?.input?.context?.sourceTaskIds || task?.input?.sourceTaskIds);
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

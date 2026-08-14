import { presentationOutlinePreflight } from './presentation-input-contract.ts';
import {
  isTaskNotificationTerminalStatus,
  taskStatusLabel,
} from './task-status-policy.ts';

export class OfficePresentationProduction {
  async execute({ task, roleToolContext, now }) {
    if (!roleToolContext) {
      return needsInput(
        now,
        'presentation_workspace_required',
        '演示文稿必须在当前 Paperclip execution workspace 中生成；本次没有可验证的工作区授权。',
      );
    }
    const input = task?.input || {};
    const title = clean(input.title);
    const description = clean(input.description || input.purpose);
    if (!title) {
      return needsInput(now, 'presentation_title_required', '请提供演示文稿标题。');
    }
    const preflight = presentationOutlinePreflight(input);
    if (!preflight.valid) return needsInput(now, preflight.code, preflight.userMessage);

    const allTasks = await roleToolContext.execute({
      toolId:'army.task.read',
      input:{
        sourceTaskIds:list(input?.context?.sourceTaskIds || input.sourceTaskIds),
        parentTaskId:task?.parentTaskId || null,
        currentTaskId:task?.taskId,
      },
    });
    const sources = referencedTasks(task, allTasks);
    const completedAt = now().toISOString();
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
    terminal:isTaskNotificationTerminalStatus(task.status),
    artifacts:artifacts.map((artifact) => ({
      type:artifact.type,
      title:clean(artifact.title) || '未命名产物',
      location:safeArtifactLocation(artifact.location),
      summary:knowledgeArtifactSummary(artifact),
      publishingStatus:clean(artifact.data?.publishingStatus),
    })),
    error:task.error?.userMessage ? clean(task.error.userMessage).slice(0, 240) : null,
  };
}

function knowledgeArtifactSummary(artifact) {
  const data = artifact?.data || {};
  if (artifact?.type === 'platform_content_draft') {
    const platforms = list(data.platforms).join('、');
    const title = clean(data.drafts?.[0]?.titleCandidates?.[0]);
    return [
      platforms ? `已生成 ${platforms} 待审草稿` : '已生成平台待审草稿',
      title ? `首选标题“${title}”` : '',
      data.publishingStatus === 'draft_only' ? '未发布' : '',
    ].filter(Boolean).join('；');
  }
  if (artifact?.type === 'video_content_analysis_report') {
    const summary = clean(data.summary);
    const completeness = clean(data.completeness);
    return [summary, completeness ? `完整度 ${completeness}` : ''].filter(Boolean).join('；').slice(0, 360);
  }
  return clean(data.summary).slice(0, 360);
}

function statusLabel(status) {
  return taskStatusLabel(status);
}

function safeArtifactLocation(value) {
  const location = String(value || '').trim();
  return /^(?:runtime|file):\/\//.test(location) || /^https:\/\/[^ ]+/.test(location) ? location.slice(0, 500) : '';
}

function safeSegment(value) {
  return String(value || 'task').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || 'task';
}

function list(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || '').trim()).filter(Boolean))];
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function needsInput(now, code, userMessage) {
  return {
    status:'needs_input',
    currentStage:code,
    error:{ code, userMessage, category:'needs_input', stage:'input', occurredAt:now().toISOString() },
  };
}

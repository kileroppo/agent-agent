import { presentationOutlinePreflight } from './presentation-input-contract.ts';
import { isTaskNotificationTerminalStatus, taskStatusLabel, } from './task-status-policy.ts';
export class OfficePresentationProduction {
    async execute({ task, roleToolContext, now }: any): Promise<any> {
        if (!roleToolContext) {
            return needsInput(now, 'presentation_workspace_required', '演示文稿必须在当前 Paperclip execution workspace 中生成；本次没有可验证的工作区授权。');
        }
        const input: any = task?.input || {};
        const title: any = clean(input.title);
        const description: any = clean(input.description || input.purpose);
        if (!title) {
            return needsInput(now, 'presentation_title_required', '请提供演示文稿标题。');
        }
        const preflight: any = presentationOutlinePreflight(input);
        if (!preflight.valid)
            return needsInput(now, preflight.code, preflight.userMessage);
        const allTasks: any = await roleToolContext.execute({
            toolId: 'army.task.read',
            input: {
                sourceTaskIds: list(input?.context?.sourceTaskIds || input.sourceTaskIds),
                parentTaskId: task?.parentTaskId || null,
                currentTaskId: task?.taskId,
            },
        });
        const sources: any = referencedTasks(task, allTasks);
        const completedAt: any = now().toISOString();
        const taskSegment: any = safeSegment(task.taskId);
        const projectBase: any = `work-products/${taskSegment}/presentation`;
        const manifestRelativePath: any = `${projectBase}/deck.pptd`;
        const sourceSummaries: any = sources.map((source: any): any => [
            source.title,
            statusLabel(source.status),
            source.artifacts.map((artifact: any): any => artifact.title).join('、'),
        ].filter(Boolean).join('｜'));
        const written: any = await roleToolContext.execute({
            toolId: 'office.pptd.write',
            relativePath: manifestRelativePath,
            input: {
                title,
                purpose: description,
                audience: input.audience,
                slideCount: input.slideCount,
                designMode: input.designMode,
                designTokens: input.designTokens,
                designSourceRef: input.designSourceRef,
                templateArtifactRef: input.templateArtifactRef,
                styleArtifactRef: input.styleArtifactRef,
                slides: input.slides,
                outline: input.outline,
                media: input.media,
                dataClassification: input.dataClassification || 'internal',
                sourceSummaries,
            },
        });
        const artifacts: any[] = [
            presentationSourceArtifact(task, written, completedAt),
            presentationQaArtifact(task, written, completedAt),
        ];
        const requestedOutputs: any = presentationOutputs(input.outputs);
        if (!requestedOutputs.includes('pptx')) {
            return presentationResult({
                task,
                completedAt,
                artifacts,
                status: 'succeeded',
                stage: 'office_presentation_pptd_ready',
                outcome: 'pptd_ready',
                tools: ['army.task.read', 'office.pptd.write'],
            });
        }
        try {
            const pptxRelativePath: any = `${projectBase}/deck.pptx`;
            const exported: any = await roleToolContext.execute({
                toolId: 'office.pptx.export',
                relativePath: pptxRelativePath,
                externalSideEffect: 'none',
                input: {
                    manifestRelativePath,
                    dataClassification: input.dataClassification || 'internal',
                },
            });
            artifacts[1] = presentationQaArtifact(task, written, completedAt, { exported });
            artifacts.push(presentationPptxArtifact(task, exported, completedAt));
            return presentationResult({
                task,
                completedAt,
                artifacts,
                status: 'succeeded',
                stage: 'office_presentation_ready',
                outcome: 'pptd_pptx_ready',
                tools: ['army.task.read', 'office.pptd.write', 'office.pptx.export'],
            });
        }
        catch (error: any) {
            const blocked: any = presentationExportBlocker(error);
            artifacts[1] = presentationQaArtifact(task, written, completedAt, { blocker: blocked });
            return {
                ...presentationResult({
                    task,
                    completedAt,
                    artifacts,
                    status: 'needs_input',
                    stage: blocked.stage,
                    outcome: 'pptd_ready_export_blocked',
                    tools: ['army.task.read', 'office.pptd.write'],
                }),
                error: {
                    code: blocked.code,
                    message: String(error?.message || blocked.userMessage).slice(0, 500),
                    userMessage: blocked.userMessage,
                    category: blocked.category || 'manual',
                    stage: blocked.stage,
                    diagnosticStage: blocked.diagnosticStage || null,
                    attempt: blocked.attempt || null,
                    retryable: false,
                    occurredAt: completedAt,
                },
            };
        }
    }
}
function presentationSourceArtifact(task: any, written: any, completedAt: any): any {
    return {
        artifactId: `office-presentation-source:${task.taskId}`,
        taskId: task.taskId,
        type: 'office_presentation_source',
        title: `${clean(task.input?.title) || '办公演示文稿'}（可编辑 PPTD）`,
        location: `workspace://${written.manifestRelativePath}`,
        mimeType: written.mimeType,
        checksum: written.checksum,
        accessScope: 'local-owner',
        createdAt: completedAt,
        validation: written.validation,
        data: {
            toolId: 'office.pptd.write',
            projectRelativePath: written.projectRelativePath,
            manifestRelativePath: written.manifestRelativePath,
            pageCount: written.validation?.pageCount,
            source: written.source,
        },
    };
}
function presentationQaArtifact(task: any, written: any, completedAt: any, { exported = null, blocker = null }: any = {}): any {
    const visualQaPassed: any = exported?.validation?.visualQaPassed === true;
    return {
        artifactId: `office-presentation-qa:${task.taskId}`,
        taskId: task.taskId,
        type: 'office_presentation_qa',
        title: `${clean(task.input?.title) || '办公演示文稿'}（结构质检）`,
        location: `workspace://${written.qaRelativePath}`,
        mimeType: 'application/json',
        checksum: written.checksum,
        accessScope: 'local-owner',
        createdAt: completedAt,
        validation: {
            exists: true,
            readable: true,
            nonEmpty: true,
            structuralQaPassed: written.validation?.structuralQaPassed === true,
            visualQaPassed,
            humanOfficeReviewRequired: true,
        },
        data: {
            stage: visualQaPassed ? 'visual' : 'structural',
            pageCount: written.validation?.pageCount,
            previewRefs: exported?.qaOverviewRelativePath
                ? [`workspace://${exported.qaOverviewRelativePath}`]
                : [],
            issues: blocker ? [{
                    code: blocker.code,
                    message: blocker.userMessage,
                    diagnosticStage: blocker.diagnosticStage || null,
                    attempt: blocker.attempt || null,
                }] : [],
            visualReviewStatus: visualQaPassed ? 'passed' : 'not_run',
        },
    };
}
function presentationPptxArtifact(task: any, exported: any, completedAt: any): any {
    return {
        artifactId: `office-pptx:${task.taskId}`,
        taskId: task.taskId,
        type: 'office_pptx_document',
        title: `${clean(task.input?.title) || '办公演示文稿'}（PPTX）`,
        location: `workspace://${exported.relativePath}`,
        mimeType: exported.mimeType,
        checksum: exported.checksum,
        accessScope: 'local-owner',
        createdAt: completedAt,
        validation: exported.validation,
        data: {
            toolId: 'office.pptx.export',
            relativePath: exported.relativePath,
            bytes: exported.bytes,
            durationMs: exported.durationMs,
            attempts: exported.attempts,
            pageCount: exported.validation?.pageCount,
            fadeTransitions: exported.validation?.fadeTransitions,
            transitionXmlOrderValid: exported.validation?.transitionXmlOrderValid,
            fontParts: exported.validation?.fontParts,
            fontEmbeddingVerified: exported.validation?.fontEmbeddingVerified,
        },
    };
}
function presentationResult({ task, completedAt, artifacts, status, stage, outcome, tools }: any): any {
    return {
        status,
        currentStage: stage,
        execution: {
            executor: 'office-assistant',
            mode: 'presentation_package',
            startedAt: task.execution?.startedAt || completedAt,
            finishedAt: completedAt,
            outcome,
        },
        usage: { tools: tools.map((id: any): any => ({ id, name: id, calls: 1 })) },
        artifactRefs: artifacts,
    };
}
function presentationOutputs(value: any): any {
    if (!Array.isArray(value) || !value.length)
        return ['pptd', 'pptx'];
    const outputs: any = [...new Set(value.map((item: any): any => String(item || '').trim().toLowerCase()))]
        .filter((item: any): any => ['pptd', 'pptx'].includes(item));
    return outputs.length ? outputs : ['pptd', 'pptx'];
}
function presentationExportBlocker(error: any): any {
    const code: any = String(error?.code || 'presentation_export_needs_capability');
    const diagnosticStage: any = safePresentationDiagnosticStage(error?.stage);
    const attempt: any = [1, 2].includes(Number(error?.attempt)) ? Number(error.attempt) : null;
    if (['external_data_processing_denied', 'presentation_external_processing_denied'].includes(code)) {
        return {
            code: 'presentation_external_processing_denied',
            stage: 'office_presentation_external_processing_denied',
            userMessage: '可编辑 PPTD 已生成；内部或敏感材料不能交给 Kimi 公共编辑器处理，因此没有生成 PPTX。',
        };
    }
    if (['external_data_processing_approval_required', 'presentation_external_processing_approval_required'].includes(code)) {
        return {
            code: 'presentation_external_processing_approval_required',
            stage: 'office_presentation_waiting_external_approval',
            userMessage: '可编辑 PPTD 已生成；PPTX 导出会使用 Kimi 公共编辑器，需要负责人明确批准本次外部处理。',
        };
    }
    if (['ETIMEDOUT', 'EPLAYWRIGHT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH'].includes(code)) {
        const location: any = diagnosticStage ? `（${presentationDiagnosticLabel(diagnosticStage)}）` : '';
        return {
            code: 'presentation_export_waiting_test',
            stage: 'office_presentation_waiting_test',
            category: 'temporary_dependency',
            diagnosticStage,
            attempt,
            userMessage: `可编辑 PPTD 已生成；图片质检或 PPTX 外部导出${location}暂时失败，已停止自动重试并保留诊断阶段，等待受控复测。`,
        };
    }
    return {
        code: 'presentation_export_needs_capability',
        stage: 'office_presentation_export_needs_capability',
        userMessage: '可编辑 PPTD 已生成；当前缺少兼容的本地 PPTX 导出依赖，页面渲染质检尚未完成，系统没有自动安装或升级软件。',
    };
}
function safePresentationDiagnosticStage(value: any): any {
    const stage: any = String(value || '').trim();
    return new Set([
        'visualQa.images', 'export.pptx', 'browser.launch', 'browser.navigation', 'deck.ready',
        'browser.viewport', 'editor.snapshot', 'editor.control', 'editor.export_dialog',
        'editor.image_format', 'visualQa.download', 'visualQa.download_wait',
        'pptx.download', 'pptx.download_wait',
    ]).has(stage) ? stage : null;
}
function presentationDiagnosticLabel(stage: any): any {
    if (stage === 'browser.navigation')
        return '打开公共编辑器';
    if (stage === 'deck.ready')
        return '等待演示文稿就绪';
    if (stage.startsWith('editor.'))
        return '定位导出控件';
    if (stage.startsWith('visualQa.download'))
        return '下载页面图片';
    if (stage.startsWith('pptx.download'))
        return '下载 PPTX';
    if (stage === 'browser.launch')
        return '启动隔离浏览器';
    return stage === 'export.pptx' ? '生成 PPTX' : '生成页面图片';
}
function referencedTasks(task: any, allTasks: any): any {
    const explicit: any = list(task?.input?.context?.sourceTaskIds || task?.input?.sourceTaskIds);
    const siblingIds: any = task?.parentTaskId
        ? allTasks.filter((item: any): any => item.parentTaskId === task.parentTaskId && item.taskId !== task.taskId && item.assigneeAgentId !== 'office-assistant').map((item: any): any => item.taskId)
        : [];
    const ids: any = new Set([...explicit, ...siblingIds]);
    return allTasks
        .filter((item: any): any => ids.has(item.taskId))
        .sort((left: any, right: any): any => String(left.createdAt || '').localeCompare(String(right.createdAt || '')))
        .map(sourceTaskSummary);
}
function sourceTaskSummary(task: any): any {
    const artifacts: any = (task.artifactRefs || []).filter((artifact: any): any => artifact?.validation?.exists === true && artifact?.validation?.nonEmpty === true);
    return {
        taskId: task.taskId,
        title: clean(task.input?.title) || '未命名工作',
        employeeId: task.assigneeAgentId || null,
        status: task.status,
        stage: task.currentStage || null,
        terminal: isTaskNotificationTerminalStatus(task.status),
        artifacts: artifacts.map((artifact: any): any => ({
            type: artifact.type,
            title: clean(artifact.title) || '未命名产物',
            location: safeArtifactLocation(artifact.location),
            summary: knowledgeArtifactSummary(artifact),
            publishingStatus: clean(artifact.data?.publishingStatus),
        })),
        error: task.error?.userMessage ? clean(task.error.userMessage).slice(0, 240) : null,
    };
}
function knowledgeArtifactSummary(artifact: any): any {
    const data: any = artifact?.data || {};
    if (artifact?.type === 'platform_content_draft') {
        const platforms: any = list(data.platforms).join('、');
        const title: any = clean(data.drafts?.[0]?.titleCandidates?.[0]);
        return [
            platforms ? `已生成 ${platforms} 待审草稿` : '已生成平台待审草稿',
            title ? `首选标题“${title}”` : '',
            data.publishingStatus === 'draft_only' ? '未发布' : '',
        ].filter(Boolean).join('；');
    }
    if (artifact?.type === 'video_content_analysis_report') {
        const summary: any = clean(data.summary);
        const completeness: any = clean(data.completeness);
        return [summary, completeness ? `完整度 ${completeness}` : ''].filter(Boolean).join('；').slice(0, 360);
    }
    return clean(data.summary).slice(0, 360);
}
function statusLabel(status: any): any {
    return taskStatusLabel(status);
}
function safeArtifactLocation(value: any): any {
    const location: any = String(value || '').trim();
    return /^(?:runtime|file):\/\//.test(location) || /^https:\/\/[^ ]+/.test(location) ? location.slice(0, 500) : '';
}
function safeSegment(value: any): any {
    return String(value || 'task').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || 'task';
}
function list(value: any): any {
    return [...new Set((Array.isArray(value) ? value : []).map((item: any): any => String(item || '').trim()).filter(Boolean))];
}
function clean(value: any): any {
    return String(value || '').replace(/\s+/g, ' ').trim();
}
function needsInput(now: any, code: any, userMessage: any): any {
    return {
        status: 'needs_input',
        currentStage: code,
        error: { code, userMessage, category: 'needs_input', stage: 'input', occurredAt: now().toISOString() },
    };
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { OfficePresentationProduction } from './office-presentation-production.ts';
import { isTaskNotificationTerminalStatus, taskStatusLabel, } from './task-status-policy.ts';
export class LocalOfficeAssistant {
    artifactsDir: any;
    knowledgeArchive: any;
    now: any;
    officePresentationProduction: any;
    store: any;
    constructor({ store, artifactsDir, knowledgeArchive = null, now = (): any => new Date() }: any = {}) {
        this.store = store;
        this.artifactsDir = artifactsDir;
        this.knowledgeArchive = knowledgeArchive;
        this.now = now;
        this.officePresentationProduction = new OfficePresentationProduction();
    }
    supports(agent: any): any { return agent?.agentId === 'office-assistant'; }
    async execute(task: any, { roleToolContext = null }: any = {}): Promise<any> {
        if (task.taskType === 'office.presentation-package') {
            return this.executePresentationPackage(task, roleToolContext);
        }
        if (task.taskType === 'office.knowledge-summary') {
            return this.executeKnowledgeSummary(task, roleToolContext);
        }
        const title: any = clean(task?.input?.title);
        const description: any = clean(task?.input?.description);
        const allTasks: any = roleToolContext
            ? await roleToolContext.execute({
                toolId: 'army.task.read',
                input: {
                    sourceTaskIds: list(task?.input?.context?.sourceTaskIds),
                    parentTaskId: task?.parentTaskId || null,
                    currentTaskId: task?.taskId,
                },
            })
            : typeof this.store?.list === 'function' ? await this.store.list() : [];
        const sources: any = referencedTasks(task, allTasks);
        if (!hasUsefulInput(title, description, sources)) {
            return needsInput(this.now(), 'office_material_required', '请提供需要整理的材料，或指定已经完成的任务；办公执行助理不会用空内容生成假汇报。');
        }
        const completedAt: any = this.now().toISOString();
        const report: any = buildReport({ title, description, sources, completedAt });
        const taskSegment: any = safeSegment(task.taskId);
        let filePath: any;
        let bytes: any;
        if (roleToolContext) {
            const written: any = await roleToolContext.execute({
                toolId: 'office.artifact.write',
                relativePath: `work-products/${taskSegment}/office-briefing.md`,
                input: { contents: report.markdown },
            });
            filePath = written.filePath;
            bytes = written.bytes;
        }
        else {
            const directory: any = path.join(this.artifactsDir, safeSegment(task.taskId));
            filePath = path.join(directory, '办公汇报包.md');
            await fs.mkdir(directory, { recursive: true, mode: 0o700 });
            await fs.chmod(directory, 0o700);
            await fs.writeFile(filePath, report.markdown, { encoding: 'utf8', mode: 0o600 });
            await fs.chmod(filePath, 0o600);
            const stat: any = await fs.stat(filePath);
            if (!stat.isFile() || stat.size < 1)
                throw new Error('办公汇报包写入后为空。');
            bytes = stat.size;
        }
        const additionalArtifacts: any = roleToolContext
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
            status: 'succeeded',
            currentStage: 'office_briefing_ready',
            execution: {
                executor: 'office-assistant',
                mode: sources.length ? 'referenced_task_briefing' : 'provided_material_briefing',
                startedAt: task.execution?.startedAt || completedAt,
                finishedAt: completedAt,
                outcome: 'briefing_ready'
            },
            usage: {
                tools: [
                    { id: 'office-artifact-write', name: '办公汇报包写入', calls: 1 },
                    ...additionalArtifacts.map((artifact: any): any => ({
                        id: artifact.data?.toolId || artifact.type,
                        name: artifact.title,
                        calls: artifact.data?.duplicate ? 0 : 1,
                    })),
                ],
            },
            artifactRefs: [{
                    artifactId: `office-briefing:${task.taskId}`,
                    taskId: task.taskId,
                    type: 'office_briefing_package',
                    title: report.title,
                    location: `file://${filePath}`,
                    mimeType: 'text/markdown',
                    accessScope: 'local-owner',
                    createdAt: completedAt,
                    validation: {
                        exists: true,
                        readable: true,
                        nonEmpty: true,
                        bytes,
                        sourceTaskCount: sources.length,
                        sourceStatusesTruthful: true,
                        includesOpenItems: true,
                        includesNextAction: true
                    },
                    data: {
                        title: report.title,
                        summary: report.summary,
                        sourceTasks: report.sourceTasks,
                        openItems: report.openItems,
                        nextAction: report.nextAction,
                        markdown: report.markdown
                    }
                }, ...additionalArtifacts]
        };
    }
    async executeKnowledgeSummary(task: any, roleToolContext: any = null): Promise<any> {
        if (!this.knowledgeArchive)
            return needsInput(this.now(), 'knowledge_archive_unavailable', '统一知识库写入能力尚未配置。');
        const title: any = clean(task?.input?.title);
        const description: any = clean(task?.input?.description);
        const allTasks: any = roleToolContext
            ? await roleToolContext.execute({
                toolId: 'army.task.read',
                input: {
                    sourceTaskIds: list(task?.input?.context?.sourceTaskIds),
                    parentTaskId: task?.parentTaskId || null,
                    currentTaskId: task?.taskId,
                },
            })
            : typeof this.store?.list === 'function' ? await this.store.list() : [];
        const sources: any = referencedTasks(task, allTasks);
        if (!hasUsefulInput(title, description, sources)) {
            return needsInput(this.now(), 'knowledge_material_required', '请提供当前任务材料，或明确引用需要归档的任务。');
        }
        const generatedAt: any = this.now().toISOString();
        const decisions: any = sources.flatMap((item: any): any => item.artifacts.map(knowledgeConclusion)).slice(0, 10);
        const openItems: any[] = [
            ...sources.filter((item: any): any => item.status !== 'succeeded').map((item: any): any => `${item.title}：${item.error || statusLabel(item.status)}`),
            ...sources.flatMap((item: any): any => item.artifacts.flatMap(knowledgeArtifactOpenItems))
        ];
        const markdown: any = [
            `# ${title || 'Agent军团任务总结'}`,
            '',
            '## 摘要',
            '',
            sources.length ? `本笔记归档 ${sources.length} 项明确引用的军团工作和已验证产物。` : description,
            '',
            '## 关键结论',
            '',
            ...(decisions.length ? decisions.map((item: any): any => `- ${item}`) : ['- 当前材料没有可验证的上游产物。']),
            '',
            '## 决定',
            '',
            '- 只归档当前任务明确提供或引用的脱敏材料。',
            '- 原始凭据、Cookie、私密聊天和未确认转录不进入知识笔记。',
            '',
            '## 待办',
            '',
            ...(openItems.length ? openItems.map((item: any): any => `- ${item}`) : ['- 无。']),
            '',
            '## 来源引用',
            '',
            ...(sources.length ? sources.map((item: any): any => `- 任务 ${item.taskId}｜${item.title}｜${statusLabel(item.status)}`) : ['- 当前任务正文。']),
            '',
            `生成时间：${generatedAt}`,
            `任务 ID：${task.taskId}`,
            ''
        ].join('\n');
        const writeInput: Record<string, any> = {
            taskId: task.taskId,
            idempotencyKey: task.idempotencyKey,
            title: title || 'Agent军团任务总结',
            markdown,
        };
        const written: any = roleToolContext
            ? await roleToolContext.execute({
                toolId: 'knowledge.archive.write',
                relativePath: 'Agent军团',
                input: writeInput,
            })
            : await this.knowledgeArchive.write(writeInput);
        return {
            status: 'succeeded',
            currentStage: 'knowledge_summary_archived',
            execution: { executor: 'office-assistant', mode: 'knowledge_archive', startedAt: task.execution?.startedAt || generatedAt, finishedAt: generatedAt, outcome: 'knowledge_note_ready' },
            usage: { tools: [{ id: 'knowledge-archive-write', name: '统一知识库受限写入', calls: written.duplicate ? 0 : 1 }] },
            artifactRefs: [{
                    artifactId: `knowledge-summary:${task.taskId}`,
                    taskId: task.taskId,
                    type: 'knowledge_summary_note',
                    title: title || 'Agent军团任务总结',
                    sourceRefs: sources.map((item: any): any => item.taskId),
                    location: `file://${written.filePath}`,
                    mimeType: 'text/markdown',
                    checksum: written.checksum,
                    accessScope: 'local-owner',
                    createdAt: generatedAt,
                    validation: { exists: true, readable: written.readable, nonEmpty: written.bytes > 0, bytes: written.bytes, pathRestricted: true, idempotent: true, duplicate: written.duplicate },
                    data: { title: title || 'Agent军团任务总结', summary: sources.length ? `已归档 ${sources.length} 项关联工作。` : description, sourceTasks: sources.map((item: any): any => item.taskId), openItems, generatedAt }
                }]
        };
    }
    async executePresentationPackage(task: any, roleToolContext: any = null): Promise<any> {
        return this.officePresentationProduction.execute({
            task,
            roleToolContext,
            now: (): any => this.now(),
        });
    }
}
async function writeRequestedOfficeArtifacts({ task, report, sources, completedAt, taskSegment, roleToolContext, }: any): Promise<any> {
    const artifacts: any[] = [];
    for (const format of officeOutputFormats(task)) {
        const toolId: any = `office.${format}.write`;
        const relativePath: any = `work-products/${taskSegment}/office-briefing.${format}`;
        const input: any = format === 'xlsx'
            ? { title: report.title, rows: officeSpreadsheetRows(sources, report) }
            : { title: report.title, markdown: report.markdown };
        const written: any = await roleToolContext.execute({ toolId, relativePath, input });
        artifacts.push({
            artifactId: `office-${format}:${task.taskId}`,
            taskId: task.taskId,
            type: `office_${format}_document`,
            title: `${report.title}（${format.toUpperCase()}）`,
            location: `workspace://${relativePath}`,
            mimeType: written.mimeType,
            checksum: written.checksum,
            accessScope: 'local-owner',
            createdAt: completedAt,
            validation: written.validation,
            data: {
                toolId,
                relativePath,
                bytes: written.bytes,
            },
        });
    }
    const cadence: any = reportCadence(task);
    if (cadence) {
        const toolId: any = `office.report.${cadence}.write`;
        const relativePath: any = `work-products/${taskSegment}/${cadence}-report.md`;
        const written: any = await roleToolContext.execute({
            toolId,
            relativePath,
            input: {
                idempotencyKey: String(task.idempotencyKey || `task-${task.taskId}`).slice(0, 200),
                title: report.title,
                summary: report.summary,
                markdown: report.markdown,
                sourceTaskIds: sources.map((source: any): any => source.taskId),
            },
        });
        artifacts.push({
            artifactId: `office-${cadence}-report:${task.taskId}`,
            taskId: task.taskId,
            type: `office_${cadence}_report_work_product`,
            title: `${report.title}（${cadence === 'daily' ? '日报' : '周报'} Work Product）`,
            location: `paperclip-work-product://${written.workProductId}`,
            checksum: written.contentHash,
            accessScope: 'local-owner',
            createdAt: completedAt,
            validation: {
                exists: true,
                readable: true,
                nonEmpty: true,
                paperclipWorkProduct: true,
                workspaceRestricted: true,
            },
            data: {
                toolId,
                workProductId: written.workProductId,
                relativePath: written.relativePath,
                duplicate: written.duplicate,
            },
        });
    }
    return artifacts;
}
function officeOutputFormats(task: any): any {
    const requested: any = Array.isArray(task?.input?.outputFormats)
        ? task.input.outputFormats
        : [];
    const normalized: any = [...new Set(requested.map((item: any): any => String(item || '').toLowerCase().trim()))]
        .filter((item: any): any => ['docx', 'xlsx', 'pdf'].includes(item));
    return normalized.length
        ? normalized
        : task?.taskType === 'office.deliverable-program' ? ['docx', 'xlsx', 'pdf'] : [];
}
function reportCadence(task: any): any {
    const requested: any = String(task?.input?.reportCadence || '').toLowerCase().trim();
    if (['daily', 'weekly'].includes(requested))
        return requested;
    return task?.taskType === 'content.campaign-metrics' ? 'daily' : null;
}
function officeSpreadsheetRows(sources: any, report: any): any {
    const rows: any[] = [['任务 ID', '标题', '负责人', '状态', '阶段', '已验证产物数']];
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
    if (!sources.length)
        rows.push(['当前任务', report.title, 'office-assistant', '已整理', '', '1']);
    return rows;
}
export function formatOfficeBriefingReply(report: any): any {
    const sourceCount: any = Array.isArray(report?.sourceTasks) ? report.sourceTasks.length : 0;
    const openItems: any = Array.isArray(report?.openItems) ? report.openItems.filter(Boolean) : [];
    return [
        `办公执行助理已完成：${clean(report?.title) || '办公汇报包'}`,
        clean(report?.summary) || '已按现有材料完成整理。',
        sourceCount ? `已核对 ${sourceCount} 项关联工作。` : '本次根据你提供的材料整理。',
        openItems.length ? `仍需处理：${openItems.slice(0, 3).join('；')}` : '当前没有未说明的阻塞项。',
        `下一步：${clean(report?.nextAction) || '请审阅汇报包并指出需要修改的部分。'}`
    ].join('\n');
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
            publishingStatus: clean(artifact.data?.publishingStatus)
        })),
        error: task.error?.userMessage ? clean(task.error.userMessage).slice(0, 240) : null
    };
}
function knowledgeConclusion(artifact: any): any {
    return artifact.summary
        ? `${artifact.title}：${artifact.summary}`
        : artifact.title;
}
function knowledgeArtifactSummary(artifact: any): any {
    const data: any = artifact?.data || {};
    if (artifact?.type === 'platform_content_draft') {
        const platforms: any = list(data.platforms).join('、');
        const title: any = clean(data.drafts?.[0]?.titleCandidates?.[0]);
        return [
            platforms ? `已生成 ${platforms} 待审草稿` : '已生成平台待审草稿',
            title ? `首选标题“${title}”` : '',
            data.publishingStatus === 'draft_only' ? '未发布' : ''
        ].filter(Boolean).join('；');
    }
    if (artifact?.type === 'video_content_analysis_report') {
        const summary: any = clean(data.summary);
        const completeness: any = clean(data.completeness);
        return [summary, completeness ? `完整度 ${completeness}` : ''].filter(Boolean).join('；').slice(0, 360);
    }
    return clean(data.summary).slice(0, 360);
}
function knowledgeArtifactOpenItems(artifact: any): any {
    if (artifact.type === 'platform_content_draft' && artifact.publishingStatus === 'draft_only') {
        return ['人工审阅平台草稿；确认事实、隐私和表达后，再单独决定是否发布。'];
    }
    return [];
}
function buildReport({ title, description, sources, completedAt }: any): any {
    const reportTitle: any = `${title || '工作整理'}｜办公汇报包`;
    const succeeded: any = sources.filter((item: any): any => item.status === 'succeeded');
    const unfinished: any = sources.filter((item: any): any => item.status !== 'succeeded');
    const summary: any = sources.length
        ? `已核对 ${sources.length} 项关联工作：${succeeded.length} 项完成，${unfinished.length} 项尚未完整完成。`
        : '已根据当前任务中提供的材料完成结构化整理。';
    const sourceLines: any = sources.length
        ? sources.map((item: any): any => `- ${statusLabel(item.status)}｜${item.title}｜负责人：${item.employeeId || '待确定'}｜任务号：${item.taskId}`)
        : ['- 当前任务未引用其他员工任务。'];
    const artifactLines: any = sources.flatMap((item: any): any => item.artifacts.map((artifact: any): any => `- ${item.title} → ${artifact.title}${artifact.location ? `（${artifact.location}）` : ''}`));
    const openItems: any = unfinished.map((item: any): any => `${item.title}：${item.error || statusLabel(item.status)}`);
    if (!sources.length && !description)
        openItems.push('未提供独立材料正文；本次仅按任务目标整理。');
    const nextAction: any = openItems.length
        ? '先补齐或完成上述未决事项，再生成最终版汇报包。'
        : '请审阅汇报包；需要修改时直接在原任务中说明。';
    const markdown: any = [
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
        ...(openItems.length ? openItems.map((item: any): any => `- ${item}`) : ['- 无。']),
        '',
        '## 下一步',
        '',
        nextAction,
        ''
    ].join('\n');
    return {
        title: reportTitle,
        summary,
        sourceTasks: sources,
        openItems,
        nextAction,
        markdown
    };
}
function hasUsefulInput(title: any, description: any, sources: any): any {
    return description.length >= 6 || sources.length > 0 || title.length >= 12;
}
function statusLabel(status: any): any {
    return taskStatusLabel(status);
}
function safeArtifactLocation(value: any): any {
    const location: any = String(value || '').trim();
    return /^(?:runtime|file):\/\//.test(location) || /^https:\/\/[^ ]+/.test(location) ? location.slice(0, 500) : '';
}
function safeSegment(value: any): any { return String(value || 'task').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || 'task'; }
function list(value: any): any { return [...new Set((Array.isArray(value) ? value : []).map((item: any): any => String(item || '').trim()).filter(Boolean))]; }
function clean(value: any): any { return String(value || '').replace(/\s+/g, ' ').trim(); }
function needsInput(now: any, code: any, userMessage: any): any {
    return { status: 'needs_input', currentStage: code, error: { code, userMessage, category: 'needs_input', stage: 'input', occurredAt: now.toISOString() } };
}

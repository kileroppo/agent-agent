import { formatPublicReportReply } from './public-report-presentation.ts';
import { formatOfficeBriefingReply } from './local-office-assistant.ts';
import { ValidationError } from './task-service-execution-support.ts';
import { validateTaskCompletion } from './task-completion-contract.ts';
import { wasVisualAnalysisUsed } from './local-content-artifacts.ts';
import { isTaskNotificationTerminalStatus, taskStatusLabel, } from './task-status-policy.ts';
import { taskDeliveryNotification } from './task-delivery-notification.ts';
export class TaskNotification {
    executors: any;
    registry: any;
    store: any;
    constructor({ store, registry, executors = {} }: any) {
        this.store = store;
        this.registry = registry;
        this.executors = executors;
    }
    async status(taskId: any, chatRef: any = ''): Promise<any> {
        const tasks: any = await this.store.list();
        const root: any = tasks.find((task: any): any => task.taskId === taskId);
        if (!root)
            throw new ValidationError('找不到要跟进的任务。');
        assertSameChat(root, chatRef);
        const chain: any = taskChain(tasks, root.taskId);
        const immediate: any = technicalOrPausedStatus(root, chain);
        if (immediate)
            return immediate;
        const attempts: any = chain.filter((task: any): any => task.taskType === root.taskType && (task.taskId === root.taskId || task.recovery?.rootTaskId === root.taskId));
        const current: any = latestTask(attempts) || root;
        const retried: any = current.taskId !== root.taskId;
        if (current.taskType === 'army.cross-agent-mission') {
            return missionNotification(current, {
                chain,
                approvals: await this.store.listApprovals(),
                xiaod: this.executors.xiaod,
            });
        }
        if (current.status === 'succeeded') {
            const transcriptDelivery: any = artifact(current, 'xiaod_media_delivery')?.data;
            if (transcriptDelivery?.currentTranscriptDelivered === false) {
                const version: any = Number(transcriptDelivery.transcriptVersion) || null;
                return status(root, 'revision_pending_delivery', true, `“${shortTaskTitle(root)}”的字幕已补正${version ? `为 v${version}` : ''}，本地分析会使用最新版；原飞书文档仍是旧版，系统不会把它冒充最新交付，也不会自动外发。`, current);
            }
            const completion: any = validateTaskCompletion(current);
            if (!completion.valid)
                return incompleteDeliveryStatus(root, `${completion.reason} 系统不会把状态当作完整交付。`, current);
            return this.succeededStatus(root, current, retried);
        }
        if (['queued', 'running'].includes(current.status)) {
            const worker: any = await taskWorkerName(this.registry, current);
            let stageDetail = '';
            if (current.currentStage === 'delivery_quality_review_pending') {
                stageDetail = `“${shortTaskTitle(root)}”已完成初步数据检索，目前正在进行交付质量复核。`;
            }
            return status(root, current.status, false, retried
                ? `“${shortTaskTitle(root)}”第一次处理失败，运维官已自动重试，当前仍在处理中。`
                : stageDetail || `“${shortTaskTitle(root)}”正在由${worker}处理。`, current);
        }
        return unfinishedStatus(root, current);
    }
    async succeededStatus(root: any, current: any, retried: any): Promise<any> {
        const deliveryNotice: any = taskDeliveryNotification(current, shortTaskTitle(root));
        if (deliveryNotice)
            return status(root, deliveryNotice.status, true, deliveryNotice.message, current, { deliveryReceipt:deliveryNotice.deliveryReceipt });
        const result: any = verifiedDelivery(current, root);
        if (result)
            return result;
        const roleReport: any = artifact(current, 'employee_role_report')?.data;
        if (roleReport?.summary) {
            const worker: any = await taskWorkerName(this.registry, current);
            return status(root, 'succeeded', true, `${worker}已完成“${shortTaskTitle(root)}”。\n${roleReport.summary}`, current);
        }
        const delivery: any = artifact(current, 'xiaod_media_delivery');
        const url: any = delivery?.data?.larkUrl;
        const verified: any = delivery?.data?.larkPermissionGranted === true;
        const prefix: any = retried ? '运维官自动恢复后，小D已经完成' : '小D已经完成';
        return status(root, 'succeeded', true, url && verified
            ? `${prefix}“${shortTaskTitle(root)}”。\n交付文档：${url}`
            : `${prefix}“${shortTaskTitle(root)}”，但飞书文档权限尚未确认；系统不会把它冒充完整交付。`, current);
    }
}
function assertSameChat(task: any, chatRef: any): any {
    const expected: any = String(task.source?.chatRef || '').trim();
    const actual: any = String(chatRef || '').trim();
    if (expected && actual !== expected)
        throw new ValidationError('当前会话不能读取这条任务。');
}
function technicalOrPausedStatus(root: any, chain: any): any {
    if (root.status === 'paused')
        return status(root, 'paused', isTaskNotificationTerminalStatus(root.status), `“${shortTaskTitle(root)}”已经暂停。你确认继续前，小D不会开始新的处理步骤。`);
    if (root.status === 'pausing')
        return status(root, 'pausing', isTaskNotificationTerminalStatus(root.status), `“${shortTaskTitle(root)}”正在暂停。小D会先完成当前一步，再在安全位置停下；不会再开始新的步骤。`);
    const technical: any = latestTask(chain.filter((task: any): any => task.taskType === 'operations.technical-repair'));
    if (!technical)
        return null;
    if (technical.status === 'waiting_test') {
        const evidence: any = artifact(technical, 'technical_repair_evidence')?.data;
        const nextAction: any = evidence?.nextAction || technical.error?.userMessage || '本轮自动检查没有完成，已保留为待测试。';
        return status(root, 'waiting_test', true, `“${shortTaskTitle(root)}”本轮暂时无法完成自动验证，已标为待测试。技术专家已保留当前结果：${nextAction} 其他工作会继续推进，不需要你重复提交。`, technical);
    }
    if (technical.status === 'succeeded') {
        const evidence: any = artifact(technical, 'technical_repair_evidence');
        const verified: any = evidence?.validation?.testsPassed === true && evidence?.validation?.recoveryVerified === true;
        return status(root, verified ? 'repair_verified' : 'technical_repair', true, verified
            ? `“${shortTaskTitle(root)}”遇到的故障已由技术专家修复，相关测试和恢复检查已经通过；仍待人工验收的项目已保留在记录中。`
            : `“${shortTaskTitle(root)}”仍未完成。技术专家已经建立修复记录，但目前没有完整的修改、测试和恢复证据，A君不会把它当作已经修好。`, technical);
    }
    if (technical.status === 'failed')
        return status(root, 'technical_repair_failed', true, `“${shortTaskTitle(root)}”仍未完成。技术专家本轮也没有修复成功，故障记录已经保留，将继续进入下一轮处理。`, technical);
    return status(root, 'technical_repair', !['queued', 'running'].includes(technical.status), `“${shortTaskTitle(root)}”仍未完成。运维官已经尝试安全恢复，现在已升级给技术专家并建立修复任务；暂时不需要你重复提交。`, technical);
}
function verifiedDelivery(current: any, root: any): any {
    const title: any = shortTaskTitle(root);
    const delivery: any = ({
        'operations.health-review': (): any => {
            const report: any = artifact(current, 'health_report')?.data;
            return report?.overall && Array.isArray(report.components) && report.components.length
                ? formatHealthReportReply(report)
                : `运维官已经完成“${title}”，但结构化健康报告不可读；系统不会把它当作完整交付。`;
        },
        'report.public-material': (): any => {
            const report: any = artifact(current, 'public_web_report')?.data;
            return report?.summary ? formatPublicReportReply(report, { taskTitle: title }) : `公开资料报告员已经完成“${title}”，但摘要产物没有通过读取确认；系统不会把它当作完整交付。`;
        },
        'research.github-search': (): any => {
            const report: any = artifact(current, 'research_github_report')?.data;
            const read: any = artifact(current, 'github_code_read')?.data;
            if (report?.results?.length)
                return formatGithubSearchDelivery(report);
            if (read?.summary)
                return `小R已读取 ${read.repo} 的 ${read.path}：${read.summary}\n来源：${read.source || `https://github.com/${read.repo}`}`;
            return `小R已经完成“${title}”，但公开 GitHub 产物不可读；系统不会把它当作完整交付。`;
        },
        'research.intel-report': (): any => {
            const report: any = artifact(current, 'intel_research_report')?.data;
            return report?.conclusion && Array.isArray(report.sources) && report.sources.length
                ? formatIntelResearchDelivery(report)
                : `小R已经完成“${title}”，但结构化研究产物或来源未通过读取确认；系统不会把它当作完整交付。`;
        },
        'office.briefing-package': (): any => {
            const report: any = artifact(current, 'office_briefing_package')?.data;
            return report?.summary && report?.markdown ? formatOfficeBriefingReply(report) : `办公执行助理已经完成“${title}”，但汇报包没有通过读取确认；系统不会把它当作完整交付。`;
        },
        'office.presentation-package': (): any => presentationDelivery(current, title),
        'office.knowledge-summary': (): any => knowledgeDelivery(current, title),
        'content.video-benchmark-analysis': (): any => {
            const report: any = artifact(current, 'video_content_analysis_report')?.data;
            return report?.modules?.length ? formatVideoAnalysisDelivery(report) : `小拆已经完成“${title}”，但拆解报告没有通过读取确认；系统不会把它当作完整交付。`;
        },
        'content.platform-draft': (): any => {
            const draft: any = artifact(current, 'platform_content_draft')?.data;
            return draft?.drafts?.length ? formatPlatformDraftDelivery(draft) : `小创已经完成“${title}”，但草稿产物没有通过读取确认；系统不会把它当作完整交付。`;
        },
        'content.video-script-package': (): any => {
            const script: any = artifact(current, 'video_script_package')?.data;
            return script?.fullScript ? formatVideoScriptDelivery(script) : `小创已经完成“${title}”，但可拍脚本没有通过读取确认；系统不会把它当作完整交付。`;
        },
        'content.performance-review': (): any => {
            const report: any = artifact(current, 'content_performance_report')?.data;
            return report?.metrics ? `【小拆内容表现复盘】\n${report.summary}\n${(report.observations || []).slice(0, 5).map((item: any): any => `- ${item}`).join('\n')}` : null;
        },
    } as any)[current.taskType]?.();
    return delivery ? status(root, 'succeeded', true, delivery, current) : null;
}
function presentationDelivery(task: any, title: any): any {
    const source: any = artifact(task, 'office_presentation_source');
    const pptx: any = artifact(task, 'office_pptx_document');
    if (!source?.validation?.structuralQaPassed || !source?.location)
        return `小办已经完成“${title}”，但 PPTD 没有通过结构检查；系统不会把它当作完整交付。`;
    return [
        `小办已完成“${title}”的可编辑 PPTD。`,
        `PPTD：${source.location}`,
        pptx?.validation?.visualQaPassed && pptx?.location ? `PPTX：${pptx.location}` : 'PPTX 和图片质检未作为本次完成证据。',
    ].join('\n');
}
function knowledgeDelivery(task: any, title: any): any {
    const note: any = artifact(task, 'knowledge_summary_note');
    return note?.validation?.readable && note?.location
        ? `小办已完成知识归档“${note.title}”。\n受控文件：${note.location}\n校验值：${note.checksum || '未提供'}`
        : `小办已经完成“${title}”，但知识笔记没有通过可读性检查；系统不会把它当作完整归档。`;
}
function unfinishedStatus(root: any, current: any): any {
    const title: any = shortTaskTitle(root);
    if (current.status === 'waiting_worker')
        return status(root, 'waiting_worker', false, `“${title}”需要老板的 Mac工作间处理。云端已安全排队；Mac 上线后会自动领取，不需要你重复提交。`, current);
    if (current.status === 'failed' && current.recovery?.coordination?.status === 'start_failed')
        return status(root, 'recovery_start_failed', true, `“${title}”处理失败，自动诊断也未能启动，故障已经记录。暂时不用重复提交。`, current);
    if (current.status === 'failed' && current.recovery?.coordination?.status === 'retrying')
        return status(root, 'recovery_pending', false, `“${title}”遇到故障，运维官已接手并正在从安全断点恢复；不需要你重复提交。`, current);
    if ((current.status === 'failed' && current.recovery?.coordination?.status === 'pending') || (current.status === 'failed' && current.taskType === 'media.transcribe-and-refine' && !current.recovery?.coordination))
        return status(root, 'recovery_pending', false, `“${title}”遇到故障，正在交给运维官判断恢复办法。`, current);
    if (current.recovery?.coordination?.status === 'pending')
        return status(root, 'recovery_pending', false, `“${title}”遇到故障，正在等待运维官接手。`, current);
    if (current.status === 'waiting_test')
        return status(root, 'waiting_test', true, `“${title}”本轮自动检查没有完成，已标为待测试。其他工作会继续推进；这项检查恢复后会按记录继续。`, current);
    if (current.status === 'needs_input')
        return status(root, 'needs_input', true, current.error?.userMessage || `“${title}”缺少必要信息，暂时不能继续。`, current);
    if (current.status === 'failed')
        return status(root, 'failed', true, `“${title}”没有完成：${current.error?.userMessage || '处理时遇到问题。'}`, current);
    return status(root, current.status || 'unknown', isTaskNotificationTerminalStatus(current.status), `“${title}”已经登记，等待新的进度。`, current);
}
function status(root: any, state: any, terminal: any, message: any, sourceTask: any = root, extensions: any = {}): any {
    const result: Record<string, any> = { terminal, status: state, taskId: root.taskId, message, ...(extensions && typeof extensions === 'object' ? extensions : {}) };
    if (!sourceTask?.taskId || sourceTask.taskId === root.taskId)
        return result;
    return {
        ...result,
        projectionTruth: {
            taskId: String(sourceTask.taskId),
            status: String(sourceTask.status || ''),
            updatedAt: String(sourceTask.updatedAt || sourceTask.createdAt || ''),
            revision: String(sourceTask.presentationRevision ?? sourceTask.revision ?? '0'),
        },
    };
}
function incompleteDeliveryStatus(task: any, message: any, sourceTask: any = task): any {
    return status(task, 'waiting_test', true, message, sourceTask);
}
function artifact(task: any, type: any): any {
    return task?.artifactRefs?.find((item: any): any => item.type === type);
}
async function taskWorkerName(registry: any, task: any): Promise<any> {
    const agentId: any = String(task?.assigneeAgentId || task?.execution?.executor || '').trim();
    const agent: any = agentId && typeof registry?.get === 'function' ? await registry.get(agentId) : null;
    return String(agent?.name || agentId || '承接员工').trim();
}
function formatGithubSearchDelivery(report: any): any {
    const items: any = report.results.slice(0, 5).map((item: any, index: any): any => `${index + 1}. ${item.fullName}（★ ${item.stars}，${item.language || '语言未提供'}）\n${item.suitability || item.assessment || ''}${item.suitability && item.assessment ? `\n元数据判断：${item.assessment}` : ''}\n${item.url}`);
    return ['【小R 公开 GitHub 检索】', `关键词：${report.query || '未提供'}`, '', ...items].join('\n');
}
function formatIntelResearchDelivery(report: any): any {
    const list: any = (items: any): any => (Array.isArray(items) && items.length ? items.map((item: any): any => `- ${item}`).join('\n') : '- 暂无。');
    return ['【小R 研究报告】', `主题：${report.topic || '未提供'}`, `背景：${report.background || '仅根据已读取来源整理。'}`, `关键发现：\n${list(report.findings)}`, `结论：${report.conclusion}`, `行动建议：\n${list(report.recommendations)}`, `未决问题：\n${list(report.openQuestions)}`, `来源：\n${report.sources.slice(0, 5).map((source: any): any => `- ${source.title || '公开来源'}\n  ${source.source}`).join('\n')}`].join('\n\n');
}
function formatHealthReportReply(report: any): any {
    const overall: any = report.overall === 'healthy' ? '正常' : report.overall === 'degraded' ? '存在降级' : String(report.overall || '未知');
    const components: any = report.components.slice(0, 12).map((item: any): any => {
        const componentStatus: any = item.status === 'healthy' ? '正常' : item.status === 'degraded' ? '降级' : String(item.status || '未知');
        return `- ${item.name || item.id || '未命名组件'}：${componentStatus}${item.detail ? `；${item.detail}` : ''}`;
    }).join('\n');
    return `【运维官健康检查】\n整体：${overall}\n${components}\n建议：${report.recommendedAction || '暂无。'}`;
}
function formatVideoAnalysisDelivery(report: any): any {
    const visualAnalysisUsed: any = wasVisualAnalysisUsed(report);
    const modules: any = report.modules.slice(0, 13).map((item: any, index: any): any => `${index + 1}. ${item.name}：${item.finding}\n   证据：${item.evidence?.timestamp ? `[${item.evidence.timestamp}] ` : ''}${item.evidence?.fragment || '证据缺失'}`).join('\n');
    const actions: any = Array.isArray(report.actionItems) && report.actionItems.length ? `\n\n行动清单：\n${report.actionItems.slice(0, 5).map((item: any): any => `- ${item}`).join('\n')}` : '';
    const visual: any = visualAnalysisUsed && Array.isArray(report.visualFindings) && report.visualFindings.length ? `\n\n画面观察：\n${report.visualFindings.slice(0, 5).map((item: any): any => `- [${item.evidence?.timestamp || '时间点缺失'}｜${item.evidence?.frameRef || '帧缺失'}] ${item.finding}`).join('\n')}` : '';
    const visualUsage: any = visualAnalysisUsed ? '已使用图片分析' : '未使用图片分析';
    const source: any = report.sourceMetadata?.title ? `\n来源：${report.sourceMetadata.title}${report.sourceMetadata.author ? `｜${report.sourceMetadata.author}` : ''}${report.sourceMetadata.platform ? `｜${report.sourceMetadata.platform}` : ''}` : '';
    const generation: any = report.generationMode === 'hermes_advisor' ? 'Hermes 深度分析' : report.generationMode === 'hermes_advisor_evidence_repaired' ? 'Hermes 深度分析（证据结构已按确认稿修复）' : '本机证据化兜底（模型结果未通过结构校验）';
    return `【小拆视频内容拆解】\n模式：${generation}\n图片分析：${visualUsage}\n证据：${report.evidenceLabel || report.evidenceMode}${source}\n${report.summary}\n\n${modules}${visual}${actions}`;
}
function formatPlatformDraftDelivery(report: any): any {
    const drafts: any = report.drafts.slice(0, 3).map((item: any): any => `- ${item.platform}：${(item.titleCandidates as any)?.[0] || '已生成草稿'}\n  开场：${item.opening || ''}`).join('\n');
    return `【小创平台草稿】\n仅生成草稿，未发布。\n${drafts}\n发布前仍需真人检查。`;
}
function formatVideoScriptDelivery(report: any): any {
    if (report.templateLifecycle?.approvedForUse === true)
        return '已采用这版。可拍脚本和制作包已经准备好；没有生成成片，也没有发布。';
    const notes: any = Array.isArray(report.shootingNotes) ? report.shootingNotes.slice(0, 3).map((item: any): any => `- ${item}`).join('\n') : '';
    return ['【可拍脚本】', `标题：${report.headline}`, `建议：${report.platform || 'douyin'}｜约 ${report.durationSeconds || 45} 秒`, '', `开场：${report.hook}`, '', report.fullScript, ...(notes ? ['', '拍摄提示：', notes] : []), '', '下一步：满意就回复“用这版”；要改直接说一句，例如“更像我说话”或“节奏快一点”。'].join('\n');
}
async function missionNotification(task: any, { chain = [], approvals = [], xiaod = null }: any = {}): Promise<any> {
    const report: any = artifact(task, 'cross_agent_mission_summary')?.data;
    const statuses: any = Array.isArray(report?.statuses) ? report.statuses.slice(0, 3) : [];
    const names: Record<string, any> = { xiaod: '小D', 'intel-researcher': '小R', 'office-assistant': '办公执行助理', 'video-content-analyst': '小拆', 'content-creator': '小创', operator: '运维官', architect: '架构师' };
    const lines: any = statuses.map((item: any): any => `- ${(names as any)[item.employeeId] || item.employeeId || '待定员工'}：${missionStatusLabel(item.status)}｜${String(item.title || '未命名分工').replace(/\s+/g, ' ').slice(0, 120)}`);
    const terminal: any = isTaskNotificationTerminalStatus(task.status);
    if (!report || !statuses.length)
        return status(task, task.status, terminal, `总任务“${shortTaskTitle(task)}”${terminal ? '已经停止推进，但统一汇总不可读；系统不会把它当作完整交付。' : '正在建立和分派员工工作。'}`);
    const briefing: any = report.decision?.briefing;
    const completed: any = statuses.filter((item: any): any => item.status === 'succeeded').length;
    const progressStatus: any = !terminal && statuses.some((item: any): any => item.status === 'waiting_approval') ? 'waiting_approval' : task.status;
    let deliveryStatus: any = progressStatus;
    const summary: any[] = [`【A君总任务】${String(report.summary || shortTaskTitle(task)).replace(/\s+/g, ' ').slice(0, 300)}`, `进度：${completed}/${statuses.length} 项完成`, ...lines];
    if (briefing?.summary) {
        summary.push(`统一汇报：${String(briefing.summary).replace(/\s+/g, ' ').slice(0, 800)}`);
        if (Array.isArray(briefing.openItems) && briefing.openItems.length)
            summary.push(`仍需处理：${briefing.openItems.slice(0, 3).join('；')}`);
        if (briefing.nextAction)
            summary.push(`下一步：${String(briefing.nextAction).replace(/\s+/g, ' ').slice(0, 500)}`);
    }
    else if (terminal && completed === statuses.length) {
        const analysisTaskId: any = statuses.find((item: any): any => item.employeeId === 'video-content-analyst' && item.status === 'succeeded')?.taskId;
        const analysis: any = artifact(chain.find((item: any): any => item.taskId === analysisTaskId), 'video_content_analysis_report')?.data;
        if (analysis?.modules?.length && validateTaskCompletion(chain.find((item: any): any => item.taskId === analysisTaskId)).valid) {
            summary.push(`\n${formatVideoAnalysisDelivery(analysis)}`);
        }
        else {
            deliveryStatus = 'waiting_test';
            summary.push('所有分工已完成，但最终业务产物未通过读取确认；系统不会只用“完成”状态冒充交付。');
        }
    }
    else if (terminal && completed < statuses.length) {
        if (task.status === 'succeeded')
            deliveryStatus = 'waiting_test';
        summary.push('未完成部分已如实保留，没有被冒充为成功。');
    }
    else if (progressStatus === 'waiting_approval') {
        const reviewTask: any = chain.find((item: any): any => item.status === 'waiting_approval' && item.execution?.executor === 'xiaod' && approvals.some((approval: any): any => approval.taskId === item.taskId && approval.status === 'pending' && approval.action === 'confirm-transcript-after-complete-listen'));
        let reviewUrl: any = '';
        if (reviewTask?.execution?.xiaodJobId && typeof xiaod?.getJob === 'function') {
            try {
                const job: any = await xiaod.getJob(reviewTask.execution.xiaodJobId);
                if (job.output?.larkPermissionGranted === true && /^https:\/\//.test(String(job.output?.larkUrl || '')))
                    reviewUrl = String(job.output.larkUrl);
            }
            catch { /* 保留文字恢复路径。 */ }
        }
        summary.push('机器稿已通过自动完整性检查；正式拆解仍未启动。');
        if (reviewUrl)
            summary.push(`机器稿：${reviewUrl}`);
        summary.push('请完整听完后在本会话回复“我已完整听审并确认”。A君会再弹出一次批准确认；未确认前不会启动小拆。');
    }
    else if (!terminal) {
        summary.push('A君会继续跟进这个总任务，不需要你分别追问每位员工。');
    }
    return status(task, deliveryStatus, terminal, summary.join('\n'));
}
function missionStatusLabel(value: any): any {
    return taskStatusLabel(value);
}
function taskChain(tasks: any, rootTaskId: any): any {
    const included: any = new Set([rootTaskId]);
    let changed: any = true;
    while (changed) {
        changed = false;
        for (const task of tasks) {
            if (task.parentTaskId && included.has(task.parentTaskId) && !included.has(task.taskId)) {
                included.add(task.taskId);
                changed = true;
            }
        }
    }
    return tasks.filter((task: any): any => included.has(task.taskId));
}
function latestTask(tasks: any): any {
    return ([...tasks].sort((left: any, right: any): any => String(right.updatedAt || right.createdAt || '').localeCompare(String(left.updatedAt || left.createdAt || ''))) as any)[0] || null;
}
function shortTaskTitle(task: any): any {
    return String(task.input?.title || '未命名任务').replace(/\s+/g, ' ').slice(0, 48);
}

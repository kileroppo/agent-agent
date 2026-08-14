import { M5ProductionTemplateResolutionError, defaultM5ProductionTemplateBinding, validM5ProductionTemplateBinding, } from './m5-production-template-resolver.ts';
import { LocalVideoScriptContentProtocol } from './local-video-script-content-protocol.ts';
import { approveLocalVideoScriptPackage } from './local-video-script-approval.ts';
import { createLocalVideoScriptFallback } from './local-video-script-fallback.ts';
import { writeLocalVideoScriptProductionPackage } from './local-video-script-production-package.ts';
import { resolveRequiredSourceContext } from './local-video-script-source-context.ts';
export class LocalVideoScriptPackage {
    advisor: any;
    allowedSourceArtifactRoots: any;
    artifactsDir: any;
    now: any;
    researcher: any;
    store: any;
    templateResolver: any;
    constructor({ store, artifactsDir, advisor = null, researcher = null, templateResolver = null, allowedSourceArtifactRoots = [], now = (): any => new Date(), }: any = {}) {
        this.store = store;
        this.artifactsDir = artifactsDir;
        this.advisor = advisor;
        this.researcher = researcher;
        this.templateResolver = templateResolver;
        this.allowedSourceArtifactRoots = Array.isArray(allowedSourceArtifactRoots)
            ? allowedSourceArtifactRoots.map((item: any): any => String(item || '').trim()).filter(Boolean)
            : [];
        this.now = now;
    }
    async execute(task: any, { allowAdvisor = true, allowResearch = true }: any = {}): Promise<any> {
        const tasks: any = typeof this.store?.list === 'function' ? await this.store.list() : [];
        if (task.input?.approvedForUse === true)
            return this.approve(task, tasks);
        const topic: any = text(task.input?.contentGoal || task.input?.topic || task.input?.title, 500);
        if (!topic) {
            return needsInput(this.now(), 'script_topic_required', '请用一句话说明这条视频要讲什么。');
        }
        const requiredSources: any = await resolveRequiredSourceContext({
            task,
            tasks,
            allowedRoots: this.allowedSourceArtifactRoots,
        });
        if (requiredSources.error) {
            return needsInput(this.now(), requiredSources.error.code, requiredSources.error.userMessage);
        }
        const sourceContext: any = requiredSources.sourceContext;
        const sourceTaskBindings: any = explicitSourceTaskBindings(task, tasks);
        const contentProtocol: any = this.#contentProtocol({ allowResearch });
        const prepared: any = contentProtocol.prepare({ task, tasks, topic });
        const isM5Script: any = prepared.isM5Script;
        const pipelineCaseId: any = task.input?.context?.pipelineCaseId;
        const templateBinding: any = isM5Script
            ? await resolveTemplateBinding(this.templateResolver, pipelineCaseId)
            : null;
        if (isM5Script && !validM5ProductionTemplateBinding(templateBinding)) {
            return needsInput(this.now(), 'm5_template_binding_invalid', 'M5 生产模板绑定缺少完整 canonical hash 或安全控制，已停止脚本生成。');
        }
        const grayTemplateBinding: any = isM5Script
            ? await resolveGrayTemplateBinding(this.templateResolver, pipelineCaseId)
            : null;
        if (!validGrayTemplateBinding(grayTemplateBinding, pipelineCaseId)) {
            return needsInput(this.now(), 'm5_gray_template_binding_invalid', 'M5 灰度模板没有完整绑定到当前日期 Case 的抖音独立内容变体。');
        }
        const draft: any = await contentProtocol.compose({
            task,
            allowAdvisor,
            templateBinding,
            grayTemplateBinding,
            prepared,
            sourceContext,
        });
        if (draft.status === 'needs_input') {
            return needsInput(this.now(), draft.code, draft.userMessage);
        }
        const completedAt: any = this.now().toISOString();
        const artifact: any = await writeLocalVideoScriptProductionPackage({
            artifactsDir: this.artifactsDir,
            task,
            data: {
                ...draft.script,
                topic: draft.topic,
                referenceMatch: draft.reference.publicMatch,
                researchStatus: draft.research?.status || 'not_required',
                templateLifecycle: isM5Script ? {
                    caseOnly: true,
                    state: templateBinding.decisionStatus,
                    approvedForUse: false,
                    templateBinding,
                } : { caseOnly: true, state: null, approvedForUse: false },
                publishingStatus: 'draft_only',
                generationMode: draft.advisorApplied ? 'hermes_advisor' : 'deterministic_fallback',
                sourceContext,
                templateGuidanceHash: draft.advisorApplied
                    ? String(draft.script.templateBindingHash || '')
                    : null,
                ...(draft.variants ? { variants: draft.variants } : {}),
                generatedAt: completedAt,
            },
            sources: draft.sources,
            sourceRefs: [
                ...new Set([
                    ...draft.sourceRefs,
                    ...sourceTaskBindings.flatMap((binding: any): any => binding.artifactIds),
                ]),
            ],
            sourceTaskBindings,
            completedAt,
        });
        return success(task, artifact, completedAt, draft.modelUsage);
    }
    async approve(task: any, tasks: any): Promise<any> {
        const result: any = await approveLocalVideoScriptPackage({
            task, tasks, artifactsDir: this.artifactsDir, now: this.now,
        });
        if (result.error)
            return needsInput(this.now(), result.error.code, result.error.userMessage);
        return success(task, result.artifact, result.completedAt, null, 'video_script_package_approved');
    }
    async research(topic: any, task: any): Promise<any> {
        return this.#contentProtocol().research(topic, task);
    }
    #contentProtocol({ allowResearch = true }: any = {}): any {
        return new LocalVideoScriptContentProtocol({
            advisor: this.advisor,
            researcher: this.researcher,
            research: allowResearch ? (topic: any, task: any): any => this.research(topic, task) : async (): Promise<any> => null,
            fallback: createLocalVideoScriptFallback,
        });
    }
}
function explicitSourceTaskBindings(task: any, tasks: any): any {
    const requiredTaskIds: any = new Set((Array.isArray(task.input?.context?.requiredSourceTaskIds)
        ? task.input.context.requiredSourceTaskIds : [])
        .map((item: any): any => text(item, 120))
        .filter(Boolean));
    const taskIds: any[] = [...new Set([
            ...(Array.isArray(task.input?.context?.sourceTaskIds) ? task.input.context.sourceTaskIds : []),
            ...(Array.isArray(task.input?.context?.requiredSourceTaskIds) ? task.input.context.requiredSourceTaskIds : []),
        ].map((item: any): any => text(item, 120)).filter(Boolean))];
    return taskIds.map((taskId: any): any => {
        const sourceTask: any = tasks.find((item: any): any => String(item?.taskId || '') === taskId);
        const artifactIds: any[] = [...new Set((sourceTask?.artifactRefs || [])
                .filter((artifact: any): any => artifact?.type !== 'employee_role_report'
                && (!requiredTaskIds.has(taskId)
                    || ['confirmed_transcript', 'video_content_analysis_report'].includes(artifact?.type))
                && artifact?.validation?.exists !== false
                && artifact?.validation?.readable !== false)
                .map((artifact: any): any => text(artifact?.artifactId, 240))
                .filter(Boolean))];
        return { taskId, artifactIds };
    });
}
async function resolveTemplateBinding(resolver: any, pipelineCaseId: any): Promise<any> {
    if (typeof resolver?.resolve !== 'function') {
        return defaultM5ProductionTemplateBinding('resolver_unavailable');
    }
    try {
        return await resolver.resolve(pipelineCaseId);
    }
    catch (error: any) {
        if (error instanceof M5ProductionTemplateResolutionError
            || error?.code === 'm5_production_template_blocked')
            throw error;
        return defaultM5ProductionTemplateBinding('resolver_read_failed');
    }
}
async function resolveGrayTemplateBinding(resolver: any, pipelineCaseId: any): Promise<any> {
    if (typeof resolver?.resolveGrayForDay !== 'function')
        return null;
    try {
        return await resolver.resolveGrayForDay(pipelineCaseId);
    }
    catch (error: any) {
        if (error instanceof M5ProductionTemplateResolutionError
            || error?.code === 'm5_production_template_blocked')
            throw error;
        return null;
    }
}
function validGrayTemplateBinding(binding: any, pipelineCaseId: any): any {
    return !binding || (validM5ProductionTemplateBinding(binding)
        && binding.source === 'approved_single_gray'
        && binding.applicationScope === 'full_content_variant'
        && binding.grayTargetDayCaseId === pipelineCaseId
        && binding.grayTargetPlatform === 'douyin');
}
function text(value: any, limit: any): any {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}
function needsInput(now: any, code: any, userMessage: any): any {
    const current: any = typeof now === 'function' ? now() : now;
    return {
        status: 'needs_input',
        currentStage: code,
        error: {
            code,
            userMessage,
            category: 'needs_input',
            stage: 'video_script_input',
            occurredAt: current.toISOString(),
        },
    };
}
function success(task: any, artifact: any, completedAt: any, modelUsage: any = null, mode: any = 'video_script_package'): any {
    return {
        status: 'succeeded',
        currentStage: `${mode}_ready`,
        execution: {
            executor: task.assigneeAgentId,
            mode,
            startedAt: task.execution?.startedAt || completedAt,
            finishedAt: completedAt,
            outcome: 'artifact_ready',
        },
        usage: {
            tools: [{ id: `${mode}-write`, name: '可拍脚本与受控生产包', calls: 1 }],
            ...(modelUsage?.model ? { model: modelUsage.model } : {}),
        },
        artifactRefs: [artifact],
    };
}

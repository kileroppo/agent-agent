import { canonicalizeBusinessAssignment, githubRepositoryQuery } from './business-task-routing.ts';
import { usesPaperclipHermesExecution } from './governance-hermes-runtime.ts';
import { inspectOpenTaskManifestCapabilities, routeOpenTaskForExecutor, supportsOpenTask, } from './open-task-routing.ts';
import { WECHAT_CHAT_TASK_TYPE, normalizeWechatChatRequest, wechatApprovalScope } from './wechat-chat-defaults.ts';
import { ValidationError } from './task-service-execution-support.ts';
import { resolveAnalysisIntent } from './analysis-intent.ts';
import { TaskCreationCoordinator, taskIdempotencyFingerprint } from './task-idempotency.ts';
import { createWorkflowLink } from './workflow/contracts.ts';
import { attachDeliveryQualityContracts, deliveryBriefGuardPatch } from './workflow/delivery-quality-intake.ts';
import { isTrustedReadOnlyDiagnosisTask } from './read-only-diagnosis-contract.ts';
import { hasAffirmativeRiskIntent } from './task-risk-intent.ts';
const ORGANIZATION_GOVERNANCE_WORDS: any = /创建.*(?:agent|智能体|岗位)|新建.*(?:agent|智能体|岗位)|扩权|账号|连接|公开发布|对外发布|付款|付费|预算|暂停|终止|跨\s*agent/i;
export class TaskIntake {
    creation: any;
    execute: any;
    governance: any;
    registry: any;
    store: any;
    maturityExecutionGuard: any;
    constructor({ registry, store, governance = null, execute }: any) {
        this.registry = registry;
        this.store = store;
        this.governance = governance;
        this.execute = execute;
        this.creation = new TaskCreationCoordinator((input: any): any => this.createOnce(input));
    }
    async create(input: any = {}): Promise<any> {
        return this.creation.run(input);
    }
    async createOnce(input: any = {}): Promise<any> {
        const requested: any = normalizeAssignment(input);
        const { title, taskType } = requested;
        if (!title)
            throw new ValidationError('请说明要完成什么。');
        if (!taskType)
            throw new ValidationError('请选择任务类型。');
        const idempotencyKey: any = String(input.idempotencyKey || '').trim();
        if (idempotencyKey) {
            const existing: any = (await this.store.list()).find((item: any): any => item.idempotencyKey === idempotencyKey);
            if (existing) {
                if (existing.idempotencyFingerprint && existing.idempotencyFingerprint !== taskIdempotencyFingerprint(input)) {
                    const error: any = new ValidationError('同一幂等键不能绑定不同的任务内容。');
                    error.code = 'task_idempotency_conflict';
                    throw error;
                }
                return existing;
            }
        }
        const route: any = await this.resolveRoute(requested);
        let task: any = await this.store.createTask(taskRecord(input, requested, route, idempotencyKey));
        task = await this.applyOpenTaskGuard(task, route.agent);
        task = await this.createRequiredApproval(task, route.agent);
        task = await this.projectGovernance(task, route.agent);
        return this.execute(task, route.agent);
    }
    async resolveRoute(requested: any): Promise<any> {
        const requestedAgentId: any = requested.agentId || null;
        let candidates: any = await this.registry.candidates(requested.taskType);
        if (requestedAgentId)
            candidates = candidates.filter((agent: any): any => agent.agentId === requestedAgentId);
        return {
            requestedAgentId,
            candidates,
            agent: candidates.length === 1 ? candidates[0] : null,
        };
    }
    async applyOpenTaskGuard(task: any, agent: any): Promise<any> {
        if (!supportsOpenTask(task, agent))
            return task;
        try {
            const routed: any = routeOpenTaskForExecutor(task, agent);
            return this.store.updateTask(task.taskId, {
                input: { ...task.input, context: routed.input.context },
            });
        }
        catch {
            return task;
        }
    }
    async createRequiredApproval(task: any, agent: any): Promise<any> {
        const { taskType } = task;
        const title: any = task.input?.title || '';
        const description: any = task.input?.description || '';
        const wechatChat: any = task.input?.wechatChat;
        if (taskType === WECHAT_CHAT_TASK_TYPE && wechatChat?.chatSelector) {
            await this.store.createApproval({
                taskId: task.taskId,
                governanceMode: 'local',
                decisionChannel: 'feishu_card',
                action: 'wechat-private-chat-read',
                riskLevel: 'high',
                reason: `只读“${wechatChat.chatSelector}”今天至当前的聊天，最多 ${wechatChat.maxMessages} 条；同名时自动选最近活跃会话。原文不落盘，仅交给本机回环地址上的 Qwen3.5-9B 分析，不进入云模型或外部平台。批准后同一飞书会话、岗位和读取范围可在 30 分钟内复用，最多 10 个任务，可随时撤销。`,
                requestedBy: 'ajun',
                approverScope: 'A君',
                requestedScope: wechatApprovalScope(task),
                validUntil: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
            });
            return this.reload(task.taskId);
        }
        if (taskType !== WECHAT_CHAT_TASK_TYPE
            && hasAffirmativeRiskIntent(`${title} ${description}`)
            && !isTrustedReadOnlyDiagnosisTask(task)
            && !['army.intake', 'governance.approval-review', 'office.knowledge-summary', 'content.platform-draft', 'content.video-script-package'].includes(taskType)) {
            await this.store.createApproval({
                taskId: task.taskId,
                governanceMode: requiresOrganizationGovernance(title, description) ? 'paperclip' : 'local',
                decisionChannel: 'feishu_card',
                action: 'manual-risk-review',
                riskLevel: 'high',
                reason: '任务描述包含高风险动作，必须人工确认范围。',
                requestedBy: 'ajun',
                approverScope: 'A君',
                requestedScope: { taskType, title, assigneeAgentId: agent?.agentId || null },
                validUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            });
            return this.reload(task.taskId);
        }
        return task;
    }
    async projectGovernance(task: any, agent: any): Promise<any> {
        if (await this.maturityExecutionGuard?.verifyOrBlock(task))
            return task;
        if (!this.governance)
            return task;
        const approval: any = task.approvalRefs?.length
            ? (await this.store.listApprovals()).find((item: any): any => item.approvalId === task.approvalRefs[0])
            : null;
        if (!usesPaperclipHermesExecution(agent) && !shouldProjectToPaperclip(task, approval))
            return task;
        const parentIssueId: any = String(task.input?.context?.parentPaperclipIssueId || '').trim();
        const projection: any = parentIssueId && this.governance.projectChild
            ? await this.governance.projectChild(task, parentIssueId)
            : await this.governance.project(task, approval);
        return this.store.updateTask(task.taskId, { governance: projection });
    }
    async reload(taskId: any): Promise<any> {
        return (await this.store.list()).find((item: any): any => item.taskId === taskId);
    }
}
function normalizeAssignment(input: any): any {
    const raw: Record<string, any> = {
        title: input.title,
        description: input.description,
        taskType: input.taskType,
        agentId: input.agentId,
        dependsOnPrevious: input.context?.dependsOnPrevious === true,
    };
    // 军团父任务是控制面信封，不能因标题中的业务词被改写成子任务。
    return String(raw.taskType || '').startsWith('army.')
        ? Object.fromEntries(Object.entries(raw).map(([key, value]: any): any => [
            key,
            typeof value === 'string' ? value.trim() : value,
        ]))
        : canonicalizeBusinessAssignment(raw);
}
function taskRecord(input: any, requested: any, route: any, idempotencyKey: any): any {
    const { title, description, taskType } = requested;
    const requesterName: any = String(input.requesterName || '').trim() || 'A君';
    const wechatChat: any = taskType === WECHAT_CHAT_TASK_TYPE
        ? normalizeWechatChatRequest({ ...input, title, description })
        : null;
    const sourceUrls: any = uniquePublicUrls([
        String(input.sourceUrl || '').trim(),
        ...(Array.isArray(input.sourceUrls) ? input.sourceUrls : []),
        ...extractPublicUrls(`${title}\n${description}`),
    ]);
    const agent: any = route.agent;
    const needsWechatChat: any = Boolean(wechatChat && !wechatChat.chatSelector);
    const analysis: any = taskType === 'content.video-benchmark-analysis'
        ? resolveAnalysisIntent({ analysisIntent: input.analysisIntent, title, description, focus: input.focus, depth: input.depth })
        : null;
    if (analysis?.error)
        throw new ValidationError(analysis.error === 'analysis_intent_conflict' ? '检测到多个分析模式，请只选择一种。' : '分析模式无效。');
    const stableIdempotencyKey: any = idempotencyKey || `local:${Buffer.from(title).toString('base64url').slice(0, 24)}:${Date.now()}`;
    return attachDeliveryQualityContracts({
        taskType,
        idempotencyKey: stableIdempotencyKey,
        ...(idempotencyKey ? { idempotencyFingerprint: taskIdempotencyFingerprint(input) } : {}),
        requester: input.requester || { kind: requesterName === 'A君' ? 'local-owner' : 'lan-collaborator', ref: requesterName },
        source: input.source || { channel: 'ajun-runtime' },
        assigneeAgentId: agent?.agentId || null,
        parentTaskId: String(input.parentTaskId || '').trim() || null,
        recovery: input.recovery || undefined,
        workflow: createWorkflowLink({ taskType, idempotencyKey: stableIdempotencyKey, ...input }),
        input: {
            title,
            description,
            sourceUrl: sourceUrls[0] || null,
            sourceUrls,
            connectionId: optionalConnectionId(input.connectionId),
            query: githubQueryInput(taskType, input.query, `${title}\n${description}`),
            repo: optionalInput(input.repo),
            path: optionalInput(input.path),
            topic: optionalInput(input.topic),
            reviewPolicy: input.reviewPolicy === 'required' ? 'required' : 'optional',
            evidenceMode: input.evidenceMode === 'preliminary' ? 'preliminary' : 'formal',
            analysisIntent: analysis?.analysisIntent || undefined,
            depth: analysis?.depth || (input.depth === 'full' ? 'full' : 'fast'),
            visualMode: input.visualMode === 'auto' || input.visualMode === 'required'
                ? input.visualMode
                : input.visualMode === 'off' ? 'off' : taskType === 'content.video-benchmark-analysis' ? 'auto' : 'off',
            focus: optionalInput(input.focus),
            platforms: Array.isArray(input.platforms) ? input.platforms.map((item: any): any => String(item || '').trim()).filter(Boolean).slice(0, 10) : undefined,
            contentGoal: optionalInput(input.contentGoal),
            durationSeconds: Number.isFinite(Number(input.durationSeconds)) ? Number(input.durationSeconds) : undefined,
            researchMode: input.researchMode === 'off' ? 'off' : 'auto',
            approvedForUse: input.approvedForUse === true,
            sourceScriptTaskId: optionalInput(input.sourceScriptTaskId),
            metrics: input.metrics && typeof input.metrics === 'object' && !Array.isArray(input.metrics) ? input.metrics : undefined,
            ...presentationTaskInput(taskType, input),
            ...(wechatChat ? { wechatChat } : {}),
            goalSpec: input.goalSpec && typeof input.goalSpec === 'object' && !Array.isArray(input.goalSpec) ? input.goalSpec : undefined,
            context: input.context || undefined,
        },
        status: needsWechatChat ? 'needs_input' : agent?.status === 'active' ? 'queued' : 'needs_input',
        currentStage: needsWechatChat ? 'wechat_chat_required' : agent?.status === 'active' ? 'queued_for_execution' : agent ? 'waiting_for_agent_activation' : 'routing_needed',
        routing: {
            requestedAgentId: route.requestedAgentId,
            candidateAgentIds: route.candidates.map((item: any): any => item.agentId),
            reason: needsWechatChat
                ? '只缺联系人或群名；其余范围使用安全默认值。'
                : agent?.status === 'active' ? '已路由到已启用的本地执行器。' : agent ? '岗位骨架已登记，等待启用真实执行器。' : route.candidates.length === 0 ? '没有岗位声明支持该任务类型。' : '多个岗位匹配，请明确选择承接岗位。',
        },
        ...(needsWechatChat ? {
            error: {
                code: 'wechat_chat_required',
                message: '微信聊天只读任务缺少联系人或群名。',
                userMessage: '请只告诉我联系人或群名；时间默认今天至现在，最多 200 条，其余不用配置。',
                category: 'needs_input',
                stage: 'scope',
                retryable: false,
                occurredAt: new Date().toISOString(),
            },
        } : {}),
    });
}
function optionalInput(value: any): any {
    const text: any = String(value || '').trim();
    return text || undefined;
}
function presentationTaskInput(taskType: any, input: any): any {
    if (taskType !== 'office.presentation-package')
        return {};
    return {
        purpose: optionalInput(input.purpose),
        audience: optionalInput(input.audience),
        slideCount: Number.isInteger(Number(input.slideCount)) ? Number(input.slideCount) : undefined,
        designMode: optionalInput(input.designMode),
        designTokens: plainObject(input.designTokens),
        designSourceRef: optionalInput(input.designSourceRef),
        templateArtifactRef: optionalInput(input.templateArtifactRef),
        styleArtifactRef: optionalInput(input.styleArtifactRef),
        sourceTaskIds: stringList(input.sourceTaskIds, 50),
        slides: Array.isArray(input.slides) ? input.slides : undefined,
        outline: Array.isArray(input.outline) ? input.outline : undefined,
        media: Array.isArray(input.media) ? input.media : undefined,
        outputs: stringList(input.outputs, 2),
        dataClassification: optionalInput(input.dataClassification),
        externalProcessingApproved: input.externalProcessingApproved === true,
    };
}
function plainObject(value: any): any {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
function stringList(value: any, limit: any): any {
    if (!Array.isArray(value))
        return undefined;
    const items: any = value.map((item: any): any => String(item || '').trim()).filter(Boolean).slice(0, limit);
    return items.length ? items : undefined;
}
function optionalConnectionId(value: any): any {
    const id: any = optionalInput(value);
    if (!id)
        return undefined;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
        throw new ValidationError('账号连接标识格式不正确。');
    }
    return id;
}
function githubQueryInput(taskType: any, suppliedQuery: any, requestText: any): any {
    const explicit: any = optionalInput(suppliedQuery);
    if (explicit || taskType !== 'research.github-search')
        return explicit;
    return githubRepositoryQuery(requestText) || undefined;
}
function extractPublicUrls(value: any): any {
    return [...String(value).matchAll(/https?:\/\/[^\s<>"'，。；：！？、【】（）《》“”‘’]+/gi)]
        .map((match: any): any => match[0].replace(/[)\]},.;]+$/, ''));
}
function uniquePublicUrls(values: any): any {
    return [...new Set(values.map((value: any): any => String(value || '').trim()).filter(Boolean))];
}
function shouldProjectToPaperclip(task: any, approval: any = null): any {
    return approval?.governanceMode === 'paperclip'
        || task.source?.channel === 'paperclip'
        || task.source?.channel === 'army-mission'
        || task.taskType.startsWith('governance.')
        || task.taskType === 'army.route-task'
        || task.taskType === 'army.cross-agent-mission'
        || task.taskType === 'operations.technical-repair';
}
function requiresOrganizationGovernance(title: any, description: any): any {
    return ORGANIZATION_GOVERNANCE_WORDS.test(`${title} ${description}`);
}

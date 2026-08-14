import { ContentCampaignError, requireActiveCampaignGrant as requireActiveGrant, requireCampaignGrant as requireGrant, samePluginApproval, } from './campaign-domain.ts';
import { asList, safeId, safeOpaqueId, safeText } from './content-campaign-primitives.ts';
import { assertM5RoutineExecutionContracts, getM5RoutineExecutionContract, } from './routine-execution-contract.ts';
const CONTROL_ACTIONS = new Set(['pause', 'resume', 'stop']);
const CONTENT_AUTONOMY_PLUGIN_KEY = 'agent-army.content-autonomy';
const INVOKABLE_AGENT_STATUSES = new Set(['active', 'idle', 'running']);
export class CampaignLifecycle {
    readonly controlPlane: Record<string, any>;
    readonly definition: Record<string, any>;
    readonly activePipelineId: string | null;
    readonly activePipelineKey: string;
    readonly now: () => Date;
    controlTail: Promise<any>;

    constructor({ controlPlane, definition, activePipelineId = null, activePipelineKey = null, now }: any) {
        this.controlPlane = controlPlane;
        this.definition = definition;
        this.activePipelineId = String(activePipelineId || '').trim() || null;
        this.activePipelineKey = String(activePipelineKey || definition.key).trim();
        this.now = now;
        this.controlTail = Promise.resolve();
    }
    async approve(caseId: any, input: any = {}) {
        return this.serialize(() => this.approveLocked(caseId, input));
    }
    async approveLocked(caseId: any, input: any) {
        if (input.confirmActivityGrant !== true) {
            throw new ContentCampaignError('必须明确确认本次活动授权，不能由 A君或岗位自行批准。');
        }
        const current = await this.parentCase(caseId);
        const grant = requireGrant(current);
        if (Number(grant.budgetCents) > 500 && input.confirmHighBudget !== true) {
            throw new ContentCampaignError('活动预算超过 5 美元，必须单独明确确认高预算。');
        }
        if (grant.status !== 'draft')
            throw new ContentCampaignError(`当前活动不是草案，不能批准：${grant.status}。`);
        const now = this.now();
        if (Date.parse(grant.expiresAt) <= now.getTime())
            throw new ContentCampaignError('活动授权已经过期，必须重新创建授权草案。');
        let updatedGrant: Record<string, any> = {
            ...grant,
            status: 'active',
            approvedAt: now.toISOString(),
            approvedBy: 'local-owner',
            pausedAt: null,
            pauseReason: null,
        };
        const pluginApproval = await this.assertActivationAllowed(current, updatedGrant);
        updatedGrant = { ...updatedGrant, pluginApproval };
        await this.activateApprovedCampaign(current, updatedGrant);
        return current.id;
    }
    async control(caseId: any, action: any, input: any = {}) {
        return this.serialize(() => this.controlLocked(caseId, action, input));
    }
    async controlLocked(caseId: any, action: any, input: any) {
        if (!CONTROL_ACTIONS.has(action))
            throw new ContentCampaignError('活动控制动作无效。');
        const current = await this.parentCase(caseId);
        const grant = requireGrant(current);
        const now = this.now();
        if (action === 'resume') {
            if (grant.status !== 'paused')
                throw new ContentCampaignError('只有已暂停活动可以恢复。');
            if (Date.parse(grant.expiresAt) <= now.getTime())
                throw new ContentCampaignError('活动授权已经过期，不能恢复。');
            const resumedGrant = { ...grant, status: 'active', pausedAt: null, pauseReason: null, resumedAt: now.toISOString() };
            await this.assertActivationAllowed(current, resumedGrant);
            await this.activateApprovedCampaign(current, resumedGrant);
        }
        else {
            await this.updateGrantWithRoutine(current, {
                ...grant,
                status: action === 'stop' ? 'stopped' : 'paused',
                pausedAt: now.toISOString(),
                pauseReason: safeText(input.reason, 500) || (action === 'stop' ? '本机负责人停止活动。' : '本机负责人暂停活动。'),
            }, false);
        }
        return current.id;
    }
    async activateScheduledDay() {
        return this.serialize(() => this.activateScheduledDayLocked());
    }
    async activateScheduledDayLocked() {
        const trigger = await this.dailyRoutine();
        if (trigger.enabled !== true) {
            throw new ContentCampaignError('M5 每日入口 Cron 当前关闭，拒绝手工或漂移唤醒。');
        }
        const pipeline = await this.pipeline();
        const cases = caseRows(await this.controlPlane.listPipelineCases(pipeline.id));
        const activeParents = cases.filter((item: any) => !item.parentCaseId && item.campaignGrant?.status === 'active');
        if (activeParents.length !== 1) {
            throw new ContentCampaignError(`M5 每日入口要求恰好一个 active CampaignGrant，当前为 ${activeParents.length} 个。`);
        }
        const parent = activeParents[0];
        const grant = requireActiveGrant(parent, this.now());
        if (parent.stageKey !== 'campaign_active') {
            throw new ContentCampaignError(`活动父 Case 不在 campaign_active 控制阶段，当前为 ${parent.stageKey || 'unknown'}。`);
        }
        const scheduledDate = dateOnlyInTimeZone(this.now(), this.definition.executionPolicy?.schedule?.timezone || 'Asia/Shanghai');
        const candidates = cases.filter((item: any) => item.parentCaseId === parent.id
            && !item.platform
            && item.campaignId === parent.campaignId
            && item.scheduledDate === scheduledDate);
        if (candidates.length !== 1) {
            throw new ContentCampaignError(`活动 ${parent.caseKey || parent.id} 在 ${scheduledDate} 必须恰好有一个日期 Case，当前为 ${candidates.length} 个。`);
        }
        const dayCase = candidates[0];
        if (dayCase.stageKey === 'draft') {
            const activated = await this.transition(dayCase, 'topic', `M5 每日入口只激活 Asia/Shanghai 日期 ${scheduledDate} 的唯一日期 Case。`);
            return {
                campaignCaseId: parent.id,
                dayCaseId: dayCase.id,
                scheduledDate,
                activated: true,
                replayed: false,
                stageKey: activated.stageKey || 'topic',
                grantExpiresAt: grant.expiresAt,
            };
        }
        const businessStageKeys = this.definition.stages
            .filter((stage: any) => !['draft', 'campaign_active', 'cancelled'].includes(stage.key))
            .map((stage: any) => stage.key);
        if (businessStageKeys.includes(dayCase.stageKey)) {
            return {
                campaignCaseId: parent.id,
                dayCaseId: dayCase.id,
                scheduledDate,
                activated: false,
                replayed: true,
                stageKey: dayCase.stageKey,
                grantExpiresAt: grant.expiresAt,
            };
        }
        throw new ContentCampaignError(`当日 Case 处于不可激活阶段 ${dayCase.stageKey || 'unknown'}，拒绝强制推进。`);
    }
    async approvalReadiness(item: any) {
        const grant = item?.campaignGrant || {};
        if (grant.status !== 'draft') {
            return { allowed: false, code: 'campaign_not_draft', reason: `当前活动状态为 ${grant.status || 'unknown'}，只有草案可以批准。` };
        }
        if (Date.parse(grant.expiresAt) <= this.now().getTime()) {
            return { allowed: false, code: 'campaign_expired', reason: '活动授权草案已经过期，必须重新创建。' };
        }
        try {
            await this.assertActivationAllowed(item, { ...grant, status: 'active' });
            return { allowed: true, code: 'ready', reason: '内容插件、岗位、Routine、Pipeline 和预算启动前检查均已通过。' };
        }
        catch (error) {
            return { allowed: false, code: 'preflight_failed', reason: safeText((error as any)?.message, 500) || 'M5 启动前检查未通过。' };
        }
    }
    async pipeline() {
        const pipeline = this.activePipelineId
            ? await this.controlPlane.getPipeline(this.activePipelineId)
            : await this.controlPlane.findPipelineByKey(this.definition.key);
        if (!pipeline) {
            throw new ContentCampaignError('M5 Paperclip Pipeline 尚未应用；先完成本地 dry-run、预算和岗位绑定审核。');
        }
        if (pipeline.key !== this.activePipelineKey) {
            throw new ContentCampaignError(`M5 activePipelineId 指向 ${pipeline.key || 'unknown'}，与声明 ${this.activePipelineKey} 不一致。`);
        }
        return pipeline;
    }
    async parentCase(caseId: any) {
        const id = safeId(caseId, '内容活动标识无效。');
        const item = await this.controlPlane.getCase(id);
        if (!item || item.parentCaseId || !item.campaignGrant)
            throw new ContentCampaignError('没有找到对应的活动父 Case。');
        await this.assertActivePipeline(item);
        return item;
    }
    async case(caseId: any) {
        const id = safeId(caseId, 'Pipeline Case 标识无效。');
        const item = await this.controlPlane.getCase(id);
        if (!item)
            throw new ContentCampaignError('没有找到对应的 Pipeline Case。');
        await this.assertActivePipeline(item);
        return item;
    }
    async assertActivePipeline(item: any) {
        const pipeline = await this.pipeline();
        const casePipelineId = item.pipelineId || item.pipeline?.id;
        if (!casePipelineId || casePipelineId !== pipeline.id) {
            throw new ContentCampaignError('当前 Case 不属于显式 activePipelineId，拒绝跨 v1/v2 操作。');
        }
    }
    async transition(item: any, toStageKey: any, reason: any) {
        if (!this.controlPlane?.transitionCase) {
            throw new ContentCampaignError('Paperclip 适配器缺少 Case 阶段迁移能力，活动保持暂停。');
        }
        return this.controlPlane.transitionCase(item.id, {
            toStageKey,
            expectedVersion: item.version,
            reason,
            force: true,
        });
    }
    async updateGrant(item: any, campaignGrant: any) {
        return this.controlPlane.updateCampaignGrant(item.id, item.version, campaignGrant);
    }
    async activateApprovedCampaign(item: any, campaignGrant: any) {
        let grantActivated = false;
        try {
            await this.updateGrant(item, campaignGrant);
            grantActivated = true;
            const current = await this.parentCase(item.id);
            const execution = await this.controlPlane.ingestCampaignExecution(await this.pipeline(), current);
            await this.restoreExecutionCasesToDraft(execution.days);
            await this.restoreExecutionCasesToDraft(execution.platformCases);
            const parent = await this.parentCase(item.id);
            if (['draft', 'cancelled'].includes(parent.stageKey)) {
                await this.transition(parent, 'campaign_active', '活动授权门禁已通过，启动父 Case。');
            }
            await this.setDailyRoutineEnabled(true);
        }
        catch (error) {
            if (grantActivated) {
                await this.setDailyRoutineEnabled(false).catch(() => undefined);
                await this.pauseIncompleteActivation(item.id, error).catch(() => undefined);
            }
            throw error;
        }
    }
    async restoreExecutionCasesToDraft(cases: any) {
        for (const item of cases) {
            if (!item || item.stageKey !== 'cancelled')
                continue;
            await this.transition(item, 'draft', '活动授权门禁已通过，恢复为待每日入口或上游阶段激活的草案 Case。');
        }
    }
    async pauseIncompleteActivation(caseId: any, error: any) {
        const current = await this.parentCase(caseId);
        const grant = requireGrant(current);
        if (grant.status !== 'active')
            return;
        await this.updateGrant(current, {
            ...grant,
            status: 'paused',
            pausedAt: this.now().toISOString(),
            pauseReason: `activation_incomplete: ${safeText(error?.message, 420) || '审批后激活未完成'}`,
        });
    }
    async assertActivationAllowed(item: any, campaignGrant: any) {
        const pipeline = await this.pipeline();
        const cases = caseRows(await this.controlPlane.listPipelineCases(pipeline.id));
        const conflict = cases.find((entry: any) => entry.id !== item.id && !entry.parentCaseId && entry.campaignGrant?.status === 'active');
        if (conflict) {
            throw new ContentCampaignError(`共享 M5 Cron 已被活动 ${conflict.caseKey || conflict.id} 占用；先暂停或停止该活动。`);
        }
        const companyId = safeOpaqueId(this.controlPlane.companyId);
        const projectId = safeOpaqueId(item.projectId || item.pipeline?.projectId || pipeline.projectId);
        if (!companyId || !projectId)
            throw new ContentCampaignError('无法核验 Paperclip 公司或项目预算，活动保持未启动。');
        const pluginApproval = await this.assertExecutionReady(pipeline);
        if (campaignGrant.pluginApproval && !samePluginApproval(campaignGrant.pluginApproval, pluginApproval)) {
            throw new ContentCampaignError('内容插件版本或配置已偏离原活动批准快照；不能自动恢复，必须重新签发活动授权。');
        }
        const overview = await this.controlPlane.getBudgetOverview().catch(() => null);
        const policy: any = asList(overview?.policies).find((entry: any) => entry.scopeType === 'project'
            && entry.scopeId === projectId
            && entry.metric === 'billed_cents'
            && entry.active === true);
        if (!policy
            || policy.hardStop !== true
            || !Number.isInteger(Number(policy.amount))
            || Number(policy.amount) !== Number(campaignGrant.budgetCents)
            || !['ok', 'warning'].includes(policy.status)
            || policy.paused === true
            || !Number.isFinite(Number(policy.remainingAmount))
            || Number(policy.remainingAmount) < 0) {
            throw new ContentCampaignError(`Paperclip 项目预算必须可用、启用硬停，且与活动预算 ${campaignGrant.budgetCents} 美分完全一致。`);
        }
        return pluginApproval;
    }
    async assertExecutionReady(pipeline: any) {
        const failures = [];
        let executionContracts: readonly any[] = [];
        try {
            executionContracts = assertM5RoutineExecutionContracts(this.definition);
        }
        catch (error) {
            failures.push(`Pipeline 执行契约无效：${String((error as any)?.message || error)}`);
        }
        const readiness = await this.controlPlane.inspectExecutionReadiness({ pipeline, executionContracts });
        const { plugins, routines, agents, pipeline: pipelineDetail } = readiness;
        const contentPlugin = plugins.find((item: any) => item.key === CONTENT_AUTONOMY_PLUGIN_KEY);
        if (!contentPlugin || contentPlugin.status !== 'ready') {
            failures.push(`内容插件 ${CONTENT_AUTONOMY_PLUGIN_KEY} 未处于 ready`);
        }
        else {
            failures.push(...await this.controlPlane.inspectContentAutonomyReadiness({ plugin: contentPlugin, agents }));
        }
        const routineByKey = new Map();
        const routineSpecs: any[] = [
            ...executionContracts.map((contract: any) => ({
                key: contract.routineKey,
                stageKey: contract.stageKey,
                owner: contract.agentId || contract.systemController,
                contract,
            })),
            { key: 'm5-daily-campaign', stageKey: null, owner: 'ajun' },
        ];
        for (const spec of routineSpecs) {
            const marker = `[agent-army:m5:routine:${spec.key}]`;
            const matches = routines.filter((item: any) => item.projectId === pipeline.projectId && String(item.description || '').includes(marker));
            if (matches.length === 0) {
                failures.push(`Routine 不存在：${spec.key}`);
                continue;
            }
            if (matches.length > 1) {
                failures.push(`Routine ${spec.key} 必须唯一，当前为 ${matches.length} 个`);
                continue;
            }
            const routine = matches[0];
            routineByKey.set(spec.key, routine);
            if (routine.status !== 'active')
                failures.push(`Routine ${spec.key} 当前状态为 ${routine.status || 'unknown'}，不是 active`);
            const agent = agents.find((item: any) => item.id === routine.assigneeAgentId);
            const reason = agentInvocationBlockReason(agent);
            if (reason) {
                failures.push(`Routine ${spec.key} 的岗位 ${spec.owner} 不可调用：${reason}`);
            }
            else if (spec.contract?.executionMode === 'system_controller' && agent?.systemRole !== spec.contract.systemController) {
                failures.push(`Routine ${spec.key} 必须绑定系统控制器 ${spec.contract.systemController}`);
            }
            else if (spec.contract?.executionMode === 'hermes') {
                failures.push(...hermesExecutionContractFailures(agent, spec.contract));
            }
        }
        const pipelineStages = asList(pipelineDetail?.stages);
        for (const stage of this.definition.stages.filter((item: any) => item.routineKey)) {
            const liveStage: any = pipelineStages.find((item: any) => item.key === stage.key);
            const routine = routineByKey.get(stage.routineKey);
            const contract = getM5RoutineExecutionContract(stage.routineKey);
            if (!liveStage)
                failures.push(`Pipeline 缺少阶段 ${stage.key}`);
            else if (routine && liveStage.routineId !== routine.id)
                failures.push(`阶段 ${stage.key} 未绑定声明的 Routine ${stage.routineKey}`);
            else if (!contract)
                failures.push(`阶段 ${stage.key} 缺少唯一执行契约`);
        }
        if (failures.length)
            throw new ContentCampaignError(`M5 启动前检查未通过：${failures.join('；')}。`);
        try {
            return await this.controlPlane.readContentAutonomyApprovalSnapshot(contentPlugin);
        }
        catch (error) {
            throw new ContentCampaignError(`M5 无法锁定内容插件批准快照：${safeText((error as any)?.message, 300) || 'unknown'}。`);
        }
    }
    async updateGrantWithRoutine(item: any, campaignGrant: any, routineEnabled: any) {
        const routineState = await this.setDailyRoutineEnabled(routineEnabled);
        try {
            return await this.updateGrant(item, campaignGrant);
        }
        catch (error) {
            if (routineState.changed)
                await this.setDailyRoutineEnabled(routineState.previousEnabled).catch(() => undefined);
            throw error;
        }
    }
    async setDailyRoutineEnabled(enabled: any) {
        const trigger = await this.dailyRoutine();
        if (typeof trigger.enabled !== 'boolean') {
            throw new ContentCampaignError('M5 每日入口触发器缺少明确 enabled 状态，活动保持未启动。');
        }
        const previousEnabled = trigger.enabled;
        if (previousEnabled === enabled)
            return { triggerId: trigger.id, previousEnabled, enabled, changed: false };
        await this.controlPlane.setDailyScheduleEnabled(trigger.id, enabled);
        return { triggerId: trigger.id, previousEnabled, enabled, changed: true };
    }
    async dailyRoutine() {
        return this.controlPlane.getDailySchedule(await this.pipeline());
    }
    async serialize(operation: any) {
        const previous = this.controlTail;
        let release: () => void = () => undefined;
        this.controlTail = new Promise((resolve: any) => { release = resolve; });
        await previous.catch(() => undefined);
        try {
            return await operation();
        }
        finally {
            release();
        }
    }
}
function caseRows(value: any) {
    return Array.isArray(value) ? value.filter(Boolean) : [];
}
function agentInvocationBlockReason(agent: any) {
    if (!agent)
        return '找不到 assignee Agent';
    if (!INVOKABLE_AGENT_STATUSES.has(agent.status))
        return `Paperclip 状态为 ${agent.status || 'unknown'}`;
    const adapterType = String(agent.adapterType || '').trim();
    if (!adapterType)
        return '缺少 adapterType';
    if (adapterType === 'http') {
        const url = String(agent.adapterConfig?.url || '').trim();
        if (!url)
            return 'HTTP adapter 缺少受控 url';
        try {
            if (!['http:', 'https:'].includes(new URL(url).protocol))
                return 'HTTP adapter url 协议无效';
        }
        catch {
            return 'HTTP adapter url 无效';
        }
    }
    if (adapterType === 'hermes_local') {
        if (!String(agent.adapterConfig?.provider || '').trim())
            return 'Hermes adapter 缺少 provider';
        if (!String(agent.adapterConfig?.model || '').trim())
            return 'Hermes adapter 缺少 model';
    }
    return null;
}
function hermesExecutionContractFailures(agent: any, contract: any) {
    const failures = [];
    if (agent?.roleId !== contract.agentId)
        failures.push(`Routine ${contract.routineKey} 必须绑定岗位 ${contract.agentId}`);
    if (agent?.adapterType !== 'hermes_local') {
        failures.push(`Routine ${contract.routineKey} 的岗位必须使用 hermes_local`);
        return failures;
    }
    const acceptedTaskTypes = commaSeparated(agent.adapterConfig?.env?.AGENT_ARMY_ALLOWED_TASK_TYPES);
    if (!acceptedTaskTypes.includes(contract.taskType))
        failures.push(`岗位 ${contract.agentId} 的 manifest 未声明任务类型 ${contract.taskType}`);
    const mcpTools = commaSeparated(agent.adapterConfig?.env?.AGENT_ARMY_ALLOWED_MCP_TOOLS);
    for (const tool of ['paperclip_assignment_get', contract.completionTool]) {
        if (tool && !mcpTools.includes(tool))
            failures.push(`岗位 ${contract.agentId} 的 MCP 工具契约缺少 ${tool}`);
    }
    if (contract.executionTool?.kind === 'agent_army_mcp' && !mcpTools.includes(contract.executionTool.id)) {
        failures.push(`岗位 ${contract.agentId} 的 MCP 工具契约缺少 ${contract.executionTool.id}`);
    }
    return failures;
}
function commaSeparated(value: any) {
    const resolved = value && typeof value === 'object' && value.type === 'plain' ? value.value : value;
    return [...new Set(String(resolved || '').split(',').map((item: any) => item.trim()).filter(Boolean))];
}
function dateOnlyInTimeZone(value: any, timeZone: any) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime()))
        throw new ContentCampaignError('M5 每日入口当前时间无效。');
    let parts;
    try {
        parts = new Intl.DateTimeFormat('en-US', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).formatToParts(date);
    }
    catch {
        throw new ContentCampaignError(`M5 每日入口时区无效：${safeText(timeZone, 80)}。`);
    }
    const byType = Object.fromEntries(parts.map((part: any) => [part.type, part.value]));
    return `${byType.year}-${byType.month}-${byType.day}`;
}

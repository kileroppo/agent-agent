import { PaperclipOrganizationClient } from '@agent-army/paperclip-client';
const COMPANY_NAME: any = 'Agent军团';
const REVIEW_SUBJECT_MARKER: any = '[agent-army:review-subject:v1]';
export class PaperclipTaskProjector {
    client: any;
    clock: any;
    company: any;
    constructor({ endpoint, clock = (): any => new Date() }: any = {}) {
        this.client = new PaperclipOrganizationClient({ endpoint });
        this.clock = clock;
        this.company = null;
    }
    async project(task: any, approval: any): Promise<any> {
        try {
            const company: any = await this.companyForRuntime();
            const deterministicLocalExecution: any = [
                'army.cross-agent-mission',
                'office.presentation-package',
            ].includes(task.taskType);
            const managedAgent: any = task.assigneeAgentId
                ? await this.managedAgent(task.assigneeAgentId, company.id)
                : null;
            const issue: any = await this.client.createIssue(company.id, {
                title: task.input.title,
                description: describeTask(task),
                // Paperclip protects users from accidentally creating two recent issues
                // with the same title. AJun already has its own task idempotency contract,
                // so use the local task id here and do not let a previous same-title review
                // become the execution envelope for a new delivery snapshot.
                idempotencyKey: `ajun-runtime:${task.taskId}`.slice(0, 255),
                allowDuplicate: true,
                status: approval
                    ? 'blocked'
                    : deterministicLocalExecution
                        ? 'backlog'
                        : managedAgent
                            ? 'todo'
                            : 'backlog',
                priority: priorityFor(task.priority),
                ...(task.taskType === 'operations.technical-repair' && managedAgent?.metadata?.paperclipProjectId
                    ? { projectId: managedAgent.metadata.paperclipProjectId }
                    : {}),
                ...(managedAgent && !deterministicLocalExecution ? { assigneeAgentId: managedAgent.id } : {}),
            });
            const result: Record<string, any> = {
                status: 'synced',
                paperclipIssueId: issue.id,
                paperclipIssueIdentifier: issue.identifier,
                ...(managedAgent && !deterministicLocalExecution ? {
                    paperclipAssigneeAgentId: managedAgent.id,
                    paperclipAssigneeName: managedAgent.name,
                } : {}),
                syncedAt: this.clock().toISOString(),
            };
            if (approval) {
                const governanceApproval: any = await this.client.createApproval(company.id, {
                    type: 'request_board_approval',
                    issueIds: [issue.id],
                    payload: {
                        source: 'ajun-runtime',
                        taskId: task.taskId,
                        action: approval.action,
                        riskLevel: approval.riskLevel,
                        reason: approval.reason,
                        requestedScope: approval.requestedScope,
                    },
                });
                result.paperclipApprovalId = governanceApproval.id;
            }
            return result;
        }
        catch (error: any) {
            return { status: 'sync_pending', reason: safeError(error), syncedAt: this.clock().toISOString() };
        }
    }
    async projectChild(task: any, parentIssueId: any): Promise<any> {
        try {
            const company: any = await this.companyForRuntime();
            const managedAgent: any = task.assigneeAgentId
                ? await this.managedAgent(task.assigneeAgentId, company.id)
                : null;
            const issue: any = await this.client.createChildIssue(parentIssueId, {
                title: task.input.title,
                description: describeTask(task),
                status: 'todo',
                priority: priorityFor(task.priority),
                blockParentUntilDone: true,
                ...(managedAgent ? { assigneeAgentId: managedAgent.id } : {}),
            });
            return {
                status: 'synced',
                paperclipIssueId: issue.id,
                paperclipIssueIdentifier: issue.identifier,
                paperclipParentIssueId: parentIssueId,
                ...(managedAgent ? {
                    paperclipAssigneeAgentId: managedAgent.id,
                    paperclipAssigneeName: managedAgent.name,
                } : {}),
                syncedAt: this.clock().toISOString(),
            };
        }
        catch (error: any) {
            return {
                status: 'sync_pending',
                paperclipParentIssueId: parentIssueId,
                reason: safeError(error),
                syncedAt: this.clock().toISOString(),
            };
        }
    }
    async companyForRuntime(): Promise<any> {
        if (this.company)
            return this.company;
        const companies: any = await this.client.listCompanies();
        const company: any = companies.find((item: any): any => item.name === COMPANY_NAME);
        if (!company)
            throw new Error(`Paperclip 中未找到“${COMPANY_NAME}”组织。`);
        this.company = company;
        return company;
    }
    async managedAgent(agentArmyId: any, companyId: any = null): Promise<any> {
        const company: any = companyId ? { id: companyId } : await this.companyForRuntime();
        const agents: any = await this.client.listAgents(company.id);
        return agents.find((agent: any): any => agent.metadata?.agentArmyId === agentArmyId && agent.status !== 'terminated') || null;
    }
}
function describeTask(task: any): any {
    const parts: any[] = [
        '由 A君运行台创建的过渡任务投影。正式军团任务由 Paperclip 统一调度；A君只执行本机业务适配。',
        `A君任务 ID：${task.taskId}`,
        `任务类型：${task.taskType}`,
        `运行时状态：${task.status}`,
        `承接岗位：${task.assigneeAgentId || '待路由'}`,
    ];
    if (task.input.description)
        parts.push(`说明：${task.input.description}`);
    const publicSourceUrls: any = safePublicUrls([
        task.input?.sourceUrl,
        ...(Array.isArray(task.input?.sourceUrls) ? task.input.sourceUrls : []),
    ]);
    if (publicSourceUrls.length)
        parts.push(`公开来源：${JSON.stringify([...new Set(publicSourceUrls)])}`);
    const context: any = task.input?.context;
    const missionItems: any = safeBusinessMissionItems(context?.businessMissionItems);
    if (task.taskType === 'army.cross-agent-mission' && missionItems.length) {
        parts.push([
            '受控业务分工（Paperclip 用于审计；A君本机生成依赖计划）：',
            JSON.stringify(missionItems),
        ].join('\n'));
    }
    if (task.taskType === 'governance.approval-review') {
        const reviewSubject: any = safeReviewSubject(context);
        if (reviewSubject)
            parts.push(`${REVIEW_SUBJECT_MARKER}\n${JSON.stringify(reviewSubject)}`);
    }
    if (context?.failure) {
        parts.push([
            '脱敏故障信息：',
            `代码：${String(context.failure.code || 'unknown')}`,
            `阶段：${String(context.failure.stage || 'unknown')}`,
            `类别：${String(context.failure.category || 'manual')}`,
            `是否允许安全重试：${context.failure.retryable === true ? '是' : '否'}`,
        ].join('\n'));
    }
    if (task.taskType === 'operations.technical-repair') {
        parts.push('工程要求：先复现和定位；只能修改当前项目；必须运行相关测试；没有证据不得宣称修好；禁止读取凭据、登录、外发、付费、扩权或发布。');
    }
    return parts.join('\n\n');
}
function safeBusinessMissionItems(value: any): any {
    if (!Array.isArray(value))
        return [];
    return value.slice(0, 11).flatMap((item: any, index: any): any => {
        if (!item || typeof item !== 'object')
            return [];
        const agentId: any = safeText(item.agentId, 80);
        const taskType: any = safeText(item.taskType, 120);
        const title: any = safeText(item.title, 300);
        if (!agentId || !taskType || !title)
            return [];
        return [{
                key: safeText(item.key, 80) || `work-${index + 1}`,
                agentId,
                taskType,
                title,
                acceptance: safeText(item.acceptance, 500) || null,
                sourceUrls: safePublicUrls(item.sourceUrls),
                dependsOn: Array.isArray(item.dependsOn)
                    ? item.dependsOn.map((child: any): any => safeText(child, 80)).filter(Boolean).slice(0, 10)
                    : [],
            }];
    });
}
function safePublicUrls(value: any): any {
    if (!Array.isArray(value))
        return [];
    return value.slice(0, 5).flatMap((item: any): any => {
        try {
            const url: any = new URL(String(item || '').trim());
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
                return [];
            return [url.toString().slice(0, 1000)];
        }
        catch {
            return [];
        }
    });
}
function safeReviewSubject(context: any): any {
    const root: any = plainObject(context);
    const nested: any = plainObject(root.reviewSubject || root.proposal || root.candidate);
    const manifest: any = plainObject(nested.candidateManifest || root.candidateManifest);
    const source: any = Object.keys(nested).length ? nested : root;
    const result: Record<string, any> = {};
    const scope: any = safeScope(source.scope ?? root.scope);
    const dataScopes: any = safeDataScopes(source.dataScopes ?? manifest.dataScopes ?? root.dataScopes);
    const toolAllowlist: any = safeStrings(source.toolAllowlist ?? manifest.toolAllowlist ?? root.toolAllowlist, 20, 120);
    const budget: any = safeBudget(source.budget ?? source.budgetPolicy ?? manifest.budgetPolicy ?? root.budget ?? root.budgetPolicy);
    const validUntil: any = safeText(source.validUntil ?? root.validUntil, 80);
    const externalSideEffects: any = safeStrings(source.externalSideEffects ?? root.externalSideEffects, 12, 120);
    const capabilityAudit: any = safeCapabilityAudit(source.capabilityAudit ?? source.capabilityAudits ?? root.capabilityAudit ?? root.capabilityAudits);
    const approvalPolicies: any = safeApprovalPolicies(source.approvalPolicies ?? manifest.approvalPolicies ?? root.approvalPolicies);
    if (scope)
        result.scope = scope;
    if (dataScopes.length)
        result.dataScopes = dataScopes;
    if (toolAllowlist.length)
        result.toolAllowlist = toolAllowlist;
    if (budget)
        result.budget = budget;
    if (validUntil)
        result.validUntil = validUntil;
    if (externalSideEffects.length)
        result.externalSideEffects = externalSideEffects;
    if (capabilityAudit.length)
        result.capabilityAudit = capabilityAudit;
    if (approvalPolicies.length)
        result.approvalPolicies = approvalPolicies;
    return Object.keys(result).length ? result : null;
}
function safeScope(value: any): any {
    if (typeof value === 'string')
        return safeText(value, 500) || null;
    const scope: any = plainObject(value);
    const result: Record<string, any> = {};
    for (const key of ['goal', 'outcome', 'description', 'boundary', 'deliverable']) {
        const text: any = safeText((scope as any)[key], 500);
        if (text)
            (result as any)[key] = text;
    }
    const constraints: any = safeStrings(scope.constraints, 12, 300);
    if (constraints.length)
        result.constraints = constraints;
    return Object.keys(result).length ? result : null;
}
function safeDataScopes(value: any): any {
    return asArray(value).slice(0, 12).flatMap((item: any): any => {
        const row: any = plainObject(item);
        const scope: any = safeText(row.scope, 120);
        const access: any = safeStrings(row.access, 8, 40);
        const boundary: any = safeText(row.boundary, 500);
        return scope && access.length && boundary ? [{ scope, access, boundary }] : [];
    });
}
function safeBudget(value: any): any {
    const source: any = plainObject(value);
    const result: Record<string, any> = {};
    for (const key of ['maxRuns', 'maxModelCalls', 'maxTokens', 'maxWallClockSeconds', 'maxCostUsd']) {
        const number: any = Number((source as any)[key]);
        if (Number.isFinite(number) && number >= 0)
            (result as any)[key] = number;
    }
    if (typeof source.externalSpendAllowed === 'boolean')
        result.externalSpendAllowed = source.externalSpendAllowed;
    return Object.keys(result).length ? result : null;
}
function safeCapabilityAudit(value: any): any {
    return asArray(value).slice(0, 20).flatMap((item: any): any => {
        const row: any = plainObject(item);
        const capabilityId: any = safeText(row.capabilityId || row.capability || row.toolId, 120);
        const status: any = safeText(row.status || row.result, 40);
        return capabilityId && status ? [{ capabilityId, status }] : [];
    });
}
function safeApprovalPolicies(value: any): any {
    return asArray(value).slice(0, 12).flatMap((item: any): any => {
        const row: any = plainObject(item);
        const action: any = safeText(row.action || row.sideEffect, 120);
        const riskLevel: any = safeText(row.riskLevel, 40);
        const decision: any = safeText(row.decision || row.result, 80);
        return action && decision ? [{ action, ...(riskLevel ? { riskLevel } : {}), decision }] : [];
    });
}
function safeStrings(value: any, limit: any, maxLength: any): any {
    return [...new Set(asArray(value).map((item: any): any => safeText(typeof item === 'string' ? item : item?.id || item?.name, maxLength)).filter(Boolean))].slice(0, limit);
}
function safeText(value: any, maxLength: any): any {
    return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}
function plainObject(value: any): any {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function asArray(value: any): any {
    return Array.isArray(value) ? value : value == null ? [] : [value];
}
function priorityFor(priority: any): any {
    return (({ low: 'low', high: 'high', urgent: 'urgent' }) as any)[priority] || 'medium';
}
function safeError(error: any): any {
    return String(error?.message || 'Paperclip 暂不可用。').slice(0, 240);
}

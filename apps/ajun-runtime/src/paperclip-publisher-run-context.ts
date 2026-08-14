const SYSTEM_ROLE: any = 'm5-publisher-controller';
export class PaperclipPublisherRunContext {
    governance: any;
    paperclipAdapter: any;
    systemRole: any;
    constructor({ paperclipAdapter, governance, systemRole = SYSTEM_ROLE, }: any = {}) {
        this.paperclipAdapter = paperclipAdapter;
        this.governance = governance;
        this.systemRole = systemRole;
    }
    async resolve({ heartbeat, bearerToken }: any = {}): Promise<any> {
        this.assertDependencies();
        const runId: any = requiredValue(heartbeat?.runId, 'Paperclip heartbeat 缺少运行标识。');
        const issueId: any = requiredValue(heartbeat?.context?.taskId, 'Paperclip heartbeat 缺少任务标识。');
        const apiKey: any = requiredValue(bearerToken, 'Paperclip Run JWT 缺失。');
        const actor: any = await this.paperclipAdapter.authenticateRun({ apiKey, runId });
        const actorId: any = requiredValue(actor?.id, 'Paperclip Run JWT 身份无效。');
        const actorCompanyId: any = requiredValue(actor?.companyId, 'Paperclip Run JWT 公司身份无效。');
        const verified: any = await this.governance.verifySystemAssignment({
            issueId,
            runId,
            paperclipAgentId: actorId,
            systemRole: this.systemRole,
        });
        const canonical: Record<string, any> = {
            issueId: requiredValue(verified?.issue?.id, 'Paperclip 核验结果缺少任务标识。'),
            runId: requiredValue(verified?.run?.id, 'Paperclip 核验结果缺少运行标识。'),
            agentId: requiredValue(verified?.paperclipAgent?.id, 'Paperclip 核验结果缺少控制器标识。'),
            companyId: requiredValue(verified?.issue?.companyId, 'Paperclip 核验结果缺少公司标识。'),
        };
        if (canonical.issueId !== issueId
            || canonical.runId !== runId
            || canonical.agentId !== actorId
            || canonical.companyId !== actorCompanyId
            || verified?.systemRole !== this.systemRole
            || verified?.run?.companyId !== canonical.companyId
            || verified?.paperclipAgent?.companyId !== canonical.companyId) {
            throw new PaperclipPublisherRunContextError('Paperclip JWT、heartbeat 与 canonical 身份链不一致。');
        }
        return Object.freeze(canonical);
    }
    assertDependencies(): any {
        if (typeof this.paperclipAdapter?.authenticateRun !== 'function') {
            throw new PaperclipPublisherRunContextError('缺少 Paperclip Run JWT 认证适配器。');
        }
        if (typeof this.governance?.verifySystemAssignment !== 'function') {
            throw new PaperclipPublisherRunContextError('缺少 Paperclip 系统任务核验适配器。');
        }
    }
}
export class PaperclipPublisherRunContextError extends Error {
}
export function canonicalPaperclipHeartbeat(heartbeat: any, canonical: any): any {
    const input: any = heartbeat && typeof heartbeat === 'object' && !Array.isArray(heartbeat)
        ? heartbeat
        : {};
    const context: any = input.context && typeof input.context === 'object' && !Array.isArray(input.context)
        ? input.context
        : {};
    return {
        ...structuredClone(input),
        runId: requiredValue(canonical?.runId, 'Paperclip canonical Run 缺失。'),
        agentId: requiredValue(canonical?.agentId, 'Paperclip canonical Agent 缺失。'),
        context: {
            ...structuredClone(context),
            taskId: requiredValue(canonical?.issueId, 'Paperclip canonical Issue 缺失。'),
        },
    };
}
function requiredValue(value: any, message: any): any {
    const normalized: any = String(value || '').trim();
    if (!normalized)
        throw new PaperclipPublisherRunContextError(message);
    return normalized;
}

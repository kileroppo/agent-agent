import { M5_SCHEMA_IDS } from '@agent-army/m5-contracts';
import { consumeM5SystemControllerPlanRevision, isRecoverableM5SystemControllerFailure, markM5SystemControllerFailure, recoverM5SystemControllerFailure, } from './m5-system-controller-recovery.ts';
import { derivePublishContext } from './publish-context-derivation.ts';
import { assertPublishReceiptIdentity, trustedPublishReceiptProducts, } from './trusted-publish-lineage.ts';
const SYSTEM_ROLE: any = 'm5-publisher-controller';
const ROUTINE_MARKER: any = '[agent-army:m5:routine:m5-publish]';
const PUBLISHER_PROVIDER: any = 'agent-army.publisher-gateway';
const PUBLISH_RECEIPT_SCHEMA: any = M5_SCHEMA_IDS.PUBLISH_RECEIPT;
const FORBIDDEN_CALLER_FIELDS: any = new Set([
    'campaignId',
    'campaignCaseId',
    'campaignGrant',
    'caseId',
    'platform',
    'scheduledDate',
    'contentVersion',
    'contentVersionId',
    'contentChecksum',
    'checksum',
    'mediaPath',
    'title',
    'body',
    'tags',
    'reviewReport',
    'idempotencyKey',
    'receiptId',
    'accountRef',
]);
export class PaperclipPublisherController {
    governance: any;
    inFlightIssues: any;
    now: any;
    publisher: any;
    constructor({ governance, publisher, now = (): any => new Date(), }: any = {}) {
        this.governance = governance;
        this.publisher = publisher;
        this.now = now;
        this.inFlightIssues = new Map();
    }
    async handle(payload: any): Promise<any> {
        assertNoPublishSelectionParameters(payload);
        const runId: any = String(payload?.runId || '').trim();
        const agentId: any = String(payload?.agentId || '').trim();
        const issueId: any = String(payload?.context?.taskId || '').trim();
        if (!runId || !agentId || !issueId) {
            throw new PaperclipPublisherControllerError('M5 发布 HTTP heartbeat 缺少运行、控制器或任务标识。');
        }
        if (this.inFlightIssues.has(issueId))
            return this.inFlightIssues.get(issueId);
        const execution: any = this.executeIssue({ issueId, runId, agentId });
        this.inFlightIssues.set(issueId, execution);
        try {
            return await execution;
        }
        catch (error: any) {
            if (!isRecoverableM5SystemControllerFailure(error))
                throw error;
            try {
                return await recoverM5SystemControllerFailure({
                    governance: this.governance,
                    issueId,
                    runId,
                    agentId,
                    routineKey: 'm5-publish',
                    systemRole: SYSTEM_ROLE,
                    error,
                });
            }
            catch {
                throw error;
            }
        }
        finally {
            this.inFlightIssues.delete(issueId);
        }
    }
    async executeIssue({ issueId, runId, agentId }: any): Promise<any> {
        this.assertDependencies();
        const { issue } = await this.governance.verifySystemAssignment({
            issueId,
            runId,
            paperclipAgentId: agentId,
            systemRole: SYSTEM_ROLE,
        });
        if (!['in_progress', 'in_review', 'done'].includes(issue.status)) {
            throw new PaperclipPublisherControllerError('发布任务必须处于 in_progress、in_review 或已完成的幂等重放状态。');
        }
        if (!String(issue.description || '').includes(ROUTINE_MARKER)) {
            throw new PaperclipPublisherControllerError('HTTP 控制器只接受 M5 发布 Routine 的固定任务。');
        }
        const caseId: any = issueCaseId(issue);
        await this.governance.assertCaseIssueLink(caseId, issueId);
        await consumeM5SystemControllerPlanRevision({
            governance: this.governance,
            pipelineCaseId: caseId,
            runId,
            routineKey: 'm5-publish',
            systemRole: SYSTEM_ROLE,
        });
        const targetCase: any = normalizeCase(await this.governance.getPipelineCase(caseId));
        if (targetCase.id !== caseId || targetCase.stageKey !== 'publish') {
            throw new PaperclipPublisherControllerError('当前 Case 不在 publish 阶段，拒绝执行发布。');
        }
        const ancestry: any = await this.resolveCampaign(targetCase);
        const executionTime: any = this.now();
        const grant: any = activeCampaignGrant(ancestry.campaignCase, executionTime);
        const outputs: any = await this.governance.getPipelineCaseOutputs(caseId);
        const derived: any = trustedPublishInputs({
            outputs,
            targetCase,
            campaignCase: ancestry.campaignCase,
            grant,
            executionTime,
        });
        const existing: any = trustedPublishReceipts(outputs);
        if (existing.length > 1) {
            throw new PaperclipPublisherControllerError('当前 Case 存在多个可信 PublishReceipt，必须人工核对。');
        }
        if (existing.length === 1) {
            assertReceiptMatches(existing[0], derived);
            if (issue.status !== 'done') {
                await this.governance.completePublisherIssue(issueId, {
                    runId,
                    comment: '已核验当前 Case 的唯一 PublishReceipt；幂等重放未再次发布或写入 Work Product。',
                });
            }
            return {
                accepted: true,
                issueId,
                replayed: true,
                receipt: existing[0],
            };
        }
        try {
            const result: any = await this.publisher.publish(derived.request, {
                action: 'publisher.publish',
                runId,
                issueId,
                campaignId: ancestry.campaignCase.id,
                agentId,
                authorizationId: `paperclip:${runId}:${issueId}:publisher.publish`,
            });
            const receipt: any = validPublisherReceipt(result?.receipt, derived);
            await this.governance.createIssueWorkProduct(issueId, {
                type: 'artifact',
                provider: PUBLISHER_PROVIDER,
                externalId: receipt.receiptId,
                title: `M5 发布凭证 / ${receipt.platform}`,
                status: 'active',
                reviewState: 'none',
                isPrimary: true,
                healthStatus: 'healthy',
                summary: `${receipt.platform} 已返回可核验内容引用。`,
                metadata: {
                    schemaVersion: PUBLISH_RECEIPT_SCHEMA,
                    kind: 'PublishReceipt',
                    receipt,
                },
                createdByRunId: runId,
            }, { runId });
            const afterWrite: any = await this.governance.getPipelineCaseOutputs(caseId);
            const persisted: any = trustedPublishReceipts(afterWrite);
            if (persisted.length !== 1) {
                throw new PaperclipPublisherControllerError(`PublishReceipt 写回后必须唯一且可回读，实际为 ${persisted.length} 个。`);
            }
            assertReceiptMatches(persisted[0], derived);
            await this.governance.completePublisherIssue(issueId, {
                runId,
                comment: 'Publisher Gateway 已返回可核验内容引用，唯一 PublishReceipt 已写回并回读确认。',
            });
            return {
                accepted: true,
                issueId,
                replayed: result.replayed === true,
                receipt: persisted[0],
            };
        }
        catch (error: any) {
            throw markM5SystemControllerFailure(error);
        }
    }
    assertDependencies(): any {
        const required: any[] = [
            'verifySystemAssignment',
            'assertCaseIssueLink',
            'getPipelineCase',
            'getPipelineCaseOutputs',
            'createIssueWorkProduct',
            'completePublisherIssue',
        ];
        if (required.some((method: any): any => typeof this.governance?.[method] !== 'function')) {
            throw new PaperclipPublisherControllerError('M5 发布控制器缺少 Paperclip Case/Work Product 适配。');
        }
        if (typeof this.publisher?.publish !== 'function') {
            throw new PaperclipPublisherControllerError('M5 Publisher 未启用；真实发布保持关闭。');
        }
    }
    async resolveCampaign(targetCase: any): Promise<any> {
        if (!validUuid(targetCase.parentCaseId)) {
            throw new PaperclipPublisherControllerError('发布 Case 缺少有效的日期父 Case。');
        }
        const dayCase: any = normalizeCase(await this.governance.getPipelineCase(targetCase.parentCaseId));
        if (!validUuid(dayCase.parentCaseId)) {
            throw new PaperclipPublisherControllerError('日期 Case 缺少有效的活动父 Case。');
        }
        const campaignCase: any = normalizeCase(await this.governance.getPipelineCase(dayCase.parentCaseId));
        if (!targetCase.parentCaseId
            || !dayCase.id
            || dayCase.id !== targetCase.parentCaseId
            || !campaignCase.id
            || campaignCase.id !== dayCase.parentCaseId
            || campaignCase.parentCaseId
            || campaignCase.stageKey !== 'campaign_active'
            || campaignCase.pipelineId !== targetCase.pipelineId
            || dayCase.pipelineId !== targetCase.pipelineId) {
            throw new PaperclipPublisherControllerError('发布 Case 不属于有效的活动父 Case 层级。');
        }
        return { dayCase, campaignCase };
    }
}
export class PaperclipPublisherControllerError extends Error {
}
export function trustedPublishInputs({ outputs, targetCase, campaignCase, grant, executionTime, }: any): any {
    return derivePublishContext({
        outputs,
        targetCase,
        campaignCase,
        grant,
        executionTime,
    }, {
        invalid: (message: any): any => new PaperclipPublisherControllerError(message),
    });
}
export function trustedPublishReceipts(outputs: any): any {
    return trustedPublishReceiptProducts(outputs).map((item: any): any => validReceiptStructure(item.metadata.receipt));
}
function activeCampaignGrant(campaignCase: any, nowValue: any): any {
    const grant: any = campaignCase.fields?.campaignGrant;
    const now: any = validDate(nowValue);
    const startsAt: any = Date.parse(grant?.startsAt);
    const expiresAt: any = Date.parse(grant?.expiresAt);
    if (!grant
        || grant.status !== 'active'
        || !Number.isFinite(startsAt)
        || !Number.isFinite(expiresAt)
        || startsAt > now.getTime()
        || expiresAt <= now.getTime()) {
        throw new PaperclipPublisherControllerError('活动父 Case 缺少当前有效的 active CampaignGrant。');
    }
    return structuredClone(grant);
}
function validPublisherReceipt(receipt: any, derived: any): any {
    const valid: any = validReceiptStructure(receipt);
    assertReceiptMatches(valid, derived);
    return valid;
}
function validReceiptStructure(receipt: any): any {
    return assertPublishReceiptIdentity(receipt, {
        invalid: (): any => new PaperclipPublisherControllerError('Publisher Gateway 没有返回结构完整的 PublishReceipt。'),
    });
}
function assertReceiptMatches(receipt: any, derived: any): any {
    const request: any = derived.request;
    if (receipt.campaignId !== request.campaignId
        || receipt.platform !== request.platform
        || receipt.contentVersionId !== request.contentVersionId
        || receipt.contentChecksum !== request.contentChecksum
        || receipt.scheduledDate !== request.scheduledDate
        || receipt.idempotencyKey !== request.idempotencyKey) {
        throw new PaperclipPublisherControllerError('PublishReceipt 与当前 Case 派生的发布上下文不一致。');
    }
}
function normalizeCase(value: any): any {
    const item: any = value?.case ?? value;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new PaperclipPublisherControllerError('Paperclip Case 结构无效。');
    }
    return {
        ...item,
        stageKey: item.stageKey || value?.stage?.key || null,
        pipelineId: item.pipelineId || value?.pipeline?.id || null,
    };
}
function issueCaseId(issue: any): any {
    const value: any = String(issue?.description || '').match(/当前 Case 为 ([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/i)?.[1];
    if (!value)
        throw new PaperclipPublisherControllerError('M5 发布任务缺少固定 Case 绑定。');
    return value;
}
function validUuid(value: any): any {
    return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(value || ''));
}
function validDate(value: any): any {
    const date: any = value instanceof Date ? new Date(value) : new Date(value);
    if (!Number.isFinite(date.getTime())) {
        throw new PaperclipPublisherControllerError('M5 发布控制器时钟无效。');
    }
    return date;
}
function assertNoPublishSelectionParameters(payload: any): any {
    const queue: any[] = [payload];
    while (queue.length) {
        const value: any = queue.pop();
        if (!value || typeof value !== 'object')
            continue;
        for (const [key, child] of Object.entries(value)) {
            if (FORBIDDEN_CALLER_FIELDS.has(key)) {
                throw new PaperclipPublisherControllerError(`M5 发布 HTTP heartbeat 不接受调用方指定 ${key}。`);
            }
            if (child && typeof child === 'object')
                queue.push(child);
        }
    }
}

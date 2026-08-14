import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { coded, safeRelativePath, sha256 } from './policy.ts';
import { reservePaidToolBudget } from './paid-budget-guard.ts';
const LEGACY_RATE_LIMIT_INCIDENT = 'm5v1-20260730-stepfun-429';
export const DEFAULT_LEGACY_RATE_LIMIT_ACTIONS = Object.freeze({
    'm5_7theme_14beee9d_t03-evidence-chain_image1_m5v1': {
        runId: 'e8a85c3c-7de4-49ec-b845-3ac5e063e542',
        errorCode: 'stepfun_request_failed',
        stateChecksum: 'sha256:44f3005adffc50206df0e146f534b8d5a445fe8d4e9029ad4c1f22f20ce17ef6',
        parameterChecksum: 'sha256:b094fe35baf9b510a0d00ab34c5108497e4f3a1756111f5b7478821304ace4c5',
    },
    'm5_7theme_14beee9d_t03-evidence-chain_tts-paperclip-b64-v1_m5v1': {
        runId: 'e8a85c3c-7de4-49ec-b845-3ac5e063e542',
        errorCode: 'stepfun_tts_failed',
        stateChecksum: 'sha256:9d5b3f6753120f57ede66b17b063fb976335c0209f43b2443b66c585eb3cf274',
        parameterChecksum: 'sha256:5de4c0932234f0f5d0741dde5c2ebddf91668c36196495c9d90472393b338884',
    },
});
export class PaidProviderActionProtocol {
    readonly getContext: () => any;
    readonly getPaidBudgetChecker: () => any;
    readonly getLegacyRateLimitActions: () => any;
    readonly getInflight: () => Map<any, any>;
    readonly validateConfirmedOutput: (...args: any[]) => any;
    readonly runCostTransition: (...args: any[]) => any;

    constructor({ getContext, getPaidBudgetChecker, getLegacyRateLimitActions, getInflight, assertConfirmedOutput, withCostTransition, }: any) {
        this.getContext = getContext;
        this.getPaidBudgetChecker = getPaidBudgetChecker;
        this.getLegacyRateLimitActions = getLegacyRateLimitActions;
        this.getInflight = getInflight;
        this.validateConfirmedOutput = assertConfirmedOutput;
        this.runCostTransition = withCostTransition;
    }
    async claim(params: any, run: any) {
        const actionId = validActionId(params.actionId);
        return this.runCostTransition(run, actionId, async () => {
            const stateKey = paidActionStateKey(run.projectId, actionId);
            const existing = await this.getContext().state.get(stateKey);
            if (!existing)
                throw coded('paid_action_not_found', '没有找到对应的付费 action，禁止创建费用提交。');
            assertPaidActionContext(existing, run);
            if (existing.state === 'confirmed') {
                return {
                    content: '费用事件已经确认。',
                    data: { ...existing.resultData, replayed: true, nextStageAllowed: true }
                };
            }
            if (existing.state === 'cost_event_submitting') {
                const error = coded('cost_event_submitting', '费用事件已经领取提交租约；结果未决时禁止再次提交。');
                (error as any).data = existing.resultData;
                throw error;
            }
            if (existing.state !== 'cost_event_pending') {
                throw coded('paid_action_ambiguous', '付费 action 不处于可提交费用的状态。');
            }
            const costEvent = existing.resultData?.costCommit?.costEvent;
            if (!costEvent)
                throw coded('cost_event_missing', '付费 action 缺少费用事件草稿。');
            const submissionId = crypto.randomUUID();
            const resultData = {
                ...existing.resultData,
                nextStageAllowed: false,
                costCommit: {
                    status: 'submitting_core_cost_event',
                    submissionId,
                    costEvent
                }
            };
            await this.getContext().state.set(stateKey, {
                ...existing,
                state: 'cost_event_submitting',
                submissionId,
                resultData,
                updatedAt: new Date().toISOString()
            });
            return {
                content: '费用事件提交租约已领取；只允许向 Paperclip 核心费用接口提交一次。',
                data: resultData
            };
        });
    }
    async confirm(params: any, run: any) {
        const actionId = validActionId(params.actionId);
        const submissionId = validUuid(params.submissionId, 'cost_submission_id_invalid', '费用提交租约标识无效。');
        const costEventId = validUuid(params.costEventId, 'cost_event_id_invalid', 'Paperclip 费用事件标识无效。');
        return this.runCostTransition(run, actionId, async () => {
            const stateKey = paidActionStateKey(run.projectId, actionId);
            const existing = await this.getContext().state.get(stateKey);
            if (!existing)
                throw coded('paid_action_not_found', '没有找到对应的付费 action，禁止确认费用。');
            assertPaidActionContext(existing, run);
            if (existing.state === 'confirmed') {
                if (existing.costEventId !== costEventId || existing.submissionId !== submissionId) {
                    throw coded('cost_confirmation_conflict', '费用已经由另一条 Paperclip 回执确认，拒绝覆盖。');
                }
                return {
                    content: '费用事件已经确认。',
                    data: { ...existing.resultData, replayed: true, nextStageAllowed: true }
                };
            }
            if (existing.state !== 'cost_event_submitting' || existing.submissionId !== submissionId) {
                throw coded('cost_submission_mismatch', '费用提交租约与当前未决记录不一致。');
            }
            const resultData = {
                ...existing.resultData,
                nextStageAllowed: true,
                costCommit: {
                    status: 'confirmed',
                    submissionId,
                    costEventId,
                    costEvent: existing.resultData?.costCommit?.costEvent
                }
            };
            await this.getContext().state.set(stateKey, {
                ...existing,
                state: 'confirmed',
                submissionId,
                costEventId,
                resultData,
                confirmedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            });
            return {
                content: 'Paperclip 核心费用事件已经确认，允许继续下一阶段。',
                data: resultData
            };
        });
    }
    async reconcileLegacyRateLimit(params: any, run: any) {
        const actionId = validActionId(params.actionId);
        const expected = this.getLegacyRateLimitActions()[actionId];
        if (!expected || run.runId !== expected.runId) {
            throw coded('legacy_rate_limit_scope_denied', '该动作不属于已核验的M5限流事故范围。');
        }
        return this.runCostTransition(run, actionId, async () => {
            const stateKey = paidActionStateKey(run.projectId, actionId);
            const existing = await this.getContext().state.get(stateKey);
            if (existing?.state === 'rate_limited'
                && existing?.legacyIncidentId === LEGACY_RATE_LIMIT_INCIDENT
                && existing?.parameterChecksum === expected.parameterChecksum) {
                return {
                    content: '历史429状态已经完成精确迁移。',
                    data: { actionId, state: 'rate_limited', replayed: true, providerCalls: 0 },
                };
            }
            if (existing?.actionId !== actionId
                || existing?.state !== 'ambiguous'
                || existing?.runId !== expected.runId
                || existing?.errorCode !== expected.errorCode
                || sha256(Buffer.from(stableJson(existing))) !== expected.stateChecksum) {
                throw coded('legacy_rate_limit_state_mismatch', '历史429状态与事故快照不一致，拒绝迁移。');
            }
            await this.getContext().state.set(stateKey, {
                ...existing,
                state: 'rate_limited',
                parameterChecksum: expected.parameterChecksum,
                errorCode: 'stepfun_rate_limited',
                httpStatus: 429,
                providerAttempts: 1,
                rateLimitRejections: 1,
                legacyIncidentId: LEGACY_RATE_LIMIT_INCIDENT,
                legacyStateChecksum: expected.stateChecksum,
                updatedAt: new Date().toISOString(),
            });
            return {
                content: '历史429状态已迁移为同参数可恢复状态。',
                data: { actionId, state: 'rate_limited', replayed: false, providerCalls: 0 },
            };
        });
    }
    async execute(params: any, run: any, operation: any, maximumCostCents: any, invoke: any) {
        const actionId = validActionId(params.actionId);
        const parameterChecksum = paidParameterChecksum(params);
        const stateKey = paidActionStateKey(run.projectId, actionId);
        const memoryKey = `${run.projectId}:${actionId}`;
        if (this.getInflight().has(memoryKey))
            throw coded('paid_action_in_progress', '相同付费 action 正在执行，禁止并发重放。');
        this.getInflight().set(memoryKey, true);
        let invocationStarted = false;
        try {
            const existing = await this.getContext().state.get(stateKey);
            if (existing) {
                if (existing.state === 'confirmed') {
                    assertPaidActionReplayContext(existing, run);
                    if (existing.operation !== operation
                        || existing.parameterChecksum !== parameterChecksum) {
                        throw coded('paid_action_context_mismatch', '已确认付费 action 的参数或操作发生变化；必须使用新的 action revision。');
                    }
                    await this.validateConfirmedOutput(existing, run);
                    return {
                        content: '已复用完成且费用已确认的付费 action。',
                        data: { ...existing.resultData, replayed: true, nextStageAllowed: true }
                    };
                }
                if (existing.state === 'rate_limited') {
                    assertPaidActionReplayContext(existing, run);
                    if (existing.operation !== operation
                        || existing.parameterChecksum !== parameterChecksum) {
                        throw coded('paid_action_context_mismatch', '限流恢复的付费 action 参数或操作发生变化。');
                    }
                }
                else {
                    assertPaidActionContext(existing, run);
                }
                if (existing.state !== 'rate_limited') {
                    const error = coded(existing.state === 'cost_event_pending'
                        ? 'cost_event_pending'
                        : existing.state === 'cost_event_submitting'
                            ? 'cost_event_submitting'
                            : 'paid_action_ambiguous', existing.state === 'cost_event_pending'
                        ? '付费调用已经完成但核心 cost_event 尚未确认，禁止重放和进入下一阶段。'
                        : existing.state === 'cost_event_submitting'
                            ? '费用事件已经领取提交租约；结果未决时禁止重放、重复计费或进入下一阶段。'
                            : '该付费 action 已存在未决记录，禁止自动重放。');
                    (error as any).data = existing.resultData
                        ? { ...existing.resultData, providerCallReplayed: true }
                        : { actionId, operation, state: existing.state, providerCallReplayed: true };
                    throw error;
                }
            }
            const budgetReservation = await reservePaidToolBudget({
                checker: this.getPaidBudgetChecker(),
                run,
                actionId,
                operation,
                maximumCostCents,
                budgetTicket: params.budgetTicket,
                parameters: params,
            });
            await this.getContext().state.set(stateKey, {
                actionId,
                operation,
                state: 'invoking',
                agentId: run.agentId,
                companyId: run.companyId,
                projectId: run.projectId,
                runId: run.runId,
                parameterChecksum,
                budgetReservation,
                startedAt: new Date().toISOString()
            });
            invocationStarted = true;
            const result = await invoke();
            const resultData = {
                ...result.data,
                actionId,
                operation,
                nextStageAllowed: false
            };
            await this.getContext().state.set(stateKey, {
                actionId,
                operation,
                state: 'cost_event_pending',
                agentId: run.agentId,
                companyId: run.companyId,
                projectId: run.projectId,
                runId: run.runId,
                parameterChecksum,
                budgetReservation,
                resultData,
                updatedAt: new Date().toISOString()
            });
            return { ...result, data: resultData };
        }
        catch (error: any) {
            if (invocationStarted && error?.retryableWithoutCharge === true) {
                await this.getContext().state.set(stateKey, {
                    actionId,
                    operation,
                    state: 'rate_limited',
                    agentId: run.agentId,
                    companyId: run.companyId,
                    projectId: run.projectId,
                    runId: run.runId,
                    parameterChecksum,
                    errorCode: String(error?.code || 'stepfun_rate_limited'),
                    providerAttempts: nonnegativeInteger(error?.data?.providerAttempts),
                    rateLimitRejections: nonnegativeInteger(error?.data?.rateLimitRejections),
                    updatedAt: new Date().toISOString()
                }).catch(() => undefined);
            }
            else if (invocationStarted) {
                await this.getContext().state.set(stateKey, {
                    actionId,
                    operation,
                    state: 'ambiguous',
                    agentId: run.agentId,
                    companyId: run.companyId,
                    projectId: run.projectId,
                    runId: run.runId,
                    errorCode: String(error?.code || 'paid_action_failed'),
                    updatedAt: new Date().toISOString()
                }).catch(() => undefined);
            }
            throw error;
        }
        finally {
            this.getInflight().delete(memoryKey);
        }
    }
    async assertConfirmedArtifact(existing: any, run: any) {
        const isVision = existing.operation === 'vision';
        if (!isVision && !['image_generate', 'image_edit', 'tts'].includes(existing.operation))
            return;
        const relativePath = isVision
            ? existing.resultData?.sourcePath
            : existing.resultData?.relativePath;
        const expectedChecksum = String(isVision
            ? existing.resultData?.sourceChecksum
            : existing.resultData?.checksum || '');
        if (!relativePath || !/^sha256:[a-f0-9]{64}$/.test(expectedChecksum)) {
            throw coded('paid_action_artifact_invalid', '已确认付费 action 缺少可核验的本地文件血缘。');
        }
        const status = await this.getContext().localFolders.status(run.companyId, 'content-workspace');
        if (!status?.healthy || !status?.realPath) {
            throw coded('paid_action_artifact_unavailable', '已确认付费 action 的受控工作区不可用。');
        }
        const root = await fs.realpath(status.realPath);
        const candidate = path.resolve(root, safeRelativePath(relativePath));
        if (!candidate.startsWith(`${root}${path.sep}`)) {
            throw coded('paid_action_artifact_mismatch', '已确认付费 action 的本地文件不在受控工作区。');
        }
        let stat;
        let real;
        try {
            stat = await fs.lstat(candidate);
            real = await fs.realpath(candidate);
        }
        catch {
            throw coded('paid_action_artifact_mismatch', '已确认付费 action 的本地文件不存在。');
        }
        if (!stat.isFile()
            || stat.isSymbolicLink()
            || !real.startsWith(`${root}${path.sep}`)) {
            throw coded('paid_action_artifact_mismatch', '已确认付费 action 的本地文件路径无效。');
        }
        const bytes = await fs.readFile(real);
        if (sha256(bytes) !== expectedChecksum) {
            throw coded('paid_action_artifact_mismatch', '已确认付费 action 的本地文件哈希不匹配。');
        }
    }
    async withTransition(run: any, actionId: any, invoke: any) {
        const memoryKey = `cost-transition:${run.projectId}:${actionId}`;
        if (this.getInflight().has(memoryKey))
            throw coded('cost_transition_in_progress', '相同费用事件正在变更状态。');
        this.getInflight().set(memoryKey, true);
        try {
            return await invoke();
        }
        finally {
            this.getInflight().delete(memoryKey);
        }
    }
}
export function paidActionStateKey(projectId: any, actionId: any) {
    return {
        scopeKind: 'project',
        scopeId: projectId,
        namespace: 'paid-actions',
        stateKey: sha256(Buffer.from(actionId)).slice('sha256:'.length)
    };
}
export function paidParameterChecksum(params: any) {
    const safe = Object.fromEntries(Object.entries(params || {}).filter(([key]: any) => key !== 'budgetTicket'));
    return sha256(Buffer.from(stableJson(safe)));
}
function stableJson(value: any): string {
    if (Array.isArray(value))
        return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key: any) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}
function nonnegativeInteger(value: any) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}
function validActionId(value: any) {
    const actionId = String(value || '');
    if (!/^[A-Za-z0-9:_-]{8,160}$/.test(actionId)) {
        throw coded('invalid_action_id', '付费工具必须提供稳定、可验证的 actionId。');
    }
    return actionId;
}
function validUuid(value: any, code: any, message: any) {
    const id = String(value || '').trim();
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))
        throw coded(code, message);
    return id;
}
function assertPaidActionContext(existing: any, run: any) {
    assertPaidActionReplayContext(existing, run);
    if (existing.runId !== run.runId) {
        throw coded('cost_run_context_mismatch', '费用事件只能由产生它的 Paperclip Agent Run 确认。');
    }
}
function assertPaidActionReplayContext(existing: any, run: any) {
    if (existing.agentId !== run.agentId
        || existing.companyId !== run.companyId
        || existing.projectId !== run.projectId) {
        throw coded('cost_run_context_mismatch', '已确认费用只能由同公司、同项目、同岗位的新 Paperclip Agent Run 只读复用。');
    }
    if (existing.runId !== run.runId && run.status !== 'running') {
        throw coded('cost_run_context_mismatch', '跨 Run 复用已确认费用必须使用已核验为 running 的新 Paperclip Agent Run。');
    }
}

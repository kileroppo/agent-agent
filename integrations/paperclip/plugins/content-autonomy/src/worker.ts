import { definePlugin, runWorker } from '@paperclipai/plugin-sdk';
import { campaignPreflight, publishPreflight, assertAgentToolGrant, coded } from './policy.ts';
import { StepFunContentTools } from './stepfun-tools.ts';
import { mediaProbe, mediaValidate, mediaFinalize, writeM5ArtifactPackage, validateArtifactLineage, verifyProviderAction, } from './media-tools.ts';
import { renderM5Composition, writeM5RenderProps, validateSubtitleLayoutFromProps } from './remotion-tools.ts';
import { isPaperclipSecretRef } from './secret-ref.ts';
import { validateExactAgentToolPolicy } from './role-tool-bundles.ts';
import { paidBudgetCheckerFromContext } from './paid-budget-guard.ts';
import { renderM5SocialCardPackage } from './social-card-tools.ts';
let healthy = true;
const plugin = definePlugin({
    async setup(ctx: any) {
        const stepfun = new StepFunContentTools({
            ctx,
            paidBudgetChecker: paidBudgetCheckerFromContext(ctx),
        });
        register(ctx, 'campaign-preflight', async (params: any) => ({
            content: '活动授权预检完成。',
            data: campaignPreflight(params.campaign)
        }));
        register(ctx, 'stepfun-vision', (params: any, run: any) => stepfun.vision(params, run));
        register(ctx, 'stepfun-image-generate', (params: any, run: any) => stepfun.image(params, run));
        register(ctx, 'stepfun-image-edit', (params: any, run: any) => stepfun.imageEdit(params, run));
        register(ctx, 'stepfun-tts', (params: any, run: any) => stepfun.tts(params, run));
        ctx.actions.register('cost-event-claim', (params: any, context: any) => stepfun.claimCostEvent(params, boardActionRunContext(params, context)));
        ctx.actions.register('cost-event-confirm', (params: any, context: any) => stepfun.confirmCostEvent(params, boardActionRunContext(params, context)));
        ctx.actions.register('provider-action-verify', (params: any, context: any) => verifyProviderAction(ctx, params, boardActionRunContext(params, context)));
        ctx.actions.register('legacy-rate-limit-reconcile', (params: any, context: any) => stepfun.reconcileLegacyRateLimit(params, boardActionRunContext(params, context)));
        register(ctx, 'media-probe', (params: any, run: any) => mediaProbe(ctx, params, run));
        register(ctx, 'media-validate', (params: any, run: any) => mediaValidate(ctx, params, run));
        register(ctx, 'media-finalize', (params: any, run: any) => mediaFinalize(ctx, params, run));
        register(ctx, 'remotion-props-write', (params: any, run: any) => writeM5RenderProps(ctx, params, run));
        register(ctx, 'remotion-render', (params: any, run: any) => renderM5Composition(ctx, params, run));
        register(ctx, 'social-card-render', (params: any, run: any) => renderM5SocialCardPackage(ctx, params, run));
        register(ctx, 'subtitle-layout-validate', (params: any, run: any) => validateSubtitleLayoutFromProps(ctx, params, run));
        register(ctx, 'artifact-package-write', (params: any, run: any) => writeM5ArtifactPackage(ctx, params, run));
        register(ctx, 'artifact-lineage-validate', (params: any, run: any) => validateArtifactLineage(ctx, params, run));
        register(ctx, 'publish-preflight', async (params: any) => ({
            content: '发布确定性门禁检查完成；本工具不会执行发布。',
            data: publishPreflight(params)
        }));
    },
    async onValidateConfig(config: any) {
        const errors = [];
        if (!isPaperclipSecretRef(config.stepfunSecretRef)) {
            errors.push('必须配置 Paperclip secret_ref 对象；禁止明文或旧字符串 UUID。');
        }
        try {
            const publicKey = String(config.budgetTicketPublicKey || '');
            if (publicKey.length < 80 || !publicKey.includes('BEGIN PUBLIC KEY')) {
                errors.push('必须配置A君预算票据Ed25519公钥。');
            }
        }
        catch {
            errors.push('预算票据公钥无效。');
        }
        if (!Array.isArray(config.officialTtsVoices) || !config.officialTtsVoices.length) {
            errors.push('必须登记至少一个 StepFun 官方音色。');
        }
        try {
            const baseUrl = new URL(String(config.stepfunBaseUrl || 'https://api.stepfun.com/v1'));
            if (!validStepFunBaseUrl(baseUrl, ['/v1'])) {
                errors.push('StepFun Base URL 只允许 https://api.stepfun.com。');
            }
        }
        catch {
            errors.push('StepFun Base URL 无效。');
        }
        try {
            const mediaBaseUrl = new URL(String(config.stepfunMediaBaseUrl || config.stepfunBaseUrl || 'https://api.stepfun.com/step_plan/v1'));
            if (!validStepFunBaseUrl(mediaBaseUrl, ['/v1', '/step_plan/v1'])) {
                errors.push('StepFun Media Base URL 只允许 https://api.stepfun.com。');
            }
        }
        catch {
            errors.push('StepFun Media Base URL 无效。');
        }
        const toolPolicy = validateExactAgentToolPolicy(config);
        errors.push(...toolPolicy.errors);
        const rates = config.costRatesCents;
        if (!rates || [
            'visionInputPerMillionTokens',
            'visionOutputPerMillionTokens',
            'imagePerGeneration',
            'ttsPerThousandCharacters'
        ].some((key: any) => !Number.isFinite(rates[key]) || rates[key] < 0)) {
            errors.push('必须配置全部非负 StepFun 计费率，禁止产生未计费调用。');
        }
        else if (Object.values(rates).every((value: any) => value === 0)) {
            errors.push('StepFun 计费率不能全部为零。');
        }
        return { ok: errors.length === 0, errors };
    },
    async onHealth() {
        return {
            status: healthy ? 'ok' : 'degraded',
            message: healthy ? '内容自治工具适配层已加载；真实外部调用仍受岗位、预算和活动授权控制。' : '最近一次工具调用失败。'
        };
    }
});
export default plugin;
runWorker(plugin, import.meta.url);
function register(ctx: any, toolName: any, handler: any) {
    const declaration = ctx.manifest.tools.find((item: any) => item.name === toolName);
    ctx.tools.register(toolName, declaration, async (params: any, run: any) => {
        try {
            const config = await ctx.config.get();
            assertAgentToolGrant(config, run.agentId, toolName);
            const result = await handler(params, run);
            if (result?.data?.nextStageAllowed === false) {
                healthy = false;
                return {
                    error: 'cost_event_pending: 付费调用已完成，但核心 cost_event 尚未确认；禁止进入下一阶段或重放。',
                    data: result.data
                };
            }
            healthy = result?.data?.nextStageAllowed !== false;
            await ctx.activity.log({
                companyId: run.companyId,
                message: `内容自治工具 ${toolName} 执行完成。`,
                entityType: 'agent_run',
                entityId: run.runId,
                metadata: {
                    toolName,
                    agentId: run.agentId,
                    outcome: result?.data?.nextStageAllowed === false ? 'pending_cost_confirmation' : 'succeeded'
                }
            });
            return result;
        }
        catch (error: any) {
            healthy = false;
            return {
                error: `${String(error?.code || 'tool_failed')}: ${String(error?.message || '工具执行失败。')}`,
                ...(error?.data ? { data: error.data } : {})
            };
        }
    });
}
function boardActionRunContext(params: any, context: any) {
    if (context?.actor?.type !== 'user' || !context.companyId) {
        throw coded('cost_control_actor_denied', '费用状态只能由 Paperclip 已认证的负责人执行面变更。');
    }
    const run = params?.runContext;
    if (!run
        || run.companyId !== context.companyId
        || ![run.agentId, run.runId, run.companyId, run.projectId].every((value: any) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(value || '')))) {
        throw coded('cost_control_context_denied', '费用状态缺少可信的 Paperclip Agent Run 上下文。');
    }
    return {
        agentId: run.agentId,
        runId: run.runId,
        companyId: run.companyId,
        projectId: run.projectId
    };
}
function validStepFunBaseUrl(url: any, allowedPaths: any) {
    return url.protocol === 'https:'
        && url.hostname === 'api.stepfun.com'
        && !url.port
        && !url.username
        && !url.password
        && !url.search
        && !url.hash
        && allowedPaths.includes(url.pathname.replace(/\/+$/, '') || '/');
}

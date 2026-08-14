import { createCostEventSchema } from '@paperclipai/shared';
import { sha256 } from './policy.ts';
export function callRecord({ run, actionId, model, operation, prompt, seed = null, inputs = [], outputs = [], usage = {}, costCents }: any) {
    const occurredAt = new Date().toISOString();
    const costEvent = createCostEventSchema.parse({
        agentId: run.agentId,
        projectId: run.projectId,
        heartbeatRunId: run.runId,
        provider: 'stepfun',
        biller: 'stepfun',
        billingType: 'metered_api',
        billingCode: `m5:${operation}`,
        model,
        inputTokens: nonnegativeInteger(usage.inputTokens),
        cachedInputTokens: nonnegativeInteger(usage.cachedInputTokens),
        outputTokens: nonnegativeInteger(usage.outputTokens),
        costCents: Math.ceil(Number(costCents || 0)),
        occurredAt
    });
    return {
        actionId,
        operation,
        provider: 'stepfun',
        model,
        promptMetadata: { characters: [...String(prompt || '')].length },
        promptChecksum: sha256(Buffer.from(String(prompt || ''))),
        seed,
        inputs,
        outputs,
        occurredAt,
        costEvent
    };
}
export async function reportCostMetric(ctx: any, record: any) {
    try {
        await ctx.metrics.write('external_cost_cents', record.costEvent.costCents, {
            provider: record.costEvent.provider,
            model: record.costEvent.model,
            operation: record.operation,
            projectId: record.costEvent.projectId || ''
        });
        return 'metric_written';
    }
    catch (error: any) {
        ctx.logger.warn('费用指标写入失败；保留 costEvent 草稿供控制面补记，禁止因此重放付费调用。', {
            operation: record.operation,
            model: record.model,
            error: String(error?.message || error)
        });
        return 'cost_event_pending';
    }
}
export function costForVision(usage: any, rates: any) {
    return (nonnegativeInteger(usage?.prompt_tokens) * Number(rates.visionInputPerMillionTokens || 0)
        + nonnegativeInteger(usage?.completion_tokens) * Number(rates.visionOutputPerMillionTokens || 0)) / 1000000;
}
export function costForImage(rates: any) {
    return Number(rates.imagePerGeneration || 0);
}
export function costForTts(text: any, rates: any) {
    return String(text || '').length * Number(rates.ttsPerThousandCharacters || 0) / 1000;
}
function nonnegativeInteger(value: any) {
    return Math.max(0, Math.trunc(Number(value || 0)));
}

import { createCostEventSchema } from '@paperclipai/shared';
import { sha256 } from './policy.js';

export function callRecord({
  run,
  actionId,
  model,
  operation,
  prompt,
  seed = null,
  inputs = [],
  outputs = [],
  usage = {},
  costCents
}) {
  const occurredAt = new Date().toISOString();
  const costEvent = createCostEventSchema.parse({
    agentId:run.agentId,
    projectId:run.projectId,
    heartbeatRunId:run.runId,
    provider:'stepfun',
    biller:'stepfun',
    billingType:'metered_api',
    billingCode:`m5:${operation}`,
    model,
    inputTokens:nonnegativeInteger(usage.inputTokens),
    cachedInputTokens:nonnegativeInteger(usage.cachedInputTokens),
    outputTokens:nonnegativeInteger(usage.outputTokens),
    costCents:Math.ceil(Number(costCents || 0)),
    occurredAt
  });
  return {
    actionId,
    operation,
    provider:'stepfun',
    model,
    promptMetadata:{ characters:[...String(prompt || '')].length },
    promptChecksum:sha256(Buffer.from(String(prompt || ''))),
    seed,
    inputs,
    outputs,
    occurredAt,
    costEvent
  };
}

export async function reportCostMetric(ctx, record) {
  try {
    await ctx.metrics.write('external_cost_cents', record.costEvent.costCents, {
      provider:record.costEvent.provider,
      model:record.costEvent.model,
      operation:record.operation,
      projectId:record.costEvent.projectId || ''
    });
    return 'metric_written';
  } catch (error) {
    ctx.logger.warn('费用指标写入失败；保留 costEvent 草稿供控制面补记，禁止因此重放付费调用。', {
      operation:record.operation,
      model:record.model,
      error:String(error?.message || error)
    });
    return 'cost_event_pending';
  }
}

export function costForVision(usage, rates) {
  return (
    nonnegativeInteger(usage?.prompt_tokens) * Number(rates.visionInputPerMillionTokens || 0)
    + nonnegativeInteger(usage?.completion_tokens) * Number(rates.visionOutputPerMillionTokens || 0)
  ) / 1_000_000;
}

export function costForImage(rates) {
  return Number(rates.imagePerGeneration || 0);
}

export function costForTts(text, rates) {
  return String(text || '').length * Number(rates.ttsPerThousandCharacters || 0) / 1000;
}

function nonnegativeInteger(value) {
  return Math.max(0, Math.trunc(Number(value || 0)));
}

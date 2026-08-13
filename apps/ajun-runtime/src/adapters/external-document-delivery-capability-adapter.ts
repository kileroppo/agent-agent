import type {
  CapabilityAdapter,
  CapabilityAdapterResult,
} from '../workflow/capability-adapter.ts';
import {
  externalCapabilityEvidence,
  runExternalCapabilityWithEvents,
} from './external-capability-run-event-bridge.ts';

export type ExternalWriteObservation = Readonly<{
  outcome: 'success' | 'confirmed_failure' | 'ambiguous';
  failureCode: string | null;
  fallbackAllowed: boolean;
  safeMessage: string;
}>;

/**
 * Wraps an existing delivery provider; it never creates another network client.
 * Unknown external-write outcomes stop here so a fallback cannot duplicate the
 * document or message.
 */
export function createExternalDocumentDeliveryCapabilityAdapter({
  adapterId,
  provider,
  deliver,
  onRunEvent,
  now = () => new Date(),
}: Readonly<{
  adapterId: string;
  provider: string;
  deliver(input: Readonly<{
    payload: unknown;
    idempotencyKey: string;
    attempt: number;
  }>): Promise<any>;
  onRunEvent?: (event: Readonly<Record<string, unknown>>) => void | Promise<void>;
  now?: () => Date;
}>): CapabilityAdapter {
  const normalizedAdapterId = clean(adapterId, 120);
  const normalizedProvider = clean(provider, 120);
  if (!normalizedAdapterId || !normalizedProvider || typeof deliver !== 'function') {
    throw new TypeError('外部文档交付适配器缺少已登记实现。');
  }
  return Object.freeze({
    adapterId:normalizedAdapterId,
    async invoke({ request, payload, attempt }): Promise<CapabilityAdapterResult> {
      if (request.sideEffect !== 'external-write') {
        throw Object.assign(new Error('文档交付必须声明外部写入。'), {
          code:'external_write_policy_required', retryable:false,
        });
      }
      return runExternalCapabilityWithEvents({
        onRunEvent,
        now,
        context:{
          taskId:request.taskId, workflowId:request.workflowId, stepId:request.stepId,
          agentId:request.agentId, capabilityId:request.capabilityId,
          routeId:normalizedAdapterId, provider:normalizedProvider,
        },
        execute:async (): Promise<CapabilityAdapterResult> => {
          let output;
          try {
            output = await deliver({ payload, idempotencyKey:request.requestId, attempt });
          } catch (error) {
            throw externalWriteError(error);
          }
          const observation = observeExternalWriteResult(output);
          if (observation.outcome !== 'success') throw externalWriteError(output);
          return Object.freeze({
            output:Object.freeze({ ...record(output), deliveryObservation:observation }),
            provider:normalizedProvider,
            usage:record(output).usage || null,
            costUsd:finiteCost(record(output).costUsd),
          });
        },
        evidence:(result) => externalCapabilityEvidence(result.output),
      });
    },
  });
}

export function observeExternalWriteResult(value: unknown): ExternalWriteObservation {
  const result = record(value);
  const error = value instanceof Error ? value as Error & Record<string, unknown> : null;
  const state = clean(
    result.deliveryState || result.state || error?.deliveryState,
    80,
  ).toLowerCase();
  const confirmed = result.confirmed === true
    || result.delivered === true
    || ['delivered', 'confirmed', 'succeeded', 'success'].includes(state);
  if (confirmed) return Object.freeze({
    outcome:'success', failureCode:null, fallbackAllowed:false,
    safeMessage:'外部交付已确认。',
  });
  const definitelyNotStarted = result.notStarted === true
    || ['not_started', 'rejected_before_send', 'confirmed_failure'].includes(state);
  if (definitelyNotStarted) return Object.freeze({
    outcome:'confirmed_failure',
    failureCode:clean(result.code || error?.code, 120) || 'external_write_confirmed_failure',
    fallbackAllowed:true,
    safeMessage:'外部交付确认未开始，可以按已批准策略选择备用路线。',
  });
  return Object.freeze({
    outcome:'ambiguous',
    failureCode:clean(result.code || error?.code, 120) || 'ambiguous_result',
    fallbackAllowed:false,
    safeMessage:'外部交付结果无法确认；已停止备用写入，避免重复发送或重复建文档。',
  });
}

function externalWriteError(value: unknown): Error {
  const observation = observeExternalWriteResult(value);
  const original = value instanceof Error ? value : new Error(observation.safeMessage);
  return Object.assign(original, {
    code:observation.failureCode,
    outcome:observation.outcome,
    failureKind:observation.outcome === 'ambiguous' ? 'ambiguous_result' : 'provider_unavailable',
    ambiguous:observation.outcome === 'ambiguous',
    fallbackAllowed:observation.fallbackAllowed,
    retryable:false,
    userMessage:observation.safeMessage,
  });
}

function finiteCost(value: unknown): number | null {
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' ? value as Record<string, any> : {};
}

function clean(value: unknown, limit: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

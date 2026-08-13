import type { CapabilityAdapter, CapabilityAdapterResult } from '../workflow/capability-execution.ts';
import {
  emitExternalCapabilityRunEvent,
  externalCapabilityEvidence,
  runExternalCapabilityWithEvents,
} from './external-capability-run-event-bridge.ts';

type LocalAiClient = Readonly<{
  invoke(input: Readonly<Record<string, unknown>>): Promise<any>;
  controlService(serviceId: string, action: string): Promise<any>;
}>;

export function createLocalAiCapabilityAdapter(client: LocalAiClient, {
  onRunEvent,
  now = () => new Date(),
}: Readonly<{
  onRunEvent?: (event: Readonly<Record<string, unknown>>) => void | Promise<void>;
  now?: () => Date;
}> = {}): CapabilityAdapter {
  return Object.freeze({
    adapterId:'local-ai-gateway',
    async invoke({ request, payload, options }): Promise<CapabilityAdapterResult> {
      const response = await runExternalCapabilityWithEvents({
        onRunEvent,
        now,
        context:context(request),
        execute:() => client.invoke({
          capability:request.capabilityId,
          input:payload,
          options:{ ...options, preferredNode:'mac', allowDesktopFallback:false },
          requestId:request.requestId,
          approved:false,
        }),
        evidence:externalCapabilityEvidence,
      });
      return Object.freeze({
        output:response?.result || null,
        provider:String(response?.provider || 'local'),
        model:String(response?.result?.model || '').trim() || null,
        usage:response?.result?.usage || null,
        costUsd:0,
      });
    },
    async recover({ request, errorCode }) {
      if (!['text.generate', 'vision.analyze', 'video.analyze'].includes(request.capabilityId)) return 'unavailable';
      const startedAt = now().toISOString();
      await emitExternalCapabilityRunEvent(onRunEvent, {
        ...context(request), eventType:'route_recovery_started', status:'recovering',
        startedAt, errorCode,
        safeSummary:'本机 AI 路线开始一次有界服务恢复。',
      });
      try {
        if (errorCode === 'local_ai_control_unavailable' || errorCode === 'local_ai_gateway_unavailable') {
          await client.controlService('gateway', 'start');
        }
        await client.controlService('qwen35', 'restart');
        await emitExternalCapabilityRunEvent(onRunEvent, {
          ...context(request), eventType:'route_recovery_succeeded', status:'recovered',
          startedAt, finishedAt:now().toISOString(),
          safeSummary:'本机 AI 服务恢复完成；执行引擎最多再调用一次当前路线。',
        });
        return 'recovered';
      } catch {
        await emitExternalCapabilityRunEvent(onRunEvent, {
          ...context(request), eventType:'capability_call_failed', status:'failed',
          startedAt, finishedAt:now().toISOString(), errorCode:'local_ai_recovery_unavailable',
          safeSummary:'本机 AI 服务恢复失败；没有登记跨设备备用 Provider，已停止。',
        });
        return 'unavailable';
      }
    },
  });
}

function context(request: any) {
  return {
    taskId:String(request?.taskId || ''), workflowId:String(request?.workflowId || ''),
    stepId:String(request?.stepId || ''), agentId:String(request?.agentId || ''),
    capabilityId:String(request?.capabilityId || ''), routeId:'local-ai-gateway', provider:'local-ai',
  };
}

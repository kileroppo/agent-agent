import type { CapabilityAdapter, CapabilityAdapterResult } from '../workflow/capability-execution.ts';

type LocalAiClient = Readonly<{
  invoke(input: Readonly<Record<string, unknown>>): Promise<any>;
  controlService(serviceId: string, action: string): Promise<any>;
}>;

export function createLocalAiCapabilityAdapter(client: LocalAiClient): CapabilityAdapter {
  return Object.freeze({
    adapterId:'local-ai-gateway',
    async invoke({ request, payload, options }): Promise<CapabilityAdapterResult> {
      const response = await client.invoke({
        capability:request.capabilityId,
        input:payload,
        options:{ ...options, preferredNode:'mac', allowDesktopFallback:false },
        requestId:request.requestId,
        approved:false,
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
      try {
        if (errorCode === 'local_ai_control_unavailable' || errorCode === 'local_ai_gateway_unavailable') {
          await client.controlService('gateway', 'start');
        }
        await client.controlService('qwen35', 'restart');
        return 'recovered';
      } catch {
        return 'unavailable';
      }
    },
  });
}

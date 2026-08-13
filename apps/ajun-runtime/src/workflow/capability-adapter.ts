import type { CapabilityRequest } from './capability-policy.ts';

export type CapabilityAdapterResult = Readonly<{
  output: unknown;
  provider: string;
  model?: string | null;
  usage?: unknown;
  costUsd?: number | null;
}>;

export type CapabilityAdapter = Readonly<{
  adapterId: string;
  invoke(input: Readonly<{
    request: CapabilityRequest;
    payload: unknown;
    options: Readonly<Record<string, unknown>>;
    attempt: number;
  }>): Promise<CapabilityAdapterResult>;
  recover?(input: Readonly<{
    request: CapabilityRequest;
    errorCode: string;
  }>): Promise<'recovered' | 'unavailable'>;
}>;

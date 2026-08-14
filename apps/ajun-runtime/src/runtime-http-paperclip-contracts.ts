import type { IncomingMessage } from 'node:http';

export type JsonRecord = Record<string, unknown>;
type AsyncHandler = Readonly<{ handle(input: JsonRecord): Promise<unknown> }>;
type CanonicalRun = Readonly<{
  runId: string;
  issueId: string;
  agentId: string;
  companyId: string;
}>;
type RunContextResolver = Readonly<{
  resolve(input: Readonly<{ heartbeat: JsonRecord; bearerToken: string }>): Promise<CanonicalRun>;
}>;
type CurrentRunScope = Readonly<{
  run(
    input: CanonicalRun & Readonly<{ apiKey: string; approvalId?: string }>,
    operation: () => Promise<unknown>,
  ): Promise<unknown>;
}>;
type PaperclipHttpServices = Readonly<{
  paperclipHeartbeat: AsyncHandler;
  paperclipCampaignDaily: AsyncHandler;
  paperclipParallelWork: AsyncHandler;
  paperclipMetricRunContext: RunContextResolver;
  paperclipMetricMonitor: AsyncHandler;
  paperclipCurrentRunScope: CurrentRunScope;
  paperclipPublisherRunContext: RunContextResolver;
  paperclipPublisherController: AsyncHandler;
  paperclipRetrospective: AsyncHandler;
  paperclipLearningLifecycle: AsyncHandler;
  canonicalPaperclipHeartbeat(heartbeat: JsonRecord, canonical: CanonicalRun): JsonRecord;
}>;

export type PaperclipHttpInput = Readonly<{
  request: Pick<IncomingMessage, 'method' | 'url' | 'headers'>;
  paperclip: PaperclipHttpServices;
  local: boolean;
  readBody(): Promise<JsonRecord>;
}>;

export type HttpRouteResult = Readonly<{ status: number; payload: unknown }> | null;

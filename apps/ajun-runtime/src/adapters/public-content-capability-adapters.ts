import type {
  CapabilityAdapter,
  CapabilityAdapterResult,
} from '../workflow/capability-adapter.ts';
import type { CapabilityRoute } from '../workflow/capability-routing.ts';
import {
  externalCapabilityEvidence,
  runExternalCapabilityWithEvents,
  type ExternalCapabilityEventContext,
} from './external-capability-run-event-bridge.ts';

type Instrumentation = Readonly<{
  onRunEvent?: (event: Readonly<Record<string, unknown>>) => void | Promise<void>;
  now?: () => Date;
}>;

type PublicWebSearchClient = Readonly<{
  search(input: Readonly<{ query: string; limit?: number }>): Promise<any>;
}>;

type PublicWebFetchClient = Readonly<{
  acquire(input: Readonly<{ sourceUrl: string }>): Promise<any>;
}>;

type PublicDynamicWebReaderClient = Readonly<{
  read(input: Readonly<{ sourceUrl: string }>): Promise<any>;
}>;

export type PublicContentQualityObservation = Readonly<{
  passed: boolean;
  evidenceEligible: boolean;
  kind: 'discovery' | 'public_content';
  reasonCodes: readonly string[];
  sourceRef: string | null;
  contentHash: string | null;
  fetchedAt: string | null;
}>;

/**
 * Search results discover candidate URLs only. They never become evidence until
 * a public reader has fetched and validated the source body.
 */
export function assessPublicSearchDiscovery(output: unknown): PublicContentQualityObservation {
  const result = record(output);
  const results = Array.isArray(result.results) ? result.results : [];
  const validCandidates = results.filter((item) => {
    const candidate = record(item);
    return publicHttpUrl(candidate.url) && clean(candidate.title, 500);
  });
  const reasonCodes = validCandidates.length ? [] : ['search_candidates_missing'];
  return Object.freeze({
    passed:validCandidates.length > 0,
    evidenceEligible:false,
    kind:'discovery',
    reasonCodes:Object.freeze(reasonCodes),
    sourceRef:null,
    contentHash:null,
    fetchedAt:null,
  });
}

/** A source counts as evidence only after its body was really read. */
export function assessPublicContentEvidence(output: unknown): PublicContentQualityObservation {
  const result = record(output);
  const validation = record(result.validation);
  const sourceRef = publicHttpUrl(result.sourceRef);
  const text = clean(result.text, 60_000);
  const contentHash = sha256(result.contentHash);
  const fetchedAt = timestamp(result.fetchedAt);
  const reasonCodes = [
    ...(!sourceRef ? ['source_ref_invalid'] : []),
    ...(!text ? ['source_body_unread'] : []),
    ...(!contentHash ? ['content_hash_missing'] : []),
    ...(!fetchedAt ? ['fetched_at_missing'] : []),
    ...(validation.exists !== true ? ['source_not_confirmed'] : []),
    ...(validation.readable !== true ? ['source_not_readable'] : []),
    ...(validation.accessScope !== 'public_read' ? ['public_read_scope_missing'] : []),
  ];
  return Object.freeze({
    passed:reasonCodes.length === 0,
    evidenceEligible:reasonCodes.length === 0,
    kind:'public_content',
    reasonCodes:Object.freeze(reasonCodes),
    sourceRef,
    contentHash,
    fetchedAt,
  });
}

export function createPublicWebSearchCapabilityAdapter(
  client: PublicWebSearchClient,
  instrumentation: Instrumentation = {},
): CapabilityAdapter {
  requireMethod(client, 'search', '公开搜索');
  return Object.freeze({
    adapterId:'public-web-search',
    async invoke({ request, payload }): Promise<CapabilityAdapterResult> {
      const input = record(payload);
      return runExternalCapabilityWithEvents({
        ...instrumentation,
        context:eventContext(request, 'public-web-search', 'public-search'),
        execute:async () => {
          const output = await client.search({
            query:clean(input.query, 1_000),
            limit:boundedInteger(input.limit, 1, 5, 3),
          });
          const quality = assessPublicSearchDiscovery(output);
          if (!quality.passed) throw qualityError(quality);
          return Object.freeze({
            output:Object.freeze({ ...record(output), quality }),
            provider:clean(record(output).provider, 120) || 'public-search',
            usage:null,
            costUsd:0,
          });
        },
        evidence:(result) => externalCapabilityEvidence(result.output),
      });
    },
  });
}

export function createPublicWebFetchCapabilityAdapter(
  client: PublicWebFetchClient,
  instrumentation: Instrumentation = {},
): CapabilityAdapter {
  requireMethod(client, 'acquire', '公开静态网页读取');
  return Object.freeze({
    adapterId:'public-web-static-reader',
    async invoke({ request, payload }): Promise<CapabilityAdapterResult> {
      return runExternalCapabilityWithEvents({
        ...instrumentation,
        context:eventContext(request, 'public-web-static', 'public-web-static'),
        execute:async () => publicContentResult(
          await client.acquire({ sourceUrl:sourceUrl(payload) }),
          'public-web-static',
        ),
        evidence:(result) => externalCapabilityEvidence(result.output),
        hasRegisteredFallback:true,
      });
    },
  });
}

export function createPublicDynamicWebReaderCapabilityAdapter(
  client: PublicDynamicWebReaderClient,
  instrumentation: Instrumentation = {},
): CapabilityAdapter {
  requireMethod(client, 'read', '公开动态网页读取');
  return Object.freeze({
    adapterId:'public-web-controlled-browser',
    async invoke({ request, payload }): Promise<CapabilityAdapterResult> {
      return runExternalCapabilityWithEvents({
        ...instrumentation,
        context:eventContext(request, 'public-web-controlled-browser', 'controlled-chromium'),
        execute:async () => publicContentResult(
          await client.read({ sourceUrl:sourceUrl(payload) }),
          'controlled-chromium',
        ),
        evidence:(result) => externalCapabilityEvidence(result.output),
      });
    },
  });
}

/** Static read is primary; the existing isolated Chromium reader is Plan B. */
export function createPublicWebReadRoutes({
  publicWebFetch,
  publicDynamicWebReader,
  instrumentation,
}: Readonly<{
  publicWebFetch: PublicWebFetchClient;
  publicDynamicWebReader: PublicDynamicWebReaderClient;
  instrumentation?: Instrumentation;
}>): readonly CapabilityRoute[] {
  return Object.freeze([
    Object.freeze({
      routeId:'public-web-static',
      adapter:createPublicWebFetchCapabilityAdapter(publicWebFetch, instrumentation),
      maxCostUsd:0,
      dataClass:'public',
      sideEffect:'read',
    }),
    Object.freeze({
      routeId:'public-web-controlled-browser',
      adapter:createPublicDynamicWebReaderCapabilityAdapter(publicDynamicWebReader, instrumentation),
      maxCostUsd:0,
      dataClass:'public',
      sideEffect:'read',
    }),
  ]);
}

function eventContext(request: any, routeId: string, provider: string): ExternalCapabilityEventContext {
  return {
    taskId:String(request?.taskId || ''),
    workflowId:String(request?.workflowId || ''),
    stepId:String(request?.stepId || ''),
    agentId:String(request?.agentId || ''),
    capabilityId:String(request?.capabilityId || ''),
    routeId,
    provider,
  };
}

function publicContentResult(output: unknown, provider: string): CapabilityAdapterResult {
  const quality = assessPublicContentEvidence(output);
  if (!quality.passed) throw qualityError(quality);
  return Object.freeze({
    output:Object.freeze({ ...record(output), quality }),
    provider,
    usage:null,
    costUsd:0,
  });
}

function qualityError(quality: PublicContentQualityObservation): Error {
  return Object.assign(new Error('公开来源没有通过正文证据质量门。'), {
    code:'quality_failed',
    category:'quality',
    retryable:false,
    quality,
  });
}

function sourceUrl(payload: unknown): string {
  const input = record(payload);
  const value = clean(input.sourceUrl || input.url, 4_000);
  if (!publicHttpUrl(value)) throw codedError('invalid_source_url', '需要一个公开 HTTP(S) 链接。');
  return value;
}

function publicHttpUrl(value: unknown): string | null {
  try {
    const parsed = new URL(String(value || ''));
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

function sha256(value: unknown): string | null {
  const normalized = clean(value, 80).toLowerCase();
  const digest = normalized.startsWith('sha256:') ? normalized.slice(7) : normalized;
  return /^[a-f0-9]{64}$/.test(digest) ? `sha256:${digest}` : null;
}

function timestamp(value: unknown): string | null {
  const normalized = clean(value, 120);
  return normalized && Number.isFinite(Date.parse(normalized)) ? normalized : null;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const number = Number(value);
  return Number.isInteger(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

function requireMethod(value: unknown, method: string, label: string): void {
  if (typeof record(value)[method] !== 'function') throw new TypeError(`${label}缺少可调用实现。`);
}

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, retryable:false });
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' ? value as Record<string, any> : {};
}

function clean(value: unknown, limit: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

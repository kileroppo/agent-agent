import { validatePublicHttpUrl } from './domain.ts';

export class MetricsRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly recommendedAction: string;

  constructor(
    message: string,
    { status = 500, code = 'metrics_unavailable', recommendedAction = 'retry' }: Readonly<{
      status?: number;
      code?: string;
      recommendedAction?: string;
    }> = {},
  ) {
    super(message);
    this.name = 'MetricsRequestError';
    this.status = status;
    this.code = code;
    this.recommendedAction = recommendedAction;
  }
}

type MetricsInput = Readonly<{
  url?: unknown;
  connectionId?: unknown;
  historyLimit?: unknown;
}>;
type MetricsCollectionResult = Readonly<{
  ok: boolean;
  metricsBundle?: unknown;
  category?: string;
  code?: string;
  safeMessage?: string;
  recommendedAction?: string;
}>;
type ContentRuntime = Readonly<{
  resolveConnectionBindingForSource(
    source: string,
    connectionId: string | null,
  ): Promise<Readonly<{ connectionId?: string }> | null>;
  contentCenter: Readonly<{
    collectMetrics(input: Readonly<{
      source: string;
      connectionId: string | null;
      requestingAgentId: 'xiaod';
      historyLimit: number;
    }>): Promise<MetricsCollectionResult>;
  }>;
}>;

export async function collectMetricsRequest({
  contentRuntime,
  input = {},
}: Readonly<{ contentRuntime: ContentRuntime; input?: MetricsInput }>): Promise<unknown> {
  const valid = validatePublicHttpUrl(input.url || '');
  if (!valid.ok) throw new MetricsRequestError(valid.reason, { status:422, code:'invalid_source_url', recommendedAction:'fix_input' });
  const requestedConnectionId = input.connectionId ?? null;
  if (requestedConnectionId !== null && (typeof requestedConnectionId !== 'string' || !requestedConnectionId.trim())) {
    throw new MetricsRequestError('连接标识格式不正确。', { status:422, code:'invalid_connection_id', recommendedAction:'fix_input' });
  }
  const historyLimit = Math.max(5, Math.min(Number(input.historyLimit) || 20, 20));
  const binding = await contentRuntime.resolveConnectionBindingForSource(valid.url, requestedConnectionId);
  const result = await contentRuntime.contentCenter.collectMetrics({
    source:valid.url,
    connectionId:binding?.connectionId || null,
    requestingAgentId:'xiaod',
    historyLimit
  });
  if (!result.ok) {
    const needsInput = result.category === 'needs_input' || String(result.code || '').startsWith('connection_');
    throw new MetricsRequestError(result.safeMessage || '作品指标暂时不可用。', {
      status:needsInput ? 409 : result.recommendedAction === 'retry' ? 503 : 422,
      code:String(result.code || 'metrics_unavailable'),
      recommendedAction:String(result.recommendedAction || 'retry'),
    });
  }
  return result.metricsBundle;
}

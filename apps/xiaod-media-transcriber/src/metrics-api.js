import { validatePublicHttpUrl } from './domain.js';

export class MetricsRequestError extends Error {
  constructor(message, { status = 500, code = 'metrics_unavailable', recommendedAction = 'retry' } = {}) {
    super(message);
    this.name = 'MetricsRequestError';
    this.status = status;
    this.code = code;
    this.recommendedAction = recommendedAction;
  }
}

export async function collectMetricsRequest({ contentRuntime, input = {} }) {
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
      code:result.code,
      recommendedAction:result.recommendedAction
    });
  }
  return result.metricsBundle;
}

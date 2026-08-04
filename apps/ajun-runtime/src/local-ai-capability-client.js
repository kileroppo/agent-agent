const CAPABILITIES = new Set([
  'text.generate',
  'vision.analyze',
  'video.analyze',
  'audio.transcribe',
  'audio.synthesize',
  'image.generate',
  'image.edit',
  'embedding.create',
  'rerank.score',
  'knowledge.index',
  'knowledge.search',
  'audio.clone_authorized',
  'video.generate',
]);

export class LocalAiCapabilityClient {
  constructor({ baseUrl = process.env.LOCAL_AI_GATEWAY_URL || 'http://127.0.0.1:18082', fetchImpl = fetch } = {}) {
    this.baseUrl = normalizeLoopbackUrl(baseUrl);
    this.fetchImpl = fetchImpl;
  }

  async health() {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/health`, { signal:AbortSignal.timeout(3_000) });
      if (!response.ok) return unavailable();
      const body = await response.json();
      const capabilities = (Array.isArray(body?.capabilities) ? body.capabilities : []).map((item) => ({
        capability:String(item?.capability || '').slice(0, 80),
        configured:item?.configured === true,
        healthy:item?.healthy === true,
        e2eVerified:item?.e2eVerified === true,
        provider:String(item?.provider || '').slice(0, 80),
      })).filter((item) => CAPABILITIES.has(item.capability));
      const ready = capabilities.filter((item) => item.healthy && item.e2eVerified);
      return {
        status:body?.status === 'healthy' ? 'healthy' : 'degraded',
        node:String(body?.node || 'local').slice(0, 80),
        readyCount:ready.length,
        capabilities,
        desktopEnhancement:{
          configured:body?.desktopEnhancement?.configured === true,
          healthy:body?.desktopEnhancement?.healthy === true,
        },
        safeMessage:body?.status === 'healthy'
          ? `本机 AI 网关健康，${ready.length} 项能力已通过端到端验收。`
          : '本机 AI 网关可访问，但部分核心能力当前不可用。',
      };
    } catch {
      return unavailable();
    }
  }

  async invoke({ capability, input = {}, options = {}, requestId, approved = false } = {}) {
    if (!CAPABILITIES.has(capability)) throw clientError('local_ai_capability_not_allowed', '未登记的本机 AI 能力。');
    const response = await this.fetchImpl(`${this.baseUrl}/v1/invoke`, {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ capability, input, options, request_id:requestId, approved }),
      signal:AbortSignal.timeout(Math.max(1_000, Math.min(Number(options?.timeoutSeconds || 300) * 1_000, 3_600_000))),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = String(body?.detail?.code || 'local_ai_failed').slice(0, 80);
      throw clientError(code, String(body?.detail?.message || '本机 AI 能力调用失败。').slice(0, 500));
    }
    return body;
  }
}

function unavailable() {
  return {
    status:'unavailable',
    node:'m1-max-primary',
    readyCount:0,
    capabilities:[],
    desktopEnhancement:{ configured:false, healthy:false },
    safeMessage:'本机 AI 网关未就绪。',
  };
}

function normalizeLoopbackUrl(value) {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)
    || !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)
    || parsed.username
    || parsed.password) {
    throw clientError('local_ai_gateway_not_loopback', '本机 AI 客户端只允许连接回环网关。');
  }
  return parsed.origin;
}

function clientError(code, message) {
  return Object.assign(new Error(message), { code, category:'manual', retryable:false });
}

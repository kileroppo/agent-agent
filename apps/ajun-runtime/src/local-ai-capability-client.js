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
const SERVICE_IDS = new Set(['gateway', 'qwen35', 'qwen36-candidate', 'embedding', 'reranker', 'speech-tools', 'mflux', 'desktop-node', 'comfyui']);
const SERVICE_ACTIONS = new Set(['start', 'stop', 'restart', 'reconnect']);
const SERVICE_MODES = new Set(['on_demand', 'always_on', 'disabled', 'per_request']);

export class LocalAiCapabilityClient {
  constructor({
    baseUrl = process.env.LOCAL_AI_GATEWAY_URL || 'http://127.0.0.1:18082',
    fetchImpl = fetch,
    gatewayControl = controlGatewayLaunchAgent,
  } = {}) {
    this.baseUrl = normalizeLoopbackUrl(baseUrl);
    this.fetchImpl = fetchImpl;
    this.gatewayControl = gatewayControl;
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
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/invoke`, {
        method:'POST',
        headers:{ 'content-type':'application/json' },
        body:JSON.stringify({ capability, input, options, request_id:requestId, approved }),
        signal:AbortSignal.timeout(Math.max(1_000, Math.min(Number(options?.timeoutSeconds || 300) * 1_000, 3_600_000))),
      });
    } catch (error) {
      throw clientError('local_ai_gateway_unavailable', error?.message || '本机 AI 网关不可用。', 503, true);
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = String(body?.detail?.code || 'local_ai_failed').slice(0, 80);
      throw clientError(code, String(body?.detail?.message || '本机 AI 能力调用失败。').slice(0, 500), response.status);
    }
    return body;
  }

  async controlOverview() {
    let body;
    try {
      body = await this.#request('/v1/control', { signal:AbortSignal.timeout(20_000) });
    } catch {
      return unavailableControl();
    }
    return {
      status:body?.status === 'ready' ? 'ready' : 'degraded',
      services:(Array.isArray(body?.services) ? body.services : []).map(sanitizeService).filter(Boolean),
      routing:(Array.isArray(body?.routing) ? body.routing : []).map((route) => ({
        capability:String(route?.capability || '').slice(0, 100),
        providers:(Array.isArray(route?.providers) ? route.providers : []).map((item) => String(item).slice(0, 120)).slice(0, 5),
      })).filter((route) => route.capability),
    };
  }

  async controlService(serviceId, action) {
    if (!SERVICE_IDS.has(serviceId) || !SERVICE_ACTIONS.has(action)) throw clientError('local_ai_service_action_not_allowed', '未登记的服务控制动作。');
    if (serviceId === 'gateway') {
      if (!['start', 'stop', 'restart'].includes(action)) throw clientError('local_ai_service_action_not_allowed', '控制网关不支持该动作。');
      await this.gatewayControl(action);
      if (action === 'stop') {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return this.controlOverview();
      }
      let snapshot = unavailableControl();
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        snapshot = await this.controlOverview();
        if (snapshot.services.some((service) => service.id === 'gateway' && service.state === 'running')) return snapshot;
      }
      return snapshot;
    }
    await this.#request(`/v1/control/services/${encodeURIComponent(serviceId)}/${encodeURIComponent(action)}`, {
      method:'POST',
      signal:AbortSignal.timeout(action === 'start' || action === 'restart' ? 180_000 : 30_000),
    });
    return this.controlOverview();
  }

  async updateServicePolicy(serviceId, { mode, idleSeconds = 900 } = {}) {
    if (!SERVICE_IDS.has(serviceId) || !['on_demand', 'always_on', 'disabled'].includes(mode)) throw clientError('local_ai_service_policy_not_allowed', '未登记的服务策略。');
    await this.#request(`/v1/control/services/${encodeURIComponent(serviceId)}/policy`, {
      method:'PUT',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ mode, idle_seconds:Math.max(60, Math.min(Number(idleSeconds) || 900, 86400)) }),
      signal:AbortSignal.timeout(180_000),
    });
    return this.controlOverview();
  }

  async #request(path, options = {}) {
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, options);
    } catch (error) {
      throw clientError('local_ai_control_unavailable', error?.message || '本机 AI 控制网关不可用。', 503);
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw clientError(
        String(body?.detail?.code || 'local_ai_control_failed').slice(0, 80),
        String(body?.detail?.message || '本机 AI 服务控制失败。').slice(0, 500),
        response.status,
      );
    }
    return body;
  }
}

function sanitizeService(item) {
  const id = String(item?.id || '');
  if (!SERVICE_IDS.has(id)) return null;
  const mode = String(item?.mode || 'on_demand');
  return {
    id,
    name:String(item?.name || id).slice(0, 100),
    node:item?.node === 'windows' ? 'windows' : 'mac',
    endpoint:String(item?.endpoint || '').slice(0, 120),
    mode:SERVICE_MODES.has(mode) ? mode : 'on_demand',
    state:['running', 'stopped', 'ready', 'offline', 'unknown'].includes(item?.state) ? item.state : 'unknown',
    actions:id === 'gateway'
      ? ['start', 'stop', 'restart']
      : (Array.isArray(item?.actions) ? item.actions : []).filter((action) => SERVICE_ACTIONS.has(action)),
    detail:String(item?.detail || '').slice(0, 300),
    idleSeconds:Number.isFinite(item?.idleSeconds) ? item.idleSeconds : null,
    managed:item?.managed === true ? true : item?.managed === false ? false : null,
  };
}

function unavailableControl() {
  return {
    status:'degraded',
    services:[{
      id:'gateway',
      name:'Mac AI 控制网关',
      node:'mac',
      endpoint:'127.0.0.1:18082',
      mode:'always_on',
      state:'stopped',
      actions:['start', 'restart'],
      detail:'轻量控制网关已停止；A君仍可重新启动。',
      idleSeconds:null,
      managed:null,
    }],
    routing:[],
  };
}

async function controlGatewayLaunchAgent(action) {
  const target = `gui/${process.getuid()}/com.agent-army.local-ai.gateway`;
  const args = action === 'start'
    ? ['kickstart', target]
    : action === 'restart'
      ? ['kickstart', '-k', target]
      : ['kill', 'SIGTERM', target];
  try {
    await execFileAsync('/bin/launchctl', args, { timeout:20_000, windowsHide:true });
  } catch (error) {
    throw clientError('local_ai_gateway_control_failed', String(error?.stderr || error?.message || '控制网关操作失败。').slice(-500), 503);
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

function clientError(code, message, httpStatus = 422, retryable = false) {
  const normalizedStatus = Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus <= 599 ? httpStatus : 422;
  return Object.assign(new Error(message), { code, category:retryable ? 'retryable' : 'manual', retryable, httpStatus:normalizedStatus });
}
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

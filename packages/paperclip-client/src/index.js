const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export class PaperclipHttpError extends Error {
  constructor({ method, path, status, detail = '' }) {
    super(`Paperclip ${method} ${path} 失败: HTTP ${status}${detail ? `（${detail}）` : ''}`);
    this.name = 'PaperclipHttpError';
    this.code = 'paperclip_http_error';
    this.status = status;
    this.method = method;
    this.path = path;
  }
}

export function normalizePaperclipBaseUrl(baseUrl, { allowRemote = false } = {}) {
  const url = new URL(baseUrl);
  if (!allowRemote && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error('默认只允许连接 loopback Paperclip；远程实例需显式 allowRemote');
  }
  return url.origin;
}

export class PaperclipHttpTransport {
  constructor({ baseUrl, apiKey = '', allowRemote = false, fetchImpl = fetch, timeoutMs = 2500 }) {
    this.baseUrl = normalizePaperclipBaseUrl(baseUrl, { allowRemote });
    this.apiKey = String(apiKey || '').trim();
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(method, path, { body, apiKey, runId, headers = {} } = {}) {
    const normalizedMethod = String(method || 'GET').toUpperCase();
    const credential = String(apiKey || this.apiKey || '').trim();
    const requestHeaders = {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(credential ? { authorization: `Bearer ${credential}` } : {}),
      ...(runId ? { 'x-paperclip-run-id': String(runId) } : {}),
      ...headers,
    };
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: normalizedMethod,
      headers: requestHeaders,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(this.timeoutMs > 0 ? { signal: AbortSignal.timeout(this.timeoutMs) } : {}),
    });
    let payload = null;
    if (typeof response.text === 'function') {
      const text = await response.text();
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = text || null;
      }
    } else if (typeof response.json === 'function') {
      payload = await response.json().catch(() => ({}));
    }
    if (!response.ok) {
      const detail = String(payload?.error || payload?.message || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300);
      throw new PaperclipHttpError({ method: normalizedMethod, path, status: response.status, detail });
    }
    return payload;
  }
}

/**
 * M5-facing Paperclip endpoint client.
 *
 * The endpoint is intentionally compatible with the existing Paperclip
 * adapters: `request(method, path, body)`. Domain services use these semantic
 * methods and no longer own URL construction.
 */
export class PaperclipM5Client {
  constructor({ endpoint } = {}) {
    this.endpoint = endpoint;
  }

  listPipelineCases(pipelineId) {
    return this.request('GET', `/api/pipelines/${pathId(pipelineId)}/cases`);
  }

  getPipeline(pipelineId) {
    return this.request('GET', `/api/pipelines/${pathId(pipelineId)}`);
  }

  getCase(caseId) {
    return this.request('GET', `/api/cases/${pathId(caseId)}`);
  }

  updateCase(caseId, patch) {
    return this.request('PATCH', `/api/cases/${pathId(caseId)}`, patch);
  }

  getCaseChildrenTree(caseId) {
    return this.request('GET', `/api/cases/${pathId(caseId)}/children/tree`);
  }

  listCaseEvents(caseId, { limit = 100, order = 'desc' } = {}) {
    const query = queryString({ limit, order });
    return this.request('GET', `/api/cases/${pathId(caseId)}/events?${query}`);
  }

  listCaseOutputs(caseId) {
    return this.request('GET', `/api/cases/${pathId(caseId)}/outputs`);
  }

  listIssueRuns(issueId) {
    return this.request('GET', `/api/issues/${pathId(issueId)}/runs`);
  }

  listPlugins() {
    return this.request('GET', '/api/plugins');
  }

  getPluginConfig(pluginId, companyId) {
    const query = queryString({ companyId });
    return this.request('GET', `/api/plugins/${pathId(pluginId)}/config?${query}`);
  }

  executePluginAction(pluginKey, actionKey, body) {
    return this.request(
      'POST',
      `/api/plugins/${pathId(pluginKey)}/actions/${pathId(actionKey)}`,
      body,
    );
  }

  listCompanyActivity(companyId, { entityType, entityId, limit = 500 } = {}) {
    const query = queryString({ entityType, entityId, limit });
    return this.request('GET', `/api/companies/${pathId(companyId)}/activity?${query}`);
  }

  getCompanyBudgetOverview(companyId) {
    return this.request('GET', `/api/companies/${pathId(companyId)}/budgets/overview`);
  }

  listCompanyRoutines(companyId) {
    return this.request('GET', `/api/companies/${pathId(companyId)}/routines`);
  }

  listCompanyAgents(companyId) {
    return this.request('GET', `/api/companies/${pathId(companyId)}/agents`);
  }

  getRoutine(routineId) {
    return this.request('GET', `/api/routines/${pathId(routineId)}`);
  }

  updateRoutineTrigger(triggerId, patch) {
    return this.request('PATCH', `/api/routine-triggers/${pathId(triggerId)}`, patch);
  }

  request(method, path, body) {
    if (!this.endpoint || typeof this.endpoint.request !== 'function') {
      throw new TypeError('PaperclipM5Client 需要可调用 request 的 endpoint');
    }
    return this.endpoint.request(method, path, body);
  }
}

function pathId(value) {
  return encodeURIComponent(String(value));
}

function queryString(values) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }
  return query.toString();
}

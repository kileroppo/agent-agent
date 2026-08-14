const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
type DynamicRecord = Record<string, any>;
type PaperclipEndpoint = Readonly<{
  request(method: string, path: string, body?: unknown): Promise<any>;
}>;
type FetchImplementation = (input: string, init?: DynamicRecord) => Promise<any>;

export class PaperclipHttpError extends Error {
  readonly code = 'paperclip_http_error';
  readonly status: number;
  readonly method: string;
  readonly path: string;

  constructor({ method, path, status, detail = '' }: Readonly<{
    method: string;
    path: string;
    status: number;
    detail?: string;
  }>) {
    super(`Paperclip ${method} ${path} 失败: HTTP ${status}${detail ? `（${detail}）` : ''}`);
    this.name = 'PaperclipHttpError';
    this.status = status;
    this.method = method;
    this.path = path;
  }
}

export function normalizePaperclipBaseUrl(
  baseUrl: string,
  { allowRemote = false }: Readonly<{ allowRemote?: boolean }> = {},
): string {
  const url = new URL(baseUrl);
  if (!allowRemote && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error('默认只允许连接 loopback Paperclip；远程实例需显式 allowRemote');
  }
  return url.origin;
}

export class PaperclipHttpTransport {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetchImpl: FetchImplementation;
  readonly timeoutMs: number;

  constructor({ baseUrl, apiKey = '', allowRemote = false, fetchImpl = fetch, timeoutMs = 2500 }: Readonly<{
    baseUrl: string;
    apiKey?: string;
    allowRemote?: boolean;
    fetchImpl?: FetchImplementation;
    timeoutMs?: number;
  }>) {
    this.baseUrl = normalizePaperclipBaseUrl(baseUrl, { allowRemote });
    this.apiKey = String(apiKey || '').trim();
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(method: unknown, path: string, {
    body,
    apiKey,
    runId,
    headers = {},
  }: Readonly<{
    body?: unknown;
    apiKey?: unknown;
    runId?: unknown;
    headers?: Record<string, string>;
  }> = {}): Promise<any> {
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
  readonly endpoint: PaperclipEndpoint | undefined;

  constructor({ endpoint }: Readonly<{ endpoint?: PaperclipEndpoint }> = {}) {
    this.endpoint = endpoint;
  }

  listPipelineCases(pipelineId: unknown) {
    return this.request('GET', `/api/pipelines/${pathId(pipelineId)}/cases`);
  }

  getPipeline(pipelineId: unknown) {
    return this.request('GET', `/api/pipelines/${pathId(pipelineId)}`);
  }

  getCase(caseId: unknown) {
    return this.request('GET', `/api/cases/${pathId(caseId)}`);
  }

  updateCase(caseId: unknown, patch: unknown) {
    return this.request('PATCH', `/api/cases/${pathId(caseId)}`, patch);
  }

  getCaseChildrenTree(caseId: unknown) {
    return this.request('GET', `/api/cases/${pathId(caseId)}/children/tree`);
  }

  listCaseEvents(caseId: unknown, { limit = 100, order = 'desc' }: DynamicRecord = {}) {
    const query = queryString({ limit, order });
    return this.request('GET', `/api/cases/${pathId(caseId)}/events?${query}`);
  }

  listCaseOutputs(caseId: unknown) {
    return this.request('GET', `/api/cases/${pathId(caseId)}/outputs`);
  }

  listIssueRuns(issueId: unknown) {
    return this.request('GET', `/api/issues/${pathId(issueId)}/runs`);
  }

  listPlugins() {
    return this.request('GET', '/api/plugins');
  }

  getPluginConfig(pluginId: unknown, companyId: unknown) {
    const query = queryString({ companyId });
    return this.request('GET', `/api/plugins/${pathId(pluginId)}/config?${query}`);
  }

  executePluginAction(pluginKey: unknown, actionKey: unknown, body: unknown) {
    return this.request(
      'POST',
      `/api/plugins/${pathId(pluginKey)}/actions/${pathId(actionKey)}`,
      body,
    );
  }

  listCompanyActivity(companyId: unknown, { entityType, entityId, limit = 500 }: DynamicRecord = {}) {
    const query = queryString({ entityType, entityId, limit });
    return this.request('GET', `/api/companies/${pathId(companyId)}/activity?${query}`);
  }

  getCompanyBudgetOverview(companyId: unknown) {
    return this.request('GET', `/api/companies/${pathId(companyId)}/budgets/overview`);
  }

  listCompanyRoutines(companyId: unknown) {
    return this.request('GET', `/api/companies/${pathId(companyId)}/routines`);
  }

  listCompanyAgents(companyId: unknown) {
    return this.request('GET', `/api/companies/${pathId(companyId)}/agents`);
  }

  getRoutine(routineId: unknown) {
    return this.request('GET', `/api/routines/${pathId(routineId)}`);
  }

  updateRoutineTrigger(triggerId: unknown, patch: unknown) {
    return this.request('PATCH', `/api/routine-triggers/${pathId(triggerId)}`, patch);
  }

  request(method: string, path: string, body?: unknown): Promise<any> {
    if (!this.endpoint || typeof this.endpoint.request !== 'function') {
      throw new TypeError('PaperclipM5Client 需要可调用 request 的 endpoint');
    }
    return this.endpoint.request(method, path, body);
  }
}

export class PaperclipOrganizationClient {
  readonly endpoint: PaperclipEndpoint | undefined;

  constructor({ endpoint }: Readonly<{ endpoint?: PaperclipEndpoint }> = {}) {
    this.endpoint = endpoint;
  }

  health() { return this.request('GET', '/api/health'); }
  listCompanies() { return this.request('GET', '/api/companies'); }
  listAgents(companyId: unknown) {
    return this.request('GET', `/api/companies/${pathId(companyId)}/agents`);
  }
  createIssue(companyId: unknown, body: unknown) {
    return this.request('POST', `/api/companies/${pathId(companyId)}/issues`, body);
  }
  createChildIssue(parentIssueId: unknown, body: unknown) {
    return this.request('POST', `/api/issues/${pathId(parentIssueId)}/children`, body);
  }
  createApproval(companyId: unknown, body: unknown) {
    return this.request('POST', `/api/companies/${pathId(companyId)}/approvals`, body);
  }

  request(method: string, path: string, body?: unknown): Promise<any> {
    if (!this.endpoint || typeof this.endpoint.request !== 'function') {
      throw new TypeError('PaperclipOrganizationClient 需要可调用 request 的 endpoint');
    }
    return this.endpoint.request(method, path, { body });
  }
}

function pathId(value: unknown): string {
  return encodeURIComponent(String(value));
}

function queryString(values: DynamicRecord): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }
  return query.toString();
}

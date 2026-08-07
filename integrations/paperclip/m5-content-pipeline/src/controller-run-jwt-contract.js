import crypto from 'node:crypto';

export const PAPERCLIP_CONTROLLER_CUTOVER_VERSION = '2026.722.0';
export const PAPERCLIP_CONTROLLER_API_BASE = 'http://127.0.0.1:3100';
export const CONTROLLER_RUN_JWT_APPLY_CONFIRMATION =
  'I_ACCEPT_M5_CONTROLLER_RUN_JWT_APPLY';
export const CONTROLLER_RUN_JWT_ROLLBACK_CONFIRMATION =
  'I_ACCEPT_M5_CONTROLLER_RUN_JWT_ROLLBACK';
export const CONTROLLER_RUN_JWT_SNAPSHOT_SCHEMA =
  'agent.army/m5-controller-run-jwt-snapshot/v1';

export const M5_RUN_JWT_CONTROLLERS = Object.freeze([
  Object.freeze({
    key:'metrics',
    id:'0684369d-9f97-49e9-921c-3c692f441e49',
    adapterType:'http',
    url:'http://127.0.0.1:4321/api/paperclip/m5-metrics-heartbeat',
  }),
  Object.freeze({
    key:'publisher',
    id:'18dd4452-705f-49a1-8aa8-4070429dc33d',
    adapterType:'http',
    url:'http://127.0.0.1:4321/api/paperclip/m5-publisher-heartbeat',
  }),
]);

export class M5ControllerRunJwtCutoverError extends Error {
  constructor(message, { recoveryRequired = false, rollbackErrors = [] } = {}) {
    super(message);
    this.name = 'M5ControllerRunJwtCutoverError';
    this.recoveryRequired = recoveryRequired;
    this.rollbackErrors = rollbackErrors;
  }
}

export class PaperclipControllerClient {
  constructor({
    apiBase = PAPERCLIP_CONTROLLER_API_BASE,
    fetchImpl = fetch,
  } = {}) {
    if (canonicalOrigin(apiBase) !== PAPERCLIP_CONTROLLER_API_BASE) {
      throw cutoverError(
        `控制器部署只允许 ${PAPERCLIP_CONTROLLER_API_BASE}。`,
      );
    }
    this.apiBase = PAPERCLIP_CONTROLLER_API_BASE;
    this.fetchImpl = fetchImpl;
  }

  async getVersion() {
    const health = await this.#request('GET', '/api/health');
    return String(health?.version || health?.serverVersion || '');
  }

  async getController(id) {
    return this.#request('GET', `/api/agents/${id}`);
  }

  async updateController(id, adapterConfig) {
    return this.#request('PATCH', `/api/agents/${id}`, { adapterConfig });
  }

  async #request(method, pathname, body) {
    const response = await this.fetchImpl(`${this.apiBase}${pathname}`, {
      method,
      headers:{
        accept:'application/json',
        ...(body === undefined ? {} : { 'content-type':'application/json' }),
      },
      ...(body === undefined ? {} : { body:JSON.stringify(body) }),
      redirect:'manual',
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw cutoverError(
        `Paperclip ${method} ${pathname} 失败：HTTP ${response.status}。`,
      );
    }
    return parsed;
  }
}
function validateController(current, declared) {
  if (!isRecord(current) || current.id !== declared.id) {
    throw cutoverError(`${declared.key} 控制器 ID 不匹配。`);
  }
  if (current.adapterType !== declared.adapterType) {
    throw cutoverError(`${declared.key} 控制器 adapterType 必须为 http。`);
  }
  const adapterConfig = current.adapterConfig;
  if (!isRecord(adapterConfig)) {
    throw cutoverError(`${declared.key} 控制器 adapterConfig 无效。`);
  }
  assertExactKeys(
    adapterConfig,
    ['url', 'forwardRunJwt'],
    `${declared.key} adapterConfig`,
    { optional:['forwardRunJwt'] },
  );
  if (adapterConfig.url !== declared.url) {
    throw cutoverError(`${declared.key} 控制器 URL 不匹配固定 loopback 路径。`);
  }
  if (
    'forwardRunJwt' in adapterConfig
    && typeof adapterConfig.forwardRunJwt !== 'boolean'
  ) {
    throw cutoverError(`${declared.key} forwardRunJwt 必须是布尔值。`);
  }
  return {
    adapterConfig:structuredClone(adapterConfig),
    forwardRunJwt:adapterConfig.forwardRunJwt === true,
  };
}

function targetAdapterConfig(item) {
  return { ...structuredClone(item.adapterConfig), forwardRunJwt:true };
}

function configSha(adapterType, adapterConfig) {
  return sha256(canonicalJson({ adapterType, adapterConfig }));
}

async function assertPaperclipVersion(client) {
  const version = await client.getVersion();
  if (version !== PAPERCLIP_CONTROLLER_CUTOVER_VERSION) {
    throw cutoverError(
      `只允许 Paperclip ${PAPERCLIP_CONTROLLER_CUTOVER_VERSION}，当前为 ${version || 'unknown'}。`,
    );
  }
}

function validateSnapshotController(item) {
  assertExactKeys(item, [
    'key',
    'id',
    'adapterType',
    'adapterConfig',
    'configSha256',
    'targetConfigSha256',
  ], '快照控制器');
  const declared = M5_RUN_JWT_CONTROLLERS.find(({ id }) => id === item.id);
  if (!declared || item.key !== declared.key || item.adapterType !== 'http') {
    throw cutoverError('快照控制器身份或类型无效。');
  }
  const normalized = validateController({
    id:item.id,
    adapterType:item.adapterType,
    adapterConfig:item.adapterConfig,
  }, declared);
  if (normalized.forwardRunJwt) {
    throw cutoverError('快照原始配置不得已启用 forwardRunJwt。');
  }
  const configSha256 = configSha(item.adapterType, normalized.adapterConfig);
  const targetConfigSha256 = configSha(
    item.adapterType,
    targetAdapterConfig({ adapterConfig:normalized.adapterConfig }),
  );
  if (
    item.configSha256 !== configSha256
    || item.targetConfigSha256 !== targetConfigSha256
  ) {
    throw cutoverError('快照控制器配置 SHA256 不匹配。');
  }
  return {
    key:item.key,
    id:item.id,
    adapterType:item.adapterType,
    adapterConfig:normalized.adapterConfig,
    configSha256,
    targetConfigSha256,
  };
}

function declarationFor(item) {
  const declared = M5_RUN_JWT_CONTROLLERS.find(({ id }) => id === item.id);
  if (!declared || declared.key !== item.key) {
    throw cutoverError('快照控制器不在固定批准清单。');
  }
  return declared;
}

function assertNoSecretKeys(value, pathValue = 'snapshot') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretKeys(item, `${pathValue}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (/(?:secret|token|cookie|password|authorization|api[_-]?key)/i.test(key)) {
      throw cutoverError(`快照包含禁止的敏感字段：${pathValue}.${key}。`);
    }
    assertNoSecretKeys(child, `${pathValue}.${key}`);
  }
}

function assertExactKeys(value, allowed, label, { optional = [] } = {}) {
  if (!isRecord(value)) throw cutoverError(`${label} 必须是对象。`);
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length) throw cutoverError(`${label} 包含未知字段。`);
  const optionalSet = new Set(optional);
  const missing = allowed.filter((key) => !optionalSet.has(key) && !(key in value));
  if (missing.length) throw cutoverError(`${label} 缺少必填字段。`);
}
function canonicalOrigin(value) {
  try {
    const url = new URL(String(value || ''));
    if (
      url.protocol !== 'http:'
      || url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash
    ) {
      return '';
    }
    return url.origin;
  } catch {
    return '';
  }
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw cutoverError('快照包含非有限数字。');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  throw cutoverError('快照包含不支持的值。');
}

function validIsoDate(now) {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw cutoverError('快照时钟无效。');
  }
  return value.toISOString();
}

function validIsoDateValue(value) {
  const parsed = new Date(String(value || ''));
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeMessage(error) {
  return String(error?.message || 'unknown')
    .replace(/\s+/g, ' ')
    .slice(0, 240);
}

function assertClient(client) {
  if (
    !client
    || typeof client.getVersion !== 'function'
    || typeof client.getController !== 'function'
    || typeof client.updateController !== 'function'
  ) {
    throw cutoverError('Paperclip 控制器客户端未配置。');
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cutoverError(message, options) {
  return new M5ControllerRunJwtCutoverError(message, options);
}

export const controllerRunJwtContract = Object.freeze({
  controller:Object.freeze({
    assertClient,
    assertVersion:assertPaperclipVersion,
    validate:validateController,
    validateSnapshot:validateSnapshotController,
    declarationFor,
    targetAdapterConfig,
    configSha,
  }),
  snapshot:Object.freeze({
    assertNoSecretKeys,
    assertExactKeys,
    canonicalJson,
    validIsoDate,
    validIsoDateValue,
    sha256,
  }),
  errors:Object.freeze({
    create:cutoverError,
    safeMessage,
  }),
});

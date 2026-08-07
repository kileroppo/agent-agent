import net from 'node:net';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const ALLOWED_EXTERNAL_EFFECTS = new Set(['none', 'network-read', 'external-data-processing']);
const EXTERNAL_PROCESSING_CLASSIFICATIONS = new Set(['public', 'redacted']);
const FORBIDDEN_EXTERNAL_EFFECTS = new Set([
  'external-write',
  'message-send',
  'publish',
  'payment',
  'permission-change',
  'account-login',
]);

export function compileM5RoleToolGrant({
  manifest,
  profile,
  paperclipAgentId,
  projectId,
  executionWorkspaceId,
  availableAdapters = [],
} = {}) {
  const agentId = String(manifest?.agentId || '').trim();
  if (!agentId || profile?.profileId !== agentId || profile?.agentManifestRef !== `agents/${agentId}/manifest.json`) {
    throw new M5RoleToolGrantError('Manifest 与 Hermes Profile 岗位身份不一致。', 'role_identity_mismatch');
  }
  for (const [name, value] of [
    ['paperclipAgentId', paperclipAgentId],
    ['projectId', projectId],
    ['executionWorkspaceId', executionWorkspaceId],
  ]) {
    if (!UUID.test(String(value || ''))) {
      throw new M5RoleToolGrantError(`${name} 必须来自 Paperclip 当前指派。`, 'paperclip_scope_invalid');
    }
  }

  const allowedTools = uniqueStrings(manifest.toolAllowlist);
  const profileTools = uniqueStrings(profile.toolAllowlist);
  const policy = manifest.toolExecutionPolicy;
  const policyTools = policy && plainObject(policy.grants)
    ? Object.keys(policy.grants)
    : [];
  if (
    !allowedTools
    || !profileTools
    || policy?.unknownToolDecision !== 'deny'
    || policy?.workspace?.scope !== 'paperclip-execution-workspace'
    || policy?.workspace?.pathMode !== 'relative-only'
    || !sameSet(allowedTools, profileTools)
    || !sameSet(allowedTools, policyTools)
  ) {
    throw new M5RoleToolGrantError(
      '岗位工具必须由 Manifest、Hermes Profile 和执行策略精确一致地授权。',
      'role_tool_policy_invalid',
    );
  }

  const grants = Object.fromEntries(allowedTools.map((toolId) => {
    const declaration = policy.grants[toolId];
    if (
      !plainObject(declaration)
      || !String(declaration.adapter || '').trim()
      || !['read', 'write'].includes(declaration.access)
      || !ALLOWED_EXTERNAL_EFFECTS.has(declaration.externalSideEffect)
      || !['paperclip-execution-workspace', 'agent-army-knowledge-archive'].includes(
        declaration.scope || 'paperclip-execution-workspace',
      )
    ) {
      throw new M5RoleToolGrantError(
        `岗位工具 ${toolId} 缺少有效的适配器、访问方式或副作用声明。`,
        'role_tool_policy_invalid',
      );
    }
    if (declaration.access === 'write' && declaration.externalSideEffect !== 'none') {
      throw new M5RoleToolGrantError(
        `岗位工具 ${toolId} 不能同时获得工作区写入和外部写副作用。`,
        'role_tool_policy_invalid',
      );
    }
    return [toolId, Object.freeze({ ...declaration })];
  }));
  const adapters = normalizeAvailableAdapters(availableAdapters);

  return Object.freeze({
    schemaVersion:'agent.army/m5-role-tool-grant/v1',
    agentId,
    paperclipAgentId,
    projectId,
    executionWorkspaceId,
    unknownToolDecision:'deny',
    workspace:Object.freeze({
      scope:'paperclip-execution-workspace',
      pathMode:'relative-only',
    }),
    availableAdapters:Object.freeze(adapters),
    grants:Object.freeze(grants),
  });
}

export function assertM5RoleToolAccess(grant, {
  toolId,
  executionWorkspaceId,
  externalSideEffect = 'none',
  relativePath = null,
  url = null,
  dataClassification = null,
  externalProcessingApproved = false,
} = {}) {
  const declaration = grant?.grants?.[String(toolId || '').trim()];
  if (!declaration) {
    throw new M5RoleToolGrantError('当前岗位未授权该工具；未知工具默认拒绝。', 'role_tool_denied');
  }
  if (executionWorkspaceId !== grant.executionWorkspaceId) {
    throw new M5RoleToolGrantError('工具请求不属于当前 Paperclip execution workspace。', 'workspace_scope_denied');
  }
  if (declaration.access === 'write' && !safeRelativePath(relativePath)) {
    throw new M5RoleToolGrantError('工作区写入工具必须提供安全相对路径。', 'workspace_path_required');
  }
  if (relativePath != null && !safeRelativePath(relativePath)) {
    throw new M5RoleToolGrantError('工具路径必须是当前工作区内的安全相对路径。', 'workspace_path_denied');
  }
  if (
    FORBIDDEN_EXTERNAL_EFFECTS.has(externalSideEffect)
    || declaration.externalSideEffect !== externalSideEffect
  ) {
    throw new M5RoleToolGrantError('工具请求的外部副作用未被岗位授权。', 'external_side_effect_denied');
  }
  if (!grant.availableAdapters?.includes(declaration.adapter)) {
    throw new M5RoleToolGrantError(
      `岗位工具 ${toolId} 的受控适配器当前不可用。`,
      'role_tool_adapter_unavailable',
    );
  }
  const publicUrl = declaration.externalSideEffect === 'network-read'
    ? publicNetworkUrl(url)
    : null;
  const externalProcessing = declaration.externalSideEffect === 'external-data-processing'
    ? externalProcessingScope({
        adapter:declaration.adapter,
        dataClassification,
        externalProcessingApproved,
      })
    : null;
  return Object.freeze({
    toolId,
    adapter:declaration.adapter,
    access:declaration.access,
    scope:declaration.scope || 'paperclip-execution-workspace',
    externalSideEffect:declaration.externalSideEffect,
    executionWorkspaceId:grant.executionWorkspaceId,
    relativePath:relativePath == null ? null : String(relativePath),
    url:publicUrl,
    dataClassification:externalProcessing?.dataClassification || null,
    externalProcessingApproved:externalProcessing?.approved || false,
    allowedHosts:externalProcessing?.allowedHosts || null,
  });
}

function externalProcessingScope({ adapter, dataClassification, externalProcessingApproved }) {
  if (adapter !== 'open-kimi-pptx') {
    throw new M5RoleToolGrantError(
      '只有 OpenKimi PPTX 适配器可以申请外部数据处理。',
      'external_data_processing_denied',
    );
  }
  const classification = String(dataClassification || '').trim();
  if (!EXTERNAL_PROCESSING_CLASSIFICATIONS.has(classification)) {
    throw new M5RoleToolGrantError(
      '外部演示文稿处理只接受 public 或 redacted 数据。',
      'external_data_processing_denied',
    );
  }
  if (externalProcessingApproved !== true) {
    throw new M5RoleToolGrantError(
      '外部演示文稿处理尚未获得本次明确批准。',
      'external_data_processing_approval_required',
    );
  }
  return Object.freeze({
    dataClassification:classification,
    approved:true,
    allowedHosts:Object.freeze(['www.kimi.com', 'statics.moonshot.cn']),
  });
}

export function createM5RoleToolExecutionContext(grant, {
  adapters = {},
  workspaceRoot = null,
  trustedScope = {},
} = {}) {
  if (!grant?.executionWorkspaceId || !plainObject(grant.grants)) {
    throw new M5RoleToolGrantError('岗位工具授权上下文无效。', 'role_tool_context_invalid');
  }
  const accesses = [];
  return Object.freeze({
    executionWorkspaceId:grant.executionWorkspaceId,
    workspaceRoot,
    async execute(input = {}) {
      const access = assertM5RoleToolAccess(grant, {
        ...input,
        executionWorkspaceId:grant.executionWorkspaceId,
      });
      const adapter = adapterFor(adapters, access.adapter);
      if (typeof adapter !== 'function') {
        throw new M5RoleToolGrantError(
          `岗位工具 ${access.toolId} 的受控适配器当前不可执行。`,
          'role_tool_adapter_unavailable',
        );
      }
      const output = await adapter({
        access,
        input:plainObject(input.input) || {},
        workspaceRoot,
        trustedScope:Object.freeze({ ...trustedScope }),
      });
      accesses.push(Object.freeze({
        ...access,
        executed:true,
      }));
      return output;
    },
    snapshot() {
      return Object.freeze(accesses.map((item) => Object.freeze({ ...item })));
    },
  });
}

export class M5RoleToolGrantError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function safeRelativePath(value) {
  const normalized = String(value || '').trim().replaceAll('\\', '/');
  return Boolean(normalized)
    && normalized.length <= 1024
    && !normalized.includes('\0')
    && !normalized.startsWith('/')
    && !/^[a-z]:\//i.test(normalized)
    && !normalized.split('/').some((part) => !part || part === '.' || part === '..');
}

function publicNetworkUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch {
    throw new M5RoleToolGrantError(
      '公开网络只读工具必须提供 HTTP(S) URL。',
      'network_url_required',
    );
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || privateHost(parsed.hostname)
  ) {
    throw new M5RoleToolGrantError(
      '网络只读工具只能访问不含凭据的公开 HTTP(S) URL，拒绝本机和内网地址。',
      'network_url_denied',
    );
  }
  return parsed.toString();
}

function privateHost(host) {
  const value = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (
    value === 'localhost'
    || value.endsWith('.localhost')
    || value.endsWith('.local')
    || value.endsWith('.internal')
    || value.endsWith('.home.arpa')
  ) return true;
  if (net.isIP(value) === 4) {
    return value.startsWith('127.')
      || value.startsWith('10.')
      || value.startsWith('192.168.')
      || /^172\.(1[6-9]|2\d|3[0-1])\./.test(value)
      || value.startsWith('169.254.')
      || value.startsWith('0.')
      || /^100\.(6[4-9]|[789]\d|1[01]\d|12[0-7])\./.test(value)
      || value === '255.255.255.255';
  }
  if (net.isIP(value) === 6) {
    const mapped = mappedIpv4(value);
    if (mapped) return privateHost(mapped);
    return value === '::'
      || value === '::1'
      || value.startsWith('fc')
      || value.startsWith('fd')
      || /^fe[89ab]/.test(value)
      || value.startsWith('::ffff:127.')
      || value.startsWith('::ffff:10.')
      || value.startsWith('::ffff:192.168.')
      || /^::ffff:172\.(1[6-9]|2\d|3[0-1])\./.test(value);
  }
  return false;
}

function mappedIpv4(value) {
  if (!value.startsWith('::ffff:')) return null;
  const suffix = value.slice('::ffff:'.length);
  if (net.isIP(suffix) === 4) return suffix;
  const parts = suffix.split(':');
  if (parts.length !== 2 || parts.some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return null;
  const high = Number.parseInt(parts[0], 16);
  const low = Number.parseInt(parts[1], 16);
  return [
    (high >>> 8) & 255,
    high & 255,
    (low >>> 8) & 255,
    low & 255,
  ].join('.');
}

function normalizeAvailableAdapters(value) {
  const names = value instanceof Map
    ? [...value.entries()].filter(([, adapter]) => typeof adapter === 'function').map(([name]) => name)
    : plainObject(value)
      ? Object.entries(value).filter(([, adapter]) => typeof adapter === 'function').map(([name]) => name)
        : [];
  return [...new Set(names.map((item) => String(item || '').trim()).filter(Boolean))].sort();
}

function adapterFor(adapters, name) {
  if (adapters instanceof Map) return adapters.get(name);
  return plainObject(adapters)?.[name];
}

function sameSet(left, right) {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function uniqueStrings(value) {
  if (
    !Array.isArray(value)
    || value.some((item) => typeof item !== 'string' || !item.trim())
    || new Set(value).size !== value.length
  ) return null;
  return [...value];
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

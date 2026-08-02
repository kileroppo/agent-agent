import {
  M5_CONTENT_ROLES,
  M5_ROLE_TOOL_BUNDLES,
  validateExactAgentToolPolicy,
} from '@agent-army/paperclip-content-autonomy/role-tool-bundles';

const CONTENT_WORKSPACE_KEY = 'content-workspace';
const STEP_FUN_CONFIG_PATH = 'stepfunSecretRef';
const STEP_FUN_BASE_URL = 'https://api.stepfun.com';
const RATE_KEYS = Object.freeze([
  'visionInputPerMillionTokens',
  'visionOutputPerMillionTokens',
  'imagePerGeneration',
  'ttsPerThousandCharacters',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function inspectContentAutonomyPluginReadiness({
  adapter,
  companyId,
  plugin,
  agents = [],
}) {
  const failures = [];
  if (!plugin?.id) {
    return ['内容插件缺少稳定 ID；重新安装并确认插件状态为 ready'];
  }

  const pluginId = encodeURIComponent(plugin.id);
  const scopedCompanyId = encodeURIComponent(companyId);
  const [configRecord, secretsPayload, providersPayload, workspaceStatus] = await Promise.all([
    read(adapter, `/api/plugins/${pluginId}/config?companyId=${scopedCompanyId}`),
    read(adapter, `/api/companies/${scopedCompanyId}/secrets`),
    read(adapter, `/api/companies/${scopedCompanyId}/secret-providers`),
    read(
      adapter,
      `/api/plugins/${pluginId}/companies/${scopedCompanyId}/local-folders/${CONTENT_WORKSPACE_KEY}/status`,
    ),
  ]);

  const config = configRecord?.configJson;
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    failures.push('内容插件缺少公司级配置；到 Paperclip 实例设置 → Plugins → Agent军团·内容自治补齐后重试');
    return failures;
  }

  const secretRef = config.stepfunSecretRef;
  if (!isSecretRef(secretRef)) {
    failures.push('StepFun Secret 必须绑定 Paperclip secret_ref 对象，不能使用旧字符串或明文；到公司设置 → Secrets 创建后回到插件选择该 Secret');
  } else {
    const secrets = asList(secretsPayload);
    const secret = secrets.find((item) => item.id === secretRef.secretId);
    if (!secret || secret.status !== 'active') {
      failures.push('StepFun Secret 元数据不存在或未启用；到公司设置 → Secrets 创建或启用后重新绑定');
    } else {
      const providers = asList(providersPayload);
      const provider = providers.find((item) => item.id === secret.provider);
      if (!provider || provider.configured !== true) {
        failures.push(`StepFun Secret 的 ${secret.provider || '未知'} 供应器未配置；先完成 Paperclip Secret Provider 配置`);
      }
      const usage = await read(adapter, `/api/secrets/${encodeURIComponent(secret.id)}/usage`);
      const versionSelector = secretRef.version ?? 'latest';
      const bound = asList(usage?.bindings).some((binding) =>
        binding.targetType === 'plugin'
        && binding.targetId === plugin.id
        && binding.configPath === STEP_FUN_CONFIG_PATH
        && String(binding.versionSelector ?? 'latest') === String(versionSelector),
      );
      if (!bound) {
        failures.push('StepFun Secret 尚未登记为本插件的 stepfunSecretRef 绑定；重新保存插件配置后再批准活动');
      }
    }
  }

  validateBaseUrl(config.stepfunBaseUrl, failures);
  validateVoices(config.officialTtsVoices, failures);
  validateRates(config.costRatesCents, failures);
  validateRoleGrants(config, agents, failures);
  validateWorkspace(workspaceStatus, failures);
  return failures;
}

function isSecretRef(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.type !== 'secret_ref' || !UUID.test(String(value.secretId || ''))) return false;
  return value.version === undefined
    || value.version === 'latest'
    || (Number.isInteger(value.version) && value.version > 0);
}

function validateBaseUrl(value, failures) {
  try {
    const parsed = new URL(String(value || `${STEP_FUN_BASE_URL}/v1`));
    if (parsed.protocol !== 'https:' || parsed.origin !== STEP_FUN_BASE_URL) throw new Error('denied');
  } catch {
    failures.push('StepFun Base URL 不是官方 HTTPS 地址；在插件配置中恢复为 https://api.stepfun.com/v1');
  }
}

function validateVoices(value, failures) {
  const voices = Array.isArray(value) ? value : [];
  if (
    voices.length === 0
    || voices.some((voice) => typeof voice !== 'string' || !voice.trim() || /^clone:/i.test(voice.trim()))
  ) {
    failures.push('官方 TTS 音色白名单为空或包含克隆音色；只登记 StepFun 官方音色后重试');
  }
}

function validateRates(value, failures) {
  if (
    !value
    || typeof value !== 'object'
    || RATE_KEYS.some((key) => !Number.isFinite(Number(value[key])) || Number(value[key]) <= 0)
  ) {
    failures.push('StepFun 视觉、生图和 TTS 费率必须全部为正数；按负责人确认的真实费率补齐后重试');
  }
}

function validateRoleGrants(config, agents, failures) {
  const policy = validateExactAgentToolPolicy(config);
  for (const error of policy.errors) {
    failures.push(`${error} 按 M5 最小权限模板重新保存插件配置`);
  }
  const bindings = config?.agentRoleBindings;
  const grants = config?.agentToolGrants;
  if (!bindings || !grants) return;

  for (const role of M5_CONTENT_ROLES) {
    const agent = agents.find((item) => item.roleId === role || item.metadata?.agentArmyId === role);
    if (!agent || bindings[role] !== agent.id) {
      failures.push(`岗位 ${role} 的 UUID绑定与 Paperclip 当前岗位不一致；重新读取岗位目录并保存插件配置`);
      continue;
    }
    const actual = grants[agent.id];
    const expected = M5_ROLE_TOOL_BUNDLES[role];
    if (
      !Array.isArray(actual)
      || actual.length !== expected.length
      || actual.some((tool) => !expected.includes(tool))
    ) {
      failures.push(`岗位 ${role} 的 grant 必须与 M5 最小bundle完全一致；删除额外工具或补齐缺失工具`);
    }
  }
  const allowedAgentIds = new Set(M5_CONTENT_ROLES.map((role) => bindings[role]));
  if (Object.keys(grants).some((agentId) => !allowedAgentIds.has(agentId))) {
    failures.push('岗位工具白名单包含 M5 内容岗位范围之外的 Agent UUID；删除额外 grant 后重试');
  }
}

function validateWorkspace(value, failures) {
  if (
    !value
    || value.folderKey !== CONTENT_WORKSPACE_KEY
    || value.configured !== true
    || value.healthy !== true
    || value.readable !== true
    || value.writable !== true
  ) {
    failures.push('内容工作区未绑定或不可读写；在插件 Local folders 中重新绑定 content-workspace 并通过健康检查');
  }
}

async function read(adapter, path) {
  return adapter.request('GET', path).catch(() => null);
}

function asList(value) {
  return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
}

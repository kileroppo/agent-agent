import crypto from 'node:crypto';

const CONTENT_PLUGIN_KEY = 'agent-army.content-autonomy';

export async function readContentAutonomyApprovalSnapshot({
  adapter,
  companyId,
  plugin = null,
} = {}) {
  if (!adapter?.request || !companyId) {
    throw new Error('生成内容插件批准快照需要限定 Paperclip 公司。');
  }
  const installed = plugin || await findContentPlugin(adapter);
  if (
    !installed?.id
    || installed.status !== 'ready'
    || !installed.manifestJson
    || String(installed.version || installed.manifestJson.version || '') !== String(installed.manifestJson.version || '')
  ) {
    throw new Error('内容插件缺少 ready 实例、稳定版本或 manifest。');
  }
  const configRecord = await adapter.request(
    'GET',
    `/api/plugins/${encodeURIComponent(installed.id)}/config?companyId=${encodeURIComponent(companyId)}`,
  );
  if (!configRecord?.configJson || typeof configRecord.configJson !== 'object') {
    throw new Error('内容插件缺少公司级配置，不能生成批准快照。');
  }
  return buildContentAutonomyApprovalSnapshot({
    plugin:installed,
    configRecord,
  });
}

export function buildContentAutonomyApprovalSnapshot({ plugin, configRecord } = {}) {
  if (!plugin?.id || !plugin?.manifestJson || !configRecord?.configJson) {
    throw new Error('内容插件批准快照缺少 plugin 或 config record。');
  }
  return {
    schemaVersion:'agent.army/content-plugin-approval/v1',
    pluginId:plugin.id,
    pluginKey:CONTENT_PLUGIN_KEY,
    version:String(plugin.version || plugin.manifestJson.version),
    manifestHash:hashJson(plugin.manifestJson),
    configHash:hashJson(configRecord.configJson),
  };
}

export async function assertContentAutonomyApprovalSnapshot({
  adapter,
  companyId,
  approved,
} = {}) {
  if (
    approved?.schemaVersion !== 'agent.army/content-plugin-approval/v1'
    || approved.pluginKey !== CONTENT_PLUGIN_KEY
    || !approved.pluginId
    || !approved.version
    || !/^sha256:[0-9a-f]{64}$/i.test(String(approved.manifestHash || ''))
    || !/^sha256:[0-9a-f]{64}$/i.test(String(approved.configHash || ''))
  ) {
    throw new Error('CampaignGrant 缺少有效的内容插件版本与配置批准快照。');
  }
  const current = await readContentAutonomyApprovalSnapshot({ adapter, companyId });
  const matches = [
    'pluginId',
    'pluginKey',
    'version',
    'manifestHash',
    'configHash',
  ].every((key) => current[key] === approved[key]);
  if (!matches) {
    throw new Error('内容插件版本、manifest 或公司配置已偏离活动批准快照；活动必须暂停并重新审批。');
  }
  return current;
}

async function findContentPlugin(adapter) {
  const payload = await adapter.request('GET', '/api/plugins');
  const plugins = Array.isArray(payload) ? payload : Array.isArray(payload?.items) ? payload.items : [];
  const matches = plugins.filter((item) =>
    [item.pluginKey, item.key, item.manifestJson?.id].includes(CONTENT_PLUGIN_KEY),
  );
  if (matches.length !== 1) {
    throw new Error(`内容插件必须且只能安装一个 ready 实例，当前为 ${matches.length} 个。`);
  }
  return matches[0];
}

function hashJson(value) {
  return `sha256:${crypto.createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(value[key])}`,
  ).join(',')}}`;
}

#!/usr/bin/env node
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  applyCompatibilityPatch,
  CONTENT_PLUGIN_STEPFUN_SHA256,
  HOST_ORIGINAL_SHA256,
  HOST_PATCHED_SHA256,
  PAPERCLIP_VERSION,
  resolveCompatibilityTargets,
  rollbackCompatibilityPatch,
} from '../compat/paperclip-2026-722-binary-rpc.ts';

const execFileAsync = promisify(execFile);
const PLUGIN_KEY = 'agent-army.content-autonomy';
const OLD_PLUGIN_VERSION = '0.4.9';
const NEW_PLUGIN_VERSION = '0.5.0';
const OLD_PLUGIN_STEPFUN_SHA256 = 'df8223807097e865db59b80a109530030ff36ffb06e032426fa01366404be4de';
const LAUNCHD_LABEL = 'ai.agent-army.paperclip';
const APPLY_CONFIRMATION = 'I_ACCEPT_CONTENT_AUTONOMY_0_5_0_LIVE_MAINTENANCE';
const ROLLBACK_CONFIRMATION = 'I_ACCEPT_CONTENT_AUTONOMY_0_4_9_ROLLBACK';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export async function runLiveMaintenance({
  mode = 'dry-run',
  input,
  api,
  processControl,
  compat,
  inspectBundle,
}) {
  const normalizedMode = String(mode || 'dry-run');
  if (!['dry-run', 'execute', 'rollback'].includes(normalizedMode)) {
    throw new Error('mode只允许dry-run、execute或rollback。');
  }
  let stage = 'preflight';
  let mutated = false;
  const recoveryAction = rollbackAction(input);
  try {
    const expectedVersion = normalizedMode === 'execute' ? OLD_PLUGIN_VERSION : null;
    const allowedCampaignStatuses = ['draft', 'paused', 'stopped'];
    const before = await verifySnapshot({
      api,
      input,
      expectedVersion,
      requireReady:normalizedMode !== 'rollback',
      allowedCampaignStatuses,
    });
    const [newBundle, oldBundle] = await Promise.all([
      inspectBundle(input.newPluginPath, NEW_PLUGIN_VERSION),
      inspectBundle(input.oldPluginPath, OLD_PLUGIN_VERSION),
    ]);
    if (
      normalizedMode !== 'execute'
      && ![OLD_PLUGIN_VERSION, NEW_PLUGIN_VERSION].includes(before.summary.pluginVersion)
    ) throw new Error('当前内容插件版本不在维护或回滚白名单。');
    const pidBefore = await processControl.pid();
    const plan = [
      'soft-uninstall-without-purge',
      `install-${normalizedMode === 'rollback' ? OLD_PLUGIN_VERSION : NEW_PLUGIN_VERSION}-same-id`,
      normalizedMode === 'rollback' ? 'preserve-binary-compat' : 'apply-binary-compat',
      `kickstart-${LAUNCHD_LABEL}`,
      'postflight-verify',
    ];
    if (normalizedMode === 'dry-run') {
      const alreadyCurrent = before.summary.pluginVersion === NEW_PLUGIN_VERSION;
      return {
        status:alreadyCurrent ? 'already_current' : 'dry_run_ready',
        mode:normalizedMode,
        preflight:before.summary,
        bundles:{ new:newBundle.summary, old:oldBundle.summary },
        pidBefore,
        plan:alreadyCurrent ? [] : plan,
      };
    }

    if (normalizedMode === 'execute') {
      stage = 'soft_uninstall';
      await api.delete(`/api/plugins/${encodeURIComponent(input.pluginId)}`);
      mutated = true;
      stage = 'install_0_5_0';
      const installed = await api.post('/api/plugins/install', {
        packageName:newBundle.root,
        isLocalPath:true,
      });
      assertInstalled(installed, input.pluginId, NEW_PLUGIN_VERSION, newBundle.root);
      stage = 'preservation_check';
      await verifyPreservedConfig(api, input, before.configHash);
      stage = 'binary_compat_apply';
      await compat.apply({
        paperclipEntry:input.paperclipEntry,
        pluginEntry:path.join(newBundle.root, 'src', 'worker.ts'),
      });
    } else {
      stage = 'binary_compat_preserve';
      await compat.apply({
        paperclipEntry:input.paperclipEntry,
        pluginEntry:path.join(oldBundle.root, 'src', 'worker.js'),
        expectedPluginVersion:OLD_PLUGIN_VERSION,
      });
      mutated = true;
      const current = await api.get(`/api/plugins/${encodeURIComponent(input.pluginId)}`);
      if (
        current?.status !== 'ready'
        || current?.version !== OLD_PLUGIN_VERSION
        || await canonicalRealpath(current?.packagePath) !== oldBundle.root
      ) {
        stage = 'soft_uninstall_new_plugin';
        await api.delete(`/api/plugins/${encodeURIComponent(input.pluginId)}`);
        stage = 'install_0_4_9';
        const installed = await api.post('/api/plugins/install', {
          packageName:oldBundle.root,
          isLocalPath:true,
        });
        assertInstalled(installed, input.pluginId, OLD_PLUGIN_VERSION, oldBundle.root);
      }
      stage = 'preservation_check';
      await verifyPreservedConfig(api, input, before.configHash);
    }

    stage = 'paperclip_kickstart';
    await processControl.kickstart();
    stage = 'postflight_health';
    const health = await processControl.waitForHealth(api);
    const pidAfter = await processControl.pid();
    if (pidAfter === pidBefore) throw new Error('Paperclip kickstart后PID没有变化。');
    const finalVersion = normalizedMode === 'rollback' ? OLD_PLUGIN_VERSION : NEW_PLUGIN_VERSION;
    const finalSnapshot = await verifySnapshot({
      api,
      input,
      expectedVersion:finalVersion,
      requireReady:true,
      expectedConfigHash:before.configHash,
      allowedCampaignStatuses,
    });
    const pluginHealth = await api.get(`/api/plugins/${encodeURIComponent(input.pluginId)}/health`);
    const pluginHealthy = pluginHealth?.status === 'ok'
      || (pluginHealth?.status === 'ready' && pluginHealth?.healthy === true);
    if (!pluginHealthy) throw new Error('内容插件健康检查未返回健康状态。');
    return {
      status:normalizedMode === 'rollback' ? 'rolled_back' : 'completed',
      mode:normalizedMode,
      pluginId:input.pluginId,
      pluginVersion:finalVersion,
      configPreserved:true,
      stateScopePreserved:true,
      campaignSafe:finalSnapshot.summary.campaignSafe,
      campaignStatus:finalSnapshot.summary.campaignStatus,
      campaignDraft:finalSnapshot.summary.campaignDraft,
      cronOff:true,
      backupHealthy:true,
      paperclipVersion:health.version,
      pidBefore,
      pidAfter,
      postflight:finalSnapshot.summary,
      rollback:recoveryAction,
    };
  } catch (error) {
    throw new LiveMaintenanceError({
      stage,
      message:safeMessage(error),
      recoveryAction:mutated
        ? recoveryAction
        : {
          command:'node',
          args:[input.scriptPath, '--mode', 'dry-run', ...commonArgs(input)],
        },
    });
  }
}

async function verifySnapshot({
  api,
  input,
  expectedVersion,
  requireReady,
  expectedConfigHash = null,
  allowedCampaignStatuses = ['draft'],
}) {
  const [health, plugin, config, campaignPayload, routine] = await Promise.all([
    api.get('/api/health'),
    api.get(`/api/plugins/${encodeURIComponent(input.pluginId)}`),
    api.get(`/api/plugins/${encodeURIComponent(input.pluginId)}/config?companyId=${encodeURIComponent(input.companyId)}`),
    api.get(`/api/cases/${encodeURIComponent(input.campaignId)}`),
    api.get(`/api/routines/${encodeURIComponent(input.routineId)}`),
  ]);
  assertHealthAndBackup(health);
  if (
    plugin?.id !== input.pluginId
    || plugin?.pluginKey !== PLUGIN_KEY
    || (requireReady && plugin.status !== 'ready')
    || (expectedVersion && plugin.version !== expectedVersion)
  ) throw new Error('内容插件ID、key、状态或版本不符合维护门禁。');
  const configHash = hashJson(config?.configJson);
  if (!config?.configJson || !validSecretRef(config.configJson.stepfunSecretRef)) {
    throw new Error('内容插件配置或Paperclip Secret引用无效。');
  }
  if (expectedConfigHash && configHash !== expectedConfigHash) {
    throw new Error('内容插件配置在维护前后发生漂移。');
  }
  const campaign = campaignPayload?.case ?? campaignPayload;
  const campaignStatus = campaign?.fields?.campaignGrant?.status;
  if (
    campaign?.id !== input.campaignId
    || campaign?.companyId !== input.companyId
    || !allowedCampaignStatuses.includes(campaignStatus)
  ) throw new Error(`Campaign必须保持安全状态：${allowedCampaignStatuses.join('或')}。`);
  const schedules = Array.isArray(routine?.triggers)
    ? routine.triggers.filter((item) => item?.kind === 'schedule')
    : [];
  if (
    routine?.id !== input.routineId
    || routine?.companyId !== input.companyId
    || schedules.length === 0
    || schedules.some((item) => item.enabled !== false)
  ) throw new Error('M5 Routine Cron必须存在且全部关闭。');
  return {
    configHash,
    summary:{
      paperclipVersion:health.version,
      backupHealthy:true,
      pluginId:plugin.id,
      pluginVersion:plugin.version,
      pluginReady:plugin.status === 'ready',
      secretRefValid:true,
      configChecksum:configHash,
      campaignSafe:true,
      campaignStatus,
      campaignDraft:campaignStatus === 'draft',
      cronOff:true,
      scheduleTriggerCount:schedules.length,
    },
  };
}

function assertHealthAndBackup(health) {
  if (
    health?.status !== 'ok'
    || health?.version !== PAPERCLIP_VERSION
    || health?.databaseBackup?.enabled !== true
    || health?.databaseBackup?.status !== 'ok'
    || !health?.databaseBackup?.latestBackup?.name
    || Number(health?.databaseBackup?.latestBackup?.sizeBytes) <= 0
    || (health?.databaseBackup?.warnings?.length || 0) !== 0
  ) throw new Error(`Paperclip ${PAPERCLIP_VERSION}健康或数据库备份门禁未通过。`);
}

async function verifyPreservedConfig(api, input, expectedHash) {
  const config = await api.get(
    `/api/plugins/${encodeURIComponent(input.pluginId)}/config?companyId=${encodeURIComponent(input.companyId)}`,
  );
  if (
    hashJson(config?.configJson) !== expectedHash
    || !validSecretRef(config?.configJson?.stepfunSecretRef)
  ) throw new Error('软重装后配置或Secret引用未保留。');
}

function assertInstalled(installed, pluginId, version, bundleRoot) {
  if (
    installed?.id !== pluginId
    || installed?.pluginKey !== PLUGIN_KEY
    || installed?.version !== version
    || installed?.status !== 'ready'
    || path.resolve(String(installed?.packagePath || '')) !== bundleRoot
  ) throw new Error(`内容插件${version}没有以同一ID从指定immutable路径ready。`);
}

export async function inspectImmutableBundle(rootValue, expectedVersion) {
  const requested = path.resolve(String(rootValue || ''));
  const root = await fs.realpath(requested);
  if (root !== requested) throw new Error('immutable插件路径不得经过符号链接。');
  const marker = root.split(path.sep).find((segment) =>
    new RegExp(`^content-autonomy-bundle-${expectedVersion.replaceAll('.', '\\.')}-[a-f0-9]{64}$`).test(segment),
  );
  if (!marker) throw new Error('插件路径不属于带SHA的immutable bundle。');
  const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  if (
    packageJson.name !== '@agent-army/paperclip-content-autonomy'
    || packageJson.version !== expectedVersion
  ) throw new Error('immutable插件包名或版本不匹配。');
  const currentBundle = expectedVersion === NEW_PLUGIN_VERSION;
  const stepfunSha = await fileSha(path.join(root, 'src', currentBundle ? 'stepfun-tools.ts' : 'stepfun-tools.js'));
  const expectedSha = expectedVersion === NEW_PLUGIN_VERSION
    ? CONTENT_PLUGIN_STEPFUN_SHA256
    : OLD_PLUGIN_STEPFUN_SHA256;
  if (stepfunSha !== expectedSha) throw new Error('immutable插件StepFun源码SHA不匹配。');
  const worker = path.join(root, 'src', currentBundle ? 'worker.ts' : 'worker.js');
  const stat = await fs.lstat(worker);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('immutable插件worker无效。');
  return {
    root,
    summary:{ version:expectedVersion, immutable:true, stepfunSha },
  };
}

export function createHttpApi({ apiBase, fetchImpl = fetch }) {
  const base = loopbackBase(apiBase);
  const request = async (method, route, body) => {
    let response;
    try {
      response = await fetchImpl(`${base}${route}`, {
        method,
        headers:{ accept:'application/json', ...(body ? { 'content-type':'application/json' } : {}) },
        ...(body ? { body:JSON.stringify(body) } : {}),
      });
    } catch {
      throw new Error(`Paperclip ${method} ${route} 未完成。`);
    }
    if (!response.ok) throw new Error(`Paperclip ${method} ${route} 返回HTTP ${response.status}。`);
    return response.status === 204 ? null : response.json();
  };
  return {
    get:(route) => request('GET', route),
    post:(route, body) => request('POST', route, body),
    delete:(route) => request('DELETE', route),
  };
}

export function createLaunchctlProcessControl({
  uid = process.getuid(),
  exec = execFileAsync,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const domain = `gui/${uid}/${LAUNCHD_LABEL}`;
  return {
    async pid() {
      const { stdout } = await exec('/bin/launchctl', ['print', domain]);
      const match = /\bpid = (\d+)/.exec(stdout);
      if (!match) throw new Error('无法读取Paperclip LaunchAgent PID。');
      return Number(match[1]);
    },
    async kickstart() {
      await exec('/bin/launchctl', ['kickstart', '-k', domain]);
    },
    async waitForHealth(api) {
      let lastError;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        try {
          const health = await api.get('/api/health');
          assertHealthAndBackup(health);
          return health;
        } catch (error) {
          lastError = error;
          await delay(500);
        }
      }
      throw lastError || new Error('Paperclip重启后未恢复健康。');
    },
  };
}

export function createCompatControl() {
  return {
    apply:applyCompatibilityPatch,
    async rollback({ paperclipEntry }) {
      const targets = await resolveCompatibilityTargets({
        paperclipEntry,
        verifyPlugin:false,
      });
      const current = await fileSha(targets.hostFile);
      if (current === HOST_ORIGINAL_SHA256) {
        return { changed:false, status:'already_rolled_back' };
      }
      if (current !== HOST_PATCHED_SHA256) throw new Error('host不是已知原版或补丁版。');
      return rollbackCompatibilityPatch({ paperclipEntry });
    },
  };
}

export class LiveMaintenanceError extends Error {
  constructor({ stage, message, recoveryAction }) {
    super(message);
    this.name = 'LiveMaintenanceError';
    this.stage = stage;
    this.recoveryAction = recoveryAction;
  }
}

function rollbackAction(input) {
  return {
    command:'node',
    args:[
      input.scriptPath,
      '--mode', 'rollback',
      ...commonArgs(input),
      '--confirm-live', ROLLBACK_CONFIRMATION,
    ],
  };
}

function commonArgs(input) {
  return [
    '--api-base', input.apiBase,
    '--company-id', input.companyId,
    '--plugin-id', input.pluginId,
    '--campaign-id', input.campaignId,
    '--routine-id', input.routineId,
    '--new-plugin-path', input.newPluginPath,
    '--old-plugin-path', input.oldPluginPath,
    '--paperclip-entry', input.paperclipEntry,
  ];
}

function validSecretRef(value) {
  return value?.type === 'secret_ref'
    && UUID.test(String(value.secretId || ''))
    && (value.version === 'latest' || Number.isInteger(value.version));
}

function hashJson(value) {
  if (!value || typeof value !== 'object') return '';
  return `sha256:${crypto.createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function canonicalRealpath(value) {
  try {
    return await fs.realpath(path.resolve(String(value || '')));
  } catch {
    return '';
  }
}

async function fileSha(file) {
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

function loopbackBase(value) {
  const parsed = new URL(String(value || 'http://127.0.0.1:3100'));
  if (
    parsed.protocol !== 'http:'
    || !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
  ) throw new Error('api-base只允许本机Paperclip HTTP根地址。');
  return parsed.toString().replace(/\/$/, '');
}

function safeMessage(error) {
  const text = String(error?.message || '维护失败。');
  return /Bearer\s|token|cookie|password|secret|\/Users\//i.test(text)
    ? '维护步骤失败；错误已脱敏。'
    : text.slice(0, 500);
}

export function assertLiveConfirmation(mode, confirmation) {
  if (
    mode === 'execute' && confirmation !== APPLY_CONFIRMATION
    || mode === 'rollback' && confirmation !== ROLLBACK_CONFIRMATION
  ) {
    throw new Error('真实维护或回滚缺少对应显式确认短语。');
  }
}

function parseArgs(args) {
  const allowed = new Set([
    'mode', 'api-base', 'company-id', 'plugin-id', 'campaign-id', 'routine-id',
    'new-plugin-path', 'old-plugin-path', 'paperclip-entry', 'confirm-live',
  ]);
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.startsWith('--') ? args[index].slice(2) : '';
    const value = args[index + 1];
    if (!allowed.has(key) || !value || value.startsWith('--') || key in result) {
      throw new Error(`参数无效：${args[index] || '(empty)'}。`);
    }
    result[key] = value;
  }
  return result;
}

function requiredUuid(value, name) {
  if (!UUID.test(String(value || ''))) throw new Error(`${name}必须是UUID。`);
  return String(value);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const mode = options.mode || 'dry-run';
  assertLiveConfirmation(mode, options['confirm-live']);
  const scriptPath = path.resolve(process.argv[1]);
  const input = {
    scriptPath,
    apiBase:loopbackBase(options['api-base']),
    companyId:requiredUuid(options['company-id'], '--company-id'),
    pluginId:requiredUuid(options['plugin-id'], '--plugin-id'),
    campaignId:requiredUuid(options['campaign-id'], '--campaign-id'),
    routineId:requiredUuid(options['routine-id'], '--routine-id'),
    newPluginPath:path.resolve(String(options['new-plugin-path'] || '')),
    oldPluginPath:path.resolve(String(options['old-plugin-path'] || '')),
    paperclipEntry:path.resolve(String(options['paperclip-entry'] || '')),
  };
  return runLiveMaintenance({
    mode,
    input,
    api:createHttpApi({ apiBase:input.apiBase }),
    processControl:createLaunchctlProcessControl({}),
    compat:createCompatControl(),
    inspectBundle:inspectImmutableBundle,
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  try {
    process.stdout.write(`${JSON.stringify(await main())}\n`);
  } catch (error) {
    const payload = error instanceof LiveMaintenanceError
      ? {
        status:'failed',
        stage:error.stage,
        message:error.message,
        recoveryAction:error.recoveryAction,
      }
      : { status:'failed', stage:'arguments', message:safeMessage(error) };
    process.stderr.write(`${JSON.stringify(payload)}\n`);
    process.exitCode = 1;
  }
}

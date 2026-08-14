import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const MODEL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{1,127}$/;
const REASONING_EFFORTS = new Set(['none', 'low', 'medium', 'high']);
const HERMES_MODEL_DISCOVERY_SCRIPT = [
  'import json',
  'from hermes_cli.inventory import build_model_options_payload, load_picker_context',
  'payload = build_model_options_payload(load_picker_context(), explicit_only=True, refresh=True)',
  'models = []',
  'for row in payload.get("providers", []):',
  '    slug = str(row.get("slug", "")).lower()',
  '    if "stepfun" in slug or "sstefun" in slug:',
  '        models.extend(str(model) for model in row.get("models", []) if model)',
  'print(json.dumps(sorted(set(models))))',
].join('\n');

export const STEPFUN_MODEL_CATALOG = Object.freeze({
  sourceUrl:'https://platform.stepfun.com/docs/zh/guides/models/overview',
  planUrl:'https://platform.stepfun.com/docs/zh/step-plan/overview',
  verifiedAt:'2026-08-14',
  reasoning:Object.freeze([
    Object.freeze({
      id:'step-3.7-flash',
      name:'Step 3.7 Flash',
      badge:'默认最强',
      summary:'旗舰多模态推理，适合 Agent、代码、图片和视频理解。',
      capabilities:Object.freeze(['推理', 'Agent', '代码', '图片理解', '视频理解']),
      efforts:Object.freeze(['low', 'medium', 'high']),
      recommendedEffort:'medium',
      recommended:true,
    }),
    Object.freeze({
      id:'step-router-v1',
      name:'Step Router V1',
      badge:'自动选模',
      summary:'按任务自动在 DeepSeek V4 Pro 与 Step 3.7 Flash 之间路由；不适合图片、文档输入。',
      capabilities:Object.freeze(['自动路由', '文本', 'Agent']),
      efforts:Object.freeze(['none', 'low', 'medium']),
      recommendedEffort:'medium',
      recommended:false,
    }),
    Object.freeze({
      id:'step-3.5-flash-2603',
      name:'Step 3.5 Flash 2603',
      badge:'高频省量',
      summary:'高频 Agent 优化，速度快、Token 效率高，适合重复性较强的文本任务。',
      capabilities:Object.freeze(['文本', 'Agent', '代码', '低推理模式']),
      efforts:Object.freeze(['low', 'medium']),
      recommendedEffort:'low',
      recommended:false,
    }),
    Object.freeze({
      id:'step-3.5-flash',
      name:'Step 3.5 Flash',
      badge:'纯文本旗舰',
      summary:'高速纯文本推理，适合长程文本任务和稳定工具调用。',
      capabilities:Object.freeze(['文本', '推理', 'Agent', '代码']),
      efforts:Object.freeze(['none', 'low', 'medium']),
      recommendedEffort:'medium',
      recommended:false,
    }),
  ]),
  capabilities:Object.freeze([
    Object.freeze({ id:'step-image-edit-2', name:'Step Image Edit 2', capability:'文生图 / 图片编辑', owner:'小创' }),
    Object.freeze({ id:'stepaudio-2.5-asr', name:'StepAudio 2.5 ASR', capability:'语音识别', owner:'小D' }),
    Object.freeze({ id:'stepaudio-2.5-tts', name:'StepAudio 2.5 TTS', capability:'配音', owner:'小创' }),
    Object.freeze({ id:'stepaudio-2.5-chat', name:'StepAudio 2.5 Chat', capability:'语音理解', owner:'需要时' }),
    Object.freeze({ id:'stepaudio-2.5-realtime', name:'StepAudio 2.5 Realtime', capability:'实时语音对话', owner:'需要时' }),
  ]),
});

export class StepFunModelPolicyService {
  clock: any;
  configClient: any;
  filePath: string;
  hermesHome: string;
  profileRoot: string;
  policy: any;
  running: Promise<any> | null;
  catalogClient: any;
  accountCatalog: any;

  static async open({ dataDir, ...options }: any) {
    const filePath = path.join(path.resolve(dataDir), 'stepfun-model-policy.json');
    let policy = null;
    try {
      policy = JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return new StepFunModelPolicyService({ ...options, filePath, policy });
  }

  constructor({
    filePath,
    policy = null,
    profileRoot = path.join(os.homedir(), '.hermes', 'profiles'),
    configClient = new HermesConfigClient(),
    catalogClient = new HermesModelCatalogClient(),
    clock = () => new Date(),
  }: any) {
    this.filePath = path.resolve(filePath);
    this.profileRoot = path.resolve(profileRoot);
    this.hermesHome = path.dirname(this.profileRoot);
    this.configClient = configClient;
    this.catalogClient = catalogClient;
    this.clock = clock;
    this.policy = policy ? normalizeStoredPolicy(policy) : null;
    this.running = null;
    this.accountCatalog = null;
  }

  snapshot(manifests: any[] = []) {
    const employees = fleetManifests(manifests);
    const policy = this.policy || seedPolicy(employees);
    return {
      catalog:publicCatalog(this.accountCatalog),
      policy:publicPolicy(policy),
      employees:employees.map((manifest: any) => ({
        agentId:manifest.agentId,
        name:manifest.name,
        role:manifest.role,
        ...this.selectionFor(manifest.agentId, manifest, policy),
      })),
      message:'保存后作用于新会话和下一次任务；正在执行的会话不会被中途换脑。',
    };
  }

  async refreshCatalog(manifests: any[] = []) {
    try {
      const models = await this.catalogClient.list(path.join(this.profileRoot, 'ajun'));
      const validModels = [...new Set((Array.isArray(models) ? models : [])
        .map((model: any) => String(model || '').trim())
        .filter((model: string) => MODEL_ID_PATTERN.test(model)))];
      if (!validModels.length) throw new Error('当前 StepFun 账号没有返回可用模型。');
      this.accountCatalog = {
        models:validModels,
        refreshedAt:this.clock().toISOString(),
      };
      return this.snapshot(manifests);
    } catch (error: any) {
      throw new StepFunModelPolicyError(`刷新失败：${safeMessage(error)}`);
    }
  }

  selectionFor(agentId: any, manifest: any = null, policy: any = this.policy) {
    const resolvedPolicy = policy || seedPolicy(manifest ? [manifest] : []);
    const override = resolvedPolicy.overrides?.[agentId];
    const selection = override || resolvedPolicy.default || manifestSelection(manifest);
    return { ...selection, source:override ? 'override' : 'default' };
  }

  applyToManifest(manifest: any) {
    if (!manifest || manifest?.interaction?.runtime !== 'hermes-profile') return manifest;
    const selection = this.selectionFor(manifest.agentId, manifest);
    return {
      ...manifest,
      runtimeCapabilities:{
        ...(manifest.runtimeCapabilities || {}),
        modelSelection:{ provider:'stepfun', model:selection.model },
      },
    };
  }

  async update(input: any, manifests: any[] = []) {
    if (this.running) throw new StepFunModelPolicyError('模型策略正在保存，请稍后再试。');
    this.running = this.updateOnce(input, manifests).finally(() => { this.running = null; });
    return this.running;
  }

  async updateOnce(input: any, manifests: any[]) {
    const employees = fleetManifests(manifests);
    const allowedAgentIds = new Set(employees.map((item: any) => item.agentId));
    const nextPolicy = normalizeInputPolicy(input, allowedAgentIds, this.clock());
    const targets = [
      { id:'default', home:this.hermesHome, selection:nextPolicy.default },
      ...employees.map((manifest: any) => ({
        id:manifest.agentId,
        home:path.join(this.profileRoot, manifest.agentId),
        selection:nextPolicy.overrides[manifest.agentId] || nextPolicy.default,
      })),
    ];
    const rollback: any[] = [];
    try {
      for (const target of targets) {
        await this.setConfig(target.home, 'model.default', target.selection.model, rollback);
        await this.setConfig(target.home, 'model.provider', 'custom:sstefun', rollback);
        await this.setConfig(target.home, 'agent.reasoning_effort', target.selection.reasoningEffort, rollback);
      }
      await writeJsonAtomic(this.filePath, nextPolicy);
      this.policy = nextPolicy;
      return this.snapshot(employees);
    } catch (error: any) {
      await rollbackConfig(rollback, this.configClient);
      throw new StepFunModelPolicyError(`模型策略未保存，已回滚：${safeMessage(error)}`);
    }
  }

  async setConfig(home: string, key: string, value: string, rollback: any[]) {
    const previous = await this.configClient.get(home, key);
    await this.configClient.set(home, key, value);
    rollback.push({ home, key, previous });
  }
}

export class StepFunModelPolicyError extends Error {}

class HermesConfigClient {
  command: string;
  constructor(command = process.env.AJUN_HERMES_COMMAND || path.join(os.homedir(), '.local', 'bin', 'hermes')) {
    this.command = command;
  }
  async get(home: string, key: string) {
    try {
      const result: any = await execFile(this.command, ['config', 'get', key], configOptions(home));
      return String(result.stdout || '').trim();
    } catch {
      return '';
    }
  }
  async set(home: string, key: string, value: string) {
    await execFile(this.command, ['config', 'set', key, value], configOptions(home));
  }
  async unset(home: string, key: string) {
    await execFile(this.command, ['config', 'unset', key], configOptions(home));
  }
}

class HermesModelCatalogClient {
  python: string;
  constructor(python = process.env.AJUN_HERMES_PYTHON
    || path.join(os.homedir(), '.hermes', 'hermes-agent', 'venv', 'bin', 'python')) {
    this.python = python;
  }
  async list(home: string) {
    const result: any = await execFile(this.python, ['-c', HERMES_MODEL_DISCOVERY_SCRIPT], {
      ...configOptions(home),
      timeout:30_000,
    });
    const parsed = JSON.parse(String(result.stdout || '[]'));
    if (!Array.isArray(parsed)) throw new Error('Hermes 返回了无法识别的模型清单。');
    return parsed;
  }
}

function configOptions(home: string) {
  return {
    env:{ ...process.env, HERMES_HOME:home, NO_COLOR:'1' },
    timeout:10_000,
    maxBuffer:256 * 1024,
  };
}

function fleetManifests(manifests: any[]) {
  return (Array.isArray(manifests) ? manifests : [])
    .filter((manifest: any) => manifest?.status === 'active'
      && manifest?.interaction?.runtime === 'hermes-profile'
      && manifest?.executionOwner === 'paperclip-hermes')
    .sort((left: any, right: any) => String(left.name).localeCompare(String(right.name), 'zh-Hans-CN'));
}

function seedPolicy(manifests: any[]) {
  const defaultSelection = { model:'step-3.7-flash', reasoningEffort:'medium' };
  const overrides: Record<string, any> = {};
  for (const manifest of manifests) {
    const selection = {
      model:'step-3.7-flash',
      reasoningEffort:recommendedEffortForAgent(manifest.agentId),
    };
    if (selection.model !== defaultSelection.model || selection.reasoningEffort !== defaultSelection.reasoningEffort) {
      overrides[manifest.agentId] = selection;
    }
  }
  return { version:1, provider:'stepfun', default:defaultSelection, overrides, updatedAt:null };
}

function recommendedEffortForAgent(agentId: string) {
  if (['architect', 'reviewer', 'technical-expert', 'intel-researcher'].includes(agentId)) return 'high';
  if (['office-assistant', 'operator', 'xiaod'].includes(agentId)) return 'low';
  return 'medium';
}

function manifestSelection(manifest: any) {
  const requestedModel = String(manifest?.runtimeCapabilities?.modelSelection?.model || '').trim();
  const model = modelById(requestedModel) ? requestedModel : 'step-3.7-flash';
  const requestedEffort = String(manifest?.autonomyBudgetPolicy?.reasoningEffort || '').trim();
  const efforts = new Set(modelById(model)?.efforts || []);
  const reasoningEffort = requestedEffort === 'none' && efforts.has('low')
    ? 'low'
    : efforts.has(requestedEffort)
    ? requestedEffort
    : modelById(model)?.recommendedEffort || 'medium';
  return { model, reasoningEffort };
}

function normalizeInputPolicy(input: any, allowedAgentIds: Set<string>, now: Date) {
  const value = input?.policy || input;
  const defaultSelection = normalizeSelection(value?.default);
  const rawOverrides = value?.overrides && typeof value.overrides === 'object' && !Array.isArray(value.overrides)
    ? value.overrides
    : {};
  const overrides: Record<string, any> = {};
  for (const [agentId, selection] of Object.entries(rawOverrides)) {
    if (!allowedAgentIds.has(agentId)) throw new StepFunModelPolicyError(`未知员工：${agentId}。`);
    const normalized = normalizeSelection(selection);
    if (normalized.model !== defaultSelection.model || normalized.reasoningEffort !== defaultSelection.reasoningEffort) {
      overrides[agentId] = normalized;
    }
  }
  return {
    version:1,
    provider:'stepfun',
    default:defaultSelection,
    overrides,
    updatedAt:now.toISOString(),
  };
}

function normalizeStoredPolicy(value: any) {
  const allowedAgentIds = new Set(Object.keys(value?.overrides || {}));
  return normalizeInputPolicy(value, allowedAgentIds, new Date(value?.updatedAt || 0));
}

function normalizeSelection(value: any) {
  const model = String(value?.model || '').trim();
  const reasoningEffort = String(value?.reasoningEffort || '').trim();
  const catalog = modelById(model);
  if (!MODEL_ID_PATTERN.test(model) || !catalog) throw new StepFunModelPolicyError('请选择受支持的 Step Plan 推理模型。');
  if (!REASONING_EFFORTS.has(reasoningEffort) || !catalog.efforts.includes(reasoningEffort)) {
    throw new StepFunModelPolicyError(`${model} 不支持推理强度 ${reasoningEffort || '空值'}。`);
  }
  return { model, reasoningEffort };
}

function modelById(model: string): any {
  return STEPFUN_MODEL_CATALOG.reasoning.find((item: any) => item.id === model) || null;
}

function publicPolicy(policy: any) {
  return JSON.parse(JSON.stringify(policy));
}

function publicCatalog(accountCatalog: any) {
  if (!accountCatalog) return STEPFUN_MODEL_CATALOG;
  const available = new Set<string>(accountCatalog.models as string[]);
  const known = new Set([
    ...STEPFUN_MODEL_CATALOG.reasoning.map((model: any) => model.id),
    ...STEPFUN_MODEL_CATALOG.capabilities.map((model: any) => model.id),
  ]);
  return {
    ...STEPFUN_MODEL_CATALOG,
    reasoning:STEPFUN_MODEL_CATALOG.reasoning.map((model: any) => ({ ...model, available:available.has(model.id) })),
    capabilities:STEPFUN_MODEL_CATALOG.capabilities.map((model: any) => ({ ...model, available:available.has(model.id) })),
    account:{
      models:[...available],
      unknown:[...available].filter((model: string) => !known.has(model)),
      refreshedAt:accountCatalog.refreshedAt,
    },
  };
}

async function rollbackConfig(operations: any[], configClient: any) {
  for (const operation of [...operations].reverse()) {
    try {
      if (operation.previous) await configClient.set(operation.home, operation.key, operation.previous);
      else await configClient.unset(operation.home, operation.key);
    } catch {}
  }
}

async function writeJsonAtomic(filePath: string, value: any) {
  await fs.mkdir(path.dirname(filePath), { recursive:true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode:0o600 });
  await fs.rename(temporary, filePath);
}

function safeMessage(error: any) {
  return String(error?.message || 'Hermes 配置写入失败。').replace(/\s+/g, ' ').slice(0, 180);
}

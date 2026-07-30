import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { M5_ROUTINE_EXECUTION_CONTRACTS } from './m5-routine-execution-contract.js';

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
export const AGENT_ARMY_REPOSITORY_ROOT = path.resolve(sourceDirectory, '../../..');
const agentsDirectory = path.join(AGENT_ARMY_REPOSITORY_ROOT, 'agents');

// Keep the historical export name for callers, but derive the fleet from the
// same manifest contract Paperclip uses. Adding an active Hermes employee no
// longer requires editing a second hard-coded roster.
export const GOVERNANCE_HERMES_AGENT_IDS = Object.freeze(discoverGovernanceHermesAgentIds());
const GOVERNANCE_HERMES_AGENT_ID_SET = new Set(GOVERNANCE_HERMES_AGENT_IDS);

export function discoverGovernanceHermesAgentIds({
  directory = agentsDirectory,
  readdir = fs.readdirSync,
  readFile = fs.readFileSync
} = {}) {
  const ids = [];
  for (const entry of readdir(directory, { withFileTypes:true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(directory, entry.name, 'manifest.json');
    let manifest;
    try {
      manifest = JSON.parse(readFile(manifestPath, 'utf8'));
    } catch {
      continue;
    }
    if (usesPaperclipHermesExecution(manifest)) ids.push(String(manifest.agentId || '').trim());
  }
  return [...new Set(ids.filter(Boolean))].sort();
}

export function isGovernanceHermesAgent(agentOrId) {
  const agentId = typeof agentOrId === 'string' ? agentOrId : agentOrId?.agentId;
  return GOVERNANCE_HERMES_AGENT_ID_SET.has(String(agentId || '').trim());
}

export function usesPaperclipHermesExecution(manifest) {
  return manifest?.status === 'active'
    && manifest?.interaction?.runtime === 'hermes-profile'
    && manifest?.executionOwner === 'paperclip-hermes';
}

export function requiresDirectFeishuGateway(manifest) {
  return usesPaperclipHermesExecution(manifest)
    && manifest?.interaction?.directFeishu === 'required';
}

export function hermesProfileHome(agentId) {
  const home = String(process.env.HOME || '').trim();
  if (!home || home === path.parse(home).root) throw new Error('无法确定安全的 Hermes Profile 根目录。');
  const profileRoot = path.resolve(home, '.hermes/profiles');
  const profileHome = path.resolve(profileRoot, String(agentId || ''));
  if (!profileHome.startsWith(`${profileRoot}${path.sep}`)) throw new Error('Hermes Profile 路径越界。');
  return profileHome;
}

export function paperclipHermesAdapterConfig(manifest) {
  if (!usesPaperclipHermesExecution(manifest)) return {};
  const promptPath = path.resolve(AGENT_ARMY_REPOSITORY_ROOT, String(manifest.promptRef || ''));
  if (!promptPath.startsWith(`${AGENT_ARMY_REPOSITORY_ROOT}${path.sep}`)) throw new Error('员工 Prompt 路径越界。');
  assertM5HermesExecutionManifest(manifest);
  assertM5HermesExecutionPrompt(manifest, fs.readFileSync(promptPath, 'utf8'));
  const paperclipToolsets = safeStringList(manifest.runtimeCapabilities?.paperclipToolsets);
  const modelSelection = safeModelSelection(manifest.runtimeCapabilities?.modelSelection);
  const fallbackModels = safeFallbackModels(manifest.runtimeCapabilities?.fallbackModels);
  if (fallbackModels.length && !modelSelection.provider) throw new Error('Hermes fallback 必须绑定主模型。');
  return {
    cwd:AGENT_ARMY_REPOSITORY_ROOT,
    instructionsFilePath:promptPath,
    hermesCommand:path.resolve(String(process.env.HOME || ''), '.local/bin/hermes'),
    ...modelSelection,
    ...(fallbackModels.length ? { fallbackModels } : {}),
    env:{
      HERMES_HOME:hermesProfileHome(manifest.agentId),
      AGENT_ARMY_AGENT_ID:manifest.agentId,
      AGENT_ARMY_ALLOWED_AGENT_IDS:manifest.agentId,
      AGENT_ARMY_ALLOWED_TASK_TYPES:safeStringList(manifest.acceptedTaskTypes).join(','),
      AGENT_ARMY_ALLOWED_MCP_TOOLS:safeStringList(manifest.runtimeCapabilities?.mcpTools).join(','),
      AGENT_ARMY_ALLOW_MISSIONS:manifest.runtimeCapabilities?.mcpTools?.includes('mission_create') ? 'true' : 'false'
    },
    toolsets:paperclipToolsets.join(','),
    persistSession:true,
    quiet:true,
    timeoutSec:1800,
    graceSec:15
  };
}

export function assertM5HermesExecutionManifest(manifest) {
  const contracts = M5_ROUTINE_EXECUTION_CONTRACTS.filter((item) =>
    item.executionMode === 'hermes'
    && item.agentId === manifest?.agentId,
  );
  if (!contracts.length) return true;
  const acceptedTaskTypes = new Set(safeStringList(manifest.acceptedTaskTypes));
  const mcpTools = new Set(safeStringList(manifest.runtimeCapabilities?.mcpTools));
  for (const contract of contracts) {
    if (!acceptedTaskTypes.has(contract.taskType)) {
      throw new Error(
        `${manifest.agentId} Manifest 缺少 M5 任务类型 ${contract.taskType}。`,
      );
    }
    const executionTool = contract.executionTool?.id;
    if (executionTool && !mcpTools.has(executionTool)) {
      throw new Error(
        `${manifest.agentId} Manifest 缺少 M5 MCP 工具 ${executionTool}。`,
      );
    }
  }
  return true;
}

export function assertM5HermesExecutionPrompt(manifest, promptText) {
  const taskTypes = M5_ROUTINE_EXECUTION_CONTRACTS
    .filter((item) =>
      item.executionMode === 'hermes'
      && item.agentId === manifest?.agentId
      && item.executionTool?.id === 'm5_stage_execute',
    )
    .map((item) => item.taskType);
  if (!taskTypes.length) return true;
  const text = String(promptText || '');
  for (const taskType of taskTypes) {
    if (!text.includes(taskType)) {
      throw new Error(
        `${manifest.agentId} SOUL 缺少 M5 任务说明 ${taskType}。`,
      );
    }
  }
  return true;
}

function safeStringList(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || '').trim()).filter(Boolean))];
}

function safeModelSelection(value) {
  if (!value) return {};
  const provider = String(value.provider || '').trim();
  const model = String(value.model || '').trim();
  const allowedProviders = new Set([
    'openai-codex',
    'openrouter',
    'nous',
    'zai',
    'kimi-coding',
    'minimax',
    'minimax-cn',
    'stepfun'
  ]);
  if (!allowedProviders.has(provider)) throw new Error('Hermes Provider 不在受控白名单中。');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{1,127}$/.test(model)) throw new Error('Hermes 模型标识不合法。');
  if (provider === 'stepfun' && model !== 'step-3.5-flash-2603') {
    throw new Error('StepFun 主模型必须使用受控固定版本。');
  }
  // Paperclip 的 Hermes adapter 尚未把 StepFun 列入 Provider 常量表；
  // 它会把该值安全降为 auto，让 Hermes 在目标 HERMES_HOME Profile
  // 中解析原生 stepfun Provider。不要追加 custom:stepfun：Hermes 0.19
  // 已将 StepFun 作为原生 Provider，旧别名会在任何网络请求前被拒绝。
  // 显式空数组也用于覆盖 Paperclip 里已经保存的旧 extraArgs；
  // 该接口会合并 adapterConfig，省略字段无法清掉历史错误参数。
  return provider === 'stepfun'
    ? { provider, model, extraArgs:[] }
    : { provider, model };
}

function safeFallbackModels(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1) throw new Error('Hermes fallback 模型配置不合法。');
  return value.map((candidate) => {
    const provider = String(candidate?.provider || '').trim();
    const model = String(candidate?.model || '').trim();
    const trigger = String(candidate?.trigger || '').trim();
    if (provider !== 'deepseek') throw new Error('Hermes fallback Provider 不在受控白名单中。');
    if (model !== 'deepseek-v4-flash') throw new Error('Hermes fallback 模型不在受控白名单中。');
    if (trigger !== 'transport_unavailable') throw new Error('Hermes fallback 仅允许连接不可用时触发。');
    return { provider, model, trigger };
  });
}

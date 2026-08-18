import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { M5_ROUTINE_EXECUTION_CONTRACTS } from '@agent-army/m5-kernel/routine-execution-contract';
const sourceDirectory: any = path.dirname(fileURLToPath(import.meta.url));
export const AGENT_ARMY_REPOSITORY_ROOT: any = path.resolve(sourceDirectory, '../../..');
const agentsDirectory: any = path.join(AGENT_ARMY_REPOSITORY_ROOT, 'agents');
const TASK_CARD_POLICIES: any = new Set([
    'routed-task',
    'durable-task',
    'incident-only',
    'disabled',
]);
// Keep the historical export name for callers, but derive the fleet from the
// same manifest contract Paperclip uses. Adding an active Hermes employee no
// longer requires editing a second hard-coded roster.
export const GOVERNANCE_HERMES_AGENT_IDS: any = Object.freeze(discoverGovernanceHermesAgentIds());
const GOVERNANCE_HERMES_AGENT_ID_SET: any = new Set(GOVERNANCE_HERMES_AGENT_IDS);
export function discoverGovernanceHermesAgentIds({ directory = agentsDirectory, readdir = fs.readdirSync, readFile = fs.readFileSync }: any = {}): any {
    const ids: any[] = [];
    for (const entry of readdir(directory, { withFileTypes: true })) {
        if (!entry.isDirectory())
            continue;
        const manifestPath: any = path.join(directory, entry.name, 'manifest.json');
        let manifest: any;
        try {
            manifest = JSON.parse(readFile(manifestPath, 'utf8'));
        }
        catch {
            continue;
        }
        if (usesPaperclipHermesExecution(manifest))
            ids.push(String(manifest.agentId || '').trim());
    }
    return [...new Set(ids.filter(Boolean))].sort();
}
export function isGovernanceHermesAgent(agentOrId: any): any {
    const agentId: any = typeof agentOrId === 'string' ? agentOrId : agentOrId?.agentId;
    return GOVERNANCE_HERMES_AGENT_ID_SET.has(String(agentId || '').trim());
}
export function usesPaperclipHermesExecution(manifest: any): any {
    return manifest?.status === 'active'
        && manifest?.interaction?.runtime === 'hermes-profile'
        && manifest?.executionOwner === 'paperclip-hermes';
}
export function requiresDirectFeishuGateway(manifest: any): any {
    return usesPaperclipHermesExecution(manifest)
        && manifest?.interaction?.directFeishu === 'required';
}
export function hermesProfileHome(agentId: any): any {
    const home: any = String(process.env.HOME || '').trim();
    if (!home || home === path.parse(home).root)
        throw new Error('无法确定安全的 Hermes Profile 根目录。');
    const profileRoot: any = path.resolve(home, '.hermes/profiles');
    const profileHome: any = path.resolve(profileRoot, String(agentId || ''));
    if (!profileHome.startsWith(`${profileRoot}${path.sep}`))
        throw new Error('Hermes Profile 路径越界。');
    return profileHome;
}
export function paperclipHermesAdapterConfig(manifest: any): any {
    if (!usesPaperclipHermesExecution(manifest))
        return {};
    const promptPath: any = path.resolve(AGENT_ARMY_REPOSITORY_ROOT, String(manifest.promptRef || ''));
    if (!promptPath.startsWith(`${AGENT_ARMY_REPOSITORY_ROOT}${path.sep}`))
        throw new Error('员工 Prompt 路径越界。');
    assertM5HermesExecutionManifest(manifest);
    assertM5HermesExecutionPrompt(manifest, fs.readFileSync(promptPath, 'utf8'));
    // Paperclip runs are headless. Interactive clarification can wait until a
    // timeout and still leave an apparently successful process record, so it
    // must not be exposed on this surface.
    const paperclipToolsets: any = safeStringList(manifest.runtimeCapabilities?.paperclipToolsets)
        .filter((toolset: any): any => toolset !== 'clarify');
    const modelSelection: any = safeModelSelection(manifest.runtimeCapabilities?.modelSelection);
    const fallbackModels: any = safeFallbackModels(manifest.runtimeCapabilities?.fallbackModels);
    if (fallbackModels.length && !modelSelection.provider)
        throw new Error('Hermes fallback 必须绑定主模型。');
    return {
        cwd: AGENT_ARMY_REPOSITORY_ROOT,
        instructionsFilePath: promptPath,
        hermesCommand: path.resolve(String(process.env.HOME || ''), '.local/bin/hermes'),
        ...modelSelection,
        // Paperclip 会合并 adapterConfig；空数组必须显式下发，才能清掉旧策略。
        fallbackModels,
        extraArgs: [],
        env: {
            HERMES_HOME: hermesProfileHome(manifest.agentId),
            AGENT_ARMY_AGENT_ID: manifest.agentId,
            AGENT_ARMY_PROFILE_ID: manifest.agentId,
            AGENT_ARMY_ALLOWED_AGENT_IDS: manifest.agentId,
            AGENT_ARMY_ALLOWED_TASK_TYPES: safeStringList(manifest.acceptedTaskTypes).join(','),
            AGENT_ARMY_ALLOWED_MCP_TOOLS: safeStringList(manifest.runtimeCapabilities?.mcpTools).join(','),
            AGENT_ARMY_ALLOWED_LOCAL_AI_CAPABILITIES: safeStringList(manifest.runtimeCapabilities?.localAiCapabilities).join(','),
            AGENT_ARMY_ALLOW_MISSIONS: manifest.runtimeCapabilities?.mcpTools?.includes('mission_create') ? 'true' : 'false',
            AGENT_ARMY_TASK_CARD_POLICY: taskCardPolicyForManifest(manifest),
        },
        toolsets: paperclipToolsets.join(','),
        persistSession: true,
        quiet: true,
        timeoutSec: 1800,
        graceSec: 15
    };
}
export function hermesRuntimePolicyForManifest(manifest: any): any {
    const budget: any = manifest?.autonomyBudgetPolicy || {};
    const maxTurns: any = Number(budget.maxTurns);
    const apiMaxRetries: any = Number(budget.apiMaxRetries);
    const reasoningEffort: any = String(budget.reasoningEffort || '').trim();
    if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 20) {
        throw new Error('Hermes 最大轮次必须在 1 到 20 之间。');
    }
    if (!['none', 'low', 'medium'].includes(reasoningEffort)) {
        throw new Error('Hermes 推理强度必须是 none、low 或 medium。');
    }
    if (!Number.isSafeInteger(apiMaxRetries) || apiMaxRetries < 0 || apiMaxRetries > 3) {
        throw new Error('Hermes API 重试次数必须在 0 到 3 之间。');
    }
    if (budget.toolLoopHardStop !== true) {
        throw new Error('Hermes 无人值守岗位必须开启工具循环硬停止。');
    }
    if (Number(budget.maxModelCalls) < maxTurns) {
        throw new Error('模型调用预算不能小于 Hermes 最大轮次。');
    }
    return Object.freeze({
        // LiteLLM 曾在转发层统一限制输出；直连 Provider 后由 Hermes
        // 自己传递同一上限，避免单次回复无限增长。
        model: Object.freeze({ maxTokens: 8_192 }),
        agent: Object.freeze({ maxTurns, reasoningEffort, apiMaxRetries }),
        toolLoopGuardrails: Object.freeze({ hardStopEnabled: true }),
        tools: Object.freeze({ toolSearch: Object.freeze({ enabled: 'off' }) }),
        compression: Object.freeze({
            enabled: true,
            threshold: 0.5,
            targetRatio: 0.2,
            protectFirstN: 3,
            protectLastN: 8,
        }),
        memory: Object.freeze({ writeApproval: true, nudgeInterval: 0 }),
        sessions: Object.freeze({ autoPrune: true, retentionDays: 30 }),
        sessionReset: Object.freeze({ mode: 'idle', idleMinutes: 1440, notify: true }),
    });
}
export function taskCardPolicyForManifest(manifest: any): any {
    const value: any = String(manifest?.interaction?.taskCardPolicy || 'disabled').trim();
    if (!TASK_CARD_POLICIES.has(value)) {
        throw new Error('飞书任务卡策略不在受控白名单中。');
    }
    return value;
}
export function assertM5HermesExecutionManifest(manifest: any): any {
    const contracts: any = M5_ROUTINE_EXECUTION_CONTRACTS.filter((item: any): any => item.executionMode === 'hermes'
        && item.agentId === manifest?.agentId);
    if (!contracts.length)
        return true;
    const acceptedTaskTypes: any = new Set(safeStringList(manifest.acceptedTaskTypes));
    const mcpTools: any = new Set(safeStringList(manifest.runtimeCapabilities?.mcpTools));
    for (const contract of contracts) {
        if (!acceptedTaskTypes.has(contract.taskType)) {
            throw new Error(`${manifest.agentId} Manifest 缺少 M5 任务类型 ${contract.taskType}。`);
        }
        const executionTool: any = contract.executionTool?.id;
        if (executionTool && !mcpTools.has(executionTool)) {
            throw new Error(`${manifest.agentId} Manifest 缺少 M5 MCP 工具 ${executionTool}。`);
        }
    }
    return true;
}
export function assertM5HermesExecutionPrompt(manifest: any, promptText: any): any {
    const taskTypes: any = M5_ROUTINE_EXECUTION_CONTRACTS
        .filter((item: any): any => item.executionMode === 'hermes'
        && item.agentId === manifest?.agentId
        && item.executionTool?.id === 'm5_stage_execute')
        .map((item: any): any => item.taskType);
    if (!taskTypes.length)
        return true;
    const text: any = String(promptText || '');
    for (const taskType of taskTypes) {
        if (!text.includes(taskType)) {
            throw new Error(`${manifest.agentId} SOUL 缺少 M5 任务说明 ${taskType}。`);
        }
    }
    return true;
}
function safeStringList(value: any): any {
    return [...new Set((Array.isArray(value) ? value : []).map((item: any): any => String(item || '').trim()).filter(Boolean))];
}
function safeModelSelection(value: any): any {
    if (!value)
        return {};
    const provider: any = String(value.provider || '').trim();
    const model: any = String(value.model || '').trim();
    const allowedProviders: any = new Set([
        'openai-codex',
        'openrouter',
        'nous',
        'zai',
        'kimi-coding',
        'minimax',
        'minimax-cn',
        'stepfun',
        'deepseek'
    ]);
    if (!allowedProviders.has(provider))
        throw new Error('Hermes Provider 不在受控白名单中。');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{1,127}$/.test(model))
        throw new Error('Hermes 模型标识不合法。');
    if (provider === 'stepfun' && ![
        'step-3.7-flash',
        'step-router-v1',
        'step-3.5-flash-2603',
        'step-3.5-flash',
    ].includes(model)) {
        throw new Error('StepFun 主模型不在受控推理模型目录中。');
    }
    if (provider === 'deepseek' && model !== 'deepseek-v4-flash') {
        throw new Error('DeepSeek 主模型必须使用受控固定版本。');
    }
    // Paperclip 的 Hermes adapter 尚未把 StepFun 列入 Provider 常量表；
    // 它会把该值安全降为 auto，让 Hermes 在目标 HERMES_HOME Profile
    // 中解析当前受控的 StepFun Provider。季度 Step Plan 可由 Profile
    // 内的具名 custom provider 承载，仓库契约仍保持 provider=stepfun。
    // 显式空数组也用于覆盖 Paperclip 里已经保存的旧 extraArgs；
    // 该接口会合并 adapterConfig，省略字段无法清掉历史错误参数。
    return { provider, model };
}
function safeFallbackModels(value: any): any {
    if (value === undefined)
        return [];
    if (!Array.isArray(value) || value.length > 1)
        throw new Error('Hermes fallback 模型配置不合法。');
    return value.map((candidate: any): any => {
        const provider: any = String(candidate?.provider || '').trim();
        const model: any = String(candidate?.model || '').trim();
        const trigger: any = String(candidate?.trigger || '').trim();
        if (provider !== 'deepseek')
            throw new Error('Hermes fallback Provider 不在受控白名单中。');
        if (model !== 'deepseek-v4-flash')
            throw new Error('Hermes fallback 模型不在受控白名单中。');
        if (trigger !== 'transport_unavailable')
            throw new Error('Hermes fallback 仅允许连接不可用时触发。');
        return { provider, model, trigger };
    });
}

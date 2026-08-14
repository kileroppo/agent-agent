import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const DEFINITIONS: any = Object.freeze({
    'yichen-web-research': { owner: 'intel-researcher', readiness: 'ready' },
    'yichen-unified-search': { owner: 'intel-researcher', readiness: 'ready' },
    'yichen-content-archive': { owners: ['intel-researcher', 'xiaod'], readiness: 'ready' },
    'yichen-grok-consult': { owner: 'intel-researcher', readiness: 'needs_login' },
    'yichen-asr': { owner: 'xiaod', readiness: 'needs_setup', recovery: '请配置 StepFun 或火山 ASR 凭据后再用；不会自动跨供应商重试。' },
    'yichen-summary': { owner: 'office-assistant', readiness: 'ready', executionBoundary: 'knowledge.archive.write' },
    'open-kimi-ppt': {
        owner: 'office-assistant',
        readiness: 'ready',
        entryPath: 'open-kimi-ppt-skill/skills/open-kimi-ppt/SKILL.md',
        packagePath: 'open-kimi-ppt-skill/package.json',
        executionBoundary: 'office.pptd.write + offline office.pptx.export',
        dataBoundary: 'assigned-task-and-workspace-only',
        externalSideEffects: [],
        recovery: 'PPTD 需要共享技能源码校验通过；PPTX 需要版本和源码校验通过的隔离 Node、Artifact Tool、JSZip 与 Sharp。本地运行时不会自动安装或升级。',
    },
    'yichen-wechat-local-vault': { owner: 'wechat-chat-retriever', readiness: 'ready', executionBoundary: 'wechat.local-vault.chat.read' },
});
export class SkillExecutionRegistry {
    adapters: any;
    grokAccessMode: any;
    grokAuthPath: any;
    readinessOverrides: any;
    readinessProbes: any;
    sharedRoot: any;
    constructor({ sharedRoot = process.env.AGENT_ARMY_SHARED_SKILLS_ROOT || path.join(os.homedir(), 'Documents/work/AIcode/skills-lib'), grokAuthPath = path.join(os.homedir(), '.grok/auth.json'), grokAccessMode = process.env.AGENT_ARMY_GROK_ACCESS || 'auto', adapters = {}, readinessOverrides = {}, readinessProbes = {}, }: any = {}) {
        this.sharedRoot = path.resolve(sharedRoot);
        this.grokAuthPath = path.resolve(grokAuthPath);
        this.grokAccessMode = normalizeGrokAccessMode(grokAccessMode);
        this.adapters = { ...adapters };
        this.readinessOverrides = { ...readinessOverrides };
        this.readinessProbes = { ...readinessProbes };
    }
    async overview(): Promise<any> {
        return Promise.all(Object.entries(DEFINITIONS).map(async ([slug, definition]: any): Promise<any> => {
            const entryPath: any = definition.entryPath || `${slug}/SKILL.md`;
            const installed: any = await fs.access(path.join(this.sharedRoot, entryPath)).then((): any => true).catch((): any => false);
            const probe: any = installed && typeof this.readinessProbes[slug] === 'function'
                ? await this.readinessProbes[slug]().catch((error: any): any => ({
                    status: 'needs_capability',
                    recovery: `能力探针失败：${String(error?.message || error).slice(0, 200)}`,
                }))
                : null;
            const configured: any = this.readinessOverrides[slug]
                || probe?.status
                || await environmentReadiness(slug, {
                    grokAuthPath: this.grokAuthPath,
                    grokAccessMode: this.grokAccessMode,
                })
                || definition.readiness;
            const status: any = installed ? configured : 'unavailable';
            return {
                slug,
                owners: definition.owners || [definition.owner],
                status,
                entryPath,
                source: probe?.source || await skillSource(this.sharedRoot, definition),
                modes: probe?.modes || defaultModes(status),
                dataBoundary: definition.dataBoundary || null,
                externalSideEffects: definition.externalSideEffects || [],
                executionBoundary: definition.executionBoundary || 'bounded-adapter-only',
                recovery: installed ? probe?.recovery || recoveryFor(slug, status, definition) : '技能目录未安装或不完整。',
                genericTerminalAccess: false,
                genericBrowserAccess: false,
            };
        }));
    }
    async execute(slug: any, input: any, context: any = {}): Promise<any> {
        const capability: any = (await this.overview()).find((item: any): any => item.slug === slug);
        if (!capability || capability.status !== 'ready') {
            throw skillError('skill_not_ready', `技能 ${slug} 当前为 ${capability?.status || 'unavailable'}。`);
        }
        const adapter: any = this.adapters[slug];
        if (typeof adapter !== 'function') {
            throw skillError('skill_adapter_missing', `技能 ${slug} 没有受控执行适配器；已拒绝开放通用终端或浏览器。`);
        }
        if (!capability.owners.includes(context.agentId)) {
            throw skillError('skill_owner_mismatch', `岗位 ${context.agentId || 'unknown'} 未获准使用技能 ${slug}。`);
        }
        return adapter(input, context);
    }
}
async function skillSource(sharedRoot: any, definition: any): Promise<any> {
    if (!definition.packagePath)
        return null;
    try {
        const packageDocument: any = JSON.parse(await fs.readFile(path.join(sharedRoot, definition.packagePath), 'utf8'));
        return Object.freeze({ packageVersion: String(packageDocument.version || '') || null });
    }
    catch {
        return null;
    }
}
function defaultModes(status: any): any {
    return Object.freeze({ execute: Object.freeze({ status }) });
}
async function environmentReadiness(slug: any, { grokAuthPath, grokAccessMode }: any): Promise<any> {
    if (slug === 'yichen-asr') {
        return process.env.STEPFUN_API_KEY || process.env.ARK_API_KEY ? 'ready' : 'needs_setup';
    }
    if (slug === 'yichen-grok-consult') {
        if (grokAccessMode === 'disabled')
            return 'not_enabled';
        const authenticated: any = await fs.stat(grokAuthPath)
            .then((stat: any): any => stat.isFile())
            .catch((): any => false);
        if (!authenticated)
            return 'needs_login';
        return grokAccessMode === 'subscribed' ? 'ready' : 'needs_subscription';
    }
    return null;
}
function recoveryFor(slug: any, status: any, definition: any): any {
    if (status === 'ready')
        return null;
    if (slug === 'yichen-grok-consult') {
        if (status === 'not_enabled')
            return '当前未订阅 Grok，已停用；小R继续使用网页研究和统一搜索。';
        if (status === 'needs_subscription')
            return '已登录，但未确认订阅额度可用；未订阅时可保持停用。';
        if (status === 'needs_login')
            return '请在本机终端运行 grok login；Agent 不会代填账号。';
    }
    return definition.recovery || null;
}
function normalizeGrokAccessMode(value: any): any {
    const normalized: any = String(value || 'auto').trim().toLowerCase();
    return ['auto', 'subscribed', 'disabled'].includes(normalized) ? normalized : 'auto';
}
function skillError(code: any, message: any): any {
    return Object.assign(new Error(message), { code, category: 'manual', retryable: false });
}

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFINITIONS = Object.freeze({
  'yichen-web-research':{ owner:'intel-researcher', readiness:'ready' },
  'yichen-unified-search':{ owner:'intel-researcher', readiness:'ready' },
  'yichen-content-archive':{ owners:['intel-researcher', 'xiaod'], readiness:'ready' },
  'yichen-grok-consult':{ owner:'intel-researcher', readiness:'needs_login', recovery:'请在本机终端运行 grok login；Agent 不会代填账号。' },
  'yichen-asr':{ owner:'xiaod', readiness:'needs_setup', recovery:'请配置 StepFun 或火山 ASR 凭据后再用；不会自动跨供应商重试。' },
  'yichen-summary':{ owner:'office-assistant', readiness:'ready', executionBoundary:'knowledge.archive.write' },
  'yichen-wechat-local-vault':{ owner:'wechat-chat-retriever', readiness:'ready', executionBoundary:'wechat.local-vault.chat.read' },
});

export class SkillExecutionRegistry {
  constructor({
    sharedRoot = process.env.AGENT_ARMY_SHARED_SKILLS_ROOT || path.join(os.homedir(), 'Documents/work/AIcode/skills-lib'),
    grokAuthPath = path.join(os.homedir(), '.grok/auth.json'),
    adapters = {},
    readinessOverrides = {},
  } = {}) {
    this.sharedRoot = path.resolve(sharedRoot);
    this.grokAuthPath = path.resolve(grokAuthPath);
    this.adapters = { ...adapters };
    this.readinessOverrides = { ...readinessOverrides };
  }

  async overview() {
    return Promise.all(Object.entries(DEFINITIONS).map(async ([slug, definition]) => {
      const installed = await fs.access(path.join(this.sharedRoot, slug, 'SKILL.md')).then(() => true).catch(() => false);
      const configured = this.readinessOverrides[slug]
        || await environmentReadiness(slug, { grokAuthPath:this.grokAuthPath })
        || definition.readiness;
      return {
        slug,
        owners:definition.owners || [definition.owner],
        status:installed ? configured : 'unavailable',
        executionBoundary:definition.executionBoundary || 'bounded-adapter-only',
        recovery:installed ? definition.recovery || null : '技能目录未安装或不完整。',
        genericTerminalAccess:false,
        genericBrowserAccess:false,
      };
    }));
  }

  async execute(slug, input, context = {}) {
    const capability = (await this.overview()).find((item) => item.slug === slug);
    if (!capability || capability.status !== 'ready') {
      throw skillError('skill_not_ready', `技能 ${slug} 当前为 ${capability?.status || 'unavailable'}。`);
    }
    const adapter = this.adapters[slug];
    if (typeof adapter !== 'function') {
      throw skillError('skill_adapter_missing', `技能 ${slug} 没有受控执行适配器；已拒绝开放通用终端或浏览器。`);
    }
    if (!capability.owners.includes(context.agentId)) {
      throw skillError('skill_owner_mismatch', `岗位 ${context.agentId || 'unknown'} 未获准使用技能 ${slug}。`);
    }
    return adapter(input, context);
  }
}

async function environmentReadiness(slug, { grokAuthPath }) {
  if (slug === 'yichen-asr') {
    return process.env.STEPFUN_API_KEY || process.env.ARK_API_KEY ? 'ready' : 'needs_setup';
  }
  if (slug === 'yichen-grok-consult') {
    return fs.stat(grokAuthPath).then((stat) => stat.isFile() ? 'ready' : 'needs_login').catch(() => 'needs_login');
  }
  return null;
}

function skillError(code, message) {
  return Object.assign(new Error(message), { code, category:'manual', retryable:false });
}

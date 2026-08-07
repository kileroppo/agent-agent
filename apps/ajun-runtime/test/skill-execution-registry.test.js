import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SkillExecutionRegistry } from '../src/skill-execution-registry.js';

async function rootWith(...slugs) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-registry-'));
  for (const slug of slugs) {
    await fs.mkdir(path.join(root, slug), { recursive:true });
    await fs.writeFile(path.join(root, slug, 'SKILL.md'), '# test\n');
  }
  return root;
}

test('就绪状态明确区分可用、需登录、需配置和未安装', async () => {
  const sharedRoot = await rootWith('yichen-web-research', 'yichen-grok-consult', 'yichen-asr');
  const registry = new SkillExecutionRegistry({
    sharedRoot,
    grokAuthPath:path.join(sharedRoot, 'missing-grok-auth.json'),
    readinessOverrides:{ 'yichen-asr':'needs_setup' }
  });
  const overview = await registry.overview();
  assert.equal(overview.find((item) => item.slug === 'yichen-web-research').status, 'ready');
  assert.equal(overview.find((item) => item.slug === 'yichen-grok-consult').status, 'needs_login');
  assert.equal(overview.find((item) => item.slug === 'yichen-asr').status, 'needs_setup');
  assert.equal(overview.find((item) => item.slug === 'yichen-summary').status, 'unavailable');
});

test('只有声明岗位能通过受控适配器执行，不存在适配器时拒绝开放通用工具', async () => {
  const sharedRoot = await rootWith('yichen-web-research', 'yichen-summary');
  const registry = new SkillExecutionRegistry({
    sharedRoot,
    adapters:{ 'yichen-web-research':async () => ({ ok:true }) }
  });
  assert.deepEqual(await registry.execute('yichen-web-research', {}, { agentId:'intel-researcher' }), { ok:true });
  await assert.rejects(() => registry.execute('yichen-web-research', {}, { agentId:'xiaod' }), (error) => error.code === 'skill_owner_mismatch');
  await assert.rejects(() => registry.execute('yichen-summary', {}, { agentId:'office-assistant' }), (error) => error.code === 'skill_adapter_missing');
});

test('Grok 登录文件存在不等于订阅可用，必须显式声明订阅后才就绪', async () => {
  const sharedRoot = await rootWith('yichen-grok-consult');
  const authRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-auth-'));
  const grokAuthPath = path.join(authRoot, 'auth.json');
  await fs.writeFile(grokAuthPath, '测试只允许检查文件存在，不能解析此内容');
  const registry = new SkillExecutionRegistry({ sharedRoot, grokAuthPath });
  const pending = (await registry.overview()).find((item) => item.slug === 'yichen-grok-consult');
  assert.equal(pending.status, 'needs_subscription');
  assert.match(pending.recovery, /未确认订阅额度/);
  const subscribed = new SkillExecutionRegistry({ sharedRoot, grokAuthPath, grokAccessMode:'subscribed' });
  const ready = (await subscribed.overview()).find((item) => item.slug === 'yichen-grok-consult');
  assert.equal(ready.status, 'ready');
  assert.equal(ready.recovery, null);
});

test('未订阅 Grok 时明确停用且保留小R其他研究能力', async () => {
  const sharedRoot = await rootWith('yichen-grok-consult');
  const registry = new SkillExecutionRegistry({ sharedRoot, grokAccessMode:'disabled' });
  const grok = (await registry.overview()).find((item) => item.slug === 'yichen-grok-consult');
  assert.equal(grok.status, 'not_enabled');
  assert.match(grok.recovery, /网页研究和统一搜索/);
});

test('OpenKimi PPT 使用嵌套共享入口并分别报告 compose、visualQa 和 export readiness', async () => {
  const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'open-kimi-registry-'));
  const skillRoot = path.join(sharedRoot, 'open-kimi-ppt-skill');
  await fs.mkdir(path.join(skillRoot, 'skills/open-kimi-ppt'), { recursive:true });
  await fs.writeFile(path.join(skillRoot, 'skills/open-kimi-ppt/SKILL.md'), '# open-kimi-ppt\n');
  await fs.writeFile(path.join(skillRoot, 'package.json'), '{"version":"1.0.0"}\n');
  const registry = new SkillExecutionRegistry({
    sharedRoot,
    readinessProbes:{
      'open-kimi-ppt':async () => ({
        status:'partial',
        source:{ packageVersion:'1.0.0', sourceHash:'fixture' },
        modes:{
          compose:{ status:'ready' },
          visualQa:{ status:'needs_capability' },
          export:{ status:'needs_capability' },
        },
        recovery:'agent-browser 版本不兼容；不会自动安装。',
      }),
    },
  });
  const capability = (await registry.overview()).find((item) => item.slug === 'open-kimi-ppt');
  assert.equal(capability.status, 'partial');
  assert.equal(capability.entryPath, 'open-kimi-ppt-skill/skills/open-kimi-ppt/SKILL.md');
  assert.equal(capability.modes.compose.status, 'ready');
  assert.equal(capability.modes.export.status, 'needs_capability');
  assert.deepEqual(capability.externalSideEffects, ['external-data-processing']);
  assert.match(capability.recovery, /不会自动安装/);
});

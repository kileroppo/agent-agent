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

test('Grok 登录文件存在后就绪状态自动恢复，但不读取文件内容', async () => {
  const sharedRoot = await rootWith('yichen-grok-consult');
  const authRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-auth-'));
  const grokAuthPath = path.join(authRoot, 'auth.json');
  await fs.writeFile(grokAuthPath, '测试只允许检查文件存在，不能解析此内容');
  const registry = new SkillExecutionRegistry({ sharedRoot, grokAuthPath });
  assert.equal((await registry.overview()).find((item) => item.slug === 'yichen-grok-consult').status, 'ready');
});

#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENT_ARMY_REPOSITORY_ROOT,
  GOVERNANCE_HERMES_AGENT_IDS,
  hermesProfileHome,
  requiresDirectFeishuGateway,
  usesPaperclipHermesExecution
} from '../src/governance-hermes-runtime.js';

const scriptPath = fileURLToPath(import.meta.url);
const mcpServerPath = path.resolve(path.dirname(scriptPath), '../src/agent-army-mcp-server.js');
const hermesCommand = process.env.AJUN_HERMES_COMMAND || path.join(os.homedir(), '.local/bin/hermes');
const paperclipUrl = process.env.PAPERCLIP_URL || 'http://127.0.0.1:3100';
const ALL_FEISHU_TOOLSETS = [
  'web',
  'browser',
  'terminal',
  'file',
  'code_execution',
  'vision',
  'video',
  'image_gen',
  'video_gen',
  'x_search',
  'tts',
  'skills',
  'todo',
  'memory',
  'context_engine',
  'session_search',
  'clarify',
  'delegation',
  'cronjob',
  'homeassistant',
  'spotify',
  'yuanbao',
  'computer_use'
];

export async function configureGovernanceHermesRuntime({
  agentIds = GOVERNANCE_HERMES_AGENT_IDS,
  allowDraftProfiles = false,
  run = runCommand,
  ensureGatewayLoaded = (agentId) => ensureLaunchAgentLoaded(agentId, run),
  ensureGatewayStopped = (agentId) => ensureLaunchAgentStopped(agentId, run),
  gatewayPlistExists = (agentId) => launchAgentPlistExists(agentId),
  fetchImpl = fetch,
  copyFile = fs.copyFile,
  copyDirectory = (source, target) => fs.cp(source, target, { recursive:true, force:true }),
  removeDirectory = (target) => fs.rm(target, { recursive:true, force:true }),
  stat = fs.stat,
  profileHomeFor = hermesProfileHome
} = {}) {
  const ids = normalizeAgentIds(agentIds, { allowDraftProfiles });
  if (!ids.length) throw new GovernanceHermesConfigurationError('至少需要指定一名治理员工。');
  const companySkills = await listPaperclipCompanySkills(fetchImpl);
  const results = [];

  for (const agentId of ids) {
    const manifestPath = path.join(AGENT_ARMY_REPOSITORY_ROOT, 'agents', agentId, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const restrictedTestingDraft = allowDraftProfiles
      && manifest.status === 'draft'
      && manifest.interaction?.runtime === 'hermes-profile'
      && manifest.interaction?.directFeishu === 'disabled'
      && manifest.executionOwner === 'paperclip-hermes';
    if (!usesPaperclipHermesExecution(manifest) && !restrictedTestingDraft) {
      throw new GovernanceHermesConfigurationError(`${agentId} 未声明 Paperclip Hermes 执行所有权。`);
    }
    const profileHome = profileHomeFor(agentId);
    const profileStat = await stat(profileHome).catch(() => null);
    if (!profileStat?.isDirectory()) throw new GovernanceHermesConfigurationError(`${agentId} 的 Hermes Profile 不存在。`);

    const promptPath = path.resolve(AGENT_ARMY_REPOSITORY_ROOT, manifest.promptRef);
    await copyFile(promptPath, path.join(profileHome, 'SOUL.md'));
    const installedSkills = [];
    for (const slug of manifest.runtimeCapabilities.skills) {
      const skill = companySkills.find((item) => item.slug === slug);
      if (!skill?.sourceLocator) throw new GovernanceHermesConfigurationError(`Paperclip 公司技能 ${slug} 不可用。`);
      const target = path.join(profileHome, 'skills', slug);
      await removeDirectory(target);
      await copyDirectory(skill.sourceLocator, target);
      installedSkills.push(slug);
    }

    const profileEnvironment = { HERMES_HOME:profileHome };
    await run(hermesCommand, ['mcp', 'remove', 'agent-army'], {
      allowFailure:true,
      env:profileEnvironment,
      input:'\n'
    });
    const env = [
      `AGENT_ARMY_AGENT_ID=${agentId}`,
      `AGENT_ARMY_ALLOWED_AGENT_IDS=${agentId}`,
      `AGENT_ARMY_ALLOWED_TASK_TYPES=${manifest.acceptedTaskTypes.join(',')}`,
      `AGENT_ARMY_ALLOWED_MCP_TOOLS=${manifest.runtimeCapabilities.mcpTools.join(',')}`,
      `AGENT_ARMY_ALLOW_MISSIONS=${manifest.runtimeCapabilities.mcpTools.includes('mission_create') ? 'true' : 'false'}`,
      'PAPERCLIP_TASK_ID=${PAPERCLIP_TASK_ID}',
      'PAPERCLIP_RUN_ID=${PAPERCLIP_RUN_ID}',
      'PAPERCLIP_AGENT_ID=${PAPERCLIP_AGENT_ID}',
      'PAPERCLIP_API_KEY=${PAPERCLIP_API_KEY}'
    ];
    await run(hermesCommand, [
      'mcp', 'add', 'agent-army',
      '--command', process.execPath,
      '--env', ...env,
      '--args', mcpServerPath
    ], { env:profileEnvironment, input:'\n' });
    // 12 分钟业务预算由 A君后台执行持有；每次 MCP 等待必须早于
    // Hermes 同步桥的 300 秒硬上限返回 running，再由同一工具续等。
    await run(hermesCommand, [
      'config', 'set', '--force', 'mcp_servers.agent-army.timeout', '290'
    ], { env:profileEnvironment, input:'\n' });
    await run(hermesCommand, ['tools', 'disable', '--platform', 'feishu', ...ALL_FEISHU_TOOLSETS], { env:profileEnvironment });
    await run(hermesCommand, ['tools', 'enable', '--platform', 'feishu', ...manifest.runtimeCapabilities.feishuToolsets], { env:profileEnvironment });
    for (const toolName of manifest.runtimeCapabilities.mcpTools) {
      await run(hermesCommand, ['tools', 'enable', '--platform', 'feishu', `agent-army:${toolName}`], { env:profileEnvironment });
    }
    const directFeishu = requiresDirectFeishuGateway(manifest);
    if (directFeishu) {
      if (!await gatewayPlistExists(agentId)) {
        await run(hermesCommand, [
          'gateway', 'install',
          '--force',
          '--no-start-now',
          '--start-on-login'
        ], { env:profileEnvironment });
      }
      await ensureGatewayLoaded(agentId);
    } else {
      await ensureGatewayStopped(agentId);
    }
    results.push({
      agentId,
      profileHome,
      skills:installedSkills,
      mcpTools:[...manifest.runtimeCapabilities.mcpTools],
      feishuToolsets:[...manifest.runtimeCapabilities.feishuToolsets],
      gatewayInstalled:directFeishu,
      executionMode:restrictedTestingDraft ? 'restricted-testing' : directFeishu ? 'always-on-feishu' : 'paperclip-on-demand'
    });
  }
  return results;
}

async function ensureLaunchAgentLoaded(agentId, run) {
  const uid = os.userInfo().uid;
  const label = `ai.hermes.gateway-${agentId}`;
  const domain = `gui/${uid}`;
  const service = `${domain}/${label}`;
  const plistPath = path.join(os.homedir(), 'Library/LaunchAgents', `${label}.plist`);
  const current = await run('/bin/launchctl', ['print', service], { allowFailure:true });
  if (current.code !== 0) {
    await run('/bin/launchctl', ['bootstrap', domain, plistPath]);
  }
  await run('/bin/launchctl', ['enable', service], { allowFailure:true });
  await run('/bin/launchctl', ['kickstart', '-k', service]);
}

async function ensureLaunchAgentStopped(agentId, run) {
  const uid = os.userInfo().uid;
  const label = `ai.hermes.gateway-${agentId}`;
  const service = `gui/${uid}/${label}`;
  await run('/bin/launchctl', ['bootout', service], { allowFailure:true });
  await run('/bin/launchctl', ['disable', service], { allowFailure:true });
}

async function launchAgentPlistExists(agentId) {
  const plistPath = path.join(os.homedir(), 'Library/LaunchAgents', `ai.hermes.gateway-${agentId}.plist`);
  const plistStat = await fs.stat(plistPath).catch(() => null);
  return Boolean(plistStat?.isFile());
}

async function listPaperclipCompanySkills(fetchImpl) {
  const companyResponse = await fetchImpl(`${paperclipUrl}/api/companies`, { signal:AbortSignal.timeout(2500) });
  if (!companyResponse.ok) throw new GovernanceHermesConfigurationError('Paperclip 公司列表不可用。');
  const companies = await companyResponse.json();
  const company = companies.find((item) => item.name === 'Agent军团');
  if (!company) throw new GovernanceHermesConfigurationError('Paperclip 中未找到 Agent军团。');
  const skillsResponse = await fetchImpl(`${paperclipUrl}/api/companies/${company.id}/skills`, { signal:AbortSignal.timeout(2500) });
  if (!skillsResponse.ok) throw new GovernanceHermesConfigurationError('Paperclip 公司技能库不可用。');
  return skillsResponse.json();
}

function normalizeAgentIds(value, { allowDraftProfiles = false } = {}) {
  const allowed = new Set(GOVERNANCE_HERMES_AGENT_IDS);
  const values = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(values
    .map((item) => String(item || '').trim())
    .filter((item) => allowDraftProfiles ? /^[a-z][a-z0-9-]{0,63}$/.test(item) : allowed.has(item)))];
}

function runCommand(command, args, { allowFailure = false, env = {}, input = '' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio:['pipe', 'pipe', 'pipe'],
      env:{ ...process.env, ...env, NO_COLOR:'1' }
    });
    let stderr = '';
    child.stdin.end(input);
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 || allowFailure) resolve({ code });
      else reject(new GovernanceHermesConfigurationError(
        `Hermes 配置命令失败：${args.slice(0, 4).join(' ')}。${stderr.replace(/\s+/g, ' ').trim().slice(0, 240)}`
      ));
    });
  });
}

export class GovernanceHermesConfigurationError extends Error {}

async function main() {
  try {
    const args = process.argv.slice(2);
    const allowDraftProfiles = args.includes('--allow-draft-testing');
    const requestedAgentIds = args.filter((item) => item !== '--allow-draft-testing');
    const results = await configureGovernanceHermesRuntime(requestedAgentIds.length
      ? { agentIds:requestedAgentIds, allowDraftProfiles }
      : { allowDraftProfiles });
    for (const result of results) {
      console.log(`已配置 ${result.agentId}：${result.skills.length} 个复用技能、${result.mcpTools.length} 个 MCP 工具、${result.gatewayInstalled ? 'Gateway 登录自启' : 'Paperclip 按需运行且 Gateway 已停用'}。`);
    }
  } catch (error) {
    console.error(error instanceof GovernanceHermesConfigurationError ? error.message : '治理员工 Hermes 配置失败。');
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) await main();

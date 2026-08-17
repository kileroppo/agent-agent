#!/usr/bin/env node

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcileHermesSkillWhitelists, HermesSkillWhitelistError } from './reconcile-hermes-skill-whitelist.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptPath);
const repositoryRoot = path.resolve(scriptDirectory, '../../..');
const defaultAgentsRoot = path.join(repositoryRoot, 'agents');

export async function assertHermesGatewayStartAllowed({
  agentId,
  agentsRoot = defaultAgentsRoot,
  profileHomeFor,
  reconcile = reconcileHermesSkillWhitelists
} = {}) {
  const normalizedAgentId = normalizeAgentId(agentId);
  const results = await reconcile({
    agentsRoot,
    agentIds:[normalizedAgentId],
    apply:false,
    profileHomeFor
  });
  const result = results[0];
  if (!result || result.agentId !== normalizedAgentId || result.status !== 'clean') {
    const status = result?.status || 'unknown';
    throw new HermesSkillWhitelistError(
      `${normalizedAgentId} 的技能白名单未收敛（${status}）；拒绝启动 Gateway。先只读核对，再在维护窗口显式 --apply。`
    );
  }
  if (result.bundledSkillSeedingOptOut !== true) {
    throw new HermesSkillWhitelistError(`${normalizedAgentId} 未关闭 Hermes 自动注入 bundled skills；拒绝启动 Gateway。`);
  }
  return result;
}

export async function startGuardedHermesGateway({
  agentId,
  agentsRoot = defaultAgentsRoot,
  profileHomeFor,
  reconcile = reconcileHermesSkillWhitelists,
  runGateway = defaultRunGateway
} = {}) {
  const policy = await assertHermesGatewayStartAllowed({
    agentId,
    agentsRoot,
    profileHomeFor,
    reconcile
  });
  return runGateway(policy);
}

export function parseGuardedGatewayArgs(args = []) {
  let agentId = '';
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--agent') {
      if (agentId) throw new HermesSkillWhitelistError('--agent 只能指定一次。');
      agentId = args[++index] || '';
      continue;
    }
    throw new HermesSkillWhitelistError(`未知参数：${value}`);
  }
  return { agentId:normalizeAgentId(agentId) };
}

async function defaultRunGateway(policy) {
  const command = process.env.AJUN_HERMES_COMMAND || path.join(os.homedir(), '.local/bin/hermes');
  return new Promise((resolve, reject) => {
    const child = spawn(command, ['gateway', 'run', '--replace'], {
      stdio:'inherit',
      env:{ ...process.env, HERMES_HOME:policy.profileHome }
    });
    child.once('error', (error) => reject(new HermesSkillWhitelistError(`无法启动 Hermes Gateway：${error.message}`, { cause:error })));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

function normalizeAgentId(value) {
  const agentId = String(value || '').trim();
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(agentId)) {
    throw new HermesSkillWhitelistError('--agent 需要合法的 active Hermes 岗位 ID。');
  }
  return agentId;
}

async function main() {
  try {
    const result = await startGuardedHermesGateway(parseGuardedGatewayArgs(process.argv.slice(2)));
    process.exitCode = typeof result.code === 'number' ? result.code : 1;
  } catch (error) {
    console.error(error instanceof HermesSkillWhitelistError ? error.message : 'Hermes Gateway 启动门禁失败。');
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) await main();

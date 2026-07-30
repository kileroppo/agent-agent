#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptPath);
const repositoryRoot = path.resolve(scriptDirectory, '../../..');
const defaultAgentsRoot = path.join(repositoryRoot, 'agents');
const helperPath = path.join(scriptDirectory, 'hermes-skill-state.py');
const skillNamePattern = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export async function reconcileHermesSkillWhitelists({
  agentsRoot = defaultAgentsRoot,
  agentIds,
  apply = false,
  inspectSkillState = defaultInspectSkillState,
  disableSkills = defaultDisableSkills,
  profileHomeFor = defaultProfileHome,
  readDirectory = (directory) => fs.readdir(directory, { withFileTypes:true }),
  readFile = fs.readFile
} = {}) {
  const policies = await discoverHermesSkillPolicies({
    agentsRoot,
    agentIds,
    profileHomeFor,
    readDirectory,
    readFile
  });
  const results = [];
  const inspections = new Map();

  for (const policy of policies) {
    try {
      inspections.set(policy.agentId, normalizeSkillState(await inspectSkillState(policy)));
    } catch (error) {
      inspections.set(policy.agentId, {
        error:error instanceof Error ? error.message : 'Hermes Profile 不可检查。'
      });
    }
  }

  const inspectionFailed = [...inspections.values()].some((value) => value.error);
  for (const policy of policies) {
    const inspection = inspections.get(policy.agentId);
    if (inspection.error) {
      results.push({
        ...policy,
        mode:apply ? 'apply' : 'dry-run',
        status:'inspection-error',
        error:inspection.error,
        extraEnabledSkills:[],
        declaredUnavailableSkills:[...policy.allowedSkills],
        declaredDisabledSkills:[],
        newlyDisabledSkills:[]
      });
      continue;
    }
    const before = inspection;
    const allowed = new Set(policy.allowedSkills);
    const visible = new Set(before.visibleSkills);
    const disabled = new Set(before.disabledSkills);
    const extraEnabledSkills = before.enabledSkills.filter((name) => !allowed.has(name));
    const declaredUnavailableSkills = policy.allowedSkills.filter((name) => !visible.has(name));
    const declaredDisabledSkills = policy.allowedSkills.filter((name) => visible.has(name) && disabled.has(name));

    const declaredGap = declaredUnavailableSkills.length > 0 || declaredDisabledSkills.length > 0;
    if (!apply || inspectionFailed || extraEnabledSkills.length === 0) {
      results.push({
        ...policy,
        mode:apply ? 'apply' : 'dry-run',
        status:inspectionFailed && apply
          ? 'apply-blocked'
          : extraEnabledSkills.length || declaredGap ? 'drift' : 'clean',
        extraEnabledSkills,
        declaredUnavailableSkills,
        declaredDisabledSkills,
        newlyDisabledSkills:[]
      });
      continue;
    }

    const applied = await disableSkills(policy, extraEnabledSkills);
    const after = normalizeSkillState(
      applied?.enabledSkills ? applied : await inspectSkillState(policy)
    );
    const remainingExtraEnabledSkills = after.enabledSkills.filter((name) => !allowed.has(name));
    const remainingDeclaredUnavailableSkills = policy.allowedSkills
      .filter((name) => !new Set(after.visibleSkills).has(name));
    const remainingDeclaredDisabledSkills = policy.allowedSkills
      .filter((name) => new Set(after.visibleSkills).has(name) && new Set(after.disabledSkills).has(name));
    results.push({
      ...policy,
      mode:'apply',
      status:remainingExtraEnabledSkills.length
        || remainingDeclaredUnavailableSkills.length
        || remainingDeclaredDisabledSkills.length
        ? 'remaining-drift'
        : 'applied',
      extraEnabledSkills,
      remainingExtraEnabledSkills,
      declaredUnavailableSkills:remainingDeclaredUnavailableSkills,
      declaredDisabledSkills:remainingDeclaredDisabledSkills,
      newlyDisabledSkills:normalizeSkillNames(applied?.newlyDisabled || extraEnabledSkills)
    });
  }

  return results;
}

export async function discoverHermesSkillPolicies({
  agentsRoot = defaultAgentsRoot,
  agentIds,
  profileHomeFor = defaultProfileHome,
  readDirectory = (directory) => fs.readdir(directory, { withFileTypes:true }),
  readFile = fs.readFile
} = {}) {
  const requestedIds = normalizeRequestedAgentIds(agentIds);
  const requested = requestedIds ? new Set(requestedIds) : null;
  const entries = await readDirectory(agentsRoot);
  const policies = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || (requested && !requested.has(entry.name))) continue;
    const manifestPath = path.join(agentsRoot, entry.name, 'manifest.json');
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch (error) {
      if (requested?.has(entry.name)) {
        throw new HermesSkillWhitelistError(`无法读取 ${entry.name} 的 AgentManifest。`, { cause:error });
      }
      continue;
    }
    if (manifest.status !== 'active' || manifest.interaction?.runtime !== 'hermes-profile') {
      if (requested?.has(entry.name)) {
        throw new HermesSkillWhitelistError(`${entry.name} 不是 active Hermes Profile 岗位。`);
      }
      continue;
    }
    const agentId = String(manifest.agentId || '').trim();
    if (agentId !== entry.name) {
      throw new HermesSkillWhitelistError(`${entry.name} 的 manifest.agentId 不匹配。`);
    }
    const allowedSkills = normalizeDeclaredSkills(manifest.runtimeCapabilities?.skills, agentId);
    policies.push({
      agentId,
      manifestPath,
      profileHome:profileHomeFor(agentId),
      allowedSkills
    });
    requested?.delete(agentId);
  }

  if (requested?.size) {
    throw new HermesSkillWhitelistError(`未找到 active Hermes Profile 岗位：${[...requested].sort().join(', ')}。`);
  }
  return policies.sort((left, right) => left.agentId.localeCompare(right.agentId));
}

export function parseReconcileArgs(args) {
  let apply = false;
  let requestedMode = null;
  const agentIds = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--apply') {
      if (requestedMode === 'dry-run') throw new HermesSkillWhitelistError('--apply 与 --dry-run 不能同时使用。');
      requestedMode = 'apply';
      apply = true;
    } else if (value === '--dry-run') {
      if (requestedMode === 'apply') throw new HermesSkillWhitelistError('--apply 与 --dry-run 不能同时使用。');
      requestedMode = 'dry-run';
      apply = false;
    } else if (value === '--agent') {
      const agentId = args[++index];
      if (!agentId) throw new HermesSkillWhitelistError('--agent 需要岗位 ID。');
      agentIds.push(agentId);
    } else {
      throw new HermesSkillWhitelistError(`未知参数：${value}`);
    }
  }
  if (apply && agentIds.length === 0) {
    throw new HermesSkillWhitelistError('--apply 必须至少显式指定一个 --agent；拒绝批量修改全部 Profile。');
  }
  return { apply, agentIds:agentIds.length ? agentIds : undefined };
}

async function defaultInspectSkillState(policy) {
  const profileStat = await fs.stat(policy.profileHome).catch(() => null);
  if (!profileStat?.isDirectory()) {
    throw new HermesSkillWhitelistError(`${policy.agentId} 的 Hermes Profile 不存在。`);
  }
  return runHermesSkillStateHelper(policy, 'inspect');
}

async function defaultDisableSkills(policy, skills) {
  return runHermesSkillStateHelper(policy, 'disable-only', { disableSkills:skills });
}

async function runHermesSkillStateHelper(policy, action, input) {
  const pythonCommand = process.env.AJUN_HERMES_PYTHON
    || path.join(os.homedir(), '.hermes/hermes-agent/venv/bin/python');
  const result = await runCommand(pythonCommand, [helperPath, action], {
    env:{ HERMES_HOME:policy.profileHome },
    input:input ? `${JSON.stringify(input)}\n` : ''
  });
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new HermesSkillWhitelistError(`${policy.agentId} 的 Hermes 技能状态不是有效 JSON。`, { cause:error });
  }
}

function runCommand(command, args, { env = {}, input = '' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio:['pipe', 'pipe', 'pipe'],
      env:{ ...process.env, ...env, NO_COLOR:'1' }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => reject(new HermesSkillWhitelistError(
      `无法启动 Hermes 技能检查器：${error.message}`,
      { cause:error }
    )));
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new HermesSkillWhitelistError(
        `Hermes 技能检查失败（${code}）：${stderr.replace(/\s+/g, ' ').trim().slice(0, 240)}`
      ));
    });
    child.stdin.end(input);
  });
}

function normalizeRequestedAgentIds(agentIds) {
  if (agentIds === undefined) return null;
  const normalized = normalizeSkillNames(agentIds);
  if (!normalized.length || normalized.some((agentId) => !/^[a-z][a-z0-9-]{0,63}$/.test(agentId))) {
    throw new HermesSkillWhitelistError('岗位 ID 不合法。');
  }
  return normalized;
}

function normalizeDeclaredSkills(value, agentId) {
  if (!Array.isArray(value)) {
    throw new HermesSkillWhitelistError(`${agentId} 缺少 runtimeCapabilities.skills 声明。`);
  }
  const skills = normalizeSkillNames(value);
  if (skills.length !== value.length || skills.some((name) => !skillNamePattern.test(name))) {
    throw new HermesSkillWhitelistError(`${agentId} 的技能白名单包含重复或非法名称。`);
  }
  return skills;
}

function normalizeSkillState(value) {
  if (!value || !Array.isArray(value.visibleSkills) || !Array.isArray(value.enabledSkills) || !Array.isArray(value.disabledSkills)) {
    throw new HermesSkillWhitelistError('Hermes 技能状态结构不合法。');
  }
  const state = {
    visibleSkills:normalizeSkillNames(value.visibleSkills),
    enabledSkills:normalizeSkillNames(value.enabledSkills),
    disabledSkills:normalizeSkillNames(value.disabledSkills)
  };
  const visible = new Set(state.visibleSkills);
  if (state.enabledSkills.some((name) => !visible.has(name))) {
    throw new HermesSkillWhitelistError('Hermes 返回了不可见但已启用的技能。');
  }
  return state;
}

function normalizeSkillNames(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean))]
    .sort();
}

function defaultProfileHome(agentId) {
  const profileRoot = path.resolve(os.homedir(), '.hermes/profiles');
  const profileHome = path.resolve(profileRoot, agentId);
  if (!profileHome.startsWith(`${profileRoot}${path.sep}`)) {
    throw new HermesSkillWhitelistError('Hermes Profile 路径越界。');
  }
  return profileHome;
}

export class HermesSkillWhitelistError extends Error {}

async function main() {
  try {
    const options = parseReconcileArgs(process.argv.slice(2));
    const results = await reconcileHermesSkillWhitelists(options);
    let hasDrift = false;
    let hasInspectionError = false;
    for (const result of results) {
      const missing = result.declaredUnavailableSkills.length + result.declaredDisabledSkills.length;
      if (result.status === 'drift' || result.status === 'remaining-drift') hasDrift = true;
      if (result.status === 'inspection-error' || result.status === 'apply-blocked') hasInspectionError = true;
      if (result.status === 'inspection-error') {
        console.log(`${result.agentId}: 无法只读检查；${result.error}`);
        continue;
      }
      if (result.mode === 'dry-run') {
        console.log(`${result.agentId}: ${result.extraEnabledSkills.length} 个越权启用技能，${missing} 个声明技能不可用或已禁用（只读）。`);
        if (result.extraEnabledSkills.length) {
          console.log(`  未声明但 enabled: ${result.extraEnabledSkills.join(', ')}`);
        }
        if (result.declaredUnavailableSkills.length) {
          console.log(`  声明但当前不可见: ${result.declaredUnavailableSkills.join(', ')}`);
        }
        if (result.declaredDisabledSkills.length) {
          console.log(`  声明但当前 disabled: ${result.declaredDisabledSkills.join(', ')}`);
        }
      } else if (result.status === 'apply-blocked') {
        console.log(`${result.agentId}: 发现 ${result.extraEnabledSkills.length} 个越权启用技能；因其他 Profile 不可检查，apply 整体未写入。`);
      } else {
        console.log(`${result.agentId}: 新禁用 ${result.newlyDisabledSkills.length} 个越权技能，剩余 ${result.remainingExtraEnabledSkills?.length || 0} 个。`);
      }
    }
    if (hasInspectionError) process.exitCode = 1;
    else if (hasDrift) process.exitCode = 2;
  } catch (error) {
    console.error(error instanceof HermesSkillWhitelistError ? error.message : 'Hermes 技能白名单检查失败。');
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) await main();

#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
const PROFILE_BACKUP_DIRECTORY = '.agent-army-skill-whitelist-backups';
const PROFILE_TRANSACTION_FILE = '.agent-army-skill-whitelist-transaction.json';

export async function reconcileHermesSkillWhitelists({
  agentsRoot = defaultAgentsRoot,
  agentIds,
  apply = false,
  inspectSkillState = defaultInspectSkillState,
  inspectProfileSafeguards = defaultInspectProfileSafeguards,
  disableSkills = defaultDisableSkills,
  enableBundledSkillOptOut = defaultEnableBundledSkillOptOut,
  backupProfile = backupHermesSkillProfile,
  restoreProfileBackup = restoreHermesSkillProfileBackup,
  completeProfileBackup = completeHermesSkillProfileBackup,
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
  const plans = [];
  const inspections = new Map();
  const safeguards = new Map();

  for (const policy of policies) {
    try {
      inspections.set(policy.agentId, normalizeSkillState(await inspectSkillState(policy)));
    } catch (error) {
      inspections.set(policy.agentId, {
        error:error instanceof Error ? error.message : 'Hermes Profile 不可检查。'
      });
    }
    try {
      safeguards.set(policy.agentId, await inspectProfileSafeguards(policy));
    } catch (error) {
      inspections.set(policy.agentId, {
        error:error instanceof Error ? error.message : 'Hermes Profile 默认拒绝保护不可检查。'
      });
    }
  }

  const inspectionFailed = [...inspections.values()].some((value) => value.error);
  for (const policy of policies) {
    const inspection = inspections.get(policy.agentId);
    if (inspection.error) {
      plans.push({
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
    const safeguard = safeguards.get(policy.agentId);
    const allowed = new Set(policy.allowedSkills);
    const visible = new Set(before.visibleSkills);
    const disabled = new Set(before.disabledSkills);
    const extraEnabledSkills = before.enabledSkills.filter((name) => !allowed.has(name));
    const declaredUnavailableSkills = policy.allowedSkills.filter((name) => !visible.has(name));
    const declaredDisabledSkills = policy.allowedSkills.filter((name) => visible.has(name) && disabled.has(name));

    const declaredGap = declaredUnavailableSkills.length > 0 || declaredDisabledSkills.length > 0;
    const bundledSkillSeedingOptOut = safeguard?.bundledSkillSeedingOptOut === true;
    const defaultDenyGap = !bundledSkillSeedingOptOut;
    plans.push({
        ...policy,
        mode:apply ? 'apply' : 'dry-run',
        status:inspectionFailed && apply
          ? 'apply-blocked'
          : extraEnabledSkills.length || declaredGap || defaultDenyGap ? 'drift' : 'clean',
        extraEnabledSkills,
        declaredUnavailableSkills,
        declaredDisabledSkills,
        newlyDisabledSkills:[],
        needsDisable:extraEnabledSkills.length > 0,
        bundledSkillSeedingOptOut,
        needsBundledSkillOptOut:defaultDenyGap,
        allowedSkills:policy.allowedSkills
      });
  }

  if (!apply || inspectionFailed) return plans.map(publicReconcileResult);

  const candidates = plans.filter((plan) => plan.needsDisable || plan.needsBundledSkillOptOut);
  if (!candidates.length) return plans.map(publicReconcileResult);

  // Back up every profile before mutating any one of them.  Hermes stores this
  // switch in config.yaml, which may contain connection settings, so copy it as
  // bytes and never parse or print its content here.
  const backups = [];
  const applied = new Map();
  try {
    for (const plan of candidates) {
      backups.push(await backupProfile(plan));
    }
    for (const plan of candidates) {
      const before = inspections.get(plan.agentId);
      const writeResult = plan.needsDisable
        ? await disableSkills(plan, plan.extraEnabledSkills, {
          expectedDisabledSkills:before.disabledSkills
        })
        : null;
      const backup = backups.find((item) => item.agentId === plan.agentId);
      if (plan.needsBundledSkillOptOut) {
        await enableBundledSkillOptOut(plan, backup);
      }
      const after = normalizeSkillState(
        writeResult?.enabledSkills ? writeResult : await inspectSkillState(plan)
      );
      const allowed = new Set(plan.allowedSkills);
      const remainingExtraEnabledSkills = after.enabledSkills.filter((name) => !allowed.has(name));
      const visible = new Set(after.visibleSkills);
      const disabled = new Set(after.disabledSkills);
      const afterSafeguard = await inspectProfileSafeguards(plan);
      const result = {
        ...plan,
        mode:'apply',
        status:remainingExtraEnabledSkills.length
          || afterSafeguard?.bundledSkillSeedingOptOut !== true
          || plan.allowedSkills.some((name) => !visible.has(name) || disabled.has(name))
          ? 'remaining-drift'
          : 'applied',
        remainingExtraEnabledSkills,
        declaredUnavailableSkills:plan.allowedSkills.filter((name) => !visible.has(name)),
        declaredDisabledSkills:plan.allowedSkills.filter((name) => visible.has(name) && disabled.has(name)),
        newlyDisabledSkills:normalizeSkillNames(writeResult?.newlyDisabled || plan.extraEnabledSkills),
        bundledSkillSeedingOptOut:afterSafeguard?.bundledSkillSeedingOptOut === true,
        backupPath:backup?.root || null
      };
      if (remainingExtraEnabledSkills.length || result.bundledSkillSeedingOptOut !== true) {
        throw new HermesSkillWhitelistError(`${plan.agentId} 写入后的默认拒绝复查未通过。`);
      }
      applied.set(plan.agentId, result);
    }
    for (const backup of backups) await completeProfileBackup(backup);
  } catch (error) {
    const rollbackErrors = [];
    for (const backup of [...backups].reverse()) {
      try {
        await restoreProfileBackup(backup);
      } catch (rollbackError) {
        rollbackErrors.push(`${backup.agentId}: ${errorMessage(rollbackError)}`);
      }
    }
    const rollback = rollbackErrors.length
      ? `回滚未完整完成：${rollbackErrors.join('；')}`
      : '已从精确 config.yaml 备份回滚。';
    throw new HermesSkillWhitelistError(`Hermes 技能白名单 apply 失败；${rollback}`, { cause:error });
  }

  return plans.map((plan) => publicReconcileResult(applied.get(plan.agentId) || plan));
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
    const independentlyManagedHermesProfile = manifest.executionOwner !== 'ajun-local';
    if (
      manifest.status !== 'active'
      || manifest.interaction?.runtime !== 'hermes-profile'
      || !independentlyManagedHermesProfile
    ) {
      if (requested?.has(entry.name)) {
        throw new HermesSkillWhitelistError(`${entry.name} 不是独立管理的 active Hermes Profile 岗位。`);
      }
      continue;
    }
    const agentId = String(manifest.agentId || '').trim();
    if (agentId !== entry.name) {
      throw new HermesSkillWhitelistError(`${entry.name} 的 manifest.agentId 不匹配。`);
    }
    const allowedSkills = normalizeDeclaredSkills(
      Array.isArray(manifest.runtimeCapabilities?.gatewaySkills)
        ? manifest.runtimeCapabilities.gatewaySkills
        : manifest.runtimeCapabilities?.skills,
      agentId,
    );
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

async function defaultInspectProfileSafeguards(policy) {
  const profileHome = await assertSafeProfileHome(policy, fs);
  const marker = await fs.lstat(path.join(profileHome, '.no-bundled-skills')).catch(() => null);
  return {
    // Hermes treats this marker as an opt-out for installer, update, and direct
    // sync.  It closes the automatic introduction path; the guarded launcher
    // below closes any manual introduction before a gateway can start.
    bundledSkillSeedingOptOut:marker?.isFile() === true && !marker.isSymbolicLink()
  };
}

async function defaultEnableBundledSkillOptOut(policy, backup) {
  const profileHome = await assertSafeProfileHome(policy, fs);
  const markerPath = path.join(profileHome, '.no-bundled-skills');
  const existing = await fs.lstat(markerPath).catch(() => null);
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new HermesSkillWhitelistError(`${policy.agentId} 的 .no-bundled-skills 标记不安全。`);
    }
    return false;
  }
  await fs.writeFile(markerPath, 'agent-army skill allowlist: bundled skill seeding disabled\n', {
    encoding:'utf8', mode:0o600, flag:'wx'
  });
  if (backup) backup.createdBundledSkillOptOut = true;
  return true;
}

async function defaultDisableSkills(policy, skills, { expectedDisabledSkills } = {}) {
  if (expectedDisabledSkills) {
    const immediatelyBefore = normalizeSkillState(await defaultInspectSkillState(policy));
    if (!sameSkillNames(immediatelyBefore.disabledSkills, expectedDisabledSkills)) {
      throw new HermesSkillWhitelistError(`${policy.agentId} 的 disabled 技能集合在检查后发生变化；拒绝覆盖。`);
    }
  }
  return runHermesSkillStateHelper(policy, 'disable-only', { disableSkills:skills });
}

export async function backupHermesSkillProfile(policy, { fileSystem = fs } = {}) {
  const profileHome = await assertSafeProfileHome(policy, fileSystem);
  const configPath = path.join(profileHome, 'config.yaml');
  const markerPath = path.join(profileHome, PROFILE_TRANSACTION_FILE);
  const configState = await fileSystem.lstat(configPath).catch(() => null);
  if (!configState?.isFile() || configState.isSymbolicLink()) {
    throw new HermesSkillWhitelistError(`${policy.agentId} 的 config.yaml 不是安全普通文件。`);
  }
  if (await fileSystem.lstat(markerPath).catch(() => null)) {
    throw new HermesSkillWhitelistError(`${policy.agentId} 存在未完成的技能白名单事务；请先从现有备份恢复。`);
  }

  const backupParent = path.join(profileHome, PROFILE_BACKUP_DIRECTORY);
  await fileSystem.mkdir(backupParent, { recursive:true, mode:0o700 });
  const backupParentState = await fileSystem.lstat(backupParent).catch(() => null);
  if (!backupParentState?.isDirectory() || backupParentState.isSymbolicLink()) {
    throw new HermesSkillWhitelistError(`${policy.agentId} 的技能白名单备份目录不安全。`);
  }
  const root = path.join(backupParent, randomUUID());
  if (!root.startsWith(`${backupParent}${path.sep}`)) {
    throw new HermesSkillWhitelistError('Hermes 技能白名单备份路径越界。');
  }
  await fileSystem.mkdir(root, { mode:0o700 });
  const backupConfigPath = path.join(root, 'config.yaml');
  await fileSystem.copyFile(configPath, backupConfigPath);
  await fileSystem.chmod(backupConfigPath, 0o600);
  const backup = {
    agentId:policy.agentId,
    profileHome,
    root,
    configPath,
    backupConfigPath,
    markerPath,
    bundledSkillMarkerPath:path.join(profileHome, '.no-bundled-skills'),
    configMode:configState.mode & 0o777
  };
  try {
    await fileSystem.writeFile(markerPath, JSON.stringify({
      schemaVersion:'agent.army/hermes-skill-whitelist-transaction/v1',
      agentId:policy.agentId,
      backupPath:root,
      files:['config.yaml'],
      configMode:backup.configMode
    }, null, 2), { encoding:'utf8', mode:0o600, flag:'wx' });
  } catch (error) {
    throw new HermesSkillWhitelistError(`${policy.agentId} 的备份已建立，但无法创建事务标记；拒绝写入。`, { cause:error });
  }
  return backup;
}

export async function restoreHermesSkillProfileBackup(backup, { fileSystem = fs } = {}) {
  const profileHome = await assertSafeProfileHome(backup, fileSystem);
  const backupRoot = path.resolve(String(backup.root || ''));
  const backupParent = path.join(profileHome, PROFILE_BACKUP_DIRECTORY);
  if (!backupRoot.startsWith(`${backupParent}${path.sep}`)) {
    throw new HermesSkillWhitelistError('Hermes 技能白名单恢复路径越界。');
  }
  const backupConfigPath = path.join(backupRoot, 'config.yaml');
  const backupConfigState = await fileSystem.lstat(backupConfigPath).catch(() => null);
  if (!backupConfigState?.isFile() || backupConfigState.isSymbolicLink()) {
    throw new HermesSkillWhitelistError(`${backup.agentId} 的技能白名单备份不可用。`);
  }
  await fileSystem.copyFile(backupConfigPath, path.join(profileHome, 'config.yaml'));
  await fileSystem.chmod(path.join(profileHome, 'config.yaml'), Number(backup.configMode) || 0o600);
  if (backup.createdBundledSkillOptOut === true) {
    const bundledMarkerPath = path.join(profileHome, '.no-bundled-skills');
    if (path.resolve(String(backup.bundledSkillMarkerPath || bundledMarkerPath)) !== bundledMarkerPath) {
      throw new HermesSkillWhitelistError('Hermes bundled skills 标记恢复路径越界。');
    }
    const bundledMarker = await fileSystem.lstat(bundledMarkerPath).catch(() => null);
    if (!bundledMarker?.isFile() || bundledMarker.isSymbolicLink()) {
      throw new HermesSkillWhitelistError(`${backup.agentId} 的 bundled skills 标记无法安全回滚。`);
    }
    await fileSystem.rm(bundledMarkerPath);
  }
  await completeHermesSkillProfileBackup(backup, { fileSystem });
}

export async function completeHermesSkillProfileBackup(backup, { fileSystem = fs } = {}) {
  const profileHome = await assertSafeProfileHome(backup, fileSystem);
  const markerPath = path.join(profileHome, PROFILE_TRANSACTION_FILE);
  if (path.resolve(String(backup.markerPath || markerPath)) !== markerPath) {
    throw new HermesSkillWhitelistError('Hermes 技能白名单事务标记路径越界。');
  }
  const markerState = await fileSystem.lstat(markerPath).catch(() => null);
  if (!markerState) return;
  if (!markerState.isFile() || markerState.isSymbolicLink()) {
    throw new HermesSkillWhitelistError(`${backup.agentId} 的技能白名单事务标记不安全。`);
  }
  await fileSystem.rm(markerPath);
}

async function assertSafeProfileHome(policy, fileSystem) {
  const profileHome = path.resolve(String(policy.profileHome || ''));
  if (!profileHome || profileHome === path.parse(profileHome).root) {
    throw new HermesSkillWhitelistError('Hermes Profile 路径不安全。');
  }
  const profileState = await fileSystem.lstat(profileHome).catch(() => null);
  if (!profileState?.isDirectory() || profileState.isSymbolicLink()) {
    throw new HermesSkillWhitelistError(`${policy.agentId} 的 Hermes Profile 不是安全目录。`);
  }
  return profileHome;
}

function publicReconcileResult(plan) {
  const { needsDisable, needsBundledSkillOptOut, ...result } = plan;
  return result;
}

function sameSkillNames(left, right) {
  const normalizedLeft = normalizeSkillNames(left);
  const normalizedRight = normalizeSkillNames(right);
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((name, index) => name === normalizedRight[index]);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : '未知错误';
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
  // A君's production Feishu gateway still uses Hermes' default profile.  The
  // dedicated profiles/ajun directory is an isolation/rollback identity and
  // must not be checked in place of the actually running gateway.
  if (agentId === 'ajun') return path.resolve(os.homedir(), '.hermes');
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
        if (result.bundledSkillSeedingOptOut !== true) {
          console.log('  Hermes bundled skills 自动注入尚未关闭。');
        }
      } else if (result.status === 'apply-blocked') {
        console.log(`${result.agentId}: 发现 ${result.extraEnabledSkills.length} 个越权启用技能；因其他 Profile 不可检查，apply 整体未写入。`);
      } else {
        console.log(`${result.agentId}: 新禁用 ${result.newlyDisabledSkills.length} 个越权技能，关闭 bundled 自动注入，剩余 ${result.remainingExtraEnabledSkills?.length || 0} 个。`);
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

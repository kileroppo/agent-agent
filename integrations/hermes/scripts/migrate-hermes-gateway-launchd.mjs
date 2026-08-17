#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { HermesSkillWhitelistError } from './reconcile-hermes-skill-whitelist.mjs';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptPath);
const guardedGatewayScript = path.join(scriptDirectory, 'start-hermes-gateway-guarded.mjs');
const defaultLaunchAgentsRoot = path.join(os.homedir(), 'Library', 'LaunchAgents');
const BACKUP_DIRECTORY = '.agent-army-hermes-gateway-backups';
const agentIdPattern = /^[a-z][a-z0-9-]{0,63}$/;
const labelPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

export function parseLaunchdGatewayMigrationArgs(args = []) {
  const options = { apply:false, rollback:false, agentId:'', label:'', plistPath:'', backupPath:'', guardedScriptPath:'' };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--apply') options.apply = true;
    else if (value === '--rollback') options.rollback = true;
    else if (value === '--agent') options.agentId = args[++index] || '';
    else if (value === '--label') options.label = args[++index] || '';
    else if (value === '--plist') options.plistPath = args[++index] || '';
    else if (value === '--backup') options.backupPath = args[++index] || '';
    else if (value === '--guard-script') options.guardedScriptPath = args[++index] || '';
    else throw new HermesSkillWhitelistError(`未知参数：${value}`);
  }
  if (options.apply === options.rollback) {
    throw new HermesSkillWhitelistError('必须二选一指定 --apply 或 --rollback。');
  }
  return normalizeMigrationOptions(options);
}

export async function migrateHermesGatewayLaunchd({
  apply = false,
  rollback = false,
  agentId,
  label,
  plistPath,
  backupPath,
  launchAgentsRoot = defaultLaunchAgentsRoot,
  nodePath = process.execPath,
  guardedScriptPath = guardedGatewayScript,
  fileSystem = fs,
  readPlistLabel = defaultReadPlistLabel,
  readProgramArguments = defaultReadProgramArguments,
  writeProgramArguments = defaultWriteProgramArguments,
  lintPlist = defaultLintPlist
} = {}) {
  const options = normalizeMigrationOptions({ apply, rollback, agentId, label, plistPath, backupPath });
  const target = await assertSafeLaunchdPlist(options.plistPath, launchAgentsRoot, fileSystem);
  const actualLabel = await readPlistLabel(target);
  if (actualLabel !== options.label) {
    throw new HermesSkillWhitelistError('plist Label 与显式 --label 不匹配；拒绝修改。');
  }

  if (options.rollback) {
    const backup = await assertSafeBackup(options, target, launchAgentsRoot, fileSystem);
    await replaceFromBackup({ target, backup, fileSystem, lintPlist });
    return { mode:'rollback-applied', agentId:options.agentId, label:options.label, plistPath:target, backupPath:backup };
  }

  const guard = await assertSafeGuardedScript(guardedScriptPath, fileSystem);
  const currentArguments = normalizeProgramArguments(await readProgramArguments(target));
  if (!isHermesGatewayRun(currentArguments)) {
    throw new HermesSkillWhitelistError('当前 ProgramArguments 不是 Hermes gateway run；拒绝覆盖。');
  }
  const desiredArguments = [path.resolve(nodePath), guard, '--agent', options.agentId];
  if (!options.apply) {
    return { mode:'migration-dry-run', agentId:options.agentId, label:options.label, plistPath:target, currentArguments, desiredArguments };
  }

  const backup = await createExactBackup({ target, agentId:options.agentId, label:options.label, launchAgentsRoot, fileSystem });
  const staging = `${target}.agent-army-gateway-staging-${randomUUID()}`;
  try {
    await fileSystem.copyFile(target, staging);
    await writeProgramArguments(staging, desiredArguments);
    await lintPlist(staging);
    await fileSystem.rename(staging, target);
  } catch (error) {
    await fileSystem.rm(staging, { force:true }).catch(() => {});
    throw new HermesSkillWhitelistError(`launchd Gateway 门禁迁移失败；原 plist 未被替换，可从备份恢复。`, { cause:error });
  }
  return { mode:'migration-applied', agentId:options.agentId, label:options.label, plistPath:target, backupPath:backup, desiredArguments };
}

function normalizeMigrationOptions({ apply, rollback, agentId, label, plistPath, backupPath, guardedScriptPath }) {
  const normalized = {
    apply:apply === true,
    rollback:rollback === true,
    agentId:String(agentId || '').trim(),
    label:String(label || '').trim(),
    plistPath:String(plistPath || '').trim(),
    backupPath:String(backupPath || '').trim(),
    guardedScriptPath:String(guardedScriptPath || '').trim()
  };
  if (!agentIdPattern.test(normalized.agentId)) throw new HermesSkillWhitelistError('--agent 必须是合法岗位 ID。');
  if (!labelPattern.test(normalized.label)) throw new HermesSkillWhitelistError('--label 不合法。');
  if (!normalized.plistPath) throw new HermesSkillWhitelistError('--plist 必须显式指定单个 launchd plist。');
  if (normalized.rollback && !normalized.backupPath) throw new HermesSkillWhitelistError('--rollback 必须显式指定 --backup。');
  if (!normalized.rollback && normalized.backupPath) throw new HermesSkillWhitelistError('--backup 只能和 --rollback 一起使用。');
  if (normalized.rollback && normalized.guardedScriptPath) throw new HermesSkillWhitelistError('--guard-script 不能和 --rollback 一起使用。');
  return normalized;
}

async function assertSafeGuardedScript(candidate, fileSystem) {
  const resolved = path.resolve(candidate || guardedGatewayScript);
  if (path.basename(resolved) !== 'start-hermes-gateway-guarded.mjs') {
    throw new HermesSkillWhitelistError('Gateway 门禁入口文件名不合法。');
  }
  const state = await fileSystem.lstat(resolved).catch(() => null);
  if (!state?.isFile() || state.isSymbolicLink()) {
    throw new HermesSkillWhitelistError('Gateway 门禁入口不是安全普通文件。');
  }
  return resolved;
}

async function assertSafeLaunchdPlist(plistPath, launchAgentsRoot, fileSystem) {
  const root = path.resolve(launchAgentsRoot);
  const target = path.resolve(plistPath);
  if (!target.startsWith(`${root}${path.sep}`) || path.extname(target) !== '.plist') {
    throw new HermesSkillWhitelistError('--plist 必须位于单一用户 LaunchAgents 目录且以 .plist 结尾。');
  }
  const rootState = await fileSystem.lstat(root).catch(() => null);
  if (!rootState?.isDirectory() || rootState.isSymbolicLink()) {
    throw new HermesSkillWhitelistError('LaunchAgents 根目录不是安全普通目录。');
  }
  const state = await fileSystem.lstat(target).catch(() => null);
  if (!state?.isFile() || state.isSymbolicLink()) throw new HermesSkillWhitelistError('目标 plist 不是安全普通文件。');
  return target;
}

async function createExactBackup({ target, agentId, label, launchAgentsRoot, fileSystem }) {
  const parent = path.join(path.dirname(target), BACKUP_DIRECTORY);
  await fileSystem.mkdir(parent, { recursive:true, mode:0o700 });
  const parentState = await fileSystem.lstat(parent).catch(() => null);
  if (!parentState?.isDirectory() || parentState.isSymbolicLink()) throw new HermesSkillWhitelistError('launchd 备份目录不安全。');
  const root = path.join(parent, randomUUID());
  await fileSystem.mkdir(root, { mode:0o700 });
  const backup = path.join(root, path.basename(target));
  await fileSystem.copyFile(target, backup);
  await fileSystem.chmod(backup, 0o600);
  const backupSha256 = sha256(await fileSystem.readFile(backup));
  await fileSystem.writeFile(path.join(root, 'backup.json'), JSON.stringify({
    schemaVersion:'agent.army/hermes-gateway-launchd-backup/v1', agentId, label,
    plistBasename:path.basename(target), backupSha256
  }, null, 2), { encoding:'utf8', mode:0o600, flag:'wx' });
  return backup;
}

async function assertSafeBackup(options, target, launchAgentsRoot, fileSystem) {
  const backupRoot = path.join(path.dirname(target), BACKUP_DIRECTORY);
  const backup = path.resolve(options.backupPath);
  if (!backup.startsWith(`${backupRoot}${path.sep}`) || path.basename(backup) !== path.basename(target)) {
    throw new HermesSkillWhitelistError('--backup 不是该 plist 的受控精确备份。');
  }
  const state = await fileSystem.lstat(backup).catch(() => null);
  if (!state?.isFile() || state.isSymbolicLink()) throw new HermesSkillWhitelistError('备份不是安全普通文件。');
  const backupRootState = await fileSystem.lstat(backupRoot).catch(() => null);
  const backupDirectoryState = await fileSystem.lstat(path.dirname(backup)).catch(() => null);
  if (!backupRootState?.isDirectory() || backupRootState.isSymbolicLink()
    || !backupDirectoryState?.isDirectory() || backupDirectoryState.isSymbolicLink()) {
    throw new HermesSkillWhitelistError('备份目录不是安全普通目录。');
  }
  const metadataPath = path.join(path.dirname(backup), 'backup.json');
  const metadataState = await fileSystem.lstat(metadataPath).catch(() => null);
  if (!metadataState?.isFile() || metadataState.isSymbolicLink()) {
    throw new HermesSkillWhitelistError('备份元数据不是安全普通文件。');
  }
  let metadata;
  try { metadata = JSON.parse(await fileSystem.readFile(metadataPath, 'utf8')); } catch { throw new HermesSkillWhitelistError('备份元数据不可读；拒绝回滚。'); }
  if (metadata?.schemaVersion !== 'agent.army/hermes-gateway-launchd-backup/v1' || metadata.agentId !== options.agentId || metadata.label !== options.label || metadata.plistBasename !== path.basename(target)) {
    throw new HermesSkillWhitelistError('备份元数据与显式岗位、label 或 plist 不匹配；拒绝回滚。');
  }
  if (!/^[0-9a-f]{64}$/.test(String(metadata.backupSha256 || ''))
    || sha256(await fileSystem.readFile(backup)) !== metadata.backupSha256) {
    throw new HermesSkillWhitelistError('备份内容完整性核对失败；拒绝回滚。');
  }
  return backup;
}

async function replaceFromBackup({ target, backup, fileSystem, lintPlist }) {
  const staging = `${target}.agent-army-gateway-rollback-${randomUUID()}`;
  try {
    await fileSystem.copyFile(backup, staging);
    await lintPlist(staging);
    await fileSystem.rename(staging, target);
  } catch (error) {
    await fileSystem.rm(staging, { force:true }).catch(() => {});
    throw new HermesSkillWhitelistError('launchd Gateway 回滚失败；当前 plist 未被替换。', { cause:error });
  }
}

function normalizeProgramArguments(value) {
  if (!Array.isArray(value) || value.length < 3 || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new HermesSkillWhitelistError('plist ProgramArguments 结构不合法。');
  }
  return value.map((item) => item.trim());
}

function isHermesGatewayRun(argumentsList) {
  const lower = argumentsList.map((item) => item.toLowerCase());
  const gateway = lower.indexOf('gateway');
  return gateway > 0 && lower[gateway + 1] === 'run' && lower.slice(0, gateway).join(' ').includes('hermes');
}

async function defaultReadPlistLabel(plistPath) {
  const { stdout } = await execFileAsync('plutil', ['-extract', 'Label', 'raw', plistPath]);
  return String(stdout || '').trim();
}

async function defaultReadProgramArguments(plistPath) {
  const { stdout } = await execFileAsync('plutil', ['-extract', 'ProgramArguments', 'json', '-o', '-', plistPath]);
  try { return JSON.parse(String(stdout || '')); } catch { throw new HermesSkillWhitelistError('无法读取 plist ProgramArguments。'); }
}

async function defaultWriteProgramArguments(plistPath, argumentsList) {
  await execFileAsync('plutil', ['-replace', 'ProgramArguments', '-json', JSON.stringify(argumentsList), plistPath]);
}

async function defaultLintPlist(plistPath) {
  await execFileAsync('plutil', ['-lint', plistPath]);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function main() {
  try {
    const result = await migrateHermesGatewayLaunchd(parseLaunchdGatewayMigrationArgs(process.argv.slice(2)));
    console.log(`${result.label}: ${result.mode}${result.backupPath ? `；备份 ${result.backupPath}` : ''}`);
  } catch (error) {
    console.error(error instanceof HermesSkillWhitelistError ? error.message : 'launchd Gateway 门禁迁移失败。');
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) await main();

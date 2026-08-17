#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { validateAjunRuntimeRelease } from '../../../apps/ajun-runtime/scripts/manage-immutable-runtime-release.mjs';
import { HermesSkillWhitelistError } from './reconcile-hermes-skill-whitelist.mjs';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptPath);
const defaultLaunchAgentsRoot = path.join(os.homedir(), 'Library', 'LaunchAgents');
const BACKUP_DIRECTORY = '.agent-army-hermes-gateway-backups';
const GUARDED_GATEWAY_RELATIVE_PATH = path.join('integrations', 'hermes', 'scripts', 'start-hermes-gateway-guarded.mjs');
const SAFE_READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
const SAFE_CREATE_FLAGS = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
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
  guardedScriptPath = '',
  fileSystem = fs,
  validateRelease = validateAjunRuntimeRelease,
  readPlistLabel = defaultReadPlistLabel,
  readProgramArguments = defaultReadProgramArguments,
  writeProgramArguments = defaultWriteProgramArguments,
  lintPlist = defaultLintPlist
} = {}) {
  const options = normalizeMigrationOptions({ apply, rollback, agentId, label, plistPath, backupPath, guardedScriptPath });
  const targetRecord = await assertSafeLaunchdPlist(options.plistPath, launchAgentsRoot, fileSystem);
  const target = targetRecord.path;
  const actualLabel = await readPlistLabel(target);
  await assertUnchangedSafeFile(targetRecord, launchAgentsRoot, fileSystem, '目标 plist');
  if (actualLabel !== options.label) {
    throw new HermesSkillWhitelistError('plist Label 与显式 --label 不匹配；拒绝修改。');
  }

  if (options.rollback) {
    const backup = await assertSafeBackup(options, target, launchAgentsRoot, fileSystem);
    await replaceFromBackup({ target, targetRecord, backup, launchAgentsRoot, fileSystem, lintPlist });
    return { mode:'rollback-applied', agentId:options.agentId, label:options.label, plistPath:target, backupPath:backup.path };
  }

  const guard = await assertSafeGuardedScript(options.guardedScriptPath, fileSystem, validateRelease);
  const currentArguments = normalizeProgramArguments(await readProgramArguments(target));
  await assertUnchangedSafeFile(targetRecord, launchAgentsRoot, fileSystem, '目标 plist');
  if (!isHermesGatewayRun(currentArguments)) {
    throw new HermesSkillWhitelistError('当前 ProgramArguments 不是 Hermes gateway run；拒绝覆盖。');
  }
  const desiredArguments = [path.resolve(nodePath), guard.path, '--agent', options.agentId];
  if (!options.apply) {
    return { mode:'migration-dry-run', agentId:options.agentId, label:options.label, plistPath:target, currentArguments, desiredArguments };
  }

  await assertUnchangedSafeFile(guard, guard.releaseRoot, fileSystem, 'Gateway 门禁入口');
  const targetContent = await readVerifiedFile(targetRecord, launchAgentsRoot, fileSystem, '目标 plist');
  const backup = await createExactBackup({ target, targetRecord, targetContent, agentId:options.agentId, label:options.label, launchAgentsRoot, fileSystem });
  const staging = `${target}.agent-army-gateway-staging-${randomUUID()}`;
  try {
    const stagingRecord = await createVerifiedStaging(staging, targetRecord.parentChain, targetContent, sha256(targetContent), fileSystem);
    await assertOwnedStaging(stagingRecord, targetRecord.parentChain, fileSystem, '迁移暂存 plist');
    await writeProgramArguments(staging, desiredArguments);
    await assertOwnedStaging(stagingRecord, targetRecord.parentChain, fileSystem, '迁移暂存 plist');
    await lintPlist(staging);
    await assertOwnedStaging(stagingRecord, targetRecord.parentChain, fileSystem, '迁移暂存 plist');
    await assertUnchangedSafeFile(targetRecord, launchAgentsRoot, fileSystem, '目标 plist');
    await assertUnchangedSafeFile(guard, guard.releaseRoot, fileSystem, 'Gateway 门禁入口');
    await assertVerifiedBackupUnchanged(backup, launchAgentsRoot, fileSystem);
    await assertUnchangedDirectoryChain(targetRecord.parentChain, launchAgentsRoot, fileSystem, '目标 plist 父目录');
    await fileSystem.rename(staging, target);
  } catch (error) {
    await fileSystem.rm(staging, { force:true }).catch(() => {});
    throw new HermesSkillWhitelistError(`launchd Gateway 门禁迁移失败；原 plist 未被替换，可从备份恢复。`, { cause:error });
  }
  return { mode:'migration-applied', agentId:options.agentId, label:options.label, plistPath:target, backupPath:backup.path, desiredArguments };
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
  if (!normalized.rollback && !normalized.guardedScriptPath) throw new HermesSkillWhitelistError('--apply（含 dry-run）必须显式指定 --guard-script 的已验证不可变 release 入口。');
  if (normalized.rollback && normalized.guardedScriptPath) throw new HermesSkillWhitelistError('--guard-script 不能和 --rollback 一起使用。');
  return normalized;
}

async function assertSafeGuardedScript(candidate, fileSystem, validateRelease) {
  const resolved = path.resolve(candidate);
  const releaseRoot = path.resolve(path.dirname(resolved), '..', '..', '..');
  if (resolved !== path.join(releaseRoot, GUARDED_GATEWAY_RELATIVE_PATH)) {
    throw new HermesSkillWhitelistError('--guard-script 必须精确指向不可变 release 内 integrations/hermes/scripts/start-hermes-gateway-guarded.mjs。');
  }
  const manifestPath = path.join(releaseRoot, 'release-manifest.json');
  let releaseHash;
  try {
    const manifestState = await fileSystem.lstat(manifestPath);
    if (!manifestState.isFile() || manifestState.isSymbolicLink()) throw new Error('manifest 不是普通文件');
    releaseHash = JSON.parse(await fileSystem.readFile(manifestPath, 'utf8'))?.releaseHash;
  } catch {
    throw new HermesSkillWhitelistError('--guard-script 所属目录不是可验证的不可变 release。');
  }
  if (!/^[0-9a-f]{64}$/.test(String(releaseHash || ''))) {
    throw new HermesSkillWhitelistError('不可变 release 清单缺少合法 releaseHash。');
  }
  let verified;
  try {
    verified = await validateRelease(releaseRoot, releaseHash);
  } catch (error) {
    throw new HermesSkillWhitelistError('--guard-script 所属不可变 release 验证失败。', { cause:error });
  }
  const verifiedRoot = path.resolve(verified?.releaseRoot || '');
  if (!verifiedRoot || verifiedRoot !== releaseRoot) {
    throw new HermesSkillWhitelistError('不可变 release 验证结果与 --guard-script 路径不一致。');
  }
  const guard = await assertSafeFileInsideRoot(resolved, verifiedRoot, fileSystem, 'Gateway 门禁入口');
  return { ...guard, releaseRoot:verifiedRoot, releaseHash:verified.releaseHash };
}

async function assertSafeLaunchdPlist(plistPath, launchAgentsRoot, fileSystem) {
  const target = path.resolve(plistPath);
  if (path.extname(target) !== '.plist') {
    throw new HermesSkillWhitelistError('--plist 必须位于单一用户 LaunchAgents 目录且以 .plist 结尾。');
  }
  return assertSafeFileInsideRoot(target, launchAgentsRoot, fileSystem, '目标 plist');
}

function pathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function fileIdentity(stat) {
  return {
    dev:stat.dev,
    ino:stat.ino,
    size:stat.size,
    mode:stat.mode,
    mtimeMs:stat.mtimeMs,
    ctimeMs:stat.ctimeMs,
  };
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mode === right.mode
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function directoryIdentity(stat) {
  return { dev:stat.dev, ino:stat.ino };
}

function sameDirectoryIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function assertSafeDirectoryInsideRoot(directory, root, fileSystem, label) {
  const resolvedRoot = path.resolve(root);
  const resolvedDirectory = path.resolve(directory);
  if (resolvedDirectory !== resolvedRoot && !pathInside(resolvedRoot, resolvedDirectory)) {
    throw new HermesSkillWhitelistError(`${label}必须位于真实 LaunchAgents 根目录内。`);
  }
  const rootState = await fileSystem.lstat(resolvedRoot).catch(() => null);
  if (!rootState?.isDirectory() || rootState.isSymbolicLink()) {
    throw new HermesSkillWhitelistError('LaunchAgents 根目录不是安全普通目录。');
  }
  let canonicalRoot;
  try { canonicalRoot = await fileSystem.realpath(resolvedRoot); } catch {
    throw new HermesSkillWhitelistError('LaunchAgents 根目录无法解析为真实目录。');
  }
  let current = resolvedRoot;
  const chain = [{ path:resolvedRoot, identity:directoryIdentity(rootState) }];
  const relativeParts = path.relative(resolvedRoot, resolvedDirectory).split(path.sep).filter(Boolean);
  for (const part of relativeParts) {
    current = path.join(current, part);
    const state = await fileSystem.lstat(current).catch(() => null);
    if (!state?.isDirectory() || state.isSymbolicLink()) {
      throw new HermesSkillWhitelistError(`${label}路径包含符号链接或非普通目录。`);
    }
    const canonical = await fileSystem.realpath(current).catch(() => null);
    if (!canonical || (canonical !== canonicalRoot && !pathInside(canonicalRoot, canonical))) {
      throw new HermesSkillWhitelistError(`${label}不在真实 LaunchAgents 根目录内。`);
    }
    chain.push({ path:current, identity:directoryIdentity(state) });
  }
  return { path:resolvedDirectory, canonicalRoot, chain };
}

async function assertSafeFileInsideRoot(candidate, root, fileSystem, label) {
  const resolved = path.resolve(candidate);
  const directory = await assertSafeDirectoryInsideRoot(path.dirname(resolved), root, fileSystem, label);
  const before = await fileSystem.lstat(resolved).catch(() => null);
  if (!before?.isFile() || before.isSymbolicLink()) {
    throw new HermesSkillWhitelistError(`${label}不是安全普通文件。`);
  }
  const canonical = await fileSystem.realpath(resolved).catch(() => null);
  if (!canonical || (canonical !== directory.canonicalRoot && !pathInside(directory.canonicalRoot, canonical))) {
    throw new HermesSkillWhitelistError(`${label}不在真实 LaunchAgents 根目录内。`);
  }
  const after = await fileSystem.lstat(resolved).catch(() => null);
  if (!after || !sameFileIdentity(fileIdentity(before), fileIdentity(after)) || after.isSymbolicLink()) {
    throw new HermesSkillWhitelistError(`${label}检查期间发生路径漂移。`);
  }
  return { path:resolved, identity:fileIdentity(after), parentChain:directory };
}

async function assertUnchangedSafeFile(record, root, fileSystem, label) {
  const current = await assertSafeFileInsideRoot(record.path, root, fileSystem, label);
  if (!sameFileIdentity(record.identity, current.identity)) {
    throw new HermesSkillWhitelistError(`${label}在迁移期间发生变化；拒绝覆盖。`);
  }
  return current;
}

async function assertUnchangedDirectoryChain(record, root, fileSystem, label) {
  const current = await assertSafeDirectoryInsideRoot(record.path, root, fileSystem, label);
  if (current.chain.length !== record.chain.length
    || current.chain.some((entry, index) => !sameDirectoryIdentity(entry.identity, record.chain[index].identity))) {
    throw new HermesSkillWhitelistError(`${label}在迁移期间发生目录替换；拒绝覆盖。`);
  }
  return current;
}

async function readVerifiedFile(record, root, fileSystem, label) {
  await assertUnchangedSafeFile(record, root, fileSystem, label);
  let handle;
  try {
    handle = await fileSystem.open(record.path, SAFE_READ_FLAGS);
    const before = await handle.stat();
    if (!before.isFile() || !sameFileIdentity(record.identity, fileIdentity(before))) {
      throw new HermesSkillWhitelistError(`${label}打开时已被替换；拒绝读取。`);
    }
    const content = await handle.readFile();
    const after = await handle.stat();
    if (!sameFileIdentity(fileIdentity(before), fileIdentity(after))) {
      throw new HermesSkillWhitelistError(`${label}读取期间发生变化；拒绝使用。`);
    }
    await assertUnchangedSafeFile(record, root, fileSystem, label);
    return content;
  } catch (error) {
    if (error instanceof HermesSkillWhitelistError) throw error;
    throw new HermesSkillWhitelistError(`${label}无法以安全句柄读取。`, { cause:error });
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function createVerifiedStaging(stagingPath, parentChain, content, expectedSha256, fileSystem) {
  await assertUnchangedDirectoryChain(parentChain, parentChain.chain[0].path, fileSystem, '暂存目录');
  let handle;
  try {
    handle = await fileSystem.open(stagingPath, SAFE_CREATE_FLAGS, 0o600);
    await handle.writeFile(content);
    await handle.sync();
    const state = await handle.stat();
    if (!state.isFile()) throw new HermesSkillWhitelistError('迁移暂存 plist 不是普通文件。');
  } catch (error) {
    if (error instanceof HermesSkillWhitelistError) throw error;
    throw new HermesSkillWhitelistError('无法创建受控迁移暂存文件。', { cause:error });
  } finally {
    await handle?.close().catch(() => {});
  }
  const staging = await assertSafeFileInsideRoot(stagingPath, parentChain.path, fileSystem, '迁移暂存 plist');
  const bytes = await readVerifiedFile(staging, parentChain.path, fileSystem, '迁移暂存 plist');
  if (sha256(bytes) !== expectedSha256) {
    throw new HermesSkillWhitelistError('迁移暂存内容与已验证备份不一致；拒绝替换。');
  }
  return staging;
}

async function assertOwnedStaging(record, parentChain, fileSystem, label) {
  await assertUnchangedDirectoryChain(parentChain, parentChain.chain[0].path, fileSystem, `${label}父目录`);
  const state = await fileSystem.lstat(record.path).catch(() => null);
  if (!state?.isFile() || state.isSymbolicLink()
    || state.dev !== record.identity.dev || state.ino !== record.identity.ino) {
    throw new HermesSkillWhitelistError(`${label}在处理期间被替换；拒绝覆盖。`);
  }
  return state;
}

async function createExactBackup({ target, targetRecord, targetContent, agentId, label, launchAgentsRoot, fileSystem }) {
  const parent = path.join(path.dirname(target), BACKUP_DIRECTORY);
  await fileSystem.mkdir(parent, { recursive:true, mode:0o700 });
  const parentChain = await assertSafeDirectoryInsideRoot(parent, launchAgentsRoot, fileSystem, 'launchd 备份目录');
  const root = path.join(parent, randomUUID());
  await fileSystem.mkdir(root, { mode:0o700 });
  const backupDirectory = await assertSafeDirectoryInsideRoot(root, launchAgentsRoot, fileSystem, 'launchd 备份目录');
  const backup = path.join(root, path.basename(target));
  await assertUnchangedSafeFile(targetRecord, launchAgentsRoot, fileSystem, '目标 plist');
  const backupSha256 = sha256(targetContent);
  const backupRecord = await createVerifiedStaging(backup, backupDirectory, targetContent, backupSha256, fileSystem);
  const metadataPath = path.join(root, 'backup.json');
  const metadataContent = Buffer.from(JSON.stringify({
    schemaVersion:'agent.army/hermes-gateway-launchd-backup/v1', agentId, label,
    plistBasename:path.basename(target), backupSha256
  }, null, 2));
  const metadataRecord = await createVerifiedStaging(metadataPath, backupDirectory, metadataContent, sha256(metadataContent), fileSystem);
  await assertUnchangedDirectoryChain(parentChain, launchAgentsRoot, fileSystem, 'launchd 备份目录');
  return { path:backup, record:backupRecord, metadataPath, metadataRecord, backupSha256, directory:backupDirectory };
}

async function assertSafeBackup(options, target, launchAgentsRoot, fileSystem) {
  const backupRoot = path.join(path.dirname(target), BACKUP_DIRECTORY);
  const backup = path.resolve(options.backupPath);
  if (!pathInside(backupRoot, backup) || path.basename(backup) !== path.basename(target)) {
    throw new HermesSkillWhitelistError('--backup 不是该 plist 的受控精确备份。');
  }
  await assertSafeDirectoryInsideRoot(backupRoot, launchAgentsRoot, fileSystem, '备份目录');
  const backupRecord = await assertSafeFileInsideRoot(backup, backupRoot, fileSystem, '备份');
  const metadataPath = path.join(path.dirname(backup), 'backup.json');
  const metadataRecord = await assertSafeFileInsideRoot(metadataPath, backupRoot, fileSystem, '备份元数据');
  let metadata;
  try {
    metadata = JSON.parse((await readVerifiedFile(metadataRecord, backupRoot, fileSystem, '备份元数据')).toString('utf8'));
  } catch { throw new HermesSkillWhitelistError('备份元数据不可读；拒绝回滚。'); }
  if (metadata?.schemaVersion !== 'agent.army/hermes-gateway-launchd-backup/v1' || metadata.agentId !== options.agentId || metadata.label !== options.label || metadata.plistBasename !== path.basename(target)) {
    throw new HermesSkillWhitelistError('备份元数据与显式岗位、label 或 plist 不匹配；拒绝回滚。');
  }
  if (!/^[0-9a-f]{64}$/.test(String(metadata.backupSha256 || ''))) {
    throw new HermesSkillWhitelistError('备份内容完整性核对失败；拒绝回滚。');
  }
  const content = await readVerifiedFile(backupRecord, backupRoot, fileSystem, '备份');
  if (sha256(content) !== metadata.backupSha256) {
    throw new HermesSkillWhitelistError('备份内容完整性核对失败；拒绝回滚。');
  }
  return { path:backup, record:backupRecord, metadataPath, metadataRecord, backupSha256:metadata.backupSha256, content };
}

async function replaceFromBackup({ target, targetRecord, backup, launchAgentsRoot, fileSystem, lintPlist }) {
  const staging = `${target}.agent-army-gateway-rollback-${randomUUID()}`;
  try {
    const stagingRecord = await createVerifiedStaging(staging, targetRecord.parentChain, backup.content, backup.backupSha256, fileSystem);
    await assertOwnedStaging(stagingRecord, targetRecord.parentChain, fileSystem, '回滚暂存 plist');
    await lintPlist(staging);
    await assertOwnedStaging(stagingRecord, targetRecord.parentChain, fileSystem, '回滚暂存 plist');
    const stagedContent = await readVerifiedFile(stagingRecord, targetRecord.parentChain.path, fileSystem, '回滚暂存 plist');
    if (sha256(stagedContent) !== backup.backupSha256) {
      throw new HermesSkillWhitelistError('回滚暂存内容与已验证备份不一致；拒绝替换。');
    }
    await assertUnchangedSafeFile(targetRecord, launchAgentsRoot, fileSystem, '目标 plist');
    await assertVerifiedBackupUnchanged(backup, launchAgentsRoot, fileSystem);
    await assertUnchangedDirectoryChain(targetRecord.parentChain, launchAgentsRoot, fileSystem, '目标 plist 父目录');
    await fileSystem.rename(staging, target);
  } catch (error) {
    await fileSystem.rm(staging, { force:true }).catch(() => {});
    throw new HermesSkillWhitelistError('launchd Gateway 回滚失败；当前 plist 未被替换。', { cause:error });
  }
}

async function assertVerifiedBackupUnchanged(backup, launchAgentsRoot, fileSystem) {
  await assertUnchangedDirectoryChain(backup.record.parentChain, backup.record.parentChain.chain[0].path, fileSystem, '备份目录');
  await assertUnchangedDirectoryChain(backup.metadataRecord.parentChain, backup.metadataRecord.parentChain.chain[0].path, fileSystem, '备份目录');
  const metadata = await readVerifiedFile(backup.metadataRecord, launchAgentsRoot, fileSystem, '备份元数据');
  const content = await readVerifiedFile(backup.record, launchAgentsRoot, fileSystem, '备份');
  let parsed;
  try { parsed = JSON.parse(metadata.toString('utf8')); } catch { throw new HermesSkillWhitelistError('备份元数据不可读；拒绝回滚。'); }
  if (parsed?.backupSha256 !== backup.backupSha256 || sha256(content) !== backup.backupSha256) {
    throw new HermesSkillWhitelistError('备份在迁移期间发生变化；拒绝覆盖。');
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

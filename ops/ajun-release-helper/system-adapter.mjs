import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {
  AJUN_RELEASE_PREFIX,
  validateAjunRuntimeRelease,
} from '../../apps/ajun-runtime/scripts/manage-immutable-runtime-release.mjs';

const ENTRYPOINT_SUFFIX = path.join('apps', 'ajun-runtime', 'src', 'server.ts');
const WORKDIR_SUFFIX = path.join('apps', 'ajun-runtime');

export class AjunReleaseSystemAdapter {
  constructor({
    repositoryRoot,
    mainPlist,
    stateDir,
    deployRoot,
    sourceParent,
    label = 'ai.agent-army.ajun-runtime',
    appPort = 4321,
    runCommand = defaultRunCommand,
    fetchFn = fetch,
    listenerPidsForPort,
    validateRelease = validateAjunRuntimeRelease,
    copyRelease = (source, destination, options) => fs.cp(source, destination, options),
  } = {}) {
    for (const [name, value] of Object.entries({ repositoryRoot, mainPlist, stateDir, deployRoot, sourceParent })) {
      if (!value) throw new Error(`缺少${name}`);
    }
    this.repositoryRoot = path.resolve(repositoryRoot);
    this.mainPlist = path.resolve(mainPlist);
    this.stateDir = path.resolve(stateDir);
    this.deployRoot = path.resolve(deployRoot);
    this.sourceParent = path.resolve(sourceParent);
    this.historyPath = path.join(this.stateDir, 'history.json');
    // This is deliberately separate from history.json.  It is written before
    // changing the plist, so a successful cutover never loses its only route
    // back merely because the final history write is interrupted.
    this.recoveryPath = path.join(this.stateDir, 'activation-recovery.json');
    this.label = label;
    this.appPort = Number(appPort);
    this.runCommand = runCommand;
    this.fetchFn = fetchFn;
    this.validateRelease = validateRelease;
    this.copyRelease = copyRelease;
    this.listenerPidsForPort = listenerPidsForPort || ((port) => this.defaultListenerPidsForPort(port));
  }

  async inspect() {
    const [branch, gitHead, dirty, current] = await Promise.all([
      this.git(['branch', '--show-current']),
      this.git(['rev-parse', 'HEAD']),
      this.git(['status', '--porcelain', '--untracked-files=all']),
      this.readCurrentRelease(),
    ]);
    const clean = dirty === '';
    const updateAvailable = gitHead !== current.gitHead;
    const branchReady = branch === 'main';
    let verification;
    try {
      verification = await this.verifyLive(current);
    } catch {
      verification = publicVerification(null);
    }
    const liveVerified = requiredVerificationPassed(verification);
    const history = await this.reconcileRollbackHistory(current, verification);
    const canPublish = clean && branchReady && updateAvailable && liveVerified;
    const message = !clean
      ? '正式仓库有未提交改动；这些内容不会发布，请先整理成正式版本。'
      : !branchReady
        ? '正式仓库当前不在 main，不能从页面发布。'
        : !liveVerified
          ? '线上运行身份未通过核对；先恢复当前服务，不能冒险切换新版。'
        : !updateAvailable
          ? '当前已经是最新版。'
          : `发现新版 ${shortHash(gitHead)}，可以发布。`;
    return {
      canPublish,
      updateAvailable,
      message,
      current:publicRelease({
        ...current,
        verification:{ ...verification, rollbackAvailable:Boolean(history?.previous) },
      }),
      candidate:publicCandidate({ gitHead, branch, clean, canPublish, updateAvailable }),
      rollback:history?.previous ? publicRelease(history.previous) : null,
    };
  }

  async publish({ inspection, onStage }) {
    const current = await this.readCurrentRelease();
    if (inspection.candidate.gitHead === current.gitHead) throw new Error('当前已经是最新版。');
    await onStage('preparing_source', '正在准备独立、干净的候选源码。');
    const sourceRoot = await this.prepareCandidateSource(inspection.candidate.gitHead);
    await onStage('verifying', '正在安装锁定依赖并运行完整验证。');
    await this.runCommand('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline'], { cwd:sourceRoot });
    await onStage('freezing', '验证通过，正在生成不可变 release。');
    const frozen = await this.freezeCandidate(sourceRoot, inspection.candidate.gitHead);
    const deployed = await this.deployCandidateRelease(frozen);
    await onStage('activating', '已备份旧版，正在切换 A君。');
    let recovery = null;
    const backupPlist = await this.activateCandidate({
      candidate:deployed,
      sourceRoot,
      previous:current,
      onBackupPrepared:async (backup) => {
        recovery = activationRecovery({ candidate:deployed, previous:current, backupPlist:backup });
        await this.writeRecovery(recovery);
      },
    });
    await onStage('verifying_live', '新版已启动，正在核对 PID、版本和 4321。');
    const verification = await this.verifyLive(deployed);
    if (recovery) {
      recovery = { ...recovery, state:'verified', verifiedAt:new Date().toISOString() };
      try {
        await this.writeRecovery(recovery);
      } catch (error) {
        throw activeReleaseHistoryError(error, deployed, current, verification);
      }
    }
    try {
      await this.writeHistory({
        schemaVersion:'agent.army/self-service-release-history/v1',
        activatedAt:new Date().toISOString(),
        current:deployed,
        previous:current,
        backupPlist,
      });
    } catch (error) {
      if (recovery) throw activeReleaseHistoryError(error, deployed, current, verification);
      throw error;
    }
    // history.json is now durable.  A stale recovery file is harmless and is
    // intentionally left for the next successful write/cleanup rather than
    // turning an already committed release into a reported failure.
    await this.clearRecovery().catch(() => {});
    return {
      current:publicRelease({ ...deployed, verification:{ ...verification, rollbackAvailable:true } }),
      rollback:publicRelease(current),
    };
  }

  async rollback({ onStage }) {
    const current = await this.readCurrentRelease();
    const currentVerification = await this.verifyLive(current);
    const history = await this.readRollbackHistory(current, currentVerification);
    if (!history?.previous || !history?.backupPlist) throw new Error('没有可用的上一版。');
    await onStage('rolling_back', '正在恢复上一版启动配置。');
    const currentBackup = await this.backupMainPlist(`rollback-${Date.now()}`);
    try {
      await this.replaceMainPlist(history.backupPlist);
      const verification = await this.restartAndVerify(history.previous);
      await this.writeHistory({
        schemaVersion:'agent.army/self-service-release-history/v1',
        rolledBackAt:new Date().toISOString(),
        current:history.previous,
        previous:null,
        backupPlist:null,
      });
      await this.clearRecovery().catch(() => {});
      return {
        current:publicRelease({ ...history.previous, verification:{ ...verification, rollbackAvailable:false } }),
        rollback:null,
      };
    } catch (error) {
      await this.replaceMainPlist(currentBackup);
      await this.restartAndVerify(current);
      throw new Error(`退回失败，当前版本已恢复：${error.message}`);
    }
  }

  async prepareCandidateSource(gitHead) {
    await fs.mkdir(this.sourceParent, { recursive:true, mode:0o700 });
    const sourceRoot = path.join(this.sourceParent, `self-service-${shortHash(gitHead)}`);
    try {
      const stat = await fs.lstat(sourceRoot);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('候选源码路径不是普通目录。');
      const [existingHead, status] = await Promise.all([
        this.runCommand('git', ['-C', sourceRoot, 'rev-parse', 'HEAD']),
        this.runCommand('git', ['-C', sourceRoot, 'status', '--porcelain', '--untracked-files=no']),
      ]);
      if (existingHead.stdout.trim() !== gitHead || status.stdout.trim()) throw new Error('既有候选源码与当前版本不一致。');
      return sourceRoot;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await this.runCommand('git', ['-C', this.repositoryRoot, 'worktree', 'add', '--detach', sourceRoot, gitHead]);
    return sourceRoot;
  }

  async freezeCandidate(sourceRoot, expectedGitHead) {
    const outputParent = path.join(sourceRoot, 'work', 'runtime-releases');
    try {
      await this.runCommand(process.execPath, [
        path.join(sourceRoot, 'apps', 'ajun-runtime', 'scripts', 'manage-immutable-runtime-release.mjs'),
        'freeze', '--repo-root', sourceRoot, '--output-parent', outputParent, '--verify',
      ], { cwd:sourceRoot });
    } catch (error) {
      throw new Error(`完整验证未通过：${error?.message || 'A君测试或发布校验失败'}。请在候选源码运行 npm test 查看首个失败项；未生成新 release，也没有切换线上服务。`);
    }
    const candidates = [];
    for (const name of await fs.readdir(outputParent)) {
      if (!name.startsWith('ajun-runtime-release-v1-')) continue;
      const root = path.join(outputParent, name);
      const manifest = await readReleaseManifest(root, this.validateRelease);
      if (manifest.gitHead === expectedGitHead) candidates.push({ ...manifest, releaseRoot:root });
    }
    if (candidates.length !== 1) throw new Error('完整验证后没有得到唯一候选 release。');
    return candidates[0];
  }

  async deployCandidateRelease(frozen) {
    await fs.mkdir(this.deployRoot, { recursive:true, mode:0o700 });
    const target = path.join(this.deployRoot, path.basename(frozen.releaseRoot));
    try {
      const existing = await validateImmutableRelease(target, frozen.releaseHash, {
        deployRoot:this.deployRoot,
        validator:this.validateRelease,
      });
      if (existing.releaseHash !== frozen.releaseHash) throw new Error('部署目录已有不同身份的同名 release。');
      return { ...existing, releaseRoot:target };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const source = await validateImmutableRelease(frozen.releaseRoot, frozen.releaseHash, {
      validator:this.validateRelease,
    });
    if (source.payloadHash !== frozen.payloadHash) {
      throw new Error('冻结 release 身份与候选不一致。');
    }
    const stagingParent = path.join(this.deployRoot, `.staging-${randomUUID()}`);
    await fs.mkdir(stagingParent, { mode:0o700 });
    const stagingParentIdentity = await directoryIdentity(stagingParent, '部署 staging 目录');
    const stagedRelease = path.join(stagingParent, path.basename(frozen.releaseRoot));
    try {
      await this.copyRelease(frozen.releaseRoot, stagedRelease, {
        recursive:true, force:false, verbatimSymlinks:true,
      });
      const stagedIdentity = await directoryIdentity(stagedRelease, '部署 staging release');
      const staged = await validateImmutableRelease(stagedRelease, frozen.releaseHash, {
        deployRoot:this.deployRoot,
        validator:this.validateRelease,
      });
      if (staged.payloadHash !== frozen.payloadHash) {
        throw new Error('部署 staging 副本身份与冻结 release 不一致。');
      }
      await validateImmutableRelease(frozen.releaseRoot, frozen.releaseHash, {
        validator:this.validateRelease,
      });
      await moveStagedReleaseIntoPlace({
        stagedRelease,
        target,
        stagingParentIdentity,
        stagedIdentity,
      });
      try {
        const deployed = await validateImmutableRelease(target, frozen.releaseHash, {
          deployRoot:this.deployRoot,
          validator:this.validateRelease,
        });
        if (deployed.payloadHash !== frozen.payloadHash) {
          throw new Error('部署副本身份与冻结 release 不一致。');
        }
        return deployed;
      } catch (error) {
        throw new Error(
          `部署副本最终校验失败；正式目标需人工核验，未自动移动或删除。${error.message}`,
          { cause:error },
        );
      }
    } finally {
      await cleanupEmptyStagingParent(stagingParentIdentity);
    }
  }

  async activateCandidate({ candidate, sourceRoot, previous, onBackupPrepared }) {
    const runId = `${Date.now()}-${shortHash(candidate.gitHead)}`;
    const backupPlist = await this.backupMainPlist(runId);
    if (onBackupPrepared) await onBackupPrepared(backupPlist);
    const stagedPlist = path.join(this.stateDir, `candidate-${runId}.plist`);
    await fs.copyFile(this.mainPlist, stagedPlist);
    await fs.chmod(stagedPlist, 0o600);
    const workingDirectory = path.join(candidate.releaseRoot, WORKDIR_SUFFIX);
    const entrypoint = path.join(candidate.releaseRoot, ENTRYPOINT_SUFFIX);
    await this.runCommand('/usr/libexec/PlistBuddy', ['-c', `Set :ProgramArguments:1 ${entrypoint}`, stagedPlist]);
    await this.runCommand('/usr/libexec/PlistBuddy', ['-c', `Set :WorkingDirectory ${workingDirectory}`, stagedPlist]);
    await this.runCommand('/usr/libexec/PlistBuddy', ['-c', `Set :EnvironmentVariables:AGENT_ARMY_SOURCE_PROJECT_ROOT ${sourceRoot}`, stagedPlist]);
    await this.runCommand('plutil', ['-lint', stagedPlist]);
    try {
      await this.replaceMainPlist(stagedPlist);
      await this.restartAndVerify({ ...candidate, workingDirectory, sourceRoot });
      return backupPlist;
    } catch (error) {
      try {
        await this.replaceMainPlist(backupPlist);
        await this.restartAndVerify(previous);
      } catch (rollbackError) {
        throw new Error(`新版启动失败且自动恢复失败：${rollbackError.message}`);
      }
      const rolledBack = new Error(`新版启动失败：${error.message}`);
      rolledBack.rolledBack = true;
      throw rolledBack;
    }
  }

  async backupMainPlist(runId) {
    const directory = path.join(this.stateDir, 'backups');
    await fs.mkdir(directory, { recursive:true, mode:0o700 });
    const backup = path.join(directory, `ajun-runtime-${runId}.plist`);
    await fs.copyFile(this.mainPlist, backup, fs.constants.COPYFILE_EXCL);
    await fs.chmod(backup, 0o600);
    return backup;
  }

  async replaceMainPlist(source) {
    const temporary = `${this.mainPlist}.${process.pid}.tmp`;
    await fs.copyFile(source, temporary);
    await fs.chmod(temporary, 0o600);
    await this.runCommand('plutil', ['-lint', temporary]);
    await fs.rename(temporary, this.mainPlist);
  }

  async restartAndVerify(expected) {
    const domain = `gui/${process.getuid()}`;
    try {
      await this.runCommand('launchctl', ['bootout', `${domain}/${this.label}`]);
    } catch {
      // A stopped or failed job can still be safely bootstrapped from the fixed plist.
    }
    await waitUntil(async () => !(await this.serviceLoaded(domain)) && !(await portOpen(this.appPort)), 20_000);
    await this.runCommand('launchctl', ['bootstrap', domain, this.mainPlist]);
    await this.runCommand('launchctl', ['kickstart', `${domain}/${this.label}`]);
    let verification = null;
    await waitUntil(async () => {
      try {
        verification = await this.verifyLive(expected);
        return true;
      } catch {
        return false;
      }
    }, 60_000);
    return verification;
  }

  async verifyLive(expected) {
    const domain = `gui/${process.getuid()}`;
    const liveManifest = await validateImmutableRelease(expected.releaseRoot, expected.releaseHash, {
      deployRoot:this.deployRoot,
      validator:this.validateRelease,
    });
    const printed = await this.runCommand('launchctl', ['print', `${domain}/${this.label}`]);
    const expectedWorkingDirectory = expected.workingDirectory || path.join(liveManifest.releaseRoot, WORKDIR_SUFFIX);
    if (!printed.stdout.includes(`working directory = ${expectedWorkingDirectory}`)) throw new Error('launchd 工作目录不是目标 release。');
    if (!/\bpid = \d+/.test(printed.stdout)) throw new Error('launchd 没有活动 PID。');
    const pid = launchdPid(printed.stdout);
    if (!pid) throw new Error('launchd 没有活动 PID。');
    const listenerPids = await this.listenerPidsForPort(this.appPort);
    if (listenerPids.length !== 1 || listenerPids[0] !== pid) {
      throw new Error('4321 listener PID 与 launchd 目标 PID 不一致。');
    }
    const cwd = await this.processCwd(pid);
    if (cwd !== expectedWorkingDirectory) throw new Error('A君实际工作目录不是目标 release。');
    const argv = await this.processArgv(pid);
    const expectedEntrypoint = path.join(liveManifest.releaseRoot, ENTRYPOINT_SUFFIX);
    if (!argv.includes(expectedEntrypoint)) throw new Error('A君实际启动参数不是目标 release。');
    const response = await this.fetchFn(`http://127.0.0.1:${this.appPort}/api/console-overview`, { signal:AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`4321 返回 HTTP ${response.status}。`);
    const overview = await response.json();
    if (overview?.schemaVersion !== 'agent.army/console-overview/v2') throw new Error('4321 响应不符合 A君控制台概览契约。');
    if (liveManifest.releaseHash !== expected.releaseHash) throw new Error('线上 release hash 身份不匹配。');
    if (liveManifest.payloadHash !== expected.payloadHash) throw new Error('线上 payload hash 身份不匹配。');
    if (liveManifest.gitHead !== expected.gitHead) throw new Error('线上 Git HEAD 身份不匹配。');
    return publicVerification({
      pid,
      verifiedAt:new Date().toISOString(),
      checks:{ pid:true, listener:true, cwd:true, argv:true, releaseHash:true, payloadHash:true, gitHead:true, api:true },
    });
  }

  async processCwd(pid) {
    const result = await this.runCommand('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
    const cwd = result.stdout.split(/\r?\n/).find((line) => line.startsWith('n'))?.slice(1) || '';
    if (!cwd) throw new Error('无法读取 A君实际工作目录。');
    return cwd;
  }

  async processArgv(pid) {
    const result = await this.runCommand('ps', ['-p', String(pid), '-o', 'command=']);
    const argv = result.stdout.trim();
    if (!argv) throw new Error('无法读取 A君实际启动参数。');
    return argv;
  }

  async defaultListenerPidsForPort(port) {
    const result = await this.runCommand('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp']);
    const pids = [...new Set(result.stdout.split(/\r?\n/)
      .filter((line) => /^p\d+$/.test(line))
      .map((line) => Number.parseInt(line.slice(1), 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0))];
    if (!pids.length) throw new Error('4321 没有可核对的 listener PID。');
    return pids;
  }

  async serviceLoaded(domain) {
    try {
      await this.runCommand('launchctl', ['print', `${domain}/${this.label}`]);
      return true;
    } catch {
      return false;
    }
  }

  async writeHistory(history) {
    await fs.mkdir(this.stateDir, { recursive:true, mode:0o700 });
    const temporary = `${this.historyPath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(history, null, 2)}\n`, { mode:0o600 });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, this.historyPath);
  }

  async writeRecovery(recovery) {
    await fs.mkdir(this.stateDir, { recursive:true, mode:0o700 });
    const temporary = `${this.recoveryPath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(recovery, null, 2)}\n`, { mode:0o600 });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, this.recoveryPath);
  }

  async clearRecovery() {
    await fs.unlink(this.recoveryPath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }

  async git(args) {
    const result = await this.runCommand('git', ['-C', this.repositoryRoot, ...args]);
    return result.stdout.trim();
  }

  async readCurrentRelease() {
    const [entrypoint, workingDirectory, sourceRoot] = await Promise.all([
      this.plistValue(':ProgramArguments:1'),
      this.plistValue(':WorkingDirectory'),
      this.plistValue(':EnvironmentVariables:AGENT_ARMY_SOURCE_PROJECT_ROOT'),
    ]);
    if (!entrypoint.endsWith(ENTRYPOINT_SUFFIX)) throw new Error('A君启动入口不是受支持的 TypeScript server。');
    if (!workingDirectory.endsWith(WORKDIR_SUFFIX)) throw new Error('A君工作目录不是受支持的不可变 release。');
    if (path.dirname(entrypoint) !== path.join(workingDirectory, 'src')) {
      throw new Error('A君启动入口与工作目录不一致。');
    }
    const releaseRoot = workingDirectory.slice(0, -WORKDIR_SUFFIX.length).replace(/[\\/]$/, '');
    const manifest = await validateImmutableRelease(releaseRoot, undefined, {
      deployRoot:this.deployRoot,
      validator:this.validateRelease,
    });
    return { ...manifest, sourceRoot, entrypoint, workingDirectory };
  }

  async plistValue(key) {
    const result = await this.runCommand('/usr/libexec/PlistBuddy', ['-c', `Print ${key}`, this.mainPlist]);
    return result.stdout.trim();
  }

  async readHistory() {
    try {
      return JSON.parse(await fs.readFile(this.historyPath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async readRollbackHistory(current, verification) {
    const history = await this.readHistory();
    if (history?.current && sameRelease(history.current, current) && await isUsableBackup(history.backupPlist)) return history;
    const recovery = await this.readRecovery();
    // A pre-activation record is only promotable after the *actual* current
    // process has passed the complete live proof.  It is never mistaken for a
    // completed rollback record just because a backup file exists.
    if (
      recovery
      && sameRelease(recovery.current, current)
      && requiredVerificationPassed(verification)
      && await isUsableBackup(recovery.backupPlist)
    ) return {
      schemaVersion:'agent.army/self-service-release-history/v1',
      current:recovery.current,
      previous:recovery.previous,
      backupPlist:recovery.backupPlist,
      recoveryPending:true,
    };
    return null;
  }

  async reconcileRollbackHistory(current, verification) {
    const history = await this.readRollbackHistory(current, verification);
    if (!history?.recoveryPending) return history;
    try {
      await this.writeHistory({
        schemaVersion:'agent.army/self-service-release-history/v1',
        recoveredAt:new Date().toISOString(),
        current:history.current,
        previous:history.previous,
        backupPlist:history.backupPlist,
      });
      await this.clearRecovery();
      return { ...history, recoveryPending:false };
    } catch {
      // The journal remains the authoritative, usable rollback record until
      // its next successful reconciliation.  Do not hide it or claim the
      // persistent history was repaired.
      return history;
    }
  }

  async readRecovery() {
    try {
      const value = JSON.parse(await fs.readFile(this.recoveryPath, 'utf8'));
      if (!isActivationRecovery(value)) throw new Error('恢复记录格式不合法。');
      return value;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }
}

export async function defaultRunCommand(command, args, { cwd, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio:['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let size = 0;
    for (const [stream, target] of [[child.stdout, stdout], [child.stderr, stderr]]) {
      stream.on('data', (chunk) => {
        size += chunk.length;
        if (size <= 2 * 1024 * 1024) target.push(chunk);
      });
    }
    child.once('error', reject);
    child.once('close', (code) => {
      const result = { code, stdout:Buffer.concat(stdout).toString('utf8'), stderr:Buffer.concat(stderr).toString('utf8') };
      if (code === 0) resolve(result);
      else {
        const detail = (result.stderr?.trim() || result.stdout?.trim() || '').slice(-300);
        reject(new Error(`${path.basename(command)} 执行失败（${code}）${detail ? `: ${detail}` : ''}`));
      }
    });
  });
}

async function readReleaseManifest(releaseRoot, validator = validateAjunRuntimeRelease) {
  const releaseHash = releaseHashFromDirectory(releaseRoot);
  const validated = await validator(releaseRoot, releaseHash);
  return {
    releaseHash:validated.releaseHash,
    payloadHash:validated.payloadHash,
    gitHead:validated.manifest.git.gitHead,
  };
}

async function validateImmutableRelease(releaseRoot, expectedReleaseHash, {
  deployRoot,
  validator = validateAjunRuntimeRelease,
} = {}) {
  const canonicalRoot = deployRoot
    ? await assertPlainContainedReleaseRoot(deployRoot, releaseRoot)
    : path.resolve(releaseRoot);
  const rootStat = await fs.lstat(canonicalRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('部署 release 根目录不是普通目录。');
  if ((rootStat.mode & 0o777) !== 0o555) throw new Error('部署 release 根目录不是只读模式。');
  const releaseHash = expectedReleaseHash || releaseHashFromDirectory(canonicalRoot);
  const validated = await validator(canonicalRoot, releaseHash);
  return {
    releaseHash:validated.releaseHash,
    payloadHash:validated.payloadHash,
    gitHead:validated.manifest.git.gitHead,
    // Keep the configured spelling for launchd cwd/argv comparison.  The
    // containment decision above was made with real paths and every segment
    // below deployRoot has already been proved to be a plain directory.
    releaseRoot:path.resolve(releaseRoot),
  };
}

function releaseHashFromDirectory(releaseRoot) {
  const name = path.basename(path.resolve(releaseRoot));
  const releaseHash = name.startsWith(AJUN_RELEASE_PREFIX)
    ? name.slice(AJUN_RELEASE_PREFIX.length)
    : '';
  if (!/^[a-f0-9]{64}$/.test(releaseHash)) {
    throw new Error('部署 release 目录名没有绑定完整 release hash。');
  }
  return releaseHash;
}

async function directoryIdentity(directory, label) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label}必须是普通目录。`);
  }
  return { root:directory, dev:stat.dev, ino:stat.ino, label };
}

async function assertDirectoryIdentity(identity) {
  const stat = await fs.lstat(identity.root);
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || stat.dev !== identity.dev
    || stat.ino !== identity.ino
  ) {
    throw new Error(`${identity.label}身份发生漂移。`);
  }
}

async function moveStagedReleaseIntoPlace({
  stagedRelease,
  target,
  stagingParentIdentity,
  stagedIdentity,
}) {
  await assertDirectoryIdentity(stagingParentIdentity);
  await assertDirectoryIdentity(stagedIdentity);
  try {
    await fs.rename(stagedRelease, target);
    return;
  } catch (error) {
    if (!['EACCES', 'EPERM'].includes(error?.code)) throw error;
    const existingTarget = await fs.lstat(target).catch((targetError) => {
      if (targetError?.code === 'ENOENT') return null;
      throw targetError;
    });
    if (existingTarget) throw error;
  }

  // macOS refuses to move a 0555 directory across parents even when both
  // parents are owned and writable.  Only the release root gains owner-write;
  // all payload entries remain read-only.  The final target is restored to
  // 0555 before the mandatory post-rename formal validation.
  await assertDirectoryIdentity(stagingParentIdentity);
  await assertDirectoryIdentity(stagedIdentity);
  await fs.chmod(stagedRelease, 0o755);
  try {
    await assertDirectoryIdentity(stagingParentIdentity);
    await assertDirectoryIdentity(stagedIdentity);
    await fs.rename(stagedRelease, target);
  } catch (error) {
    await fs.chmod(stagedRelease, 0o555).catch(() => {});
    throw error;
  }
  await fs.chmod(target, 0o555);
}

async function cleanupEmptyStagingParent(identity) {
  const current = await fs.lstat(identity.root).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (
    !current
    || !current.isDirectory()
    || current.isSymbolicLink()
    || current.dev !== identity.dev
    || current.ino !== identity.ino
  ) return false;
  if ((await fs.readdir(identity.root)).length) return false;
  await assertDirectoryIdentity(identity);
  await fs.rmdir(identity.root);
  return true;
}

async function assertPlainContainedReleaseRoot(deployRoot, releaseRoot) {
  const lexicalDeployRoot = path.resolve(deployRoot);
  const lexicalReleaseRoot = path.resolve(releaseRoot);
  const relative = path.relative(lexicalDeployRoot, lexicalReleaseRoot);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('release 根目录必须位于受信任部署目录内。');
  }
  const deployStat = await fs.lstat(lexicalDeployRoot);
  if (!deployStat.isDirectory() || deployStat.isSymbolicLink()) throw new Error('部署目录不是普通目录。');
  const canonicalDeployRoot = await fs.realpath(lexicalDeployRoot);
  let current = lexicalDeployRoot;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('release 路径含软链或非目录中间节点。');
    }
  }
  const canonicalReleaseRoot = await fs.realpath(lexicalReleaseRoot);
  const canonicalRelative = path.relative(canonicalDeployRoot, canonicalReleaseRoot);
  if (!canonicalRelative || canonicalRelative === '..' || canonicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(canonicalRelative)) {
    throw new Error('release 根目录真实路径不在受信任部署目录内。');
  }
  return canonicalReleaseRoot;
}

function activationRecovery({ candidate, previous, backupPlist }) {
  return {
    schemaVersion:'agent.army/self-service-activation-recovery/v1',
    state:'prepared',
    preparedAt:new Date().toISOString(),
    current:releaseIdentity(candidate),
    previous:releaseIdentity(previous),
    backupPlist,
  };
}

function isActivationRecovery(value) {
  return value?.schemaVersion === 'agent.army/self-service-activation-recovery/v1'
    && ['prepared', 'verified'].includes(value.state)
    && releaseIdentity(value.current)
    && releaseIdentity(value.previous)
    && typeof value.backupPlist === 'string';
}

function releaseIdentity(value) {
  if (!value?.releaseHash || !value?.gitHead || !value?.releaseRoot) return null;
  return {
    releaseHash:value.releaseHash,
    payloadHash:value.payloadHash || null,
    gitHead:value.gitHead,
    releaseRoot:value.releaseRoot,
  };
}

function sameRelease(left, right) {
  return Boolean(left && right
    && left.releaseHash === right.releaseHash
    && left.payloadHash === right.payloadHash
    && left.gitHead === right.gitHead);
}

async function isUsableBackup(value) {
  if (!value) return false;
  try {
    const stat = await fs.lstat(value);
    return stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600;
  } catch {
    return false;
  }
}

function activeReleaseHistoryError(error, current, previous, verification) {
  const result = new Error(`新版已上线且运行身份已核对；发布历史写入失败，恢复记录仍可用于回滚：${error.message}`);
  result.releaseActive = true;
  result.current = publicRelease({ ...current, verification:{ ...verification, rollbackAvailable:true } });
  result.rollback = publicRelease(previous);
  return result;
}

async function waitUntil(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  throw new Error('等待运行状态切换超时。');
}

async function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host:'127.0.0.1', port });
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(300);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function publicRelease(value) {
  return value ? {
    releaseHash:value.releaseHash,
    payloadHash:value.payloadHash || null,
    gitHead:value.gitHead,
    verification:value.verification ? publicVerification(value.verification) : null,
  } : null;
}

function publicCandidate({ gitHead, branch, clean, canPublish, updateAvailable }) {
  return {
    gitHead,
    branch,
    clean,
    committed:/^[0-9a-f]{40}$/i.test(gitHead),
    validation:{ status:'not_checked', verifiedAt:null },
    publishable:canPublish === true,
    undeployed:updateAvailable === true,
  };
}

function publicVerification(value) {
  const checks = value?.checks && typeof value.checks === 'object' ? value.checks : {};
  return {
    verifiedAt:validIso(value?.verifiedAt),
    pid:Number.isInteger(value?.pid) && value.pid > 0 ? value.pid : null,
    checks:{
      pid:checks.pid === true,
      listener:checks.listener === true,
      cwd:checks.cwd === true,
      argv:checks.argv === true,
      releaseHash:checks.releaseHash === true,
      payloadHash:checks.payloadHash === true,
      gitHead:checks.gitHead === true,
      api:checks.api === true,
      rollbackAvailable:value?.rollbackAvailable === true,
    },
  };
}

function requiredVerificationPassed(value) {
  const checks = value?.checks || {};
  return ['pid', 'listener', 'cwd', 'argv', 'releaseHash', 'payloadHash', 'gitHead', 'api']
    .every((name) => checks[name] === true);
}

function launchdPid(printed) {
  const match = String(printed || '').match(/\bpid = (\d+)/);
  const pid = Number.parseInt(match?.[1] || '', 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function validIso(value) {
  const text = String(value || '').trim();
  return Number.isNaN(Date.parse(text)) ? null : text;
}

function shortHash(value) {
  return String(value || '').slice(0, 7);
}

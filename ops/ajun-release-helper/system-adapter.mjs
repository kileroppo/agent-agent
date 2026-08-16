import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const RELEASE_MANIFEST = 'release-manifest.json';
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
    this.label = label;
    this.appPort = Number(appPort);
    this.runCommand = runCommand;
  }

  async inspect() {
    const [branch, gitHead, dirty, current, history] = await Promise.all([
      this.git(['branch', '--show-current']),
      this.git(['rev-parse', 'HEAD']),
      this.git(['status', '--porcelain', '--untracked-files=all']),
      this.readCurrentRelease(),
      this.readHistory(),
    ]);
    const clean = dirty === '';
    const updateAvailable = gitHead !== current.gitHead;
    const branchReady = branch === 'main';
    const canPublish = clean && branchReady && updateAvailable;
    const message = !clean
      ? '正式仓库有未提交改动；这些内容不会发布，请先整理成正式版本。'
      : !branchReady
        ? '正式仓库当前不在 main，不能从页面发布。'
        : !updateAvailable
          ? '当前已经是最新版。'
          : `发现新版 ${shortHash(gitHead)}，可以发布。`;
    return {
      canPublish,
      updateAvailable,
      message,
      current:publicRelease(current),
      candidate:{ gitHead, branch, clean },
      rollback:history?.previous ? publicRelease(history.previous) : null,
    };
  }

  async publish({ inspection, onStage }) {
    const current = await this.readCurrentRelease();
    if (inspection.candidate.gitHead === current.gitHead) throw new Error('当前已经是最新版。');
    await onStage('preparing_source', '正在准备独立、干净的候选源码。');
    const sourceRoot = await this.prepareCandidateSource(inspection.candidate.gitHead);
    await onStage('verifying', '正在安装锁定依赖并运行完整验证。');
    await this.runCommand('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd:sourceRoot });
    await onStage('freezing', '验证通过，正在生成不可变 release。');
    const frozen = await this.freezeCandidate(sourceRoot, inspection.candidate.gitHead);
    const deployed = await this.deployCandidateRelease(frozen);
    await onStage('activating', '已备份旧版，正在切换 A君。');
    const backupPlist = await this.activateCandidate({ candidate:deployed, sourceRoot, previous:current });
    await onStage('verifying_live', '新版已启动，正在核对 PID、版本和 4321。');
    await this.verifyLive(deployed);
    await this.writeHistory({
      schemaVersion:'agent.army/self-service-release-history/v1',
      activatedAt:new Date().toISOString(),
      current:deployed,
      previous:current,
      backupPlist,
    });
    return { current:publicRelease(deployed), rollback:publicRelease(current) };
  }

  async rollback({ onStage }) {
    const history = await this.readHistory();
    if (!history?.previous || !history?.backupPlist) throw new Error('没有可用的上一版。');
    const current = await this.readCurrentRelease();
    await onStage('rolling_back', '正在恢复上一版启动配置。');
    const currentBackup = await this.backupMainPlist(`rollback-${Date.now()}`);
    try {
      await this.replaceMainPlist(history.backupPlist);
      await this.restartAndVerify(history.previous);
    } catch (error) {
      await this.replaceMainPlist(currentBackup);
      await this.restartAndVerify(current);
      throw new Error(`退回失败，当前版本已恢复：${error.message}`);
    }
    await this.writeHistory({
      schemaVersion:'agent.army/self-service-release-history/v1',
      rolledBackAt:new Date().toISOString(),
      current:history.previous,
      previous:null,
      backupPlist:null,
    });
    return { current:publicRelease(history.previous), rollback:null };
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
    await this.runCommand(process.execPath, [
      path.join(sourceRoot, 'apps', 'ajun-runtime', 'scripts', 'manage-immutable-runtime-release.mjs'),
      'freeze', '--repo-root', sourceRoot, '--output-parent', outputParent, '--verify',
    ], { cwd:sourceRoot });
    const candidates = [];
    for (const name of await fs.readdir(outputParent)) {
      if (!name.startsWith('ajun-runtime-release-v1-')) continue;
      const root = path.join(outputParent, name);
      const manifest = await readReleaseManifest(root);
      if (manifest.gitHead === expectedGitHead) candidates.push({ ...manifest, releaseRoot:root });
    }
    if (candidates.length !== 1) throw new Error('完整验证后没有得到唯一候选 release。');
    return candidates[0];
  }

  async deployCandidateRelease(frozen) {
    await fs.mkdir(this.deployRoot, { recursive:true, mode:0o700 });
    const target = path.join(this.deployRoot, path.basename(frozen.releaseRoot));
    try {
      const existing = await readReleaseManifest(target);
      if (existing.releaseHash !== frozen.releaseHash) throw new Error('部署目录已有不同身份的同名 release。');
      return { ...existing, releaseRoot:target };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const temporary = path.join(this.deployRoot, `.deploy-${process.pid}-${Date.now()}.tmp`);
    await fs.cp(frozen.releaseRoot, temporary, { recursive:true, errorOnExist:true, force:false, verbatimSymlinks:true });
    const copied = await readReleaseManifest(temporary);
    if (copied.releaseHash !== frozen.releaseHash || copied.payloadHash !== frozen.payloadHash) {
      throw new Error('部署副本身份与冻结 release 不一致。');
    }
    await fs.rename(temporary, target);
    return { ...copied, releaseRoot:target };
  }

  async activateCandidate({ candidate, sourceRoot, previous }) {
    const runId = `${Date.now()}-${shortHash(candidate.gitHead)}`;
    const backupPlist = await this.backupMainPlist(runId);
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
    await waitUntil(async () => {
      try {
        await this.verifyLive(expected);
        return true;
      } catch {
        return false;
      }
    }, 60_000);
  }

  async verifyLive(expected) {
    const domain = `gui/${process.getuid()}`;
    const printed = await this.runCommand('launchctl', ['print', `${domain}/${this.label}`]);
    const expectedWorkingDirectory = expected.workingDirectory || path.join(expected.releaseRoot, WORKDIR_SUFFIX);
    if (!printed.stdout.includes(`working directory = ${expectedWorkingDirectory}`)) throw new Error('launchd 工作目录不是目标 release。');
    if (!/\bpid = \d+/.test(printed.stdout)) throw new Error('launchd 没有活动 PID。');
    const response = await fetch(`http://127.0.0.1:${this.appPort}/api/overview`, { signal:AbortSignal.timeout(3_000) });
    if (!response.ok) throw new Error(`4321 返回 HTTP ${response.status}。`);
    const overview = await response.json();
    if (!Array.isArray(overview?.tasks)) throw new Error('4321 响应不符合 A君概览契约。');
    const liveManifest = await readReleaseManifest(expected.releaseRoot);
    if (liveManifest.releaseHash !== expected.releaseHash || liveManifest.gitHead !== expected.gitHead) throw new Error('线上 release manifest 身份不匹配。');
    return { ok:true };
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
    const manifest = await readReleaseManifest(releaseRoot);
    return { ...manifest, releaseRoot, sourceRoot, entrypoint, workingDirectory };
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
      else reject(new Error(`${path.basename(command)} 执行失败（${code}）。`));
    });
  });
}

async function readReleaseManifest(releaseRoot) {
  const manifest = JSON.parse(await fs.readFile(path.join(releaseRoot, RELEASE_MANIFEST), 'utf8'));
  if (manifest?.kind !== 'agent-army/ajun-immutable-runtime-release') throw new Error('当前运行目录缺少可信 release manifest。');
  if (!manifest.releaseHash || !manifest.git?.gitHead) throw new Error('当前 release manifest 身份不完整。');
  return { releaseHash:manifest.releaseHash, payloadHash:manifest.payloadHash, gitHead:manifest.git.gitHead };
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
  return value ? { releaseHash:value.releaseHash, payloadHash:value.payloadHash || null, gitHead:value.gitHead } : null;
}

function shortHash(value) {
  return String(value || '').slice(0, 7);
}

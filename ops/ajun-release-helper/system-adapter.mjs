import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
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

function publicRelease(value) {
  return value ? { releaseHash:value.releaseHash, payloadHash:value.payloadHash || null, gitHead:value.gitHead } : null;
}

function shortHash(value) {
  return String(value || '').slice(0, 7);
}

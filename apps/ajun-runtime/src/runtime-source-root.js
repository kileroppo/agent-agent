import { execFile as execFileCallback } from 'node:child_process';
import fsConstants from 'node:fs';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export class RuntimeSourceRootError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RuntimeSourceRootError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Resolve the writable Git checkout used only by the technical-repair chain.
 *
 * An ordinary development checkout keeps the historical sourceRoot=runtimeRoot
 * behaviour. An immutable runtime has no .git and therefore must bind a
 * separate source root explicitly; it never falls back to its read-only release.
 */
export async function resolveRuntimeSourceRoot({
  runtimeRoot,
  configuredSourceRoot = process.env.AGENT_ARMY_SOURCE_PROJECT_ROOT,
  dataDir,
  privateDir,
  worktreeParent,
  externalStatePaths = {},
  fsImpl = fs,
  execFileImpl = execFile,
} = {}) {
  const canonicalRuntimeRoot = await canonicalDirectory(
    runtimeRoot,
    'runtimeRoot',
    fsImpl,
  );
  const configured = String(configuredSourceRoot || '').trim();
  if (configured && !path.isAbsolute(configured)) {
    throw new RuntimeSourceRootError(
      'source_root_not_absolute',
      'AGENT_ARMY_SOURCE_PROJECT_ROOT 必须是绝对路径。',
      { configuredSourceRoot:configured },
    );
  }

  const candidate = configured || canonicalRuntimeRoot;
  const canonicalSourceRoot = await canonicalDirectory(
    candidate,
    'AGENT_ARMY_SOURCE_PROJECT_ROOT',
    fsImpl,
  );
  const sourceIdentity = await inspectWritableGitRoot(
    canonicalSourceRoot,
    fsImpl,
    execFileImpl,
  );

  const legacyMode = !configured && canonicalSourceRoot === canonicalRuntimeRoot;
  if (!legacyMode && sourceIdentity.dirty) {
    throw new RuntimeSourceRootError(
      'source_root_dirty',
      '外置 AGENT_ARMY_SOURCE_PROJECT_ROOT 必须是干净的专用 Git worktree。',
      { sourceProjectRoot:canonicalSourceRoot },
    );
  }
  if (!legacyMode) {
    const boundaries = [
      ['runtime release', canonicalRuntimeRoot],
      ['AGENT_ARMY_DATA_DIR', dataDir],
      ['AGENT_ARMY_PRIVATE_DIR', privateDir],
      ['PAPERCLIP_REPAIR_WORKTREE_PARENT', worktreeParent],
      ...Object.entries(externalStatePaths),
    ];
    for (const [label, value] of boundaries) {
      if (!value) continue;
      const canonicalBoundary = await canonicalProspectivePath(value, label, fsImpl);
      assertDisjoint(canonicalSourceRoot, canonicalBoundary, label);
    }
  }

  const verifyFields = async (fields) => {
    const current = await inspectWritableGitRoot(
      canonicalSourceRoot,
      fsImpl,
      execFileImpl,
    );
    for (const field of fields) {
      if (current[field] !== sourceIdentity[field]) {
        throw new RuntimeSourceRootError(
          'source_root_identity_changed',
          'AGENT_ARMY_SOURCE_PROJECT_ROOT 的身份、HEAD 或工作树状态已变化；必须重新启动后再执行技术修复。',
          {
            sourceProjectRoot:canonicalSourceRoot,
            field,
            expected:sourceIdentity[field],
            actual:current[field],
          },
        );
      }
    }
    return current;
  };
  const identityFields = [
      'device',
      'inode',
      'head',
      'gitCommonDir',
      'gitCommonDevice',
      'gitCommonInode',
      'gitDir',
      'gitDirDevice',
      'gitDirInode',
  ];
  const verifyIdentity = () => verifyFields(identityFields);
  const verify = () => verifyFields([
    ...identityFields,
    'dirty',
    'statusFingerprint',
  ]);

  return Object.freeze({
    sourceProjectRoot:canonicalSourceRoot,
    runtimeRoot:canonicalRuntimeRoot,
    mode:legacyMode
      ? 'legacy_runtime_git_root'
      : 'external_writable_git_root',
    sourceIdentity:Object.freeze(sourceIdentity),
    integrityLevel:legacyMode && sourceIdentity.dirty
      ? 'legacy_dirty_status_shape'
      : 'clean_git_worktree',
    verify,
    verifyIdentity,
  });
}

async function inspectWritableGitRoot(sourceRoot, fsImpl, execFileImpl) {
  const canonical = await canonicalDirectory(
    sourceRoot,
    'AGENT_ARMY_SOURCE_PROJECT_ROOT',
    fsImpl,
  );
  const sourceStat = await fsImpl.lstat(canonical);
  try {
    await fsImpl.access(
      sourceRoot,
      fsConstants.constants.R_OK
        | fsConstants.constants.W_OK
        | fsConstants.constants.X_OK,
    );
  } catch (error) {
    throw new RuntimeSourceRootError(
      'source_root_not_writable',
      'AGENT_ARMY_SOURCE_PROJECT_ROOT 必须是当前进程可读写的目录。',
      { sourceProjectRoot:sourceRoot, cause:error?.code || error?.message },
    );
  }

  const gitMarker = path.join(sourceRoot, '.git');
  let marker;
  try {
    marker = await fsImpl.lstat(gitMarker);
  } catch (error) {
    throw new RuntimeSourceRootError(
      'source_root_not_git',
      'AGENT_ARMY_SOURCE_PROJECT_ROOT 必须包含真实的 .git 元数据。',
      { sourceProjectRoot:sourceRoot, cause:error?.code || error?.message },
    );
  }
  if (marker.isSymbolicLink() || (!marker.isDirectory() && !marker.isFile())) {
    throw new RuntimeSourceRootError(
      'source_root_unsafe_git_marker',
      'AGENT_ARMY_SOURCE_PROJECT_ROOT 的 .git 不能是符号链接或特殊文件。',
      { sourceProjectRoot:sourceRoot },
    );
  }

  const runGit = async (args, code, message) => {
    try {
      return await execFileImpl('git', args, {
        cwd:sourceRoot,
        encoding:'utf8',
        timeout:5_000,
        maxBuffer:1024 * 1024,
      });
    } catch (error) {
      throw new RuntimeSourceRootError(code, message, {
        sourceProjectRoot:sourceRoot,
        cause:error?.code || error?.message,
      });
    }
  };

  const inside = await runGit(
    ['rev-parse', '--is-inside-work-tree'],
    'source_root_git_unusable',
    'AGENT_ARMY_SOURCE_PROJECT_ROOT 不是可用的 Git 工作树。',
  );
  if (String(inside.stdout || '').trim() !== 'true') {
    throw new RuntimeSourceRootError(
      'source_root_git_unusable',
      'AGENT_ARMY_SOURCE_PROJECT_ROOT 不是可用的 Git 工作树。',
      { sourceProjectRoot:sourceRoot },
    );
  }

  const topLevel = await runGit(
    ['rev-parse', '--show-toplevel'],
    'source_root_git_unusable',
    '无法确认 AGENT_ARMY_SOURCE_PROJECT_ROOT 的 Git 根。',
  );
  let canonicalTopLevel;
  try {
    canonicalTopLevel = await fsImpl.realpath(
      String(topLevel.stdout || '').trim(),
    );
  } catch (error) {
    throw new RuntimeSourceRootError(
      'source_root_git_unusable',
      'AGENT_ARMY_SOURCE_PROJECT_ROOT 的 Git 根无法解析。',
      { sourceProjectRoot:sourceRoot, cause:error?.code || error?.message },
    );
  }
  if (canonicalTopLevel !== sourceRoot) {
    throw new RuntimeSourceRootError(
      'source_root_not_git_toplevel',
      'AGENT_ARMY_SOURCE_PROJECT_ROOT 必须直接指向 Git 顶层目录。',
      { sourceProjectRoot:sourceRoot, gitTopLevel:canonicalTopLevel },
    );
  }

  const worktrees = await runGit(
    ['worktree', 'list', '--porcelain'],
    'source_root_worktree_unusable',
    'AGENT_ARMY_SOURCE_PROJECT_ROOT 无法使用 git worktree。',
  );
  const listedRoots = String(worktrees.stdout || '')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim());
  const canonicalListedRoots = [];
  for (const listedRoot of listedRoots) {
    try {
      canonicalListedRoots.push(await fsImpl.realpath(listedRoot));
    } catch {
      // Stale worktree entries do not prove that the selected source root is safe.
    }
  }
  if (!canonicalListedRoots.includes(sourceRoot)) {
    throw new RuntimeSourceRootError(
      'source_root_worktree_unusable',
      'AGENT_ARMY_SOURCE_PROJECT_ROOT 未出现在 git worktree 清单中。',
      { sourceProjectRoot:sourceRoot },
    );
  }
  const head = await runGit(
    ['rev-parse', '--verify', 'HEAD^{commit}'],
    'source_root_head_missing',
    'AGENT_ARMY_SOURCE_PROJECT_ROOT 必须有可验证的 HEAD 提交。',
  );
  const commonDir = await runGit(
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    'source_root_git_unusable',
    '无法确认 AGENT_ARMY_SOURCE_PROJECT_ROOT 的 Git 公共元数据目录。',
  );
  const gitDirResult = await runGit(
    ['rev-parse', '--path-format=absolute', '--absolute-git-dir'],
    'source_root_git_unusable',
    '无法确认 AGENT_ARMY_SOURCE_PROJECT_ROOT 的 Git 工作树元数据目录。',
  );
  let gitCommon;
  let gitDirectory;
  try {
    gitCommon = await existingDirectoryIdentity(
      fsImpl,
      String(commonDir.stdout || '').trim(),
    );
    gitDirectory = await existingDirectoryIdentity(
      fsImpl,
      String(gitDirResult.stdout || '').trim(),
    );
  } catch (error) {
    throw new RuntimeSourceRootError(
      'source_root_git_unusable',
      'AGENT_ARMY_SOURCE_PROJECT_ROOT 的 Git 公共元数据目录无法解析。',
      { sourceProjectRoot:sourceRoot, cause:error?.code || error?.message },
    );
  }
  const status = await runGit(
    ['status', '--porcelain=v1', '-z', '--untracked-files=normal'],
    'source_root_git_unusable',
    '无法读取 AGENT_ARMY_SOURCE_PROJECT_ROOT 的工作树状态。',
  );
  const statusText = String(status.stdout || '');
  return {
    device:String(sourceStat.dev),
    inode:String(sourceStat.ino),
    head:String(head.stdout || '').trim(),
    gitCommonDir:gitCommon.path,
    gitCommonDevice:gitCommon.device,
    gitCommonInode:gitCommon.inode,
    gitDir:gitDirectory.path,
    gitDirDevice:gitDirectory.device,
    gitDirInode:gitDirectory.inode,
    dirty:statusText.length > 0,
    statusFingerprint:crypto.createHash('sha256').update(statusText).digest('hex'),
  };
}

async function existingDirectoryIdentity(fsImpl, value) {
  const normalized = path.normalize(value);
  const stat = await fsImpl.lstat(normalized);
  const canonical = await fsImpl.realpath(normalized);
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonical !== normalized) {
    throw new Error('Git 元数据目录不是规范真实目录。');
  }
  return {
    path:canonical,
    device:String(stat.dev),
    inode:String(stat.ino),
  };
}

async function canonicalDirectory(value, label, fsImpl) {
  const supplied = String(value || '').trim();
  if (!supplied || !path.isAbsolute(supplied)) {
    throw new RuntimeSourceRootError(
      'directory_not_absolute',
      `${label} 必须是绝对路径。`,
      { label, value:supplied },
    );
  }
  const normalized = path.normalize(supplied);
  let stat;
  let canonical;
  try {
    stat = await fsImpl.lstat(normalized);
    canonical = await fsImpl.realpath(normalized);
  } catch (error) {
    throw new RuntimeSourceRootError(
      'directory_unavailable',
      `${label} 必须是已经存在的真实目录。`,
      { label, value:normalized, cause:error?.code || error?.message },
    );
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonical !== normalized) {
    throw new RuntimeSourceRootError(
      'directory_not_canonical',
      `${label} 必须是非符号链接的规范真实目录。`,
      { label, value:normalized, canonical },
    );
  }
  return canonical;
}

async function canonicalProspectivePath(value, label, fsImpl) {
  const supplied = String(value || '').trim();
  if (!supplied || !path.isAbsolute(supplied)) {
    throw new RuntimeSourceRootError(
      'boundary_not_absolute',
      `${label} 必须是绝对路径，才能验证源码根隔离。`,
      { label, value:supplied },
    );
  }
  let cursor = path.normalize(supplied);
  const suffix = [];
  while (true) {
    try {
      const stat = await fsImpl.lstat(cursor);
      if (stat.isSymbolicLink()) {
        throw new RuntimeSourceRootError(
          'boundary_symlink',
          `${label} 的路径祖先不能是符号链接。`,
          { label, value:supplied, symlink:cursor },
        );
      }
      const canonicalParent = await fsImpl.realpath(cursor);
      if (canonicalParent !== cursor) {
        throw new RuntimeSourceRootError(
          'boundary_symlink',
          `${label} 的路径祖先不能是符号链接。`,
          { label, value:supplied, canonical:canonicalParent },
        );
      }
      return path.join(canonicalParent, ...suffix.reverse());
    } catch (error) {
      if (error instanceof RuntimeSourceRootError) throw error;
      if (error?.code !== 'ENOENT') {
        throw new RuntimeSourceRootError(
          'boundary_unavailable',
          `${label} 无法完成路径隔离检查。`,
          { label, value:supplied, cause:error?.code || error?.message },
        );
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        throw new RuntimeSourceRootError(
          'boundary_unavailable',
          `${label} 没有可解析的真实路径祖先。`,
          { label, value:supplied },
        );
      }
      suffix.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

function assertDisjoint(sourceRoot, boundary, label) {
  if (isInsideOrSame(sourceRoot, boundary) || isInsideOrSame(boundary, sourceRoot)) {
    throw new RuntimeSourceRootError(
      'source_root_overlap',
      `AGENT_ARMY_SOURCE_PROJECT_ROOT 不能与 ${label} 重叠。`,
      { sourceProjectRoot:sourceRoot, boundary, label },
    );
  }
}

function isInsideOrSame(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

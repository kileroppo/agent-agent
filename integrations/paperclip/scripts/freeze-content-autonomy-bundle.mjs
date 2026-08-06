#!/usr/bin/env node

import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const BUNDLE_VERSION = '0.4.9';
export const BUNDLE_PREFIX = `content-autonomy-bundle-${BUNDLE_VERSION}-`;
export const DEFAULT_OUTPUT_RELATIVE = 'work/m5-content-autonomy/plugin-packages';
export const MANIFEST_FILE = 'bundle-manifest.json';

const COMPONENTS = [
  {
    relativePath: 'integrations/paperclip/plugins/content-autonomy',
    exclusions: [],
  },
  {
    relativePath: 'apps/animated-chart',
    exclusions: [
      'out/**',
      'public/m5-*/**',
      'node_modules/.cache/**',
    ],
  },
  {
    relativePath: 'apps/ajun-runtime',
    exclusions: [],
    includePaths: [
      'package.json',
      'src/m5-budget-cost-contract.js',
      'src/local-budget-ticket-authority.js',
    ],
  },
  {
    relativePath: 'designs',
    exclusions: [],
    includePaths: [
      'm2-authorization-architecture/a-jun-product-runtime-preview.png',
      'm2-authorization-architecture/architecture-preview.png',
      'agent-army-m1/desktop-preview.png',
      'feishu-mobile-army-control/architecture-preview.png',
    ],
  },
];

export async function freezeContentAutonomyBundle({
  repoRoot,
  outputParent,
  verify = false,
  runCommand = defaultRunCommand,
} = {}) {
  if (!repoRoot) {
    throw new Error('必须提供 repoRoot');
  }

  const inputRepoRoot = path.resolve(repoRoot);
  const canonicalRepoRoot = await canonicalDirectory(inputRepoRoot, '仓库根目录');
  let resolvedOutputParent;
  if (outputParent) {
    const requestedOutput = path.resolve(outputParent);
    assertInside(inputRepoRoot, requestedOutput, '输出目录');
    resolvedOutputParent = path.join(
      canonicalRepoRoot,
      path.relative(inputRepoRoot, requestedOutput),
    );
  } else {
    resolvedOutputParent = path.join(canonicalRepoRoot, DEFAULT_OUTPUT_RELATIVE);
  }
  await ensureDirectoryTree(canonicalRepoRoot, resolvedOutputParent);

  const sources = [];
  for (const component of COMPONENTS) {
    const sourceRoot = path.join(canonicalRepoRoot, component.relativePath);
    await assertDirectoryPathWithoutSymlinks(
      canonicalRepoRoot,
      sourceRoot,
      `源码目录 ${component.relativePath}`,
    );
    sources.push({ ...component, sourceRoot });
  }
  await assertPluginVersion(sources[0].sourceRoot);

  const stagingRoot = path.join(
    resolvedOutputParent,
    `.${BUNDLE_PREFIX}${process.pid}-${crypto.randomUUID()}.tmp`,
  );
  await fs.mkdir(stagingRoot, { mode: 0o700 });

  let stagingExists = true;
  try {
    for (const component of sources) {
      await copyComponent(component, stagingRoot);
    }

    const beforeVerification = await snapshotPayload(stagingRoot, {
      requireImmutableModes: false,
    });
    let verification = { requested: false, commands: [] };
    if (verify) {
      verification = await verifyBundle(stagingRoot, runCommand);
      const afterVerification = await snapshotPayload(stagingRoot, {
        requireImmutableModes: false,
      });
      if (afterVerification.payloadHash !== beforeVerification.payloadHash) {
        throw new Error('验证命令修改了待冻结内容，拒绝生成不可变包');
      }
    }

    const manifest = {
      schemaVersion: 1,
      bundleVersion: BUNDLE_VERSION,
      payloadHash: beforeVerification.payloadHash,
      sourceRoots: COMPONENTS.map(({ relativePath }) => relativePath),
      includedFiles: COMPONENTS.flatMap(({ relativePath, includePaths = [] }) =>
        includePaths.map((includedPath) => `${relativePath}/${includedPath}`)),
      exclusions: COMPONENTS.flatMap(({ relativePath, exclusions }) =>
        exclusions.map((pattern) => `${relativePath}/${pattern}`)),
      entries: beforeVerification.entries,
    };
    await fs.writeFile(
      path.join(stagingRoot, MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: 'wx', mode: 0o444 },
    );

    const finalRoot = path.join(
      resolvedOutputParent,
      `${BUNDLE_PREFIX}${beforeVerification.payloadHash}`,
    );
    const existing = await lstatOrNull(finalRoot);
    if (existing) {
      await validateFrozenBundle(finalRoot, beforeVerification.payloadHash);
      await fs.rm(stagingRoot, { recursive: true });
      stagingExists = false;
      return {
        status: 'already_frozen',
        bundleRoot: finalRoot,
        bundleVersion: BUNDLE_VERSION,
        payloadHash: beforeVerification.payloadHash,
        entryCount: beforeVerification.entries.length,
        verification,
      };
    }

    await chmodTreeReadonly(stagingRoot);
    try {
      await fs.rename(stagingRoot, finalRoot);
      stagingExists = false;
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code)) {
        throw error;
      }
      await validateFrozenBundle(finalRoot, beforeVerification.payloadHash);
      await makeTreeWritable(stagingRoot);
      await fs.rm(stagingRoot, { recursive: true });
      stagingExists = false;
      return {
        status: 'already_frozen',
        bundleRoot: finalRoot,
        bundleVersion: BUNDLE_VERSION,
        payloadHash: beforeVerification.payloadHash,
        entryCount: beforeVerification.entries.length,
        verification,
      };
    }

    await validateFrozenBundle(finalRoot, beforeVerification.payloadHash);
    return {
      status: 'frozen',
      bundleRoot: finalRoot,
      bundleVersion: BUNDLE_VERSION,
      payloadHash: beforeVerification.payloadHash,
      entryCount: beforeVerification.entries.length,
      verification,
    };
  } finally {
    if (stagingExists) {
      await makeTreeWritable(stagingRoot).catch(() => {});
      await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export async function validateFrozenBundle(bundleRoot, expectedHash) {
  const rootStat = await fs.lstat(bundleRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`冻结包不是普通目录: ${bundleRoot}`);
  }
  if ((rootStat.mode & 0o777) !== 0o555) {
    throw new Error(`冻结包根目录不是只读模式: ${bundleRoot}`);
  }

  const manifestPath = path.join(bundleRoot, MANIFEST_FILE);
  const manifestStat = await fs.lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error('冻结包清单不是普通文件');
  }
  if ((manifestStat.mode & 0o777) !== 0o444) {
    throw new Error('冻结包清单不是只读模式');
  }
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (manifest.bundleVersion !== BUNDLE_VERSION) {
    throw new Error(`冻结包版本不匹配: ${manifest.bundleVersion}`);
  }
  if (manifest.payloadHash !== expectedHash) {
    throw new Error('冻结包清单哈希与目标路径不匹配');
  }
  if (path.basename(bundleRoot) !== `${BUNDLE_PREFIX}${expectedHash}`) {
    throw new Error('冻结包路径未包含完整内容哈希');
  }

  const actual = await snapshotPayload(bundleRoot, {
    requireImmutableModes: true,
  });
  if (actual.payloadHash !== expectedHash) {
    throw new Error('已有冻结包内容哈希不匹配，拒绝覆盖');
  }
  if (JSON.stringify(actual.entries) !== JSON.stringify(manifest.entries)) {
    throw new Error('已有冻结包文件清单不匹配，拒绝覆盖');
  }
  return {
    bundleRoot,
    payloadHash: actual.payloadHash,
    entryCount: actual.entries.length,
  };
}

export async function verifyBundle(bundleRoot, runCommand = defaultRunCommand) {
  const commands = [
    {
      cwd: path.join(bundleRoot, 'integrations/paperclip/plugins/content-autonomy'),
      command: 'npm',
      args: ['test'],
    },
    {
      cwd: path.join(bundleRoot, 'integrations/paperclip/plugins/content-autonomy'),
      command: 'npm',
      args: ['run', 'check'],
    },
    {
      cwd: path.join(bundleRoot, 'apps/animated-chart'),
      command: 'npm',
      args: ['run', 'test:m5-preflight'],
    },
    {
      cwd: path.join(bundleRoot, 'apps/animated-chart'),
      command: 'npm',
      args: ['run', 'lint'],
    },
  ];
  for (const item of commands) {
    await runCommand(item.command, item.args, { cwd: item.cwd });
  }
  return {
    requested: true,
    commands: commands.map(({ cwd, command, args }) => ({
      cwd: path.relative(bundleRoot, cwd).split(path.sep).join('/'),
      command,
      args,
    })),
  };
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv);
  const result = await freezeContentAutonomyBundle({
    ...options,
    runCommand: dependencies.runCommand,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function parseArgs(argv) {
  const options = { verify: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--verify') {
      options.verify = true;
      continue;
    }
    if (value === '--repo-root' || value === '--output-parent') {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) {
        throw new Error(`${value} 缺少路径`);
      }
      options[value === '--repo-root' ? 'repoRoot' : 'outputParent'] = next;
      index += 1;
      continue;
    }
    throw new Error(`未知参数: ${value}`);
  }
  if (!options.repoRoot) {
    throw new Error('必须显式提供 --repo-root');
  }
  return options;
}

async function copyComponent(component, stagingRoot) {
  const destinationRoot = path.join(stagingRoot, component.relativePath);
  await fs.mkdir(destinationRoot, { recursive: true });
  if (component.includePaths) {
    await copyAllowlistedFiles(component, destinationRoot);
    return;
  }
  await copyDirectory(component.sourceRoot, destinationRoot, component);
}

async function copyAllowlistedFiles(component, destinationRoot) {
  for (const includedPath of [...component.includePaths].sort(bytewiseSort)) {
    const sourcePath = path.join(component.sourceRoot, includedPath);
    assertInside(component.sourceRoot, sourcePath, `allowlist源码 ${includedPath}`);
    await assertDirectoryPathWithoutSymlinks(
      component.sourceRoot,
      path.dirname(sourcePath),
      `allowlist源码父目录 ${includedPath}`,
    );
    const stat = await fs.lstat(sourcePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`allowlist源码必须是普通文件: ${component.relativePath}/${includedPath}`);
    }
    const canonicalSource = await fs.realpath(sourcePath);
    assertInside(component.sourceRoot, canonicalSource, `allowlist源码 ${includedPath}`);
    const destinationPath = path.join(destinationRoot, includedPath);
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.copyFile(sourcePath, destinationPath, fsSync.constants.COPYFILE_EXCL);
    await fs.chmod(destinationPath, stat.mode & 0o777);
  }
}

async function copyDirectory(sourceDirectory, destinationDirectory, component) {
  const names = (await fs.readdir(sourceDirectory)).sort(bytewiseSort);
  for (const name of names) {
    const sourcePath = path.join(sourceDirectory, name);
    const relativePath = path.relative(component.sourceRoot, sourcePath)
      .split(path.sep)
      .join('/');
    if (isExcluded(component.relativePath, relativePath)) {
      continue;
    }

    const destinationPath = path.join(destinationDirectory, name);
    const stat = await fs.lstat(sourcePath);
    if (stat.isDirectory()) {
      await fs.mkdir(destinationPath, { mode: stat.mode & 0o777 });
      await copyDirectory(sourcePath, destinationPath, component);
      continue;
    }
    if (stat.isFile()) {
      const canonicalSource = await fs.realpath(sourcePath);
      assertInside(component.sourceRoot, canonicalSource, `源码文件 ${relativePath}`);
      await fs.copyFile(sourcePath, destinationPath, fsSync.constants.COPYFILE_EXCL);
      await fs.chmod(destinationPath, stat.mode & 0o777);
      continue;
    }
    if (stat.isSymbolicLink()) {
      const target = await fs.readlink(sourcePath);
      await validateSymlink(component.sourceRoot, sourcePath, target, component);
      await fs.symlink(target, destinationPath);
      continue;
    }
    throw new Error(`不支持的源码条目类型: ${component.relativePath}/${relativePath}`);
  }
}

async function validateSymlink(componentRoot, linkPath, target, component) {
  if (path.isAbsolute(target)) {
    throw new Error(`拒绝绝对软链: ${linkPath} -> ${target}`);
  }
  const lexicalTarget = path.resolve(path.dirname(linkPath), target);
  assertInside(componentRoot, lexicalTarget, `软链目标 ${linkPath}`);
  const targetRelative = path.relative(componentRoot, lexicalTarget)
    .split(path.sep)
    .join('/');
  if (isExcluded(component.relativePath, targetRelative)) {
    throw new Error(`软链指向被排除内容: ${linkPath} -> ${target}`);
  }
  let canonicalTarget;
  try {
    canonicalTarget = await fs.realpath(linkPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`拒绝悬空软链: ${linkPath} -> ${target}`);
    }
    throw error;
  }
  assertInside(componentRoot, canonicalTarget, `软链真实目标 ${linkPath}`);
}

function isExcluded(componentRelativePath, relativePath) {
  if (componentRelativePath !== 'apps/animated-chart') {
    return false;
  }
  if (relativePath === 'out' || relativePath.startsWith('out/')) {
    return true;
  }
  if (
    relativePath === 'node_modules/.cache'
    || relativePath.startsWith('node_modules/.cache/')
  ) {
    return true;
  }
  const parts = relativePath.split('/');
  return parts[0] === 'public' && parts[1]?.startsWith('m5-');
}

async function snapshotPayload(root, { requireImmutableModes }) {
  const entries = [];
  await collectEntries(root, root, entries, { requireImmutableModes });
  entries.sort((left, right) => bytewiseSort(left.path, right.path));
  const hasher = crypto.createHash('sha256');
  for (const entry of entries) {
    hasher.update(`${JSON.stringify(entry)}\n`);
  }
  return {
    payloadHash: hasher.digest('hex'),
    entries,
  };
}

async function collectEntries(root, current, entries, options) {
  const names = (await fs.readdir(current)).sort(bytewiseSort);
  for (const name of names) {
    const absolute = path.join(current, name);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (relative === MANIFEST_FILE) {
      continue;
    }
    const stat = await fs.lstat(absolute);
    if (stat.isDirectory()) {
      const expectedMode = 0o555;
      assertMode(relative, stat.mode, expectedMode, options);
      entries.push({ type: 'directory', path: relative, mode: octal(expectedMode) });
      await collectEntries(root, absolute, entries, options);
      continue;
    }
    if (stat.isFile()) {
      const expectedMode = stat.mode & 0o111 ? 0o555 : 0o444;
      assertMode(relative, stat.mode, expectedMode, options);
      entries.push({
        type: 'file',
        path: relative,
        mode: octal(expectedMode),
        size: stat.size,
        sha256: await sha256File(absolute),
      });
      continue;
    }
    if (stat.isSymbolicLink()) {
      const target = await fs.readlink(absolute);
      await validateBundleSymlink(root, absolute, target);
      entries.push({ type: 'symlink', path: relative, target });
      continue;
    }
    throw new Error(`冻结内容含不支持的条目类型: ${relative}`);
  }
}

async function validateBundleSymlink(bundleRoot, linkPath, target) {
  if (path.isAbsolute(target)) {
    throw new Error(`冻结内容含绝对软链: ${linkPath}`);
  }
  const relative = path.relative(bundleRoot, linkPath).split(path.sep).join('/');
  const component = COMPONENTS.find(({ relativePath }) =>
    relative === relativePath || relative.startsWith(`${relativePath}/`));
  if (!component) {
    throw new Error(`软链不属于允许的冻结组件: ${relative}`);
  }
  const componentRoot = path.join(bundleRoot, component.relativePath);
  const lexicalTarget = path.resolve(path.dirname(linkPath), target);
  assertInside(componentRoot, lexicalTarget, `冻结软链目标 ${relative}`);
  const targetRelative = path.relative(componentRoot, lexicalTarget)
    .split(path.sep)
    .join('/');
  if (isExcluded(component.relativePath, targetRelative)) {
    throw new Error(`冻结软链指向被排除内容: ${relative}`);
  }
  let canonicalTarget;
  try {
    canonicalTarget = await fs.realpath(linkPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`冻结内容含悬空软链: ${relative}`);
    }
    throw error;
  }
  assertInside(componentRoot, canonicalTarget, `冻结软链真实目标 ${relative}`);
}

function assertMode(relative, actualMode, expectedMode, { requireImmutableModes }) {
  if (requireImmutableModes && (actualMode & 0o777) !== expectedMode) {
    throw new Error(`冻结条目不是只读模式: ${relative}`);
  }
}

async function chmodTreeReadonly(root) {
  const directories = [root];
  await walkForChmod(root, directories);
  directories.sort((left, right) => right.length - left.length);
  for (const directory of directories) {
    await fs.chmod(directory, 0o555);
  }
}

async function walkForChmod(directory, directories) {
  for (const name of await fs.readdir(directory)) {
    const absolute = path.join(directory, name);
    const stat = await fs.lstat(absolute);
    if (stat.isDirectory()) {
      directories.push(absolute);
      await walkForChmod(absolute, directories);
    } else if (stat.isFile()) {
      await fs.chmod(absolute, stat.mode & 0o111 ? 0o555 : 0o444);
    }
  }
}

async function makeTreeWritable(root) {
  const stat = await lstatOrNull(root);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    return;
  }
  await fs.chmod(root, 0o700);
  for (const name of await fs.readdir(root)) {
    const absolute = path.join(root, name);
    const child = await fs.lstat(absolute);
    if (child.isDirectory() && !child.isSymbolicLink()) {
      await makeTreeWritable(absolute);
    } else if (child.isFile()) {
      await fs.chmod(absolute, 0o600);
    }
  }
}

async function canonicalDirectory(input, label) {
  const absolute = path.resolve(input);
  const stat = await fs.lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label}必须是普通目录: ${absolute}`);
  }
  return fs.realpath(absolute);
}

async function assertDirectoryPathWithoutSymlinks(root, target, label) {
  assertInside(root, target, label);
  const relativeParts = path.relative(root, target).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of relativeParts) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${label}路径含软链或非目录: ${current}`);
    }
  }
}

async function ensureDirectoryTree(root, target) {
  assertInside(root, target, '输出目录');
  const relativeParts = path.relative(root, target).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of relativeParts) {
    current = path.join(current, part);
    const stat = await lstatOrNull(current);
    if (!stat) {
      await fs.mkdir(current, { mode: 0o755 });
      continue;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`输出路径含软链或非目录: ${current}`);
    }
  }
}

function assertInside(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return;
  }
  throw new Error(`${label}越出允许根目录: ${candidate}`);
}

async function assertPluginVersion(pluginRoot) {
  const packagePath = path.join(pluginRoot, 'package.json');
  const stat = await fs.lstat(packagePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('插件 package.json 必须是普通文件');
  }
  const packageJson = JSON.parse(await fs.readFile(packagePath, 'utf8'));
  if (packageJson.version !== BUNDLE_VERSION) {
    throw new Error(
      `只允许冻结 content-autonomy ${BUNDLE_VERSION}，当前为 ${packageJson.version}`,
    );
  }
}

async function sha256File(file) {
  const hasher = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fsSync.createReadStream(file);
    stream.on('data', (chunk) => hasher.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hasher.digest('hex');
}

function octal(mode) {
  return mode.toString(8).padStart(4, '0');
}

function bytewiseSort(left, right) {
  return Buffer.from(left).compare(Buffer.from(right));
}

async function lstatOrNull(file) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function defaultRunCommand(command, args, { cwd }) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, CI: '1' },
      stdio: 'inherit',
      shell: false,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(
        `${command} ${args.join(' ')} 失败: ${signal ? `signal ${signal}` : `exit ${code}`}`,
      ));
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}

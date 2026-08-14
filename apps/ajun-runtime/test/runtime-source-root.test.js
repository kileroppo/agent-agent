import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createRuntime } from '../src/runtime-composition-root.ts';
import {
  resolveRuntimeSourceRoot,
  RuntimeSourceRootError,
} from '../src/runtime-source-root.ts';

const execFile = promisify(execFileCallback);

async function git(cwd, ...args) {
  return execFile('git', args, { cwd, encoding:'utf8' });
}

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-source-root-')));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const source = path.join(root, 'source');
  const runtime = path.join(root, 'runtime');
  const external = path.join(root, 'external');
  await Promise.all([
    fs.mkdir(source),
    fs.mkdir(runtime),
    fs.mkdir(external),
  ]);
  await git(source, 'init');
  await fs.writeFile(path.join(source, 'tracked.js'), 'export const ok = true;\n');
  await git(source, 'add', '.');
  await git(
    source,
    '-c',
    'user.name=fixture',
    '-c',
    'user.email=fixture@example.com',
    'commit',
    '-m',
    'fixture',
  );
  return {
    root,
    source:await fs.realpath(source),
    runtime:await fs.realpath(runtime),
    data:path.join(external, 'data'),
    privateDir:path.join(external, 'private'),
    worktrees:path.join(external, 'worktrees'),
    content:path.join(external, 'content'),
  };
}

test('开发态默认复用当前 Git 根并显式标记 legacy mode', async (t) => {
  const item = await fixture(t);
  const result = await resolveRuntimeSourceRoot({
    runtimeRoot:item.source,
    dataDir:path.join(item.source, 'apps/ajun-runtime/data'),
  });
  assert.equal(result.mode, 'legacy_runtime_git_root');
  assert.equal(result.sourceProjectRoot, item.source);
  assert.match(result.sourceIdentity.head, /^[0-9a-f]{40,64}$/);
  assert.equal(typeof result.sourceIdentity.dirty, 'boolean');
  await result.verify();
});

test('外置源码根必须是干净的专用 worktree，开发态才允许显式降级为 dirty legacy', async (t) => {
  const item = await fixture(t);
  await fs.writeFile(path.join(item.source, 'tracked.js'), 'export const changed = true;\n');
  await assert.rejects(
    resolveRuntimeSourceRoot({
      runtimeRoot:item.runtime,
      configuredSourceRoot:item.source,
      dataDir:item.data,
    }),
    (error) => (
      error instanceof RuntimeSourceRootError
      && error.code === 'source_root_dirty'
    ),
  );
  const legacy = await resolveRuntimeSourceRoot({ runtimeRoot:item.source });
  assert.equal(legacy.mode, 'legacy_runtime_git_root');
  assert.equal(legacy.integrityLevel, 'legacy_dirty_status_shape');
});

test('不可变运行根未显式绑定源码根时失败关闭', async (t) => {
  const item = await fixture(t);
  await assert.rejects(
    resolveRuntimeSourceRoot({ runtimeRoot:item.runtime }),
    (error) => (
      error instanceof RuntimeSourceRootError
      && error.code === 'source_root_not_git'
    ),
  );
});

test('不可变运行根只接受隔离的绝对可写 Git 根', async (t) => {
  const item = await fixture(t);
  const result = await resolveRuntimeSourceRoot({
    runtimeRoot:item.runtime,
    configuredSourceRoot:item.source,
    dataDir:item.data,
    privateDir:item.privateDir,
    worktreeParent:item.worktrees,
    externalStatePaths:{ AGENT_ARMY_CONTENT_WORKSPACE_DIR:item.content },
  });
  assert.equal(result.mode, 'external_writable_git_root');
  assert.equal(result.sourceProjectRoot, item.source);

  await assert.rejects(
    resolveRuntimeSourceRoot({
      runtimeRoot:item.runtime,
      configuredSourceRoot:'relative/source',
    }),
    /必须是绝对路径/,
  );
  await assert.rejects(
    resolveRuntimeSourceRoot({
      runtimeRoot:item.runtime,
      configuredSourceRoot:item.source,
      dataDir:path.join(item.source, 'data'),
    }),
    /不能与 AGENT_ARMY_DATA_DIR 重叠/,
  );
  await assert.rejects(
    resolveRuntimeSourceRoot({
      runtimeRoot:item.runtime,
      configuredSourceRoot:item.source,
      externalStatePaths:{ AUTO_WORK_ROOT:path.dirname(item.source) },
    }),
    /不能与 AUTO_WORK_ROOT 重叠/,
  );
});

test('源码根与路径祖先 symlink 都不会被当成安全配置', async (t) => {
  const item = await fixture(t);
  const sourceLink = path.join(item.root, 'source-link');
  await fs.symlink(item.source, sourceLink);
  await assert.rejects(
    resolveRuntimeSourceRoot({
      runtimeRoot:item.runtime,
      configuredSourceRoot:sourceLink,
    }),
    /非符号链接的规范真实目录/,
  );

  const externalLink = path.join(item.root, 'external-link');
  await fs.symlink(path.dirname(item.data), externalLink);
  await assert.rejects(
    resolveRuntimeSourceRoot({
      runtimeRoot:item.runtime,
      configuredSourceRoot:item.source,
      dataDir:path.join(externalLink, 'data'),
    }),
    /路径祖先不能是符号链接/,
  );
});

test('linked worktree 的 .git 文件可用，但 HEAD 或源码根身份变化后复验失败', async (t) => {
  const item = await fixture(t);
  const linked = path.join(item.root, 'linked-source');
  await git(item.source, 'worktree', 'add', '--detach', linked, 'HEAD');
  const canonicalLinked = await fs.realpath(linked);
  const result = await resolveRuntimeSourceRoot({
    runtimeRoot:item.runtime,
    configuredSourceRoot:canonicalLinked,
    dataDir:item.data,
  });
  assert.equal(result.mode, 'external_writable_git_root');
  assert.equal((await fs.lstat(path.join(canonicalLinked, '.git'))).isFile(), true);

  await fs.writeFile(path.join(canonicalLinked, 'next.js'), 'export const next = true;\n');
  await git(canonicalLinked, 'add', 'next.js');
  await git(
    canonicalLinked,
    '-c',
    'user.name=fixture',
    '-c',
    'user.email=fixture@example.com',
    'commit',
    '-m',
    'next',
  );
  await assert.rejects(result.verify(), /身份、HEAD 或工作树状态已变化/);
});

test('真实 Composition Root 在源码 Interface 失败时不会写入运行状态', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-source-order-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const dataDir = path.join(root, 'data');

  await assert.rejects(
    createRuntime({
      environment:{
        ...process.env,
        AGENT_ARMY_SOURCE_PROJECT_ROOT:'relative/source',
        AGENT_ARMY_DATA_DIR:dataDir,
        AGENT_ARMY_PRIVATE_DIR:path.join(root, 'private'),
        PAPERCLIP_REPAIR_WORKTREE_PARENT:path.join(root, 'worktrees'),
        AGENT_ARMY_CONTENT_WORKSPACE_DIR:path.join(root, 'content'),
        AGENT_ARMY_HERMES_PROFILE_ROOT:path.join(root, 'hermes'),
        AUTO_WORK_ROOT:path.join(root, 'auto-work'),
        XIAOD_ARTIFACT_ROOT:path.join(root, 'xiaod'),
      },
      logger:{ log:() => undefined, warn:() => undefined },
    }),
    /必须是绝对路径/,
  );
  await assert.rejects(fs.access(path.join(dataDir, 'm5-budget-ticket-ed25519.pem')), {
    code:'ENOENT',
  });
});

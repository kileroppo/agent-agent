#!/usr/bin/env node

import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import { builtinModules } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveRuntimeSourceRoot } from '../src/runtime-source-root.js';

export const AJUN_RELEASE_SCHEMA_VERSION = 1;
export const AJUN_RELEASE_PREFIX = 'ajun-runtime-release-v1-';
export const AJUN_RELEASE_MANIFEST = 'release-manifest.json';
export const DEFAULT_RELEASE_PARENT = 'apps/ajun-runtime/data/releases';

const ENTRYPOINT = 'apps/ajun-runtime/src/server.js';
const EXTERNAL_STATE = [
  'AGENT_ARMY_DATA_DIR',
  'AGENT_ARMY_CONTENT_WORKSPACE_DIR',
  'AGENT_ARMY_HERMES_PROFILE_ROOT',
  'AGENT_ARMY_PRIVATE_DIR',
  'AJUN_HERMES_HOME',
  'AUTO_WORK_ROOT',
  'XIAOD_ARTIFACT_ROOT',
  'PAPERCLIP_REPAIR_WORKTREE_PARENT',
  'AGENT_ARMY_SOURCE_PROJECT_ROOT',
];
const REQUIRED_PASSTHROUGH_ENVIRONMENT = [
  'PAPERCLIP_URL',
  'XIAOD_RUNTIME_URL',
  'M5_ACTIVE_PIPELINE_ID',
  'M5_ACTIVE_PIPELINE_KEY',
  'AJUN_HERMES_NATIVE_EMPLOYEE_IDS',
  'AJUN_HERMES_NATIVE_FEISHU',
  'AGENT_ARMY_EMPLOYEE_FEISHU_OWNER',
  'AGENT_ARMY_DEPLOYMENT_MODE',
  'AJUN_TASK_DETAIL_BASE_URL',
  'AJUN_HERMES_COMMAND',
  'AJUN_CODEX_COMMAND',
  'AGENT_ARMY_PYTHON',
  'WECHAT_VAULT_SKILL_DIR',
  'WECHAT_VAULT_PYTHON',
  'WECHAT_VAULT_REPORTS_DIR',
];
const SOURCE_EXCLUSIONS = [
  'apps/ajun-runtime/data/**',
  'apps/ajun-runtime/test/**',
  'apps/ajun-runtime/scripts/**',
  '**/.env',
  '**/.env.*',
  '**/*credential*.json',
  '**/*secrets*.json',
  '**/*.pem',
  '**/*.key',
  '**/*.log',
  '**/node_modules/**/.cache/**',
];
const LEGACY_V1_SOURCE_EXCLUSIONS = [
  'apps/ajun-runtime/data/**',
  'apps/ajun-runtime/test/**',
  'apps/ajun-runtime/scripts/**',
  '**/.env',
  '**/.env.*',
  '**/*credential*.json',
  '**/*secrets*.json',
  '**/*.pem',
  '**/*.key',
  '**/node_modules/**/.cache/**',
  '**/node_modules/**/*.log',
];
const COMPONENT_RULES = [
  {
    root:'apps/ajun-runtime',
    files:['package.json', 'package-lock.json'],
    directories:['src', 'public', 'node_modules'],
  },
  {
    root:'agents',
    oneLevelFiles:[{ suffix:'/manifest.json', namePattern:/^[a-z][a-z0-9-]{0,63}$/ }],
  },
  {
    root:'integrations/hermes/profiles',
  },
  {
    root:'integrations/paperclip/m5-content-pipeline',
    files:['package.json', 'package-lock.json'],
    directories:['src', 'config', 'node_modules'],
  },
  {
    root:'integrations/paperclip/plugins/content-autonomy',
    files:['package.json', 'package-lock.json'],
    directories:['src', 'node_modules'],
  },
  {
    root:'integrations/publishing/m5-publisher-gateway',
    files:['package.json'],
    directories:['src'],
  },
  {
    root:'integrations/access',
    files:['package.json'],
    topLevelFilePattern:/^[a-z0-9-]+\.js$/,
  },
];
const VERIFY_COMMANDS = [
  {
    cwd:'apps/ajun-runtime',
    command:'npm',
    args:['test'],
  },
  {
    cwd:'integrations/paperclip/m5-content-pipeline',
    command:'npm',
    args:['test'],
  },
  {
    cwd:'integrations/paperclip/plugins/content-autonomy',
    command:'npm',
    args:['run', 'check'],
  },
  {
    cwd:'integrations/paperclip/plugins/content-autonomy',
    command:'npm',
    args:['test'],
  },
  {
    cwd:'integrations/publishing/m5-publisher-gateway',
    command:'npm',
    args:['run', 'check'],
  },
];
const LEGACY_V1_VERIFY_COMMANDS = [
  {
    cwd:'apps/ajun-runtime',
    command:'node',
    args:[
      '--test',
      'test/production-control-plane-boundary.test.js',
      'test/m5-server-publisher-composition.test.js',
    ],
  },
  {
    cwd:'integrations/paperclip/m5-content-pipeline',
    command:'npm',
    args:['test'],
  },
  {
    cwd:'integrations/paperclip/plugins/content-autonomy',
    command:'npm',
    args:['run', 'check'],
  },
  {
    cwd:'integrations/publishing/m5-publisher-gateway',
    command:'npm',
    args:['run', 'check'],
  },
];

export async function freezeAjunRuntimeRelease({
  repoRoot,
  outputParent,
  verify = false,
  runCommand = defaultRunCommand,
  smokeRunner = defaultFrozenStartupSmoke,
} = {}) {
  if (!repoRoot) throw new Error('必须提供 repoRoot');
  const inputRepoRoot = path.resolve(repoRoot);
  const canonicalRepoRoot = await canonicalPlainDirectory(repoRoot, '仓库根目录');
  let requestedOutput;
  if (outputParent) {
    const lexicalOutput = path.resolve(outputParent);
    assertInside(inputRepoRoot, lexicalOutput, '输出目录');
    requestedOutput = path.join(
      canonicalRepoRoot,
      path.relative(inputRepoRoot, lexicalOutput),
    );
  } else {
    requestedOutput = path.join(canonicalRepoRoot, DEFAULT_RELEASE_PARENT);
  }
  const gitBeforeFreeze = await readGitIdentity(canonicalRepoRoot, {
    excludedPaths:[requestedOutput],
  });
  await ensureDirectoryTree(canonicalRepoRoot, requestedOutput, '输出路径');
  const outputParentIdentity = await directoryIdentity(requestedOutput, '输出目录');
  const includedPaths = await resolveAllowlist(canonicalRepoRoot);
  assertOutputDoesNotOverlapAllowlist(canonicalRepoRoot, requestedOutput, includedPaths);

  const stagingRoot = path.join(
    requestedOutput,
    `.ajun-release-${process.pid}-${crypto.randomUUID()}.tmp`,
  );
  await fs.mkdir(stagingRoot, { mode:0o700 });
  const stagingIdentity = await directoryIdentity(stagingRoot, 'release暂存目录');
  let stagingExists = true;
  try {
    for (const relative of includedPaths) {
      await copyAllowlistedEntry(canonicalRepoRoot, stagingRoot, relative);
    }
    await assertRuntimeStaticClosure(stagingRoot);
    await assertGovernanceRosterSmoke(stagingRoot);

    const beforeVerification = await snapshotPayload(stagingRoot, { requireReadonly:false });
    const gitAtSnapshot = await readGitIdentity(canonicalRepoRoot, {
      excludedPaths:[requestedOutput],
    });
    assertGitIdentityUnchanged(gitBeforeFreeze, gitAtSnapshot, '冻结快照期间');
    const git = publicGitIdentity(gitAtSnapshot);
    let verification = { requested:false, commands:[] };
    if (verify) {
      if (!git.gitHead) {
        throw new Error('verify需要可验证的Git HEAD来建立隔离源码worktree');
      }
      const startupSmoke = await smokeRunner({
        releaseRoot:stagingRoot,
        repoRoot:canonicalRepoRoot,
        gitHead:git.gitHead,
        nodePath:process.execPath,
      });
      assertStartupSmokeEvidence(startupSmoke, git.gitHead);
      for (const item of VERIFY_COMMANDS) {
        await runCommand(item.command, item.args, {
          cwd:path.join(canonicalRepoRoot, item.cwd),
        });
      }
      const sourceRecheckRoot = path.join(
        requestedOutput,
        `.ajun-source-recheck-${process.pid}-${crypto.randomUUID()}.tmp`,
      );
      await fs.mkdir(sourceRecheckRoot, { mode:0o700 });
      const sourceRecheckIdentity = await directoryIdentity(
        sourceRecheckRoot,
        'release源码复核目录',
      );
      try {
        for (const relative of includedPaths) {
          await copyAllowlistedEntry(canonicalRepoRoot, sourceRecheckRoot, relative);
        }
        const sourceRecheck = await snapshotPayload(sourceRecheckRoot, {
          requireReadonly:false,
        });
        if (
          sourceRecheck.payloadHash !== beforeVerification.payloadHash
          || JSON.stringify(sourceRecheck.entries)
            !== JSON.stringify(beforeVerification.entries)
        ) {
          throw new Error('源码测试期间allowlist快照发生变化，拒绝冻结');
        }
      } finally {
        await removePrivateTree(sourceRecheckRoot, sourceRecheckIdentity);
      }
      await assertRuntimeStaticClosure(stagingRoot);
      await assertGovernanceRosterSmoke(stagingRoot);
      const afterVerification = await snapshotPayload(stagingRoot, { requireReadonly:false });
      if (
        afterVerification.payloadHash !== beforeVerification.payloadHash
        || JSON.stringify(afterVerification.entries) !== JSON.stringify(beforeVerification.entries)
      ) {
        throw new Error('验证期间release内容发生变化，拒绝冻结');
      }
      const gitAfterVerification = await readGitIdentity(canonicalRepoRoot, {
        excludedPaths:[requestedOutput],
      });
      assertGitIdentityUnchanged(gitAtSnapshot, gitAfterVerification, '源码验证期间');
      verification = {
        requested:true,
        commands:VERIFY_COMMANDS.map((item) => ({
          ...item,
          evidenceLayer:'source_test',
        })),
        startupSmoke,
        frozenStaticClosure:true,
        payloadUnchanged:true,
        sourceSnapshotBound:true,
      };
    }

    const snapshot = beforeVerification;
    const manifestWithoutReleaseHash = {
      schemaVersion:AJUN_RELEASE_SCHEMA_VERSION,
      kind:'agent-army/ajun-immutable-runtime-release',
      payloadHash:snapshot.payloadHash,
      workingTreeSnapshot:snapshot.payloadHash,
      git,
      runtimeAbi:{
        node:process.version,
        modules:process.versions.modules,
        platform:process.platform,
        arch:process.arch,
      },
      entrypoint:ENTRYPOINT,
      sourceAllowlist:includedPaths,
      sourceExclusions:SOURCE_EXCLUSIONS,
      externalState:EXTERNAL_STATE,
      verification,
      entries:snapshot.entries,
    };
    const releaseHash = hashCanonical(manifestWithoutReleaseHash);
    const manifest = { ...manifestWithoutReleaseHash, releaseHash };
    await fs.writeFile(
      path.join(stagingRoot, AJUN_RELEASE_MANIFEST),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag:'wx', mode:0o444 },
    );

    const finalRoot = path.join(requestedOutput, `${AJUN_RELEASE_PREFIX}${releaseHash}`);
    await assertDirectoryIdentity(outputParentIdentity);
    const existing = await lstatOrNull(finalRoot);
    if (existing) {
      const validated = await validateAjunRuntimeRelease(finalRoot, releaseHash);
      await removePrivateTree(stagingRoot);
      stagingExists = false;
      return releaseResult(
        'already_frozen',
        finalRoot,
        snapshot,
        validated.manifest.verification,
        releaseHash,
      );
    }

    await chmodTreeReadonly(stagingRoot);
    await assertDirectoryIdentity(outputParentIdentity);
    try {
      await fs.rename(stagingRoot, finalRoot);
      stagingExists = false;
    } catch (error) {
      const collisionCodes = ['EEXIST', 'ENOTEMPTY', 'EACCES', 'EPERM'];
      if (!collisionCodes.includes(error?.code) || !(await lstatOrNull(finalRoot))) {
        throw error;
      }
      const validated = await validateAjunRuntimeRelease(finalRoot, releaseHash);
      await removePrivateTree(stagingRoot);
      stagingExists = false;
      return releaseResult(
        'already_frozen',
        finalRoot,
        snapshot,
        validated.manifest.verification,
        releaseHash,
      );
    }
    await validateAjunRuntimeRelease(finalRoot, releaseHash);
    return releaseResult('frozen', finalRoot, snapshot, verification, releaseHash);
  } finally {
    if (stagingExists) {
      try {
        await assertDirectoryIdentity(outputParentIdentity);
        await assertDirectoryIdentity(stagingIdentity);
        await removePrivateTree(stagingRoot, stagingIdentity);
      } catch (error) {
        throw new Error(
          `release暂存清理失败，需人工核验恢复: ${stagingRoot} (${error.message})`,
          { cause:error },
        );
      }
    }
  }
}

export async function validateAjunRuntimeRelease(releaseRoot, expectedHash) {
  const canonicalRoot = await canonicalPlainDirectory(releaseRoot, 'release根目录');
  const rootStat = await fs.lstat(canonicalRoot);
  if ((rootStat.mode & 0o777) !== 0o555) throw new Error('release根目录不是只读模式');
  const manifestPath = path.join(canonicalRoot, AJUN_RELEASE_MANIFEST);
  const manifestStat = await fs.lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error('release清单不是普通文件');
  }
  if ((manifestStat.mode & 0o777) !== 0o444) throw new Error('release清单不是只读模式');
  const manifest = JSON.parse(await readOrdinaryFile(manifestPath, canonicalRoot, 'release清单'));
  if (
    manifest.schemaVersion !== AJUN_RELEASE_SCHEMA_VERSION
    || manifest.kind !== 'agent-army/ajun-immutable-runtime-release'
  ) {
    throw new Error('release清单版本或类型不匹配');
  }
  assertExactManifest(manifest);
  const { releaseHash, ...manifestWithoutReleaseHash } = manifest;
  if (hashCanonical(manifestWithoutReleaseHash) !== releaseHash) {
    throw new Error('release元数据未绑定内容哈希');
  }
  if (releaseHash !== expectedHash) throw new Error('release清单哈希不匹配');
  if (path.basename(canonicalRoot) !== `${AJUN_RELEASE_PREFIX}${expectedHash}`) {
    throw new Error('release目录名未绑定完整内容哈希');
  }
  const snapshot = await snapshotPayload(canonicalRoot, { requireReadonly:true });
  if (snapshot.payloadHash !== manifest.payloadHash) throw new Error('release内容哈希不匹配');
  if (JSON.stringify(snapshot.entries) !== JSON.stringify(manifest.entries)) {
    throw new Error('release文件清单不匹配');
  }
  await assertRuntimeStaticClosure(canonicalRoot);
  await assertGovernanceRosterSmoke(canonicalRoot);
  return {
    releaseRoot:canonicalRoot,
    releaseHash:expectedHash,
    payloadHash:manifest.payloadHash,
    entryCount:snapshot.entries.length,
    manifest,
  };
}

export async function buildLaunchdCutoverPlan({
  oldReleaseRoot,
  newReleaseRoot,
  sourceProjectRoot,
  rollbackSourceProjectRoot,
  dataDir,
  contentWorkspaceDir,
  hermesProfileRoot,
  privateDir,
  autoWorkRoot,
  xiaodArtifactRoot,
  paperclipRepairWorktreeParent,
  nodePath,
  label = 'ai.agent-army.ajun-runtime',
} = {}) {
  const oldRelease = await validateReleaseFromOwnManifest(oldReleaseRoot);
  const newRelease = await validateReleaseFromOwnManifest(newReleaseRoot);
  if (oldRelease.releaseHash === newRelease.releaseHash) {
    throw new Error('old/new release内容相同，无需切换');
  }
  const external = {
    dataDir:await canonicalOrProspectiveDirectory(dataDir, 'AGENT_ARMY_DATA_DIR'),
    contentWorkspaceDir:await canonicalOrProspectiveDirectory(
      contentWorkspaceDir,
      'AGENT_ARMY_CONTENT_WORKSPACE_DIR',
    ),
    hermesProfileRoot:await canonicalOrProspectiveDirectory(
      hermesProfileRoot,
      'AGENT_ARMY_HERMES_PROFILE_ROOT',
    ),
    privateDir:await canonicalOrProspectiveDirectory(privateDir, 'AGENT_ARMY_PRIVATE_DIR'),
    autoWorkRoot:await canonicalOrProspectiveDirectory(autoWorkRoot, 'AUTO_WORK_ROOT'),
    xiaodArtifactRoot:await canonicalOrProspectiveDirectory(
      xiaodArtifactRoot,
      'XIAOD_ARTIFACT_ROOT',
    ),
    paperclipRepairWorktreeParent:await canonicalOrProspectiveDirectory(
      paperclipRepairWorktreeParent,
      'PAPERCLIP_REPAIR_WORKTREE_PARENT',
    ),
  };
  for (const [name, value] of Object.entries(external)) {
    assertOutsideRelease(value, oldRelease.releaseRoot, name);
    assertOutsideRelease(value, newRelease.releaseRoot, name);
  }
  assertNonOverlappingDirectories(external);
  const sourceBinding = await validateRepairSourceBinding({
    release:newRelease,
    sourceProjectRoot,
    external,
    label:'cutover',
  });
  assertOutsideRelease(sourceBinding.sourceProjectRoot, oldRelease.releaseRoot, 'sourceProjectRoot');
  assertOutsideRelease(sourceBinding.sourceProjectRoot, newRelease.releaseRoot, 'sourceProjectRoot');
  assertNonOverlappingDirectories({
    ...external,
    sourceProjectRoot:sourceBinding.sourceProjectRoot,
  });
  let rollbackSourceBinding = null;
  if (rollbackSourceProjectRoot) {
    rollbackSourceBinding = await validateRepairSourceBinding({
      release:oldRelease,
      sourceProjectRoot:rollbackSourceProjectRoot,
      external,
      label:'rollback',
    });
    assertOutsideRelease(
      rollbackSourceBinding.sourceProjectRoot,
      oldRelease.releaseRoot,
      'rollbackSourceProjectRoot',
    );
    assertOutsideRelease(
      rollbackSourceBinding.sourceProjectRoot,
      newRelease.releaseRoot,
      'rollbackSourceProjectRoot',
    );
    assertNonOverlappingDirectories({
      ...external,
      sourceProjectRoot:sourceBinding.sourceProjectRoot,
      rollbackSourceProjectRoot:rollbackSourceBinding.sourceProjectRoot,
    });
  }
  const canonicalNode = path.resolve(String(nodePath || ''));
  if (!path.isAbsolute(String(nodePath || '')) || canonicalNode === path.parse(canonicalNode).root) {
    throw new Error('nodePath必须是明确的绝对文件路径');
  }
  const nodeStat = await fs.lstat(canonicalNode).catch(() => null);
  if (
    !nodeStat
    || !nodeStat.isFile()
    || nodeStat.isSymbolicLink()
    || (nodeStat.mode & 0o111) === 0
  ) {
    throw new Error('nodePath必须是存在的普通可执行文件');
  }
  const nodeAbi = await readNodeAbi(canonicalNode);
  for (const release of [oldRelease, newRelease]) {
    if (stableCanonical(release.manifest.runtimeAbi) !== stableCanonical(nodeAbi)) {
      throw new Error(`nodePath ABI与release不兼容: ${release.releaseHash}`);
    }
  }
  const cutoverConfirmation = `I_ACCEPT_AJUN_RUNTIME_CUTOVER_${newRelease.releaseHash.slice(0, 12).toUpperCase()}`;
  const rollbackConfirmation = `I_ACCEPT_AJUN_RUNTIME_ROLLBACK_${oldRelease.releaseHash.slice(0, 12).toUpperCase()}`;
  const sharedEnvironment = {
    PORT:'4321',
    AJUN_HOST:'127.0.0.1',
    AGENT_ARMY_DATA_DIR:external.dataDir,
    AGENT_ARMY_CONTENT_WORKSPACE_DIR:external.contentWorkspaceDir,
    AGENT_ARMY_HERMES_PROFILE_ROOT:external.hermesProfileRoot,
    AGENT_ARMY_PRIVATE_DIR:external.privateDir,
    AJUN_HERMES_HOME:path.join(external.hermesProfileRoot, 'ajun'),
    AUTO_WORK_ROOT:external.autoWorkRoot,
    XIAOD_ARTIFACT_ROOT:external.xiaodArtifactRoot,
    PAPERCLIP_REPAIR_WORKTREE_PARENT:external.paperclipRepairWorktreeParent,
  };
  const cutoverEnvironment = {
    ...sharedEnvironment,
    AGENT_ARMY_SOURCE_PROJECT_ROOT:sourceBinding.sourceProjectRoot,
  };
  const rollbackEnvironment = rollbackSourceBinding
    ? {
        ...sharedEnvironment,
        AGENT_ARMY_SOURCE_PROJECT_ROOT:rollbackSourceBinding.sourceProjectRoot,
      }
    : null;
  return {
    schemaVersion:1,
    kind:'agent-army/ajun-launchd-cutover-plan',
    mode:'plan_only',
    executesChanges:false,
    launchd:{
      label,
      plistMutationAllowed:false,
      loadOrUnloadPerformed:false,
      instruction:'此对象只描述人工审核后的切换；本工具没有修改或加载plist的能力。',
    },
    cutover:{
      status:rollbackSourceBinding ? 'ready' : 'blocked',
      launchable:Boolean(rollbackSourceBinding),
      blockedReason:rollbackSourceBinding
        ? null
        : '未绑定独立匹配的rollback源码根，无法保证失败后的安全恢复。',
      requiredConfirmation:cutoverConfirmation,
      oldRelease:releaseReference(oldRelease),
      newRelease:releaseReference(newRelease),
      programArguments:rollbackSourceBinding
        ? [
            canonicalNode,
            path.join(newRelease.releaseRoot, ENTRYPOINT),
          ]
        : null,
      workingDirectory:rollbackSourceBinding
        ? path.join(newRelease.releaseRoot, 'apps/ajun-runtime')
        : null,
      environment:rollbackSourceBinding ? cutoverEnvironment : null,
      nodeAbi,
      requiredPassthroughEnvironment:REQUIRED_PASSTHROUGH_ENVIRONMENT,
      requiredLoopbackEnvironment:['PAPERCLIP_URL', 'XIAOD_RUNTIME_URL'],
      standardOutPath:path.join(external.dataDir, 'ajun-runtime.launchd.log'),
      standardErrorPath:path.join(external.dataDir, 'ajun-runtime.launchd.error.log'),
      checks:[
        '停止前核对当前PID、端口4321、cwd和health',
        '确认cutover与rollback均为ready且launchable',
        '仅在确认词匹配后人工修改受控launchd副本',
        '启动后核对新PID、entrypoint、health和Paperclip心跳',
        '任一检查失败立即按rollback目标恢复',
      ],
      technicalRepair:{
        status:'enabled',
        sourceProjectRoot:sourceBinding.sourceProjectRoot,
        sourceGitHead:sourceBinding.sourceIdentity.head,
        releaseGitHead:newRelease.manifest.git.gitHead,
        provenanceMatched:true,
        sourceWorktreeState:'clean',
      },
      knownCapabilityRestrictions:[],
    },
    rollback:{
      status:rollbackSourceBinding ? 'ready' : 'blocked',
      launchable:Boolean(rollbackSourceBinding),
      requiredConfirmation:rollbackConfirmation,
      targetRelease:releaseReference(oldRelease),
      programArguments:rollbackSourceBinding
        ? [
            canonicalNode,
            path.join(oldRelease.releaseRoot, ENTRYPOINT),
          ]
        : null,
      workingDirectory:rollbackSourceBinding
        ? path.join(oldRelease.releaseRoot, 'apps/ajun-runtime')
        : null,
      environment:rollbackEnvironment,
      requiredPassthroughEnvironment:REQUIRED_PASSTHROUGH_ENVIRONMENT,
      requiredLoopbackEnvironment:['PAPERCLIP_URL', 'XIAOD_RUNTIME_URL'],
      preservesExternalState:true,
      technicalRepair:rollbackSourceBinding
        ? {
            status:'enabled',
            sourceProjectRoot:rollbackSourceBinding.sourceProjectRoot,
            sourceGitHead:rollbackSourceBinding.sourceIdentity.head,
            releaseGitHead:oldRelease.manifest.git.gitHead,
            provenanceMatched:true,
            sourceWorktreeState:'clean',
          }
        : {
            status:'disabled',
            enforcement:'rollback启动计划不签发programArguments或environment',
            reason:'未提供与旧release来源精确匹配的独立干净Git worktree；禁止复用新版本源码根冒充回滚源码。',
          },
      knownCapabilityRestrictions:[
        ...(rollbackSourceBinding
          ? []
          : ['rollback在绑定独立匹配源码根前不可启动，technical-repair保持disabled']),
      ],
      instruction:rollbackSourceBinding
        ? '回滚只恢复代码release；data、内容工作区、Hermes Profile和日志保持外置且不删除。'
        : '先准备与旧release gitHead匹配的独立干净Git worktree，再重新生成回滚计划；当前对象不能启动旧release。',
    },
  };
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const [mode = 'help', ...rest] = argv;
  if (mode === 'freeze') {
    const options = parseNamedArgs(rest, ['repo-root', 'output-parent'], ['verify']);
    const result = await freezeAjunRuntimeRelease({
      repoRoot:options['repo-root'],
      outputParent:options['output-parent'],
      verify:options.verify,
      runCommand:dependencies.runCommand,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  if (mode === 'plan') {
    const options = parseNamedArgs(rest, [
      'old-release',
      'new-release',
      'source-project-root',
      'rollback-source-project-root',
      'data-dir',
      'content-workspace-dir',
      'hermes-profile-root',
      'private-dir',
      'auto-work-root',
      'xiaod-artifact-root',
      'paperclip-repair-worktree-parent',
      'node-path',
    ]);
    const plan = await buildLaunchdCutoverPlan({
      oldReleaseRoot:options['old-release'],
      newReleaseRoot:options['new-release'],
      sourceProjectRoot:options['source-project-root'],
      rollbackSourceProjectRoot:options['rollback-source-project-root'],
      dataDir:options['data-dir'],
      contentWorkspaceDir:options['content-workspace-dir'],
      hermesProfileRoot:options['hermes-profile-root'],
      privateDir:options['private-dir'],
      autoWorkRoot:options['auto-work-root'],
      xiaodArtifactRoot:options['xiaod-artifact-root'],
      paperclipRepairWorktreeParent:options['paperclip-repair-worktree-parent'],
      nodePath:options['node-path'],
    });
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return plan;
  }
  process.stdout.write([
    '仅提供不可变release冻结与launchd计划，不执行激活、重启或plist修改。',
    'freeze --repo-root <path> [--output-parent <path>] [--verify]',
    'plan --old-release <path> --new-release <path> --source-project-root <path>',
    '  [--rollback-source-project-root <path>] --data-dir <path>',
    '  --content-workspace-dir <path> --hermes-profile-root <path> --node-path <path>',
    '  --private-dir <path>',
    '  --auto-work-root <path> --xiaod-artifact-root <path>',
    '  --paperclip-repair-worktree-parent <path>',
  ].join('\n') + '\n');
  return { mode:'help' };
}

async function resolveAllowlist(repoRoot) {
  const included = [];
  for (const rule of COMPONENT_RULES) {
    const componentRoot = path.join(repoRoot, rule.root);
    await assertPlainDirectoryPath(repoRoot, componentRoot, `组件 ${rule.root}`);
    for (const file of rule.files || []) {
      const relative = `${rule.root}/${file}`;
      await assertOrdinarySourceFile(repoRoot, relative);
      included.push(relative);
    }
    for (const directory of rule.directories || []) {
      const relative = `${rule.root}/${directory}`;
      await assertPlainDirectoryPath(repoRoot, path.join(repoRoot, relative), `目录 ${relative}`);
      included.push(`${relative}/**`);
    }
    if (rule.topLevelFilePattern) {
      const names = (await fs.readdir(componentRoot)).sort(bytewiseSort);
      for (const name of names) {
        if (!rule.topLevelFilePattern.test(name)) continue;
        const relative = `${rule.root}/${name}`;
        await assertOrdinarySourceFile(repoRoot, relative);
        included.push(relative);
      }
    }
    for (const selector of rule.oneLevelFiles || []) {
      const names = (await fs.readdir(componentRoot)).sort(bytewiseSort);
      for (const name of names) {
        if (!selector.namePattern.test(name)) continue;
        const relative = `${rule.root}/${name}${selector.suffix}`;
        const stat = await lstatOrNull(path.join(repoRoot, relative));
        if (!stat) continue;
        await assertOrdinarySourceFile(repoRoot, relative);
        included.push(relative);
        if (relative.startsWith('agents/') && relative.endsWith('/manifest.json')) {
          const manifest = JSON.parse(
            (await readOrdinaryFile(
              path.join(repoRoot, relative),
              repoRoot,
              `岗位Manifest ${relative}`,
            )).toString('utf8'),
          );
          const agentId = relative.split('/')[1];
          const promptRef = String(manifest.promptRef || '').trim();
          if (promptRef) {
            const expectedPrefix = `agents/${agentId}/`;
            if (
              !promptRef.startsWith(expectedPrefix)
              || path.posix.normalize(promptRef) !== promptRef
            ) {
              throw new Error(`岗位Prompt引用越界或不规范: ${relative}`);
            }
            await assertOrdinarySourceFile(repoRoot, promptRef);
            const promptsDirectory = `agents/${agentId}/prompts`;
            if (
              promptRef === `${promptsDirectory}/system.md`
              || promptRef.startsWith(`${promptsDirectory}/`)
            ) {
              await assertPlainDirectoryPath(
                repoRoot,
                path.join(repoRoot, promptsDirectory),
                `岗位Prompt目录 ${agentId}`,
              );
              included.push(`${promptsDirectory}/**`);
            } else {
              included.push(promptRef);
            }
            const promptText = (await readOrdinaryFile(
              path.join(repoRoot, promptRef),
              repoRoot,
              `岗位Prompt ${promptRef}`,
            )).toString('utf8');
            const guideRefs = promptText.match(
              /agents\/[a-z][a-z0-9-]{0,63}\/task-guides\/[a-zA-Z0-9._/-]+\.md/g,
            ) || [];
            for (const guideRef of guideRefs) {
              if (!guideRef.startsWith(`agents/${agentId}/task-guides/`)) {
                throw new Error(`岗位任务指南引用越权: ${guideRef}`);
              }
              await assertOrdinarySourceFile(repoRoot, guideRef);
              included.push(guideRef);
            }
          }
          const profileRef = String(manifest.runtimeProfileRef || '').trim();
          if (profileRef) {
            const expectedProfile = `integrations/hermes/profiles/${agentId}.profile.json`;
            if (profileRef !== expectedProfile) {
              throw new Error(`岗位Hermes Profile引用不符合精确映射: ${relative}`);
            }
            await assertOrdinarySourceFile(repoRoot, profileRef);
            included.push(profileRef);
          }
        }
      }
    }
  }
  return [...new Set(included)].sort(bytewiseSort);
}

async function copyAllowlistedEntry(repoRoot, stagingRoot, allowlisted) {
  if (allowlisted.endsWith('/**')) {
    const relative = allowlisted.slice(0, -3);
    const source = path.join(repoRoot, relative);
    const destination = path.join(stagingRoot, relative);
    await fs.mkdir(destination, { recursive:true, mode:0o755 });
    await copyDirectory(repoRoot, source, stagingRoot, destination, {
      allowNodeModuleSymlinks:relative.endsWith('/node_modules'),
    });
    return;
  }
  await copyOrdinaryFile(repoRoot, path.join(repoRoot, allowlisted), stagingRoot, allowlisted);
}

async function copyDirectory(repoRoot, sourceDirectory, stagingRoot, destinationDirectory, options) {
  await assertPlainDirectoryPath(repoRoot, sourceDirectory, 'allowlist源码目录');
  for (const name of (await fs.readdir(sourceDirectory)).sort(bytewiseSort)) {
    if (name === '.DS_Store') continue;
    const source = path.join(sourceDirectory, name);
    const relative = path.relative(repoRoot, source).split(path.sep).join('/');
    if (relative.toLowerCase().endsWith('.log')) continue;
    if (isGeneratedDependencyEntry(relative)) continue;
    assertNotSecretPath(relative);
    const destination = path.join(destinationDirectory, name);
    const stat = await fs.lstat(source);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      await fs.mkdir(destination, { mode:0o755 });
      await copyDirectory(repoRoot, source, stagingRoot, destination, options);
      continue;
    }
    if (stat.isFile() && !stat.isSymbolicLink()) {
      await copyOrdinaryFile(repoRoot, source, stagingRoot, relative);
      continue;
    }
    if (stat.isSymbolicLink() && options.allowNodeModuleSymlinks) {
      const target = await fs.readlink(source);
      await validateContainedSymlink(sourceDirectoryForNodeModules(sourceDirectory), source, target);
      await fs.symlink(target, destination);
      continue;
    }
    throw new Error(`allowlist源码含软链或不支持条目: ${relative}`);
  }
}

function sourceDirectoryForNodeModules(sourceDirectory) {
  const marker = `${path.sep}node_modules`;
  const index = sourceDirectory.lastIndexOf(marker);
  return index === -1
    ? sourceDirectory
    : sourceDirectory.slice(0, index + marker.length);
}

async function validateContainedSymlink(componentRoot, linkPath, target) {
  if (path.isAbsolute(target)) throw new Error(`拒绝绝对软链: ${linkPath}`);
  const lexicalTarget = path.resolve(path.dirname(linkPath), target);
  assertInside(componentRoot, lexicalTarget, 'node_modules软链目标');
  const canonicalTarget = await fs.realpath(linkPath).catch((error) => {
    if (error?.code === 'ENOENT') throw new Error(`拒绝悬空软链: ${linkPath}`);
    throw error;
  });
  assertInside(componentRoot, canonicalTarget, 'node_modules软链真实目标');
}

async function copyOrdinaryFile(repoRoot, source, stagingRoot, relative) {
  assertNotSecretPath(relative);
  const content = await readOrdinaryFile(source, repoRoot, `源码文件 ${relative}`);
  const destination = path.join(stagingRoot, relative);
  assertInside(stagingRoot, destination, 'release目标');
  await fs.mkdir(path.dirname(destination), { recursive:true, mode:0o755 });
  await fs.writeFile(destination, content, { flag:'wx', mode:0o644 });
}

async function readOrdinaryFile(file, allowedRoot, label) {
  assertInside(allowedRoot, file, label);
  const handle = await fs.open(
    file,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`${label}必须是普通文件`);
    if (before.nlink !== 1) throw new Error(`${label}不允许硬链接文件`);
    const canonical = await fs.realpath(file);
    assertInside(allowedRoot, canonical, label);
    const content = await handle.readFile();
    assertNoHighConfidenceSecret(content, label);
    const after = await handle.stat();
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error(`${label}读取期间发生漂移`);
    }
    const pathStat = await fs.lstat(file);
    if (pathStat.dev !== after.dev || pathStat.ino !== after.ino || pathStat.isSymbolicLink()) {
      throw new Error(`${label}读取期间路径被替换`);
    }
    return content;
  } finally {
    await handle.close();
  }
}

async function assertRuntimeStaticClosure(releaseRoot) {
  const entrypoint = path.join(releaseRoot, ENTRYPOINT);
  const pending = [entrypoint];
  const visited = new Set();
  while (pending.length) {
    const current = pending.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    const source = (await readOrdinaryFile(current, releaseRoot, '静态依赖')).toString('utf8');
    for (const specifier of extractStaticSpecifiers(source)) {
      if (specifier.startsWith('node:') || builtinModules.includes(specifier)) continue;
      if (specifier.startsWith('.') || specifier.startsWith('/')) {
        if (specifier.startsWith('/')) {
          throw new Error(`静态依赖越出release: ${specifier}`);
        }
        const resolved = await resolveRelativeModule(path.dirname(current), specifier);
        if (!resolved) throw new Error(`静态依赖无法解析: ${specifier} from ${path.relative(releaseRoot, current)}`);
        assertInside(releaseRoot, resolved, '静态依赖');
        if (/\.(?:js|mjs|cjs)$/.test(resolved)) pending.push(resolved);
        continue;
      }
      try {
        const resolved = await resolveEsmPackage(releaseRoot, current, specifier);
        assertInside(releaseRoot, resolved, `包依赖 ${specifier}`);
      } catch (error) {
        throw new Error(`静态依赖无法解析: ${specifier} from ${path.relative(releaseRoot, current)} (${error.message})`);
      }
    }
  }
  return { entrypoint:ENTRYPOINT, moduleCount:visited.size };
}

async function resolveEsmPackage(releaseRoot, importer, specifier) {
  const parts = specifier.split('/');
  const packageName = specifier.startsWith('@')
    ? parts.slice(0, 2).join('/')
    : parts[0];
  const packageParts = packageName.split('/');
  const subpathParts = parts.slice(packageParts.length);
  const exportKey = subpathParts.length ? `./${subpathParts.join('/')}` : '.';
  let directory = path.dirname(importer);
  while (true) {
    const packageRoot = path.join(directory, 'node_modules', ...packageParts);
    const packageJsonPath = path.join(packageRoot, 'package.json');
    const stat = await lstatOrNull(packageJsonPath);
    if (stat?.isFile() && !stat.isSymbolicLink()) {
      const packageJson = JSON.parse(
        (await readOrdinaryFile(packageJsonPath, releaseRoot, `包清单 ${packageName}`))
          .toString('utf8'),
      );
      const exportTarget = selectImportExport(packageJson.exports, exportKey)
        || (!subpathParts.length && String(packageJson.module || '').trim())
        || (!subpathParts.length && String(packageJson.main || '').trim())
        || (subpathParts.length ? `./${subpathParts.join('/')}` : './index.js');
      if (!exportTarget.startsWith('./')) {
        throw new Error(`包 ${packageName} 的import导出不是包内相对路径`);
      }
      const resolved = await resolveRelativeModule(packageRoot, exportTarget);
      if (!resolved) throw new Error(`包 ${packageName} 的import导出不存在: ${exportTarget}`);
      assertInside(packageRoot, resolved, `包 ${packageName} import导出`);
      return resolved;
    }
    if (directory === releaseRoot) break;
    const parent = path.dirname(directory);
    if (parent === directory || !pathsOverlap(releaseRoot, parent)) break;
    directory = parent;
  }
  throw new Error(`找不到包 ${packageName}`);
}

function selectImportExport(exportsField, exportKey) {
  if (!exportsField) return '';
  let candidate = exportsField;
  if (
    typeof exportsField === 'object'
    && !Array.isArray(exportsField)
    && Object.keys(exportsField).some((key) => key.startsWith('.'))
  ) {
    candidate = exportsField[exportKey];
  }
  return selectImportCondition(candidate);
}

function selectImportCondition(candidate) {
  if (typeof candidate === 'string') return candidate;
  if (Array.isArray(candidate)) {
    for (const item of candidate) {
      const selected = selectImportCondition(item);
      if (selected) return selected;
    }
    return '';
  }
  if (!candidate || typeof candidate !== 'object') return '';
  for (const condition of ['import', 'node', 'default']) {
    const selected = selectImportCondition(candidate[condition]);
    if (selected) return selected;
  }
  return '';
}

async function assertGovernanceRosterSmoke(releaseRoot) {
  const modulePath = path.join(
    releaseRoot,
    'apps/ajun-runtime/src/governance-hermes-runtime.js',
  );
  const moduleStat = await lstatOrNull(modulePath);
  if (!moduleStat) return { status:'not_present_in_fixture', checked:0 };
  if (!moduleStat.isFile() || moduleStat.isSymbolicLink()) {
    throw new Error('governance roster smoke模块不是普通文件');
  }
  const runtime = await import(
    `${pathToFileURL(modulePath).href}?immutable-release-smoke=${crypto.randomUUID()}`
  );
  const agentsRoot = path.join(releaseRoot, 'agents');
  let checked = 0;
  for (const agentId of (await fs.readdir(agentsRoot)).sort(bytewiseSort)) {
    const manifestPath = path.join(agentsRoot, agentId, 'manifest.json');
    const stat = await lstatOrNull(manifestPath);
    if (!stat?.isFile() || stat.isSymbolicLink()) continue;
    const manifest = JSON.parse(
      (await readOrdinaryFile(manifestPath, releaseRoot, `岗位Manifest ${agentId}`))
        .toString('utf8'),
    );
    if (!runtime.usesPaperclipHermesExecution(manifest)) continue;
    runtime.paperclipHermesAdapterConfig(manifest);
    checked += 1;
  }
  return { status:'passed', checked };
}

function extractStaticSpecifiers(source) {
  const found = [];
  const staticPattern = /\b(?:import|export)\s+(?:(?:[\w*$,\s{}]+)\s+from\s+)?['"]([^'"]+)['"]/g;
  const dynamicPattern = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const pattern of [staticPattern, dynamicPattern]) {
    let match;
    while ((match = pattern.exec(source))) found.push(match[1]);
  }
  return [...new Set(found)];
}

async function resolveRelativeModule(directory, specifier) {
  const base = path.resolve(directory, specifier);
  const candidates = [
    base,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.json`,
    path.join(base, 'index.js'),
  ];
  for (const candidate of candidates) {
    const stat = await lstatOrNull(candidate);
    if (stat?.isFile() && !stat.isSymbolicLink()) return candidate;
  }
  return null;
}

async function snapshotPayload(root, { requireReadonly }) {
  const entries = [];
  await collectEntries(root, root, entries, requireReadonly);
  entries.sort((left, right) => bytewiseSort(left.path, right.path));
  const hasher = crypto.createHash('sha256');
  for (const entry of entries) hasher.update(`${JSON.stringify(entry)}\n`);
  return { payloadHash:hasher.digest('hex'), entries };
}

async function collectEntries(root, current, entries, requireReadonly) {
  for (const name of (await fs.readdir(current)).sort(bytewiseSort)) {
    const absolute = path.join(current, name);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (relative === AJUN_RELEASE_MANIFEST) continue;
    assertNotSecretPath(relative);
    const stat = await fs.lstat(absolute);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      if (requireReadonly && (stat.mode & 0o777) !== 0o555) {
        throw new Error(`release目录不是只读模式: ${relative}`);
      }
      entries.push({ type:'directory', path:relative, mode:'0555' });
      await collectEntries(root, absolute, entries, requireReadonly);
      continue;
    }
    if (stat.isFile() && !stat.isSymbolicLink()) {
      const expectedMode = stat.mode & 0o111 ? 0o555 : 0o444;
      if (requireReadonly && (stat.mode & 0o777) !== expectedMode) {
        throw new Error(`release文件不是只读模式: ${relative}`);
      }
      const bytes = await readOrdinaryFile(absolute, root, `release文件 ${relative}`);
      entries.push({
        type:'file',
        path:relative,
        mode:expectedMode === 0o555 ? '0555' : '0444',
        size:bytes.length,
        sha256:crypto.createHash('sha256').update(bytes).digest('hex'),
      });
      continue;
    }
    if (stat.isSymbolicLink()) {
      const target = await fs.readlink(absolute);
      const nodeModulesRoot = nodeModulesRootForReleasePath(root, absolute);
      if (!nodeModulesRoot) throw new Error(`release含非node_modules软链: ${relative}`);
      await validateContainedSymlink(nodeModulesRoot, absolute, target);
      entries.push({ type:'symlink', path:relative, target });
      continue;
    }
    throw new Error(`release含不支持条目: ${relative}`);
  }
}

function nodeModulesRootForReleasePath(root, absolute) {
  const relativeParts = path.relative(root, absolute).split(path.sep);
  const index = relativeParts.lastIndexOf('node_modules');
  return index === -1 ? null : path.join(root, ...relativeParts.slice(0, index + 1));
}

async function chmodTreeReadonly(root) {
  const directories = [root];
  await walk(root, async (absolute, stat) => {
    if (stat.isDirectory()) directories.push(absolute);
    else if (stat.isFile()) await fs.chmod(absolute, stat.mode & 0o111 ? 0o555 : 0o444);
  });
  directories.sort((left, right) => right.length - left.length);
  for (const directory of directories) await fs.chmod(directory, 0o555);
}

async function walk(directory, visit) {
  for (const name of await fs.readdir(directory)) {
    const absolute = path.join(directory, name);
    const stat = await fs.lstat(absolute);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      await visit(absolute, stat);
      await walk(absolute, visit);
    } else {
      await visit(absolute, stat);
    }
  }
}

async function removePrivateTree(root, expectedIdentity = null) {
  const stat = await lstatOrNull(root);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return;
  const identity = expectedIdentity || {
    root,
    dev:stat.dev,
    ino:stat.ino,
    label:'待清理暂存目录',
  };
  await assertDirectoryIdentity(identity);
  await fs.chmod(root, 0o700);
  for (const name of await fs.readdir(root)) {
    const absolute = path.join(root, name);
    const child = await fs.lstat(absolute);
    if (child.isDirectory() && !child.isSymbolicLink()) {
      await removePrivateTree(absolute, {
        root:absolute,
        dev:child.dev,
        ino:child.ino,
        label:'待清理暂存子目录',
      });
    } else {
      if (child.isFile()) await fs.chmod(absolute, 0o600);
      const current = await fs.lstat(absolute);
      if (
        current.dev !== child.dev
        || current.ino !== child.ino
        || current.isDirectory() !== child.isDirectory()
        || current.isSymbolicLink() !== child.isSymbolicLink()
      ) {
        throw new Error(`待清理暂存条目身份发生漂移: ${absolute}`);
      }
      await fs.rm(absolute);
    }
  }
  await assertDirectoryIdentity(identity);
  await fs.rmdir(root);
}

async function validateReleaseFromOwnManifest(releaseRoot) {
  if (!releaseRoot) throw new Error('必须提供old/new release路径');
  const canonical = await canonicalPlainDirectory(releaseRoot, 'release根目录');
  const manifestPath = path.join(canonical, AJUN_RELEASE_MANIFEST);
  const manifest = JSON.parse(await readOrdinaryFile(manifestPath, canonical, 'release清单'));
  return validateAjunRuntimeRelease(canonical, manifest.releaseHash);
}

function releaseReference(release) {
  return {
    root:release.releaseRoot,
    releaseHash:release.releaseHash,
    payloadHash:release.payloadHash,
    entrypoint:path.join(release.releaseRoot, ENTRYPOINT),
  };
}

function releaseResult(status, releaseRoot, snapshot, verification, releaseHash) {
  return {
    status,
    releaseRoot,
    releaseHash,
    payloadHash:snapshot.payloadHash,
    entryCount:snapshot.entries.length,
    verification,
  };
}

async function validateRepairSourceBinding({
  release,
  sourceProjectRoot,
  external,
  label,
}) {
  if (!sourceProjectRoot) {
    throw new Error(`${label}必须提供AGENT_ARMY_SOURCE_PROJECT_ROOT`);
  }
  if (
    release.manifest.git?.worktreeState !== 'clean'
    || !/^[a-f0-9]{40,64}$/.test(String(release.manifest.git?.gitHead || ''))
  ) {
    throw new Error(`${label} release来源必须是clean且有可验证gitHead`);
  }
  if (
    release.manifest.verification?.requested !== true
    || release.manifest.verification?.startupSmoke?.status !== 'passed'
  ) {
    throw new Error(`${label} release必须先通过冻结包真实启动验证`);
  }
  const runtimeSource = await resolveRuntimeSourceRoot({
    runtimeRoot:release.releaseRoot,
    configuredSourceRoot:sourceProjectRoot,
    dataDir:external.dataDir,
    privateDir:external.privateDir,
    worktreeParent:external.paperclipRepairWorktreeParent,
    externalStatePaths:{
      AGENT_ARMY_CONTENT_WORKSPACE_DIR:external.contentWorkspaceDir,
      AGENT_ARMY_HERMES_PROFILE_ROOT:external.hermesProfileRoot,
      AUTO_WORK_ROOT:external.autoWorkRoot,
      XIAOD_ARTIFACT_ROOT:external.xiaodArtifactRoot,
    },
  });
  if (runtimeSource.mode !== 'external_writable_git_root') {
    throw new Error(`${label}源码根未进入外置干净Git worktree模式`);
  }
  if (runtimeSource.sourceIdentity.dirty) {
    throw new Error(`${label}源码根必须保持clean`);
  }
  if (runtimeSource.sourceIdentity.head !== release.manifest.git.gitHead) {
    throw new Error(
      `${label}源码根HEAD与release来源不匹配: `
      + `${runtimeSource.sourceIdentity.head} != ${release.manifest.git.gitHead}`,
    );
  }
  return runtimeSource;
}

function assertExactManifest(manifest) {
  const expectedKeys = [
    'entries',
    'entrypoint',
    'externalState',
    'git',
    'kind',
    'payloadHash',
    'releaseHash',
    'runtimeAbi',
    'schemaVersion',
    'sourceAllowlist',
    'sourceExclusions',
    'verification',
    'workingTreeSnapshot',
  ].sort();
  const actualKeys = Object.keys(manifest || {}).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error('release清单字段不符合精确契约');
  }
  if (manifest.entrypoint !== ENTRYPOINT) throw new Error('release entrypoint发生漂移');
  if (JSON.stringify(manifest.externalState) !== JSON.stringify(EXTERNAL_STATE)) {
    throw new Error('release externalState发生漂移');
  }
  const sourceExclusions = JSON.stringify(manifest.sourceExclusions);
  const currentSourceExclusions = JSON.stringify(SOURCE_EXCLUSIONS);
  const legacySourceExclusions = JSON.stringify(LEGACY_V1_SOURCE_EXCLUSIONS);
  if (
    sourceExclusions !== currentSourceExclusions
    && sourceExclusions !== legacySourceExclusions
  ) {
    throw new Error('release sourceExclusions发生漂移');
  }
  if (
    sourceExclusions === legacySourceExclusions
    && manifest.entries.some(({ path:entryPath }) =>
      String(entryPath || '').toLowerCase().endsWith('.log'))
  ) {
    throw new Error('legacy v1 release含日志文件，拒绝作为回滚包');
  }
  if (
    !Array.isArray(manifest.sourceAllowlist)
    || !manifest.sourceAllowlist.length
    || [...manifest.sourceAllowlist].sort(bytewiseSort).join('\n')
      !== manifest.sourceAllowlist.join('\n')
  ) {
    throw new Error('release sourceAllowlist不合法');
  }
  if (manifest.workingTreeSnapshot !== manifest.payloadHash) {
    throw new Error('release workingTreeSnapshot未绑定payload');
  }
  if (
    manifest.runtimeAbi?.node !== process.version
    || manifest.runtimeAbi?.modules !== process.versions.modules
    || manifest.runtimeAbi?.platform !== process.platform
    || manifest.runtimeAbi?.arch !== process.arch
  ) {
    throw new Error('release Node ABI与当前运行时不匹配');
  }
  if (!Array.isArray(manifest.entries)) throw new Error('release entries不合法');
  assertVerificationContract(manifest.verification, manifest.git?.gitHead, {
    verificationCommands:sourceExclusions === legacySourceExclusions
      ? LEGACY_V1_VERIFY_COMMANDS
      : VERIFY_COMMANDS,
  });
}

function assertVerificationContract(
  verification,
  expectedGitHead,
  { verificationCommands = VERIFY_COMMANDS } = {},
) {
  if (!verification || typeof verification !== 'object') {
    throw new Error('release verification不合法');
  }
  if (verification.requested === false) {
    if (
      JSON.stringify(Object.keys(verification).sort()) !== JSON.stringify(['commands', 'requested'])
      || !Array.isArray(verification.commands)
      || verification.commands.length
    ) {
      throw new Error('release未验证状态不符合精确契约');
    }
    return;
  }
  const expectedKeys = [
    'commands',
    'frozenStaticClosure',
    'payloadUnchanged',
    'requested',
    'sourceSnapshotBound',
    'startupSmoke',
  ];
  if (
    verification.requested !== true
    || verification.frozenStaticClosure !== true
    || verification.payloadUnchanged !== true
    || verification.sourceSnapshotBound !== true
    || JSON.stringify(Object.keys(verification).sort()) !== JSON.stringify(expectedKeys)
  ) {
    throw new Error('release验证状态不符合精确契约');
  }
  assertStartupSmokeEvidence(verification.startupSmoke, expectedGitHead);
  const expectedCommands = verificationCommands.map((item) => ({
    ...item,
    evidenceLayer:'source_test',
  }));
  if (stableCanonical(verification.commands) !== stableCanonical(expectedCommands)) {
    throw new Error('release验证命令发生漂移');
  }
}

function assertStartupSmokeEvidence(evidence, expectedGitHead) {
  const expectedKeys = [
    'endpoint',
    'entrypoint',
    'evidenceLayer',
    'externalEntrypoints',
    'externalStateIsolation',
    'host',
    'httpStatus',
    'portMode',
    'responseContract',
    'sourceGitHead',
    'sourceProjectRoot',
    'status',
    'termination',
  ];
  if (
    !evidence
    || evidence.status !== 'passed'
    || evidence.evidenceLayer !== 'frozen_release_startup'
    || evidence.entrypoint !== ENTRYPOINT
    || evidence.host !== '127.0.0.1'
    || evidence.portMode !== 'ephemeral_loopback'
    || evidence.endpoint !== '/api/overview'
    || evidence.httpStatus !== 200
    || evidence.responseContract !== 'overview.tasks-array'
    || evidence.externalStateIsolation !== 'temporary_directories'
    || evidence.externalEntrypoints !== 'disabled'
    || evidence.sourceProjectRoot !== 'temporary_clean_git_worktree'
    || evidence.sourceGitHead !== expectedGitHead
    || JSON.stringify(Object.keys(evidence).sort()) !== JSON.stringify(expectedKeys)
  ) {
    throw new Error('frozen startup smoke证据不符合精确契约');
  }
  const terminationKeys = ['exitConfirmed', 'forced', 'requestedSignal'];
  if (
    evidence.termination?.requestedSignal !== 'SIGTERM'
    || typeof evidence.termination?.forced !== 'boolean'
    || evidence.termination?.exitConfirmed !== true
    || JSON.stringify(Object.keys(evidence.termination).sort())
      !== JSON.stringify(terminationKeys)
  ) {
    throw new Error('frozen startup smoke进程收口证据不完整');
  }
}

function hashCanonical(value) {
  return crypto.createHash('sha256').update(stableCanonical(value)).digest('hex');
}

function stableCanonical(value) {
  if (Array.isArray(value)) return `[${value.map(stableCanonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort(bytewiseSort).map((key) =>
      `${JSON.stringify(key)}:${stableCanonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function readGitIdentity(repoRoot, { excludedPaths = [] } = {}) {
  const head = await runCaptured('git', ['rev-parse', 'HEAD'], repoRoot);
  if (!/^[a-f0-9]{40}$/.test(head.stdout.trim())) {
    return {
      gitHead:null,
      worktreeState:'unavailable',
      statusFingerprint:null,
    };
  }
  const statusArgs = [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '--',
    '.',
  ];
  for (const excludedPath of excludedPaths) {
    const absolute = path.resolve(excludedPath);
    assertInside(repoRoot, absolute, 'Git状态排除路径');
    const relative = path.relative(repoRoot, absolute).split(path.sep).join('/');
    if (!relative || relative === '.') {
      throw new Error('Git状态排除路径不能是仓库根目录');
    }
    statusArgs.push(`:(exclude)${relative}`, `:(exclude)${relative}/**`);
  }
  const status = await runCaptured('git', statusArgs, repoRoot);
  const statusText = status.ok ? status.stdout : '';
  return {
    gitHead:head.stdout.trim(),
    worktreeState:status.ok && statusText.trim() === '' ? 'clean' : 'dirty',
    statusFingerprint:status.ok ? hashCanonical(statusText) : null,
  };
}

function publicGitIdentity(identity) {
  return {
    gitHead:identity.gitHead,
    worktreeState:identity.worktreeState,
  };
}

function assertGitIdentityUnchanged(before, after, label) {
  if (
    before.gitHead !== after.gitHead
    || before.worktreeState !== after.worktreeState
    || before.statusFingerprint !== after.statusFingerprint
  ) {
    throw new Error(`${label}Git源码状态发生变化，拒绝冻结`);
  }
}

async function runCaptured(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env:{ ...process.env, LC_ALL:'C' },
      stdio:['ignore', 'pipe', 'ignore'],
      shell:false,
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.once('error', () => resolve({ ok:false, stdout:'' }));
    child.once('exit', (code) => resolve({ ok:code === 0, stdout }));
  });
}

async function readNodeAbi(nodePath) {
  const result = await runCaptured(
    nodePath,
    [
      '-p',
      'JSON.stringify({node:process.version,modules:process.versions.modules,platform:process.platform,arch:process.arch})',
    ],
    path.dirname(nodePath),
  );
  if (!result.ok) throw new Error('无法用nodePath读取运行时ABI');
  let abi;
  try {
    abi = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error('nodePath返回了无效ABI');
  }
  if (
    typeof abi.node !== 'string'
    || typeof abi.modules !== 'string'
    || typeof abi.platform !== 'string'
    || typeof abi.arch !== 'string'
  ) {
    throw new Error('nodePath ABI字段不完整');
  }
  return abi;
}

async function canonicalPlainDirectory(input, label) {
  const absolute = path.resolve(String(input || ''));
  const stat = await fs.lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label}必须是普通目录: ${absolute}`);
  }
  return fs.realpath(absolute);
}

async function canonicalOrProspectiveDirectory(input, label) {
  if (!input || !path.isAbsolute(String(input))) throw new Error(`${label}必须是绝对目录`);
  const absolute = path.resolve(input);
  const stat = await lstatOrNull(absolute);
  if (!stat) {
    const missing = [];
    let ancestor = absolute;
    while (!(await lstatOrNull(ancestor))) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw new Error(`${label}没有可核验祖先目录`);
      missing.unshift(path.basename(ancestor));
      ancestor = parent;
    }
    const ancestorStat = await fs.lstat(ancestor);
    if (!ancestorStat.isDirectory() || ancestorStat.isSymbolicLink()) {
      throw new Error(`${label}祖先不能是软链或文件`);
    }
    const canonicalAncestor = await fs.realpath(ancestor);
    return path.join(canonicalAncestor, ...missing);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label}不能是软链或文件`);
  return fs.realpath(absolute);
}

async function assertPlainDirectoryPath(root, target, label) {
  assertInside(root, target, label);
  let current = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${label}路径含软链或非目录: ${current}`);
    }
  }
}

async function assertOrdinarySourceFile(repoRoot, relative) {
  assertNotSecretPath(relative);
  const absolute = path.join(repoRoot, relative);
  await assertPlainDirectoryPath(repoRoot, path.dirname(absolute), `源码父目录 ${relative}`);
  const stat = await fs.lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`allowlist源码必须是普通文件: ${relative}`);
  }
}

async function ensureDirectoryTree(root, target, label) {
  assertInside(root, target, label);
  let current = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await lstatOrNull(current);
    if (!stat) {
      try {
        await fs.mkdir(current, { mode:0o700 });
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
      const created = await fs.lstat(current);
      if (!created.isDirectory() || created.isSymbolicLink()) {
        throw new Error(`${label}含软链或非目录: ${current}`);
      }
      continue;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${label}含软链或非目录: ${current}`);
    }
  }
}

async function directoryIdentity(directory, label) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label}必须是普通目录`);
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
    throw new Error(`${identity.label}身份发生漂移`);
  }
}

function assertNotSecretPath(relative) {
  const names = relative.split('/');
  for (const name of names) {
    const lower = name.toLowerCase();
    if (
      lower === '.env'
      || lower.startsWith('.env.')
      || lower === 'auth.json'
      || lower === 'master.key'
      || lower === 'feishu-agent-secrets.json'
      || lower.endsWith('.pem')
      || lower.endsWith('.p12')
      || lower.endsWith('.pfx')
      || lower.endsWith('.key')
      || (lower.endsWith('.json') && /(?:credential|secrets?)/.test(lower))
    ) {
      throw new Error(`禁止进入release的私密路径: ${relative}`);
    }
  }
}

function isGeneratedDependencyEntry(relative) {
  const parts = relative.split('/');
  const nodeModulesIndex = parts.indexOf('node_modules');
  if (nodeModulesIndex === -1) return false;
  return parts.slice(nodeModulesIndex + 1).includes('.cache')
    || parts.at(-1)?.endsWith('.log');
}

function assertNoHighConfidenceSecret(content, label) {
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content);
  const patterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]{80,}\r?\n-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\b(?:STEPFUN|OPENAI|DEEPSEEK|FEISHU)_(?:API_)?(?:KEY|TOKEN|SECRET)\s*[:=]\s*["']?(?:sk-|[A-Za-z0-9+/=_-]{24,})/i,
    /\b[A-Z][A-Z0-9_]{1,48}_(?:CLIENT_SECRET|ACCESS_TOKEN|API_KEY)\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{24,}/,
    /["'](?:api[_-]?key|access[_-]?token|client[_-]?secret)["']\s*:\s*["'](?:sk-|[A-Za-z0-9+/=_-]{24,})/i,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}/,
    /\bsk-[A-Za-z0-9_-]{20,}\b/,
  ];
  if (patterns.some((pattern) => pattern.test(text))) {
    throw new Error(`${label}含高置信凭据内容，禁止进入release`);
  }
}

function assertOutsideRelease(candidate, releaseRoot, label) {
  if (pathsOverlap(candidate, releaseRoot)) {
    throw new Error(`${label}必须外置于release: ${candidate}`);
  }
}

function assertNonOverlappingDirectories(directories) {
  const entries = Object.entries(directories);
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      if (pathsOverlap(entries[left][1], entries[right][1])) {
        throw new Error(`${entries[left][0]}与${entries[right][0]}不得重叠`);
      }
    }
  }
}

function assertOutputDoesNotOverlapAllowlist(repoRoot, outputParent, includedPaths) {
  for (const included of includedPaths) {
    const relative = included.endsWith('/**') ? included.slice(0, -3) : included;
    const source = path.join(repoRoot, relative);
    if (pathsOverlap(outputParent, source)) {
      throw new Error(`输出目录与allowlist源码重叠: ${relative}`);
    }
  }
}

function pathsOverlap(left, right) {
  const leftToRight = path.relative(left, right);
  const rightToLeft = path.relative(right, left);
  return leftToRight === ''
    || (!leftToRight.startsWith('..') && !path.isAbsolute(leftToRight))
    || (!rightToLeft.startsWith('..') && !path.isAbsolute(rightToLeft));
}

function assertInside(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return;
  throw new Error(`${label}越出允许根目录: ${candidate}`);
}

function parseNamedArgs(argv, valueNames, flagNames = []) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (flagNames.includes(value.replace(/^--/, '')) && value.startsWith('--')) {
      options[value.slice(2)] = true;
      continue;
    }
    if (!value.startsWith('--') || !valueNames.includes(value.slice(2))) {
      throw new Error(`未知参数: ${value}`);
    }
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`${value}缺少值`);
    options[value.slice(2)] = next;
    index += 1;
  }
  for (const name of valueNames) {
    if (['output-parent', 'rollback-source-project-root'].includes(name)) continue;
    if (!options[name]) throw new Error(`必须提供 --${name}`);
  }
  return options;
}

async function lstatOrNull(file) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function bytewiseSort(left, right) {
  return Buffer.from(left).compare(Buffer.from(right));
}

async function defaultFrozenStartupSmoke({
  releaseRoot,
  repoRoot,
  gitHead,
  nodePath,
}) {
  const smokeRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-frozen-startup-')),
  );
  const sourceRoot = path.join(smokeRoot, 'source-worktree');
  const externalRoot = path.join(smokeRoot, 'external');
  let worktreeAttempted = false;
  let child = null;
  let childExit = null;
  let smokeError = null;
  let termination = {
    requestedSignal:'SIGTERM',
    forced:false,
    exitConfirmed:false,
  };
  try {
    worktreeAttempted = true;
    await runCheckedCaptured(
      'git',
      ['worktree', 'add', '--detach', sourceRoot, gitHead],
      repoRoot,
      15_000,
    );
    const canonicalSourceRoot = await canonicalPlainDirectory(
      sourceRoot,
      'smoke源码worktree',
    );
    const sourceGit = await readGitIdentity(canonicalSourceRoot);
    if (sourceGit.gitHead !== gitHead || sourceGit.worktreeState !== 'clean') {
      throw new Error('smoke源码worktree与release Git来源不匹配或不干净');
    }

    const directories = {
      data:path.join(externalRoot, 'data'),
      content:path.join(externalRoot, 'content'),
      hermes:path.join(externalRoot, 'hermes'),
      privateDir:path.join(externalRoot, 'private'),
      autoWork:path.join(externalRoot, 'auto-work'),
      xiaod:path.join(externalRoot, 'xiaod'),
      repair:path.join(externalRoot, 'repair-worktrees'),
      home:path.join(externalRoot, 'home'),
      tmp:path.join(externalRoot, 'tmp'),
    };
    await Promise.all(
      Object.values(directories).map((directory) =>
        fs.mkdir(directory, { recursive:true, mode:0o700 })),
    );
    const port = await reserveLoopbackPort();
    const environment = {
      PATH:process.env.PATH || '/usr/bin:/bin',
      HOME:directories.home,
      TMPDIR:directories.tmp,
      LANG:'C',
      LC_ALL:'C',
      CI:'1',
      NO_PROXY:'127.0.0.1,localhost',
      PORT:String(port),
      AJUN_HOST:'127.0.0.1',
      AGENT_ARMY_DATA_DIR:directories.data,
      AGENT_ARMY_CONTENT_WORKSPACE_DIR:directories.content,
      AGENT_ARMY_HERMES_PROFILE_ROOT:directories.hermes,
      AGENT_ARMY_PRIVATE_DIR:directories.privateDir,
      AJUN_HERMES_HOME:path.join(directories.hermes, 'ajun'),
      AUTO_WORK_ROOT:directories.autoWork,
      XIAOD_ARTIFACT_ROOT:directories.xiaod,
      PAPERCLIP_REPAIR_WORKTREE_PARENT:directories.repair,
      AGENT_ARMY_SOURCE_PROJECT_ROOT:canonicalSourceRoot,
      AGENT_ARMY_DEPLOYMENT_MODE:'cloud',
      AGENT_ARMY_EMPLOYEE_FEISHU_OWNER:'disabled',
      AJUN_HERMES_NATIVE_FEISHU:'true',
      AJUN_HERMES_NATIVE_EMPLOYEE_IDS:'',
      PAPERCLIP_URL:'http://127.0.0.1:1',
      XIAOD_RUNTIME_URL:'http://127.0.0.1:65534',
    };
    child = spawn(nodePath, [path.join(releaseRoot, ENTRYPOINT)], {
      cwd:path.join(releaseRoot, 'apps/ajun-runtime'),
      env:environment,
      stdio:['ignore', 'pipe', 'pipe'],
      shell:false,
    });
    const output = captureBoundedChildOutput(child, 32_768);
    childExit = childExitPromise(child);
    await waitForOverview({
      url:`http://127.0.0.1:${port}/api/overview`,
      childExit,
      output,
      timeoutMs:20_000,
    });
  } catch (error) {
    smokeError = error;
  } finally {
    if (child) {
      try {
        termination = await terminateChild(child, childExit, 3_000);
      } catch (error) {
        smokeError ||= error;
      }
    }
    if (worktreeAttempted) {
      try {
        await removeRegisteredSmokeWorktree(repoRoot, sourceRoot);
        if (await lstatOrNull(sourceRoot)) {
          throw new Error('smoke源码worktree清理后仍存在');
        }
      } catch (error) {
        smokeError ||= new Error(`smoke源码worktree清理失败: ${error.message}`, {
          cause:error,
        });
      }
    }
    try {
      await fs.rm(smokeRoot, { recursive:true, force:true });
    } catch (error) {
      smokeError ||= new Error(`smoke临时目录清理失败: ${error.message}`, {
        cause:error,
      });
    }
  }
  if (smokeError) throw smokeError;
  if (!termination.exitConfirmed) {
    throw new Error('frozen server退出未确认，拒绝签发验证');
  }
  return {
    status:'passed',
    evidenceLayer:'frozen_release_startup',
    entrypoint:ENTRYPOINT,
    host:'127.0.0.1',
    portMode:'ephemeral_loopback',
    endpoint:'/api/overview',
    httpStatus:200,
    responseContract:'overview.tasks-array',
    externalStateIsolation:'temporary_directories',
    externalEntrypoints:'disabled',
    sourceProjectRoot:'temporary_clean_git_worktree',
    sourceGitHead:gitHead,
    termination,
  };
}

async function removeRegisteredSmokeWorktree(repoRoot, sourceRoot) {
  const listed = await runCheckedCaptured(
    'git',
    ['worktree', 'list', '--porcelain', '-z'],
    repoRoot,
    15_000,
  );
  const registered = listed.stdout
    .split('\0')
    .filter((entry) => entry.startsWith('worktree '))
    .map((entry) => path.normalize(entry.slice('worktree '.length).trim()))
    .includes(path.normalize(sourceRoot));
  if (registered) {
    await runCheckedCaptured(
      'git',
      ['worktree', 'remove', '--force', sourceRoot],
      repoRoot,
      15_000,
    );
    return;
  }
  const stat = await lstatOrNull(sourceRoot);
  if (stat?.isSymbolicLink() || (stat && !stat.isDirectory())) {
    throw new Error('未注册smoke源码路径被替换为非目录');
  }
}

async function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (!Number.isInteger(port) || port < 1) reject(new Error('无法分配回环随机端口'));
        else resolve(port);
      });
    });
  });
}

function captureBoundedChildOutput(child, maxBytes) {
  const state = { stdout:'', stderr:'' };
  const append = (field, chunk) => {
    state[field] = `${state[field]}${chunk}`.slice(-maxBytes);
  };
  child.stdout?.on('data', (chunk) => append('stdout', chunk));
  child.stderr?.on('data', (chunk) => append('stderr', chunk));
  return state;
}

function childExitPromise(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function waitForOverview({ url, childExit, output, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await Promise.race([
      childExit.then((exit) => ({ type:'exit', exit })),
      fetch(url, { signal:AbortSignal.timeout(750) })
        .then(async (response) => ({
          type:'response',
          response,
          body:await response.json().catch(() => null),
        }))
        .catch(() => ({ type:'retry' })),
    ]);
    if (result.type === 'exit') {
      throw new Error(
        `frozen server在overview验收前退出: `
        + `${result.exit.signal || `exit ${result.exit.code}`}; `
        + `${output.stderr || output.stdout}`.slice(-2_000),
      );
    }
    if (
      result.type === 'response'
      && result.response.status === 200
      && Array.isArray(result.body?.tasks)
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `frozen server未在${timeoutMs}ms内通过GET /api/overview: `
    + `${output.stderr || output.stdout}`.slice(-2_000),
  );
}

async function terminateChild(child, exitPromise, timeoutMs) {
  if (child.exitCode !== null || child.signalCode) {
    await exitPromise;
    return { requestedSignal:'SIGTERM', forced:false, exitConfirmed:true };
  }
  child.kill('SIGTERM');
  const graceful = await settleWithin(exitPromise, timeoutMs);
  if (graceful.settled) {
    if (graceful.error) throw graceful.error;
    return { requestedSignal:'SIGTERM', forced:false, exitConfirmed:true };
  }
  child.kill('SIGKILL');
  const forced = await settleWithin(exitPromise, timeoutMs);
  if (!forced.settled) throw new Error('frozen server在SIGKILL后仍未确认退出');
  if (forced.error) throw forced.error;
  return { requestedSignal:'SIGTERM', forced:true, exitConfirmed:true };
}

async function settleWithin(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ settled:true, value }),
        (error) => ({ settled:true, error }),
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ settled:false }), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runCheckedCaptured(command, args, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env:{ ...process.env, LC_ALL:'C' },
      stdio:['ignore', 'pipe', 'pipe'],
      shell:false,
    });
    let stdout = '';
    let stderr = '';
    let timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timer);
      timer = null;
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(
        `${command} ${args.join(' ')}失败: ${signal || `exit ${code}`} `
        + `${stderr}`.slice(-1_000),
      ));
    });
  });
}

async function defaultRunCommand(command, args, { cwd }) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env:{ ...process.env, CI:'1' },
      stdio:'inherit',
      shell:false,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(`${command} ${args.join(' ')}失败: ${signal || `exit ${code}`}`));
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  AJUN_RELEASE_PREFIX,
  buildLaunchdCutoverPlan,
  freezeAjunRuntimeRelease,
  validateAjunRuntimeRelease,
} from '../scripts/manage-immutable-runtime-release.mjs';

const execFile = promisify(execFileCallback);

test('按运行时白名单冻结内容寻址只读包，并排除data、测试、脚本和私密文件', async (context) => {
  const repoRoot = await createFixture(context, 'one');
  const result = await freezeAjunRuntimeRelease({ repoRoot });

  assert.equal(result.status, 'frozen');
  assert.match(result.payloadHash, /^[a-f0-9]{64}$/);
  assert.equal(path.basename(result.releaseRoot), `${AJUN_RELEASE_PREFIX}${result.releaseHash}`);
  assert.equal(
    await fs.readFile(path.join(result.releaseRoot, 'apps/ajun-runtime/src/server.js'), 'utf8'),
    "import './local.js';\n",
  );
  for (const sourceFile of [
    'hermes-oneshot-policy.js',
    'm5-work-product-integrity.js',
    'task-service.js',
  ]) {
    assert.equal(
      (await fs.stat(path.join(result.releaseRoot, 'apps/ajun-runtime/src', sourceFile))).isFile(),
      true,
    );
  }
  assert.equal(
    JSON.parse(await fs.readFile(
      path.join(result.releaseRoot, 'agents/ajun/manifest.json'),
      'utf8',
    )).agentId,
    'ajun',
  );
  assert.equal(
    JSON.parse(await fs.readFile(
      path.join(result.releaseRoot, 'integrations/hermes/profiles/ajun.profile.json'),
      'utf8',
    )).profileId,
    'ajun',
  );
  await assert.rejects(
    fs.stat(path.join(result.releaseRoot, 'apps/ajun-runtime/data/runtime.json')),
    { code: 'ENOENT' },
  );
  await assert.rejects(
    fs.stat(path.join(result.releaseRoot, 'apps/ajun-runtime/test/server.test.js')),
    { code: 'ENOENT' },
  );
  await assert.rejects(
    fs.stat(path.join(result.releaseRoot, 'apps/ajun-runtime/test/task-service.test.js')),
    { code:'ENOENT' },
  );
  await assert.rejects(
    fs.stat(path.join(result.releaseRoot, 'apps/ajun-runtime/scripts/not-runtime.mjs')),
    { code: 'ENOENT' },
  );
  await assert.rejects(
    fs.stat(path.join(
      result.releaseRoot,
      'node_modules/.cache/generated.log',
    )),
    { code:'ENOENT' },
  );
  await assert.rejects(
    fs.stat(path.join(result.releaseRoot, 'apps/ajun-runtime/src/runtime.log')),
    { code:'ENOENT' },
  );
  assert.equal((await fs.stat(result.releaseRoot)).mode & 0o777, 0o555);
  assert.equal(
    (await fs.stat(path.join(result.releaseRoot, 'apps/ajun-runtime/src/server.js'))).mode & 0o777,
    0o444,
  );

  const manifest = JSON.parse(await fs.readFile(
    path.join(result.releaseRoot, 'release-manifest.json'),
    'utf8',
  ));
  assert.equal(manifest.payloadHash, result.payloadHash);
  assert.equal(manifest.entrypoint, 'apps/ajun-runtime/src/server.js');
  assert.deepEqual(manifest.externalState, [
    'AGENT_ARMY_DATA_DIR',
    'AGENT_ARMY_TASK_STORE',
    'AGENT_ARMY_CONTENT_WORKSPACE_DIR',
    'AGENT_ARMY_HERMES_PROFILE_ROOT',
    'AGENT_ARMY_PRIVATE_DIR',
    'AJUN_HERMES_HOME',
    'AUTO_WORK_ROOT',
    'XIAOD_ARTIFACT_ROOT',
    'PAPERCLIP_REPAIR_WORKTREE_PARENT',
    'AGENT_ARMY_SOURCE_PROJECT_ROOT',
  ]);
  assert.equal(
    await fs.readFile(
      path.join(result.releaseRoot, 'agents/ajun/prompts/system.md'),
      'utf8',
    ),
    '# A君\n',
  );
  assert.equal(
    await fs.readFile(
      path.join(result.releaseRoot, 'agents/ajun/prompts/task-guides/check.md'),
      'utf8',
    ),
    '# 检查\n',
  );
  assert.ok(manifest.entries.some(({ path: entryPath }) =>
    entryPath === 'integrations/paperclip/m5-content-pipeline/src/index.js'));
  assert.ok(manifest.entries.some(({ path: entryPath }) =>
    entryPath === 'integrations/paperclip/m5-content-pipeline/config/definition.json'));
  assert.ok(manifest.entries.some(({ path: entryPath }) =>
    entryPath === 'integrations/paperclip/plugins/content-autonomy/src/signed-budget-ticket.js'));
  assert.ok(manifest.entries.some(({ path: entryPath }) =>
    entryPath === 'integrations/publishing/m5-publisher-gateway/src/index.js'));
  assert.ok(manifest.entries.some(({ path: entryPath }) =>
    entryPath === 'integrations/access/content-acquisition-center.js'));
  assert.ok(manifest.entries.some(({ type, path: entryPath }) =>
    type === 'symlink' && entryPath === 'node_modules/@agent-army/m5-kernel'));
  assert.ok(manifest.entries.some(({ type, path: entryPath }) =>
    type === 'symlink' && entryPath === 'node_modules/ajun-common-access'));
  assert.equal(
    manifest.entries.some(({ path: entryPath }) => entryPath.includes('/data/')),
    false,
  );
  await validateAjunRuntimeRelease(result.releaseRoot, result.releaseHash);
});

test('未忽略的受管发布目录不污染clean来源，但其他未提交文件仍判dirty', async (context) => {
  const repoRoot = await createFixture(context, 'output-provenance');
  const cleanRelease = await freezeAjunRuntimeRelease({
    repoRoot,
    outputParent:path.join(repoRoot, 'work/runtime-releases'),
  });
  const cleanManifest = JSON.parse(await fs.readFile(
    path.join(cleanRelease.releaseRoot, 'release-manifest.json'),
    'utf8',
  ));
  assert.equal(cleanManifest.git.worktreeState, 'clean');

  await fs.writeFile(path.join(repoRoot, 'unrelated-dirty.txt'), 'dirty\n');
  const dirtyRelease = await freezeAjunRuntimeRelease({
    repoRoot,
    outputParent:path.join(repoRoot, 'work/dirty-runtime-releases'),
  });
  const dirtyManifest = JSON.parse(await fs.readFile(
    path.join(dirtyRelease.releaseRoot, 'release-manifest.json'),
    'utf8',
  ));
  assert.equal(dirtyManifest.git.worktreeState, 'dirty');
});

test('相同内容幂等复用；已有同哈希包漂移时失败且不覆盖', async (context) => {
  const repoRoot = await createFixture(context, 'same');
  const first = await freezeAjunRuntimeRelease({ repoRoot });
  const second = await freezeAjunRuntimeRelease({ repoRoot });
  assert.equal(second.status, 'already_frozen');
  assert.equal(second.releaseRoot, first.releaseRoot);

  const target = path.join(first.releaseRoot, 'apps/ajun-runtime/src/server.js');
  await fs.chmod(first.releaseRoot, 0o755);
  await fs.chmod(path.dirname(target), 0o755);
  await fs.chmod(target, 0o644);
  await fs.writeFile(target, "import './drift.js';\n");
  await assert.rejects(
    freezeAjunRuntimeRelease({ repoRoot }),
    /只读|哈希|清单/,
  );
});

test('允许目录中的secret、源码软链和输出路径软链均被拒绝', async (context) => {
  const secretRepo = await createFixture(context, 'secret');
  await fs.writeFile(path.join(secretRepo, 'apps/ajun-runtime/src/.env.local'), 'TOKEN=nope\n');
  await assert.rejects(
    freezeAjunRuntimeRelease({ repoRoot: secretRepo }),
    /禁止进入release/,
  );

  const sourceLinkRepo = await createFixture(context, 'source-link');
  await fs.symlink(
    'local.js',
    path.join(sourceLinkRepo, 'apps/ajun-runtime/src/linked.js'),
  );
  await assert.rejects(
    freezeAjunRuntimeRelease({ repoRoot: sourceLinkRepo }),
    /软链/,
  );

  const outputLinkRepo = await createFixture(context, 'output-link');
  const realOutput = path.join(outputLinkRepo, 'real-output');
  const linkedOutput = path.join(outputLinkRepo, 'linked-output');
  await fs.mkdir(realOutput);
  await fs.symlink('real-output', linkedOutput);
  await assert.rejects(
    freezeAjunRuntimeRelease({ repoRoot: outputLinkRepo, outputParent: linkedOutput }),
    /输出路径含软链/,
  );
});

test('伪装在允许源码中的真实Key特征和根外硬链接均失败关闭', async (context) => {
  const secretRepo = await createFixture(context, 'secret-content');
  await fs.writeFile(
    path.join(secretRepo, 'apps/ajun-runtime/src/local.js'),
    'const STEPFUN_API_KEY="sk-live-redteam-abcdefghijklmnop";\n',
  );
  await assert.rejects(
    freezeAjunRuntimeRelease({ repoRoot:secretRepo }),
    /高置信凭据内容/,
  );
  const publisherSecretRepo = await createFixture(context, 'publisher-secret-content');
  await fs.writeFile(
    path.join(publisherSecretRepo, 'apps/ajun-runtime/src/local.js'),
    'const DOUYIN_CLIENT_SECRET="douyin-secret-abcdefghijklmnopqrstuvwxyz123456";\n',
  );
  await assert.rejects(
    freezeAjunRuntimeRelease({ repoRoot:publisherSecretRepo }),
    /高置信凭据内容/,
  );

  const pemLiteralRepo = await createFixture(context, 'pem-literal');
  await fs.writeFile(
    path.join(pemLiteralRepo, 'apps/ajun-runtime/src/local.js'),
    "export const pemHeader = '-----BEGIN PRIVATE KEY-----';\n",
  );
  await freezeAjunRuntimeRelease({ repoRoot:pemLiteralRepo });

  const realPemRepo = await createFixture(context, 'real-pem');
  await fs.writeFile(
    path.join(realPemRepo, 'apps/ajun-runtime/src/local.js'),
    `export const leaked = \`-----BEGIN PRIVATE KEY-----\n${'A'.repeat(96)}\n-----END PRIVATE KEY-----\`;\n`,
  );
  await assert.rejects(
    freezeAjunRuntimeRelease({ repoRoot:realPemRepo }),
    /高置信凭据内容/,
  );

  const hardlinkRepo = await createFixture(context, 'hardlink');
  const externalFile = path.join(path.dirname(hardlinkRepo), `outside-${path.basename(hardlinkRepo)}.js`);
  context.after(() => fs.rm(externalFile, { force:true }));
  await fs.writeFile(externalFile, 'export const outside = true;\n');
  const linkedFile = path.join(hardlinkRepo, 'apps/ajun-runtime/src/local.js');
  await fs.rm(linkedFile);
  await fs.link(externalFile, linkedFile);
  await assert.rejects(
    freezeAjunRuntimeRelease({ repoRoot:hardlinkRepo }),
    /硬链接/,
  );
});

test('manifest元数据篡改即使恢复0444也不能通过验证', async (context) => {
  const repoRoot = await createFixture(context, 'manifest-tamper');
  const release = await freezeAjunRuntimeRelease({ repoRoot });
  const manifestPath = path.join(release.releaseRoot, 'release-manifest.json');
  await fs.chmod(manifestPath, 0o644);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.entrypoint = 'apps/ajun-runtime/src/other.js';
  manifest.externalState = [];
  manifest.verification = { requested:true, commands:[] };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.chmod(manifestPath, 0o444);
  await assert.rejects(
    validateAjunRuntimeRelease(release.releaseRoot, release.releaseHash),
    /元数据|entrypoint|externalState/,
  );
});

test('输出目录与allowlist源码重叠被拒绝，竞态冻结只产生一个同内容release', async (context) => {
  const overlapRepo = await createFixture(context, 'overlap');
  await assert.rejects(
    freezeAjunRuntimeRelease({
      repoRoot:overlapRepo,
      outputParent:path.join(overlapRepo, 'apps/ajun-runtime/src/releases'),
    }),
    /输出目录与allowlist源码重叠/,
  );

  const concurrentRepo = await createFixture(context, 'concurrent');
  const results = await Promise.all([
    freezeAjunRuntimeRelease({ repoRoot:concurrentRepo }),
    freezeAjunRuntimeRelease({ repoRoot:concurrentRepo }),
  ]);
  assert.deepEqual(
    results.map(({ status }) => status).sort(),
    ['already_frozen', 'frozen'],
  );
  assert.equal(results[0].releaseRoot, results[1].releaseRoot);

  const collisionRepo = await createFixture(context, 'collision');
  const first = await freezeAjunRuntimeRelease({ repoRoot:collisionRepo });
  await makeWritable(first.releaseRoot);
  await fs.rm(first.releaseRoot, { recursive:true });
  const elsewhere = path.join(collisionRepo, 'elsewhere');
  await fs.mkdir(elsewhere);
  await fs.symlink(elsewhere, first.releaseRoot);
  await assert.rejects(
    freezeAjunRuntimeRelease({ repoRoot:collisionRepo }),
    /普通目录|软链/,
  );
  assert.equal((await fs.lstat(first.releaseRoot)).isSymbolicLink(), true);
});

test('server静态依赖闭包缺文件时冻结失败关闭', async (context) => {
  const repoRoot = await createFixture(context, 'missing-import');
  await fs.writeFile(
    path.join(repoRoot, 'apps/ajun-runtime/src/server.js'),
    "import './missing.js';\n",
  );
  await assert.rejects(
    freezeAjunRuntimeRelease({ repoRoot }),
    /静态依赖无法解析/,
  );
});

test('verify要求真实启动级证据并执行必要源码测试，且清单记录结构化证据', async (context) => {
  const repoRoot = await createFixture(context, 'verify');
  const calls = [];
  const smokeCalls = [];
  const canonicalRepoRoot = await fs.realpath(repoRoot);
  const result = await freezeAjunRuntimeRelease({
    repoRoot,
    verify: true,
    smokeRunner:async (input) => {
      smokeCalls.push(input);
      return startupEvidence(input.gitHead);
    },
    runCommand: async (command, args, options) => {
      const cwd = path.relative(canonicalRepoRoot, options.cwd);
      calls.push({ command, args, cwd });
    },
  });
  assert.equal(smokeCalls.length, 1);
  assert.match(smokeCalls[0].releaseRoot, /\.ajun-release-/);
  assert.equal(smokeCalls[0].repoRoot, canonicalRepoRoot);
  assert.match(smokeCalls[0].gitHead, /^[a-f0-9]{40}$/);
  assert.deepEqual(calls, [
    {
      command:'npm',
      args:['test'],
      cwd:'integrations/m5-kernel',
    },
    {
      command:'npm',
      args:['test'],
      cwd: 'apps/ajun-runtime',
    },
    {
      command: 'npm',
      args: ['test'],
      cwd: 'integrations/paperclip/m5-content-pipeline',
    },
    {
      command: 'npm',
      args: ['run', 'check'],
      cwd: 'integrations/paperclip/plugins/content-autonomy',
    },
    {
      command:'npm',
      args:['test'],
      cwd:'integrations/paperclip/plugins/content-autonomy',
    },
    {
      command: 'npm',
      args: ['run', 'check'],
      cwd: 'integrations/publishing/m5-publisher-gateway',
    },
    {
      command:'npm',
      args:['run', 'check'],
      cwd:'packages/m5-contracts',
    },
    {
      command:'npm',
      args:['test'],
      cwd:'packages/paperclip-client',
    },
  ]);
  assert.equal(result.verification.requested, true);
  assert.equal(result.verification.commands.length, 8);
  assert.equal(result.verification.commands[0].evidenceLayer, 'source_test');
  assert.equal(result.verification.startupSmoke.status, 'passed');
  assert.equal(result.verification.startupSmoke.httpStatus, 200);
  assert.equal(result.verification.startupSmoke.termination.exitConfirmed, true);
  assert.equal(result.verification.recoveryStartupSmoke.status, 'passed');
  assert.equal(result.verification.recoveryStartupSmoke.healthHttpStatus, 200);
  assert.equal(result.verification.recoveryStartupSmoke.unknownGetHttpStatus, 404);
  assert.equal(result.verification.recoveryStartupSmoke.writeHttpStatus, 503);
  assert.equal(result.verification.recoveryStartupSmoke.writeError, 'recovery_mode_read_only');
  assert.deepEqual(result.verification.recoveryStartupSmoke.formalStateEnvironmentKeys, []);
  assert.equal(result.verification.recoveryStartupSmoke.termination.forced, false);
  assert.equal(result.verification.recoveryStartupSmoke.termination.exitConfirmed, true);
  assert.equal(result.verification.payloadUnchanged, true);
  assert.equal(result.verification.sourceSnapshotBound, true);

  const driftingSourceRepo = await createFixture(context, 'source-drift');
  let mutated = false;
  await assert.rejects(
    freezeAjunRuntimeRelease({
      repoRoot:driftingSourceRepo,
      verify:true,
      smokeRunner:async ({ gitHead }) => startupEvidence(gitHead),
      runCommand:async () => {
        if (mutated) return;
        mutated = true;
        await fs.writeFile(
          path.join(driftingSourceRepo, 'apps/ajun-runtime/src/local.js'),
          'export const changedDuringSourceTests = true;\n',
        );
      },
    }),
    /源码测试期间allowlist快照发生变化/,
  );

  const sameRepo = await createFixture(context, 'verify-upgrade');
  const unverified = await freezeAjunRuntimeRelease({ repoRoot:sameRepo });
  const verified = await freezeAjunRuntimeRelease({
    repoRoot:sameRepo,
    verify:true,
    smokeRunner:async ({ gitHead }) => startupEvidence(gitHead),
    runCommand:async () => {},
  });
  assert.notEqual(verified.releaseRoot, unverified.releaseRoot);
  assert.equal(verified.verification.requested, true);
  assert.equal(unverified.verification.requested, false);

  const invalidSmokeRepo = await createFixture(context, 'invalid-smoke');
  await assert.rejects(
    freezeAjunRuntimeRelease({
      repoRoot:invalidSmokeRepo,
      verify:true,
      smokeRunner:async ({ gitHead }) => ({
        ...startupEvidence(gitHead),
        httpStatus:503,
      }),
      runCommand:async () => {},
    }),
    /startup smoke证据/,
  );

  const invalidRecoverySmokeRepo = await createFixture(context, 'invalid-recovery-smoke');
  await assert.rejects(
    freezeAjunRuntimeRelease({
      repoRoot:invalidRecoverySmokeRepo,
      verify:true,
      smokeRunner:async ({ gitHead }) => startupEvidence(gitHead),
      recoverySmokeRunner:async ({ gitHead, payloadHash }) => ({
        ...recoveryStartupEvidence(gitHead, payloadHash),
        writeHttpStatus:200,
      }),
      runCommand:async () => {},
    }),
    /recovery startup smoke证据/,
  );

  const tamperedRecoveryRepo = await createFixture(context, 'tampered-recovery-evidence');
  const tamperedRecoveryRelease = await verifiedFixtureRelease(tamperedRecoveryRepo);
  const rewrittenRecoveryRelease = await rewriteManifestContract(
    tamperedRecoveryRelease.releaseRoot,
    (manifest) => {
      manifest.verification.recoveryStartupSmoke.writeError = 'write_allowed';
    },
  );
  await assert.rejects(
    validateAjunRuntimeRelease(
      rewrittenRecoveryRelease.releaseRoot,
      rewrittenRecoveryRelease.releaseHash,
    ),
    /recovery startup smoke证据/,
  );
});

test('launchd计划强绑clean源码来源，cutover启用技术修复而rollback默认失败关闭', async (context) => {
  const oldRepo = await createFixture(context, 'old');
  const newRepo = await createFixture(context, 'new');
  await fs.writeFile(path.join(newRepo, 'apps/ajun-runtime/src/local.js'), 'export const value = 2;\n');
  await commitFixture(newRepo, 'new release');
  const oldRelease = await verifiedFixtureRelease(oldRepo);
  const newRelease = await verifiedFixtureRelease(newRepo);
  const externalRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-external-state-')),
  );
  context.after(() => fs.rm(externalRoot, { recursive:true, force:true }));
  const sourceProjectRoot = path.join(externalRoot, 'new-source');
  const rollbackSourceProjectRoot = path.join(externalRoot, 'old-source');
  await cloneSourceRoot(newRepo, sourceProjectRoot);
  await cloneSourceRoot(oldRepo, rollbackSourceProjectRoot);
  const dataDir = path.join(externalRoot, 'data');
  const contentWorkspaceDir = path.join(externalRoot, 'content');
  const hermesProfileRoot = path.join(externalRoot, 'hermes');
  const privateDir = path.join(externalRoot, 'private');
  const autoWorkRoot = path.join(externalRoot, 'auto-work');
  const xiaodArtifactRoot = path.join(externalRoot, 'xiaod-artifacts');
  const paperclipRepairWorktreeParent = path.join(externalRoot, 'repair-worktrees');
  await Promise.all([
    fs.mkdir(dataDir),
    fs.mkdir(contentWorkspaceDir),
    fs.mkdir(hermesProfileRoot),
    fs.mkdir(privateDir),
    fs.mkdir(autoWorkRoot),
    fs.mkdir(xiaodArtifactRoot),
    fs.mkdir(paperclipRepairWorktreeParent),
  ]);

  const baseInput = {
    oldReleaseRoot:oldRelease.releaseRoot,
    newReleaseRoot:newRelease.releaseRoot,
    sourceProjectRoot,
    dataDir,
    taskStoreMode:'sqlite',
    contentWorkspaceDir,
    hermesProfileRoot,
    privateDir,
    autoWorkRoot,
    xiaodArtifactRoot,
    paperclipRepairWorktreeParent,
    nodePath:process.execPath,
  };
  const plan = await buildLaunchdCutoverPlan(baseInput);

  assert.equal(plan.mode, 'plan_only');
  assert.equal(plan.executesChanges, false);
  assert.equal(plan.launchd.plistMutationAllowed, false);
  assert.equal(plan.cutover.newRelease.releaseHash, newRelease.releaseHash);
  assert.equal(plan.rollback.targetRelease.releaseHash, oldRelease.releaseHash);
  assert.match(plan.cutover.requiredConfirmation, /^I_ACCEPT_AJUN_RUNTIME_CUTOVER_/);
  assert.match(plan.rollback.requiredConfirmation, /^I_ACCEPT_AJUN_RUNTIME_ROLLBACK_/);
  assert.equal(plan.cutover.status, 'blocked');
  assert.equal(plan.cutover.launchable, false);
  assert.equal(plan.cutover.programArguments, null);
  assert.equal(plan.cutover.environment, null);
  assert.match(plan.cutover.blockedReason, /rollback源码根/);
  assert.equal(plan.cutover.technicalRepair.status, 'candidate_only');
  assert.equal(plan.cutover.technicalRepair.readiness, 'blocked');
  assert.equal(plan.cutover.technicalRepair.provenanceMatched, true);
  assert.match(plan.cutover.knownCapabilityRestrictions.join('\n'), /候选绑定/);
  assert.deepEqual(plan.cutover.requiredPassthroughEnvironment, []);
  assert.deepEqual(plan.cutover.requiredLoopbackEnvironment, []);
  assert.equal(plan.cutover.standardOutPath, null);
  assert.equal(plan.cutover.standardErrorPath, null);
  assert.equal(plan.rollback.status, 'blocked');
  assert.equal(plan.rollback.launchable, false);
  assert.equal(plan.rollback.programArguments, null);
  assert.equal(plan.rollback.environment, null);
  assert.equal(plan.rollback.technicalRepair.status, 'disabled');
  assert.match(plan.rollback.technicalRepair.reason, /禁止复用新版本源码根/);

  const exactWithoutAttestation = await buildLaunchdCutoverPlan({
    ...baseInput,
    rollbackSourceProjectRoot,
  });
  assert.equal(exactWithoutAttestation.cutover.status, 'blocked');
  assert.equal(exactWithoutAttestation.rollback.status, 'blocked');
  assert.match(exactWithoutAttestation.cutover.blockedReason, /内置可信OS|拒绝调用方/);
  assert.equal(exactWithoutAttestation.rollback.exactPreviousLive, false);

  let injectedCollectorCalled = false;
  const injectedAttestations = await buildLaunchdCutoverPlan({
    ...baseInput,
    rollbackSourceProjectRoot,
    liveAttestationCollector:async () => {
      injectedCollectorCalled = true;
      return { forged:true };
    },
    stateRollbackAttestationCollector:async () => {
      injectedCollectorCalled = true;
      return { forged:true };
    },
  });
  assert.equal(injectedCollectorCalled, false);
  assert.equal(injectedAttestations.cutover.status, 'blocked');
  assert.equal(injectedAttestations.cutover.launchable, false);
  assert.equal(injectedAttestations.cutover.programArguments, null);
  assert.equal(injectedAttestations.cutover.workingDirectory, null);
  assert.equal(injectedAttestations.cutover.environment, null);
  assert.match(injectedAttestations.cutover.blockedReason, /内置可信OS|拒绝调用方/);
  assert.equal(injectedAttestations.rollback.status, 'blocked');
  assert.equal(injectedAttestations.rollback.launchable, false);
  assert.equal(injectedAttestations.rollback.programArguments, null);
  assert.equal(injectedAttestations.rollback.workingDirectory, null);
  assert.equal(injectedAttestations.rollback.environment, null);
  assert.equal(injectedAttestations.rollback.exactPreviousLive, false);
  assert.equal(injectedAttestations.rollback.stateRollbackReady, false);
  assert.equal(injectedAttestations.rollback.currentLiveAttestation, null);
  assert.equal(injectedAttestations.rollback.stateRollbackAttestation, null);
  assert.equal(injectedAttestations.rollback.technicalRepair.status, 'disabled');

  let degradedCollectorCalled = false;
  const degradedFallback = await buildLaunchdCutoverPlan({
    ...baseInput,
    rollbackMode:'verified_degraded_fallback',
    liveAttestationCollector:async () => {
      degradedCollectorCalled = true;
      return { forged:true };
    },
    stateRollbackAttestationCollector:async () => {
      degradedCollectorCalled = true;
      return { forged:true };
    },
  });
  assert.equal(degradedCollectorCalled, false);
  assert.equal(degradedFallback.cutover.status, 'ready');
  assert.equal(degradedFallback.cutover.launchable, true);
  assert.deepEqual(
    degradedFallback.cutover.programArguments,
    [process.execPath, path.join(newRelease.releaseRoot, 'apps/ajun-runtime/src/server.js')],
  );
  assert.equal(
    degradedFallback.cutover.workingDirectory,
    path.join(newRelease.releaseRoot, 'apps/ajun-runtime'),
  );
  assert.equal(
    degradedFallback.cutover.environment?.AGENT_ARMY_SOURCE_PROJECT_ROOT,
    sourceProjectRoot,
  );
  assert.equal(degradedFallback.cutover.environment?.AGENT_ARMY_TASK_STORE, 'sqlite');
  assert.equal(degradedFallback.cutover.blockedReason, null);
  assert.equal(degradedFallback.rollback.status, 'ready');
  assert.equal(degradedFallback.rollback.launchable, true);
  assert.deepEqual(
    degradedFallback.rollback.programArguments,
    [process.execPath, path.join(newRelease.releaseRoot, 'apps/ajun-runtime/src/recovery-server.js')],
  );
  assert.equal(
    degradedFallback.rollback.workingDirectory,
    path.join(newRelease.releaseRoot, 'apps/ajun-runtime'),
  );
  assert.equal(degradedFallback.rollback.environment?.PORT, '4321');
  assert.match(
    degradedFallback.rollback.requiredConfirmation,
    /^I_ACCEPT_AJUN_RUNTIME_RECOVERY_/,
  );
  assert.equal(degradedFallback.rollback.basis, 'verified_degraded_fallback');
  assert.equal(degradedFallback.rollback.exactPreviousLive, false);
  assert.equal(degradedFallback.rollback.operatingMode, 'local_recovery_only');
  assert.equal(degradedFallback.rollback.stateIsolation, 'no_external_state_access');
  assert.equal(degradedFallback.rollback.stateRollbackReady, true);
  assert.equal(degradedFallback.rollback.stateRollbackAttestation?.status, 'passed');
  assert.equal(degradedFallback.rollback.recoveryEntrypointCandidatePresent, true);
  assert.equal(degradedFallback.rollback.recoveryLaunchBlockedReason, null);
  assert.equal(degradedFallback.rollback.technicalRepair.status, 'disabled');
  assert.equal(
    degradedFallback.rollback.targetRelease.releaseHash,
    newRelease.releaseHash,
  );
  assert.equal(
    degradedFallback.rollback.historicalReferenceRelease.releaseHash,
    oldRelease.releaseHash,
  );
  assert.equal(
    degradedFallback.rollback.recoveryEntrypoint.path,
    path.join(newRelease.releaseRoot, 'apps/ajun-runtime/src/recovery-server.js'),
  );
  assert.deepEqual(degradedFallback.rollback.requiredPassthroughEnvironment, []);
  assert.deepEqual(degradedFallback.rollback.requiredLoopbackEnvironment, []);
  assert.match(
    degradedFallback.rollback.knownCapabilityRestrictions.join('\n'),
    /不声称恢复当前live内存中的精确旧代码/,
  );
  assert.doesNotMatch(
    degradedFallback.rollback.knownCapabilityRestrictions.join('\n'),
    /旧release.*worktree|旧release.*源码根/,
  );
  assert.match(degradedFallback.rollback.instruction, /降级回滚启动新release内的独立只读recovery entrypoint/);
  assert.doesNotMatch(degradedFallback.rollback.instruction, /旧release|worktree/);

  await assert.rejects(
    buildLaunchdCutoverPlan({
      ...baseInput,
      rollbackSourceProjectRoot,
      rollbackMode:'unsafe_guess',
    }),
    /rollbackMode只允许/,
  );

  await assert.rejects(
    buildLaunchdCutoverPlan({
      ...baseInput,
      taskStoreMode:'memory',
    }),
    /taskStoreMode只允许/,
  );

  await assert.rejects(
    buildLaunchdCutoverPlan({
      ...baseInput,
      dataDir:path.join(newRelease.releaseRoot, 'apps/ajun-runtime/data'),
    }),
    /祖先|必须外置于release/,
  );

  await assert.rejects(
    buildLaunchdCutoverPlan({
      ...baseInput,
      dataDir:path.dirname(newRelease.releaseRoot),
    }),
    /必须外置于release/,
  );

  await assert.rejects(
    buildLaunchdCutoverPlan({
      ...baseInput,
      nodePath:path.join(externalRoot, 'missing-node'),
    }),
    /nodePath必须是存在的普通可执行文件/,
  );

  const incompatibleNode = path.join(externalRoot, 'incompatible-node');
  await fs.writeFile(
    incompatibleNode,
    '#!/bin/sh\nprintf \'{"node":"v0.0.0","modules":"0","platform":"other","arch":"other"}\\n\'\n',
    { mode:0o755 },
  );
  await assert.rejects(
    buildLaunchdCutoverPlan({
      ...baseInput,
      nodePath:incompatibleNode,
    }),
    /ABI与release不兼容/,
  );

  const symlinkParent = path.join(externalRoot, 'linked-release');
  await fs.symlink(newRelease.releaseRoot, symlinkParent);
  await assert.rejects(
    buildLaunchdCutoverPlan({
      ...baseInput,
      dataDir:path.join(symlinkParent, 'future-data'),
    }),
    /祖先|必须外置于release/,
  );

  await assert.rejects(
    buildLaunchdCutoverPlan({
      ...baseInput,
      sourceProjectRoot:rollbackSourceProjectRoot,
    }),
    /HEAD与release来源不匹配/,
  );

  const sourceLink = path.join(externalRoot, 'source-link');
  await fs.symlink(sourceProjectRoot, sourceLink);
  await assert.rejects(
    buildLaunchdCutoverPlan({
      ...baseInput,
      sourceProjectRoot:sourceLink,
    }),
    /规范真实目录|符号链接/,
  );

  const sourceAncestorLink = path.join(externalRoot, 'source-parent-link');
  await fs.symlink(externalRoot, sourceAncestorLink);
  await assert.rejects(
    buildLaunchdCutoverPlan({
      ...baseInput,
      sourceProjectRoot:path.join(sourceAncestorLink, 'new-source'),
    }),
    /规范真实目录|符号链接/,
  );

  const bareSource = path.join(externalRoot, 'bare-source.git');
  await execFile('git', ['init', '--bare', bareSource], { cwd:externalRoot });
  await assert.rejects(
    buildLaunchdCutoverPlan({
      ...baseInput,
      sourceProjectRoot:bareSource,
    }),
    /Git|工作树|\.git/,
  );

  await fs.writeFile(path.join(sourceProjectRoot, 'dirty.txt'), 'dirty\n');
  await assert.rejects(
    buildLaunchdCutoverPlan(baseInput),
    /必须是干净|dirty|clean/,
  );
  await fs.rm(path.join(sourceProjectRoot, 'dirty.txt'));

  await assert.rejects(
    buildLaunchdCutoverPlan({
      ...baseInput,
      dataDir:path.join(sourceProjectRoot, 'nested-data'),
    }),
    /不能与 AGENT_ARMY_DATA_DIR 重叠|不得重叠/,
  );

  await assert.rejects(
    buildLaunchdCutoverPlan({
      ...baseInput,
      sourceProjectRoot:undefined,
    }),
    /必须提供AGENT_ARMY_SOURCE_PROJECT_ROOT/,
  );
});

test('validator兼容不含日志的历史v1排除契约，但拒绝任意漂移', async (context) => {
  const legacyRepo = await createFixture(context, 'legacy-v1-exclusions');
  const currentRelease = await verifiedFixtureRelease(legacyRepo);
  const legacyRelease = await rewriteManifestContract(currentRelease.releaseRoot, (manifest) => {
    manifest.sourceExclusions = [
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
    manifest.verification.commands = [
      {
        cwd:'apps/ajun-runtime',
        command:'node',
        args:[
          '--test',
          'test/production-control-plane-boundary.test.js',
          'test/m5-server-publisher-composition.test.js',
        ],
        evidenceLayer:'source_test',
      },
      {
        cwd:'integrations/paperclip/m5-content-pipeline',
        command:'npm',
        args:['test'],
        evidenceLayer:'source_test',
      },
      {
        cwd:'integrations/paperclip/plugins/content-autonomy',
        command:'npm',
        args:['run', 'check'],
        evidenceLayer:'source_test',
      },
      {
        cwd:'integrations/publishing/m5-publisher-gateway',
        command:'npm',
        args:['run', 'check'],
        evidenceLayer:'source_test',
      },
    ];
  });
  const validated = await validateAjunRuntimeRelease(
    legacyRelease.releaseRoot,
    legacyRelease.releaseHash,
  );
  assert.equal(validated.releaseHash, legacyRelease.releaseHash);
  assert.equal(validated.manifest.schemaVersion, 1);
  assert.equal(
    validated.manifest.entries.some(({ path:entryPath }) =>
      entryPath.toLowerCase().endsWith('.log')),
    false,
  );

  const historicalRepo = await createFixture(context, 'historical-v1-no-recovery-smoke');
  const currentHistoricalRelease = await verifiedFixtureRelease(historicalRepo);
  const historicalRelease = await rewriteManifestContract(
    currentHistoricalRelease.releaseRoot,
    async (manifest) => {
      await fs.rm(path.join(
        currentHistoricalRelease.releaseRoot,
        'apps/ajun-runtime/src/recovery-server.js',
      ));
      manifest.entries = manifest.entries.filter(
        ({ path:entryPath }) => entryPath !== 'apps/ajun-runtime/src/recovery-server.js',
      );
      const payloadHasher = crypto.createHash('sha256');
      for (const entry of manifest.entries) {
        payloadHasher.update(`${JSON.stringify(entry)}\n`);
      }
      manifest.payloadHash = payloadHasher.digest('hex');
      manifest.workingTreeSnapshot = manifest.payloadHash;
      delete manifest.verification.recoveryStartupSmoke;
    },
  );
  const historicalValidated = await validateAjunRuntimeRelease(
    historicalRelease.releaseRoot,
    historicalRelease.releaseHash,
  );
  assert.equal(historicalValidated.manifest.schemaVersion, 1);
  assert.equal(
    Object.hasOwn(historicalValidated.manifest.verification, 'recoveryStartupSmoke'),
    false,
  );

  const driftRepo = await createFixture(context, 'drifted-v1-exclusions');
  const driftRelease = await verifiedFixtureRelease(driftRepo);
  const rewrittenDrift = await rewriteManifestContract(driftRelease.releaseRoot, (manifest) => {
    manifest.sourceExclusions = ['**/made-up-exclusion/**'];
  });
  await assert.rejects(
    validateAjunRuntimeRelease(rewrittenDrift.releaseRoot, rewrittenDrift.releaseHash),
    /sourceExclusions发生漂移/,
  );
});

test('plan拒绝dirty来源release和未做真实启动验收的release', async (context) => {
  const oldRepo = await createFixture(context, 'provenance-old');
  const oldRelease = await verifiedFixtureRelease(oldRepo);
  const dirtyRepo = await createFixture(context, 'provenance-dirty');
  await fs.writeFile(
    path.join(dirtyRepo, 'apps/ajun-runtime/src/local.js'),
    'export const dirtySnapshot = true;\n',
  );
  const dirtyRelease = await verifiedFixtureRelease(dirtyRepo);
  const unverifiedRepo = await createFixture(context, 'provenance-unverified');
  await fs.writeFile(
    path.join(unverifiedRepo, 'apps/ajun-runtime/src/local.js'),
    'export const unverified = true;\n',
  );
  await commitFixture(unverifiedRepo, 'unverified release');
  const unverifiedRelease = await freezeAjunRuntimeRelease({ repoRoot:unverifiedRepo });

  const externalRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-provenance-state-')),
  );
  context.after(() => fs.rm(externalRoot, { recursive:true, force:true }));
  const dirtySource = path.join(externalRoot, 'dirty-source');
  const unverifiedSource = path.join(externalRoot, 'unverified-source');
  await cloneSourceRoot(dirtyRepo, dirtySource);
  await cloneSourceRoot(unverifiedRepo, unverifiedSource);
  const external = await createPlanExternalDirectories(externalRoot);
  const base = {
    oldReleaseRoot:oldRelease.releaseRoot,
    ...external,
    nodePath:process.execPath,
  };

  await assert.rejects(
    buildLaunchdCutoverPlan({
      ...base,
      newReleaseRoot:dirtyRelease.releaseRoot,
      sourceProjectRoot:dirtySource,
    }),
    /release来源必须是clean/,
  );
  await assert.rejects(
    buildLaunchdCutoverPlan({
      ...base,
      newReleaseRoot:unverifiedRelease.releaseRoot,
      sourceProjectRoot:unverifiedSource,
    }),
    /必须先通过冻结包真实启动验证/,
  );
});

async function createFixture(context, suffix) {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), `ajun-release-${suffix}-`));
  const recoveryServerSource = await fs.readFile(
    new URL('../src/recovery-server.js', import.meta.url),
    'utf8',
  );
  context.after(async () => {
    await makeWritable(repoRoot);
    await fs.rm(repoRoot, { recursive:true, force:true });
  });
  const requiredDirectories = [
    'apps/ajun-runtime/src',
    'apps/ajun-runtime/public',
    'node_modules/pkg',
    'node_modules/.cache',
    'apps/ajun-runtime/data',
    'apps/ajun-runtime/test',
    'apps/ajun-runtime/scripts',
    'agents/ajun',
    'integrations/hermes/profiles',
    'integrations/paperclip/m5-content-pipeline/config',
    'integrations/paperclip/m5-content-pipeline/src',
    'integrations/paperclip/m5-content-pipeline/node_modules/zod',
    'integrations/paperclip/plugins/content-autonomy/src',
    'integrations/paperclip/plugins/content-autonomy/node_modules/plugin-sdk',
    'integrations/publishing/m5-publisher-gateway/src',
    'integrations/access',
    'integrations/boom-monitor',
    'integrations/m5-kernel/src',
    'packages/m5-contracts/src',
    'packages/paperclip-client/src',
  ];
  await Promise.all(requiredDirectories.map((relative) =>
    fs.mkdir(path.join(repoRoot, relative), { recursive:true })));

  const files = new Map([
    ['.gitignore', '/apps/ajun-runtime/data/releases/\n'],
    ['apps/ajun-runtime/package.json', '{"name":"ajun-runtime","type":"module","dependencies":{"pkg":"1.0.0"}}\n'],
    ['apps/ajun-runtime/package-lock.json', '{"lockfileVersion":3}\n'],
    ['apps/ajun-runtime/src/server.js', "import './local.js';\n"],
    ['apps/ajun-runtime/src/recovery-server.js', recoveryServerSource],
    ['apps/ajun-runtime/src/local.js', "import '@agent-army/m5-content-pipeline';\nimport '@agent-army/m5-kernel';\nimport '@agent-army/paperclip-content-autonomy/signed-budget-ticket';\nimport '@agent-army/m5-publisher-gateway';\nimport 'ajun-common-access/content-acquisition-center';\nimport '@agent-army/boom-monitor';\nimport '@agent-army/m5-contracts';\nimport '@agent-army/paperclip-client';\nimport 'pkg';\n"],
    ['apps/ajun-runtime/src/hermes-oneshot-policy.js', 'export const policy = true;\n'],
    ['apps/ajun-runtime/src/m5-work-product-integrity.js', 'export const integrity = true;\n'],
    ['apps/ajun-runtime/src/task-service.js', 'export const tasks = true;\n'],
    ['apps/ajun-runtime/src/runtime.log', 'runtime log must not ship\n'],
    ['apps/ajun-runtime/public/index.html', '<!doctype html>\n'],
    ['node_modules/pkg/package.json', '{"name":"pkg","type":"module","exports":{"import":"./index.js"}}\n'],
    ['node_modules/pkg/index.js', 'export default true;\n'],
    ['node_modules/.cache/generated.log', 'generated\n'],
    ['apps/ajun-runtime/data/runtime.json', '{}\n'],
    ['apps/ajun-runtime/test/server.test.js', 'throw new Error("not runtime");\n'],
    ['apps/ajun-runtime/test/task-service.test.js', '// source-only verification\n'],
    ['apps/ajun-runtime/test/production-control-plane-boundary.test.js', '// fixture\n'],
    ['apps/ajun-runtime/test/m5-server-publisher-composition.test.js', '// fixture\n'],
    ['apps/ajun-runtime/scripts/not-runtime.mjs', 'throw new Error("not runtime");\n'],
    ['agents/ajun/manifest.json', '{"agentId":"ajun","promptRef":"agents/ajun/prompts/system.md","runtimeProfileRef":"integrations/hermes/profiles/ajun.profile.json"}\n'],
    ['agents/ajun/prompts/system.md', '# A君\n'],
    ['agents/ajun/prompts/task-guides/check.md', '# 检查\n'],
    ['integrations/hermes/profiles/ajun.profile.json', '{"profileId":"ajun"}\n'],
    ['integrations/paperclip/m5-content-pipeline/package.json', '{"name":"@agent-army/m5-content-pipeline","type":"module","exports":"./src/index.js"}\n'],
    ['integrations/paperclip/m5-content-pipeline/package-lock.json', '{"lockfileVersion":3}\n'],
    ['integrations/paperclip/m5-content-pipeline/config/definition.json', '{"key":"fixture"}\n'],
    ['integrations/paperclip/m5-content-pipeline/src/index.js', 'export const pipeline = true;\n'],
    ['integrations/paperclip/m5-content-pipeline/node_modules/zod/package.json', '{"name":"zod"}\n'],
    ['integrations/paperclip/m5-content-pipeline/test/pipeline.test.js', '// fixture\n'],
    ['integrations/paperclip/m5-content-pipeline/test/controller-run-jwt-cutover.test.js', '// fixture\n'],
    ['integrations/paperclip/plugins/content-autonomy/package.json', '{"name":"@agent-army/paperclip-content-autonomy","type":"module","exports":{"./signed-budget-ticket":"./src/signed-budget-ticket.js"},"scripts":{"check":"true"}}\n'],
    ['integrations/paperclip/plugins/content-autonomy/package-lock.json', '{"lockfileVersion":3}\n'],
    ['integrations/paperclip/plugins/content-autonomy/src/signed-budget-ticket.js', 'export const ticket = true;\n'],
    ['integrations/paperclip/plugins/content-autonomy/node_modules/plugin-sdk/package.json', '{"name":"plugin-sdk"}\n'],
    ['integrations/publishing/m5-publisher-gateway/package.json', '{"name":"@agent-army/m5-publisher-gateway","type":"module","exports":"./src/index.js","scripts":{"check":"true"}}\n'],
    ['integrations/publishing/m5-publisher-gateway/src/index.js', 'export const publisher = true;\n'],
    ['integrations/access/package.json', '{"name":"ajun-common-access","type":"module","exports":{"./content-acquisition-center":"./content-acquisition-center.js"}}\n'],
    ['integrations/access/content-acquisition-center.js', 'export const access = true;\n'],
    ['integrations/access/connection-broker.js', 'export const broker = true;\n'],
    ['integrations/boom-monitor/ajun-intake.js', 'export const boom = true;\n'],
    ['integrations/boom-monitor/package.json', '{"name":"@agent-army/boom-monitor","type":"module","exports":"./ajun-intake.js"}\n'],
    ['integrations/m5-kernel/package.json', '{"name":"@agent-army/m5-kernel","type":"module","exports":"./src/index.js","scripts":{"test":"true"}}\n'],
    ['integrations/m5-kernel/src/index.js', 'export const kernel = true;\n'],
    ['packages/m5-contracts/package.json', '{"name":"@agent-army/m5-contracts","type":"module","exports":"./src/index.js","scripts":{"check":"true"}}\n'],
    ['packages/m5-contracts/src/index.js', 'export const contracts = true;\n'],
    ['packages/paperclip-client/package.json', '{"name":"@agent-army/paperclip-client","type":"module","exports":"./src/index.js","scripts":{"test":"true"}}\n'],
    ['packages/paperclip-client/src/index.js', 'export const client = true;\n'],
  ]);
  for (const [relative, content] of files) {
    const absolute = path.join(repoRoot, relative);
    await fs.mkdir(path.dirname(absolute), { recursive:true });
    await fs.writeFile(absolute, content);
  }
  await execFile('git', ['init'], { cwd:repoRoot });
  await commitFixture(repoRoot, 'fixture');
  return repoRoot;
}

async function createPlanExternalDirectories(root) {
  const result = {
    dataDir:path.join(root, 'data'),
    contentWorkspaceDir:path.join(root, 'content'),
    hermesProfileRoot:path.join(root, 'hermes'),
    privateDir:path.join(root, 'private'),
    autoWorkRoot:path.join(root, 'auto-work'),
    xiaodArtifactRoot:path.join(root, 'xiaod-artifacts'),
    paperclipRepairWorktreeParent:path.join(root, 'repair-worktrees'),
  };
  await Promise.all(
    Object.values(result).map((directory) => fs.mkdir(directory)),
  );
  return result;
}

async function commitFixture(repoRoot, message) {
  await execFile('git', ['add', '-A'], { cwd:repoRoot });
  await execFile(
    'git',
    [
      '-c',
      'user.name=fixture',
      '-c',
      'user.email=fixture@example.com',
      'commit',
      '-m',
      message,
    ],
    { cwd:repoRoot },
  );
}

async function cloneSourceRoot(repoRoot, destination) {
  await execFile(
    'git',
    ['clone', '--quiet', '--no-hardlinks', repoRoot, destination],
    { cwd:path.dirname(destination) },
  );
  return fs.realpath(destination);
}

async function verifiedFixtureRelease(repoRoot) {
  return freezeAjunRuntimeRelease({
    repoRoot,
    verify:true,
    smokeRunner:async ({ gitHead }) => startupEvidence(gitHead),
    runCommand:async () => {},
  });
}

function startupEvidence(gitHead) {
  return {
    status:'passed',
    evidenceLayer:'frozen_release_startup',
    entrypoint:'apps/ajun-runtime/src/server.js',
    host:'127.0.0.1',
    portMode:'ephemeral_loopback',
    endpoint:'/api/overview',
    httpStatus:200,
    responseContract:'overview.tasks-array',
    externalStateIsolation:'temporary_directories',
    externalEntrypoints:'disabled',
    sourceProjectRoot:'temporary_clean_git_worktree',
    sourceGitHead:gitHead,
    termination:{
      requestedSignal:'SIGTERM',
      forced:false,
      exitConfirmed:true,
    },
  };
}

function recoveryStartupEvidence(gitHead, payloadHash) {
  const smokeIdentityHash = crypto.createHash('sha256')
    .update(stableCanonicalForTest({
      kind:'agent-army/frozen-recovery-smoke-identity',
      gitHead,
      payloadHash,
    }))
    .digest('hex');
  return {
    status:'passed',
    evidenceLayer:'frozen_recovery_startup',
    entrypoint:'apps/ajun-runtime/src/recovery-server.js',
    host:'127.0.0.1',
    portMode:'ephemeral_loopback',
    healthEndpoint:'/api/health',
    healthHttpStatus:200,
    statusEndpoint:'/api/recovery/status',
    statusHttpStatus:200,
    pageEndpoint:'/',
    pageHttpStatus:200,
    unknownGetEndpoint:'/api/overview',
    unknownGetHttpStatus:404,
    writeMethod:'POST',
    writeEndpoint:'/api/overview',
    writeHttpStatus:503,
    writeError:'recovery_mode_read_only',
    healthContract:'local-recovery-only-v1',
    identityMode:'payload-and-git-bound-smoke',
    smokeIdentityHash,
    payloadHash,
    mode:'local_recovery_only',
    pidMatched:true,
    bootIdPresent:true,
    startedAtValid:true,
    externalEffects:false,
    writableRoutes:false,
    environmentMode:'clean_allowlist',
    environmentKeys:[
      'AJUN_HOST',
      'AJUN_RECOVERY_PAYLOAD_HASH',
      'AJUN_RECOVERY_REASON',
      'AJUN_RECOVERY_RELEASE_HASH',
      'CI',
      'HOME',
      'LANG',
      'LC_ALL',
      'PORT',
      'TMPDIR',
    ],
    formalStateEnvironmentKeys:[],
    externalStateAccess:'none',
    termination:{
      requestedSignal:'SIGTERM',
      forced:false,
      exitConfirmed:true,
    },
  };
}

async function rewriteManifestContract(releaseRoot, mutate) {
  await makeWritable(releaseRoot);
  const manifestPath = path.join(releaseRoot, 'release-manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  await mutate(manifest);
  delete manifest.releaseHash;
  const releaseHash = crypto.createHash('sha256')
    .update(stableCanonicalForTest(manifest))
    .digest('hex');
  manifest.releaseHash = releaseHash;
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode:0o444,
  });
  await makeReadonly(releaseRoot);
  const renamedRoot = path.join(
    path.dirname(releaseRoot),
    `${AJUN_RELEASE_PREFIX}${releaseHash}`,
  );
  await fs.rename(releaseRoot, renamedRoot);
  return { releaseRoot:renamedRoot, releaseHash };
}

function stableCanonicalForTest(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableCanonicalForTest).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort((left, right) =>
      Buffer.from(left).compare(Buffer.from(right))).map((key) =>
      `${JSON.stringify(key)}:${stableCanonicalForTest(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function makeReadonly(root) {
  const directories = [root];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const name of await fs.readdir(directory)) {
      const absolute = path.join(directory, name);
      const stat = await fs.lstat(absolute);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        directories.push(absolute);
        pending.push(absolute);
      } else if (stat.isFile()) {
        await fs.chmod(absolute, stat.mode & 0o111 ? 0o555 : 0o444);
      }
    }
  }
  directories.sort((left, right) => right.length - left.length);
  for (const directory of directories) await fs.chmod(directory, 0o555);
}

async function makeWritable(root) {
  const stat = await fs.lstat(root).catch(() => null);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return;
  await fs.chmod(root, 0o700);
  for (const name of await fs.readdir(root)) {
    const absolute = path.join(root, name);
    const child = await fs.lstat(absolute);
    if (child.isDirectory() && !child.isSymbolicLink()) {
      await makeWritable(absolute);
    } else if (child.isFile()) {
      await fs.chmod(absolute, 0o600);
    }
  }
}

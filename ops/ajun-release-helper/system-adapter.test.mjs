import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AjunReleaseSystemAdapter } from './system-adapter.mjs';

test('只读检查识别 main 上的干净新提交', async (context) => {
  const fixture = await createFixture(context);
  const result = await fixture.adapter.inspect();
  assert.equal(result.canPublish, true);
  assert.equal(result.updateAvailable, true);
  assert.equal(result.current.gitHead, fixture.oldHead);
  assert.equal(result.candidate.gitHead, fixture.newHead);
  assert.equal(result.candidate.committed, true);
  assert.equal(result.candidate.validation.status, 'not_checked');
  assert.equal(result.candidate.publishable, true);
  assert.equal(result.candidate.undeployed, true);
  assert.equal(result.current.verification.checks.api, true);
  assert.match(result.message, /发现新版/);
});

test('未提交改动阻止发布且不隐藏原因', async (context) => {
  const fixture = await createFixture(context, { dirty:' M apps/ajun-runtime/src/server.ts' });
  const result = await fixture.adapter.inspect();
  assert.equal(result.canPublish, false);
  assert.match(result.message, /未提交改动/);
});

test('线上身份未核对时仍返回当前与候选真相，但阻止发布', async (context) => {
  const fixture = await createFixture(context);
  fixture.adapter.verifyLive = async () => { throw new Error('transient detail must stay private'); };
  const result = await fixture.adapter.inspect();
  assert.equal(result.canPublish, false);
  assert.equal(result.current.gitHead, fixture.oldHead);
  assert.equal(result.candidate.gitHead, fixture.newHead);
  assert.equal(result.current.verification.checks.api, false);
  assert.match(result.message, /线上运行身份未通过核对/);
  assert.doesNotMatch(result.message, /transient detail/);
});

test('非 main 分支和相同版本都不能从页面发布', async (context) => {
  const branchFixture = await createFixture(context, { branch:'codex/test' });
  assert.match((await branchFixture.adapter.inspect()).message, /不在 main/);
  const currentFixture = await createFixture(context, { newHead:branchFixture.oldHead });
  const current = await currentFixture.adapter.inspect();
  assert.equal(current.updateAvailable, false);
  assert.match(current.message, /已经是最新版/);
});

test('当前启动目录缺少可信 manifest 时失败关闭', async (context) => {
  const fixture = await createFixture(context);
  await fs.chmod(fixture.releaseRoot, 0o755);
  await fs.chmod(path.join(fixture.releaseRoot, 'release-manifest.json'), 0o644);
  await fs.writeFile(path.join(fixture.releaseRoot, 'release-manifest.json'), '{}');
  await fs.chmod(fixture.releaseRoot, 0o555);
  await assert.rejects(() => fixture.adapter.inspect(), /manifest/);
});

test('上线核对必须同时证明 launchd PID 就是 4321 listener、cwd、argv、release/payload/Git 和控制台 API', async (context) => {
  const fixture = await createFixture(context, { realLiveVerification:true });
  const expected = {
    releaseHash:fixture.oldReleaseHash,
    payloadHash:fixture.oldPayloadHash,
    gitHead:fixture.oldHead,
    releaseRoot:fixture.releaseRoot,
  };
  const workingDirectory = path.join(fixture.releaseRoot, 'apps', 'ajun-runtime');
  fixture.adapter.runCommand = async (command, args) => {
    if (command === 'launchctl') return { code:0, stdout:`pid = 4242\nworking directory = ${workingDirectory}\n`, stderr:'' };
    if (command === 'lsof') return { code:0, stdout:`p4242\nfcwd\nn${workingDirectory}\n`, stderr:'' };
    if (command === 'ps') return { code:0, stdout:`node ${path.join(workingDirectory, 'src', 'server.ts')}\n`, stderr:'' };
    throw new Error(`unexpected command ${command} ${args.join(' ')}`);
  };
  fixture.adapter.fetchFn = async () => ({ ok:true, status:200, json:async () => ({ schemaVersion:'agent.army/console-overview/v2' }) });
  fixture.adapter.listenerPidsForPort = async () => [4242];

  const proof = await fixture.adapter.verifyLive(expected);
  assert.equal(proof.pid, 4242);
  assert.deepEqual(proof.checks, {
    pid:true, listener:true, cwd:true, argv:true, releaseHash:true, payloadHash:true, gitHead:true, api:true, rollbackAvailable:false,
  });

  fixture.adapter.runCommand = async (command, args) => {
    if (command === 'launchctl') return { code:0, stdout:`pid = 4242\nworking directory = ${workingDirectory}\n`, stderr:'' };
    if (command === 'lsof') return { code:0, stdout:`p4242\nfcwd\nn${workingDirectory}\n`, stderr:'' };
    if (command === 'ps') return { code:0, stdout:'node /wrong/server.ts\n', stderr:'' };
    throw new Error(`unexpected command ${command} ${args.join(' ')}`);
  };
  await assert.rejects(() => fixture.adapter.verifyLive(expected), /启动参数/);
  fixture.adapter.listenerPidsForPort = async () => [9999];
  await assert.rejects(() => fixture.adapter.verifyLive(expected), /listener PID/);
});

test('发布严格按准备、验证、冻结、切换和线上回读推进', async (context) => {
  const fixture = await createFixture(context);
  const stages = [];
  const history = [];
  const candidate = { releaseHash:'release-new', payloadHash:'payload-new', gitHead:fixture.newHead, releaseRoot:path.join(fixture.root, 'deploy-new') };
  fixture.adapter.readCurrentRelease = async () => ({ releaseHash:'release-old', payloadHash:'payload-old', gitHead:fixture.oldHead, releaseRoot:fixture.releaseRoot });
  fixture.adapter.prepareCandidateSource = async () => path.join(fixture.root, 'source-new');
  fixture.adapter.runCommand = async (command) => {
    assert.equal(command, 'npm');
    return { code:0, stdout:'', stderr:'' };
  };
  fixture.adapter.freezeCandidate = async () => ({ ...candidate, releaseRoot:path.join(fixture.root, 'frozen-new') });
  fixture.adapter.deployCandidateRelease = async () => candidate;
  fixture.adapter.activateCandidate = async () => path.join(fixture.root, 'backup.plist');
  fixture.adapter.verifyLive = async () => ({ ok:true });
  fixture.adapter.writeHistory = async (value) => history.push(value);

  const result = await fixture.adapter.publish({
    inspection:{ candidate:{ gitHead:fixture.newHead } },
    onStage:async (stage) => stages.push(stage),
  });
  assert.deepEqual(stages, ['preparing_source', 'verifying', 'freezing', 'activating', 'verifying_live']);
  assert.equal(result.current.releaseHash, 'release-new');
  assert.equal(result.rollback.releaseHash, 'release-old');
  assert.equal(history[0].backupPlist, path.join(fixture.root, 'backup.plist'));
});

test('新版启动失败时恢复旧 plist 并标记自动回滚', async (context) => {
  const fixture = await createFixture(context);
  const mainPlist = path.join(fixture.root, 'main.plist');
  await fs.writeFile(mainPlist, 'old-plist', { mode:0o600 });
  const candidateRoot = path.join(fixture.root, 'deploy-new');
  await fs.mkdir(path.join(candidateRoot, 'apps', 'ajun-runtime', 'src'), { recursive:true });
  fixture.adapter.runCommand = async () => ({ code:0, stdout:'', stderr:'' });
  let starts = 0;
  fixture.adapter.restartAndVerify = async () => {
    starts += 1;
    if (starts === 1) throw new Error('new failed');
  };
  await assert.rejects(
    () => fixture.adapter.activateCandidate({
      candidate:{ releaseHash:'release-new', gitHead:fixture.newHead, releaseRoot:candidateRoot },
      sourceRoot:path.join(fixture.root, 'source-new'),
      previous:{ releaseHash:'release-old', gitHead:fixture.oldHead, releaseRoot:fixture.releaseRoot },
    }),
    (error) => error.rolledBack === true,
  );
  assert.equal(await fs.readFile(mainPlist, 'utf8'), 'old-plist');
  assert.equal(starts, 2);
});

test('手动回滚恢复上一版并清空连续回滚入口', async (context) => {
  const fixture = await createFixture(context);
  const previous = { releaseHash:'release-old', payloadHash:'payload-old', gitHead:fixture.oldHead, releaseRoot:fixture.releaseRoot };
  const calls = [];
  fixture.adapter.readHistory = async () => ({
    current:{ releaseHash:'release-new', gitHead:fixture.newHead, releaseRoot:path.join(fixture.root, 'new') },
    previous, backupPlist:path.join(fixture.root, 'previous.plist'),
  });
  await fs.writeFile(path.join(fixture.root, 'previous.plist'), 'previous', { mode:0o600 });
  fixture.adapter.readCurrentRelease = async () => ({ releaseHash:'release-new', gitHead:fixture.newHead, releaseRoot:path.join(fixture.root, 'new') });
  fixture.adapter.backupMainPlist = async () => path.join(fixture.root, 'current.plist');
  fixture.adapter.replaceMainPlist = async (source) => calls.push(['replace', source]);
  fixture.adapter.restartAndVerify = async (expected) => {
    calls.push(['restart', expected.releaseHash]);
    return { pid:77, verifiedAt:'2026-08-17T00:00:00.000Z', checks:{ pid:true, listener:true, cwd:true, argv:true, releaseHash:true, payloadHash:true, gitHead:true, api:true } };
  };
  fixture.adapter.writeHistory = async (value) => calls.push(['history', value]);
  const result = await fixture.adapter.rollback({ onStage:async (stage) => calls.push(['stage', stage]) });
  assert.equal(result.current.releaseHash, 'release-old');
  assert.equal(result.current.verification.checks.api, true);
  assert.equal(result.rollback, null);
  assert.deepEqual(calls.slice(0, 3), [
    ['stage', 'rolling_back'],
    ['replace', path.join(fixture.root, 'previous.plist')],
    ['restart', 'release-old'],
  ]);
  assert.equal(calls.at(-1)[1].previous, null);
});

test('激活和线上核对完成后历史写入失败，不把已经在线的新版本说成失败且保留可重建回滚记录', async (context) => {
  const fixture = await createFixture(context);
  const previous = { releaseHash:'release-old', payloadHash:'payload-old', gitHead:fixture.oldHead, releaseRoot:fixture.releaseRoot };
  const candidate = { releaseHash:'release-new', payloadHash:'payload-new', gitHead:fixture.newHead, releaseRoot:path.join(fixture.root, 'deploy-new') };
  const backup = path.join(fixture.root, 'backup.plist');
  await fs.writeFile(backup, 'old plist', { mode:0o600 });
  fixture.adapter.readCurrentRelease = async () => previous;
  fixture.adapter.prepareCandidateSource = async () => path.join(fixture.root, 'source-new');
  fixture.adapter.runCommand = async () => ({ code:0, stdout:'', stderr:'' });
  fixture.adapter.freezeCandidate = async () => ({ ...candidate, releaseRoot:path.join(fixture.root, 'frozen-new') });
  fixture.adapter.deployCandidateRelease = async () => candidate;
  fixture.adapter.activateCandidate = async ({ onBackupPrepared }) => {
    await onBackupPrepared(backup);
    return backup;
  };
  const proof = { pid:88, verifiedAt:'2026-08-17T00:00:00.000Z', checks:{ pid:true, listener:true, cwd:true, argv:true, releaseHash:true, payloadHash:true, gitHead:true, api:true } };
  fixture.adapter.verifyLive = async () => proof;
  fixture.adapter.writeHistory = async () => { throw new Error('disk full'); };

  await assert.rejects(
    () => fixture.adapter.publish({ inspection:{ candidate:{ gitHead:fixture.newHead } }, onStage:async () => {} }),
    (error) => error.releaseActive === true && error.current.releaseHash === 'release-new' && error.rollback.releaseHash === 'release-old',
  );
  const recovery = JSON.parse(await fs.readFile(path.join(fixture.root, 'state', 'activation-recovery.json'), 'utf8'));
  assert.equal(recovery.state, 'verified');
  const rollback = await fixture.adapter.readRollbackHistory(candidate, proof);
  assert.equal(rollback.previous.releaseHash, 'release-old');
  assert.equal(rollback.recoveryPending, true);
  delete fixture.adapter.writeHistory;
  const rebuilt = await fixture.adapter.reconcileRollbackHistory(candidate, proof);
  assert.equal(rebuilt.recoveryPending, false);
  assert.equal((await fixture.adapter.readHistory()).previous.releaseHash, 'release-old');
  await assert.rejects(() => fs.stat(path.join(fixture.root, 'state', 'activation-recovery.json')), { code:'ENOENT' });
});

test('复用同名部署 release 时复核只读普通文件、manifest、payload 和 entries，篡改即拒绝', async (context) => {
  const fixture = await createFixture(context);
  const frozen = await createImmutableRelease(fixture.deployRoot || path.join(fixture.root, 'deploy'), fixture.newHead);
  fixture.adapter.deployRoot = path.dirname(frozen.releaseRoot);
  const reused = await fixture.adapter.deployCandidateRelease(frozen);
  assert.equal(reused.releaseHash, frozen.releaseHash);
  const server = path.join(frozen.releaseRoot, 'apps', 'ajun-runtime', 'src', 'server.ts');
  await fs.chmod(server, 0o644);
  await fs.writeFile(server, 'tampered\n');
  await fs.chmod(server, 0o444);
  await assert.rejects(() => fixture.adapter.deployCandidateRelease(frozen), /payload hash|文件清单/);
});

test('复用部署目录拒绝软链，即使 manifest releaseHash 恰好相同', async (context) => {
  const fixture = await createFixture(context);
  const frozen = await createImmutableRelease(path.join(fixture.root, 'deploy'), '3'.repeat(40));
  const source = path.join(frozen.releaseRoot, 'apps', 'ajun-runtime', 'src', 'server.ts');
  const link = path.join(frozen.releaseRoot, 'apps', 'ajun-runtime', 'src', 'residual-link');
  for (const directory of [
    frozen.releaseRoot,
    path.join(frozen.releaseRoot, 'apps'),
    path.join(frozen.releaseRoot, 'apps', 'ajun-runtime'),
    path.dirname(source),
  ]) await fs.chmod(directory, 0o755);
  await fs.symlink('server.ts', link);
  for (const directory of [
    path.dirname(source),
    path.join(frozen.releaseRoot, 'apps', 'ajun-runtime'),
    path.join(frozen.releaseRoot, 'apps'),
    frozen.releaseRoot,
  ]) await fs.chmod(directory, 0o555);
  await assert.rejects(() => fixture.adapter.deployCandidateRelease(frozen), /含软链/);
});

test('线上 release payload 被篡改而 manifest 不变时，verifyLive 在 HTTP 前失败关闭', async (context) => {
  const fixture = await createFixture(context);
  delete fixture.adapter.verifyLive;
  const server = path.join(fixture.releaseRoot, 'apps', 'ajun-runtime', 'src', 'server.ts');
  await chmodMutable(fixture.releaseRoot);
  await fs.writeFile(server, 'tampered runtime\n');
  await chmodReadonly(fixture.releaseRoot);
  await assert.rejects(
    () => fixture.adapter.verifyLive({
      releaseHash:fixture.oldReleaseHash, payloadHash:fixture.oldPayloadHash,
      gitHead:fixture.oldHead, releaseRoot:fixture.releaseRoot,
    }),
    /payload hash|文件清单/,
  );
});

test('线上 releaseRoot 不在部署目录或路径中夹带软链时拒绝，不信任同 manifest 的任意路径', async (context) => {
  const fixture = await createFixture(context);
  delete fixture.adapter.verifyLive;
  const outsideParent = path.join(fixture.root, 'outside');
  const outside = await createImmutableRelease(outsideParent, fixture.oldHead);
  const expected = {
    releaseHash:outside.releaseHash, payloadHash:outside.payloadHash,
    gitHead:fixture.oldHead, releaseRoot:outside.releaseRoot,
  };
  fixture.adapter.plistValue = async (key) => ({
    ':ProgramArguments:1':path.join(outside.releaseRoot, 'apps', 'ajun-runtime', 'src', 'server.ts'),
    ':WorkingDirectory':path.join(outside.releaseRoot, 'apps', 'ajun-runtime'),
    ':EnvironmentVariables:AGENT_ARMY_SOURCE_PROJECT_ROOT':path.join(fixture.root, 'source-old'),
  })[key];
  await assert.rejects(() => fixture.adapter.readCurrentRelease(), /受信任部署目录/);
  await assert.rejects(() => fixture.adapter.verifyLive(expected), /受信任部署目录/);

  const linkedParent = path.join(fixture.deployRoot, 'linked');
  await fs.symlink(outsideParent, linkedParent);
  await assert.rejects(
    () => fixture.adapter.verifyLive({ ...expected, releaseRoot:path.join(linkedParent, path.basename(outside.releaseRoot)) }),
    /路径含软链/,
  );
});

async function createFixture(context, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-release-adapter-'));
  context.after(async () => {
    await chmodMutable(root);
    await fs.rm(root, { recursive:true, force:true });
  });
  const deployRoot = path.join(root, 'deploy');
  const oldHead = options.oldHead || '1111111111111111111111111111111111111111';
  const newHead = options.newHead || '2222222222222222222222222222222222222222';
  const frozenCurrent = await createImmutableRelease(deployRoot, oldHead);
  const releaseRoot = frozenCurrent.releaseRoot;
  const workdir = path.join(releaseRoot, 'apps', 'ajun-runtime');
  await fs.writeFile(path.join(root, 'main.plist'), 'fixture', { mode:0o600 });
  const values = new Map([
    ['git:-C,repo,branch,--show-current', options.branch || 'main'],
    ['git:-C,repo,rev-parse,HEAD', newHead],
    ['git:-C,repo,status,--porcelain,--untracked-files=all', options.dirty || ''],
    ['PlistBuddy:-c,Print :ProgramArguments:1,main.plist', path.join(workdir, 'src', 'server.ts')],
    ['PlistBuddy:-c,Print :WorkingDirectory,main.plist', workdir],
    ['PlistBuddy:-c,Print :EnvironmentVariables:AGENT_ARMY_SOURCE_PROJECT_ROOT,main.plist', path.join(root, 'source-old')],
  ]);
  const runCommand = async (command, args) => {
    const key = `${path.basename(command)}:${args.map((item) => item === path.join(root, 'repo') ? 'repo' : item === path.join(root, 'main.plist') ? 'main.plist' : item).join(',')}`;
    if (!values.has(key)) throw new Error(`unexpected command ${path.basename(command)}`);
    return { code:0, stdout:`${values.get(key)}\n`, stderr:'' };
  };
  const adapter = new AjunReleaseSystemAdapter({
    repositoryRoot:path.join(root, 'repo'),
    mainPlist:path.join(root, 'main.plist'),
    stateDir:path.join(root, 'state'),
    deployRoot,
    sourceParent:path.join(root, 'sources'),
    runCommand,
  });
  if (!options.realLiveVerification) {
    adapter.verifyLive = async () => ({
      verifiedAt:'2026-08-17T00:00:00.000Z',
      pid:1234,
      checks:{ pid:true, listener:true, cwd:true, argv:true, releaseHash:true, payloadHash:true, gitHead:true, api:true, rollbackAvailable:false },
    });
  }
  return {
    adapter, root, deployRoot, releaseRoot, oldHead, newHead,
    oldReleaseHash:frozenCurrent.releaseHash, oldPayloadHash:frozenCurrent.payloadHash,
  };
}

async function createImmutableRelease(deployRoot, gitHead) {
  const staging = path.join(deployRoot, 'staging');
  const workdir = path.join(staging, 'apps', 'ajun-runtime', 'src');
  await fs.mkdir(workdir, { recursive:true });
  await fs.writeFile(path.join(workdir, 'server.ts'), 'export {};\n');
  const snapshot = await fixtureSnapshot(staging);
  const manifestWithoutReleaseHash = {
    kind:'agent-army/ajun-immutable-runtime-release', payloadHash:snapshot.payloadHash,
    git:{ gitHead }, entries:snapshot.entries,
  };
  const releaseHash = canonicalHash(manifestWithoutReleaseHash);
  const manifest = { ...manifestWithoutReleaseHash, releaseHash };
  await fs.writeFile(path.join(staging, 'release-manifest.json'), `${JSON.stringify(manifest)}\n`);
  await chmodReadonly(staging);
  const releaseRoot = path.join(deployRoot, `ajun-runtime-release-v1-${releaseHash}`);
  await fs.rename(staging, releaseRoot);
  return { releaseHash, payloadHash:snapshot.payloadHash, gitHead, releaseRoot };
}

async function fixtureSnapshot(root) {
  const entries = [];
  async function walk(current) {
    for (const name of (await fs.readdir(current)).sort()) {
      const absolute = path.join(current, name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (relative === 'release-manifest.json') continue;
      const stat = await fs.lstat(absolute);
      if (stat.isDirectory()) {
        entries.push({ type:'directory', path:relative, mode:'0555' });
        await walk(absolute);
      } else {
        const bytes = await fs.readFile(absolute);
        entries.push({ type:'file', path:relative, mode:'0444', size:bytes.length, sha256:crypto.createHash('sha256').update(bytes).digest('hex') });
      }
    }
  }
  await walk(root);
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  const hasher = crypto.createHash('sha256');
  for (const entry of entries) hasher.update(`${JSON.stringify(entry)}\n`);
  return { entries, payloadHash:hasher.digest('hex') };
}

function canonicalHash(value) {
  const stable = (item) => Array.isArray(item)
    ? `[${item.map(stable).join(',')}]`
    : item && typeof item === 'object'
      ? `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${stable(item[key])}`).join(',')}}`
      : JSON.stringify(item);
  return crypto.createHash('sha256').update(stable(value)).digest('hex');
}

async function chmodReadonly(root) {
  const stat = await fs.lstat(root);
  if (stat.isDirectory()) {
    for (const name of await fs.readdir(root)) await chmodReadonly(path.join(root, name));
    await fs.chmod(root, 0o555);
  } else {
    await fs.chmod(root, 0o444);
  }
}

async function chmodMutable(root) {
  const stat = await fs.lstat(root).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (!stat) return;
  if (stat.isDirectory()) {
    await fs.chmod(root, 0o755);
    for (const name of await fs.readdir(root)) await chmodMutable(path.join(root, name));
  } else {
    await fs.chmod(root, 0o644);
  }
}

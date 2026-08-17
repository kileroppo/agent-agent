import assert from 'node:assert/strict';
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
  await fs.writeFile(path.join(fixture.releaseRoot, 'release-manifest.json'), '{}');
  await assert.rejects(() => fixture.adapter.inspect(), /可信 release manifest/);
});

test('上线核对必须同时证明 PID、cwd、argv、release/payload/Git 和控制台 API', async (context) => {
  const fixture = await createFixture(context, { realLiveVerification:true });
  const expected = {
    releaseHash:'release-old',
    payloadHash:'payload-old',
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

  const proof = await fixture.adapter.verifyLive(expected);
  assert.equal(proof.pid, 4242);
  assert.deepEqual(proof.checks, {
    pid:true, cwd:true, argv:true, releaseHash:true, payloadHash:true, gitHead:true, api:true, rollbackAvailable:false,
  });

  fixture.adapter.runCommand = async (command, args) => {
    if (command === 'launchctl') return { code:0, stdout:`pid = 4242\nworking directory = ${workingDirectory}\n`, stderr:'' };
    if (command === 'lsof') return { code:0, stdout:`p4242\nfcwd\nn${workingDirectory}\n`, stderr:'' };
    if (command === 'ps') return { code:0, stdout:'node /wrong/server.ts\n', stderr:'' };
    throw new Error(`unexpected command ${command} ${args.join(' ')}`);
  };
  await assert.rejects(() => fixture.adapter.verifyLive(expected), /启动参数/);
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
  fixture.adapter.readHistory = async () => ({ previous, backupPlist:path.join(fixture.root, 'previous.plist') });
  fixture.adapter.readCurrentRelease = async () => ({ releaseHash:'release-new', gitHead:fixture.newHead, releaseRoot:path.join(fixture.root, 'new') });
  fixture.adapter.backupMainPlist = async () => path.join(fixture.root, 'current.plist');
  fixture.adapter.replaceMainPlist = async (source) => calls.push(['replace', source]);
  fixture.adapter.restartAndVerify = async (expected) => {
    calls.push(['restart', expected.releaseHash]);
    return { pid:77, verifiedAt:'2026-08-17T00:00:00.000Z', checks:{ pid:true, cwd:true, argv:true, releaseHash:true, payloadHash:true, gitHead:true, api:true } };
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

async function createFixture(context, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ajun-release-adapter-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const releaseRoot = path.join(root, 'release-old');
  const workdir = path.join(releaseRoot, 'apps', 'ajun-runtime');
  await fs.mkdir(workdir, { recursive:true });
  const oldHead = options.oldHead || '1111111111111111111111111111111111111111';
  const newHead = options.newHead || '2222222222222222222222222222222222222222';
  await fs.writeFile(path.join(releaseRoot, 'release-manifest.json'), JSON.stringify({
    kind:'agent-army/ajun-immutable-runtime-release', releaseHash:'release-old', payloadHash:'payload-old', git:{ gitHead:oldHead },
  }));
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
    deployRoot:path.join(root, 'deploy'),
    sourceParent:path.join(root, 'sources'),
    runCommand,
  });
  if (!options.realLiveVerification) {
    adapter.verifyLive = async () => ({
      verifiedAt:'2026-08-17T00:00:00.000Z',
      pid:1234,
      checks:{ pid:true, cwd:true, argv:true, releaseHash:true, payloadHash:true, gitHead:true, api:true, rollbackAvailable:false },
    });
  }
  return { adapter, root, releaseRoot, oldHead, newHead };
}

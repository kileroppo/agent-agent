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
  assert.match(result.message, /发现新版/);
});

test('未提交改动阻止发布且不隐藏原因', async (context) => {
  const fixture = await createFixture(context, { dirty:' M apps/ajun-runtime/src/server.ts' });
  const result = await fixture.adapter.inspect();
  assert.equal(result.canPublish, false);
  assert.match(result.message, /未提交改动/);
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
  return { adapter, root, releaseRoot, oldHead, newHead };
}

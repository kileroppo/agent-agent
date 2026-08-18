import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { runStabilityPhase1 } from './run-stability-phase1.mjs';

const scriptPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'run-stability-phase1.mjs',
);

async function readScript() {
  return fsp.readFile(scriptPath, 'utf8');
}

test('Phase 1 验收目录和摘要文件分别收紧为 0700 与 0600', async () => {
  const source = await readScript();
  assert.match(source, /fsp\.mkdir\(directory, \{ recursive:true, mode:0o700 \}\)/);
  assert.match(source, /fsp\.chmod\(directory, 0o700\)/);
  assert.match(source, /fsp\.writeFile\(filePath, .*\{ mode:0o600 \}\)/);
  assert.match(source, /fsp\.chmod\(filePath, 0o600\)/);
  assert.match(source, /path\.join\(runDirectory, 'phase1-summary\.json'\)/);
});

test('Phase 1 suite 进程丢弃输出，摘要不会建立 stdout 或 stderr 日志文件', async () => {
  const source = await readScript();
  assert.match(source, /stdio:'ignore'/);
  assert.doesNotMatch(source, /(?:stdout|stderr)[-_]?(?:log|output)|(?:log|output)[-_]?(?:stdout|stderr)/i);
  assert.doesNotMatch(source, /createWriteStream|appendFile/);
});

test('Phase 1 摘要仅投影 suite 命令、退出码和耗时等执行元数据', async () => {
  const source = await readScript();
  assert.match(source, /command:\[suite\.command, \.\.\.suite\.args\]\.join\(' '\)/);
  assert.match(source, /durationMs:finishedAt\.getTime\(\) - startedAt\.getTime\(\)/);
  assert.match(source, /exitCode,/);
  assert.doesNotMatch(source, /child\.(?:stdout|stderr)/);
});

test('Phase 1 依据 suite 结果汇总失败数，并明确不预期 Provider 调用', async () => {
  const source = await readScript();
  assert.match(source, /status:exitCode === 0 \? 'passed' : 'failed'/);
  assert.match(source, /failedSuiteCount:results\.filter\(\(item\) => item\.status !== 'passed'\)\.length/);
  assert.match(source, /providerCallsExpected:false/);
  assert.doesNotMatch(source, /https?:\/\/|fetch\(|axios|openai|anthropic|stepfun/i);
});

test('local-ai smoke 与 Hermes dry-run 是仅有的真实 HOME 例外', async () => {
  const source = await readScript();
  assert.match(
    source,
    /id:'local-ai-smoke', command:'npm', args:\['run', 'local-ai:smoke'\], homePolicy:'host'/,
  );
  assert.match(
    source,
    /id:'hermes-whitelist-dry-run', command:'node', args:\['integrations\/hermes\/scripts\/reconcile-hermes-skill-whitelist\.mjs'\], homePolicy:'host'/,
  );
});

test('root-test 未指定 Python 时只获得宿主 HOME 派生的本机 AI 目录', async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'stability-phase1-local-ai-'));
  const hostHome = path.join(root, 'host-home');
  const environmentFile = path.join(root, 'environment.json');
  const previousPython = process.env.AGENT_ARMY_LOCAL_AI_PYTHON;
  const previousHome = process.env.AGENT_ARMY_LOCAL_AI_HOME;
  delete process.env.AGENT_ARMY_LOCAL_AI_PYTHON;
  process.env.AGENT_ARMY_LOCAL_AI_HOME = 'must-not-be-inherited';
  context.after(async () => {
    if (previousPython === undefined) delete process.env.AGENT_ARMY_LOCAL_AI_PYTHON;
    else process.env.AGENT_ARMY_LOCAL_AI_PYTHON = previousPython;
    if (previousHome === undefined) delete process.env.AGENT_ARMY_LOCAL_AI_HOME;
    else process.env.AGENT_ARMY_LOCAL_AI_HOME = previousHome;
    await fsp.rm(root, { recursive:true, force:true });
  });

  await runStabilityPhase1({
    root,
    acceptanceRoot:path.join(root, 'acceptance'),
    runId:'local-ai-home',
    hostHome,
    suites:[{
      id:'root-test',
      command:process.execPath,
      args:['-e', 'require("node:fs").writeFileSync(process.argv[1], process.env.AGENT_ARMY_LOCAL_AI_HOME || "")', environmentFile],
    }],
  });
  assert.equal(
    await fsp.readFile(environmentFile, 'utf8'),
    path.join(hostHome, 'Library', 'Application Support', 'AgentArmy', 'local-ai'),
  );
});

test('Phase 1 保留子进程的正常 umask，并在结束后收紧 suiteHome 树', async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'stability-phase1-umask-'));
  const childUmaskFile = path.join(root, 'child-umask.txt');
  const parentUmask = process.umask();
  process.umask(0o022);
  context.after(async () => {
    process.umask(parentUmask);
    await fsp.rm(root, { recursive:true, force:true });
  });

  await runStabilityPhase1({
    root,
    acceptanceRoot:path.join(root, 'acceptance'),
    runId:'private-child-artifacts',
    suites:[{
      id:'suite-home-permission-probe',
      command:process.execPath,
      args:['-e', [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const fixtureDirectory = path.join(process.env.HOME, "fixture-dir");',
        'fs.mkdirSync(fixtureDirectory);',
        'fs.writeFileSync(path.join(fixtureDirectory, "fixture.txt"), "ok");',
        'fs.writeFileSync(process.argv[1], String(process.umask()));',
      ].join(''), childUmaskFile],
    }],
  });

  const suiteHome = path.join(root, 'acceptance', 'private-child-artifacts', 'suite-home');
  assert.equal(Number(await fsp.readFile(childUmaskFile, 'utf8')), 0o022);
  assert.equal((await fsp.stat(suiteHome)).mode & 0o777, 0o700);
  assert.equal((await fsp.stat(path.join(suiteHome, 'fixture-dir'))).mode & 0o777, 0o700);
  assert.equal((await fsp.stat(path.join(suiteHome, 'fixture-dir', 'fixture.txt'))).mode & 0o777, 0o600);
  assert.equal(process.umask(), 0o022);
});

test('Phase 1 使用隔离环境运行可控 suite，并写出最小安全摘要产物', async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'stability-phase1-'));
  const acceptanceRoot = path.join(root, 'acceptance');
  const environmentFile = path.join(root, 'suite-environment.json');
  const hostEnvironmentFile = path.join(root, 'host-suite-environment.json');
  const hermesEnvironmentFile = path.join(root, 'hermes-suite-environment.json');
  const hostHome = path.join(root, 'real-home');
  const previousSecret = process.env.PHASE1_TEST_SECRET;
  const previousHermesPython = process.env.AJUN_HERMES_PYTHON;
  const previousLocalAiPython = process.env.AGENT_ARMY_LOCAL_AI_PYTHON;
  const previousLocalAiHome = process.env.AGENT_ARMY_LOCAL_AI_HOME;
  process.env.PHASE1_TEST_SECRET = 'must-not-reach-suite';
  process.env.AJUN_HERMES_PYTHON = 'private-hermes-python-path';
  process.env.AGENT_ARMY_LOCAL_AI_PYTHON = 'private-local-ai-python-path';
  process.env.AGENT_ARMY_LOCAL_AI_HOME = 'private-parent-local-ai-home';
  context.after(async () => {
    if (previousSecret === undefined) delete process.env.PHASE1_TEST_SECRET;
    else process.env.PHASE1_TEST_SECRET = previousSecret;
    if (previousHermesPython === undefined) delete process.env.AJUN_HERMES_PYTHON;
    else process.env.AJUN_HERMES_PYTHON = previousHermesPython;
    if (previousLocalAiPython === undefined) delete process.env.AGENT_ARMY_LOCAL_AI_PYTHON;
    else process.env.AGENT_ARMY_LOCAL_AI_PYTHON = previousLocalAiPython;
    if (previousLocalAiHome === undefined) delete process.env.AGENT_ARMY_LOCAL_AI_HOME;
    else process.env.AGENT_ARMY_LOCAL_AI_HOME = previousLocalAiHome;
    await fsp.rm(root, { recursive:true, force:true });
  });

  const probeScript = [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'fs.writeFileSync(process.argv[1], JSON.stringify({',
    'secretPresent:Boolean(process.env.PHASE1_TEST_SECRET),',
    'providerCalls:process.env.AGENT_ARMY_PROVIDER_CALLS,',
    'externalEffects:process.env.AGENT_ARMY_EXTERNAL_EFFECTS,',
    'backgroundDisabled:process.env.AJUN_DISABLE_BACKGROUND_SERVICES,',
    'offline:process.env.npm_config_offline,',
    'hermesPythonPresent:Boolean(process.env.AJUN_HERMES_PYTHON),',
    'localAiPythonPresent:Boolean(process.env.AGENT_ARMY_LOCAL_AI_PYTHON),',
    'localAiHomePresent:Boolean(process.env.AGENT_ARMY_LOCAL_AI_HOME),',
    'home:process.env.HOME, temp:process.env.TMPDIR,',
    'tempMode:fs.statSync(process.env.TMPDIR).mode & 0o777,',
    'serverSocket:path.join(process.env.TMPDIR, "server.sock"),',
    'missingSocket:path.join(process.env.TMPDIR, "missing.sock")',
    '}));',
  ].join('');
  const summary = await runStabilityPhase1({
    root,
    acceptanceRoot,
    runId:'safe-artifact',
    hostHome,
    suites:[
      {
        id:'environment-probe',
        command:process.execPath,
        args:['-e', probeScript, environmentFile],
        homePolicy:'host',
      },
      {
        id:'local-ai-smoke',
        command:process.execPath,
        args:['-e', probeScript, hostEnvironmentFile],
        homePolicy:'host',
      },
      {
        id:'root-test',
        command:process.execPath,
        args:['-e', probeScript, path.join(root, 'root-test-environment.json')],
      },
      {
        id:'hermes-whitelist-dry-run',
        command:process.execPath,
        args:['-e', probeScript, hermesEnvironmentFile],
        homePolicy:'host',
      },
      { id:'expected-failure', command:process.execPath, args:['-e', 'process.exit(7)'] },
    ],
  });

  const runDirectory = path.join(acceptanceRoot, 'safe-artifact');
  const recordedEnvironment = JSON.parse(await fsp.readFile(environmentFile, 'utf8'));
  const recordedHostEnvironment = JSON.parse(await fsp.readFile(hostEnvironmentFile, 'utf8'));
  const recordedHermesEnvironment = JSON.parse(await fsp.readFile(hermesEnvironmentFile, 'utf8'));
  const recordedRootTestEnvironment = JSON.parse(await fsp.readFile(path.join(root, 'root-test-environment.json'), 'utf8'));
  const savedSummary = JSON.parse(await fsp.readFile(path.join(runDirectory, 'phase1-summary.json'), 'utf8'));
  const expectedIsolatedEnvironment = {
    secretPresent:false,
    providerCalls:'disabled',
    externalEffects:'disabled',
    backgroundDisabled:'true',
    offline:'true',
    hermesPythonPresent:false,
    localAiPythonPresent:false,
    localAiHomePresent:false,
    home:path.join(runDirectory, 'suite-home'),
  };
  for (const environment of [
    recordedEnvironment,
    recordedHostEnvironment,
    recordedHermesEnvironment,
    recordedRootTestEnvironment,
  ]) {
    assert.match(environment.temp, /^\/tmp\/aa-s1-[^/]+$/);
    assert.equal(environment.tempMode, 0o700);
    assert.ok(Buffer.byteLength(environment.serverSocket) < 104);
    assert.ok(Buffer.byteLength(environment.missingSocket) < 104);
    assert.notEqual(environment.serverSocket, environment.missingSocket);
    await assert.rejects(fsp.stat(environment.temp), { code:'ENOENT' });
  }
  assert.deepEqual(
    Object.fromEntries(Object.entries(recordedEnvironment).filter(([key]) => !['temp', 'tempMode', 'serverSocket', 'missingSocket'].includes(key))),
    expectedIsolatedEnvironment,
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(recordedHostEnvironment).filter(([key]) => !['temp', 'tempMode', 'serverSocket', 'missingSocket', 'home'].includes(key))),
    Object.fromEntries(Object.entries(expectedIsolatedEnvironment).filter(([key]) => key !== 'home')),
  );
  assert.equal(recordedHostEnvironment.home, hostHome);
  assert.equal(recordedHermesEnvironment.home, hostHome);
  assert.equal(recordedHermesEnvironment.hermesPythonPresent, true);
  assert.equal(recordedRootTestEnvironment.home, expectedIsolatedEnvironment.home);
  assert.equal(recordedRootTestEnvironment.localAiPythonPresent, true);
  assert.equal((await fsp.stat(runDirectory)).mode & 0o777, 0o700);
  assert.equal((await fsp.stat(path.join(runDirectory, 'phase1-summary.json'))).mode & 0o777, 0o600);
  assert.equal(summary.failedSuiteCount, 1);
  assert.deepEqual(savedSummary, summary);
  assert.deepEqual(
    Object.keys(summary.suites[0]).sort(),
    ['command', 'durationMs', 'exitCode', 'finishedAt', 'id', 'startedAt', 'status'],
  );
  assert.doesNotMatch(JSON.stringify(summary), /must-not-reach-suite/);
  assert.doesNotMatch(JSON.stringify(summary), /private-hermes-python-path/);
  assert.doesNotMatch(JSON.stringify(summary), /private-local-ai-python-path|private-parent-local-ai-home/);
});

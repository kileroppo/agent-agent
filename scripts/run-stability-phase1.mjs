import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { createRunId, resolveRunDirectory } from './stability-observer.mjs';

const DEFAULT_ACCEPTANCE_ROOT = path.join(os.homedir(), '.agent-army', 'acceptance');
const SUITES = Object.freeze([
  Object.freeze({ id:'root-check', command:'npm', args:['run', 'check'] }),
  Object.freeze({ id:'root-test', command:'npm', args:['run', 'test'] }),
  Object.freeze({ id:'core-test', command:'npm', args:['run', 'test:core'] }),
  Object.freeze({ id:'contracts-test', command:'npm', args:['run', 'test:contracts'] }),
  Object.freeze({ id:'local-ai-smoke', command:'npm', args:['run', 'local-ai:smoke'], homePolicy:'host' }),
  Object.freeze({ id:'hermes-whitelist-dry-run', command:'node', args:['integrations/hermes/scripts/reconcile-hermes-skill-whitelist.mjs'], homePolicy:'host' }),
  Object.freeze({ id:'paperclip-fake-e2e', command:'npm', args:['run', 'acceptance:fake-e2e', '--workspace=@agent-army/m5-content-pipeline'] }),
  Object.freeze({ id:'ajun-local-chaos', command:'node', args:['apps/ajun-runtime/scripts/run-m5-local-chaos-acceptance.mjs'] }),
]);
const HOST_HOME_SUITE_IDS = new Set(['local-ai-smoke', 'hermes-whitelist-dry-run']);

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`未知参数：${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`参数 --${key} 缺少值。`);
    options[key] = value;
    index += 1;
  }
  return options;
}

async function ensureDirectory(directory) {
  await fsp.mkdir(directory, { recursive:true, mode:0o700 });
  await fsp.chmod(directory, 0o700);
}

async function writeJson(filePath, value) {
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode:0o600 });
  await fsp.chmod(filePath, 0o600);
}

async function createPrivateSuiteTempDirectory() {
  const suiteTemp = await fsp.mkdtemp('/tmp/aa-s1-');
  await fsp.chmod(suiteTemp, 0o700);
  return suiteTemp;
}

async function hardenPrivateTree(directory) {
  const entries = await fsp.readdir(directory, { withFileTypes:true });
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await hardenPrivateTree(child);
      await fsp.chmod(child, 0o700);
    } else if (entry.isFile()) {
      await fsp.chmod(child, 0o600);
    }
  }
  await fsp.chmod(directory, 0o700);
}

function createSafeSuiteEnvironment({ home, suiteTemp, hermesPython, localAiRuntime }) {
  return Object.freeze({
    PATH:process.env.PATH || '',
    HOME:home,
    TMPDIR:suiteTemp,
    CI:'1',
    NO_COLOR:'1',
    NO_UPDATE_NOTIFIER:'1',
    npm_config_audit:'false',
    npm_config_fund:'false',
    npm_config_offline:'true',
    npm_config_update_notifier:'false',
    AGENT_ARMY_STABILITY_PHASE1:'1',
    AGENT_ARMY_PROVIDER_CALLS:'disabled',
    AGENT_ARMY_EXTERNAL_EFFECTS:'disabled',
    AJUN_DISABLE_BACKGROUND_SERVICES:'true',
    ...(hermesPython === undefined ? {} : { AJUN_HERMES_PYTHON:hermesPython }),
    ...localAiRuntime,
  });
}

async function runSuite({ root, suite, spawnImpl, environment }) {
  const startedAt = new Date();
  const child = spawnImpl(suite.command, suite.args, {
    cwd:root,
    env:environment,
    stdio:'ignore',
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const finishedAt = new Date();
  return Object.freeze({
    id:suite.id,
    command:[suite.command, ...suite.args].join(' '),
    startedAt:startedAt.toISOString(),
    finishedAt:finishedAt.toISOString(),
    durationMs:finishedAt.getTime() - startedAt.getTime(),
    exitCode,
    status:exitCode === 0 ? 'passed' : 'failed',
  });
}

export async function runStabilityPhase1({
  root = process.cwd(),
  runId = createRunId(),
  acceptanceRoot = DEFAULT_ACCEPTANCE_ROOT,
  suites = SUITES,
  spawnImpl = spawn,
  hostHome = process.env.HOME || os.homedir(),
} = {}) {
  const runDirectory = resolveRunDirectory(runId, acceptanceRoot);
  await ensureDirectory(runDirectory);
  const suiteHome = path.join(runDirectory, 'suite-home');
  await ensureDirectory(suiteHome);
  const results = [];
  for (const suite of suites) {
    const suiteTemp = await createPrivateSuiteTempDirectory();
    const home = suite.homePolicy === 'host' && HOST_HOME_SUITE_IDS.has(suite.id)
      ? hostHome
      : suiteHome;
    const hermesPython = suite.id === 'hermes-whitelist-dry-run'
      ? process.env.AJUN_HERMES_PYTHON
      : undefined;
    const localAiRuntime = suite.id !== 'root-test'
      ? {}
      : process.env.AGENT_ARMY_LOCAL_AI_PYTHON === undefined
        ? { AGENT_ARMY_LOCAL_AI_HOME:path.join(hostHome, 'Library', 'Application Support', 'AgentArmy', 'local-ai') }
        : { AGENT_ARMY_LOCAL_AI_PYTHON:process.env.AGENT_ARMY_LOCAL_AI_PYTHON };
    try {
      const environment = createSafeSuiteEnvironment({
        home, suiteTemp, hermesPython, localAiRuntime,
      });
      results.push(await runSuite({ root, suite, spawnImpl, environment }));
    } finally {
      await fsp.rm(suiteTemp, { recursive:true, force:true });
    }
  }
  await hardenPrivateTree(suiteHome);
  const summary = Object.freeze({
    schemaVersion:'agent.army/stability-phase1/v1',
    runId,
    generatedAt:new Date().toISOString(),
    safety:Object.freeze({ readOnly:false, externalEffects:false, providerCallsExpected:false }),
    suiteCount:results.length,
    failedSuiteCount:results.filter((item) => item.status !== 'passed').length,
    suites:Object.freeze(results),
  });
  await writeJson(path.join(runDirectory, 'phase1-summary.json'), summary);
  return summary;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const runId = options['run-id'] || createRunId();
  const summary = await runStabilityPhase1({
    root:path.resolve(process.cwd()),
    runId,
    acceptanceRoot:DEFAULT_ACCEPTANCE_ROOT,
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (summary.failedSuiteCount > 0) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${String(error?.message || error)}\n`);
    process.exitCode = 1;
  }
}

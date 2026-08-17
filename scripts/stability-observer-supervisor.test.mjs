import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptsDirectory, '..');
const supervisorScriptPath = path.join(scriptsDirectory, 'stability-observer-supervisor.mjs');

function startSupervisor(homeRoot, args) {
  return spawn(process.execPath, [supervisorScriptPath, ...args], {
    cwd:repositoryRoot,
    env:{ ...process.env, HOME:homeRoot },
    stdio:['ignore', 'pipe', 'pipe'],
  });
}

function waitForExit(child, { timeoutMs = 12_000 } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('等待 supervisor 退出超时'));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function waitForFile(filePath, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fsp.access(filePath);
      return;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('等待 supervisor 证据文件超时');
}

async function assertMissing(filePath) {
  await assert.rejects(() => fsp.stat(filePath), (error) => error?.code === 'ENOENT');
}

async function waitForMissing(filePath, { timeoutMs = 5_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fsp.access(filePath);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('等待 observer 锁清理超时');
}

function assertNoPrivatePathOutput(result, homeRoot) {
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(output.includes(homeRoot), false);
  assert.doesNotMatch(output, /observe\.lock|runDirectory|\/Users\//);
}

for (const stopSignal of ['SIGINT', 'SIGTERM']) {
  test(`运行中 ${stopSignal} 会转发给真实 observer，等待 summary 和锁清理后退出`, async (context) => {
    const homeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'observer-supervisor-signal-'));
    const runId = `supervisor-${stopSignal.toLowerCase()}-forwarding`;
    const runDirectory = path.join(homeRoot, '.agent-army', 'acceptance', runId);
    const observationPath = path.join(runDirectory, 'observations.jsonl');
    const summaryPath = path.join(runDirectory, 'summary.json');
    const lockPath = path.join(runDirectory, 'observe.lock');
    const supervisor = startSupervisor(homeRoot, [
      'observe', '--run-id', runId,
      '--duration-seconds', '120', '--interval-seconds', '30',
    ]);
    context.after(() => {
      if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill('SIGKILL');
      return fsp.rm(homeRoot, { recursive:true, force:true });
    });
    const exitResult = waitForExit(supervisor);

    await waitForFile(observationPath);
    assert.equal(supervisor.kill(stopSignal), true);
    const result = await exitResult;

    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    await assertMissing(lockPath);
    const summary = JSON.parse(await fsp.readFile(summaryPath, 'utf8'));
    assert.equal(summary.stopRequested, true);
    assert.equal(summary.observationCount >= 1, true);
    assertNoPrivatePathOutput(result, homeRoot);
  });
}

test('真实 observer 短任务自然完成后 supervisor 驻留，TERM 后干净退出', async (context) => {
  const homeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'observer-supervisor-complete-'));
  const runId = 'supervisor-natural-completion';
  const runDirectory = path.join(homeRoot, '.agent-army', 'acceptance', runId);
  const summaryPath = path.join(runDirectory, 'summary.json');
  const lockPath = path.join(runDirectory, 'observe.lock');
  const supervisor = startSupervisor(homeRoot, [
    'observe', '--run-id', runId,
    '--duration-seconds', '1', '--interval-seconds', '1',
  ]);
  context.after(() => {
    if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill('SIGKILL');
    return fsp.rm(homeRoot, { recursive:true, force:true });
  });
  const exitResult = waitForExit(supervisor);

  await waitForFile(summaryPath);
  await waitForMissing(lockPath);
  assert.equal(supervisor.exitCode, null);
  assert.equal(supervisor.signalCode, null);
  const summary = JSON.parse(await fsp.readFile(summaryPath, 'utf8'));
  assert.equal(summary.stopRequested, false);
  assert.equal(summary.run.remainingDurationSeconds, 0);

  assert.equal(supervisor.kill('SIGTERM'), true);
  const result = await exitResult;
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assertNoPrivatePathOutput(result, homeRoot);
});

test('真实 observer 身份门禁 exit 2 后 supervisor 驻留而非重启循环', async (context) => {
  const homeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'observer-supervisor-identity-'));
  const runId = 'supervisor-identity-terminal';
  const runDirectory = path.join(homeRoot, '.agent-army', 'acceptance', runId);
  const summaryPath = path.join(runDirectory, 'summary.json');
  const lockPath = path.join(runDirectory, 'observe.lock');
  const supervisor = startSupervisor(homeRoot, [
    'observe', '--run-id', runId,
    '--duration-seconds', '60', '--interval-seconds', '30',
    '--expected-git-head', '0'.repeat(40),
  ]);
  context.after(() => {
    if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill('SIGKILL');
    return fsp.rm(homeRoot, { recursive:true, force:true });
  });
  const exitResult = waitForExit(supervisor);

  await waitForFile(summaryPath);
  await waitForMissing(lockPath);
  assert.equal(supervisor.exitCode, null);
  assert.equal(supervisor.signalCode, null);
  const summary = JSON.parse(await fsp.readFile(summaryPath, 'utf8'));
  assert.equal(summary.identityFailure?.passed, false);

  assert.equal(supervisor.kill('SIGTERM'), true);
  const result = await exitResult;
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assertNoPrivatePathOutput(result, homeRoot);
});

test('真实 observer 其他错误码由 supervisor 原样返回供 launchd 重试', async (context) => {
  const homeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'observer-supervisor-error-'));
  const supervisor = startSupervisor(homeRoot, ['not-a-command']);
  context.after(() => fsp.rm(homeRoot, { recursive:true, force:true }));

  const result = await waitForExit(supervisor);
  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
  assert.match(result.stderr, /未知命令/);
  assertNoPrivatePathOutput(result, homeRoot);
});

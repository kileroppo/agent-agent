import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const sourceScript = fileURLToPath(
  new URL('../scripts/verify-m4-role-quality.mjs', import.meta.url),
);

test('--help 只显示帮助，不生成证据或调用 Hermes', async (context) => {
  const fixture = await createCliFixture(context);
  const result = await runCli(fixture, ['--help']);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /显示帮助并退出；不读取或改写证据，不调用模型/);
  assert.equal(result.stderr, '');
  await assertNoSideEffects(fixture);
});

test('未知参数失败关闭，不生成证据或调用 Hermes', async (context) => {
  const fixture = await createCliFixture(context);
  const result = await runCli(fixture, ['--definitely-unknown']);

  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /参数错误：未知参数：--definitely-unknown/);
  await assertNoSideEffects(fixture);
});

async function createCliFixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm4-role-quality-cli-'));
  context.after(() => fs.rm(root, { recursive:true, force:true }));
  const scriptPath = path.join(
    root,
    'apps/ajun-runtime/scripts/verify-m4-role-quality.mjs',
  );
  const home = path.join(root, 'home');
  const hermesPath = path.join(home, '.local/bin/hermes');
  const modelMarker = path.join(root, 'hermes-was-called');
  await fs.mkdir(path.dirname(scriptPath), { recursive:true });
  await fs.mkdir(path.dirname(hermesPath), { recursive:true });
  await fs.copyFile(sourceScript, scriptPath);
  await fs.writeFile(
    hermesPath,
    '#!/bin/sh\nprintf called > \"$HERMES_TRAP_MARKER\"\nexit 91\n',
    { mode:0o700 },
  );
  return {
    root,
    home,
    scriptPath,
    modelMarker,
    evidenceRoot:path.join(root, 'docs/reviews'),
  };
}

function runCli(fixture, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixture.scriptPath, ...args], {
      env:{
        ...process.env,
        HOME:fixture.home,
        HERMES_TRAP_MARKER:fixture.modelMarker,
      },
      stdio:['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (exitCode, signal) => {
      if (signal) return reject(new Error(`CLI 被信号 ${signal} 终止。`));
      resolve({ exitCode, stdout:stdout.trim(), stderr:stderr.trim() });
    });
  });
}

async function assertNoSideEffects(fixture) {
  await assert.rejects(fs.stat(fixture.evidenceRoot), { code:'ENOENT' });
  await assert.rejects(fs.stat(fixture.modelMarker), { code:'ENOENT' });
}

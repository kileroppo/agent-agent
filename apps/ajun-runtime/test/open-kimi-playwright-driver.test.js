import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { captureDownload } from '../scripts/open-kimi-playwright-driver.mjs';

const execute = promisify(execFile);
const DRIVER = fileURLToPath(new URL('../scripts/open-kimi-playwright-driver.mjs', import.meta.url));
const DEFAULT_TOOLCHAIN = path.join(os.homedir(), '.agent-army/toolchains/open-kimi-ppt/1.1.0');
const DEFAULT_NODE = '/opt/homebrew/bin/node';
const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OPEN_KIMI_SCRIPTS = path.join(
  os.homedir(),
  'Documents/work/AIcode/skills-lib/open-kimi-ppt-skill/skills/open-kimi-ppt/scripts',
);
const IMAGE_ZIP = Buffer.from(
  'UEsDBBQAAAAIACBJB12zeqwnEQAAAA8AAAAFAAAAMS5wbmfrDPBz5+WS4krLrCgpLUoFAFBLAQIUAxQAAAAIACBJB12zeqwnEQAAAA8AAAAFAAAAAAAAAAAAAACAAQAAAAAxLnBuZ1BLBQYAAAAAAQABADMAAAA0AAAAAAA=',
  'base64',
);

test('Playwright 下载捕获拒绝覆盖已有目标', async (t) => {
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'open-kimi-download-existing-'));
  t.after(() => fs.rm(workRoot, { recursive:true, force:true }));
  const output = path.join(workRoot, 'browser-output.zip');
  await fs.writeFile(output, IMAGE_ZIP);
  await assert.rejects(
    () => captureDownload(null, null, output, 1_000),
    (error) => error?.code === 'playwright_output_exists',
  );
  assert.deepEqual(await fs.readFile(output), IMAGE_ZIP);
});

test('隔离 Playwright 在单一生命周期内完成 localhost 操作并拦截越界请求', async (t) => {
  const toolchain = process.env.AGENT_ARMY_OPEN_KIMI_TOOLCHAIN || DEFAULT_TOOLCHAIN;
  const nodeBinary = process.env.AGENT_ARMY_OPEN_KIMI_NODE || DEFAULT_NODE;
  const chromeBinary = process.env.AGENT_ARMY_OPEN_KIMI_CHROME || DEFAULT_CHROME;
  const playwrightRoot = path.join(toolchain, 'node_modules/playwright-core');
  if (!(await allExist([nodeBinary, chromeBinary, path.join(playwrightRoot, 'index.mjs')]))) {
    t.skip('本机未安装锁定的 OpenKimi Playwright 隔离工具链');
    return;
  }

  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'open-kimi-playwright-'));
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type':'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><body><script>
      document.documentElement.dataset.ready = 'yes';
      fetch('http://127.0.0.1/forbidden')
        .then(() => { document.documentElement.dataset.blocked = 'no'; })
        .catch(() => { document.documentElement.dataset.blocked = 'yes'; });
    </script></body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(workRoot, { recursive:true, force:true });
  });

  const child = spawn(nodeBinary, [DRIVER], {
    stdio:['pipe', 'pipe', 'ignore'],
    env:{
      PATH:`${path.dirname(nodeBinary)}:/usr/bin:/bin`,
      HOME:workRoot,
      TMPDIR:workRoot,
      AGENT_ARMY_OPEN_KIMI_PLAYWRIGHT_ROOT:playwrightRoot,
      AGENT_ARMY_OPEN_KIMI_CHROME_REAL:chromeBinary,
      AGENT_ARMY_OPEN_KIMI_BROWSER_WORK_ROOT:workRoot,
      PLAYWRIGHT_BROWSERS_PATH:'0',
    },
  });
  const rpc = createRpc(child);
  t.after(async () => {
    child.stdin.end();
    if (child.exitCode == null) child.kill('SIGTERM');
  });

  const address = server.address();
  await rpc('open', { url:`http://127.0.0.1:${address.port}/` });
  await rpc('waitFunction', { expression:"document.documentElement.dataset.ready === 'yes'" });
  await rpc('waitFunction', { expression:"document.documentElement.dataset.blocked === 'yes'" });
  await rpc('viewport', { width:1440, height:900 });
  const closed = await rpc('close');
  assert.equal(closed.closed, true);
});

test('隔离 Playwright 捕获 localhost 图片 ZIP，并同时落入显式输出与受控下载目录', async (t) => {
  const toolchain = process.env.AGENT_ARMY_OPEN_KIMI_TOOLCHAIN || DEFAULT_TOOLCHAIN;
  const nodeBinary = process.env.AGENT_ARMY_OPEN_KIMI_NODE || DEFAULT_NODE;
  const chromeBinary = process.env.AGENT_ARMY_OPEN_KIMI_CHROME || DEFAULT_CHROME;
  const playwrightRoot = path.join(toolchain, 'node_modules/playwright-core');
  const pythonBinary = path.join(toolchain, 'python/bin/python');
  if (!(await allExist([
    nodeBinary,
    chromeBinary,
    pythonBinary,
    path.join(playwrightRoot, 'index.mjs'),
    path.join(OPEN_KIMI_SCRIPTS, 'export_images.py'),
  ]))) {
    t.skip('本机未安装锁定的 OpenKimi Playwright/Python 隔离工具链');
    return;
  }

  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'open-kimi-download-'));
  const server = http.createServer((request, response) => {
    if (request.url === '/slides.zip') {
      response.writeHead(200, {
        'content-type':'application/zip',
        'content-disposition':'attachment; filename="slides.zip"',
        'content-length':String(IMAGE_ZIP.length),
      });
      response.end(IMAGE_ZIP);
      return;
    }
    response.writeHead(200, { 'content-type':'text/html; charset=utf-8' });
    response.end('<!doctype html><html><body><button onclick="location.href=\'/slides.zip\'">下载</button></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(workRoot, { recursive:true, force:true });
  });

  const child = spawn(nodeBinary, [DRIVER], {
    stdio:['pipe', 'pipe', 'ignore'],
    env:{
      PATH:`${path.dirname(nodeBinary)}:/usr/bin:/bin`,
      HOME:workRoot,
      TMPDIR:workRoot,
      AGENT_ARMY_OPEN_KIMI_PLAYWRIGHT_ROOT:playwrightRoot,
      AGENT_ARMY_OPEN_KIMI_CHROME_REAL:chromeBinary,
      AGENT_ARMY_OPEN_KIMI_BROWSER_WORK_ROOT:workRoot,
      AGENT_ARMY_OPEN_KIMI_LOCAL_DOWNLOAD_FIXTURE:'1',
      PLAYWRIGHT_BROWSERS_PATH:'0',
    },
  });
  const rpc = createRpc(child);
  t.after(() => {
    child.stdin.end();
    if (child.exitCode == null) child.kill('SIGTERM');
  });

  const address = server.address();
  const output = path.join(workRoot, 'browser-output.zip');
  await rpc('open', { url:`http://127.0.0.1:${address.port}/` });
  const result = await rpc('fixtureDownload', { output, timeoutMs:15_000 });
  assert.equal(result.downloaded, true);
  assert.equal(result.bytes, IMAGE_ZIP.length);
  assert.deepEqual(await fs.readFile(output), IMAGE_ZIP);

  const downloadFiles = await fs.readdir(path.join(workRoot, 'downloads'));
  assert.ok(downloadFiles.length >= 1, '浏览器受控下载目录应保留上游可轮询的候选文件');
  const candidates = [output, ...downloadFiles.map((name) => path.join(workRoot, 'downloads', name))];
  await execute(pythonBinary, ['-c', [
    'import sys',
    'from pathlib import Path',
    'from export_images import is_image_zip',
    'raise SystemExit(0 if all(is_image_zip(Path(item)) for item in sys.argv[1:]) else 1)',
  ].join(';'), ...candidates], { cwd:OPEN_KIMI_SCRIPTS, timeout:15_000 });

  const beforeTrigger = new Set(await fs.readdir(path.join(workRoot, 'downloads')));
  const triggered = await rpc('fixtureTriggerDownload');
  assert.equal(triggered.triggered, true);
  const triggeredFile = await waitForNewFile(path.join(workRoot, 'downloads'), beforeTrigger);
  await execute(pythonBinary, ['-c', [
    'import sys',
    'from pathlib import Path',
    'from export_images import is_image_zip',
    'raise SystemExit(0 if is_image_zip(Path(sys.argv[1])) else 1)',
  ].join(';'), triggeredFile], { cwd:OPEN_KIMI_SCRIPTS, timeout:15_000 });

  const closed = await rpc('close');
  assert.equal(closed.closed, true);
});

function createRpc(child) {
  const lines = readline.createInterface({ input:child.stdout, crlfDelay:Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  let sequence = 0;
  return async (action, fields = {}) => {
    const id = ++sequence;
    child.stdin.write(`${JSON.stringify({ id, action, timeoutMs:15_000, ...fields })}\n`);
    const next = await iterator.next();
    assert.equal(next.done, false, 'Playwright driver 提前退出');
    const response = JSON.parse(next.value);
    assert.equal(response.id, id);
    assert.equal(response.ok, true, `Playwright driver 返回 ${response.code || 'unknown_error'}`);
    return response.result;
  };
}

async function allExist(paths) {
  const states = await Promise.all(paths.map((target) => fs.access(target).then(() => true).catch(() => false)));
  return states.every(Boolean);
}

async function waitForNewFile(directory, previousNames, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const names = await fs.readdir(directory);
    const added = names.find((name) => !previousNames.has(name));
    if (added) {
      const target = path.join(directory, added);
      const stat = await fs.stat(target).catch(() => null);
      if (stat?.isFile() && stat.size > 0) return target;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('普通点击后受控下载目录没有出现新文件');
}

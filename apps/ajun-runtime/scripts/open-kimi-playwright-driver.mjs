#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', 'www.kimi.com', 'statics.moonshot.cn']);
const EDITOR_URL_HINT = 'www.kimi.com/neo-ppt';
const DEFAULT_TIMEOUT_MS = 60_000;

let browser;
let context;
let page;
let workRoot;
let blockedByPolicy = false;
let referenceSequence = 0;
let references = new Map();

export function isAllowedNetworkUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || ''));
  } catch {
    return false;
  }
  if (['about:', 'blob:', 'data:'].includes(url.protocol)) return true;
  if (!ALLOWED_HOSTS.has(url.hostname)) return false;
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
    return ['http:', 'ws:'].includes(url.protocol) && Boolean(url.port);
  }
  return ['https:', 'wss:'].includes(url.protocol);
}

async function initialize() {
  if (browser) return;
  const playwrightRoot = requiredAbsolutePath('AGENT_ARMY_OPEN_KIMI_PLAYWRIGHT_ROOT');
  const chromePath = requiredAbsolutePath('AGENT_ARMY_OPEN_KIMI_CHROME_REAL');
  workRoot = requiredAbsolutePath('AGENT_ARMY_OPEN_KIMI_BROWSER_WORK_ROOT');
  const downloadsPath = path.join(workRoot, 'downloads');
  await fs.mkdir(downloadsPath, { recursive:true, mode:0o700 });
  const packageEntry = path.join(playwrightRoot, 'index.mjs');
  const { chromium } = await import(pathToFileURL(packageEntry).href);
  browser = await chromium.launch({
    executablePath:chromePath,
    headless:true,
    downloadsPath,
    args:[
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-domain-reliability',
      '--disable-sync',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--metrics-recording-only',
      '--no-default-browser-check',
      '--no-first-run',
    ],
  });
  context = await browser.newContext({
    acceptDownloads:true,
    serviceWorkers:'block',
    viewport:{ width:1280, height:720 },
  });
  context.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
  context.setDefaultNavigationTimeout(DEFAULT_TIMEOUT_MS);
  await context.addInitScript(() => {
    for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection']) {
      try {
        Object.defineProperty(globalThis, name, { configurable:false, value:undefined });
      } catch {}
    }
  });
  await context.route('**/*', async (route) => {
    if (isAllowedNetworkUrl(route.request().url())) await route.continue();
    else {
      blockedByPolicy = true;
      await route.abort('blockedbyclient');
    }
  });
  await context.routeWebSocket(/.*/, async (socket) => {
    if (isAllowedNetworkUrl(socket.url())) socket.connectToServer();
    else {
      blockedByPolicy = true;
      await socket.close({ code:1008, reason:'network policy' });
    }
  });
  page = await context.newPage();
}

async function handle(request) {
  const action = String(request?.action || '');
  if (action === 'close') {
    await closeBrowser();
    return { closed:true };
  }
  await initialize();
  const timeout = boundedTimeout(request?.timeoutMs);
  if (action === 'open') {
    if (!isLocalBridgeUrl(request.url)) throw policyError('playwright_navigation_denied');
    await page.goto(request.url, { waitUntil:'domcontentloaded', timeout });
    return { opened:true };
  }
  if (action === 'waitFunction') {
    await page.waitForFunction(String(request.expression || ''), null, { timeout });
    return { ready:true };
  }
  if (action === 'viewport') {
    await page.setViewportSize({ width:boundedDimension(request.width), height:boundedDimension(request.height) });
    return { updated:true };
  }
  if (action === 'snapshot') return snapshotEditor(timeout);
  if (action === 'clickRef') {
    await locatorForRef(request.ref).click({ timeout });
    return { clicked:true };
  }
  if (action === 'selectImageFormat') {
    const frame = await editorFrame(timeout);
    const target = await exactTextLocator(frame, '.radio-group-item', '图片');
    await target.click({ timeout });
    await frame.locator('.radio-group-item.active').filter({ hasText:/^\s*图片\s*$/ }).waitFor({ state:'visible', timeout });
    return { selected:true };
  }
  if (action === 'downloadRef') {
    const output = safeOutputPath(request.output);
    const locator = locatorForRef(request.ref);
    return captureDownload(page, locator, output, timeout);
  }
  if (action === 'fixtureDownload') {
    if (process.env.AGENT_ARMY_OPEN_KIMI_LOCAL_DOWNLOAD_FIXTURE !== '1' || !isLocalBridgeUrl(page.url())) {
      throw policyError('playwright_command_denied');
    }
    const output = safeOutputPath(request.output);
    const locator = page.getByRole('button', { name:'下载', exact:true });
    return captureDownload(page, locator, output, timeout);
  }
  throw policyError('playwright_command_denied');
}

export async function captureDownload(targetPage, locator, output, timeout) {
  await assertOutputMissing(output);
  const downloadPromise = targetPage.waitForEvent('download', { timeout }).catch((cause) => {
    throw operationError('playwright_download_event_timeout', cause);
  });
  const [download] = await Promise.all([
    downloadPromise,
    locator.click({ timeout }).catch((cause) => {
      throw operationError('playwright_download_trigger_failed', cause);
    }),
  ]);
  const failure = await download.failure().catch((cause) => {
    throw operationError('playwright_download_save_failed', cause);
  });
  if (failure) throw operationError('playwright_download_save_failed');
  await download.saveAs(output).catch((cause) => {
    throw operationError('playwright_download_save_failed', cause);
  });
  const stat = await fs.stat(output).catch(() => null);
  if (!stat?.isFile() || stat.size < 1) throw operationError('playwright_download_empty');
  return { downloaded:true, bytes:stat.size };
}

async function snapshotEditor(timeout) {
  const frame = await editorFrame(timeout);
  references = new Map();
  referenceSequence = 0;
  const refs = {};
  const lines = [];
  for (const name of ['导出', '下载']) {
    const locator = frame.getByRole('button', { name, exact:true }).last();
    if (await locator.count() && await locator.isVisible().catch(() => false)) {
      const ref = remember(locator);
      refs[ref] = { name, role:'button' };
      lines.push(`button "${name}" [ref=${ref}]`);
    }
  }
  const switchLocator = frame.getByRole('switch').first();
  if (await switchLocator.count() && await switchLocator.isVisible().catch(() => false)) {
    const ref = remember(switchLocator);
    const checked = await switchLocator.isChecked().catch(() => false);
    const disabled = await switchLocator.isDisabled().catch(() => false);
    refs[ref] = { name:'font-embedding', role:'switch' };
    lines.push(`switch [checked=${checked}${disabled ? ' disabled' : ''} ref=${ref}]`);
  }
  return { data:{ refs, snapshot:lines.join('\n') } };
}

async function editorFrame(timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const frame = page.frames().find((candidate) => candidate.url().includes(EDITOR_URL_HINT));
    if (frame) return frame;
    await page.waitForTimeout(100);
  }
  throw Object.assign(new Error('editor frame unavailable'), { code:'playwright_editor_frame_unavailable' });
}

async function exactTextLocator(frame, selector, text) {
  const candidates = frame.locator(selector).filter({ hasText:new RegExp(`^\\s*${text}\\s*$`) });
  if (!(await candidates.count())) throw Object.assign(new Error('editor control unavailable'), { code:'playwright_editor_control_unavailable' });
  return candidates.last();
}

function remember(locator) {
  const ref = `e${++referenceSequence}`;
  references.set(ref, locator);
  return ref;
}

function locatorForRef(value) {
  const ref = String(value || '').replace(/^@/, '');
  const locator = references.get(ref);
  if (!locator) throw policyError('playwright_reference_invalid');
  return locator;
}

function safeOutputPath(value) {
  const candidate = path.resolve(String(value || ''));
  const relative = path.relative(workRoot, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw policyError('playwright_output_denied');
  return candidate;
}

async function assertOutputMissing(output) {
  try {
    await fs.lstat(output);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw operationError('playwright_download_output_invalid', error);
  }
  throw policyError('playwright_output_exists');
}

function isLocalBridgeUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:'
      && ['127.0.0.1', 'localhost'].includes(url.hostname)
      && Boolean(url.port)
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

function boundedTimeout(value) {
  const timeout = Number(value || DEFAULT_TIMEOUT_MS);
  return Number.isFinite(timeout) ? Math.min(300_000, Math.max(1_000, Math.trunc(timeout))) : DEFAULT_TIMEOUT_MS;
}

function boundedDimension(value) {
  const dimension = Number(value);
  if (!Number.isInteger(dimension) || dimension < 200 || dimension > 4096) throw policyError('playwright_viewport_denied');
  return dimension;
}

function requiredAbsolutePath(name) {
  const value = String(process.env[name] || '').trim();
  if (!path.isAbsolute(value)) throw policyError('playwright_environment_invalid');
  return value;
}

function policyError(code) {
  return Object.assign(new Error(code), { code });
}

function operationError(code, cause) {
  return Object.assign(new Error(code, cause ? { cause } : undefined), { code });
}

async function closeBrowser() {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  context = undefined;
  browser = undefined;
  page = undefined;
  references = new Map();
}

function classifyError(error) {
  const code = String(error?.code || '');
  if (code.startsWith('playwright_')) return code;
  if (blockedByPolicy) return 'playwright_network_policy_blocked';
  if (String(error?.name || '').includes('Timeout') || /timeout/i.test(String(error?.message || ''))) return 'playwright_timeout';
  if (/closed|crash|browser/i.test(String(error?.message || ''))) return 'playwright_browser_unavailable';
  return 'playwright_operation_failed';
}

async function runRpc() {
  const input = readline.createInterface({ input:process.stdin, crlfDelay:Infinity });
  for await (const line of input) {
    let request;
    try {
      request = JSON.parse(line);
      const result = await handle(request);
      process.stdout.write(`${JSON.stringify({ id:request.id, ok:true, result })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ id:request?.id || null, ok:false, code:classifyError(error) })}\n`);
    }
  }
  await closeBrowser();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runRpc().catch(async () => {
    await closeBrowser();
    process.exitCode = 1;
  });
}

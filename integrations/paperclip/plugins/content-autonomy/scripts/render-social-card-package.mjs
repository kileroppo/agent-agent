#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const options = parseArgs(process.argv.slice(2));
for (const key of ['props', 'output', 'publicDir']) {
  if (!options[key]) fail(`missing --${key === 'publicDir' ? 'public-dir' : key}`);
}
const props = JSON.parse(await fs.readFile(options.props, 'utf8'));
const outputDir = path.resolve(options.output);
const publicDir = await fs.realpath(options.publicDir);
const browser = await resolveBrowser();
const cards = [];

for (const [index, card] of props.cards.entries()) {
  const sequence = String(index + 1).padStart(2, '0');
  const file = `xhs-${sequence}-${card.id}.png`;
  const htmlPath = path.join(outputDir, `.render-${card.id}.html`);
  const outputPath = path.join(outputDir, file);
  const profilePath = path.join(outputDir, `.chrome-${card.id}`);
  await fs.writeFile(htmlPath, renderHtml(props, card, index, publicDir), { mode:0o600, flag:'wx' });
  let browserProcess = null;
  try {
    browserProcess = spawn(browser, [
      '--headless=new',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--allow-file-access-from-files',
      '--host-resolver-rules=MAP * ~NOTFOUND',
      '--force-device-scale-factor=1',
      `--user-data-dir=${profilePath}`,
      '--window-size=1080,1440',
      `--screenshot=${outputPath}`,
      pathToFileURL(htmlPath).href,
    ], {
      detached:process.platform !== 'win32',
      stdio:'ignore',
    });
    await waitForScreenshot(outputPath, browserProcess);
  } finally {
    await terminateBrowserProcess(browserProcess);
    await fs.rm(htmlPath, { force:true });
    await fs.rm(profilePath, { recursive:true, force:true });
  }
  const bytes = await fs.readFile(outputPath);
  const dimensions = pngDimensions(bytes);
  if (dimensions.width !== 1080 || dimensions.height !== 1440) {
    fail(`unexpected dimensions for ${file}: ${dimensions.width}x${dimensions.height}`);
  }
  cards.push({
    id:card.id,
    file,
    width:dimensions.width,
    height:dimensions.height,
    bytes:bytes.length,
    checksum:sha256(bytes),
  });
}

await fs.writeFile(
  path.join(outputDir, 'social-card-render-manifest.tson'),
  `${JSON.stringify({ schemaVersion:1, platform:'xiaohongshu', cards }, null, 2)}\n`,
  { mode:0o600, flag:'wx' },
);

function renderHtml(props, card, index, publicDir) {
  const image = card.imageSrc ? imageUrl(publicDir, card.imageSrc) : null;
  const bulletMarkup = (card.bullets || []).map((item, bulletIndex) => `
    <div class="row"><span>${String(bulletIndex + 1).padStart(2, '0')}</span><strong>${escapeHtml(item)}</strong></div>`).join('');
  const evidence = image ? `<div class="evidence"><img src="${escapeHtml(image)}" alt=""></div>` : '';
  const kindClass = `kind-${card.kind}`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;width:1080px;height:1440px;overflow:hidden;background:#fafaf8;color:#0a0a0b;font-family:Inter,"PingFang SC","Noto Sans CJK SC",sans-serif}main{width:1080px;height:1440px;padding:88px 84px;display:flex;flex-direction:column;gap:38px}header{height:48px;border-bottom:1px solid #c9c9c5;display:flex;justify-content:space-between;font:500 18px/1.2 ui-monospace,SFMono-Regular,monospace;letter-spacing:.14em;color:#666}.kicker{font-size:22px;font-weight:650;letter-spacing:.06em;color:#002fa7;text-transform:uppercase}.headline{font-size:104px;line-height:1.02;font-weight:260;letter-spacing:-.025em;max-width:900px;margin:0}.body{font-size:31px;line-height:1.48;margin:0;max-width:900px}.rule{width:96px;height:4px;background:#002fa7}.rows{display:flex;flex-direction:column;gap:0;border-top:1px solid #c9c9c5}.row{min-height:118px;border-bottom:1px solid #c9c9c5;display:grid;grid-template-columns:90px 1fr;align-items:center}.row span{font:500 18px/1 ui-monospace,SFMono-Regular,monospace;letter-spacing:.12em;color:#666}.row strong{font-size:29px;font-weight:520}.evidence{height:610px;background:#f0f0ed;padding:28px;display:flex;align-items:center;justify-content:center}.evidence img{width:100%;height:100%;object-fit:contain;display:block}.kind-cover .headline{font-size:126px}.kind-cover .body{font-size:34px}.kind-cover .rows{margin-top:auto;display:grid;grid-template-columns:repeat(3,1fr);border:0;gap:18px}.kind-cover .row{min-height:188px;border:1px solid #c9c9c5;display:flex;flex-direction:column;align-items:flex-start;justify-content:space-between;padding:26px}.kind-cover .row strong{font-size:28px}.kind-evidence{gap:18px}.kind-evidence .headline{font-size:72px}.kind-evidence .body{font-size:27px}.kind-evidence .evidence{height:350px;flex:0 0 350px;padding:24px}.kind-evidence .rows{flex:0 0 auto}.kind-evidence .row{height:70px;min-height:70px}.kind-evidence .row strong{font-size:22px}.kind-checklist .rows{margin-top:10px}.foot{margin-top:auto;border-top:4px solid #002fa7;padding-top:20px;font:500 18px/1.4 ui-monospace,SFMono-Regular,monospace;letter-spacing:.1em;color:#666}</style></head><body><main class="${kindClass}"><header><span>AGENT军团 · STATIC CARD</span><span>${String(index + 1).padStart(2, '0')} / ${String(props.cards.length).padStart(2, '0')}</span></header><p class="kicker">${escapeHtml(props.sourceLabel)}</p><h1 class="headline">${escapeHtml(card.headline)}</h1><div class="rule"></div><p class="body">${escapeHtml(card.body)}</p>${evidence}<div class="rows">${bulletMarkup}</div><div class="foot">${escapeHtml(props.rightsBasis)} · TEMPLATE ${escapeHtml(props.templateBinding.bindingHash.slice(7, 19))}</div></main></body></html>`;
}

function imageUrl(publicDir, relative) {
  const absolute = path.resolve(publicDir, relative);
  if (!absolute.startsWith(`${publicDir}${path.sep}`)) fail('asset path escaped public directory');
  return pathToFileURL(absolute).href;
}

async function resolveBrowser() {
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : process.platform === 'win32'
      ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const candidate of candidates) {
    if (await fs.access(candidate).then(() => true).catch(() => false)) return candidate;
  }
  fail('no supported local Chromium browser found');
}

function parseArgs(args) {
  const value = { props:null, output:null, publicDir:null };
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const next = args[index + 1];
    if (flag === '--props') value.props = next;
    else if (flag === '--output') value.output = next;
    else if (flag === '--public-dir') value.publicDir = next;
    else fail(`unexpected argument: ${flag}`);
  }
  return value;
}

function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function pngDimensions(bytes) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const iend = Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);
  if (
    bytes.length < 36
    || !bytes.subarray(0, 8).equals(signature)
    || bytes.toString('ascii', 12, 16) !== 'IHDR'
    || !bytes.subarray(-12).equals(iend)
  ) fail('renderer output is not a complete PNG');
  return { width:bytes.readUInt32BE(16), height:bytes.readUInt32BE(20) };
}

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

async function waitForScreenshot(outputPath, child) {
  let exited = false;
  let exitCode = null;
  let spawnError = null;
  child.once('error', (error) => {
    spawnError = error;
  });
  child.once('exit', (code) => {
    exited = true;
    exitCode = code;
  });
  let previousSize = -1;
  let stableSamples = 0;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    await delay(100);
    if (spawnError) fail(`browser failed to start: ${String(spawnError.code || 'spawn_error')}`);
    const stat = await fs.stat(outputPath).catch(() => null);
    if (stat?.size > 24) {
      stableSamples = stat.size === previousSize ? stableSamples + 1 : 0;
      previousSize = stat.size;
      if (stableSamples >= 2) {
        pngDimensions(await fs.readFile(outputPath));
        return;
      }
    }
    if (exited && !stat) fail(`browser exited before screenshot: ${String(exitCode)}`);
  }
  fail('browser screenshot timed out');
}

async function terminateBrowserProcess(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio:'ignore' });
      killer.once('error', resolve);
      killer.once('exit', resolve);
    });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
  await delay(50);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

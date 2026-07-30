#!/usr/bin/env node
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  LOCAL_ACCEPTANCE_CONFIRMATION,
  LOCAL_ACCEPTANCE_DEFAULT_PORT,
  LOCAL_ACCEPTANCE_HOST,
  buildBoundedSessionPolicy,
  createLocalFixtureRequestHandler,
  evaluateCuaPreflight,
  resolveAcceptanceUploadPath
} from '../src/local-cua-acceptance.js';
import { parseBrowserPrepareResult } from '../src/cua-driver-runner.js';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const workspaceRoot = path.resolve(root, '../../..');
const defaultFixtureDirectory = path.join(root, 'acceptance', 'fixtures');
const defaultUpload = path.join(defaultFixtureDirectory, 'sample-upload.txt');
const htmlPath = path.join(root, 'acceptance', 'fake-platform.html');
const knownBrowserExecutables = new Set([
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
]);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

export function requireBrowserApprovalToken(value) {
  const token = typeof value === 'string' ? value.trim() : '';
  if (!token) {
    fail(
      'browser_consent_required',
      '本地 CUA 验收需要当次 browser-approve 生成的五分钟单次凭证；请生成新凭证并只通过 CUA_BROWSER_APPROVAL_TOKEN 注入后立即重试。',
    );
  }
  return token;
}

export function parseArguments(argv) {
  const args = {
    confirmation:'',
    platform:'fake-douyin',
    port:LOCAL_ACCEPTANCE_DEFAULT_PORT,
    upload:defaultUpload,
    browserPid:null,
    evidenceOutput:null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = argv[index + 1];
    if (value === '--confirm') args.confirmation = next, index += 1;
    else if (value === '--platform') args.platform = next, index += 1;
    else if (value === '--port') args.port = Number(next), index += 1;
    else if (value === '--upload') args.upload = next, index += 1;
    else if (value === '--browser-pid') args.browserPid = Number(next), index += 1;
    else if (value === '--evidence-output') args.evidenceOutput = next, index += 1;
    else if (value === '--help') {
      process.stdout.write([
        'M5 本地假平台 Computer Use 验收',
        '',
        `M5_FAKE_CUA_ACCEPTANCE=1 npm run acceptance:cua:local -- --confirm ${LOCAL_ACCEPTANCE_CONFIRMATION} --evidence-output work/m5-cua-evidence.json`,
        '',
        '参数：',
        '  --platform fake-douyin|fake-xiaohongshu',
        `  --port ${LOCAL_ACCEPTANCE_DEFAULT_PORT}`,
        '  --upload <获准测试目录内的普通文件>',
        '  --browser-pid <已运行 Chrome/Chromium/Edge 的主进程 PID>',
        '  --evidence-output <当前工作区内尚不存在的普通 .json 路径>',
        ''
      ].join('\n'));
      process.exit(0);
    } else {
      fail('invalid_argument', `未知参数：${value}`);
    }
  }
  if (!['fake-douyin', 'fake-xiaohongshu'].includes(args.platform)) {
    fail('invalid_platform', '只允许 fake-douyin 或 fake-xiaohongshu。');
  }
  if (!Number.isInteger(args.port) || args.port < 1024 || args.port > 65535) {
    fail('invalid_port', '本地验收端口必须是 1024–65535 的整数。');
  }
  if (args.browserPid !== null && (!Number.isInteger(args.browserPid) || args.browserPid <= 0)) {
    fail('invalid_browser_pid', '--browser-pid 必须是正整数。');
  }
  if (typeof args.evidenceOutput !== 'string' || !args.evidenceOutput.trim()) {
    fail('evidence_output_required', '必须显式提供 --evidence-output <当前工作区内的普通 .json 路径>。');
  }
  return args;
}

async function run(command, args, options = {}) {
  const result = await execFileAsync(command, args, {
    encoding:'utf8',
    maxBuffer:8 * 1024 * 1024,
    ...options
  });
  return result.stdout.trim();
}

function parseJson(value, label) {
  try {
    return JSON.parse(String(value).trim());
  } catch {
    fail('invalid_cua_output', `${label} 未返回可解析的 JSON。`);
  }
}

function unwrapCuaPayload(value) {
  if (typeof value === 'string') {
    try {
      return unwrapCuaPayload(JSON.parse(value));
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map(unwrapCuaPayload);
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value.content)) {
    const text = value.content.find((item) => typeof item?.text === 'string')?.text;
    if (text) return unwrapCuaPayload(text);
  }
  if (value.result && Object.keys(value).length <= 3) return unwrapCuaPayload(value.result);
  return value;
}

function walk(value, visit) {
  if (visit(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = walk(item, visit);
      if (found !== undefined) return found;
    }
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      const found = walk(item, visit);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function findString(value, key) {
  const found = walk(value, (item) => (
    item && typeof item === 'object' && typeof item[key] === 'string'
  ));
  return found?.[key];
}

export function findRef(value, expectedName, action) {
  const target = expectedName.toLowerCase();
  const matches = [];
  walkAll(value, (item) => {
    if (!item || typeof item !== 'object' || typeof item.ref !== 'string') return false;
    const name = [
      item.name,
      item.accessible_name,
      item.label,
      item.text,
      item.description
    ].filter(Boolean).join(' ').toLowerCase();
    const actions = Array.isArray(item.actions) ? item.actions : [];
    if (name.includes(target) && (!action || actions.includes(action))) matches.push(item);
    return false;
  });
  if (matches.length === 0) {
    fail('browser_ref_missing', `页面快照中未找到“${expectedName}”的 ${action || '操作'} ref。`);
  }
  if (matches.length !== 1) {
    fail(
      'browser_ref_ambiguous',
      `页面快照中“${expectedName}”的 ${action || '操作'} 匹配到 ${matches.length} 项，拒绝猜测。`,
    );
  }
  return matches[0].ref;
}

function walkAll(value, visit) {
  visit(value);
  if (Array.isArray(value)) {
    for (const item of value) walkAll(item, visit);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) walkAll(item, visit);
  }
}

function containsText(value, expected) {
  if (typeof value === 'string') return value.includes(expected);
  if (Array.isArray(value)) return value.some((item) => containsText(item, expected));
  if (value && typeof value === 'object') {
    return Object.values(value).some((item) => containsText(item, expected));
  }
  return false;
}

function findTextMatch(value, pattern) {
  if (typeof value === 'string') return value.match(pattern)?.[0];
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findTextMatch(item, pattern);
      if (found) return found;
    }
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      const found = findTextMatch(item, pattern);
      if (found) return found;
    }
  }
  return undefined;
}

export async function resolveEvidenceOutputPath(allowedWorkspace, candidate) {
  const canonicalWorkspace = await fs.realpath(allowedWorkspace);
  const workspaceStats = await fs.stat(canonicalWorkspace);
  if (!workspaceStats.isDirectory() || canonicalWorkspace === path.parse(canonicalWorkspace).root) {
    fail('invalid_evidence_workspace', '验收证据工作区必须是非根目录的真实目录。');
  }
  const text = String(candidate || '').trim();
  if (!text || path.extname(text) !== '.json') {
    fail('invalid_evidence_output', '验收证据输出必须是当前工作区内的 .json 文件。');
  }
  const requested = path.isAbsolute(text)
    ? path.normalize(text)
    : path.resolve(canonicalWorkspace, text);
  const relative = path.relative(canonicalWorkspace, requested);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('evidence_output_outside_workspace', '验收证据输出不得越出当前工作区。');
  }
  let inspected = canonicalWorkspace;
  for (const part of path.dirname(relative).split(path.sep).filter(Boolean)) {
    inspected = path.join(inspected, part);
    let stats;
    try {
      stats = await fs.lstat(inspected);
    } catch {
      fail('evidence_output_parent_missing', '验收证据输出目录必须已经存在。');
    }
    if (stats.isSymbolicLink()) {
      fail('evidence_output_symlink', '验收证据输出路径不能包含符号链接。');
    }
    if (!stats.isDirectory()) {
      fail('evidence_output_parent_missing', '验收证据输出目录必须是普通目录。');
    }
  }
  const canonicalParent = await fs.realpath(path.dirname(requested)).catch(() => {
    fail('evidence_output_parent_missing', '验收证据输出目录必须已经存在。');
  });
  const parentRelative = path.relative(canonicalWorkspace, canonicalParent);
  if (parentRelative.startsWith('..') || path.isAbsolute(parentRelative)) {
    fail('evidence_output_outside_workspace', '验收证据输出目录不得通过符号链接越出当前工作区。');
  }
  const output = path.join(canonicalParent, path.basename(requested));
  try {
    const stats = await fs.lstat(output);
    if (stats.isSymbolicLink()) {
      fail('evidence_output_symlink', '验收证据输出不能是符号链接。');
    }
    fail('evidence_output_exists', '验收证据输出已经存在，拒绝覆盖。');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return { file:output, workspace:canonicalWorkspace };
}

export async function writeEvidenceAtomically(outputPath, evidence) {
  const parent = path.dirname(outputPath);
  const temporary = path.join(
    parent,
    `.${path.basename(outputPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await fs.link(temporary, outputPath);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        fail('evidence_output_exists', '验收证据输出已经存在，拒绝覆盖。');
      }
      throw error;
    }
    await fs.unlink(temporary);
    const stats = await fs.lstat(outputPath);
    if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o777) !== 0o600) {
      fail('evidence_output_invalid', '验收证据必须是权限 0600 的普通 JSON 文件。');
    }
    return { bytes:stats.size, mode:'0600' };
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporary).catch(() => undefined);
  }
}

export function createAcceptanceEvidence({
  platform,
  origin,
  cuaDriverVersion,
  uploadBasename,
  uploadSha256,
  uploadBytes,
  policySha256,
  contentId,
  startedAt,
  completedAt,
}) {
  const version = String(cuaDriverVersion || '').match(/\d+\.\d+\.\d+/)?.[0];
  const expectedContentId = new RegExp(
    `^local-${platform === 'fake-douyin' ? 'fake-douyin' : 'fake-xiaohongshu'}-[a-f0-9]{16}$`,
  );
  if (
    !['fake-douyin', 'fake-xiaohongshu'].includes(platform)
    || !/^http:\/\/127\.0\.0\.1:\d+$/.test(String(origin || ''))
    || !version
    || path.basename(String(uploadBasename || '')) !== uploadBasename
    || !/^sha256:[a-f0-9]{64}$/.test(String(uploadSha256 || ''))
    || !Number.isInteger(uploadBytes)
    || uploadBytes < 0
    || !/^sha256:[a-f0-9]{64}$/.test(String(policySha256 || ''))
    || !expectedContentId.test(String(contentId || ''))
    || !Number.isFinite(Date.parse(startedAt))
    || !Number.isFinite(Date.parse(completedAt))
    || Date.parse(completedAt) < Date.parse(startedAt)
  ) {
    fail('invalid_acceptance_evidence', '本地 CUA 验收证据字段不完整或身份不一致。');
  }
  return {
    schemaVersion:'agent.army/local-cua-acceptance-evidence/v1',
    platform,
    origin,
    cuaDriverVersion:version,
    profileMode:'isolated_new',
    upload:{
      basename:uploadBasename,
      sha256:uploadSha256,
      bytes:uploadBytes,
    },
    policySha256,
    contentId,
    startedAt:new Date(startedAt).toISOString(),
    completedAt:new Date(completedAt).toISOString(),
    realPlatformTouched:false,
  };
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

function sha256Text(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

async function findBrowserIdentity(explicitPid) {
  const output = await run('/bin/ps', ['-axo', 'pid=,comm=']);
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (
      match
      && knownBrowserExecutables.has(match[2])
      && (!explicitPid || Number(match[1]) === explicitPid)
    ) {
      return { pid:Number(match[1]), executable:match[2] };
    }
  }
  if (explicitPid) {
    fail('unsupported_browser_pid', '指定 PID 不是已审核的 Chrome、Chromium 或 Edge 主进程。');
  }
  fail(
    'supported_browser_not_running',
    '未发现已运行的 Chrome、Chromium 或 Edge 主进程；请手工打开其中一个浏览器后重试。'
  );
}

async function cuaCall(socketPath, tool, input) {
  const output = await run('cua-driver', [
    'call',
    '--socket',
    socketPath,
    tool,
    JSON.stringify(input)
  ]);
  return unwrapCuaPayload(parseJson(output, tool));
}

async function waitForDaemon(socketPath, daemon) {
  let lastError = '';
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (daemon.exitCode !== null) {
      fail('cua_daemon_failed', `bounded CuaDriver 启动失败：${lastError || `exit ${daemon.exitCode}`}`);
    }
    try {
      await run('cua-driver', ['status', '--socket', socketPath]);
      return;
    } catch (error) {
      lastError = error.stderr || error.message;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  fail('cua_daemon_timeout', `bounded CuaDriver 未在 3 秒内就绪：${lastError}`);
}

async function waitForBrowserWindow(socketPath, preparedPid) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const windows = await cuaCall(socketPath, 'list_windows', { pid:preparedPid });
    const windowId = findBestBrowserWindowId(windows, preparedPid);
    if (windowId) return windowId;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail('prepared_browser_window_missing', '隔离浏览器未在5秒内返回可绑定窗口。');
}

function findBestBrowserWindowId(value, preparedPid) {
  const candidates = [];
  walk(value, (item) => {
    if (
      item
      && typeof item === 'object'
      && Number.isInteger(item.window_id)
      && item.pid === preparedPid
    ) {
      const width = Number(item.bounds?.width || 0);
      const height = Number(item.bounds?.height || 0);
      candidates.push({
        windowId:item.window_id,
        score:(item.is_on_screen === true ? 1_000_000_000 : 0) + width * height
      });
    }
    return false;
  });
  candidates.sort((left, right) => right.score - left.score);
  return candidates[0]?.windowId;
}

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, LOCAL_ACCEPTANCE_HOST, resolve);
  });
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  if (
    process.env.M5_FAKE_CUA_ACCEPTANCE !== '1' ||
    args.confirmation !== LOCAL_ACCEPTANCE_CONFIRMATION
  ) {
    fail(
      'local_cua_acceptance_disabled',
      `本地 Computer Use 验收默认关闭；需同时设置 M5_FAKE_CUA_ACCEPTANCE=1 和 --confirm ${LOCAL_ACCEPTANCE_CONFIRMATION}。`
    );
  }
  const evidenceOutput = await resolveEvidenceOutputPath(workspaceRoot, args.evidenceOutput);
  const upload = await resolveAcceptanceUploadPath(
    path.dirname(path.resolve(args.upload)),
    path.resolve(args.upload)
  );
  const uploadSha256 = await sha256File(upload.file);
  const manifest = parseJson(await run('cua-driver', ['manifest', '--pretty']), 'cua-driver manifest');
  const permissions = parseJson(
    await run('cua-driver', ['permissions', 'status', '--json']),
    'cua-driver permissions status'
  );
  evaluateCuaPreflight({
    enabled:process.env.M5_FAKE_CUA_ACCEPTANCE === '1',
    confirmation:args.confirmation,
    version:manifest.binary_version,
    permissions
  });

  const browser = await findBrowserIdentity(args.browserPid);
  const approvalToken = requireBrowserApprovalToken(
    process.env.CUA_BROWSER_APPROVAL_TOKEN,
  );
  const html = await fs.readFile(htmlPath, 'utf8');
  const server = http.createServer(createLocalFixtureRequestHandler(html));
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'm5-local-cua-'));
  const socketPath = path.join(tempDirectory, 'cua.sock');
  const policyPath = path.join(tempDirectory, 'bounded-session.yaml');
  const session = `m5-local-fake-${process.pid}`;
  const origin = `http://${LOCAL_ACCEPTANCE_HOST}:${args.port}`;
  const policy = buildBoundedSessionPolicy({
    origin,
    readableDirectory:upload.directory,
    browserExecutable:browser.executable
  });
  const policySha256 = sha256Text(policy);
  let daemon = null;
  let sessionStarted = false;

  try {
    await fs.writeFile(
      policyPath,
      policy,
      { encoding:'utf8', mode:0o600, flag:'wx' }
    );
    await listen(server, args.port);
    await run('/usr/bin/open', [
      '-n',
      '-g',
      '-a',
      'CuaDriver',
      '--args',
      'serve',
      '--socket',
      socketPath,
      '--permission-mode',
      'bounded',
      '--session-policy',
      policyPath,
      '--approve-session-policy',
      '--no-overlay'
    ]);
    daemon = { exitCode:null };
    await waitForDaemon(socketPath, daemon);

    await cuaCall(socketPath, 'start_session', { session, capture_scope:'window' });
    sessionStarted = true;
    const prepared = await cuaCall(socketPath, 'browser_prepare', {
      pid:browser.pid,
      session,
      allow_launch:true,
      approval_token:approvalToken,
      profile:{ mode:'isolated_new' }
    });
    const preparedPid = parseBrowserPrepareResult(prepared);

    const windowId = await waitForBrowserWindow(socketPath, preparedPid);

    const binding = await cuaCall(socketPath, 'get_browser_state', {
      pid:preparedPid,
      window_id:windowId,
      session
    });
    const targetId = findString(binding, 'target_id');
    const tabId = findString(binding, 'tab_id');
    if (!targetId || !tabId) fail('browser_binding_missing', '无法取得隔离浏览器的 target/tab capability。');

    const navigation = await cuaCall(socketPath, 'browser_navigate', {
      target_id:targetId,
      tab_id:tabId,
      session,
      url:`${origin}/?platform=${args.platform}`
    });
    if (navigation?.status !== 'ok') {
      fail(
        navigation?.refusal?.code || 'browser_navigation_failed',
        navigation?.refusal?.message || '隔离浏览器没有确认本地假平台导航。'
      );
    }
    const snapshot = await cuaCall(socketPath, 'get_browser_state', {
      target_id:targetId,
      tab_id:tabId,
      session,
      snapshot_format:'semantic_v2',
      include_screenshot:false
    });
    const common = { target_id:targetId, tab_id:tabId, session };
    await cuaCall(socketPath, 'browser_set_input_files', {
      ...common,
      ref:findRef(snapshot, '测试媒体文件', 'upload'),
      files:[upload.file]
    });
    const fields = [
      ['标题', 'AI Agent 本地受控发布验收'],
      ['正文', '这是一条仅在本机假平台页面生成回执的验收内容，不连接任何真实平台。'],
      ['标签', '#AI-Agent #本地验收'],
      ['计划时间', '2026-07-30 12:00']
    ];
    for (const [name, text] of fields) {
      await cuaCall(socketPath, 'browser_type', {
        ...common,
        ref:findRef(snapshot, name, 'type'),
        text,
        replace:true
      });
    }
    await cuaCall(socketPath, 'browser_click', {
      ...common,
      ref:findRef(snapshot, '生成本地假回执', 'click'),
      input_route:'dom_event'
    });
    const verification = await cuaCall(socketPath, 'get_browser_state', {
      ...common,
      snapshot_format:'semantic_v2',
      include_screenshot:false,
      query:'本地假发布成功'
    });
    if (!containsText(verification, '本地假发布成功')) {
      fail('local_fake_receipt_missing', '页面没有出现“本地假发布成功”回执。');
    }
    const contentId = findTextMatch(
      verification,
      /local-fake-(?:douyin|xiaohongshu)-[a-f0-9]{16}/
    );
    if (!contentId) {
      fail('local_fake_content_id_missing', '本地假平台回执缺少可核验 contentId。');
    }
    const [completedUploadSha256, completedUploadStats] = await Promise.all([
      sha256File(upload.file),
      fs.stat(upload.file),
    ]);
    if (
      completedUploadSha256 !== uploadSha256
      || !completedUploadStats.isFile()
      || completedUploadStats.size !== upload.size
    ) {
      fail('acceptance_upload_changed', '验收期间测试媒体文件发生变化，拒绝写入证据账本。');
    }
    const completedAt = new Date().toISOString();
    const evidence = createAcceptanceEvidence({
      platform:args.platform,
      origin,
      cuaDriverVersion:manifest.binary_version,
      uploadBasename:path.basename(upload.file),
      uploadSha256,
      uploadBytes:upload.size,
      policySha256,
      contentId,
      startedAt,
      completedAt,
    });
    await writeEvidenceAtomically(evidenceOutput.file, evidence);
    process.stdout.write(`${JSON.stringify({
      ok:true,
      mode:'local-fake-platform',
      evidenceWritten:true,
      ...evidence,
    }, null, 2)}\n`);
  } finally {
    if (sessionStarted && daemon?.exitCode === null) {
      await cuaCall(socketPath, 'end_session', { session }).catch(() => {});
    }
    if (daemon?.exitCode === null) {
      await run('cua-driver', ['stop', '--socket', socketPath]).catch(() => {});
    }
    await closeServer(server);
    await fs.rm(tempDirectory, { recursive:true, force:true });
  }
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.code || 'local_cua_acceptance_failed'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

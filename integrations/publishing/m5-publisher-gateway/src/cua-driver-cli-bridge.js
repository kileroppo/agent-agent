import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  SUPPORTED_BROWSER_EXECUTABLES,
  renderBoundedBrowserPolicy,
} from './cua-policy.js';
import {
  MINIMUM_CUA_DRIVER_VERSION,
  versionAtLeast,
} from './local-cua-acceptance.js';
import { coded } from './policy.js';
import {
  cuaSemanticSnapshot,
  findExactRef,
  findFileInputRef,
  findRichTextInputRef,
  parseBrowserPrepareResult,
} from './cua-semantic-snapshot.js';

const execFileAsync = promisify(execFile);
const EXPECTED_TCC_IDENTITY = 'com.trycua.driver';
const KNOWN_BROWSER_EXECUTABLES = new Set(SUPPORTED_BROWSER_EXECUTABLES);

export class CuaDriverCliBridge {
  constructor({
    command = 'cua-driver',
    browserPid = null,
    browserPidResolver = findBrowserPid,
    approvalTokenProvider = null,
  } = {}) {
    this.command = command;
    this.browserPid = browserPid;
    this.browserPidResolver = browserPidResolver;
    this.approvalTokenProvider = approvalTokenProvider;
  }

  async open({
    sessionId,
    origin,
    readableDirectory,
    selectors,
    profileMode,
    profileName,
  }) {
    await verifyCuaPreflight(this.command);
    const browser = normalizeBrowserIdentity(
      await this.browserPidResolver(this.browserPid),
    );
    const approvalToken = await this.approvalTokenProvider?.({
      pid:browser.pid,
      profileMode,
      profileName,
      sessionId,
    });
    if (typeof approvalToken !== 'string' || !approvalToken.trim()) {
      throw coded(
        'browser_consent_required',
        '隔离浏览器需要可信宿主提供一次性 browser-approve 凭证；runner 不生成、记录或持久化该凭证。',
      );
    }
    const runtimeDirectory = await fs.mkdtemp(path.join(readableDirectory, '.runtime-'));
    const socketPath = path.join(runtimeDirectory, 'cua.sock');
    const policyPath = path.join(runtimeDirectory, 'bounded-session.yaml');
    await fs.writeFile(
      policyPath,
      renderBoundedBrowserPolicy({
        origin,
        readableDirectory,
        browserExecutable:browser.executable,
        profileMode,
        profileName,
      }),
      { encoding:'utf8', mode:0o600, flag:'wx' },
    );
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
      '--no-overlay',
    ]);
    const daemon = { exitCode:null };
    await waitForDaemon(this.command, socketPath, daemon);

    try {
      await cuaCall(this.command, socketPath, 'start_session', {
        session:sessionId,
        capture_scope:'window',
      });
      const prepared = await cuaCall(this.command, socketPath, 'browser_prepare', {
        pid:browser.pid,
        session:sessionId,
        allow_launch:true,
        approval_token:approvalToken,
        profile:{
          mode:profileMode,
          ...(profileMode === 'isolated_named' ? { name:profileName } : {}),
        },
      });
      const preparedPid = parseBrowserPrepareResult(prepared);
      const windowId = await waitForBrowserWindow(this.command, socketPath, preparedPid);
      const binding = await cuaCall(this.command, socketPath, 'get_browser_state', {
        pid:preparedPid,
        window_id:windowId,
        session:sessionId,
      });
      const targetId = cuaSemanticSnapshot.findString(binding, 'target_id');
      const tabId = cuaSemanticSnapshot.findString(binding, 'tab_id');
      if (!targetId || !tabId) throw coded('browser_binding_missing', '无法取得隔离浏览器 capability。');
      const destination = new URL(selectors.path || '/', origin);
      if (destination.origin !== origin) {
        throw coded('cua_selector_map_invalid', 'CUA selector map 的入口路径逃逸了官方 origin。');
      }
      const common = { target_id:targetId, tab_id:tabId, session:sessionId };
      await cuaCall(this.command, socketPath, 'browser_navigate', {
        ...common,
        url:destination.href,
      });
      return {
        command:this.command,
        socketPath,
        daemon,
        sessionId,
        common,
        origin,
        selectors,
        runtimeDirectory,
      };
    } catch (error) {
      await stopBridgeSession({
        command:this.command,
        socketPath,
        daemon,
        sessionId,
        runtimeDirectory,
      });
      throw error;
    }
  }

  async snapshot(session, snapshotFormat = 'semantic_v2', { query } = {}) {
    return cuaCall(session.command, session.socketPath, 'get_browser_state', {
      ...session.common,
      snapshot_format:snapshotFormat,
      include_screenshot:false,
      ...(typeof query === 'string' && query.trim() ? { query:query.trim() } : {}),
    });
  }

  async upload(session, selector, file) {
    const semanticSnapshot = await this.snapshot(session);
    let ref;
    try {
      ref = findRef(semanticSnapshot, selector.label, 'upload');
    } catch (error) {
      if (error?.code !== 'browser_ref_missing') throw error;
      findRef(semanticSnapshot, selector.label, 'click');
      const domSnapshot = await this.snapshot(session, 'dom_refs_v1');
      ref = findFileInputRef(domSnapshot);
    }
    await cuaCall(session.command, session.socketPath, 'browser_set_input_files', {
      ...session.common,
      ref,
      files:[file],
    });
    return this.snapshot(session);
  }

  async type(session, selector, text) {
    const semanticSnapshot = await this.snapshot(session);
    let ref;
    try {
      ref = findRef(semanticSnapshot, selector.label, 'type');
    } catch (error) {
      if (error?.code !== 'browser_ref_missing') throw error;
      if (selector.action === 'set_tags') {
        findRef(semanticSnapshot, selector.label, 'click');
      } else if (!cuaSemanticSnapshot.text(semanticSnapshot).toLowerCase().includes(
        String(selector.label).toLowerCase(),
      )) {
        throw error;
      }
      const domSnapshot = await this.snapshot(session, 'dom_refs_v1');
      ref = findRichTextInputRef(domSnapshot);
    }
    await cuaCall(session.command, session.socketPath, 'browser_type', {
      ...session.common,
      ref,
      text,
      replace:selector.action !== 'set_tags',
    });
    return this.snapshot(session);
  }

  async click(session, selector) {
    const snapshot = await this.snapshot(session);
    await cuaCall(session.command, session.socketPath, 'browser_click', {
      ...session.common,
      ref:findRef(snapshot, selector.label, 'click'),
      input_route:'dom_event',
    });
    return this.snapshot(session);
  }

  async readManagementResult({
    bridgeSession:session,
    origin,
    selectors,
    expectedTitle,
    attempts,
    intervalMs,
    sleep,
  }) {
    const destination = new URL(selectors.result.managementPath, origin);
    if (destination.origin !== origin) {
      throw coded('cua_selector_map_invalid', 'CUA 结果管理页逃逸了官方 origin。');
    }
    await cuaCall(session.command, session.socketPath, 'browser_navigate', {
      ...session.common,
      url:destination.href,
    });

    let last = null;
    let managementSnapshot = null;
    let usedAttempts = 0;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      usedAttempts += 1;
      last = await this.snapshot(session);
      const normalized = cuaSemanticSnapshot.normalize(last, origin, selectors);
      if (cuaSemanticSnapshot.stopReason(normalized.raw, selectors.stopPatterns)) return last;
      if (cuaSemanticSnapshot.managementEntryReady(normalized.raw, selectors.result, expectedTitle)) {
        const titleSnapshot = await this.snapshot(session, 'semantic_v2', {
          query:expectedTitle,
        });
        const ref = findExactRef(titleSnapshot, expectedTitle, 'click');
        managementSnapshot = last;
        await cuaCall(session.command, session.socketPath, 'browser_click', {
          ...session.common,
          ref,
          input_route:'dom_event',
        });
        break;
      }
      if (attempt + 1 < attempts && intervalMs > 0) await sleep(intervalMs);
    }
    if (!managementSnapshot) return last;

    let detailSnapshot = await this.snapshot(session);
    while (true) {
      const combined = cuaSemanticSnapshot.combineManagementEvidence(managementSnapshot, detailSnapshot);
      const normalized = cuaSemanticSnapshot.normalize(combined, origin, selectors);
      if (
        cuaSemanticSnapshot.stopReason(normalized.raw, selectors.stopPatterns)
        || cuaSemanticSnapshot.hasManagementEvidence(normalized.raw, selectors.result)
        || usedAttempts >= attempts
      ) {
        return combined;
      }
      usedAttempts += 1;
      if (intervalMs > 0) await sleep(intervalMs);
      detailSnapshot = await this.snapshot(session);
    }
  }

  async close(session) {
    await stopBridgeSession(session);
  }
}

async function verifyCuaPreflight(command) {
  const manifest = cuaSemanticSnapshot.parseJson(await run(command, ['manifest', '--pretty']), 'cua-driver manifest');
  const permissions = cuaSemanticSnapshot.parseJson(
    await run(command, ['permissions', 'status', '--json']),
    'cua-driver permissions status',
  );
  if (!versionAtLeast(manifest.binary_version, MINIMUM_CUA_DRIVER_VERSION)) {
    throw coded('cua_driver_version_unsupported', `需要 cua-driver >= ${MINIMUM_CUA_DRIVER_VERSION}。`);
  }
  if (permissions?.source?.bundle_id !== EXPECTED_TCC_IDENTITY) {
    throw coded('cua_identity_mismatch', 'CuaDriver 权限身份不是 com.trycua.driver。');
  }
  if (permissions?.accessibility !== true) {
    throw coded('accessibility_required', 'CuaDriver 尚未获得辅助功能权限。');
  }
  if (permissions?.screen_recording !== true || permissions?.screen_recording_capturable === false) {
    throw coded('screen_recording_required', 'CuaDriver 尚未获得屏幕录制权限。');
  }
}

async function findBrowserPid(explicitPid) {
  const output = await run('/bin/ps', ['-axo', 'pid=,comm=']);
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (
      match
      && KNOWN_BROWSER_EXECUTABLES.has(match[2])
      && (!explicitPid || Number(match[1]) === explicitPid)
    ) {
      return { pid:Number(match[1]), executable:match[2] };
    }
  }
  if (explicitPid) throw coded('unsupported_browser_pid', '指定 PID 不是已审核的 Chromium 主进程。');
  throw coded('supported_browser_not_running', '未发现已运行的 Chrome、Chromium 或 Edge 主进程。');
}

function normalizeBrowserIdentity(value) {
  if (
    !Number.isInteger(value?.pid)
    || value.pid <= 0
    || !KNOWN_BROWSER_EXECUTABLES.has(value?.executable)
  ) {
    throw coded('unsupported_browser_pid', '浏览器解析器必须返回已审核 Chromium 的 PID 和绝对可执行路径。');
  }
  return value;
}

async function run(command, args, options = {}) {
  const result = await execFileAsync(command, args, {
    encoding:'utf8',
    maxBuffer:8 * 1024 * 1024,
    ...options,
  });
  return result.stdout.trim();
}

async function cuaCall(command, socketPath, tool, input) {
  const output = await run(command, [
    'call',
    '--socket',
    socketPath,
    tool,
    JSON.stringify(input),
  ]);
  return cuaSemanticSnapshot.unwrap(cuaSemanticSnapshot.parseJson(output, tool));
}

async function waitForDaemon(command, socketPath, daemon) {
  let lastError = '';
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (daemon.exitCode !== null) {
      throw coded('cua_daemon_failed', `bounded CuaDriver 启动失败：${lastError || `exit ${daemon.exitCode}`}`);
    }
    try {
      await run(command, ['status', '--socket', socketPath]);
      return;
    } catch (error) {
      lastError = error.stderr || error.message;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw coded('cua_daemon_timeout', `bounded CuaDriver 未在 3 秒内就绪：${lastError}`);
}

async function waitForBrowserWindow(command, socketPath, preparedPid) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const windows = await cuaCall(command, socketPath, 'list_windows', { pid:preparedPid });
    const windowId = findBestBrowserWindowId(windows, preparedPid);
    if (windowId) return windowId;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw coded('prepared_browser_window_missing', '隔离浏览器未在5秒内返回可绑定窗口。');
}

function findBestBrowserWindowId(value, preparedPid) {
  const candidates = [];
  cuaSemanticSnapshot.walk(value, (item) => {
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
        score:(item.is_on_screen === true ? 1_000_000_000 : 0) + width * height,
      });
    }
    return false;
  });
  candidates.sort((left, right) => right.score - left.score);
  return candidates[0]?.windowId;
}

async function stopBridgeSession(session) {
  if (session.daemon?.exitCode === null) {
    await cuaCall(session.command, session.socketPath, 'end_session', {
      session:session.sessionId,
    }).catch(() => undefined);
    await run(session.command, ['stop', '--socket', session.socketPath]).catch(() => undefined);
  }
  await fs.rm(session.runtimeDirectory, { recursive:true, force:true });
}

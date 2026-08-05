import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  CUA_PLATFORM_ORIGINS,
  CUA_PUBLISH_ACTIONS,
  CUA_RUNNER_SCHEMA,
} from './cua-connector.js';
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
  validateApprovedProfileLease,
  validateApprovedSelectorBundle,
} from './cua-trust-contracts.js';

const execFileAsync = promisify(execFile);
const EXPECTED_TCC_IDENTITY = 'com.trycua.driver';
const MAX_MEDIA_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_STOP_PATTERNS = Object.freeze({
  captcha:['验证码', 'captcha'],
  identity_verification:['身份验证', '实名认证', 'verify your identity'],
  account_switch:['切换账号', '账号已切换', 'switch account'],
  risk_control:['风控', '操作频繁', '异常操作', 'risk control'],
  platform_violation:['违规', '内容不符合规范', 'violation'],
});
const KNOWN_BROWSER_EXECUTABLES = new Set(SUPPORTED_BROWSER_EXECUTABLES);

export class CuaDriverPublisherRunner {
  constructor({
    enabled = false,
    selectorMaps = {},
    selectorBundles = {},
    profileLease = null,
    bridge = new CuaDriverCliBridge(),
    temporaryRoot = os.tmpdir(),
    clock = () => new Date(),
    resultPollAttempts = 20,
    resultPollIntervalMs = 250,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {}) {
    this.enabled = enabled === true;
    if (
      Object.keys(selectorMaps || {}).length > 0
      && Object.keys(selectorBundles || {}).length > 0
    ) {
      throw coded('cua_selector_source_conflict', '不能同时注入未批准 selector map 和已批准 selector bundle。');
    }
    this.selectorMaps = { ...selectorMaps };
    this.selectorBundles = { ...selectorBundles };
    this.profileLease = profileLease ? { ...profileLease } : null;
    this.bridge = bridge;
    this.temporaryRoot = temporaryRoot;
    this.clock = clock;
    if (
      !Number.isInteger(resultPollAttempts)
      || resultPollAttempts < 1
      || resultPollAttempts > 40
      || !Number.isInteger(resultPollIntervalMs)
      || resultPollIntervalMs < 0
      || resultPollIntervalMs > 1_000
      || typeof sleep !== 'function'
    ) {
      throw coded('cua_result_poll_invalid', '发布结果轮询必须是最多40次、每次最多1秒的只读有界轮询。');
    }
    this.resultPollAttempts = resultPollAttempts;
    this.resultPollIntervalMs = resultPollIntervalMs;
    this.sleep = sleep;
    this.sessions = new Map();
    const profileMode = this.profileLease ? 'isolated_named' : 'isolated_new';
    this.contract = Object.freeze({
      schemaVersion:CUA_RUNNER_SCHEMA,
      profileMode,
      profileName:this.profileLease?.profileName || null,
      accountIdentityVerification:this.profileLease
        ? 'page_identity_sha256'
        : 'unverified',
      selectorTrust:Object.keys(this.selectorBundles).length > 0
        ? 'approved_bundle'
        : 'unapproved',
      allowedActions:Object.freeze([...CUA_PUBLISH_ACTIONS]),
      arbitraryDesktop:false,
    });
  }

  async beginSession(input = {}) {
    if (!this.enabled) {
      throw coded('cua_runner_disabled', 'CuaDriver runner 默认关闭，尚未获得单独启用批准。');
    }
    const profile = validateBeginInput(input, this.contract, this.profileLease, this.clock);
    const approvedBundle = this.selectorBundles[input.platform]
      ? validateApprovedSelectorBundle(this.selectorBundles[input.platform], {
        platform:input.platform,
        origin:input.origin,
        clock:this.clock,
      })
      : null;
    const selectors = validateSelectorMap(
      approvedBundle
        ? {
          ...approvedBundle.selectorMap,
          platform:approvedBundle.platform,
          origin:approvedBundle.origin,
          selectorBundle:{
            bundleVersion:approvedBundle.bundleVersion,
            approvalRef:approvedBundle.approval.approvalRef,
            selectorChecksum:approvedBundle.approval.selectorChecksum,
            expiresAt:approvedBundle.approval.expiresAt,
          },
        }
        : this.selectorMaps[input.platform],
      input.platform,
      input.origin,
    );
    const directory = await fs.mkdtemp(path.join(this.temporaryRoot, 'm5-cua-runner-'));
    await fs.chmod(directory, 0o700);
    const sessionId = `m5-cua-${crypto.randomUUID()}`;

    try {
      const bridgeSession = await this.bridge.open({
        sessionId,
        platform:input.platform,
        origin:input.origin,
        readableDirectory:directory,
        selectors,
        profileMode:profile.mode,
        profileName:profile.name || null,
      });
      const initial = normalizeSnapshot(
        await this.bridge.snapshot(bridgeSession),
        input.origin,
        selectors,
      );
      const stopReason = detectStopReason(initial.raw, selectors.stopPatterns);
      if (stopReason) {
        await this.bridge.close(bridgeSession).catch(() => undefined);
        await fs.rm(directory, { recursive:true, force:true });
        return {
          sessionId,
          observation:stopObservation(input.origin, stopReason),
        };
      }
      if (!verifyPageAccountIdentity(
        initial.raw,
        selectors.identity,
        profile.identityClaim,
      )) {
        await this.bridge.close(bridgeSession).catch(() => undefined);
        await fs.rm(directory, { recursive:true, force:true });
        return {
          sessionId,
          observation:stopObservation(input.origin, 'account_switch'),
        };
      }
      this.sessions.set(sessionId, {
        bridgeSession,
        directory,
        origin:input.origin,
        platform:input.platform,
        selectors,
        profile,
        accountIdentityVerified:true,
        nextActionIndex:0,
      });
      return {
        sessionId,
        observation:{
          kind:'ok',
          pageState:initial.pageState === 'editing' ? 'editing' : 'ready',
          origin:initial.origin,
        },
      };
    } catch (error) {
      await fs.rm(directory, { recursive:true, force:true });
      throw error;
    }
  }

  async perform(input = {}) {
    const session = this.sessions.get(String(input.sessionId || ''));
    if (!session) throw coded('cua_session_missing', 'CUA session 不存在或已经结束。');
    validatePerformInput(input, session);

    const before = normalizeSnapshot(
      await this.bridge.snapshot(session.bridgeSession),
      session.origin,
      session.selectors,
    );
    const beforeStop = detectStopReason(before.raw, session.selectors.stopPatterns);
    if (beforeStop) return stopObservation(session.origin, beforeStop);

    const action = input.action;
    let result;
    if (action === 'upload_media') {
      const media = await materializeMediaLease({
        directory:session.directory,
        mediaLease:input.input?.mediaLease,
        verifiedMedia:input.input?.verifiedMedia,
      });
      result = await this.bridge.upload(
        session.bridgeSession,
        session.selectors.actions.upload_media,
        media.file,
      );
    } else if (action === 'set_title' || action === 'set_body') {
      result = await this.bridge.type(
        session.bridgeSession,
        session.selectors.actions[action],
        String(input.input?.text || ''),
      );
    } else if (action === 'set_tags') {
      const tags = Array.isArray(input.input?.tags) ? input.input.tags : [];
      result = await this.bridge.type(
        session.bridgeSession,
        session.selectors.actions.set_tags,
        tags.length > 0 ? ` ${tags.join(' ')}` : '',
      );
    } else if (action === 'submit_publish') {
      result = await this.bridge.click(
        session.bridgeSession,
        session.selectors.actions.submit_publish,
      );
    } else {
      const pollInput = {
        bridge:this.bridge,
        bridgeSession:session.bridgeSession,
        origin:session.origin,
        selectors:session.selectors,
        attempts:this.resultPollAttempts,
        intervalMs:this.resultPollIntervalMs,
        sleep:this.sleep,
      };
      result = session.selectors.result.mode === 'management_detail'
        && typeof this.bridge.readManagementResult === 'function'
        ? await this.bridge.readManagementResult({
          ...pollInput,
          expectedTitle:input.input?.expectedTitle,
        })
        : await pollPublishedResult(pollInput);
    }

    const after = normalizeSnapshot(result, session.origin, session.selectors);
    const stopReason = detectStopReason(after.raw, session.selectors.stopPatterns);
    if (stopReason) return stopObservation(session.origin, stopReason);

    session.nextActionIndex += 1;
    if (action === 'read_result') {
      const published = parsePublishedResult(
        after.raw,
        session.selectors,
        this.clock,
        input.input?.expectedTitle,
      );
      if (!published) return stopObservation(session.origin, 'unknown_page');
      return {
        kind:'ok',
        pageState:'published',
        origin:after.origin,
        accountIdentityVerified:session.accountIdentityVerified === true,
        ...published,
      };
    }
    return {
      kind:'ok',
      pageState:action === 'submit_publish' ? 'submitted' : 'editing',
      origin:after.origin,
    };
  }

  async endSession(input = {}) {
    const sessionId = String(input.sessionId || '');
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    try {
      await this.bridge.close(session.bridgeSession);
    } finally {
      await fs.rm(session.directory, { recursive:true, force:true });
    }
  }
}

async function pollPublishedResult({
  bridge,
  bridgeSession,
  origin,
  selectors,
  attempts,
  intervalMs,
  sleep,
}) {
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await bridge.snapshot(bridgeSession);
    const normalized = normalizeSnapshot(last, origin, selectors);
    if (
      normalized.origin !== origin
      || normalized.pageState === 'published'
      || detectStopReason(normalized.raw, selectors.stopPatterns)
    ) {
      return last;
    }
    if (attempt + 1 < attempts && intervalMs > 0) await sleep(intervalMs);
  }
  return last;
}

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
      const targetId = findString(binding, 'target_id');
      const tabId = findString(binding, 'tab_id');
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
      } else if (!flattenText(semanticSnapshot).toLowerCase().includes(
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
      const normalized = normalizeSnapshot(last, origin, selectors);
      if (detectStopReason(normalized.raw, selectors.stopPatterns)) return last;
      if (isManagementEntryReady(normalized.raw, selectors.result, expectedTitle)) {
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
      const combined = combineManagementEvidence(managementSnapshot, detailSnapshot);
      const normalized = normalizeSnapshot(combined, origin, selectors);
      if (
        detectStopReason(normalized.raw, selectors.stopPatterns)
        || hasManagementEvidence(normalized.raw, selectors.result)
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

async function materializeMediaLease({ directory, mediaLease, verifiedMedia }) {
  if (
    mediaLease?.immutableLease !== true
    || typeof mediaLease?.createReadStream !== 'function'
    || !/^sha256:[a-f0-9]{64}$/.test(String(verifiedMedia?.checksum || ''))
    || !Number.isInteger(verifiedMedia?.bytes)
    || verifiedMedia.bytes < 0
    || verifiedMedia.bytes > MAX_MEDIA_BYTES
  ) {
    throw coded('invalid_cua_media_lease', 'CUA 上传需要审核哈希绑定的不可变媒体 lease。');
  }
  const file = path.join(directory, 'media-upload');
  const handle = await fs.open(file, 'wx', 0o400);
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of mediaLease.createReadStream()) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_MEDIA_BYTES) throw coded('cua_media_too_large', 'CUA 上传文件不得超过 2 GiB。');
      hash.update(buffer);
      await handle.write(buffer);
    }
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.rm(file, { force:true });
    throw error;
  }
  await handle.close();
  const checksum = `sha256:${hash.digest('hex')}`;
  if (checksum !== verifiedMedia.checksum || bytes !== verifiedMedia.bytes) {
    await fs.rm(file, { force:true });
    throw coded('cua_media_verification_failed', 'CUA 上传临时副本与审核哈希或字节数不一致。');
  }
  return { file, checksum, bytes };
}

function validateBeginInput(input, contract, profileLease, clock) {
  const expectedOrigin = CUA_PLATFORM_ORIGINS[input.platform];
  const actionsMatch = Array.isArray(input.allowedActions)
    && input.allowedActions.length === CUA_PUBLISH_ACTIONS.length
    && input.allowedActions.every((action, index) => action === CUA_PUBLISH_ACTIONS[index]);
  if (
    !expectedOrigin
    || input.origin !== expectedOrigin
    || input.profile?.mode !== contract.profileMode
    || (contract.profileMode === 'isolated_named'
      && input.profile?.name !== contract.profileName)
    || (contract.profileMode === 'isolated_new' && input.profile?.name)
    || !actionsMatch
  ) {
    throw coded('cua_begin_input_invalid', 'CUA session 只允许精确官方 origin、独立 Profile 和固定六步动作。');
  }
  if (contract.profileMode === 'isolated_named') {
    const approved = validateApprovedProfileLease(profileLease, {
      platform:input.platform,
      accountRef:input.accountRef,
      clock,
    });
    return {
      mode:'isolated_named',
      name:approved.profileName,
      identityClaim:approved.identityClaim,
    };
  }
  return { mode:'isolated_new' };
}

function validatePerformInput(input, session) {
  const expectedAction = CUA_PUBLISH_ACTIONS[session.nextActionIndex];
  if (
    input.platform !== session.platform
    || input.expectedOrigin !== session.origin
    || input.action !== expectedAction
  ) {
    throw coded('cua_action_sequence_invalid', 'CUA 发布动作越权、跨平台或顺序不正确。');
  }
}

function validateSelectorMap(selectors, platform, origin) {
  const resultMode = selectors?.result?.mode || 'direct';
  const managementResultValid = resultMode !== 'management_detail' || (
    typeof selectors?.result?.managementPath === 'string'
    && selectors.result.managementPath.startsWith('/')
    && !selectors.result.managementPath.startsWith('//')
    && !selectors.result.managementPath.includes('\\')
    && typeof selectors?.result?.managementReadyText === 'string'
    && selectors.result.managementReadyText.trim()
    && Array.isArray(selectors?.result?.publishedStatusTexts)
    && selectors.result.publishedStatusTexts.length > 0
    && selectors.result.publishedStatusTexts.length <= 5
    && selectors.result.publishedStatusTexts.every((item) => (
      typeof item === 'string' && item.trim() && item.length <= 40
    ))
  );
  if (
    !selectors
    || selectors.platform !== platform
    || selectors.origin !== origin
    || typeof selectors.path !== 'string'
    || !selectors.identity?.accountTextPattern
    || !selectors.actions
    || !selectors.actions.upload_media?.label
    || !selectors.actions.set_title?.label
    || !selectors.actions.set_body?.label
    || !selectors.actions.set_tags?.label
    || !selectors.actions.submit_publish?.label
    || !selectors.result?.successText
    || !selectors.result?.contentIdPattern
    || !selectors.result?.evidencePathPrefix
    || !['direct', 'management_detail'].includes(resultMode)
    || !managementResultValid
  ) {
    throw coded(
      'cua_selector_map_missing',
      `${platform} 尚无经过审核的官方创作页 selector map，真实 CUA 保持关闭。`,
    );
  }
  let pattern;
  let identityPattern;
  try {
    pattern = new RegExp(selectors.result.contentIdPattern);
    identityPattern = new RegExp(selectors.identity.accountTextPattern, 'i');
  } catch {
    throw coded('cua_selector_map_invalid', 'CUA selector map 的账号或内容 ID 规则无效。');
  }
  if (
    !pattern.source
    || pattern.flags.includes('g')
    || !identityPattern.source
    || identityPattern.flags.includes('g')
  ) {
    throw coded('cua_selector_map_invalid', 'CUA selector map 的内容 ID 规则不能为空或使用全局匹配。');
  }
  const evidence = new URL(selectors.result.evidencePathPrefix, origin);
  if (evidence.origin !== origin) {
    throw coded('cua_selector_map_invalid', 'CUA selector map 的发布证据路径逃逸了官方 origin。');
  }
  return {
    ...selectors,
    identity:{ ...selectors.identity, accountTextRegex:identityPattern },
    stopPatterns:normalizeStopPatterns(selectors.stopPatterns),
    result:{ ...selectors.result, mode:resultMode, contentIdRegex:pattern },
  };
}

function normalizeSnapshot(value, expectedOrigin, selectors) {
  const raw = unwrapCuaPayload(value);
  const origin = findOrigin(raw);
  if (origin !== expectedOrigin) {
    return { raw, origin:origin || '', pageState:'unknown' };
  }
  const text = flattenText(raw);
  return {
    raw,
    origin,
    pageState:text.includes(selectors.result.successText) ? 'published' : 'editing',
  };
}

function detectStopReason(value, configured = {}) {
  const text = flattenText(value).toLowerCase();
  for (const [reason, patterns] of Object.entries(configured)) {
    if (patterns.some((pattern) => text.includes(pattern.toLowerCase()))) return reason;
  }
  return null;
}

function normalizeStopPatterns(configured = {}) {
  const output = {};
  for (const [reason, defaults] of Object.entries(DEFAULT_STOP_PATTERNS)) {
    const extra = Array.isArray(configured[reason]) ? configured[reason] : [];
    output[reason] = [...new Set([...defaults, ...extra].map(String).filter(Boolean))];
  }
  return output;
}

function parsePublishedResult(raw, selectors, clock, expectedTitle) {
  const text = flattenText(raw);
  const isManagementResult = selectors.result.mode === 'management_detail';
  if (isManagementResult) {
    if (!isManagementEntryReady(raw, selectors.result, expectedTitle)) return null;
  } else if (!text.includes(selectors.result.successText)) return null;
  if (typeof expectedTitle !== 'string' || !expectedTitle.trim() || !text.includes(expectedTitle.trim())) {
    return null;
  }
  const pageUrl = findPageUrl(raw);
  if (!pageUrl) return null;
  const evidence = new URL(pageUrl);
  const contentId = `${text} ${evidence.href}`.match(selectors.result.contentIdRegex)?.[0];
  if (!contentId) return null;
  if (evidence.origin !== selectors.origin) return null;
  if (isManagementResult) {
    if (
      !evidence.pathname.startsWith(selectors.result.evidencePathPrefix)
      || !evidence.href.includes(contentId)
    ) return null;
  } else {
    const expectedPath = `${selectors.result.evidencePathPrefix}${encodeURIComponent(contentId)}`;
    if (!evidence.pathname.startsWith(expectedPath)) return null;
  }
  const observedAt = clock().toISOString();
  return {
    externalContentId:contentId,
    evidence:evidence.href,
    evidenceSnapshotHash:`sha256:${crypto.createHash('sha256')
      .update(JSON.stringify({ url:evidence.href, text }))
      .digest('hex')}`,
    selectorBundleVersion:selectors.selectorBundle?.bundleVersion || null,
    observedAt,
    publishedAt:observedAt,
  };
}

function isManagementEntryReady(raw, result, expectedTitle) {
  if (typeof expectedTitle !== 'string' || !expectedTitle.trim()) return false;
  const text = flattenText(raw);
  return text.includes(result.managementReadyText)
    && text.includes(expectedTitle.trim())
    && result.publishedStatusTexts.some((status) => text.includes(status));
}

function hasManagementEvidence(raw, result) {
  const pageUrl = findPageUrl(raw);
  if (!pageUrl) return false;
  const evidence = new URL(pageUrl);
  const contentId = `${flattenText(raw)} ${evidence.href}`.match(result.contentIdRegex)?.[0];
  return Boolean(
    contentId
    && evidence.pathname.startsWith(result.evidencePathPrefix)
    && evidence.href.includes(contentId)
  );
}

function combineManagementEvidence(managementSnapshot, detailSnapshot) {
  return {
    managementEvidence:withoutPageUrls(unwrapCuaPayload(managementSnapshot)),
    detailEvidence:unwrapCuaPayload(detailSnapshot),
  };
}

function withoutPageUrls(value) {
  if (Array.isArray(value)) return value.map(withoutPageUrls);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !['url', 'page_url', 'pageUrl'].includes(key))
      .map(([key, item]) => [key, withoutPageUrls(item)]),
  );
}

function verifyPageAccountIdentity(raw, identity, claim) {
  if (
    identity?.accountTextRegex instanceof RegExp === false
    || claim?.kind !== 'page_identity_sha256'
    || !/^sha256:[a-f0-9]{64}$/.test(String(claim?.value || ''))
  ) {
    return false;
  }
  const text = flattenText(raw);
  const matches = [...text.matchAll(cloneGlobal(identity.accountTextRegex))]
    .map((match) => String(match[1] || '').trim().toLowerCase())
    .filter(Boolean);
  const unique = [...new Set(matches)];
  if (unique.length !== 1) return false;
  const actual = `sha256:${crypto.createHash('sha256').update(unique[0]).digest('hex')}`;
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(claim.value));
}

function cloneGlobal(pattern) {
  return new RegExp(pattern.source, `${pattern.flags.replaceAll('g', '')}g`);
}

function stopObservation(origin, reason) {
  return { kind:'stop', reason, pageState:'stopped', origin };
}

async function verifyCuaPreflight(command) {
  const manifest = parseJson(await run(command, ['manifest', '--pretty']), 'cua-driver manifest');
  const permissions = parseJson(
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
  return unwrapCuaPayload(parseJson(output, tool));
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

function parseJson(value, label) {
  try {
    return JSON.parse(String(value).trim());
  } catch {
    throw coded('invalid_cua_output', `${label} 未返回可解析的 JSON。`);
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

export function parseBrowserPrepareResult(value) {
  const prepared = unwrapCuaPayload(value);
  const refusalEnvelope = walk(prepared, (item) => (
    item
    && typeof item === 'object'
    && (
      item.status === 'refused'
      || (item.refusal && typeof item.refusal === 'object')
    )
  ));
  if (refusalEnvelope) {
    const refusal = refusalEnvelope.refusal;
    const code = (
      typeof refusal?.code === 'string'
      && /^[a-z][a-z0-9_]{2,80}$/.test(refusal.code.trim())
    )
      ? refusal.code.trim()
      : 'browser_prepare_refused';
    const message = (
      typeof refusal?.message === 'string'
      && refusal.message.trim()
      && refusal.message.trim().length <= 500
    )
      ? refusal.message.trim()
      : 'CuaDriver 拒绝准备隔离浏览器。';
    throw coded(code, message);
  }
  const preparedPid = findNumber(prepared, 'prepared_pid');
  if (!preparedPid) {
    throw coded('prepared_browser_pid_missing', 'CuaDriver 未返回隔离浏览器 PID。');
  }
  return preparedPid;
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

function findNumber(value, key) {
  const found = walk(value, (item) => (
    item && typeof item === 'object' && Number.isInteger(item[key])
  ));
  return found?.[key];
}

function findString(value, key) {
  const found = walk(value, (item) => (
    item && typeof item === 'object' && typeof item[key] === 'string'
  ));
  return found?.[key];
}

function findOrigin(value) {
  const pageUrl = findPageUrl(value);
  return pageUrl ? new URL(pageUrl).origin : null;
}

function findPageUrl(value) {
  const matches = [];
  walkAll(value, (item) => {
    if (!item || typeof item !== 'object') return;
    for (const key of ['url', 'page_url', 'pageUrl']) {
      if (typeof item[key] !== 'string') continue;
      try {
        const candidate = new URL(item[key]);
        if (['http:', 'https:'].includes(candidate.protocol)) matches.push(candidate.href);
      } catch {
        // Ignore malformed values; ambiguity or absence fails closed below.
      }
    }
  });
  const unique = [...new Set(matches)];
  return unique.length === 1 ? unique[0] : null;
}

function findRef(value, expectedName, action) {
  const target = expectedName.toLowerCase();
  const matches = [];
  walkAll(value, (item) => {
    if (!item || typeof item !== 'object' || typeof item.ref !== 'string') return false;
    const name = [
      item.name,
      item.accessible_name,
      item.label,
      item.text,
      item.description,
    ].filter(Boolean).join(' ').toLowerCase();
    const actions = Array.isArray(item.actions) ? item.actions : [];
    if (name.includes(target) && actions.includes(action)) matches.push(item);
    return false;
  });
  const uniqueRefs = [...new Set(matches.map((item) => item.ref))];
  if (uniqueRefs.length === 0) {
    throw coded('browser_ref_missing', `页面快照中未找到“${expectedName}”的 ${action} ref。`);
  }
  if (uniqueRefs.length !== 1) {
    throw coded('browser_ref_ambiguous', `页面中“${expectedName}”的 ${action} ref 不唯一，拒绝猜测。`);
  }
  return uniqueRefs[0];
}

export function findExactRef(value, expectedName, action) {
  const target = String(expectedName || '').trim().toLowerCase();
  const matches = [];
  walkAll(value, (item) => {
    if (!item || typeof item !== 'object' || typeof item.ref !== 'string') return;
    const names = [
      item.name,
      item.accessible_name,
      item.label,
      item.text,
      item.description,
    ].filter((name) => typeof name === 'string')
      .map((name) => name.trim().toLowerCase());
    const actions = Array.isArray(item.actions) ? item.actions : [];
    if (target && names.includes(target) && actions.includes(action)) matches.push(item.ref);
  });
  const uniqueRefs = [...new Set(matches)];
  if (uniqueRefs.length === 0) {
    throw coded('browser_ref_missing', `页面快照中未找到标题精确为“${expectedName}”的 ${action} ref。`);
  }
  if (uniqueRefs.length !== 1) {
    throw coded('browser_ref_ambiguous', `页面中标题精确为“${expectedName}”的 ${action} ref 不唯一，拒绝猜测。`);
  }
  return uniqueRefs[0];
}

export function findFileInputRef(value) {
  const matches = [];
  walkAll(value, (item) => {
    if (!item || typeof item !== 'object' || typeof item.ref !== 'string') return;
    const node = String(item.node || '').toLowerCase();
    const label = String(item.label || '');
    if (
      node === 'input'
      && /(?:^|\s)type\s*=\s*(?:file|"file"|'file')(?:\s|$)/i.test(label)
    ) {
      matches.push(item.ref);
    }
  });
  const uniqueRefs = [...new Set(matches)];
  if (uniqueRefs.length === 0) {
    throw coded('browser_ref_missing', '页面快照中未找到唯一的文件上传 input ref。');
  }
  if (uniqueRefs.length !== 1) {
    throw coded('browser_ref_ambiguous', '页面中存在多个文件上传 input ref，拒绝猜测。');
  }
  return uniqueRefs[0];
}

export function findRichTextInputRef(value) {
  const matches = [];
  walkAll(value, (item) => {
    if (!item || typeof item !== 'object' || typeof item.ref !== 'string') return;
    const node = String(item.node || '').toLowerCase();
    const label = String(item.label || '');
    if (node === 'div' && /(?:^|\s)role\s*=\s*textbox(?:\s|$)/i.test(label)) {
      matches.push(item.ref);
    }
  });
  const uniqueRefs = [...new Set(matches)];
  if (uniqueRefs.length === 0) {
    throw coded('browser_ref_missing', '页面快照中未找到唯一的富文本正文 ref。');
  }
  if (uniqueRefs.length !== 1) {
    throw coded('browser_ref_ambiguous', '页面中存在多个富文本正文 ref，拒绝猜测。');
  }
  return uniqueRefs[0];
}

function walkAll(value, visit) {
  visit(value);
  if (Array.isArray(value)) {
    for (const item of value) walkAll(item, visit);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) walkAll(item, visit);
  }
}

function flattenText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(flattenText).join(' ');
  if (value && typeof value === 'object') return Object.values(value).map(flattenText).join(' ');
  return '';
}

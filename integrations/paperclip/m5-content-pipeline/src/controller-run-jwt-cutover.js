import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export const PAPERCLIP_CONTROLLER_CUTOVER_VERSION = '2026.722.0';
export const PAPERCLIP_CONTROLLER_API_BASE = 'http://127.0.0.1:3100';
export const CONTROLLER_RUN_JWT_APPLY_CONFIRMATION =
  'I_ACCEPT_M5_CONTROLLER_RUN_JWT_APPLY';
export const CONTROLLER_RUN_JWT_ROLLBACK_CONFIRMATION =
  'I_ACCEPT_M5_CONTROLLER_RUN_JWT_ROLLBACK';
export const CONTROLLER_RUN_JWT_SNAPSHOT_SCHEMA =
  'agent.army/m5-controller-run-jwt-snapshot/v1';

export const M5_RUN_JWT_CONTROLLERS = Object.freeze([
  Object.freeze({
    key:'metrics',
    id:'0684369d-9f97-49e9-921c-3c692f441e49',
    adapterType:'http',
    url:'http://127.0.0.1:4321/api/paperclip/m5-metrics-heartbeat',
  }),
  Object.freeze({
    key:'publisher',
    id:'18dd4452-705f-49a1-8aa8-4070429dc33d',
    adapterType:'http',
    url:'http://127.0.0.1:4321/api/paperclip/m5-publisher-heartbeat',
  }),
]);

export class M5ControllerRunJwtCutoverError extends Error {
  constructor(message, { recoveryRequired = false, rollbackErrors = [] } = {}) {
    super(message);
    this.name = 'M5ControllerRunJwtCutoverError';
    this.recoveryRequired = recoveryRequired;
    this.rollbackErrors = rollbackErrors;
  }
}

export class PaperclipControllerClient {
  constructor({
    apiBase = PAPERCLIP_CONTROLLER_API_BASE,
    fetchImpl = fetch,
  } = {}) {
    if (canonicalOrigin(apiBase) !== PAPERCLIP_CONTROLLER_API_BASE) {
      throw cutoverError(
        `控制器部署只允许 ${PAPERCLIP_CONTROLLER_API_BASE}。`,
      );
    }
    this.apiBase = PAPERCLIP_CONTROLLER_API_BASE;
    this.fetchImpl = fetchImpl;
  }

  async getVersion() {
    const health = await this.#request('GET', '/api/health');
    return String(health?.version || health?.serverVersion || '');
  }

  async getController(id) {
    return this.#request('GET', `/api/agents/${id}`);
  }

  async updateController(id, adapterConfig) {
    return this.#request('PATCH', `/api/agents/${id}`, { adapterConfig });
  }

  async #request(method, pathname, body) {
    const response = await this.fetchImpl(`${this.apiBase}${pathname}`, {
      method,
      headers:{
        accept:'application/json',
        ...(body === undefined ? {} : { 'content-type':'application/json' }),
      },
      ...(body === undefined ? {} : { body:JSON.stringify(body) }),
      redirect:'manual',
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw cutoverError(
        `Paperclip ${method} ${pathname} 失败：HTTP ${response.status}。`,
      );
    }
    return parsed;
  }
}

export async function snapshotControllerRunJwtCutover({
  client,
  snapshotPath,
  now = () => new Date(),
  fileSystem = fs,
} = {}) {
  assertClient(client);
  await assertPaperclipVersion(client);
  const controllers = [];
  for (const declared of M5_RUN_JWT_CONTROLLERS) {
    const current = await client.getController(declared.id);
    controllers.push(snapshotController(current, declared));
  }
  const payload = {
    schemaVersion:CONTROLLER_RUN_JWT_SNAPSHOT_SCHEMA,
    paperclipVersion:PAPERCLIP_CONTROLLER_CUTOVER_VERSION,
    apiOrigin:PAPERCLIP_CONTROLLER_API_BASE,
    createdAt:validIsoDate(now),
    controllers,
  };
  const snapshot = {
    ...payload,
    snapshotSha256:sha256(canonicalJson(payload)),
  };
  await writePrivateSnapshot(
    snapshotPath,
    snapshot,
    fileSystem,
  );
  return {
    status:'snapshotted',
    snapshotPath:path.resolve(snapshotPath),
    snapshotSha256:snapshot.snapshotSha256,
    controllerCount:controllers.length,
    writesToPaperclip:0,
  };
}

export async function applyControllerRunJwtCutover({
  client,
  snapshotPath,
  confirmation,
  fileSystem = fs,
} = {}) {
  if (confirmation !== CONTROLLER_RUN_JWT_APPLY_CONFIRMATION) {
    throw cutoverError(
      `apply 必须显式确认 ${CONTROLLER_RUN_JWT_APPLY_CONFIRMATION}。`,
    );
  }
  assertClient(client);
  await assertPaperclipVersion(client);
  const snapshot = await readTrustedSnapshot(snapshotPath, fileSystem);
  const current = await readAndValidateCurrentSet(client, snapshot, {
    allowedStates:['original'],
  });
  try {
    for (const item of snapshot.controllers) {
      await assertControllerState(client, item, 'original');
      await client.updateController(item.id, targetAdapterConfig(item));
      await assertControllerState(client, item, 'target');
    }
  } catch (error) {
    const rollbackErrors = await restoreSetToSnapshot(client, snapshot);
    if (rollbackErrors.length) {
      throw cutoverError(
        `forwardRunJwt apply 失败且逆序回滚不完整：${safeMessage(error)}`,
        { recoveryRequired:true, rollbackErrors },
      );
    }
    throw cutoverError(
      `forwardRunJwt apply 失败；两个控制器已按逆序恢复：${safeMessage(error)}`,
    );
  }
  return {
    status:'applied',
    snapshotSha256:snapshot.snapshotSha256,
    changedControllers:current.map((item) => item.id),
  };
}

export async function rollbackControllerRunJwtCutover({
  client,
  snapshotPath,
  confirmation,
  fileSystem = fs,
} = {}) {
  if (confirmation !== CONTROLLER_RUN_JWT_ROLLBACK_CONFIRMATION) {
    throw cutoverError(
      `rollback 必须显式确认 ${CONTROLLER_RUN_JWT_ROLLBACK_CONFIRMATION}。`,
    );
  }
  assertClient(client);
  await assertPaperclipVersion(client);
  const snapshot = await readTrustedSnapshot(snapshotPath, fileSystem);
  const before = await readAndValidateCurrentSet(client, snapshot, {
    allowedStates:['original', 'target'],
  });
  const changed = [];
  try {
    for (const item of [...snapshot.controllers].reverse()) {
      const state = before.find((candidate) => candidate.id === item.id);
      if (state.state === 'original') continue;
      await assertControllerState(client, item, state.state);
      changed.push({ item, before:state });
      await client.updateController(item.id, item.adapterConfig);
      await assertControllerState(client, item, 'original');
    }
  } catch (error) {
    const rollbackErrors = await restoreRollbackAttempt(client, changed);
    if (rollbackErrors.length) {
      throw cutoverError(
        `forwardRunJwt rollback 失败且补偿不完整：${safeMessage(error)}`,
        { recoveryRequired:true, rollbackErrors },
      );
    }
    throw cutoverError(
      `forwardRunJwt rollback 失败；已恢复 rollback 前状态：${safeMessage(error)}`,
    );
  }
  return {
    status:changed.length ? 'rolled_back' : 'already_rolled_back',
    snapshotSha256:snapshot.snapshotSha256,
    changedControllers:changed.map(({ item }) => item.id),
  };
}

function snapshotController(current, declared) {
  const normalized = validateController(current, declared);
  if (normalized.forwardRunJwt === true) {
    throw cutoverError(`${declared.key} 已启用 forwardRunJwt，拒绝覆盖部署基线。`);
  }
  return {
    key:declared.key,
    id:declared.id,
    adapterType:declared.adapterType,
    adapterConfig:normalized.adapterConfig,
    configSha256:configSha(declared.adapterType, normalized.adapterConfig),
    targetConfigSha256:configSha(
      declared.adapterType,
      targetAdapterConfig({ adapterConfig:normalized.adapterConfig }),
    ),
  };
}

async function readAndValidateCurrentSet(client, snapshot, { allowedStates }) {
  const current = [];
  for (const item of snapshot.controllers) {
    const declared = declarationFor(item);
    const normalized = validateController(
      await client.getController(item.id),
      declared,
    );
    const sha = configSha(declared.adapterType, normalized.adapterConfig);
    const state = sha === item.configSha256
      ? 'original'
      : sha === item.targetConfigSha256
        ? 'target'
        : 'drift';
    if (!allowedStates.includes(state)) {
      throw cutoverError(`${item.key} 控制器存在未知配置漂移，拒绝写入。`);
    }
    current.push({ id:item.id, state, adapterConfig:normalized.adapterConfig });
  }
  return current;
}

async function assertControllerState(client, item, expected) {
  const declared = declarationFor(item);
  const normalized = validateController(
    await client.getController(item.id),
    declared,
  );
  const expectedSha = expected === 'target'
    ? item.targetConfigSha256
    : item.configSha256;
  if (configSha(declared.adapterType, normalized.adapterConfig) !== expectedSha) {
    throw cutoverError(`${item.key} 控制器回读校验失败。`);
  }
}

async function restoreSetToSnapshot(client, snapshot) {
  const errors = [];
  for (const item of [...snapshot.controllers].reverse()) {
    try {
      const declared = declarationFor(item);
      const normalized = validateController(
        await client.getController(item.id),
        declared,
      );
      const currentSha = configSha(declared.adapterType, normalized.adapterConfig);
      if (currentSha === item.configSha256) continue;
      if (currentSha !== item.targetConfigSha256) {
        throw cutoverError(`${item.key} 回滚前出现未知配置漂移。`);
      }
      await client.updateController(item.id, item.adapterConfig);
      await assertControllerState(client, item, 'original');
    } catch (error) {
      errors.push(`${item.key}:${safeMessage(error)}`);
    }
  }
  return errors;
}

async function restoreRollbackAttempt(client, changed) {
  const errors = [];
  for (const { item, before } of [...changed].reverse()) {
    try {
      if (before.state !== 'target') continue;
      await client.updateController(item.id, targetAdapterConfig(item));
      await assertControllerState(client, item, 'target');
    } catch (error) {
      errors.push(`${item.key}:${safeMessage(error)}`);
    }
  }
  return errors;
}

function validateController(current, declared) {
  if (!isRecord(current) || current.id !== declared.id) {
    throw cutoverError(`${declared.key} 控制器 ID 不匹配。`);
  }
  if (current.adapterType !== declared.adapterType) {
    throw cutoverError(`${declared.key} 控制器 adapterType 必须为 http。`);
  }
  const adapterConfig = current.adapterConfig;
  if (!isRecord(adapterConfig)) {
    throw cutoverError(`${declared.key} 控制器 adapterConfig 无效。`);
  }
  assertExactKeys(
    adapterConfig,
    ['url', 'forwardRunJwt'],
    `${declared.key} adapterConfig`,
    { optional:['forwardRunJwt'] },
  );
  if (adapterConfig.url !== declared.url) {
    throw cutoverError(`${declared.key} 控制器 URL 不匹配固定 loopback 路径。`);
  }
  if (
    'forwardRunJwt' in adapterConfig
    && typeof adapterConfig.forwardRunJwt !== 'boolean'
  ) {
    throw cutoverError(`${declared.key} forwardRunJwt 必须是布尔值。`);
  }
  return {
    adapterConfig:structuredClone(adapterConfig),
    forwardRunJwt:adapterConfig.forwardRunJwt === true,
  };
}

function targetAdapterConfig(item) {
  return { ...structuredClone(item.adapterConfig), forwardRunJwt:true };
}

function configSha(adapterType, adapterConfig) {
  return sha256(canonicalJson({ adapterType, adapterConfig }));
}

async function assertPaperclipVersion(client) {
  const version = await client.getVersion();
  if (version !== PAPERCLIP_CONTROLLER_CUTOVER_VERSION) {
    throw cutoverError(
      `只允许 Paperclip ${PAPERCLIP_CONTROLLER_CUTOVER_VERSION}，当前为 ${version || 'unknown'}。`,
    );
  }
}

async function writePrivateSnapshot(
  snapshotPath,
  snapshot,
  fileSystem,
) {
  const target = safeAbsolutePath(snapshotPath);
  const parent = path.dirname(target);
  const parentState = await fileSystem.lstat(parent).catch(() => null);
  if (!parentState?.isDirectory() || parentState.isSymbolicLink()) {
    throw cutoverError('快照父目录不存在或不是安全目录。');
  }
  const realParent = await fileSystem.realpath(parent);
  if (path.dirname(target) !== realParent) {
    throw cutoverError('快照父目录真实路径不匹配。');
  }
  const directoryHandle = await openNoFollow(
    fileSystem,
    parent,
    fsConstants.O_RDONLY | requiredFsFlag('O_DIRECTORY') | requiredFsFlag('O_NOFOLLOW'),
    '快照父目录无法安全打开。',
  );
  let temporaryHandle = null;
  let temporaryPath = '';
  let temporaryIdentity = null;
  let published = false;
  let pinnedCleaner = null;
  try {
    const openedParent = await directoryHandle.stat();
    assertDirectoryIdentity(parentState, openedParent);
    await assertStableParent(fileSystem, parent, openedParent);
    pinnedCleaner = await openPinnedDirectoryCleaner(
      parent,
      openedParent,
      fileSystem.__controllerRunJwtCleanerOptions,
    );
    const existing = await fileSystem.lstat(target).catch(() => null);
    if (existing) throw cutoverError('快照路径已存在，拒绝覆盖。');
    await assertStableParent(fileSystem, parent, openedParent);

    temporaryPath = path.join(
      parent,
      `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    temporaryHandle = await openNoFollow(
      fileSystem,
      temporaryPath,
      fsConstants.O_WRONLY
        | fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | requiredFsFlag('O_NOFOLLOW'),
      '快照临时文件无法安全创建。',
      0o600,
    );
    temporaryIdentity = await temporaryHandle.stat();
    assertPrivateRegularFile(temporaryIdentity);
    await assertOpenFilePath(
      fileSystem,
      temporaryPath,
      temporaryIdentity,
      '快照临时文件身份发生漂移。',
    );
    await temporaryHandle.writeFile(
      `${JSON.stringify(snapshot, null, 2)}\n`,
      { encoding:'utf8' },
    );
    await temporaryHandle.sync();
    const writtenIdentity = await temporaryHandle.stat();
    assertPrivateRegularFile(writtenIdentity);
    if (!sameFileIdentity(temporaryIdentity, writtenIdentity)) {
      throw cutoverError('快照临时文件写入期间身份发生漂移。');
    }
    temporaryIdentity = writtenIdentity;
    await assertStableParent(fileSystem, parent, openedParent);
    if (await fileSystem.lstat(target).catch(() => null)) {
      throw cutoverError('快照路径在发布前已存在，拒绝覆盖。');
    }
    await assertOpenFilePath(
      fileSystem,
      temporaryPath,
      temporaryIdentity,
      '快照临时文件发布前身份发生漂移。',
    );

    // 同目录 hard-link 是 no-replace 的原子发布；POSIX rename 会覆盖并发创建的目标。
    await fileSystem.link(temporaryPath, target);
    published = true;
    await assertStableParent(fileSystem, parent, openedParent);
    await assertOpenFilePath(
      fileSystem,
      target,
      temporaryIdentity,
      '快照发布后身份发生漂移。',
    );
    await directoryHandle.sync();
    await pinnedCleaner.cleanup([
      cleanupEntry(path.basename(temporaryPath), temporaryIdentity),
    ]);
    temporaryPath = '';
    await directoryHandle.sync();
    await assertStableParent(fileSystem, parent, openedParent);
    await assertOpenFilePath(
      fileSystem,
      target,
      temporaryIdentity,
      '快照发布完成后身份发生漂移。',
    );
    await pinnedCleaner.close();
    pinnedCleaner = null;
  } catch (error) {
    const cleanupEntries = [
      ...(published
        ? [cleanupEntry(path.basename(target), temporaryIdentity)]
        : []),
      ...(temporaryPath
        ? [cleanupEntry(path.basename(temporaryPath), temporaryIdentity)]
        : []),
    ];
    try {
      if (pinnedCleaner) {
        await pinnedCleaner.cleanup(cleanupEntries);
      } else {
        if (published) {
          await unlinkIfSameFile(fileSystem, target, temporaryIdentity);
        }
        if (temporaryPath) {
          await unlinkIfSameFile(fileSystem, temporaryPath, temporaryIdentity);
        }
      }
    } catch (cleanupError) {
      throw cutoverError(
        `快照安全落盘失败且原目录清理不完整：${safeMessage(cleanupError)}`,
        { recoveryRequired:true },
      );
    }
    if (error instanceof M5ControllerRunJwtCutoverError) throw error;
    throw cutoverError('快照安全落盘失败。');
  } finally {
    let cleanerCloseError = null;
    try {
      await pinnedCleaner?.close();
    } catch (error) {
      cleanerCloseError = error;
    }
    await temporaryHandle?.close().catch(() => undefined);
    await directoryHandle.close().catch(() => undefined);
    if (cleanerCloseError) throw cleanerCloseError;
  }
}

const DEFAULT_CLEANER_MESSAGE_TIMEOUT_MS = 2_000;
const DEFAULT_CLEANER_CLOSE_TIMEOUT_MS = 1_000;
const DEFAULT_CLEANER_TERM_TIMEOUT_MS = 500;
const DEFAULT_CLEANER_KILL_TIMEOUT_MS = 1_000;

const PINNED_DIRECTORY_CLEANER_SOURCE = String.raw`
  const fs = require('node:fs');
  const parent = fs.statSync('.');
  process.send({
    type:'ready',
    dev:String(parent.dev),
    ino:String(parent.ino),
  });
  process.on('message', (message) => {
    if (message?.type === 'close') {
      process.disconnect();
      return;
    }
    if (message?.type !== 'cleanup' || !Array.isArray(message.entries)) {
      process.send({ type:'result', requestId:message?.requestId, errors:['invalid-command'] });
      return;
    }
    const errors = [];
    for (const entry of message.entries) {
      try {
        if (
          typeof entry?.name !== 'string'
          || entry.name !== require('node:path').basename(entry.name)
          || entry.name === '.'
          || entry.name === '..'
        ) {
          throw new Error('invalid-name');
        }
        let state;
        try {
          state = fs.lstatSync(entry.name);
        } catch (error) {
          if (error?.code === 'ENOENT') continue;
          throw error;
        }
        if (
          !state.isFile()
          || state.isSymbolicLink()
          || String(state.dev) !== entry.dev
          || String(state.ino) !== entry.ino
        ) {
          throw new Error('identity-mismatch');
        }
        fs.unlinkSync(entry.name);
      } catch (error) {
        errors.push(String(error?.message || error));
      }
    }
    process.send({ type:'result', requestId:message.requestId, errors });
  });
`;

async function openPinnedDirectoryCleaner(
  parent,
  expectedState,
  {
    spawnImpl = spawn,
    onReady,
    messageTimeoutMs = DEFAULT_CLEANER_MESSAGE_TIMEOUT_MS,
    closeTimeoutMs = DEFAULT_CLEANER_CLOSE_TIMEOUT_MS,
    termTimeoutMs = DEFAULT_CLEANER_TERM_TIMEOUT_MS,
    killTimeoutMs = DEFAULT_CLEANER_KILL_TIMEOUT_MS,
  } = {},
) {
  const timeouts = validateCleanerTimeouts({
    messageTimeoutMs,
    closeTimeoutMs,
    termTimeoutMs,
    killTimeoutMs,
  });
  const child = spawnImpl(
    process.execPath,
    ['-e', PINNED_DIRECTORY_CLEANER_SOURCE],
    {
      cwd:parent,
      stdio:['ignore', 'ignore', 'ignore', 'ipc'],
    },
  );
  const ready = await waitForCleanerMessage(
    child,
    (message) => message?.type === 'ready',
    timeouts.messageTimeoutMs,
    '快照原目录清理器启动超时。',
  ).catch(async () => {
    await terminateCleanerChild(child, timeouts);
    throw cutoverError('快照原目录清理器无法安全启动。');
  });
  if (
    ready.dev !== String(expectedState.dev)
    || ready.ino !== String(expectedState.ino)
  ) {
    await terminateCleanerChild(child, timeouts);
    throw cutoverError('快照原目录清理器父目录身份发生漂移。');
  }
  await onReady?.(child);
  let closed = false;
  return {
    async cleanup(entries) {
      if (entries.length === 0) return;
      if (closed) throw cutoverError('快照原目录清理器已关闭，清理未确认。');
      const requestId = crypto.randomUUID();
      let result;
      try {
        result = await requestCleanerMessage(
          child,
          { type:'cleanup', requestId, entries },
          (message) =>
            message?.type === 'result' && message.requestId === requestId,
          timeouts.messageTimeoutMs,
          '快照原目录清理确认超时。',
        );
      } catch (error) {
        closed = true;
        await terminateCleanerChild(child, timeouts);
        throw error;
      }
      if (result.errors.length > 0) {
        throw cutoverError(`原目录相对清理失败：${result.errors.join(',')}`);
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await closeCleanerChild(child, timeouts);
    },
  };
}

function validateCleanerTimeouts(timeouts) {
  for (const [name, value] of Object.entries(timeouts)) {
    if (!Number.isInteger(value) || value < 1 || value > 30_000) {
      throw cutoverError(`${name} 必须是 1 到 30000 毫秒的整数。`);
    }
  }
  return timeouts;
}

function cleanupEntry(name, state) {
  if (!state || !validFileIdentity(state)) {
    throw cutoverError('原目录清理缺少可信文件身份。');
  }
  return {
    name,
    dev:String(state.dev),
    ino:String(state.ino),
  };
}

function waitForCleanerMessage(child, predicate, timeoutMs, timeoutMessage) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(cutoverError(timeoutMessage));
    }, timeoutMs);
    const onMessage = (message) => {
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onExit = () => {
      cleanup();
      reject(cutoverError('快照原目录清理器意外退出。'));
    };
    const onError = () => {
      cleanup();
      reject(cutoverError('快照原目录清理器执行失败。'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function requestCleanerMessage(
  child,
  message,
  predicate,
  timeoutMs,
  timeoutMessage,
) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(cutoverError(timeoutMessage));
    }, timeoutMs);
    const onMessage = (candidate) => {
      if (!predicate(candidate)) return;
      cleanup();
      resolve(candidate);
    };
    const onExit = () => {
      cleanup();
      reject(cutoverError('快照原目录清理器意外退出。'));
    };
    const onError = () => {
      cleanup();
      reject(cutoverError('快照原目录清理器执行失败。'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
    child.once('error', onError);
    try {
      if (!child.connected) throw new Error('disconnected');
      child.send(message, (error) => {
        if (!error) return;
        cleanup();
        reject(cutoverError('快照原目录清理器 IPC 发送失败。'));
      });
    } catch {
      cleanup();
      reject(cutoverError('快照原目录清理器 IPC 发送失败。'));
    }
  });
}

function sendCleanerMessage(child, message) {
  try {
    if (!child.connected) {
      throw cutoverError('快照原目录清理器 IPC 不可用。');
    }
    child.send(message);
  } catch (error) {
    if (error instanceof M5ControllerRunJwtCutoverError) throw error;
    throw cutoverError('快照原目录清理器 IPC 发送失败。');
  }
}

async function closeCleanerChild(child, timeouts) {
  if (hasCleanerExited(child)) {
    assertCleanerCleanExit(child);
    return;
  }
  sendCleanerMessage(child, { type:'close' });
  if (await waitForCleanerExit(child, timeouts.closeTimeoutMs)) {
    assertCleanerCleanExit(child);
    return;
  }
  await terminateCleanerChild(child, timeouts);
  throw cutoverError('快照原目录清理器未确认正常关闭，已强制退出。');
}

async function terminateCleanerChild(child, timeouts) {
  if (hasCleanerExited(child)) return;
  child.kill('SIGTERM');
  if (await waitForCleanerExit(child, timeouts.termTimeoutMs)) return;
  child.kill('SIGKILL');
  if (await waitForCleanerExit(child, timeouts.killTimeoutMs)) return;
  throw cutoverError('快照原目录清理器强制退出未获确认。');
}

function waitForCleanerExit(child, timeoutMs) {
  if (hasCleanerExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(hasCleanerExited(child));
    }, timeoutMs);
    const onExit = () => {
      cleanup();
      resolve(true);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off('exit', onExit);
    };
    child.once('exit', onExit);
  });
}

function hasCleanerExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function assertCleanerCleanExit(child) {
  if (child.exitCode !== 0 || child.signalCode !== null) {
    throw cutoverError('快照原目录清理器未正常退出。');
  }
}

async function readTrustedSnapshot(snapshotPath, fileSystem) {
  const target = safeAbsolutePath(snapshotPath);
  const state = await fileSystem.lstat(target).catch(() => null);
  if (
    !state?.isFile()
    || state.isSymbolicLink()
    || (state.mode & 0o077) !== 0
  ) {
    throw cutoverError('快照必须是权限不超过 0600 的安全普通文件。');
  }
  if (await fileSystem.realpath(target).catch(() => null) !== target) {
    throw cutoverError('快照真实路径不匹配或父链包含符号链接。');
  }
  const handle = await openNoFollow(
    fileSystem,
    target,
    fsConstants.O_RDONLY | requiredFsFlag('O_NOFOLLOW'),
    '快照无法按 no-follow 模式安全打开。',
  );
  try {
    const openedState = await handle.stat();
    assertPrivateRegularFile(openedState);
    if (!sameFileIdentity(state, openedState)) {
      throw cutoverError('快照在安全打开前身份发生漂移。');
    }
    await assertOpenFilePath(
      fileSystem,
      target,
      openedState,
      '快照路径在读取前发生漂移。',
    );
    const raw = await handle.readFile({ encoding:'utf8' });
    const readState = await handle.stat();
    if (!sameStableFile(openedState, readState)) {
      throw cutoverError('快照读取期间发生漂移。');
    }
    let snapshot;
    try {
      snapshot = JSON.parse(raw);
    } catch {
      throw cutoverError('快照不是有效 JSON。');
    }
    assertNoSecretKeys(snapshot);
    assertExactKeys(snapshot, [
      'schemaVersion',
      'paperclipVersion',
      'apiOrigin',
      'createdAt',
      'controllers',
      'snapshotSha256',
    ], '快照');
    if (
      snapshot.schemaVersion !== CONTROLLER_RUN_JWT_SNAPSHOT_SCHEMA
      || snapshot.paperclipVersion !== PAPERCLIP_CONTROLLER_CUTOVER_VERSION
      || snapshot.apiOrigin !== PAPERCLIP_CONTROLLER_API_BASE
      || !validIsoDateValue(snapshot.createdAt)
      || !Array.isArray(snapshot.controllers)
      || snapshot.controllers.length !== M5_RUN_JWT_CONTROLLERS.length
      || !/^[a-f0-9]{64}$/.test(String(snapshot.snapshotSha256 || ''))
    ) {
      throw cutoverError('快照公共字段无效。');
    }
    const normalizedControllers = snapshot.controllers.map((item) =>
      validateSnapshotController(item));
    const expectedOrder = M5_RUN_JWT_CONTROLLERS.map(({ id }) => id);
    if (
      JSON.stringify(normalizedControllers.map(({ id }) => id))
      !== JSON.stringify(expectedOrder)
    ) {
      throw cutoverError('快照控制器顺序或身份不匹配。');
    }
    const payload = {
      schemaVersion:snapshot.schemaVersion,
      paperclipVersion:snapshot.paperclipVersion,
      apiOrigin:snapshot.apiOrigin,
      createdAt:snapshot.createdAt,
      controllers:normalizedControllers,
    };
    if (sha256(canonicalJson(payload)) !== snapshot.snapshotSha256) {
      throw cutoverError('快照 SHA256 不匹配。');
    }
    const finalState = await handle.stat();
    if (!sameStableFile(readState, finalState)) {
      throw cutoverError('快照在使用前发生漂移。');
    }
    await assertOpenFilePath(
      fileSystem,
      target,
      finalState,
      '快照路径在使用前发生漂移。',
    );
    return { ...payload, snapshotSha256:snapshot.snapshotSha256 };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function openNoFollow(fileSystem, target, flags, message, mode) {
  if (typeof fileSystem?.open !== 'function') throw cutoverError(message);
  try {
    return await fileSystem.open(target, flags, mode);
  } catch {
    throw cutoverError(message);
  }
}

function requiredFsFlag(name) {
  const value = fsConstants[name];
  if (!Number.isInteger(value) || value === 0) {
    throw cutoverError(`当前 Node 平台缺少 ${name}，拒绝执行快照操作。`);
  }
  return value;
}

function assertPrivateRegularFile(state) {
  if (
    !state?.isFile()
    || state.isSymbolicLink?.()
    || (state.mode & 0o077) !== 0
    || !validFileIdentity(state)
  ) {
    throw cutoverError('快照必须是权限不超过 0600 的安全普通文件。');
  }
}

function assertDirectoryIdentity(expected, actual) {
  if (
    !actual?.isDirectory()
    || actual.isSymbolicLink?.()
    || !sameFileIdentity(expected, actual)
  ) {
    throw cutoverError('快照父目录身份发生漂移。');
  }
}

async function assertStableParent(fileSystem, parent, openedState) {
  const current = await fileSystem.lstat(parent).catch(() => null);
  const real = await fileSystem.realpath(parent).catch(() => null);
  if (
    !current?.isDirectory()
    || current.isSymbolicLink()
    || real !== parent
    || !sameFileIdentity(openedState, current)
  ) {
    throw cutoverError('快照父目录在操作期间发生漂移。');
  }
}

async function assertOpenFilePath(fileSystem, target, openedState, message) {
  const current = await fileSystem.lstat(target).catch(() => null);
  const real = await fileSystem.realpath(target).catch(() => null);
  if (
    !current?.isFile()
    || current.isSymbolicLink()
    || real !== target
    || (current.mode & 0o077) !== 0
    || !sameFileIdentity(openedState, current)
  ) {
    throw cutoverError(message);
  }
}

async function unlinkIfSameFile(fileSystem, target, expected) {
  if (!target || !expected) return;
  const current = await fileSystem.lstat(target).catch(() => null);
  if (
    current?.isFile()
    && !current.isSymbolicLink()
    && sameFileIdentity(current, expected)
  ) {
    await fileSystem.unlink(target).catch(() => undefined);
  }
}

function sameFileIdentity(left, right) {
  return validFileIdentity(left)
    && validFileIdentity(right)
    && left.dev === right.dev
    && left.ino === right.ino;
}

function sameStableFile(left, right) {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function validFileIdentity(state) {
  return state
    && (typeof state.dev === 'number' || typeof state.dev === 'bigint')
    && (typeof state.ino === 'number' || typeof state.ino === 'bigint')
    && state.ino !== 0
    && state.ino !== 0n;
}

function validateSnapshotController(item) {
  assertExactKeys(item, [
    'key',
    'id',
    'adapterType',
    'adapterConfig',
    'configSha256',
    'targetConfigSha256',
  ], '快照控制器');
  const declared = M5_RUN_JWT_CONTROLLERS.find(({ id }) => id === item.id);
  if (!declared || item.key !== declared.key || item.adapterType !== 'http') {
    throw cutoverError('快照控制器身份或类型无效。');
  }
  const normalized = validateController({
    id:item.id,
    adapterType:item.adapterType,
    adapterConfig:item.adapterConfig,
  }, declared);
  if (normalized.forwardRunJwt) {
    throw cutoverError('快照原始配置不得已启用 forwardRunJwt。');
  }
  const configSha256 = configSha(item.adapterType, normalized.adapterConfig);
  const targetConfigSha256 = configSha(
    item.adapterType,
    targetAdapterConfig({ adapterConfig:normalized.adapterConfig }),
  );
  if (
    item.configSha256 !== configSha256
    || item.targetConfigSha256 !== targetConfigSha256
  ) {
    throw cutoverError('快照控制器配置 SHA256 不匹配。');
  }
  return {
    key:item.key,
    id:item.id,
    adapterType:item.adapterType,
    adapterConfig:normalized.adapterConfig,
    configSha256,
    targetConfigSha256,
  };
}

function declarationFor(item) {
  const declared = M5_RUN_JWT_CONTROLLERS.find(({ id }) => id === item.id);
  if (!declared || declared.key !== item.key) {
    throw cutoverError('快照控制器不在固定批准清单。');
  }
  return declared;
}

function assertNoSecretKeys(value, pathValue = 'snapshot') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretKeys(item, `${pathValue}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (/(?:secret|token|cookie|password|authorization|api[_-]?key)/i.test(key)) {
      throw cutoverError(`快照包含禁止的敏感字段：${pathValue}.${key}。`);
    }
    assertNoSecretKeys(child, `${pathValue}.${key}`);
  }
}

function assertExactKeys(value, allowed, label, { optional = [] } = {}) {
  if (!isRecord(value)) throw cutoverError(`${label} 必须是对象。`);
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length) throw cutoverError(`${label} 包含未知字段。`);
  const optionalSet = new Set(optional);
  const missing = allowed.filter((key) => !optionalSet.has(key) && !(key in value));
  if (missing.length) throw cutoverError(`${label} 缺少必填字段。`);
}

function safeAbsolutePath(value) {
  const text = String(value || '').trim();
  if (!path.isAbsolute(text) || path.resolve(text) !== text) {
    throw cutoverError('快照路径必须是规范绝对路径。');
  }
  return text;
}

function canonicalOrigin(value) {
  try {
    const url = new URL(String(value || ''));
    if (
      url.protocol !== 'http:'
      || url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash
    ) {
      return '';
    }
    return url.origin;
  } catch {
    return '';
  }
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw cutoverError('快照包含非有限数字。');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  throw cutoverError('快照包含不支持的值。');
}

function validIsoDate(now) {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw cutoverError('快照时钟无效。');
  }
  return value.toISOString();
}

function validIsoDateValue(value) {
  const parsed = new Date(String(value || ''));
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeMessage(error) {
  return String(error?.message || 'unknown')
    .replace(/\s+/g, ' ')
    .slice(0, 240);
}

function assertClient(client) {
  if (
    !client
    || typeof client.getVersion !== 'function'
    || typeof client.getController !== 'function'
    || typeof client.updateController !== 'function'
  ) {
    throw cutoverError('Paperclip 控制器客户端未配置。');
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cutoverError(message, options) {
  return new M5ControllerRunJwtCutoverError(message, options);
}

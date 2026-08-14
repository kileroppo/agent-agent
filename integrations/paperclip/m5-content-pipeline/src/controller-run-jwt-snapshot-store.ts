import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { CONTROLLER_RUN_JWT_SNAPSHOT_SCHEMA, M5ControllerRunJwtCutoverError, M5_RUN_JWT_CONTROLLERS, PAPERCLIP_CONTROLLER_API_BASE, PAPERCLIP_CONTROLLER_CUTOVER_VERSION, controllerRunJwtContract, } from './controller-run-jwt-contract.ts';
const { validateSnapshot: validateSnapshotController } = controllerRunJwtContract.controller;
const { assertNoSecretKeys, assertExactKeys, canonicalJson, validIsoDateValue, sha256, } = controllerRunJwtContract.snapshot;
const { create: cutoverError, safeMessage } = controllerRunJwtContract.errors;
async function writePrivateSnapshot(snapshotPath: any, snapshot: any, fileSystem: any) {
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
    const directoryHandle = await openNoFollow(fileSystem, parent, fsConstants.O_RDONLY | requiredFsFlag('O_DIRECTORY') | requiredFsFlag('O_NOFOLLOW'), '快照父目录无法安全打开。');
    let temporaryHandle = null;
    let temporaryPath = '';
    let temporaryIdentity = null;
    let published = false;
    let pinnedCleaner = null;
    try {
        const openedParent = await directoryHandle.stat();
        assertDirectoryIdentity(parentState, openedParent);
        await assertStableParent(fileSystem, parent, openedParent);
        pinnedCleaner = await openPinnedDirectoryCleaner(parent, openedParent, fileSystem.__controllerRunJwtCleanerOptions);
        const existing = await fileSystem.lstat(target).catch(() => null);
        if (existing)
            throw cutoverError('快照路径已存在，拒绝覆盖。');
        await assertStableParent(fileSystem, parent, openedParent);
        temporaryPath = path.join(parent, `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);
        temporaryHandle = await openNoFollow(fileSystem, temporaryPath, fsConstants.O_WRONLY
            | fsConstants.O_CREAT
            | fsConstants.O_EXCL
            | requiredFsFlag('O_NOFOLLOW'), '快照临时文件无法安全创建。', 0o600);
        temporaryIdentity = await temporaryHandle.stat();
        assertPrivateRegularFile(temporaryIdentity);
        await assertOpenFilePath(fileSystem, temporaryPath, temporaryIdentity, '快照临时文件身份发生漂移。');
        await temporaryHandle.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8' });
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
        await assertOpenFilePath(fileSystem, temporaryPath, temporaryIdentity, '快照临时文件发布前身份发生漂移。');
        // 同目录 hard-link 是 no-replace 的原子发布；POSIX rename 会覆盖并发创建的目标。
        await fileSystem.link(temporaryPath, target);
        published = true;
        await assertStableParent(fileSystem, parent, openedParent);
        await assertOpenFilePath(fileSystem, target, temporaryIdentity, '快照发布后身份发生漂移。');
        await directoryHandle.sync();
        await pinnedCleaner.cleanup([
            cleanupEntry(path.basename(temporaryPath), temporaryIdentity),
        ]);
        temporaryPath = '';
        await directoryHandle.sync();
        await assertStableParent(fileSystem, parent, openedParent);
        await assertOpenFilePath(fileSystem, target, temporaryIdentity, '快照发布完成后身份发生漂移。');
        await pinnedCleaner.close();
        pinnedCleaner = null;
    }
    catch (error: any) {
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
            }
            else {
                if (published) {
                    await unlinkIfSameFile(fileSystem, target, temporaryIdentity);
                }
                if (temporaryPath) {
                    await unlinkIfSameFile(fileSystem, temporaryPath, temporaryIdentity);
                }
            }
        }
        catch (cleanupError: any) {
            throw cutoverError(`快照安全落盘失败且原目录清理不完整：${safeMessage(cleanupError)}`, { recoveryRequired: true });
        }
        if (error instanceof M5ControllerRunJwtCutoverError)
            throw error;
        throw cutoverError('快照安全落盘失败。');
    }
    finally {
        let cleanerCloseError = null;
        try {
            await pinnedCleaner?.close();
        }
        catch (error: any) {
            cleanerCloseError = error;
        }
        await temporaryHandle?.close().catch(() => undefined);
        await directoryHandle.close().catch(() => undefined);
        if (cleanerCloseError)
            throw cleanerCloseError;
    }
}
const DEFAULT_CLEANER_MESSAGE_TIMEOUT_MS = 2000;
const DEFAULT_CLEANER_CLOSE_TIMEOUT_MS = 1000;
const DEFAULT_CLEANER_TERM_TIMEOUT_MS = 500;
const DEFAULT_CLEANER_KILL_TIMEOUT_MS = 1000;
const PINNED_DIRECTORY_CLEANER_SOURCE = String.raw `
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
async function openPinnedDirectoryCleaner(parent: any, expectedState: any, { spawnImpl = spawn, onReady, messageTimeoutMs = DEFAULT_CLEANER_MESSAGE_TIMEOUT_MS, closeTimeoutMs = DEFAULT_CLEANER_CLOSE_TIMEOUT_MS, termTimeoutMs = DEFAULT_CLEANER_TERM_TIMEOUT_MS, killTimeoutMs = DEFAULT_CLEANER_KILL_TIMEOUT_MS, }: any = {}) {
    const timeouts = validateCleanerTimeouts({
        messageTimeoutMs,
        closeTimeoutMs,
        termTimeoutMs,
        killTimeoutMs,
    });
    const child = spawnImpl(process.execPath, ['-e', PINNED_DIRECTORY_CLEANER_SOURCE], {
        cwd: parent,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const ready = await waitForCleanerMessage(child, (message: any) => message?.type === 'ready', timeouts.messageTimeoutMs, '快照原目录清理器启动超时。').catch(async () => {
        await terminateCleanerChild(child, timeouts);
        throw cutoverError('快照原目录清理器无法安全启动。');
    });
    if (ready.dev !== String(expectedState.dev)
        || ready.ino !== String(expectedState.ino)) {
        await terminateCleanerChild(child, timeouts);
        throw cutoverError('快照原目录清理器父目录身份发生漂移。');
    }
    await onReady?.(child);
    let closed = false;
    return {
        async cleanup(entries: any) {
            if (entries.length === 0)
                return;
            if (closed)
                throw cutoverError('快照原目录清理器已关闭，清理未确认。');
            const requestId = crypto.randomUUID();
            let result;
            try {
                result = await requestCleanerMessage(child, { type: 'cleanup', requestId, entries }, (message: any) => message?.type === 'result' && message.requestId === requestId, timeouts.messageTimeoutMs, '快照原目录清理确认超时。');
            }
            catch (error: any) {
                closed = true;
                await terminateCleanerChild(child, timeouts);
                throw error;
            }
            if (result.errors.length > 0) {
                throw cutoverError(`原目录相对清理失败：${result.errors.join(',')}`);
            }
        },
        async close() {
            if (closed)
                return;
            closed = true;
            await closeCleanerChild(child, timeouts);
        },
    };
}
function validateCleanerTimeouts(timeouts: any) {
    for (const [name, value] of Object.entries(timeouts)) {
        if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 30000) {
            throw cutoverError(`${name} 必须是 1 到 30000 毫秒的整数。`);
        }
    }
    return timeouts;
}
function cleanupEntry(name: any, state: any) {
    if (!state || !validFileIdentity(state)) {
        throw cutoverError('原目录清理缺少可信文件身份。');
    }
    return {
        name,
        dev: String(state.dev),
        ino: String(state.ino),
    };
}
function waitForCleanerMessage(child: any, predicate: any, timeoutMs: any, timeoutMessage: any): Promise<any> {
    return new Promise<any>((resolve: any, reject: any) => {
        const timer = setTimeout(() => {
            cleanup();
            reject(cutoverError(timeoutMessage));
        }, timeoutMs);
        const onMessage = (message: any) => {
            if (!predicate(message))
                return;
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
function requestCleanerMessage(child: any, message: any, predicate: any, timeoutMs: any, timeoutMessage: any): Promise<any> {
    return new Promise<any>((resolve: any, reject: any) => {
        const timer = setTimeout(() => {
            cleanup();
            reject(cutoverError(timeoutMessage));
        }, timeoutMs);
        const onMessage = (candidate: any) => {
            if (!predicate(candidate))
                return;
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
            if (!child.connected)
                throw new Error('disconnected');
            child.send(message, (error: any) => {
                if (!error)
                    return;
                cleanup();
                reject(cutoverError('快照原目录清理器 IPC 发送失败。'));
            });
        }
        catch {
            cleanup();
            reject(cutoverError('快照原目录清理器 IPC 发送失败。'));
        }
    });
}
function sendCleanerMessage(child: any, message: any) {
    try {
        if (!child.connected) {
            throw cutoverError('快照原目录清理器 IPC 不可用。');
        }
        child.send(message);
    }
    catch (error: any) {
        if (error instanceof M5ControllerRunJwtCutoverError)
            throw error;
        throw cutoverError('快照原目录清理器 IPC 发送失败。');
    }
}
async function closeCleanerChild(child: any, timeouts: any) {
    if (hasCleanerExited(child)) {
        assertCleanerCleanExit(child);
        return;
    }
    sendCleanerMessage(child, { type: 'close' });
    if (await waitForCleanerExit(child, timeouts.closeTimeoutMs)) {
        assertCleanerCleanExit(child);
        return;
    }
    await terminateCleanerChild(child, timeouts);
    throw cutoverError('快照原目录清理器未确认正常关闭，已强制退出。');
}
async function terminateCleanerChild(child: any, timeouts: any) {
    if (hasCleanerExited(child))
        return;
    child.kill('SIGTERM');
    if (await waitForCleanerExit(child, timeouts.termTimeoutMs))
        return;
    child.kill('SIGKILL');
    if (await waitForCleanerExit(child, timeouts.killTimeoutMs))
        return;
    throw cutoverError('快照原目录清理器强制退出未获确认。');
}
function waitForCleanerExit(child: any, timeoutMs: any) {
    if (hasCleanerExited(child))
        return Promise.resolve(true);
    return new Promise((resolve: any) => {
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
function hasCleanerExited(child: any) {
    return child.exitCode !== null || child.signalCode !== null;
}
function assertCleanerCleanExit(child: any) {
    if (child.exitCode !== 0 || child.signalCode !== null) {
        throw cutoverError('快照原目录清理器未正常退出。');
    }
}
async function readTrustedSnapshot(snapshotPath: any, fileSystem: any) {
    const target = safeAbsolutePath(snapshotPath);
    const state = await fileSystem.lstat(target).catch(() => null);
    if (!state?.isFile()
        || state.isSymbolicLink()
        || (state.mode & 0o077) !== 0) {
        throw cutoverError('快照必须是权限不超过 0600 的安全普通文件。');
    }
    if (await fileSystem.realpath(target).catch(() => null) !== target) {
        throw cutoverError('快照真实路径不匹配或父链包含符号链接。');
    }
    const handle = await openNoFollow(fileSystem, target, fsConstants.O_RDONLY | requiredFsFlag('O_NOFOLLOW'), '快照无法按 no-follow 模式安全打开。');
    try {
        const openedState = await handle.stat();
        assertPrivateRegularFile(openedState);
        if (!sameFileIdentity(state, openedState)) {
            throw cutoverError('快照在安全打开前身份发生漂移。');
        }
        await assertOpenFilePath(fileSystem, target, openedState, '快照路径在读取前发生漂移。');
        const raw = await handle.readFile({ encoding: 'utf8' });
        const readState = await handle.stat();
        if (!sameStableFile(openedState, readState)) {
            throw cutoverError('快照读取期间发生漂移。');
        }
        let snapshot;
        try {
            snapshot = JSON.parse(raw);
        }
        catch {
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
        if (snapshot.schemaVersion !== CONTROLLER_RUN_JWT_SNAPSHOT_SCHEMA
            || snapshot.paperclipVersion !== PAPERCLIP_CONTROLLER_CUTOVER_VERSION
            || snapshot.apiOrigin !== PAPERCLIP_CONTROLLER_API_BASE
            || !validIsoDateValue(snapshot.createdAt)
            || !Array.isArray(snapshot.controllers)
            || snapshot.controllers.length !== M5_RUN_JWT_CONTROLLERS.length
            || !/^[a-f0-9]{64}$/.test(String(snapshot.snapshotSha256 || ''))) {
            throw cutoverError('快照公共字段无效。');
        }
        const normalizedControllers = snapshot.controllers.map((item: any) => validateSnapshotController(item));
        const expectedOrder = M5_RUN_JWT_CONTROLLERS.map(({ id }: any) => id);
        if (JSON.stringify(normalizedControllers.map(({ id }: any) => id))
            !== JSON.stringify(expectedOrder)) {
            throw cutoverError('快照控制器顺序或身份不匹配。');
        }
        const payload = {
            schemaVersion: snapshot.schemaVersion,
            paperclipVersion: snapshot.paperclipVersion,
            apiOrigin: snapshot.apiOrigin,
            createdAt: snapshot.createdAt,
            controllers: normalizedControllers,
        };
        if (sha256(canonicalJson(payload)) !== snapshot.snapshotSha256) {
            throw cutoverError('快照 SHA256 不匹配。');
        }
        const finalState = await handle.stat();
        if (!sameStableFile(readState, finalState)) {
            throw cutoverError('快照在使用前发生漂移。');
        }
        await assertOpenFilePath(fileSystem, target, finalState, '快照路径在使用前发生漂移。');
        return { ...payload, snapshotSha256: snapshot.snapshotSha256 };
    }
    finally {
        await handle.close().catch(() => undefined);
    }
}
async function openNoFollow(fileSystem: any, target: any, flags: any, message: any, mode: any = undefined) {
    if (typeof fileSystem?.open !== 'function')
        throw cutoverError(message);
    try {
        return await fileSystem.open(target, flags, mode);
    }
    catch {
        throw cutoverError(message);
    }
}
function requiredFsFlag(name: any) {
    const value = (fsConstants as Record<string, number>)[name];
    if (!Number.isInteger(value) || value === 0) {
        throw cutoverError(`当前 Node 平台缺少 ${name}，拒绝执行快照操作。`);
    }
    return value;
}
function assertPrivateRegularFile(state: any) {
    if (!state?.isFile()
        || state.isSymbolicLink?.()
        || (state.mode & 0o077) !== 0
        || !validFileIdentity(state)) {
        throw cutoverError('快照必须是权限不超过 0600 的安全普通文件。');
    }
}
function assertDirectoryIdentity(expected: any, actual: any) {
    if (!actual?.isDirectory()
        || actual.isSymbolicLink?.()
        || !sameFileIdentity(expected, actual)) {
        throw cutoverError('快照父目录身份发生漂移。');
    }
}
async function assertStableParent(fileSystem: any, parent: any, openedState: any) {
    const current = await fileSystem.lstat(parent).catch(() => null);
    const real = await fileSystem.realpath(parent).catch(() => null);
    if (!current?.isDirectory()
        || current.isSymbolicLink()
        || real !== parent
        || !sameFileIdentity(openedState, current)) {
        throw cutoverError('快照父目录在操作期间发生漂移。');
    }
}
async function assertOpenFilePath(fileSystem: any, target: any, openedState: any, message: any) {
    const current = await fileSystem.lstat(target).catch(() => null);
    const real = await fileSystem.realpath(target).catch(() => null);
    if (!current?.isFile()
        || current.isSymbolicLink()
        || real !== target
        || (current.mode & 0o077) !== 0
        || !sameFileIdentity(openedState, current)) {
        throw cutoverError(message);
    }
}
async function unlinkIfSameFile(fileSystem: any, target: any, expected: any) {
    if (!target || !expected)
        return;
    const current = await fileSystem.lstat(target).catch(() => null);
    if (current?.isFile()
        && !current.isSymbolicLink()
        && sameFileIdentity(current, expected)) {
        await fileSystem.unlink(target).catch(() => undefined);
    }
}
function sameFileIdentity(left: any, right: any) {
    return validFileIdentity(left)
        && validFileIdentity(right)
        && left.dev === right.dev
        && left.ino === right.ino;
}
function sameStableFile(left: any, right: any) {
    return sameFileIdentity(left, right)
        && left.size === right.size
        && left.mtimeMs === right.mtimeMs
        && left.ctimeMs === right.ctimeMs;
}
function validFileIdentity(state: any) {
    return state
        && (typeof state.dev === 'number' || typeof state.dev === 'bigint')
        && (typeof state.ino === 'number' || typeof state.ino === 'bigint')
        && state.ino !== 0
        && state.ino !== 0n;
}
function safeAbsolutePath(value: any) {
    const text = String(value || '').trim();
    if (!path.isAbsolute(text) || path.resolve(text) !== text) {
        throw cutoverError('快照路径必须是规范绝对路径。');
    }
    return text;
}
export const controllerRunJwtSnapshotStore = Object.freeze({
    write: writePrivateSnapshot,
    read: readTrustedSnapshot,
});

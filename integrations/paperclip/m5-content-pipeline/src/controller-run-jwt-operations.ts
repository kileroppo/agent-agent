import fs from 'node:fs/promises';
import path from 'node:path';
import { CONTROLLER_RUN_JWT_APPLY_CONFIRMATION, CONTROLLER_RUN_JWT_ROLLBACK_CONFIRMATION, CONTROLLER_RUN_JWT_SNAPSHOT_SCHEMA, M5_RUN_JWT_CONTROLLERS, PAPERCLIP_CONTROLLER_API_BASE, PAPERCLIP_CONTROLLER_CUTOVER_VERSION, controllerRunJwtContract, } from './controller-run-jwt-contract.ts';
import { controllerRunJwtSnapshotStore } from './controller-run-jwt-snapshot-store.ts';
const { assertClient, assertVersion: assertPaperclipVersion, validate: validateController, declarationFor, targetAdapterConfig, configSha, } = controllerRunJwtContract.controller;
const { canonicalJson, validIsoDate, sha256, } = controllerRunJwtContract.snapshot;
const { create: cutoverError, safeMessage } = controllerRunJwtContract.errors;
const { write: writePrivateSnapshot, read: readTrustedSnapshot, } = controllerRunJwtSnapshotStore;
async function snapshotControllerRunJwtCutover({ client, snapshotPath, now = () => new Date(), fileSystem = fs, }: any = {}) {
    assertClient(client);
    await assertPaperclipVersion(client);
    const controllers = [];
    for (const declared of M5_RUN_JWT_CONTROLLERS) {
        const current = await client.getController(declared.id);
        controllers.push(snapshotController(current, declared));
    }
    const payload = {
        schemaVersion: CONTROLLER_RUN_JWT_SNAPSHOT_SCHEMA,
        paperclipVersion: PAPERCLIP_CONTROLLER_CUTOVER_VERSION,
        apiOrigin: PAPERCLIP_CONTROLLER_API_BASE,
        createdAt: validIsoDate(now),
        controllers,
    };
    const snapshot = {
        ...payload,
        snapshotSha256: sha256(canonicalJson(payload)),
    };
    await writePrivateSnapshot(snapshotPath, snapshot, fileSystem);
    return {
        status: 'snapshotted',
        snapshotPath: path.resolve(snapshotPath),
        snapshotSha256: snapshot.snapshotSha256,
        controllerCount: controllers.length,
        writesToPaperclip: 0,
    };
}
async function applyControllerRunJwtCutover({ client, snapshotPath, confirmation, fileSystem = fs, }: any = {}) {
    if (confirmation !== CONTROLLER_RUN_JWT_APPLY_CONFIRMATION) {
        throw cutoverError(`apply 必须显式确认 ${CONTROLLER_RUN_JWT_APPLY_CONFIRMATION}。`);
    }
    assertClient(client);
    await assertPaperclipVersion(client);
    const snapshot = await readTrustedSnapshot(snapshotPath, fileSystem);
    const current = await readAndValidateCurrentSet(client, snapshot, {
        allowedStates: ['original'],
    });
    try {
        for (const item of snapshot.controllers) {
            await assertControllerState(client, item, 'original');
            await client.updateController(item.id, targetAdapterConfig(item));
            await assertControllerState(client, item, 'target');
        }
    }
    catch (error: any) {
        const rollbackErrors = await restoreSetToSnapshot(client, snapshot);
        if (rollbackErrors.length) {
            throw cutoverError(`forwardRunJwt apply 失败且逆序回滚不完整：${safeMessage(error)}`, { recoveryRequired: true, rollbackErrors });
        }
        throw cutoverError(`forwardRunJwt apply 失败；两个控制器已按逆序恢复：${safeMessage(error)}`);
    }
    return {
        status: 'applied',
        snapshotSha256: snapshot.snapshotSha256,
        changedControllers: current.map((item: any) => item.id),
    };
}
async function rollbackControllerRunJwtCutover({ client, snapshotPath, confirmation, fileSystem = fs, }: any = {}) {
    if (confirmation !== CONTROLLER_RUN_JWT_ROLLBACK_CONFIRMATION) {
        throw cutoverError(`rollback 必须显式确认 ${CONTROLLER_RUN_JWT_ROLLBACK_CONFIRMATION}。`);
    }
    assertClient(client);
    await assertPaperclipVersion(client);
    const snapshot = await readTrustedSnapshot(snapshotPath, fileSystem);
    const before = await readAndValidateCurrentSet(client, snapshot, {
        allowedStates: ['original', 'target'],
    });
    const changed = [];
    try {
        for (const item of [...snapshot.controllers].reverse()) {
            const state = before.find((candidate: any) => candidate.id === item.id);
            if (!state)
                throw cutoverError(`控制器 ${item.id} 不在回滚快照中。`);
            if (state.state === 'original')
                continue;
            await assertControllerState(client, item, state.state);
            changed.push({ item, before: state });
            await client.updateController(item.id, item.adapterConfig);
            await assertControllerState(client, item, 'original');
        }
    }
    catch (error: any) {
        const rollbackErrors = await restoreRollbackAttempt(client, changed);
        if (rollbackErrors.length) {
            throw cutoverError(`forwardRunJwt rollback 失败且补偿不完整：${safeMessage(error)}`, { recoveryRequired: true, rollbackErrors });
        }
        throw cutoverError(`forwardRunJwt rollback 失败；已恢复 rollback 前状态：${safeMessage(error)}`);
    }
    return {
        status: changed.length ? 'rolled_back' : 'already_rolled_back',
        snapshotSha256: snapshot.snapshotSha256,
        changedControllers: changed.map(({ item }: any) => item.id),
    };
}
function snapshotController(current: any, declared: any) {
    const normalized = validateController(current, declared);
    if (normalized.forwardRunJwt === true) {
        throw cutoverError(`${declared.key} 已启用 forwardRunJwt，拒绝覆盖部署基线。`);
    }
    return {
        key: declared.key,
        id: declared.id,
        adapterType: declared.adapterType,
        adapterConfig: normalized.adapterConfig,
        configSha256: configSha(declared.adapterType, normalized.adapterConfig),
        targetConfigSha256: configSha(declared.adapterType, targetAdapterConfig({ adapterConfig: normalized.adapterConfig })),
    };
}
async function readAndValidateCurrentSet(client: any, snapshot: any, { allowedStates }: any) {
    const current = [];
    for (const item of snapshot.controllers) {
        const declared = declarationFor(item);
        const normalized = validateController(await client.getController(item.id), declared);
        const sha = configSha(declared.adapterType, normalized.adapterConfig);
        const state = sha === item.configSha256
            ? 'original'
            : sha === item.targetConfigSha256
                ? 'target'
                : 'drift';
        if (!allowedStates.includes(state)) {
            throw cutoverError(`${item.key} 控制器存在未知配置漂移，拒绝写入。`);
        }
        current.push({ id: item.id, state, adapterConfig: normalized.adapterConfig });
    }
    return current;
}
async function assertControllerState(client: any, item: any, expected: any) {
    const declared = declarationFor(item);
    const normalized = validateController(await client.getController(item.id), declared);
    const expectedSha = expected === 'target'
        ? item.targetConfigSha256
        : item.configSha256;
    if (configSha(declared.adapterType, normalized.adapterConfig) !== expectedSha) {
        throw cutoverError(`${item.key} 控制器回读校验失败。`);
    }
}
async function restoreSetToSnapshot(client: any, snapshot: any) {
    const errors = [];
    for (const item of [...snapshot.controllers].reverse()) {
        try {
            const declared = declarationFor(item);
            const normalized = validateController(await client.getController(item.id), declared);
            const currentSha = configSha(declared.adapterType, normalized.adapterConfig);
            if (currentSha === item.configSha256)
                continue;
            if (currentSha !== item.targetConfigSha256) {
                throw cutoverError(`${item.key} 回滚前出现未知配置漂移。`);
            }
            await client.updateController(item.id, item.adapterConfig);
            await assertControllerState(client, item, 'original');
        }
        catch (error: any) {
            errors.push(`${item.key}:${safeMessage(error)}`);
        }
    }
    return errors;
}
async function restoreRollbackAttempt(client: any, changed: any) {
    const errors = [];
    for (const { item, before } of [...changed].reverse()) {
        try {
            if (before.state !== 'target')
                continue;
            await client.updateController(item.id, targetAdapterConfig(item));
            await assertControllerState(client, item, 'target');
        }
        catch (error: any) {
            errors.push(`${item.key}:${safeMessage(error)}`);
        }
    }
    return errors;
}
export const controllerRunJwtOperations = Object.freeze({
    snapshot: snapshotControllerRunJwtCutover,
    apply: applyControllerRunJwtCutover,
    rollback: rollbackControllerRunJwtCutover,
});

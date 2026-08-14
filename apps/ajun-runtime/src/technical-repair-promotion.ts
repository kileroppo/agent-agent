import crypto from 'node:crypto';
import fsConstants from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
export class TechnicalRepairPromotion {
    allowedWorkspaceRoots: any;
    fs: any;
    projectRoot: any;
    sourceIdentity: any;
    sourceMode: any;
    verifySourceRoot: any;
    constructor({ projectRoot, allowedWorkspaceRoots = [], sourceMode = 'legacy_runtime_git_root', sourceIdentity = null, verifySourceRoot = null, fsImpl = fs, }: any = {}) {
        this.projectRoot = path.resolve(projectRoot || process.cwd());
        this.allowedWorkspaceRoots = allowedWorkspaceRoots.map((item: any): any => path.resolve(item));
        this.sourceMode = sourceMode;
        this.sourceIdentity = sourceIdentity;
        this.verifySourceRoot = verifySourceRoot;
        this.fs = fsImpl;
    }
    async promote(task: any, evidence: any): Promise<any> {
        try {
            if (this.verifySourceRoot)
                await this.verifySourceRoot();
            return await this.promoteVerified(task, evidence);
        }
        catch (error: any) {
            return {
                status: 'rejected',
                reason: error?.message || '源码根或修理副本未通过安全复验。',
            };
        }
    }
    async promoteVerified(task: any, evidence: any): Promise<any> {
        const proof: any = evidence?.metadata?.agentArmyRepairEvidence;
        const workspaceInput: any = String(task.execution?.workspace?.path || '');
        const allowedFiles: any = repairFiles(task);
        const changedFiles: any = Array.isArray(proof?.changedFiles)
            ? proof.changedFiles.map((item: any): any => String(item || '').trim()).filter(Boolean)
            : [];
        if (!workspaceInput
            || proof?.testsPassed !== true
            || proof?.recoveryVerified !== true
            || !changedFiles.length
            || changedFiles.some((item: any): any => !allowedFiles.includes(item))) {
            return {
                status: 'rejected',
                reason: '修复结果缺少完整证据，或改动超出允许范围。',
            };
        }
        const workspace: any = await canonicalAllowedDirectory(this.fs, workspaceInput, this.allowedWorkspaceRoots.length
            ? this.allowedWorkspaceRoots
            : [this.projectRoot]);
        const snapshotPath: any = path.join(workspace, '.agent-army-repair-snapshot.json');
        let snapshot: any;
        try {
            const snapshotFile: any = await readSafeRegularFile(this.fs, workspace, snapshotPath);
            snapshot = JSON.parse(snapshotFile.content.toString('utf8'));
        }
        catch {
            return { status: 'rejected', reason: '缺少修理房创建时的原始记录。' };
        }
        if (snapshot?.version !== 2
            || !sameSourceIdentity(snapshot.sourceIdentity, this.sourceIdentity)
            || snapshot.taskId !== String(task?.taskId || '')) {
            return {
                status: 'rejected',
                reason: '修理房快照不属于当前任务或当前源码根。',
            };
        }
        const candidates: any[] = [];
        for (const relativePath of changedFiles) {
            const source: any = path.join(this.projectRoot, relativePath);
            const candidate: any = path.join(workspace, relativePath);
            const expected: any = snapshot.files?.[relativePath]?.sourceHash;
            if (!expected) {
                return { status: 'rejected', reason: '修理房没有记录该文件的原始状态。' };
            }
            const sourceFile: any = await readSafeRegularFile(this.fs, this.projectRoot, source);
            const candidateFile: any = await readSafeRegularFile(this.fs, workspace, candidate);
            const current: any = sourceFile.content;
            const originalHash: any = hash(current);
            if (originalHash !== expected) {
                return {
                    status: 'conflict',
                    reason: `主工程中的 ${relativePath} 已被其他改动更新，未覆盖。`,
                };
            }
            candidates.push({
                relativePath,
                source,
                sourceIdentity: fileIdentity(sourceFile.stat),
                content: candidateFile.content,
                mode: sourceFile.stat.mode,
                originalHash,
            });
        }
        if (this.verifySourceRoot)
            await this.verifySourceRoot();
        return this.commitAll(candidates);
    }
    async commitAll(candidates: any): Promise<any> {
        const transaction: any = crypto.randomUUID();
        const staged: any[] = [];
        try {
            for (const item of candidates) {
                const temporary: any = `${item.source}.agent-army-new-${transaction}`;
                const backup: any = `${item.source}.agent-army-old-${transaction}`;
                const handle: any = await this.fs.open(temporary, 'wx', item.mode);
                try {
                    await handle.writeFile(item.content);
                    await handle.sync();
                }
                finally {
                    await handle.close();
                }
                staged.push({
                    ...item,
                    temporary,
                    backup,
                    backupCreated: false,
                    replacementCommitted: false,
                    recoveryRequired: false,
                });
            }
            for (const item of staged) {
                const currentFile: any = await readSafeRegularFile(this.fs, this.projectRoot, item.source);
                if (!sameFileIdentity(fileIdentity(currentFile.stat), item.sourceIdentity)) {
                    throw new Error(`${item.relativePath} 在晋升前发生变化，未覆盖。`);
                }
                if (hash(currentFile.content) !== hashFromSnapshotCandidate(item, candidates)) {
                    throw new Error(`${item.relativePath} 在晋升前发生变化，未覆盖。`);
                }
                await this.fs.link(item.source, item.backup);
                item.backupCreated = true;
                const backupStat: any = await this.fs.lstat(item.backup);
                if (!backupStat.isFile()
                    || !sameFileIdentity(fileIdentity(backupStat), item.sourceIdentity)) {
                    throw new Error(`${item.relativePath} 的恢复锚与原文件不一致，未替换。`);
                }
                await this.fs.rename(item.temporary, item.source);
                item.replacementCommitted = true;
            }
            const cleanupWarnings: any[] = [];
            for (const item of staged) {
                try {
                    await this.fs.unlink(item.backup);
                    item.backupCreated = false;
                }
                catch (error: any) {
                    cleanupWarnings.push({
                        file: item.relativePath,
                        backup: item.backup,
                        error: error?.message || String(error),
                    });
                }
            }
            return {
                status: this.sourceMode === 'external_writable_git_root'
                    ? 'candidate_promoted'
                    : 'promoted',
                changedFiles: candidates.map((item: any): any => item.relativePath),
                recommendedCompletionStatus: this.sourceMode === 'external_writable_git_root'
                    ? 'waiting_test'
                    : 'succeeded',
                ...(this.sourceMode === 'external_writable_git_root'
                    ? {
                        nextAction: '候选源码已更新；必须生成并验证新的不可变 release 后才能切换运行版本。',
                    }
                    : {}),
                ...(cleanupWarnings.length ? { cleanupWarnings } : {}),
            };
        }
        catch (error: any) {
            const rollbackFailures: any[] = [];
            for (const item of [...staged].reverse()) {
                if (!item.replacementCommitted)
                    continue;
                try {
                    await this.fs.rename(item.backup, item.source);
                    item.backupCreated = false;
                    item.replacementCommitted = false;
                }
                catch (rollbackError: any) {
                    item.recoveryRequired = true;
                    rollbackFailures.push({
                        file: item.relativePath,
                        backup: item.backup,
                        source: item.source,
                        error: rollbackError?.message || String(rollbackError),
                    });
                }
            }
            return {
                status: rollbackFailures.length ? 'recovery_required' : 'conflict',
                reason: rollbackFailures.length
                    ? '多文件晋升失败且未能完整回滚；必须人工恢复备份。'
                    : (error?.message || '多文件晋升失败，已恢复原文件。'),
                ...(rollbackFailures.length ? { rollbackFailures } : {}),
            };
        }
        finally {
            for (const item of staged) {
                await this.fs.unlink(item.temporary).catch((): any => { });
                if (item.backupCreated
                    && !item.replacementCommitted
                    && !item.recoveryRequired) {
                    await this.fs.unlink(item.backup).catch((): any => { });
                    item.backupCreated = false;
                }
            }
        }
    }
}
function repairFiles(task: any): any {
    return Array.isArray(task?.input?.context?.repairScope?.files)
        ? task.input.context.repairScope.files
            .map((item: any): any => String(item || '').trim())
            .filter((item: any): any => (item
            && !path.isAbsolute(item)
            && !item.split('/').includes('..')))
        : [];
}
async function canonicalAllowedDirectory(fsImpl: any, input: any, allowedRoots: any): Promise<any> {
    if (!path.isAbsolute(input))
        throw new Error('修理副本路径必须是绝对路径。');
    const normalized: any = path.normalize(input);
    const stat: any = await fsImpl.lstat(normalized);
    const canonical: any = await fsImpl.realpath(normalized);
    if (!stat.isDirectory() || stat.isSymbolicLink() || canonical !== normalized) {
        throw new Error('修理副本必须是非符号链接的真实目录。');
    }
    const allowed: any[] = [];
    for (const root of allowedRoots) {
        try {
            allowed.push(await fsImpl.realpath(root));
        }
        catch { }
    }
    if (!allowed.some((root: any): any => isInsideOrSame(canonical, root))) {
        throw new Error('修理副本不在允许目录内。');
    }
    return canonical;
}
async function assertSafeRegularFile(fsImpl: any, root: any, candidate: any): Promise<any> {
    assertInside(candidate, root);
    const relative: any = path.relative(root, candidate);
    let cursor: any = root;
    let result: any;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, segment);
        result = await fsImpl.lstat(cursor);
        if (result.isSymbolicLink())
            throw new Error('修复文件或路径祖先是符号链接。');
        if (cursor !== candidate && !result.isDirectory()) {
            throw new Error('修复文件的路径祖先不是目录。');
        }
    }
    if (!result?.isFile())
        throw new Error('修复对象必须是普通文件。');
    const canonical: any = await fsImpl.realpath(candidate);
    if (canonical !== candidate)
        throw new Error('修复对象没有解析到原始文件。');
    return result;
}
async function readSafeRegularFile(fsImpl: any, root: any, candidate: any): Promise<any> {
    const expected: any = await assertSafeRegularFile(fsImpl, root, candidate);
    const handle: any = await fsImpl.open(candidate, fsConstants.constants.O_RDONLY | fsConstants.constants.O_NOFOLLOW);
    try {
        const stat: any = await handle.stat();
        if (!stat.isFile()
            || stat.dev !== expected.dev
            || stat.ino !== expected.ino) {
            throw new Error('修复文件在读取时发生替换。');
        }
        return { stat, content: await handle.readFile() };
    }
    finally {
        await handle.close();
    }
}
function assertInside(candidate: any, root: any): any {
    if (!isInsideOrSame(candidate, root) || candidate === root) {
        throw new Error('修复对象超出允许工程范围。');
    }
}
function isInsideOrSame(candidate: any, root: any): any {
    const relative: any = path.relative(root, candidate);
    return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
function sameSourceIdentity(actual: any, expected: any): any {
    if (!expected)
        return actual === null;
    return [
        'device',
        'inode',
        'head',
        'gitCommonDir',
        'gitCommonDevice',
        'gitCommonInode',
        'gitDir',
        'gitDirDevice',
        'gitDirInode',
    ].every((key: any): any => actual?.[key] === expected[key]);
}
function fileIdentity(stat: any): any {
    return {
        device: String(stat.dev),
        inode: String(stat.ino),
        size: String(stat.size),
        modifiedNs: String(stat.mtimeNs ?? BigInt(Math.round(stat.mtimeMs * 1e6))),
    };
}
function sameFileIdentity(actual: any, expected: any): any {
    return Object.keys(expected).every((key: any): any => actual[key] === expected[key]);
}
function hashFromSnapshotCandidate(item: any, candidates: any): any {
    const original: any = candidates.find((candidate: any): any => candidate.source === item.source);
    return original?.originalHash || '';
}
function hash(value: any): any {
    return crypto.createHash('sha256').update(value).digest('hex');
}

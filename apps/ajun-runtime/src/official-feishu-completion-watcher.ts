import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { shortTaskRef, taskDetailBaseUrl } from './task-presentation.ts';
import {
    createDeliveryReceipt,
    deliveryRecoveryAction,
    normalizeDeliveryReceipt,
} from './delivery-receipt-state.ts';
/**
 * Keeps the promise A君 makes in Feishu: long work reports its real ending
 * back to the same chat.  It stores only the local task id and chat id, never
 * message text, people data, credentials, or the delivered content itself.
 */
export class OfficialFeishuCompletionWatcher {
    checkInFlight: any;
    deliverySnapshot: any;
    detailBaseUrl: any;
    intervalMs: any;
    leaseMs: any;
    logger: any;
    ownerId: any;
    send: any;
    store: any;
    taskStatus: any;
    timer: any;
    timers: any;
    constructor({ taskStatus, send, store, intervalMs = 3000, leaseMs = 30000, ownerId = crypto.randomUUID(), timers = globalThis, detailBaseUrl = '', logger = console }: any = {}) {
        if (typeof taskStatus !== 'function')
            throw new OfficialFeishuCompletionWatcherError('官方飞书跟进缺少任务状态读取方法。');
        if (typeof send !== 'function')
            throw new OfficialFeishuCompletionWatcherError('官方飞书跟进缺少原会话发送方法。');
        if (!store?.list || !store?.upsert || !store?.remove || !store?.claimDelivery || !store?.completeDelivery || !store?.recoverExpiredDelivery)
            throw new OfficialFeishuCompletionWatcherError('官方飞书跟进缺少可原子领取的本机记录。');
        this.taskStatus = taskStatus;
        this.send = send;
        this.store = store;
        this.intervalMs = intervalMs;
        this.timers = timers;
        this.detailBaseUrl = taskDetailBaseUrl(detailBaseUrl);
        this.logger = logger;
        this.leaseMs = Math.max(1000, Number(leaseMs) || 30000);
        this.ownerId = required(ownerId, '官方飞书跟进缺少投递实例标识。');
        this.timer = null;
        this.checkInFlight = null;
        this.deliverySnapshot = deliveryState([]);
    }
    async start(): Promise<any> {
        await this.check();
        this.timer = this.timers.setInterval((): any => void this.check(), this.intervalMs);
        this.timer?.unref?.();
    }
    stop(): any {
        if (this.timer)
            this.timers.clearInterval(this.timer);
        this.timer = null;
    }
    async watch({ taskId, chatId }: any): Promise<any> {
        const task: any = required(taskId, '官方飞书跟进缺少任务编号。');
        const chat: any = required(chatId, '官方飞书跟进缺少原会话。');
        const existing: any = (await this.store.list()).find((item: any): any => watchKey(item.taskId, item.chatId) === watchKey(task, chat));
        // A duplicated ingress event must never erase an uncertain/delivered
        // receipt and thereby make a second external send possible.
        if (!existing)
            await this.store.upsert({ taskId: task, chatId: chat, lastStatus: null, createdAt: new Date().toISOString() });
    }
    snapshot(): any { return { ...this.deliverySnapshot }; }
    async resolveDelivery({ taskId, chatId, outcome }: any = {}): Promise<any> {
        const task: any = required(taskId, '投递核对缺少任务编号。');
        const chat: any = required(chatId, '投递核对缺少原会话。');
        const decision: any = String(outcome || '').trim();
        if (!['delivered', 'retry'].includes(decision))
            throw new OfficialFeishuCompletionWatcherError('投递核对结果无效。');
        const watch: any = (await this.store.list()).find((item: any): any => watchKey(item.taskId, item.chatId) === watchKey(task, chat));
        const receipt: any = normalizeDeliveryReceipt(watch?.delivery);
        if (!receipt || !['delivery_unknown', 'failed'].includes(receipt.status))
            throw new OfficialFeishuCompletionWatcherError('这条跟进没有等待人工核对的投递。');
        if (receipt.status === 'failed' && decision !== 'retry')
            throw new OfficialFeishuCompletionWatcherError('明确失败的投递只能选择恢复发送。');
        if (decision === 'retry') {
            await this.store.upsert({ ...watch, delivery: createReceipt({ ...receipt, status:'prepared', preparedAt:new Date().toISOString(), errorCode:undefined }), updatedAt: new Date().toISOString() });
        }
        else {
            await this.store.upsert({
                ...watch,
                lastStatus:receipt.targetStatus || watch.lastStatus,
                delivery:createReceipt({
                    ...receipt,
                    status:'delivered',
                    deliveredAt:new Date().toISOString(),
                    errorCode:undefined,
                    evidence:{ type:'manual_delivery_verification', observedAt:new Date().toISOString() },
                }),
                updatedAt:new Date().toISOString(),
            });
        }
        await this.refreshSnapshot();
        return { resolved: true, outcome: decision, taskId: task };
    }
    async check(): Promise<any> {
        if (this.checkInFlight)
            return this.checkInFlight;
        const check: any = this.checkWatches();
        this.checkInFlight = check;
        try {
            return await check;
        }
        finally {
            if (this.checkInFlight === check)
                this.checkInFlight = null;
        }
    }
    async checkWatches(): Promise<any> {
        const watches: any = await this.store.list();
        for (const watch of watches)
            await this.checkOne(watch);
        await this.refreshSnapshot();
    }
    async checkOne(watch: any): Promise<any> {
        try {
            const receipt: any = normalizeDeliveryReceipt(watch.delivery);
            // Read compatibility records once and write them back in the formal
            // contract.  This makes a restart-safe unknown outcome visible to
            // every later reader, not only this in-memory check.
            if (receipt && watch.delivery?.status !== receipt.status) {
                watch = { ...watch, delivery:receipt, updatedAt:new Date().toISOString() };
                await this.store.upsert(watch);
            }
            if (receipt?.status === 'sending') {
                if (leaseActive(receipt))
                    return;
                await this.store.recoverExpiredDelivery({ taskId:watch.taskId, chatId:watch.chatId });
                return;
            }
            if (receipt?.status === 'delivery_unknown' || receipt?.status === 'delivered')
                return;
            // The first failed start is safe to retry once.  A second failed
            // start is no longer background work: keep its evidence and wait
            // for an explicit operator recovery action.
            if (receipt?.status === 'failed' && Number(receipt.attempt || 0) >= 2)
                return;
            const status: any = await this.taskStatus(watch.taskId, watch.chatId);
            const message: any = withTaskLink(status.message, watch.taskId, this.detailBaseUrl);
            const changed: any = watch.lastStatus !== status.status;
            if (status.terminal) {
                await this.deliver(watch, status.status, 'terminal', message);
                return;
            }
            if (changed && shouldReportProgress(status.status)) {
                await this.deliver(watch, status.status, 'progress', message);
                return;
            }
            if (changed)
                await this.store.upsert({ ...watch, lastStatus: status.status, updatedAt: new Date().toISOString() });
        }
        catch {
            // A temporary status/store failure leaves the watch in place. Delivery
            // failures are handled inside deliver(), where ambiguous outcomes must
            // not be retried as if the provider had definitely received nothing.
        }
    }
    async deliver(watch: any, targetStatus: any, kind: any, message: any): Promise<any> {
        const previous: any = normalizeDeliveryReceipt(watch.delivery);
        const nextDeliveryId: any = deliveryId(watch.taskId, watch.chatId, kind, targetStatus);
        const prepared: Record<string, any> = createReceipt({
            deliveryId: nextDeliveryId,
            idempotencyKey: previous?.deliveryId === nextDeliveryId ? previous.idempotencyKey : nextDeliveryId,
            channel:'feishu',
            kind,
            targetStatus: String(targetStatus || ''),
            status:'prepared',
            preparedAt:new Date().toISOString(),
            attempt:(Number(previous?.attempt) || 0) + 1,
        });
        // The claim is file-backed and conditional: separate processes may
        // observe the same task, but only one can begin external I/O.
        const claim: any = await this.store.claimDelivery({
            taskId:watch.taskId, chatId:watch.chatId, delivery:prepared,
            ownerId:this.ownerId, leaseMs:this.leaseMs,
        });
        if (!claim?.claimed)
            return;
        const sendingWatch: Record<string, any> = claim.watch;
        const delivery: Record<string, any> = normalizeDeliveryReceipt(sendingWatch.delivery);
        // `check()` is awaiting external I/O below.  Publish the durable
        // sending state now so concurrent UI/API reads cannot project ready.
        await this.refreshSnapshot();
        try {
            const sent: any = await this.send(watch.chatId, { markdown: message, deliveryId: delivery.deliveryId, idempotencyKey:delivery.idempotencyKey });
            const delivered: any = deliveredReceipt(delivery, sent);
            if (!delivered) {
                await this.markDeliveryUncertain(sendingWatch, safeDeliveryError(sent));
                return;
            }
            await this.store.completeDelivery({ taskId:watch.taskId, chatId:watch.chatId, claimToken:delivery.lease?.token, update:{ lastStatus:targetStatus, delivery:delivered } });
        }
        catch (error: any) {
            if (error?.deliveryState === 'not_started') {
                await this.store.completeDelivery({ taskId:watch.taskId, chatId:watch.chatId, claimToken:delivery.lease?.token, update:{ delivery:createReceipt({ ...delivery, status:'failed', failedAt:new Date().toISOString(), errorCode:safeDeliveryError(error) }) } });
            }
            else {
                await this.markDeliveryUncertain(sendingWatch, safeDeliveryError(error));
            }
            return;
        }
    }
    async markDeliveryUncertain(watch: any, reason: any): Promise<any> {
        const delivery: Record<string, any> = createReceipt({
            ...normalizeDeliveryReceipt(watch.delivery),
            status:'delivery_unknown',
            unknownAt:new Date().toISOString(),
            errorCode:safeDeliveryError(reason),
        });
        await this.store.completeDelivery({ taskId:watch.taskId, chatId:watch.chatId, claimToken:normalizeDeliveryReceipt(watch.delivery)?.lease?.token, update:{ delivery } });
        this.logger.warn?.(`飞书任务 ${watch.taskId} 的完成跟进投递结果不确定；已停止自动重发，等待本机核对。`);
    }
    async refreshSnapshot(): Promise<any> {
        this.deliverySnapshot = deliveryState(await this.store.list());
    }
}
export class OfficialFeishuCompletionWatcherError extends Error {
}
export class FileCompletionWatchStore {
    beforeStaleReclaim: any;
    filePath: any;
    lockLeaseMs: any;
    mutations: any;
    constructor(filePath: any, { lockLeaseMs = 10000, beforeStaleReclaim = null }: any = {}) {
        this.filePath = filePath;
        this.lockLeaseMs = Math.max(25, Number(lockLeaseMs) || 10000);
        this.beforeStaleReclaim = beforeStaleReclaim;
        this.mutations = Promise.resolve();
    }
    async list(): Promise<any> { await this.mutations.catch((): any => undefined); return (await this.read()).watches; }
    async upsert(input: any): Promise<any> {
        return this.mutate(async (): Promise<any> => this.withFileLock(async (): Promise<any> => {
            const data: any = await this.read();
            const key: any = watchKey(input.taskId, input.chatId);
            const index: any = data.watches.findIndex((item: any): any => watchKey(item.taskId, item.chatId) === key);
            if (index >= 0)
                data.watches[index] = { ...data.watches[index], ...input };
            else
                data.watches.push(input);
            await this.write(data);
        }));
    }
    async remove(taskId: any, chatId: any): Promise<any> {
        return this.mutate(async (): Promise<any> => this.withFileLock(async (): Promise<any> => {
            const data: any = await this.read();
            data.watches = data.watches.filter((item: any): any => watchKey(item.taskId, item.chatId) !== watchKey(taskId, chatId));
            await this.write(data);
        }));
    }
    async claimDelivery({ taskId, chatId, delivery, ownerId, leaseMs = 30000 }: any): Promise<any> {
        return this.mutate(async (): Promise<any> => this.withFileLock(async (): Promise<any> => {
            const data: any = await this.read();
            const index: any = data.watches.findIndex((item: any): any => watchKey(item.taskId, item.chatId) === watchKey(taskId, chatId));
            if (index < 0) return { claimed:false, reason:'watch_missing' };
            const current: any = normalizeDeliveryReceipt(data.watches[index].delivery);
            if (current?.status === 'sending') {
                if (leaseActive(current)) return { claimed:false, reason:'lease_held' };
                data.watches[index] = uncertainWatch(data.watches[index], current, 'process_interrupted');
                await this.write(data);
                return { claimed:false, reason:'lease_expired' };
            }
            if (current?.status === 'delivered' || current?.status === 'delivery_unknown' || (current?.status === 'failed' && Number(current.attempt || 0) >= 2))
                return { claimed:false, reason:'not_deliverable' };
            const lease: any = {
                owner:required(ownerId, '投递租约缺少实例标识。'), token:crypto.randomUUID(),
                expiresAt:new Date(Date.now() + Math.max(1000, Number(leaseMs) || 30000)).toISOString(),
            };
            const sending: any = createReceipt({ ...delivery, status:'sending', sendingAt:new Date().toISOString(), lease });
            const watch: any = { ...data.watches[index], delivery:sending, updatedAt:new Date().toISOString() };
            data.watches[index] = watch;
            await this.write(data);
            return { claimed:true, watch };
        }));
    }
    async completeDelivery({ taskId, chatId, claimToken, update }: any): Promise<any> {
        return this.mutate(async (): Promise<any> => this.withFileLock(async (): Promise<any> => {
            const data: any = await this.read();
            const index: any = data.watches.findIndex((item: any): any => watchKey(item.taskId, item.chatId) === watchKey(taskId, chatId));
            const current: any = index >= 0 ? normalizeDeliveryReceipt(data.watches[index].delivery) : null;
            if (!current || current.status !== 'sending' || !claimToken || current.lease?.token !== claimToken)
                return { completed:false, reason:'lease_lost' };
            data.watches[index] = { ...data.watches[index], ...update, updatedAt:new Date().toISOString() };
            await this.write(data);
            return { completed:true, watch:data.watches[index] };
        }));
    }
    async recoverExpiredDelivery({ taskId, chatId }: any): Promise<any> {
        return this.mutate(async (): Promise<any> => this.withFileLock(async (): Promise<any> => {
            const data: any = await this.read();
            const index: any = data.watches.findIndex((item: any): any => watchKey(item.taskId, item.chatId) === watchKey(taskId, chatId));
            const current: any = index >= 0 ? normalizeDeliveryReceipt(data.watches[index].delivery) : null;
            if (!current || current.status !== 'sending' || leaseActive(current)) return { recovered:false };
            data.watches[index] = uncertainWatch(data.watches[index], current, 'process_interrupted');
            await this.write(data);
            return { recovered:true, watch:data.watches[index] };
        }));
    }
    mutate(operation: any): any {
        const run: any = this.mutations.catch((): any => undefined).then(operation);
        this.mutations = run;
        return run;
    }
    async withFileLock(operation: any): Promise<any> {
        const lockPath: any = `${this.filePath}.lock`;
        await fs.mkdir(path.dirname(this.filePath), { recursive:true });
        for (let attempt = 0; attempt < 100; attempt += 1) {
            const token: any = crypto.randomUUID();
            try {
                const handle: any = await fs.open(lockPath, 'wx', 0o600);
                await this.writeLockMetadata(handle, token);
                let renewal: any = Promise.resolve();
                const heartbeat: any = setInterval((): any => {
                    renewal = renewal.catch((): any => undefined).then((): any => this.writeLockMetadata(handle, token));
                }, Math.max(10, Math.floor(this.lockLeaseMs / 3)));
                heartbeat.unref?.();
                try { return await operation(); }
                finally {
                    clearInterval(heartbeat);
                    await renewal.catch((): any => undefined);
                    await this.releaseFileLock(lockPath, token, handle);
                    await handle.close();
                }
            }
            catch (error: any) {
                if (error?.code !== 'EEXIST') throw error;
                await this.recoverStaleLock(lockPath);
                await delay(10);
            }
        }
        throw new OfficialFeishuCompletionWatcherError('等待飞书投递记录锁超时；未开始外发。');
    }
    async recoverStaleLock(lockPath: any): Promise<any> {
        const first: any = await readLockIdentity(lockPath);
        if (!staleLock(first, this.lockLeaseMs)) return;
        await this.beforeStaleReclaim?.(first);
        // Re-read identity after the async gap.  A replacement lock must never
        // be removed just because the previous pathname was stale.
        const verified: any = await readLockIdentity(lockPath);
        if (!sameLock(first, verified) || !staleLock(verified, this.lockLeaseMs)) return;
        const quarantine: any = `${lockPath}.reclaim.${process.pid}.${crypto.randomUUID()}`;
        try { await fs.rename(lockPath, quarantine); }
        catch (error: any) { if (error?.code === 'ENOENT') return; throw error; }
        const moved: any = await readLockIdentity(quarantine);
        if (sameLock(verified, moved) && staleLock(moved, this.lockLeaseMs)) {
            await fs.rm(quarantine, { force:true });
            return;
        }
        // The pathname changed after verification. Keep the unexpected lock
        // intact and restore it only if nobody acquired a new lock meanwhile.
        try { await fs.link(quarantine, lockPath); await fs.rm(quarantine, { force:true }); }
        catch (error: any) { if (error?.code !== 'EEXIST') throw error; }
    }
    async writeLockMetadata(handle: any, token: any): Promise<any> {
        const value: any = Buffer.from(JSON.stringify({ token, expiresAt:new Date(Date.now() + this.lockLeaseMs).toISOString() }));
        await handle.write(value, 0, value.length, 0);
        await handle.truncate(value.length);
        await handle.sync();
    }
    async releaseFileLock(lockPath: any, token: any, handle: any): Promise<any> {
        const held: any = await handle.stat().catch((): any => null);
        const quarantine: any = `${lockPath}.release.${process.pid}.${crypto.randomUUID()}`;
        try { await fs.rename(lockPath, quarantine); }
        catch (error: any) { if (error?.code === 'ENOENT') return; throw error; }
        const moved: any = await readLockIdentity(quarantine);
        if (held && moved?.metadata?.token === token && sameFile(held, moved.stat)) {
            await fs.rm(quarantine, { force:true });
            return;
        }
        // A stale-breaker or a new owner changed the name after this owner
        // started releasing. Do not unlink that replacement; restore only if
        // the canonical lock path is still empty.
        try { await fs.link(quarantine, lockPath); await fs.rm(quarantine, { force:true }); }
        catch (error: any) { if (error?.code !== 'EEXIST') throw error; }
    }
    async read(): Promise<any> {
        try {
            const file: any = await fs.open(this.filePath, 'r');
            try {
                const serialized: any = await file.readFile('utf8');
                if (((await file.stat()).mode & 0o777) !== 0o600)
                    await file.chmod(0o600);
                const value: any = JSON.parse(serialized);
                return { watches: Array.isArray(value.watches) ? value.watches.map(normalizeWatch).filter(Boolean) : [] };
            }
            finally {
                await file.close();
            }
        }
        catch (error: any) {
            if (error?.code === 'ENOENT')
                return { watches: [] };
            throw error;
        }
    }
    async write(data: any): Promise<any> {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        const temporary: any = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
        try {
            await fs.writeFile(temporary, JSON.stringify({ watches: data.watches }, null, 2), { flag: 'wx', mode: 0o600 });
            await fs.rename(temporary, this.filePath);
            await fs.chmod(this.filePath, 0o600);
        }
        catch (error: any) {
            await fs.rm(temporary, { force: true }).catch((): any => { });
            throw error;
        }
    }
}
function shouldReportProgress(status: any): any { return ['waiting_approval', 'recovery_pending', 'technical_repair'].includes(String(status || '')); }
function withTaskLink(message: any, taskId: any, baseUrl: any): any {
    if (!baseUrl)
        return message;
    const url: any = new URL(`/tasks/${encodeURIComponent(taskId)}`, `${baseUrl}/`).toString();
    return `${String(message || '').trim()}\n\n[查看任务 ${shortTaskRef(taskId)}](${url})`;
}
function watchKey(taskId: any, chatId: any): any { return `${taskId}:${chatId}`; }
function required(value: any, message: any): any {
    const text: any = String(value || '').trim();
    if (!text)
        throw new OfficialFeishuCompletionWatcherError(message);
    return text;
}
function normalizeWatch(input: any): any {
    const taskId: any = String(input?.taskId || '').trim();
    const chatId: any = String(input?.chatId || '').trim();
    const delivery: any = normalizeDelivery(input?.delivery);
    return taskId && chatId ? {
        taskId,
        chatId,
        lastStatus: String(input?.lastStatus || '').trim() || null,
        createdAt: String(input?.createdAt || '').trim() || undefined,
        updatedAt: String(input?.updatedAt || '').trim() || undefined,
        ...(delivery ? { delivery } : {})
    } : null;
}
function normalizeDelivery(input: any): any {
    const receipt: any = normalizeDeliveryReceipt(input);
    const kind: any = ['terminal', 'progress'].includes(receipt?.kind) ? receipt.kind : null;
    return receipt?.deliveryId && kind ? receipt : null;
}
function deliveryId(taskId: any, chatId: any, kind: any, targetStatus: any): any {
    const hex: any = crypto.createHash('sha256').update(`${taskId}\0${chatId}\0${kind}\0${targetStatus}`, 'utf8').digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function deliveryState(watches: any): any {
    const receipts: any[] = watches.map((watch: any): any => normalizeDeliveryReceipt(watch.delivery)).filter(Boolean);
    const pendingDeliveries: any = receipts.filter((receipt: any): any => ['prepared', 'sending'].includes(receipt.status)).length;
    const uncertainDeliveries: any = receipts.filter((receipt: any): any => receipt.status === 'delivery_unknown').length;
    const failedDeliveries: any = receipts.filter((receipt: any): any => receipt.status === 'failed').length;
    const actions: any[] = receipts.map(deliveryRecoveryAction).filter(Boolean);
    return {
        // Keep the existing public status for compatibility, but do not hide a
        // confirmed send failure behind "ready".
        status: uncertainDeliveries || failedDeliveries ? 'delivery_uncertain' : pendingDeliveries ? 'delivery_pending' : 'ready',
        uncertainDeliveries,
        failedDeliveries,
        pendingDeliveries,
        actions,
        message: uncertainDeliveries
            ? `有 ${uncertainDeliveries} 条飞书完成跟进的投递结果不确定；已停止自动重发，需在本机核对。`
            : failedDeliveries
                ? `有 ${failedDeliveries} 条飞书完成跟进明确失败；后台重试已停止，需显式恢复交付。`
                : pendingDeliveries
                    ? `有 ${pendingDeliveries} 条飞书完成跟进仍在等待投递确认；确认前不显示为已就绪。`
                    : '飞书完成跟进没有待核对的投递。'
    };
}
function safeDeliveryError(error: any): any {
    // Provider messages can contain recipient ids, URLs or tokens.  Persist an
    // explicit machine code only; unknown free-form errors intentionally fold
    // into one safe diagnosis.
    const internalCode: any = typeof error === 'string' && /^[a-z][a-z0-9_]{0,119}$/i.test(error) ? error : '';
    const code: any = String(error?.code || internalCode || 'delivery_outcome_unknown');
    return code.replace(/[^a-zA-Z0-9_.-]/g, '_').replace(/_+/g, '_').slice(0, 120);
}
function createReceipt(input: any): any {
    const receipt: any = createDeliveryReceipt(input);
    if (!receipt)
        throw new OfficialFeishuCompletionWatcherError('飞书交付回执不完整。');
    return receipt;
}
function deliveredReceipt(delivery: any, sent: any): any {
    // Undefined, booleans and arbitrary provider payloads are not delivery
    // confirmation.  The adapter must deliberately assert the confirmation
    // and attach a normalized acknowledgement credential.
    if (sent?.deliveryConfirmed !== true || !['delivered', 'confirmed', 'success', 'succeeded'].includes(String(sent?.deliveryState || '').toLowerCase()))
        return null;
    const evidence: any = sent?.deliveryEvidence || sent?.evidence;
    if (!evidence?.type || !evidence?.observedAt)
        return null;
    const now: any = new Date().toISOString();
    return createReceipt({
        ...delivery,
        status:'delivered',
        deliveredAt:now,
        evidence,
    });
}
function leaseActive(receipt: any): boolean {
    const expiresAt: any = Date.parse(receipt?.lease?.expiresAt || '');
    return Number.isFinite(expiresAt) && expiresAt > Date.now();
}
function uncertainWatch(watch: any, delivery: any, reason: any): any {
    return {
        ...watch,
        delivery:createReceipt({ ...delivery, status:'delivery_unknown', unknownAt:new Date().toISOString(), errorCode:safeDeliveryError(reason) }),
        updatedAt:new Date().toISOString(),
    };
}
async function readLockIdentity(lockPath: any): Promise<any> {
    let handle: any;
    try {
        handle = await fs.open(lockPath, 'r');
        const stat: any = await handle.stat();
        let metadata: any = null;
        try { metadata = JSON.parse(await handle.readFile('utf8')); }
        catch { metadata = null; }
        return { stat, metadata };
    }
    catch (error: any) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
    finally { await handle?.close?.(); }
}
function sameFile(left: any, right: any): boolean {
    return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}
function sameLock(left: any, right: any): boolean {
    return sameFile(left?.stat, right?.stat) && left?.metadata?.token === right?.metadata?.token;
}
function staleLock(lock: any, lockLeaseMs: any): boolean {
    if (!lock?.stat) return false;
    const expiresAt: any = Date.parse(lock.metadata?.expiresAt || '');
    return Number.isFinite(expiresAt) ? expiresAt <= Date.now() : Date.now() - lock.stat.mtimeMs > lockLeaseMs;
}
function delay(ms: any): Promise<void> { return new Promise((resolve: any): any => setTimeout(resolve, ms)); }

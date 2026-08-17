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
    logger: any;
    send: any;
    store: any;
    taskStatus: any;
    timer: any;
    timers: any;
    constructor({ taskStatus, send, store, intervalMs = 3000, timers = globalThis, detailBaseUrl = '', logger = console }: any = {}) {
        if (typeof taskStatus !== 'function')
            throw new OfficialFeishuCompletionWatcherError('官方飞书跟进缺少任务状态读取方法。');
        if (typeof send !== 'function')
            throw new OfficialFeishuCompletionWatcherError('官方飞书跟进缺少原会话发送方法。');
        if (!store?.list || !store?.upsert || !store?.remove)
            throw new OfficialFeishuCompletionWatcherError('官方飞书跟进缺少本机记录。');
        this.taskStatus = taskStatus;
        this.send = send;
        this.store = store;
        this.intervalMs = intervalMs;
        this.timers = timers;
        this.detailBaseUrl = taskDetailBaseUrl(detailBaseUrl);
        this.logger = logger;
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
                await this.markDeliveryUncertain(watch, 'process_interrupted');
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
        const prepared: Record<string, any> = createReceipt({
            deliveryId: deliveryId(watch.taskId, watch.chatId, kind, targetStatus),
            idempotencyKey: previous?.idempotencyKey || deliveryId(watch.taskId, watch.chatId, kind, targetStatus),
            channel:'feishu',
            kind,
            targetStatus: String(targetStatus || ''),
            status:'prepared',
            preparedAt:new Date().toISOString(),
            attempt:(Number(previous?.attempt) || 0) + 1,
        });
        const preparedWatch: Record<string, any> = { ...watch, delivery:prepared, updatedAt: new Date().toISOString() };
        await this.store.upsert(preparedWatch);
        const delivery: Record<string, any> = createReceipt({ ...prepared, status:'sending', sendingAt:new Date().toISOString() });
        const sendingWatch: Record<string, any> = { ...preparedWatch, delivery, updatedAt: new Date().toISOString() };
        await this.store.upsert(sendingWatch);
        try {
            const sent: any = await this.send(watch.chatId, { markdown: message, deliveryId: delivery.deliveryId, idempotencyKey:delivery.idempotencyKey });
            const delivered: any = deliveredReceipt(delivery, sent);
            if (!delivered) {
                await this.markDeliveryUncertain(sendingWatch, safeDeliveryError(sent));
                return;
            }
            await this.store.upsert({ ...sendingWatch, lastStatus:targetStatus, delivery:delivered, updatedAt:new Date().toISOString() });
        }
        catch (error: any) {
            if (error?.deliveryState === 'not_started') {
                await this.store.upsert({ ...sendingWatch, delivery:createReceipt({ ...delivery, status:'failed', failedAt:new Date().toISOString(), errorCode:safeDeliveryError(error) }), updatedAt: new Date().toISOString() });
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
        await this.store.upsert({ ...watch, delivery, updatedAt: new Date().toISOString() });
        this.logger.warn?.(`飞书任务 ${watch.taskId} 的完成跟进投递结果不确定；已停止自动重发，等待本机核对。`);
    }
    async refreshSnapshot(): Promise<any> {
        this.deliverySnapshot = deliveryState(await this.store.list());
    }
}
export class OfficialFeishuCompletionWatcherError extends Error {
}
export class FileCompletionWatchStore {
    filePath: any;
    mutations: any;
    constructor(filePath: any) { this.filePath = filePath; this.mutations = Promise.resolve(); }
    async list(): Promise<any> { await this.mutations.catch((): any => undefined); return (await this.read()).watches; }
    async upsert(input: any): Promise<any> {
        return this.mutate(async (): Promise<any> => {
            const data: any = await this.read();
            const key: any = watchKey(input.taskId, input.chatId);
            const index: any = data.watches.findIndex((item: any): any => watchKey(item.taskId, item.chatId) === key);
            if (index >= 0)
                data.watches[index] = { ...data.watches[index], ...input };
            else
                data.watches.push(input);
            await this.write(data);
        });
    }
    async remove(taskId: any, chatId: any): Promise<any> {
        return this.mutate(async (): Promise<any> => {
            const data: any = await this.read();
            data.watches = data.watches.filter((item: any): any => watchKey(item.taskId, item.chatId) !== watchKey(taskId, chatId));
            await this.write(data);
        });
    }
    mutate(operation: any): any {
        const run: any = this.mutations.catch((): any => undefined).then(operation);
        this.mutations = run;
        return run;
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
    const uncertainDeliveries: any = receipts.filter((receipt: any): any => receipt.status === 'delivery_unknown').length;
    const failedDeliveries: any = receipts.filter((receipt: any): any => receipt.status === 'failed').length;
    const actions: any[] = receipts.map(deliveryRecoveryAction).filter(Boolean);
    return {
        // Keep the existing public status for compatibility, but do not hide a
        // confirmed send failure behind "ready".
        status: uncertainDeliveries || failedDeliveries ? 'delivery_uncertain' : 'ready',
        uncertainDeliveries,
        failedDeliveries,
        actions,
        message: uncertainDeliveries
            ? `有 ${uncertainDeliveries} 条飞书完成跟进的投递结果不确定；已停止自动重发，需在本机核对。`
            : failedDeliveries
                ? `有 ${failedDeliveries} 条飞书完成跟进明确失败；后台重试已停止，需显式恢复交付。`
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
    if (sent?.deliveryState && !['delivered', 'confirmed', 'success', 'succeeded'].includes(String(sent.deliveryState).toLowerCase()))
        return null;
    const now: any = new Date().toISOString();
    return createReceipt({
        ...delivery,
        status:'delivered',
        deliveredAt:now,
        evidence:sent?.deliveryEvidence || sent?.evidence || {
            type:'channel_send_acknowledged', observedAt:now,
            reference:String(sent?.messageId || sent?.providerMessageId || '').trim() || undefined,
        },
    });
}

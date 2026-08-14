import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { shortTaskRef, taskDetailBaseUrl } from './task-presentation.ts';
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
        if (!watch?.delivery || watch.delivery.state !== 'uncertain')
            throw new OfficialFeishuCompletionWatcherError('这条跟进没有等待人工核对的投递。');
        if (decision === 'retry') {
            await this.store.upsert({ ...watch, delivery: null, updatedAt: new Date().toISOString() });
        }
        else if (watch.delivery.kind === 'terminal') {
            await this.store.remove(task, chat);
        }
        else {
            await this.store.upsert({ ...watch, lastStatus: watch.delivery.targetStatus, delivery: null, updatedAt: new Date().toISOString() });
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
            if (watch.delivery?.state === 'sending') {
                await this.markDeliveryUncertain(watch, 'process_interrupted');
                return;
            }
            if (watch.delivery?.state === 'uncertain')
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
        const delivery: Record<string, any> = {
            deliveryId: deliveryId(watch.taskId, watch.chatId, kind, targetStatus),
            kind,
            targetStatus: String(targetStatus || ''),
            state: 'sending',
            startedAt: new Date().toISOString()
        };
        const sendingWatch: Record<string, any> = { ...watch, delivery, updatedAt: new Date().toISOString() };
        await this.store.upsert(sendingWatch);
        try {
            await this.send(watch.chatId, { markdown: message, deliveryId: delivery.deliveryId });
        }
        catch (error: any) {
            if (error?.deliveryState === 'not_started') {
                await this.store.upsert({ ...sendingWatch, delivery: null, updatedAt: new Date().toISOString() });
            }
            else {
                await this.markDeliveryUncertain(sendingWatch, safeDeliveryError(error));
            }
            return;
        }
        if (kind === 'terminal')
            await this.store.remove(watch.taskId, watch.chatId);
        else
            await this.store.upsert({ ...sendingWatch, lastStatus: targetStatus, delivery: null, updatedAt: new Date().toISOString() });
    }
    async markDeliveryUncertain(watch: any, reason: any): Promise<any> {
        const delivery: Record<string, any> = {
            ...watch.delivery,
            state: 'uncertain',
            uncertainAt: new Date().toISOString(),
            reason: String(reason || 'delivery_outcome_unknown').slice(0, 120)
        };
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
    const deliveryId: any = String(input?.deliveryId || '').trim();
    const kind: any = ['terminal', 'progress'].includes(input?.kind) ? input.kind : null;
    const state: any = ['sending', 'uncertain'].includes(input?.state) ? input.state : null;
    if (!deliveryId || !kind || !state)
        return null;
    return {
        deliveryId,
        kind,
        targetStatus: String(input?.targetStatus || '').trim(),
        state,
        startedAt: String(input?.startedAt || '').trim() || undefined,
        uncertainAt: String(input?.uncertainAt || '').trim() || undefined,
        reason: String(input?.reason || '').trim() || undefined
    };
}
function deliveryId(taskId: any, chatId: any, kind: any, targetStatus: any): any {
    const hex: any = crypto.createHash('sha256').update(`${taskId}\0${chatId}\0${kind}\0${targetStatus}`, 'utf8').digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function deliveryState(watches: any): any {
    const uncertainDeliveries: any = watches.filter((watch: any): any => watch.delivery?.state === 'uncertain').length;
    return {
        status: uncertainDeliveries ? 'delivery_uncertain' : 'ready',
        uncertainDeliveries,
        message: uncertainDeliveries
            ? `有 ${uncertainDeliveries} 条飞书完成跟进的投递结果不确定；已停止自动重发，需在本机核对。`
            : '飞书完成跟进没有待核对的投递。'
    };
}
function safeDeliveryError(error: any): any {
    return String(error?.code || error?.message || 'delivery_outcome_unknown').replace(/[\r\n]/g, ' ').slice(0, 120);
}

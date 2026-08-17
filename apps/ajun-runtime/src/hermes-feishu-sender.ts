import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
export class HermesFeishuSender {
    command: any;
    hermesHome: any;
    spawn: any;
    timeoutMs: any;
    constructor({ command = path.join(os.homedir(), '.local/bin/hermes'), hermesHome = path.join(os.homedir(), '.hermes'), spawnImpl = spawn, timeoutMs = 20000 }: any = {}) {
        this.command = command;
        this.hermesHome = hermesHome;
        this.spawn = spawnImpl;
        this.timeoutMs = timeoutMs;
    }
    async send(chatId: any, payload: any = {}): Promise<any> {
        const chat: any = safeChatId(chatId);
        const message: any = safeMessage(payload.markdown || payload.text);
        if (!message)
            throw new HermesFeishuSenderError('飞书回话内容为空。');
        const idempotencyKey: any = safeIdempotencyKey(payload.idempotencyKey || payload.deliveryId);
        const acknowledgement: any = await new Promise((resolve: any, reject: any): any => {
            let child: any;
            let stdout: any = '';
            try {
                child = this.spawn(this.command, [
                    'send',
                    '--to',
                    `feishu:${chat}`,
                    '--file',
                    '-',
                    '--json'
                ], {
                    // Hermes currently has no documented provider-side
                    // idempotency argument. This crosses the process boundary
                    // for a future adapter, but local atomic leases remain the
                    // only asserted de-duplication guarantee today.
                    env: { ...process.env, HERMES_HOME: this.hermesHome, ...(idempotencyKey ? { HERMES_DELIVERY_IDEMPOTENCY_KEY:idempotencyKey } : {}) },
                    stdio: ['pipe', 'pipe', 'ignore']
                });
            }
            catch {
                reject(new HermesFeishuSenderError('Hermes 飞书回话进程未启动，将保留任务跟进记录后重试。', { deliveryState: 'not_started' }));
                return;
            }
            let settled: any = false;
            const finish: any = (error: any = null): any => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                if (error)
                    reject(error);
                else
                    resolve(stdout);
            };
            const timer: any = setTimeout((): any => {
                child.kill('SIGTERM');
                finish(new HermesFeishuSenderError('Hermes 飞书回话超时；无法确认平台是否已经收件。', { deliveryState: 'unknown' }));
            }, this.timeoutMs);
            timer.unref?.();
            child.once('error', (): any => finish(new HermesFeishuSenderError('Hermes 飞书回话进程未启动，将保留任务跟进记录后重试。', { deliveryState: 'not_started' })));
            child.once('close', (code: any): any => finish(code === 0 ? null : new HermesFeishuSenderError('Hermes 飞书回话未确认成功；无法判断平台是否已经收件。', { deliveryState: 'unknown' })));
            child.stdout?.on?.('data', (chunk: any): any => {
                // The JSON result is tiny. A large or malformed response is
                // deliberately not persisted or echoed into errors/logs.
                if (stdout.length < 16384)
                    stdout += String(chunk).slice(0, 16384 - stdout.length);
            });
            child.stdin.once('error', (): any => undefined);
            child.stdin.end(message);
        });
        const providerMessageId: any = confirmedProviderMessageId(acknowledgement);
        if (!providerMessageId)
            throw new HermesFeishuSenderError('Hermes 命令已结束，但没有可核验的飞书回执；投递结果不确定。', { deliveryState:'unknown', code:'hermes_send_unconfirmed' });
        const observedAt: any = new Date().toISOString();
        return {
            success: true,
            deliveryConfirmed:true,
            deliveryState:'delivered',
            deliveryEvidence:{
                type:'hermes_feishu_provider_acknowledged',
                observedAt,
                reference:providerMessageId,
            },
            idempotencyKey,
            providerIdempotency:{ forwardedToHermesProcess:Boolean(idempotencyKey), providerDeduplication:'unsupported' },
        };
    }
}
function safeIdempotencyKey(value: any): any {
    const key: any = String(value || '').trim();
    if (!key) return undefined;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(key))
        throw new HermesFeishuSenderError('飞书投递幂等标识无效。', { deliveryState:'not_started' });
    return key;
}
function confirmedProviderMessageId(stdout: any): any {
    if (typeof stdout !== 'string' || stdout.length === 0 || stdout.length > 16384)
        return null;
    try {
        const result: any = JSON.parse(stdout);
        // The target is fixed to `feishu:<chat>` above. Hermes 0.19's send
        // JSON confirms Feishu with success + message_id but does not always
        // include a platform field, so requiring one would turn real receipts
        // into false unknowns.
        if (result?.success !== true)
            return null;
        const messageId: any = String(result.message_id || '').trim();
        // Do not retain a raw CLI payload: it may include a chat id or a
        // provider error. The provider-assigned message id is the sole receipt.
        return /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(messageId) ? messageId : null;
    }
    catch { return null; }
}
export class HermesFeishuSenderError extends Error {
    code: any;
    deliveryState: any;
    name: any;
    constructor(message: any, { deliveryState = 'unknown', code = null }: any = {}) {
        super(message);
        this.name = 'HermesFeishuSenderError';
        this.deliveryState = deliveryState;
        this.code = code || (deliveryState === 'not_started' ? 'hermes_send_not_started' : 'hermes_send_unconfirmed');
    }
}
function safeChatId(value: any): any {
    const chatId: any = String(value || '').trim();
    if (!/^[a-zA-Z0-9_-]{8,240}$/.test(chatId))
        throw new HermesFeishuSenderError('飞书原会话标识无效。');
    return chatId;
}
function safeMessage(value: any): any {
    return String(value || '')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
        .trim()
        .slice(0, 8000);
}

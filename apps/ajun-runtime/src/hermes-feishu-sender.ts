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
        await new Promise((resolve: any, reject: any): any => {
            let child: any;
            try {
                child = this.spawn(this.command, [
                    'send',
                    '--to',
                    `feishu:${chat}`,
                    '--file',
                    '-',
                    '--quiet'
                ], {
                    env: { ...process.env, HERMES_HOME: this.hermesHome },
                    stdio: ['pipe', 'ignore', 'ignore']
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
                    resolve();
            };
            const timer: any = setTimeout((): any => {
                child.kill('SIGTERM');
                finish(new HermesFeishuSenderError('Hermes 飞书回话超时；无法确认平台是否已经收件。', { deliveryState: 'unknown' }));
            }, this.timeoutMs);
            timer.unref?.();
            child.once('error', (): any => finish(new HermesFeishuSenderError('Hermes 飞书回话进程未启动，将保留任务跟进记录后重试。', { deliveryState: 'not_started' })));
            child.once('close', (code: any): any => finish(code === 0 ? null : new HermesFeishuSenderError('Hermes 飞书回话未确认成功；无法判断平台是否已经收件。', { deliveryState: 'unknown' })));
            child.stdin.once('error', (): any => undefined);
            child.stdin.end(message);
        });
        return { success: true };
    }
}
export class HermesFeishuSenderError extends Error {
    deliveryState: any;
    name: any;
    constructor(message: any, { deliveryState = 'unknown' }: any = {}) {
        super(message);
        this.name = 'HermesFeishuSenderError';
        this.deliveryState = deliveryState;
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

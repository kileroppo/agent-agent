import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { shortTaskRef, taskDetailBaseUrl } from './task-presentation.js';

/**
 * Keeps the promise A君 makes in Feishu: long work reports its real ending
 * back to the same chat.  It stores only the local task id and chat id, never
 * message text, people data, credentials, or the delivered content itself.
 */
export class OfficialFeishuCompletionWatcher {
  constructor({ taskStatus, send, store, intervalMs = 3000, timers = globalThis, detailBaseUrl = '' } = {}) {
    if (typeof taskStatus !== 'function') throw new OfficialFeishuCompletionWatcherError('官方飞书跟进缺少任务状态读取方法。');
    if (typeof send !== 'function') throw new OfficialFeishuCompletionWatcherError('官方飞书跟进缺少原会话发送方法。');
    if (!store?.list || !store?.upsert || !store?.remove) throw new OfficialFeishuCompletionWatcherError('官方飞书跟进缺少本机记录。');
    this.taskStatus = taskStatus;
    this.send = send;
    this.store = store;
    this.intervalMs = intervalMs;
    this.timers = timers;
    this.detailBaseUrl = taskDetailBaseUrl(detailBaseUrl);
    this.timer = null;
    this.checkInFlight = null;
  }

  async start() {
    await this.check();
    this.timer = this.timers.setInterval(() => void this.check(), this.intervalMs);
    this.timer?.unref?.();
  }

  stop() { if (this.timer) this.timers.clearInterval(this.timer); this.timer = null; }

  async watch({ taskId, chatId }) {
    const task = required(taskId, '官方飞书跟进缺少任务编号。');
    const chat = required(chatId, '官方飞书跟进缺少原会话。');
    await this.store.upsert({ taskId:task, chatId:chat, lastStatus:null, createdAt:new Date().toISOString() });
  }

  async check() {
    if (this.checkInFlight) return this.checkInFlight;
    const check = this.checkWatches();
    this.checkInFlight = check;
    try {
      return await check;
    } finally {
      if (this.checkInFlight === check) this.checkInFlight = null;
    }
  }

  async checkWatches() {
    const watches = await this.store.list();
    for (const watch of watches) await this.checkOne(watch);
  }

  async checkOne(watch) {
    try {
      const status = await this.taskStatus(watch.taskId, watch.chatId);
      const message = withTaskLink(status.message, watch.taskId, this.detailBaseUrl);
      const changed = watch.lastStatus !== status.status;
      if (status.terminal) {
        await this.send(watch.chatId, { markdown:message });
        await this.store.remove(watch.taskId, watch.chatId);
        return;
      }
      if (changed && shouldReportProgress(status.status)) await this.send(watch.chatId, { markdown:message });
      if (changed) await this.store.upsert({ ...watch, lastStatus:status.status, updatedAt:new Date().toISOString() });
    } catch {
      // A temporary read/send failure must leave the watch in place. The next
      // interval (or process restart) can safely retry without inventing a result.
    }
  }
}

export class OfficialFeishuCompletionWatcherError extends Error {}

export class FileCompletionWatchStore {
  constructor(filePath) { this.filePath = filePath; }

  async list() { return (await this.read()).watches; }
  async upsert(input) {
    const data = await this.read();
    const key = watchKey(input.taskId, input.chatId);
    const index = data.watches.findIndex((item) => watchKey(item.taskId, item.chatId) === key);
    if (index >= 0) data.watches[index] = { ...data.watches[index], ...input };
    else data.watches.push(input);
    await this.write(data);
  }
  async remove(taskId, chatId) {
    const data = await this.read();
    data.watches = data.watches.filter((item) => watchKey(item.taskId, item.chatId) !== watchKey(taskId, chatId));
    await this.write(data);
  }
  async read() {
    try {
      const file = await fs.open(this.filePath, 'r');
      try {
        const serialized = await file.readFile('utf8');
        if (((await file.stat()).mode & 0o777) !== 0o600) await file.chmod(0o600);
        const value = JSON.parse(serialized);
        return { watches:Array.isArray(value.watches) ? value.watches.map(normalizeWatch).filter(Boolean) : [] };
      } finally {
        await file.close();
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return { watches:[] };
      throw error;
    }
  }
  async write(data) {
    await fs.mkdir(path.dirname(this.filePath), { recursive:true });
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ watches:data.watches }, null, 2), { flag:'wx', mode:0o600 });
      await fs.rename(temporary, this.filePath);
      await fs.chmod(this.filePath, 0o600);
    } catch (error) {
      await fs.rm(temporary, { force:true }).catch(() => {});
      throw error;
    }
  }
}

function shouldReportProgress(status) { return ['waiting_approval', 'recovery_pending', 'technical_repair'].includes(String(status || '')); }
function withTaskLink(message, taskId, baseUrl) {
  if (!baseUrl) return message;
  const url = new URL(`/tasks/${encodeURIComponent(taskId)}`, `${baseUrl}/`).toString();
  return `${String(message || '').trim()}\n\n[查看任务 ${shortTaskRef(taskId)}](${url})`;
}
function watchKey(taskId, chatId) { return `${taskId}:${chatId}`; }
function required(value, message) { const text = String(value || '').trim(); if (!text) throw new OfficialFeishuCompletionWatcherError(message); return text; }
function normalizeWatch(input) {
  const taskId = String(input?.taskId || '').trim(); const chatId = String(input?.chatId || '').trim();
  return taskId && chatId ? { taskId, chatId, lastStatus:String(input?.lastStatus || '').trim() || null, createdAt:String(input?.createdAt || '').trim() || undefined, updatedAt:String(input?.updatedAt || '').trim() || undefined } : null;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileCompletionWatchStore, OfficialFeishuCompletionWatcher } from '../src/official-feishu-completion-watcher.js';

function setup({ status = { terminal:false, status:'running', message:'正在处理。' } } = {}) {
  const records = []; const sent = [];
  const store = {
    async list() { return records.map((item) => ({ ...item })); },
    async upsert(item) { const index = records.findIndex((record) => record.taskId === item.taskId && record.chatId === item.chatId); if (index >= 0) records[index] = { ...records[index], ...item }; else records.push({ ...item }); },
    async remove(taskId, chatId) { const index = records.findIndex((record) => record.taskId === taskId && record.chatId === chatId); if (index >= 0) records.splice(index, 1); }
  };
  const watcher = new OfficialFeishuCompletionWatcher({ taskStatus:async () => status, send:async (chatId, content) => sent.push({ chatId, content }), store });
  return { watcher, records, sent, setStatus(value) { status = value; } };
}

test('长任务会在完成时只回到原聊天一次，并清掉本机跟进记录', async () => {
  const state = setup();
  await state.watcher.watch({ taskId:'task-a', chatId:'chat-a' });
  state.setStatus({ terminal:true, status:'succeeded', message:'工作已经完成。' });
  await state.watcher.check();
  assert.deepEqual(state.sent, [{ chatId:'chat-a', content:{ markdown:'工作已经完成。' } }]);
  assert.deepEqual(state.records, []);
});

test('处理中不刷屏，进入运维接手时才主动说一次', async () => {
  const state = setup(); await state.watcher.watch({ taskId:'task-a', chatId:'chat-a' });
  await state.watcher.check();
  state.setStatus({ terminal:false, status:'recovery_pending', message:'运维官正在接手。' });
  await state.watcher.check(); await state.watcher.check();
  assert.deepEqual(state.sent, [{ chatId:'chat-a', content:{ markdown:'运维官正在接手。' } }]);
  assert.equal(state.records[0].lastStatus, 'recovery_pending');
});

test('内容任务进入完整听审审批时会主动提醒一次并继续等待终态', async () => {
  const state = setup(); await state.watcher.watch({ taskId:'mission-content', chatId:'chat-content' });
  await state.watcher.check();
  state.setStatus({ terminal:false, status:'waiting_approval', message:'机器稿已完成，请完整听审后确认。' });
  await state.watcher.check();
  await state.watcher.check();
  assert.deepEqual(state.sent, [{
    chatId:'chat-content',
    content:{ markdown:'机器稿已完成，请完整听审后确认。' }
  }]);
  assert.equal(state.records[0].lastStatus, 'waiting_approval');
});

test('临时读取失败会保留跟进记录，下一次仍可继续检查', async () => {
  const state = setup(); await state.watcher.watch({ taskId:'task-a', chatId:'chat-a' });
  state.watcher.taskStatus = async () => { throw new Error('temporary'); };
  await state.watcher.check();
  assert.equal(state.records.length, 1);
  assert.equal(state.sent.length, 0);
});

test('原会话跟进记录只保存任务号和会话号且文件权限为 0600', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-watch-'));
  const filePath = path.join(directory, 'watches.json');
  try {
    const store = new FileCompletionWatchStore(filePath);
    await store.upsert({ taskId:'task-safe', chatId:'oc_safe_chat', lastStatus:null });
    const stored = JSON.parse(await fs.readFile(filePath, 'utf8'));
    const mode = (await fs.stat(filePath)).mode & 0o777;
    assert.deepEqual(stored.watches, [{ taskId:'task-safe', chatId:'oc_safe_chat', lastStatus:null }]);
    assert.equal(mode, 0o600);
  } finally {
    await fs.rm(directory, { recursive:true, force:true });
  }
});

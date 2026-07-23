import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialFeishuCompletionWatcher } from '../src/official-feishu-completion-watcher.js';

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

test('临时读取失败会保留跟进记录，下一次仍可继续检查', async () => {
  const state = setup(); await state.watcher.watch({ taskId:'task-a', chatId:'chat-a' });
  state.watcher.taskStatus = async () => { throw new Error('temporary'); };
  await state.watcher.check();
  assert.equal(state.records.length, 1);
  assert.equal(state.sent.length, 0);
});

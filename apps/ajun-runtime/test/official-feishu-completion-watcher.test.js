import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileCompletionWatchStore, OfficialFeishuCompletionWatcher } from '../src/official-feishu-completion-watcher.ts';

function setup({ status = { terminal:false, status:'running', message:'正在处理。' }, detailBaseUrl = '' } = {}) {
  const records = []; const sent = [];
  const store = {
    async list() { return records.map((item) => ({ ...item })); },
    async upsert(item) { const index = records.findIndex((record) => record.taskId === item.taskId && record.chatId === item.chatId); if (index >= 0) records[index] = { ...records[index], ...item }; else records.push({ ...item }); },
    async remove(taskId, chatId) { const index = records.findIndex((record) => record.taskId === taskId && record.chatId === chatId); if (index >= 0) records.splice(index, 1); },
    async claimDelivery({ taskId, chatId, delivery, ownerId, leaseMs }) {
      const index = records.findIndex((record) => record.taskId === taskId && record.chatId === chatId);
      const current = records[index]?.delivery;
      if (index < 0 || ['sending', 'delivered', 'delivery_unknown'].includes(current?.status)) return { claimed:false };
      const watch = { ...records[index], delivery:{ ...delivery, status:'sending', sendingAt:new Date().toISOString(), lease:{ owner:ownerId, token:`lease-${ownerId}`, expiresAt:new Date(Date.now() + leaseMs).toISOString() } } };
      records[index] = watch;
      return { claimed:true, watch:{ ...watch } };
    },
    async completeDelivery({ taskId, chatId, claimToken, update }) {
      const index = records.findIndex((record) => record.taskId === taskId && record.chatId === chatId);
      if (index < 0 || records[index].delivery?.lease?.token !== claimToken) return { completed:false };
      records[index] = { ...records[index], ...update };
      return { completed:true, watch:{ ...records[index] } };
    },
    async recoverExpiredDelivery({ taskId, chatId }) {
      const index = records.findIndex((record) => record.taskId === taskId && record.chatId === chatId);
      if (index < 0 || records[index].delivery?.status !== 'sending') return { recovered:false };
      records[index] = { ...records[index], delivery:{ ...records[index].delivery, status:'delivery_unknown', unknownAt:new Date().toISOString() } };
      return { recovered:true };
    }
  };
  const watcher = new OfficialFeishuCompletionWatcher({ taskStatus:async () => status, send:async (chatId, content) => {
    sent.push({ chatId, content });
    return { deliveryConfirmed:true, deliveryState:'delivered', deliveryEvidence:{ type:'test_ack', observedAt:new Date().toISOString() } };
  }, store, detailBaseUrl });
  return { watcher, records, sent, setStatus(value) { status = value; } };
}

test('长任务会在完成时只回到原聊天一次，并保留脱敏的已送达回执', async () => {
  const state = setup();
  await state.watcher.watch({ taskId:'task-a', chatId:'chat-a' });
  state.setStatus({ terminal:true, status:'succeeded', message:'工作已经完成。' });
  await state.watcher.check();
  assert.equal(state.sent.length, 1);
  assert.equal(state.sent[0].chatId, 'chat-a');
  assert.equal(state.sent[0].content.markdown, '工作已经完成。');
  assert.match(state.sent[0].content.deliveryId, /^[0-9a-f-]{36}$/);
  assert.equal(state.records.length, 1);
  assert.equal(state.records[0].delivery.status, 'delivered');
  assert.equal(state.records[0].delivery.idempotencyKey, state.sent[0].content.deliveryId);
  assert.equal(state.records[0].delivery.evidence.type, 'test_ack');
});

test('终态发送较慢时并发检查也只回到原聊天一次', async () => {
  const state = setup({ status:{ terminal:true, status:'failed', message:'工作没有完成。' } });
  let releaseSend;
  const sendBlocked = new Promise((resolve) => { releaseSend = resolve; });
  state.watcher.send = async (chatId, content) => {
    state.sent.push({ chatId, content });
    await sendBlocked;
    return { deliveryConfirmed:true, deliveryState:'delivered', deliveryEvidence:{ type:'test_ack', observedAt:new Date().toISOString() } };
  };
  await state.watcher.watch({ taskId:'task-a', chatId:'chat-a' });

  const checks = [state.watcher.check(), state.watcher.check(), state.watcher.check()];
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.sent.length, 1);
  assert.equal(state.watcher.snapshot().status, 'delivery_pending');
  releaseSend();
  await Promise.all(checks);
  assert.equal(state.records[0].delivery.status, 'delivered');
});

test('配置运行台地址后，飞书进度会带可点击的短任务编号', async () => {
  const state = setup({
    status:{ terminal:true, status:'succeeded', message:'工作已经完成。' },
    detailBaseUrl:'http://127.0.0.1:4321'
  });
  await state.watcher.watch({ taskId:'7df3c85a-1111-2222-3333-444444444444', chatId:'chat-a' });
  await state.watcher.check();
  assert.match(state.sent[0].content.markdown, /\[查看任务 #7DF3C85A\]\(http:\/\/127\.0\.0\.1:4321\/tasks\/7df3c85a-1111-2222-3333-444444444444\)/);
});

test('处理中不刷屏，进入运维接手时才主动说一次', async () => {
  const state = setup(); await state.watcher.watch({ taskId:'task-a', chatId:'chat-a' });
  await state.watcher.check();
  state.setStatus({ terminal:false, status:'recovery_pending', message:'运维官正在接手。' });
  await state.watcher.check(); await state.watcher.check();
  assert.equal(state.sent.length, 1);
  assert.deepEqual({ chatId:state.sent[0].chatId, markdown:state.sent[0].content.markdown }, { chatId:'chat-a', markdown:'运维官正在接手。' });
  assert.equal(state.records[0].lastStatus, 'recovery_pending');
});

test('内容任务进入完整听审审批时会主动提醒一次并继续等待终态', async () => {
  const state = setup(); await state.watcher.watch({ taskId:'mission-content', chatId:'chat-content' });
  await state.watcher.check();
  state.setStatus({ terminal:false, status:'waiting_approval', message:'机器稿已完成，请完整听审后确认。' });
  await state.watcher.check();
  await state.watcher.check();
  assert.equal(state.sent.length, 1);
  assert.deepEqual({ chatId:state.sent[0].chatId, markdown:state.sent[0].content.markdown }, {
    chatId:'chat-content', markdown:'机器稿已完成，请完整听审后确认。'
  });
  assert.equal(state.records[0].lastStatus, 'waiting_approval');
});

test('临时读取失败会保留跟进记录，下一次仍可继续检查', async () => {
  const state = setup(); await state.watcher.watch({ taskId:'task-a', chatId:'chat-a' });
  state.watcher.taskStatus = async () => { throw new Error('temporary'); };
  await state.watcher.check();
  assert.equal(state.records.length, 1);
  assert.equal(state.sent.length, 0);
});

test('发送结果不确定时停止盲目重发，并要求本机明确选择已送达或重试', async () => {
  const state = setup({ status:{ terminal:true, status:'succeeded', message:'工作已经完成。' } });
  let attempts = 0;
  state.watcher.send = async () => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error('process closed'), { deliveryState:'unknown' });
    return { deliveryConfirmed:true, deliveryState:'delivered', deliveryEvidence:{ type:'test_ack', observedAt:new Date().toISOString() } };
  };
  await state.watcher.watch({ taskId:'task-uncertain', chatId:'chat-uncertain' });

  await state.watcher.check();
  await state.watcher.check();
  assert.equal(attempts, 1);
  assert.equal(state.records[0].delivery.status, 'delivery_unknown');
  assert.equal(state.records[0].delivery.errorCode, 'delivery_outcome_unknown');
  assert.equal(state.watcher.snapshot().status, 'delivery_uncertain');

  await state.watcher.resolveDelivery({ taskId:'task-uncertain', chatId:'chat-uncertain', outcome:'retry' });
  await state.watcher.check();
  assert.equal(attempts, 2);
  assert.equal(state.records[0].delivery.status, 'delivered');
});

test('send 没有显式确认凭据时只能记录 delivery_unknown，不能冒充已送达', async () => {
  const state = setup({ status:{ terminal:true, status:'succeeded', message:'工作已经完成。' } });
  state.watcher.send = async () => undefined;
  await state.watcher.watch({ taskId:'task-no-ack', chatId:'chat-no-ack' });
  await state.watcher.check();
  assert.equal(state.records[0].delivery.status, 'delivery_unknown');
  assert.equal(state.records[0].delivery.errorCode, 'delivery_outcome_unknown');
});

test('两个独立文件存储竞争同一任务时，只有拿到持久化租约的一方可以外发', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-watch-'));
  const filePath = path.join(directory, 'watches.json');
  const sent = [];
  const send = async (_chatId, payload) => {
    sent.push(payload);
    return { deliveryConfirmed:true, deliveryState:'delivered', deliveryEvidence:{ type:'test_ack', observedAt:new Date().toISOString() } };
  };
  try {
    const input = { taskStatus:async () => ({ terminal:true, status:'succeeded', message:'完成。' }), send };
    const first = new OfficialFeishuCompletionWatcher({ ...input, ownerId:'watcher-one', store:new FileCompletionWatchStore(filePath) });
    const second = new OfficialFeishuCompletionWatcher({ ...input, ownerId:'watcher-two', store:new FileCompletionWatchStore(filePath) });
    await Promise.all([first.watch({ taskId:'task-race', chatId:'chat-race' }), second.watch({ taskId:'task-race', chatId:'chat-race' })]);
    await Promise.all([first.check(), second.check()]);
    assert.equal(sent.length, 1);
    assert.equal((await new FileCompletionWatchStore(filePath).list())[0].delivery.status, 'delivered');
  } finally {
    await fs.rm(directory, { recursive:true, force:true });
  }
});

test('租约到期后的发送中记录按崩溃恢复为 unknown，绝不自动再发', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-watch-'));
  const filePath = path.join(directory, 'watches.json');
  try {
    const store = new FileCompletionWatchStore(filePath);
    await store.upsert({ taskId:'task-crash', chatId:'chat-crash', lastStatus:null, delivery:{
      deliveryId:'11111111-1111-5111-a111-111111111111', idempotencyKey:'crash-key', kind:'terminal', targetStatus:'succeeded', status:'sending',
      lease:{ owner:'dead-process', token:'dead-lease', expiresAt:'2020-01-01T00:00:00.000Z' },
    } });
    let sends = 0;
    const watcher = new OfficialFeishuCompletionWatcher({ taskStatus:async () => ({ terminal:true, status:'succeeded', message:'完成。' }), send:async () => { sends += 1; }, store });
    await watcher.check();
    assert.equal(sends, 0);
    assert.equal((await store.list())[0].delivery.status, 'delivery_unknown');
  } finally {
    await fs.rm(directory, { recursive:true, force:true });
  }
});

test('prepared 或 sending 回执投影为待投递，不显示为 ready', async () => {
  const state = setup();
  await state.watcher.watch({ taskId:'task-pending', chatId:'chat-pending' });
  state.records[0].delivery = { deliveryId:'22222222-2222-5222-a222-222222222222', kind:'terminal', targetStatus:'succeeded', status:'prepared' };
  await state.watcher.check();
  assert.equal(state.watcher.snapshot().status, 'delivery_pending');
  assert.equal(state.watcher.snapshot().pendingDeliveries, 1);
});

test('进程重启读到发送中记录时标记投递不确定，不会再次调用外部发送', async () => {
  const state = setup({ status:{ terminal:true, status:'succeeded', message:'工作已经完成。' } });
  await state.watcher.watch({ taskId:'task-restart', chatId:'chat-restart' });
  state.records[0].delivery = {
    deliveryId:'11111111-1111-5111-a111-111111111111', kind:'terminal', targetStatus:'succeeded', state:'sending', startedAt:new Date().toISOString()
  };

  await state.watcher.check();
  assert.equal(state.sent.length, 0);
  assert.equal(state.records[0].delivery.status, 'delivery_unknown');
});

test('明确未启动发送进程时保留自动重试能力', async () => {
  const state = setup({ status:{ terminal:true, status:'failed', message:'工作没有完成。' } });
  let attempts = 0;
  state.watcher.send = async () => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error('spawn failed'), { deliveryState:'not_started' });
    return { deliveryConfirmed:true, deliveryState:'delivered', deliveryEvidence:{ type:'test_ack', observedAt:new Date().toISOString() } };
  };
  await state.watcher.watch({ taskId:'task-not-started', chatId:'chat-not-started' });

  await state.watcher.check();
  assert.equal(state.records[0].delivery.status, 'failed');
  await state.watcher.check();
  assert.equal(attempts, 2);
  assert.equal(state.records[0].delivery.status, 'delivered');
});

test('明确失败最多自动尝试两次，第三次检查冻结并等待人工恢复', async () => {
  const state = setup({ status:{ terminal:true, status:'failed', message:'工作没有完成。' } });
  let attempts = 0;
  state.watcher.send = async () => {
    attempts += 1;
    throw Object.assign(new Error('spawn failed'), { deliveryState:'not_started' });
  };
  await state.watcher.watch({ taskId:'task-auto-cap', chatId:'chat-auto-cap' });

  await state.watcher.check();
  const idempotencyKey = state.records[0].delivery.idempotencyKey;
  await state.watcher.check();
  await state.watcher.check();

  assert.equal(attempts, 2);
  assert.equal(state.records[0].delivery.status, 'failed');
  assert.equal(state.records[0].delivery.attempt, 2);
  assert.equal(state.records[0].delivery.idempotencyKey, idempotencyKey);
  assert.equal(state.watcher.snapshot().status, 'delivery_uncertain');
  assert.equal(state.watcher.snapshot().failedDeliveries, 1);
  assert.deepEqual(state.watcher.snapshot().actions.map((item) => item.action), ['retry_delivery']);
});

test('冻结的 failed 回执只有人工 retry 才能恢复，并保持同一幂等键', async () => {
  const state = setup({ status:{ terminal:true, status:'succeeded', message:'工作已经完成。' } });
  let attempts = 0;
  state.watcher.send = async () => {
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error('spawn failed'), { deliveryState:'not_started' });
    return { deliveryConfirmed:true, deliveryState:'delivered', deliveryEvidence:{ type:'test_ack', observedAt:new Date().toISOString() } };
  };
  await state.watcher.watch({ taskId:'task-manual-retry', chatId:'chat-manual-retry' });
  await state.watcher.check();
  const idempotencyKey = state.records[0].delivery.idempotencyKey;
  await state.watcher.check();
  await state.watcher.check();
  assert.equal(attempts, 2);

  await state.watcher.resolveDelivery({ taskId:'task-manual-retry', chatId:'chat-manual-retry', outcome:'retry' });
  await state.watcher.check();
  assert.equal(attempts, 3);
  assert.equal(state.records[0].delivery.status, 'delivered');
  assert.equal(state.records[0].delivery.idempotencyKey, idempotencyKey);
});

test('旧 uncertain 记录会迁移为正式 delivery_unknown，并只暴露一个核对动作', async () => {
  const state = setup({ status:{ terminal:true, status:'succeeded', message:'工作已经完成。' } });
  await state.watcher.watch({ taskId:'task-old', chatId:'chat-old' });
  state.records[0].delivery = {
    deliveryId:'11111111-1111-5111-a111-111111111111', kind:'terminal', targetStatus:'succeeded',
    state:'uncertain', startedAt:'2026-08-17T00:00:00.000Z', uncertainAt:'2026-08-17T00:01:00.000Z',
    reason:'token=should-not-be-shown'
  };
  await state.watcher.check();
  assert.equal(state.sent.length, 0);
  assert.equal(state.records[0].delivery.status, 'delivery_unknown');
  assert.equal(state.records[0].delivery.errorCode, 'delivery_outcome_unknown');
  assert.deepEqual(state.watcher.snapshot().actions.map((item) => item.action), ['verify_delivery']);
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

test('只读首次加载会把既有 0644 跟进记录收敛为 0600，文件内容保持逐字不变', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-watch-'));
  const filePath = path.join(directory, 'watches.json');
  const original = '{\n  "watches": [\n    { "taskId": "task-old", "chatId": "oc_old", "lastStatus": null }\n  ]\n}\n';
  try {
    await fs.writeFile(filePath, original, { mode:0o644 });
    await fs.chmod(filePath, 0o644);
    const before = await fs.stat(filePath);
    const store = new FileCompletionWatchStore(filePath);
    assert.deepEqual(await store.list(), [{ taskId:'task-old', chatId:'oc_old', lastStatus:null, createdAt:undefined, updatedAt:undefined }]);
    const after = await fs.stat(filePath);
    assert.equal(after.mode & 0o777, 0o600);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(await fs.readFile(filePath, 'utf8'), original);
  } finally {
    await fs.rm(directory, { recursive:true, force:true });
  }
});

test('跟进记录替换失败不会破坏旧文件，也不会清理其他临时文件', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-watch-'));
  const filePath = path.join(directory, 'watches.json');
  const unrelatedTemporary = `${filePath}.unrelated.tmp`;
  const original = '{\n  "watches": []\n}\n';
  try {
    await fs.writeFile(filePath, original, { mode:0o600 });
    await fs.writeFile(unrelatedTemporary, 'leave-me', { mode:0o600 });
    const rename = fs.rename.bind(fs);
    context.mock.method(fs, 'rename', async (source, destination) => {
      if (destination === filePath) {
        assert.equal((await fs.stat(source)).mode & 0o777, 0o600);
        const error = new Error('simulated rename failure');
        error.code = 'EIO';
        throw error;
      }
      return rename(source, destination);
    });

    const store = new FileCompletionWatchStore(filePath);
    await assert.rejects(
      store.upsert({ taskId:'task-new', chatId:'oc_new', lastStatus:null }),
      /simulated rename failure/
    );
    assert.equal(await fs.readFile(filePath, 'utf8'), original);
    assert.equal(await fs.readFile(unrelatedTemporary, 'utf8'), 'leave-me');
    const entries = await fs.readdir(directory);
    assert.deepEqual(entries.sort(), ['watches.json', 'watches.json.unrelated.tmp']);
  } finally {
    await fs.rm(directory, { recursive:true, force:true });
  }
});

test('并发登记不同任务时文件存储不会因读改写竞态丢记录', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-watch-'));
  const filePath = path.join(directory, 'watches.json');
  try {
    const store = new FileCompletionWatchStore(filePath);
    await Promise.all(Array.from({ length:20 }, (_, index) => store.upsert({
      taskId:`task-${index}`, chatId:`oc_chat_${index}`, lastStatus:null
    })));
    const watches = await store.list();
    assert.equal(watches.length, 20);
    assert.deepEqual(watches.map((item) => item.taskId).sort(), Array.from({ length:20 }, (_, index) => `task-${index}`).sort());
  } finally {
    await fs.rm(directory, { recursive:true, force:true });
  }
});

test('文件锁在临界区超过原 TTL 时持续续租，第二个 store 不会并发进入', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-watch-'));
  const filePath = path.join(directory, 'watches.json');
  const first = new FileCompletionWatchStore(filePath, { lockLeaseMs:25 });
  const second = new FileCompletionWatchStore(filePath, { lockLeaseMs:25 });
  let active = 0; let maximum = 0;
  try {
    const longOperation = first.withFileLock(async () => {
      active += 1; maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 90));
      active -= 1;
    });
    await new Promise((resolve) => setTimeout(resolve, 35));
    const contender = second.withFileLock(async () => {
      active += 1; maximum = Math.max(maximum, active); active -= 1;
    });
    await Promise.all([longOperation, contender]);
    assert.equal(maximum, 1);
  } finally {
    await fs.rm(directory, { recursive:true, force:true });
  }
});

test('回收 stale lock 前若路径已被新 token 原子替换，不会删除新锁', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-army-watch-'));
  const filePath = path.join(directory, 'watches.json');
  const lockPath = `${filePath}.lock`;
  try {
    await fs.writeFile(lockPath, JSON.stringify({ token:'stale-token', expiresAt:'2020-01-01T00:00:00.000Z' }), { mode:0o600 });
    const store = new FileCompletionWatchStore(filePath, {
      beforeStaleReclaim:async () => {
        const replacement = `${lockPath}.replacement`;
        await fs.writeFile(replacement, JSON.stringify({ token:'live-token', expiresAt:'2099-01-01T00:00:00.000Z' }), { mode:0o600 });
        await fs.rename(replacement, lockPath);
      }
    });
    await store.recoverStaleLock(lockPath);
    assert.deepEqual(JSON.parse(await fs.readFile(lockPath, 'utf8')), { token:'live-token', expiresAt:'2099-01-01T00:00:00.000Z' });
  } finally {
    await fs.rm(directory, { recursive:true, force:true });
  }
});

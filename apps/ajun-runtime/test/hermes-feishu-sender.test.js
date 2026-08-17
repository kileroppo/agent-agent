import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { HermesFeishuSender, HermesFeishuSenderError } from '../src/hermes-feishu-sender.ts';

test('Hermes 飞书回话只向受控原会话发送 stdin 文本，不经过 shell', async () => {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdin.end = (message) => {
      calls.push({ command, args, options, message });
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(JSON.stringify({ success:true, message_id:'om_provider_123' })));
        child.emit('close', 0);
      });
    };
    child.kill = () => undefined;
    return child;
  };
  const sender = new HermesFeishuSender({
    command:'/safe/hermes',
    hermesHome:'/safe/profile',
    spawnImpl,
    timeoutMs:1_000
  });

  const result = await sender.send('oc_content_1234', { markdown:'任务已完成。', idempotencyKey:'delivery-key-1' });

  assert.equal(result.success, true);
  assert.deepEqual(calls[0].args, ['send', '--to', 'feishu:oc_content_1234', '--file', '-', '--json']);
  assert.equal(calls[0].options.stdio[0], 'pipe');
  assert.equal(calls[0].options.env.HERMES_HOME, '/safe/profile');
  assert.equal(calls[0].options.env.HERMES_DELIVERY_IDEMPOTENCY_KEY, 'delivery-key-1');
  assert.equal(calls[0].message, '任务已完成。');
  assert.equal(result.deliveryConfirmed, true);
  assert.equal(result.deliveryEvidence.reference, 'om_provider_123');
  assert.deepEqual(result.providerIdempotency, { forwardedToHermesProcess:true, providerDeduplication:'unsupported' });
});

test('Hermes 飞书回话拒绝非法会话标识和空消息', async () => {
  const sender = new HermesFeishuSender({ spawnImpl:() => { throw new Error('不应启动'); } });
  await assert.rejects(() => sender.send('../other', { markdown:'hello' }), HermesFeishuSenderError);
  await assert.rejects(() => sender.send('oc_content_1234', { markdown:'   ' }), /内容为空/);
});

test('Hermes 发送进程未启动与发送后结果未知会返回不同的投递真相', async () => {
  const notStarted = new HermesFeishuSender({ spawnImpl:() => { throw new Error('spawn failed'); } });
  await assert.rejects(
    () => notStarted.send('oc_content_1234', { markdown:'任务已完成。' }),
    (error) => error instanceof HermesFeishuSenderError && error.deliveryState === 'not_started'
  );

  const unknown = new HermesFeishuSender({
    spawnImpl:() => {
      const child = new EventEmitter();
      child.stdin = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stdin.end = () => queueMicrotask(() => child.emit('close', 1));
      child.kill = () => undefined;
      return child;
    }
  });
  await assert.rejects(
    () => unknown.send('oc_content_1234', { markdown:'任务已完成。' }),
    (error) => error instanceof HermesFeishuSenderError && error.deliveryState === 'unknown'
  );
});

test('quiet 风格的 exit 0 没有 JSON provider 回执时只能视为 delivery_unknown', async () => {
  const calls = [];
  const sender = new HermesFeishuSender({
    spawnImpl:(_command, args) => {
      const child = new EventEmitter();
      child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.kill = () => undefined;
      child.stdin.end = () => { calls.push(args); queueMicrotask(() => child.emit('close', 0)); };
      return child;
    }
  });
  await assert.rejects(
    () => sender.send('oc_content_1234', { markdown:'任务已完成。' }),
    (error) => error instanceof HermesFeishuSenderError && error.deliveryState === 'unknown' && error.code === 'hermes_send_unconfirmed'
  );
  assert.equal(calls[0].includes('--quiet'), false);
  assert.equal(calls[0].includes('--json'), true);
});

test('畸形 stdout 不会成为回执或进入错误文本', async () => {
  for (const stdout of ['not-json', '{"success":true,"message_id":"Bearer secret-value"}', '{"success":false,"message_id":"om-not-success"}', '{"success":true,"message_id":""}']) {
    const sender = new HermesFeishuSender({
      spawnImpl:() => {
        const child = new EventEmitter();
        child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.kill = () => undefined;
        child.stdin.end = () => queueMicrotask(() => { child.stdout.emit('data', stdout); child.emit('close', 0); });
        return child;
      }
    });
    await assert.rejects(
      () => sender.send('oc_content_1234', { markdown:'任务已完成。' }),
      (error) => error instanceof HermesFeishuSenderError
        && error.deliveryState === 'unknown'
        && !error.message.includes('secret-value')
    );
  }
});

test('含敏感附加字段的 JSON 只保留 provider message id，不回显 stdout', async () => {
  const sender = new HermesFeishuSender({
    spawnImpl:() => {
      const child = new EventEmitter();
      child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.kill = () => undefined;
      child.stdin.end = () => queueMicrotask(() => {
        child.stdout.emit('data', '{"success":true,"message_id":"om-ok","token":"secret-value"}');
        child.emit('close', 0);
      });
      return child;
    }
  });
  const result = await sender.send('oc_content_1234', { markdown:'任务已完成。' });
  assert.equal(result.deliveryEvidence.reference, 'om-ok');
  assert.equal(JSON.stringify(result).includes('secret-value'), false);
});

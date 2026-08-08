import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { HermesFeishuSender, HermesFeishuSenderError } from '../src/hermes-feishu-sender.js';

test('Hermes 飞书回话只向受控原会话发送 stdin 文本，不经过 shell', async () => {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = (message) => {
      calls.push({ command, args, options, message });
      queueMicrotask(() => child.emit('close', 0));
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

  const result = await sender.send('oc_content_1234', { markdown:'任务已完成。' });

  assert.equal(result.success, true);
  assert.deepEqual(calls[0].args, ['send', '--to', 'feishu:oc_content_1234', '--file', '-', '--quiet']);
  assert.equal(calls[0].options.stdio[0], 'pipe');
  assert.equal(calls[0].options.env.HERMES_HOME, '/safe/profile');
  assert.equal(calls[0].message, '任务已完成。');
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

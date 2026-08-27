import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { RuntimeSseHub } from '../src/runtime-sse-hub.ts';

class MockResponse extends EventEmitter {
  constructor() {
    super();
    this.writtenHeaders = null;
    this.writtenChunks = [];
    this.ended = false;
  }

  writeHead(statusCode, headers) {
    this.statusCode = statusCode;
    this.writtenHeaders = headers;
  }

  write(chunk) {
    this.writtenChunks.push(chunk);
    return true;
  }

  end() {
    this.ended = true;
    this.emit('close');
  }
}

test('RuntimeSseHub 能够正确注册客户端、发送首包并处理广播与心跳', async () => {
  const hub = new RuntimeSseHub();
  const res1 = new MockResponse();
  const res2 = new MockResponse();

  const client1 = hub.addClient(res1, { heartbeatIntervalMs: 50 });
  const client2 = hub.addClient(res2, { taskId: 'task-123', heartbeatIntervalMs: 50 });

  assert.equal(hub.clientCount(), 2);
  assert.equal(res1.statusCode, 200);
  assert.equal(res1.writtenHeaders['content-type'], 'text/event-stream');
  assert.match(res1.writtenChunks[0], /: connected client=sse-client-1/);

  // 全局广播
  hub.broadcast('ping', { message: 'hello' });
  assert.ok(res1.writtenChunks.some((c) => c.includes('event: ping') && c.includes('hello')));
  assert.ok(res2.writtenChunks.some((c) => c.includes('event: ping') && c.includes('hello')));

  // 指定任务定向广播
  hub.broadcastTaskUpdate('task-123', { status: 'running', progress: 0.5 });
  assert.ok(res2.writtenChunks.some((c) => c.includes('task_update') && c.includes('task-123')));

  // 断开清理
  res1.emit('close');
  assert.equal(hub.clientCount(), 1);

  hub.close();
  assert.equal(hub.clientCount(), 0);
});

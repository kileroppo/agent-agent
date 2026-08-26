import assert from 'node:assert/strict';
import test from 'node:test';
import { EventStreamGovernor } from '../src/event-stream-governor.ts';

test('EventStreamGovernor 队列在容量内正常接收并排队', () => {
  const governor = new EventStreamGovernor({ capacity: 5 });
  governor.push({ type: 'task_started', timestamp: '2026-08-25T10:00:00Z' });
  governor.push({ type: 'stage_progress', timestamp: '2026-08-25T10:00:01Z' });

  assert.equal(governor.size(), 2);
  const drained = governor.drain(2);
  assert.equal(drained.length, 2);
  assert.equal(governor.size(), 0);
});

test('EventStreamGovernor 溢出时优先丢弃 verbose 与 normal 事件，保护 critical 关键事件', () => {
  const dropped = [];
  const governor = new EventStreamGovernor({
    capacity: 3,
    onDrop: (e) => { dropped.push(e.type); },
  });

  // 放入 1 个 critical，2 个 verbose
  governor.push({ type: 'task_started', timestamp: '1' }); // critical
  governor.push({ type: 'subtask_tick', timestamp: '2' }); // verbose
  governor.push({ type: 'subtask_tick', timestamp: '3' }); // verbose
  assert.equal(governor.size(), 3);

  // 此时放入一个新的 critical 事件 -> 应该淘汰一个 verbose 事件
  const ok = governor.push({ type: 'task_succeeded', timestamp: '4' });
  assert.equal(ok, true);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0], 'subtask_tick');

  // 验证当前队列中的事件包含两个 critical
  const metrics = governor.getMetrics();
  assert.equal(metrics.criticalCount, 2);
  assert.equal(metrics.droppedCount, 1);
});

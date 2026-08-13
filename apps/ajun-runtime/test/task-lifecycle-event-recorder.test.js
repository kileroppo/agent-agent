import assert from 'node:assert/strict';
import test from 'node:test';

import { TaskLifecycleEventRecorder } from '../src/task-lifecycle-event-recorder.js';

function eventFixture() {
  const events = new Map();
  return {
    events,
    recorder:new TaskLifecycleEventRecorder({ eventStore:{
      appendTaskRunEvent(event) {
        if (events.has(event.eventId)) {
          throw Object.assign(new Error('duplicate'), { code:'task_run_event_exists' });
        }
        events.set(event.eventId, structuredClone(event));
      },
    } }),
  };
}

function task(patch = {}) {
  return {
    taskId:'task-1', status:'running', currentStage:'delegated', createdAt:'2026-08-13T00:00:00.000Z',
    updatedAt:'2026-08-13T00:01:00.000Z', assigneeAgentId:'xiaod', workflow:{ workflowId:'workflow-1', stepId:'step-1' },
    artifactRefs:[], ...patch,
  };
}

test('异步持久化后统一记录完成、阻塞和普通状态', () => {
  const { events, recorder } = eventFixture();
  recorder.recordPersisted(task({ status:'running', currentStage:'xiaod_running' }));
  recorder.recordPersisted(task({ status:'succeeded', currentStage:'xiaod_completed', artifactRefs:[{ artifactId:'delivery-1' }] }), {
    previousTask:task({ status:'running', currentStage:'xiaod_running' }),
  });
  recorder.recordPersisted(task({ status:'needs_input', currentStage:'xiaod_awaiting_delivery', error:{ code:'delivery_pending' } }), {
    previousTask:task({ status:'running', currentStage:'xiaod_running' }),
  });

  const values = [...events.values()];
  assert.equal(values.some((event) => event.eventType === 'workflow_state_changed' && event.status === 'running'), true);
  assert.equal(values.some((event) => event.eventType === 'workflow_completed' && event.status === 'succeeded'), true);
  assert.equal(values.some((event) => event.eventType === 'workflow_blocked' && event.status === 'needs_input' && event.errorCode === 'delivery_pending'), true);
  assert.equal(values.some((event) => event.eventType === 'artifact_committed' && event.artifactRefs[0] === 'delivery-1'), true);
});

test('相同异步结果重复回放不会重复写运行事件', () => {
  const { events, recorder } = eventFixture();
  const completed = task({ status:'succeeded', currentStage:'xiaod_completed', artifactRefs:[{ artifactId:'delivery-1' }] });
  const previous = task({ status:'running', currentStage:'xiaod_running' });

  recorder.recordPersisted(completed, { previousTask:previous });
  const firstSize = events.size;
  recorder.recordPersisted(completed, { previousTask:previous });
  recorder.recordPersisted(completed, { previousTask:completed });

  assert.equal(events.size, firstSize);
  assert.equal([...events.values()].filter((event) => event.eventType === 'workflow_completed').length, 1);
  assert.equal([...events.values()].filter((event) => event.eventType === 'artifact_committed').length, 1);
});

test('创建事件复用统一持久化投影且重复调用保持幂等', () => {
  const { events, recorder } = eventFixture();
  const created = task({
    status:'waiting_approval', currentStage:'approval_required', updatedAt:'2026-08-13T00:00:00.000Z',
    deliveryBrief:{ readiness:'ready' },
  });

  recorder.recordCreated(created, created.createdAt);
  recorder.recordCreated(created, created.createdAt);

  assert.equal(events.size, 3);
  assert.deepEqual([...events.values()].map((event) => event.eventType), [
    'task_received', 'delivery_brief_resolved', 'workflow_blocked',
  ]);
});

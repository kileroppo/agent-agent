import assert from 'node:assert/strict';
import test from 'node:test';
import { XiaodDeliveryResume } from '../src/xiaod-delivery-resume.js';
import { setupTaskService } from './support/task-service-fixture.js';

test('XiaodDeliveryResume 隐藏单飞恢复协议并保留构造后 Adapter override Seam', async () => {
  const { service, records } = setupTaskService();
  records.tasks.push({
    taskId:'delivery-resume', taskType:'media.transcribe-and-refine', status:'needs_input',
    currentStage:'xiaod_awaiting_delivery', assigneeAgentId:'xiaod', source:{ chatRef:'chat-a' },
    execution:{ executor:'xiaod', xiaodJobId:'job-1' },
  });
  const deliveryResume = new XiaodDeliveryResume(service);
  let calls = 0;
  let release;
  service.executors.xiaod = {
    async redeliver() {
      calls += 1;
      await new Promise((resolve) => { release = resolve; });
      return { status:'awaiting_delivery', progress:90 };
    },
  };

  const first = deliveryResume.request('delivery-resume', { chatRef:'chat-a' });
  const second = deliveryResume.request('delivery-resume', { chatRef:'chat-a' });
  assert.equal(first, second);
  const accepted = await first;
  assert.equal(accepted.status, 'queued');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(records.tasks[0].status, 'needs_input');
  assert.equal(records.tasks[0].error.code, 'xiaod_delivery_pending');
  assert.equal(service.xiaodDeliveryRequestRuns.size, 0);
  assert.equal(service.xiaodDeliveryRuns.size, 0);
});

test('XiaodDeliveryResume 保留后台 observe 异常的失败身份和可重试状态', async () => {
  const { service, records } = setupTaskService();
  records.tasks.push({
    taskId:'delivery-observe-failure', taskType:'media.transcribe-and-refine', status:'needs_input',
    currentStage:'xiaod_awaiting_delivery', execution:{ executor:'xiaod', xiaodJobId:'job-2' },
  });
  let release;
  service.executors.xiaod = {
    async redeliver() {
      await new Promise((resolve) => { release = resolve; });
      return { status:'completed', progress:100 };
    },
    observe() { throw new Error('observer unavailable'); },
  };

  const accepted = await new XiaodDeliveryResume(service).request('delivery-observe-failure');
  assert.equal(accepted.status, 'queued');
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(records.tasks[0].status, 'needs_input');
  assert.equal(records.tasks[0].currentStage, 'xiaod_awaiting_delivery');
  assert.equal(records.tasks[0].error.code, 'xiaod_delivery_retry_failed');
  assert.match(records.tasks[0].error.userMessage, /再次回复“继续飞书交付”/);
});

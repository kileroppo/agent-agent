import assert from 'node:assert/strict';
import test from 'node:test';
import { registerSourceCompletionWatch } from '../src/source-completion-watch.js';

test('飞书来源任务在 API 返回前由服务端登记终态回告', async () => {
  const calls = [];
  const result = await registerSourceCompletionWatch({
    taskId:'task-feishu', source:{ channel:'feishu', chatRef:'oc_owner' },
  }, { async watch(input){ calls.push(input); } });
  assert.deepEqual(calls, [{ taskId:'task-feishu', chatId:'oc_owner' }]);
  assert.deepEqual(result, { required:true, registered:true, taskId:'task-feishu' });
});

test('终态回告登记失败不会抹掉已创建任务但必须显式返回失败状态', async () => {
  const result = await registerSourceCompletionWatch({
    mission:{ taskId:'mission-feishu', source:{ channel:'feishu', chatRef:'oc_owner' } },
  }, { async watch(){ throw new Error('disk unavailable'); } });
  assert.equal(result.required, true);
  assert.equal(result.registered, false);
  assert.equal(result.errorCode, 'completion_watch_registration_failed');
});

test('非飞书来源不建立外部回告', async () => {
  const result = await registerSourceCompletionWatch({
    taskId:'task-local', source:{ channel:'local-ui' },
  }, { async watch(){ throw new Error('不应调用'); } });
  assert.deepEqual(result, { required:false, registered:false });
});

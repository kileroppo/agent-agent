import assert from 'node:assert/strict';
import test from 'node:test';
import { FeishuCardActionEngine } from '../src/feishu-card-action-engine.ts';

test('FeishuCardActionEngine 正常路由动作并返回成功 Toast 与就地更新卡片', async () => {
  const engine = new FeishuCardActionEngine();

  engine.registerHandler('retry_task', async ({ value, userId }) => {
    assert.equal(value.taskId, 't-888');
    assert.equal(userId, 'ou_user_123');
    return {
      success: true,
      message: '任务已重新提交入队',
      updatedSummary: '正在重新分配 Worker 并续接执行。',
    };
  });

  const res = await engine.handleAction({
    action: {
      tag: 'button',
      value: { actionType: 'retry_task', taskId: 't-888' },
    },
    user_id: 'ou_user_123',
    open_message_id: 'om_msg_999',
  });

  assert.equal(res.toast.type, 'success');
  assert.equal(res.toast.content, '任务已重新提交入队');
  assert.equal(res.card.header.template, 'green');
  assert.ok(res.card.elements[0].text.content.includes('✅ 任务已重新提交入队'));
  assert.ok(res.card.elements[0].text.content.includes('此卡片交互已完结'));
});

test('FeishuCardActionEngine 处理未知动作时返回错误 Toast', async () => {
  const engine = new FeishuCardActionEngine();
  const res = await engine.handleAction({
    action: {
      tag: 'button',
      value: { actionType: 'unknown_action' },
    },
  });

  assert.equal(res.toast.type, 'error');
  assert.ok(res.toast.content.includes('未知的操作类型'));
  assert.equal(res.card.header.template, 'red');
});

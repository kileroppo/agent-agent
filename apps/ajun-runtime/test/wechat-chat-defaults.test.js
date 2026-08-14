import assert from 'node:assert/strict';
import test from 'node:test';
import { inferChatSelector, normalizeWechatChatRequest } from '../src/wechat-chat-defaults.ts';

test('微信聊天请求只要求群名，其余采用有主见的安全默认值', () => {
  const now = new Date('2026-07-30T14:25:30+08:00');
  const request = normalizeWechatChatRequest({
    title:'获取微信聊天',
    description:'群名：yingz'
  }, { now });

  assert.equal(request.chatSelector, 'yingz');
  assert.equal(request.startTime, '2026-07-29T16:00:00.000Z');
  assert.equal(request.endTime, now.toISOString());
  assert.equal(request.maxMessages, 200);
  assert.equal(request.outputMode, 'local-summary');
  assert.equal(request.refreshMode, 'incremental');
  assert.equal(request.sameNameStrategy, 'latest-active-session');
  assert.equal(request.privateContentModelAccess, 'local-only');
});

test('未来结束时间不会把一次性读取伪装成持续监控', () => {
  const now = new Date('2026-07-30T09:00:00+08:00');
  const request = normalizeWechatChatRequest({
    chatSelector:'yingz',
    endTime:'2026-07-30T22:00:00+08:00'
  }, { now });
  assert.equal(request.endTime, now.toISOString());
  assert.equal(request.requestedFutureEndClampedToNow, true);
});

test('常见中文说法可以自动提取群名', () => {
  assert.equal(inferChatSelector('帮我读取 yингz 群的微信聊天'), 'yингz');
  assert.equal(inferChatSelector('获取微信聊天，群名：yingz'), 'yingz');
});

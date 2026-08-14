import test from 'node:test';
import assert from 'node:assert/strict';
import { FeishuChannelBridge, FeishuChannelBridgeError } from '../src/feishu-channel-bridge.ts';

function setup() {
  const calls = { messages:[], approvals:[] };
  const bridge = new FeishuChannelBridge({
    commander:{ async handle(input) { calls.messages.push(input); return { reply:`已接住：${input.text}` }; } },
    async resolveApproval(input) { calls.approvals.push(input); return { status:'approved' }; }
  });
  return { bridge, calls };
}

test('官方收发入口把私聊规范化消息交给现有总管，并保留原会话与事件编号', async () => {
  const { bridge, calls } = setup();
  const result = await bridge.handleMessage({ eventRef:'feishu:evt-1', text:'检查系统状态', chatType:'p2p', chatRef:'chat-1', requesterRef:'person-1' });

  assert.equal(result.handled, true);
  assert.equal(result.deduplicated, false);
  assert.deepEqual(calls.messages[0], { text:'检查系统状态', sourceEventRef:'feishu:evt-1', requesterRef:'person-1', chatRef:'chat-1', targetAgentId:undefined });
});

test('同一官方消息重复投递时不重复调用总管', async () => {
  const { bridge, calls } = setup();
  await bridge.handleMessage({ eventRef:'feishu:evt-2', text:'检查系统状态', chatType:'p2p' });
  const duplicate = await bridge.handleMessage({ eventRef:'feishu:evt-2', text:'检查系统状态', chatType:'p2p' });

  assert.equal(calls.messages.length, 1);
  assert.equal(duplicate.deduplicated, true);
});

test('群内没有 @ A君 时不创建任务', async () => {
  const { bridge, calls } = setup();
  const result = await bridge.handleMessage({ eventRef:'feishu:evt-3', text:'有人在吗', chatType:'group', mentioned:false });

  assert.equal(result.handled, false);
  assert.equal(calls.messages.length, 0);
});

test('群内 @ A君 的消息可进入同一套总管路由', async () => {
  const { bridge, calls } = setup();
  await bridge.handleMessage({ eventRef:'feishu:evt-4', text:'@A君 看看状态', chatType:'group', mentioned:true, targetAgentId:'xiaod' });

  assert.equal(calls.messages.length, 1);
  assert.equal(calls.messages[0].targetAgentId, 'xiaod');
});

test('官方卡片回调只把允许的决定交给原有审批真相', async () => {
  const { bridge, calls } = setup();
  const result = await bridge.handleCardAction({ approvalId:'approval-1', action:'approve', governanceMode:'paperclip', chatRef:'chat-1', requesterRef:'person-1' });

  assert.equal(result.result.status, 'approved');
  assert.deepEqual(calls.approvals[0], { approvalId:'approval-1', action:'approve', governanceMode:'paperclip', chatRef:'chat-1', requesterRef:'person-1' });
});

test('缺失或未知卡片动作不会执行审批', async () => {
  const { bridge, calls } = setup();
  await assert.rejects(() => bridge.handleCardAction({ approvalId:'approval-1', action:'delete', governanceMode:'local' }), FeishuChannelBridgeError);
  assert.equal(calls.approvals.length, 0);
});

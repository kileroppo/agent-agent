import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialFeishuChannelRunner, OfficialFeishuChannelRunnerError, approvalCard, officialChannelOptions } from '../src/official-feishu-channel-runner.ts';

function setup({ environment = { AJUN_FEISHU_CHANNEL_ENABLED:'true', AJUN_FEISHU_CHANNEL_APP_ID:'app', AJUN_FEISHU_CHANNEL_APP_SECRET:'secret', AJUN_FEISHU_CHANNEL_ALLOWED_USER_IDS:'person-a' } } = {}) {
  const sent = []; let handlers = null; let connects = 0;
  const channel = { on(value) { handlers = value; }, async connect() { connects += 1; }, async disconnect() {}, async reply(message, input) { sent.push({ message, input }); }, async send() {} };
  const bridge = {
    async handleMessage(input) { return { handled:true, result:{ reply:`收到：${input.text}`, approval:{ approvalId:'approval-a', governanceMode:'local', reason:'只在本次范围内处理。', requestedScope:{ title:'整理公开网页' } } } }; },
    async handleCardAction(input) { return { action:input, result:{ task:{ taskId:'task-a' } } }; }
  };
  const runner = new OfficialFeishuChannelRunner({ bridge, createChannel:() => channel, environment, logger:{ info(){}, warn(){} } });
  return { runner, sent, channel, get handlers() { return handlers; }, get connects() { return connects; } };
}

test('未明确启用时官方飞书入口保持关闭，不影响现有入口', async () => {
  const { runner } = setup({ environment:{} });
  const result = await runner.start();
  assert.equal(result.status, 'disabled');
  assert.equal(result.message, '官方飞书入口尚未启用；现有 A君入口保持不变。');
  assert.ok(result.updatedAt);
  assert.equal(runner.snapshot().status, 'disabled');
});

test('启用后只把官方规范化消息交给 A君，并回复原消息和审批卡', async () => {
  const state = setup();
  await state.runner.start();
  await state.handlers.message({ messageId:'msg-a', content:'整理网页', chatType:'p2p', mentionedBot:false, chatId:'chat-a', senderId:'person-a' });

  assert.equal(state.connects, 1);
  assert.equal(state.runner.snapshot().status, 'connected');
  assert.equal(state.sent.length, 2);
  assert.deepEqual(state.sent[0].input, { markdown:'收到：整理网页' });
  assert.equal(state.sent[1].input.card.header.title.content, 'A君 · 请你确认');
  assert.deepEqual(state.sent[1].input.card.elements[1].actions[0].value, { approvalId:'approval-a', governanceMode:'local', action:'approve', taskControlAction:null });
});

test('独立员工飞书智能体会带上自己的岗位身份进入同一条任务真相', async () => {
  const state = setup();
  const seen = [];
  state.runner.bridge.handleMessage = async (input) => { seen.push(input); return { handled:true, result:{ reply:'运维官已接手。' } }; };
  state.runner.targetAgentId = 'operator';
  await state.runner.start();
  await state.handlers.message({ messageId:'operator-message', content:'检查一下', chatType:'p2p', mentionedBot:false, chatId:'chat-operator', senderId:'person-a' });
  assert.equal(seen[0].targetAgentId, 'operator');
  assert.equal(state.sent[0].input.markdown, '运维官已接手。');
});

test('独立员工提供自己的飞书应用配置时，不受 A君旧环境开关限制', async () => {
  const state = setup();
  state.runner.channelOptions = { appId:'cli-operator', appSecret:'secret', transport:'websocket', policy:{} };
  state.runner.environment = {};
  assert.equal(state.runner.enabled(), true);
});

test('官方卡片回调只传递批准或拒绝所需的信息，并给点击者明确结果', async () => {
  const state = setup(); await state.runner.start();
  const response = await state.handlers.cardAction({ chatId:'chat-a', operator:{ openId:'person-a' }, action:{ value:{ approvalId:'approval-a', governanceMode:'paperclip', action:'approve' } } });
  assert.equal(response.toast.content, '已批准，任务会按确认范围继续。');
  assert.equal(response.card.type, 'raw');
  assert.equal(response.card.data.header.title.content, 'A君 · 审批已处理');
  assert.equal(response.card.data.elements[0].content, '**已批准**\n\n已批准，任务会按确认范围继续。');
});

test('长任务会登记为原会话跟进，不依赖用户再来问进度', async () => {
  const watched = []; const watcher = { async start() {}, stop() {}, async watch(input) { watched.push(input); } };
  const state = setup(); const { runner, channel } = state;
  runner.bridge.handleMessage = async () => ({ handled:true, result:{ reply:'已接住。', completionWatch:{ taskId:'task-a' } } });
  runner.taskStatus = async () => ({ terminal:false, status:'running', message:'处理中。' });
  runner.completionWatchStore = { async list(){ return []; }, async upsert(){}, async remove(){} };
  runner.completionWatcherFactory = () => watcher;
  await runner.start();
  // setup() exposes the handlers through its live getter; read it after start.
  await new Promise((resolve) => setImmediate(resolve));
  // The channel keeps its handler internally; deliberately use the public on
  // hook captured by setup rather than reaching into runner internals.
  let messageHandler;
  channel.on = (handlers) => { messageHandler = handlers.message; };
  // Reconnect the test channel once with the replacement hook, mirroring a
  // restart without talking to Feishu.
  await runner.stop(); await runner.start();
  await messageHandler({ messageId:'message-a', content:'整理公开网页', chatType:'p2p', mentionedBot:false, chatId:'chat-a', senderId:'person-a' });
  assert.deepEqual(watched, [{ taskId:'task-a', chatId:'chat-a' }]);
});

test('官方飞书跟进出现投递不确定时，连接快照不再显示完全正常', () => {
  const { runner } = setup();
  runner.state = { status:'connected', message:'已连接。' };
  runner.completionWatcher = { snapshot:() => ({ status:'delivery_uncertain', uncertainDeliveries:2, message:'有 2 条投递待核对。' }) };
  assert.deepEqual(runner.snapshot(), { status:'delivery_uncertain', uncertainDeliveries:2, message:'有 2 条投递待核对。' });
});

test('缺少人员白名单时，不生成可连接的官方飞书配置', () => {
  assert.throws(() => officialChannelOptions({ AJUN_FEISHU_CHANNEL_APP_ID:'app', AJUN_FEISHU_CHANNEL_APP_SECRET:'secret' }), OfficialFeishuChannelRunnerError);
});

test('审批卡不会夹带未定义字段，只保留原审批编号和决定', () => {
  const card = approvalCard({ approvalId:'approval-a', governanceMode:'proposal', reason:'审核岗位范围', requestedScope:{ title:'公开网页摘要员工' } });
  assert.equal(card.header.title.content, 'A君 · 新员工审核');
  assert.deepEqual(card.elements[1].actions[1].value, { approvalId:'approval-a', governanceMode:'proposal', action:'reject', taskControlAction:null });
});

test('暂停和继续卡使用动作准确的按钮，并在点击后替换为无按钮的结果卡', async () => {
  const pause = approvalCard({ approvalId:'pause-a', governanceMode:'paperclip', action:'pause-task', reason:'暂停', requestedScope:{ title:'公开视频' } });
  const resume = approvalCard({ approvalId:'resume-a', governanceMode:'paperclip', action:'resume-task', reason:'继续', requestedScope:{ title:'公开视频' } });
  assert.equal(pause.elements[1].actions[0].text.content, '同意暂停');
  assert.equal(pause.elements[1].actions[1].text.content, '保持继续处理');
  assert.equal(resume.elements[1].actions[0].text.content, '同意继续');
  assert.equal(resume.elements[1].actions[1].text.content, '保持暂停');

  const state = setup(); await state.runner.start();
  const response = await state.handlers.cardAction({ chatId:'chat-a', operator:{ openId:'person-a' }, action:{ value:{ approvalId:'pause-a', governanceMode:'paperclip', action:'approve', taskControlAction:'pause-task' } } });
  assert.equal(response.toast.content, '已同意暂停；小D会在安全位置停下。');
  assert.equal(response.card.data.elements.some((element) => element.tag === 'action'), false);
  assert.match(response.card.data.elements[0].content, /已同意暂停/);
});

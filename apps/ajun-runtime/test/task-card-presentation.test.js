import assert from 'node:assert/strict';
import test from 'node:test';
import { presentTaskCard, projectTaskCard, TASK_CARD_SCHEMA_VERSION } from '../src/task-card-presentation.js';

const baseTask = {
  taskId:'7df3c85a-1111-2222-3333-444444444444',
  status:'running',
  input:{ title:'整理员工资料' },
  assigneeAgentId:'xiaoban',
  approvalRefs:[],
  updatedAt:'2026-08-12T03:00:00.000Z',
};

test('输出稳定的 task-card/v1 公共投影', () => {
  const first = presentTaskCard(baseTask, { owner:'小办' });
  const second = projectTaskCard(structuredClone(baseTask), { owner:{ label:'小办' } });

  assert.equal(first.schemaVersion, TASK_CARD_SCHEMA_VERSION);
  assert.equal(first.taskId, baseTask.taskId);
  assert.equal(first.taskRef, '#7DF3C85A');
  assert.equal(first.title, '整理员工资料');
  assert.equal(first.state, 'running');
  assert.equal(first.tone, 'active');
  assert.match(first.summary, /正在处理中/);
  assert.equal(first.owner, '小办');
  assert.match(first.nextAction, /等待/);
  assert.equal(first.sourceRevision, '2026-08-12T03:00:00.000Z:card-ux3');
  assert.equal(first.updatedAt, '2026-08-12T03:00:00.000Z');
  assert.equal(first.terminal, false);
  assert.deepEqual(first.actions, []);
  assert.match(first.contentHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(second, first);
});

test('主要任务状态映射状态、语气和终态', () => {
  for (const [status, tone, terminal] of [
    ['queued', 'active', false],
    ['running', 'active', false],
    ['needs_input', 'attention', false],
    ['waiting_test', 'attention', false],
    ['paused', 'attention', false],
    ['recovery_pending', 'attention', false],
    ['technical_repair', 'attention', false],
    ['succeeded', 'success', true],
    ['failed', 'danger', true],
    ['cancelled', 'muted', true],
  ]) {
    const card = presentTaskCard({ ...baseTask, status, updatedAt:`2026-08-12T03:${String(status.length).padStart(2, '0')}:00.000Z` });
    assert.equal(card.state, status);
    assert.equal(card.tone, tone);
    assert.equal(card.terminal, terminal);
  }
});

test('待审批覆盖任务状态并只生成批准与拒绝动作', () => {
  const approvals = [{
    approvalId:'approval-1',
    taskId:baseTask.taskId,
    status:'pending',
    governanceMode:'paperclip',
    createdAt:'2026-08-12T03:01:00.000Z',
  }];
  const card = presentTaskCard(baseTask, { approvals });

  assert.equal(card.state, 'waiting_approval');
  assert.equal(card.sourceRevision, '2026-08-12T03:01:00.000Z:card-ux3');
  assert.deepEqual(card.actions, [
    { action:'approve', label:'批准', approvalId:'approval-1', governanceMode:'paperclip' },
    { action:'reject', label:'拒绝', approvalId:'approval-1', governanceMode:'paperclip' },
  ]);
});

test('暂停与继续审批使用普通用户能理解的确认文案', () => {
  const pause = presentTaskCard(baseTask, { approvals:[{
    approvalId:'pause-1', taskId:baseTask.taskId, action:'pause-task', status:'pending', governanceMode:'paperclip',
  }] });
  const resume = presentTaskCard(baseTask, { approvals:[{
    approvalId:'resume-1', taskId:baseTask.taskId, action:'resume-task', status:'pending', governanceMode:'paperclip',
  }] });

  assert.deepEqual(pause.actions.map((item) => item.label), ['确认暂停', '保持运行']);
  assert.deepEqual(resume.actions.map((item) => item.label), ['确认继续', '保持暂停']);
});

test('只接受四种白名单动作并过滤终态的陈旧动作', () => {
  const recoveryView = {
    state:'technical_repair',
    updatedAt:'2026-08-12T03:02:00.000Z',
    actions:[
      { actionKey:'pause', label:'先暂停' },
      { actionKey:'resume', label:'继续处理' },
      { actionKey:'retry', label:'危险的平行动作' },
      { action:'approve', label:'确认继续', approvalId:'approval-2' },
      { taskControlAction:'delete', label:'删除任务' },
      { actionKey:'pause', label:'重复动作' },
    ],
  };
  const active = presentTaskCard(baseTask, { recoveryView });
  assert.equal(active.state, 'technical_repair');
  assert.deepEqual(active.actions.map((item) => item.action), ['pause', 'resume', 'approve']);
  assert.equal(active.actions[0].label, '先暂停');

  const terminal = presentTaskCard({ ...baseTask, status:'succeeded' }, {
    recoveryView:{ ...recoveryView, state:'done' },
  });
  assert.deepEqual(terminal.actions, []);
});

test('只使用传入且属于任务的审批，不自行推断无关审批', () => {
  const card = presentTaskCard({ ...baseTask, approvalRefs:['approval-matching'] }, { approvals:[
    { approvalId:'approval-other', taskId:'other-task', status:'pending' },
    { approvalId:'approval-matching', taskId:'legacy-missing', status:'approved' },
  ] });
  assert.equal(card.state, 'running');
  assert.deepEqual(card.actions, []);
});

test('公开文本脱敏且 contentHash 不包含原始秘密', () => {
  const secret = 'raw-secret-value';
  const card = presentTaskCard({
    ...baseTask,
    status:'needs_input',
    input:{ title:`读取 https://private.example/path?token=${secret}` },
    error:{ userMessage:`password=${secret}，请重新授权。` },
  }, { owner:`token=${secret}` });
  const serialized = JSON.stringify(card);

  assert.doesNotMatch(serialized, /private\.example|raw-secret-value/);
  assert.match(card.title, /\[链接已脱敏\]/);
  assert.match(card.nextAction, /\[已脱敏\]/);
  assert.match(card.owner, /\[已脱敏\]/);
  assert.match(card.contentHash, /^[a-f0-9]{64}$/);
});

test('小D飞书交付失败说明真实影响、责任边界和唯一恢复动作', () => {
  const card = presentTaskCard({
    ...baseTask,
    status:'needs_input',
    error:{
      code:'xiaod_delivery_pending',
      userMessage:'小D已安全保存本地确认稿，但飞书交付尚未开始。请修复飞书配置。',
    },
  });

  assert.match(card.summary, /视频处理结果已保存/);
  assert.match(card.summary, /报告发送到飞书失败/);
  assert.match(card.nextAction, /不是你的操作问题/);
  assert.match(card.nextAction, /系统管理员/);
  assert.match(card.nextAction, /继续飞书交付/);
});

test('小D交付完成且权限确认后只投影可信飞书文档入口', () => {
  const card = presentTaskCard({
    taskId:'task-delivered', status:'succeeded', input:{ title:'整理公开视频' },
    artifactRefs:[{
      type:'xiaod_media_delivery',
      data:{ larkUrl:'https://feishu.cn/docx/docx123', larkPermissionGranted:true },
    }],
  });
  assert.deepEqual(card.primaryLink, {
    label:'打开交付文档',
    url:'https://feishu.cn/docx/docx123',
  });

  const unsafe = presentTaskCard({
    taskId:'task-unsafe-link', status:'succeeded', input:{ title:'整理公开视频' },
    artifactRefs:[{
      type:'xiaod_media_delivery',
      data:{ larkUrl:'https://example.com/docx/docx123', larkPermissionGranted:true },
    }],
  });
  assert.equal(unsafe.primaryLink, null);
});

test('缺少时间戳的旧任务使用稳定的无秘密修订摘要', () => {
  const legacy = { taskId:'legacy-1', status:'paused', input:{ title:'旧任务' } };
  const first = presentTaskCard(legacy, { recoveryView:{ actions:[{ actionKey:'resume' }] } });
  const second = presentTaskCard(structuredClone(legacy), { recoveryView:{ actions:[{ actionKey:'resume' }] } });
  assert.match(first.sourceRevision, /^legacy:[a-f0-9]{16}$/);
  assert.equal(second.sourceRevision, first.sourceRevision);
  assert.equal(second.contentHash, first.contentHash);
});

test('仅真相时间推进不会改变可见内容哈希', () => {
  const before = presentTaskCard(baseTask);
  const after = presentTaskCard({ ...baseTask, updatedAt:'2026-08-12T03:30:00.000Z' });
  assert.notEqual(after.sourceRevision, before.sourceRevision);
  assert.equal(after.contentHash, before.contentHash);
});

test('只有受现有小D控制契约支持的任务才展示暂停或继续', () => {
  const running = presentTaskCard({
    ...baseTask,
    execution:{ executor:'xiaod', xiaodJobId:'job-1' },
  });
  assert.deepEqual(running.actions.map((item) => item.action), ['pause']);

  const paused = presentTaskCard({
    ...baseTask,
    status:'paused',
    execution:{ executor:'xiaod', xiaodJobId:'job-1' },
  });
  assert.deepEqual(paused.actions.map((item) => item.action), ['resume']);

  const unsupported = presentTaskCard({ ...baseTask, execution:{ executor:'paperclip' } });
  assert.deepEqual(unsupported.actions, []);
});

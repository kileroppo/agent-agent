import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const moduleDirectory = path.resolve(here, '../runtime');
const hermesHome = process.env.HERMES_HOME || path.join(homedir(), '.hermes', 'hermes-agent');
const python = process.env.HERMES_PYTHON || path.join(hermesHome, 'venv', 'bin', 'python');

function runPython(lines) {
  const script = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(moduleDirectory)})`,
    'from agent_army_feishu_task_card import AgentArmyFeishuTaskCardAdapter, HermesTaskCardCompatibilityError, SUPERVISOR_MAX_CONCURRENCY, SUPPORTED_HERMES_GIT_COMMIT, SUPPORTED_HERMES_VERSION, TASK_CARD_ADAPTER_SEAM, decide_task_card_delivery, install_agent_army_feishu_task_card_adapter, is_trusted_task_card_event, poll_interval_seconds, render_task_card, task_card_policy_decision, trusted_task_card_handler',
    ...lines,
  ].join('\n');
  const result = spawnSync(python, ['-c', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function projection(overrides = {}) {
  return {
    schemaVersion: 'agent.army/task-card/v1',
    taskId: 'task-123',
    agentId: 'intel-researcher',
    profileId: 'intel-researcher',
    chatId: 'oc_research',
    taskRef: 'T-123',
    title: '调研竞争产品',
    state: '等待审批',
    tone: 'orange',
    summary: '资料已整理，等待批准后继续。',
    owner: '小研',
    nextAction: '批准或拒绝所列范围',
    actions: ['approve', 'reject'],
    sourceRevision: 7,
    contentHash: 'sha256:seven',
    terminal: false,
    updatedAt: '2026-08-12T10:00:00Z',
    ...overrides,
  };
}

function render(value, { detailsExpanded = false } = {}) {
  return runPython([
    `projection = json.loads(${JSON.stringify(JSON.stringify(value))})`,
    `print(json.dumps(render_task_card(projection, details_expanded=${detailsExpanded ? 'True' : 'False'}), ensure_ascii=False))`,
  ]);
}

function decide(record, value) {
  return runPython([
    `record = json.loads(${JSON.stringify(JSON.stringify(record))})`,
    `projection = json.loads(${JSON.stringify(JSON.stringify(value))})`,
    'print(json.dumps(decide_task_card_delivery(record, projection), ensure_ascii=False))',
  ]);
}

function decideWithPolicy(record, value, taskCardPolicy) {
  return runPython([
    `record = json.loads(${JSON.stringify(JSON.stringify(record))})`,
    `projection = json.loads(${JSON.stringify(JSON.stringify(value))})`,
    `policy = json.loads(${JSON.stringify(JSON.stringify(taskCardPolicy))})`,
    'print(json.dumps(decide_task_card_delivery(record, projection, task_card_policy=policy), ensure_ascii=False))',
  ]);
}

test('渲染单张 interactive card，并严格过滤动作白名单', () => {
  const card = render(projection({ tone:'attention', actions: [
    { action:'approve', approvalId:'approval-1', governanceMode:'paperclip' },
    'delete',
    { id: 'pause' },
    'reject',
  ] }));
  assert.equal(card.header.template, 'orange');
  assert.equal(card.config.update_multi, true);
  const actionRow = card.elements.find((element) => element.tag === 'action');
  assert.deepEqual(
    actionRow.actions.map((button) => button.value.agent_army_task_card_action),
    ['approve', 'pause', 'reject'],
  );
  assert.ok(actionRow.actions.every((button) => button.value.task_id === 'task-123'));
  assert.ok(actionRow.actions.every((button) => button.value.taskId === 'task-123'));
  assert.ok(actionRow.actions.every((button) => button.value.agentId === 'intel-researcher'));
  assert.ok(actionRow.actions.every((button) => button.value.profileId === 'intel-researcher'));
  assert.ok(actionRow.actions.every((button) => button.value.chatId === 'oc_research'));
  assert.equal(actionRow.actions[0].value.approval_id, 'approval-1');
  assert.equal(actionRow.actions[0].value.governance_mode, 'paperclip');
  const refresh = card.elements
    .filter((element) => element.tag === 'action')
    .flatMap((element) => element.actions)
    .find((button) => button.value.agent_army_task_card_action === 'refresh');
  assert.equal(refresh.text.content, '刷新任务状态');
  assert.equal(refresh.value.profileId, 'intel-researcher');
  const details = card.elements
    .filter((element) => element.tag === 'action')
    .flatMap((element) => element.actions)
    .find((button) => button.value.agent_army_task_card_action === 'details');
  assert.equal(details.text.content, '查看任务详情');
  assert.equal(card.elements.some((element) => element.tag === 'markdown' && element.content.includes('**任务详情**')), false);
});

test('任务详情在飞书卡片内展开，并提供明确的收起与刷新入口', () => {
  const card = render(projection({
    details:{
      taskType:'公开情报调研',
      createdAt:'2026-08-12T09:00:00Z',
      updatedAt:'2026-08-12T10:00:00Z',
    },
  }), { detailsExpanded:true });
  const details = card.elements.find((element) =>
    element.tag === 'markdown' && element.content.includes('**任务详情**'));
  assert.match(details.content, /\*\*任务编号\*\*：T-123/);
  assert.match(details.content, /\*\*任务类型\*\*：公开情报调研/);
  assert.match(details.content, /\*\*创建时间\*\*：2026-08-12 17:00/);
  const actions = card.elements
    .filter((element) => element.tag === 'action')
    .flatMap((element) => element.actions);
  assert.equal(actions.find((button) => button.value?.agent_army_task_card_action === 'collapse_details').text.content, '收起任务详情');
  assert.equal(actions.find((button) => button.value?.agent_army_task_card_action === 'refresh').text.content, '刷新任务状态');
});

test('优先使用权威投影的任务控制文案，并避免重复显示下一步', () => {
  const card = render(projection({
    summary:'视频处理结果已保存。请联系管理员检查连接。',
    nextAction:'请联系管理员检查连接。',
    actions:[
      { action:'approve', label:'确认暂停', approvalId:'pause-1', governanceMode:'paperclip' },
      { action:'reject', label:'保持运行', approvalId:'pause-1', governanceMode:'paperclip' },
    ],
  }));
  const actionButtons = card.elements
    .filter((element) => element.tag === 'action')
    .flatMap((element) => element.actions)
    .filter((button) => ['approve', 'reject'].includes(button.value.agent_army_task_card_action));
  assert.deepEqual(actionButtons.map((button) => button.text.content), ['确认暂停', '保持运行']);
  assert.equal(card.elements.some((element) => element.tag === 'markdown' && element.content.startsWith('**下一步**')), false);
});

test('终态卡片只保留只读信息和可信交付入口', () => {
  const card = render(projection({
    terminal:true,
    state:'succeeded',
    owner:'ajun',
    tone:'success',
    updatedAt:'2026-08-12T03:53:23.815Z',
    actions:['pause'],
    primaryLink:{ label:'打开交付文档', url:'https://feishu.cn/docx/docx123' },
  }));
  assert.equal(card.header.template, 'green');
  assert.equal(card.elements.some((element) => element.tag === 'action'), false);
  assert.match(card.elements[0].content, /\*\*状态\*\*：已完成/);
  assert.match(card.elements[0].content, /\*\*负责人\*\*：A君/);
  assert.ok(card.elements.some((element) => element.tag === 'markdown' && element.content.includes('**任务详情**')));
  assert.ok(card.elements.some((element) =>
    element.tag === 'markdown'
      && element.content === '[打开交付文档](https://feishu.cn/docx/docx123)'));
  assert.match(card.elements.at(-1).elements[0].content, /更新于 2026-08-12 11:53$/);
});

test('交付入口只接受可信飞书 HTTPS 域名', () => {
  const malicious = render(projection({
    terminal:true,
    primaryLink:{ label:'打开交付文档', url:'https://feishu.cn.attacker.example/docx/secret' },
  }));
  assert.equal(malicious.elements.some((element) => element.tag === 'action'), false);
  assert.equal(malicious.elements.some((element) =>
    element.tag === 'markdown' && element.content.includes('attacker.example')), false);

  const trusted = render(projection({
    terminal:false,
    primaryLink:{ label:'打开交付文档', url:'https://tenant.feishu.cn/docx/docx123' },
  }));
  const link = trusted.elements
    .filter((element) => element.tag === 'action')
    .flatMap((element) => element.actions)
    .find((button) => button.url);
  assert.equal(link.url, 'https://tenant.feishu.cn/docx/docx123');
});

test('无记录发送，有锚点且新 revision 更新，并返回 messageId', () => {
  assert.equal(decide(null, projection()).operation, 'send');
  const result = decide(
    { taskId: 'task-123', messageId: 'om_123', lastSourceRevision: 6, lastContentHash: 'sha256:six' },
    projection(),
  );
  assert.equal(result.operation, 'update');
  assert.equal(result.messageId, 'om_123');
});

test('发送结果不确定时不盲目重发', () => {
  const result = decide(
    { taskId: 'task-123', deliveryState: 'sending', lastSourceRevision: 7 },
    projection(),
  );
  assert.deepEqual([result.operation, result.reason], ['anchor_uncertain', 'send_outcome_unknown']);
});

test('只有明确未开始可重试一次，第二次后停止', () => {
  assert.equal(decide(
    { taskId:'task-123', deliveryState:'not_started', attemptCount:1 },
    projection(),
  ).operation, 'send');
  const exhausted = decide(
    { taskId:'task-123', deliveryState:'not_started', attemptCount:2 },
    projection(),
  );
  assert.deepEqual([exhausted.operation, exhausted.reason], ['skip', 'retry_exhausted']);
});

test('旧 revision 与同 revision 冲突均不得覆盖新状态或恢复审批按钮', () => {
  const terminalRecord = {
    taskId: 'task-123',
    messageId: 'om_terminal',
    lastSourceRevision: 9,
    lastContentHash: 'sha256:terminal',
    terminal: true,
  };
  assert.equal(decide(terminalRecord, projection({ sourceRevision: 8 })).reason, 'stale_projection');
  assert.equal(
    decide(terminalRecord, projection({ sourceRevision: 9, contentHash: 'sha256:buttons-restored' })).reason,
    'revision_conflict',
  );
});

test('同 taskId 的 profile、agent、chat 归属互相隔离', () => {
  const record = {
    taskId:'task-123',
    agentId:'intel-researcher',
    profileId:'intel-researcher',
    chatId:'oc_research',
    messageId:'om_original',
    lastSourceRevision:6,
    lastContentHash:'sha256:six',
  };
  assert.equal(decide(record, projection({ agentId:'xiaod' })).reason, 'agent_mismatch');
  assert.equal(decide(record, projection({ profileId:'xiaod' })).reason, 'profile_mismatch');
  assert.equal(decide(record, projection({ chatId:'oc_other' })).reason, 'chat_mismatch');
  assert.equal(decide(record, projection({ agentId:undefined })).reason, 'agent_missing');
  assert.equal(decide(record, projection({ profileId:undefined })).reason, 'profile_missing');
  assert.equal(decide(record, projection({ chatId:undefined })).reason, 'chat_missing');
  assert.equal(decide(record, projection()).operation, 'update');
});

test('缺失归属字段的既有 v1 投影保持兼容', () => {
  const legacyProjection = projection({
    agentId:undefined,
    profileId:undefined,
    chatId:undefined,
  });
  const card = render(legacyProjection);
  const refresh = card.elements
    .filter((element) => element.tag === 'action')
    .flatMap((element) => element.actions)
    .find((button) => button.value?.agent_army_task_card_action === 'refresh');
  assert.equal(refresh.value.task_id, 'task-123');
  assert.equal(refresh.value.taskId, 'task-123');
  assert.equal(refresh.value.agentId, undefined);
  assert.equal(decide({ taskId:'task-123', messageId:'om_legacy', lastSourceRevision:6 }, legacyProjection).operation, 'update');
});

test('卡片策略显式限制用途，incident-only 不从文案推断', () => {
  const disabled = decide(null, projection({ taskCardPolicy:'disabled' }));
  assert.deepEqual([disabled.operation, disabled.reason], ['skip', 'policy_disabled']);
  assert.equal(decide(null, projection({ taskCardPolicy:'routed-task' })).operation, 'send');
  assert.equal(decide(null, projection({ taskCardPolicy:'durable-task' })).operation, 'send');
  assert.equal(decide(null, projection({
    taskCardPolicy:'incident-only',
    summary:'发生 incident，需要 recovery 和 approval。',
    state:'running',
    actions:[],
  })).reason, 'incident_kind_required');
  assert.equal(decide(null, projection({
    taskCardPolicy:'incident-only',
    taskKind:'incident',
  })).operation, 'send');
  assert.equal(decide(null, projection({
    taskCardPolicy:'incident-only',
    category:'governance.approval',
  })).operation, 'send');
  assert.equal(decide(null, projection({
    taskCardPolicy:'incident-only',
    taskType:'operations.failure-recovery',
    state:'running',
    actions:[],
  })).operation, 'send');
  assert.equal(decide(null, projection({
    taskCardPolicy:'incident-only',
    taskKind:'operations.incident-response',
    state:'running',
    actions:[],
  })).operation, 'send');
  assert.equal(decide(null, projection({
    taskCardPolicy:'incident-only',
    taskKind:'operations.health-review',
    state:'waiting_approval',
    actions:['approve'],
  })).reason, 'routine_health_excluded');
  assert.equal(decide(null, projection({
    taskCardPolicy:'incident-only',
    state:'waiting_approval',
    actions:[],
  })).operation, 'send');
  assert.equal(decide(null, projection({
    taskCardPolicy:'incident-only',
    state:'running',
    actions:['approve', 'reject'],
  })).operation, 'send');
  assert.equal(decide(null, projection({ taskCardPolicy:'future-policy' })).reason, 'policy_unsupported');
  assert.equal(decideWithPolicy(null, projection({ taskCardPolicy:'durable-task' }), 'disabled').reason, 'policy_disabled');
});

test('单 supervisor 的轮询退避为 2 秒、15 秒、60 秒', () => {
  const result = runPython([
    'print(json.dumps({"concurrency": SUPERVISOR_MAX_CONCURRENCY, "intervals": [',
    '  poll_interval_seconds(age_seconds=60),',
    '  poll_interval_seconds(age_seconds=301),',
    '  poll_interval_seconds(age_seconds=1801),',
    ']}))',
  ]);
  assert.equal(result.concurrency, 3);
  assert.deepEqual(result.intervals, [2, 15, 60]);
});

test('正式 Adapter Seam 校验 Host Interface、版本并保持幂等', () => {
  const result = runPython([
    'class MessageApi:',
    '  def patch(self, request): return None',
    'class V1: message = MessageApi()',
    'class Im: v1 = V1()',
    'class Client: im = Im()',
    'class SymbolType:',
    '  def __init__(self, *args, **kwargs): pass',
    'class Host:',
    '  def __init__(self): self._client = Client()',
    '  async def connect(self): return True',
    '  async def send(self, chat_id, content, *args, **kwargs): return None',
    '  def _on_card_action_trigger(self, data): return None',
    '  async def _feishu_send_with_retry(self, **kwargs): return None',
    '  def _finalize_send_result(self, response, message): return response',
    '  def _is_interactive_operator_authorized(self, open_id): return True',
    '  async def _run_blocking(self, func, *args): return func(*args)',
    'symbols = {"get_hermes_home": lambda: "/tmp/hermes-profile", "SendResult": SymbolType, "CallBackCard": SymbolType, "P2CardActionTriggerResponse": SymbolType}',
    'first = install_agent_army_feishu_task_card_adapter(Host, hermes_version=SUPPORTED_HERMES_VERSION, hermes_git_commit=SUPPORTED_HERMES_GIT_COMMIT, host_symbols=symbols)',
    'second = install_agent_army_feishu_task_card_adapter(Host, hermes_version=SUPPORTED_HERMES_VERSION, hermes_git_commit=SUPPORTED_HERMES_GIT_COMMIT, host_symbols=symbols)',
    'version_closed = False',
    'try:',
    '  install_agent_army_feishu_task_card_adapter(type("Other", (), {}), hermes_version="future", hermes_git_commit=SUPPORTED_HERMES_GIT_COMMIT, host_symbols=symbols)',
    'except HermesTaskCardCompatibilityError:',
    '  version_closed = True',
    'git_closed = False',
    'try:',
    '  install_agent_army_feishu_task_card_adapter(type("OtherGit", (), {}), hermes_version=SUPPORTED_HERMES_VERSION, hermes_git_commit="different", host_symbols=symbols)',
    'except HermesTaskCardCompatibilityError:',
    '  git_closed = True',
    'symbol_closed = False',
    'try:',
    '  incomplete = dict(symbols)',
    '  incomplete.pop("CallBackCard")',
    '  install_agent_army_feishu_task_card_adapter(type("MissingSymbolHost", (Host,), {}), hermes_version=SUPPORTED_HERMES_VERSION, hermes_git_commit=SUPPORTED_HERMES_GIT_COMMIT, host_symbols=incomplete)',
    'except HermesTaskCardCompatibilityError:',
    '  symbol_closed = True',
    'print(json.dumps({"same": first is second, "seam": Host.__agent_army_task_card_seam__, "versionClosed": version_closed, "gitClosed": git_closed, "symbolClosed": symbol_closed, "hasHandler": callable(Host.handle_agent_army_task_result)}))',
  ]);
  assert.equal(result.same, true);
  assert.equal(result.seam, 'agent.army/hermes-feishu-task-card-adapter/v1');
  assert.equal(result.versionClosed, true);
  assert.equal(result.gitClosed, true);
  assert.equal(result.symbolClosed, true);
  assert.equal(result.hasHandler, true);
});

test('Gateway 事件筛选由 runtime Module 统一持有，非飞书或非白名单工具失败关闭', () => {
  const result = runPython([
    'class Adapter:',
    '  async def handle_agent_army_task_result(self, source, result): return True',
    'class Source:',
    '  platform = "feishu"',
    'handler = trusted_task_card_handler(Adapter(), Source(), feishu_platform="feishu")',
    'Source.platform = "slack"',
    'closed = trusted_task_card_handler(Adapter(), Source(), feishu_platform="feishu")',
    'print(json.dumps({"handler": callable(handler), "closed": closed is None, "create": is_trusted_task_card_event("tool.completed", "mcp__agent_army__task_create"), "list": is_trusted_task_card_event("tool.completed", "mcp__agent_army__task_list"), "started": is_trusted_task_card_event("tool.started", "mcp__agent_army__task_create"), "invalid": is_trusted_task_card_event("tool.completed", {})}))',
  ]);
  assert.deepEqual(result, {
    handler: true,
    closed: true,
    create: true,
    list: false,
    started: false,
    invalid: false,
  });
});

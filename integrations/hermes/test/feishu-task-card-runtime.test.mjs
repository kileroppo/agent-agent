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
    'from agent_army_feishu_task_card import SUPERVISOR_MAX_CONCURRENCY, decide_task_card_delivery, poll_interval_seconds, render_task_card',
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

function render(value) {
  return runPython([
    `projection = json.loads(${JSON.stringify(JSON.stringify(value))})`,
    'print(json.dumps(render_task_card(projection), ensure_ascii=False))',
  ]);
}

function decide(record, value) {
  return runPython([
    `record = json.loads(${JSON.stringify(JSON.stringify(record))})`,
    `projection = json.loads(${JSON.stringify(JSON.stringify(value))})`,
    'print(json.dumps(decide_task_card_delivery(record, projection), ensure_ascii=False))',
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
  assert.equal(actionRow.actions[0].value.approval_id, 'approval-1');
  assert.equal(actionRow.actions[0].value.governance_mode, 'paperclip');
});

test('终态卡片不渲染任何可执行按钮', () => {
  const card = render(projection({ terminal: true, state: '已完成', tone: 'success' }));
  assert.equal(card.header.template, 'green');
  assert.equal(card.elements.some((element) => element.tag === 'action'), false);
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

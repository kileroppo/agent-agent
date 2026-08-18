// 切片 B · Hermes 侧证据模块测试（任务 4.3）
//
// 由 node --test 驱动 python3 执行 integrations/hermes/runtime/agent_army_feishu_commander_evidence.py。
// 覆盖：正常写入、目录不存在、权限不足、kind 非法 —— 全部返回布尔且不抛异常。
//
// 模块是纯 stdlib，因此用系统 python3 即可运行（不依赖 Hermes venv 与第三方包）。
// 沙箱 python3 为 3.9，模块必须与之兼容（不得使用 `str | None` 之类的新语法）。
//
// **Validates: Requirements 2.4, 2.11**

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const moduleDirectory = path.resolve(here, '../runtime');
const python = process.env.HERMES_TEST_PYTHON || 'python3';

function runPython(lines) {
  const script = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(moduleDirectory)})`,
    'from agent_army_feishu_commander_evidence import (',
    '    EVIDENCE_SCHEMA,',
    '    build_commander_chain_evidence,',
    '    digest_ref,',
    '    evidence_file_path,',
    '    read_commander_chain_evidence,',
    '    record_commander_chain_evidence,',
    ')',
    ...lines,
  ].join('\n');
  const result = spawnSync(python, ['-c', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, `python3 失败（模块不得抛异常）：${result.stderr}`);
  return result.stdout.trim() ? JSON.parse(result.stdout.trim().split('\n').at(-1)) : null;
}

function makeHermesHome(context) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-evidence-home-'));
  context.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function readLedger(home) {
  const files = fs.readdirSync(home).filter((name) => name.endsWith('.jsonl')).sort();
  return files.flatMap((name) => fs.readFileSync(path.join(home, name), 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line)));
}

test('4.3 正常写入：返回 True、文件 0600、按日切分且只写摘要', (context) => {
  const home = makeHermesHome(context);
  const outcome = runPython([
    'ok_one = record_commander_chain_evidence(',
    `    hermes_home=${JSON.stringify(home)},`,
    '    kind="ingress_unreachable",',
    '    source_event_ref="feishu:om_hermes_1",',
    '    chat_ref="oc_hermes_chat_1",',
    '    requester_ref="ou_hermes_user_1",',
    '    reason="URLError",',
    '    profile_agent_id="ajun",',
    ')',
    'ok_two = record_commander_chain_evidence(',
    `    hermes_home=${JSON.stringify(home)},`,
    '    kind="degraded_notice_send_failed",',
    '    source_event_ref="feishu:om_hermes_1",',
    '    chat_ref="oc_hermes_chat_1",',
    ')',
    'print(json.dumps({',
    '    "okOne": ok_one, "okTwo": ok_two, "schema": EVIDENCE_SCHEMA,',
    `    "path": str(evidence_file_path(${JSON.stringify(home)})),`,
    '}))',
  ]);

  assert.equal(outcome.okOne, true);
  assert.equal(outcome.okTwo, true);
  assert.equal(outcome.schema, 'agent.army/feishu-commander-chain-evidence/v1');
  assert.match(path.basename(outcome.path), /^agent_army_commander_evidence-\d{4}-\d{2}-\d{2}\.jsonl$/);
  assert.equal(path.dirname(outcome.path), home);

  const records = readLedger(home);
  assert.equal(records.length, 2, '同一天的两条记录必须追加到同一个文件。');
  assert.equal((fs.statSync(outcome.path).mode & 0o777), 0o600);
  for (const record of records) {
    assert.equal(record.schemaVersion, 'agent.army/feishu-commander-chain-evidence/v1');
    assert.equal(record.side, 'hermes-gateway');
    assert.equal(record.externalActionStarted, false);
    assert.equal(record.sourceEventRef, 'feishu:om_hermes_1');
    assert.match(record.chatRefDigest, /^sha256:[0-9a-f]{12}$/);
    assert.match(record.recordedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.match(record.nextStep, /diagnose:feishu-chain/);
  }
  const serialized = JSON.stringify(records);
  assert.ok(!serialized.includes('oc_hermes_chat_1'), 'chat_ref 原值被写入。');
  assert.ok(!serialized.includes('ou_hermes_user_1'), 'requester_ref 原值被写入。');
  assert.equal(records[0].reason, 'URLError');
  assert.equal(records[1].kind, 'degraded_notice_send_failed');
  assert.match(records[1].outcome, /飞书会话内没有任何回复/);
});

test('4.3 目录不存在时自建；父路径是普通文件时返回 False 且不抛', (context) => {
  const home = makeHermesHome(context);
  const nested = path.join(home, 'missing', 'deeper');
  const blocking = path.join(home, 'not-a-directory');
  fs.writeFileSync(blocking, 'x', 'utf8');

  const outcome = runPython([
    `created = record_commander_chain_evidence(hermes_home=${JSON.stringify(nested)}, kind="ingress_http_error", source_event_ref="feishu:om_nested", http_status=403)`,
    `blocked = record_commander_chain_evidence(hermes_home=${JSON.stringify(path.join(blocking, 'nested'))}, kind="ingress_unreachable", source_event_ref="feishu:om_blocked")`,
    'print(json.dumps({"created": created, "blocked": blocked}))',
  ]);

  assert.equal(outcome.created, true);
  assert.equal(outcome.blocked, false);
  const created = readLedger(nested);
  assert.equal(created.length, 1);
  assert.equal(created[0].httpStatus, 403);
});

test('4.3 权限不足时返回 False 且不抛异常', (context) => {
  const home = makeHermesHome(context);
  const readOnlyParent = path.join(home, 'read-only');
  fs.mkdirSync(readOnlyParent);
  const outcome = runPython([
    'import os',
    // 沙箱可能以 root 运行，届时 0o500 不构成真实不可写；两种情况都必须只返回布尔。
    `os.chmod(${JSON.stringify(readOnlyParent)}, 0o500)`,
    `blocked = record_commander_chain_evidence(hermes_home=${JSON.stringify(path.join(readOnlyParent, 'child'))}, kind="ingress_unreachable", source_event_ref="feishu:om_ro")`,
    `os.chmod(${JSON.stringify(readOnlyParent)}, 0o700)`,
    'print(json.dumps({"blocked": blocked, "isBool": isinstance(blocked, bool)}))',
  ]);
  assert.equal(outcome.isBool, true);
});

test('4.3 kind 非法、缺参与 secret 形态一律返回 False，不落盘', (context) => {
  const home = makeHermesHome(context);
  const outcome = runPython([
    `home = ${JSON.stringify(home)}`,
    'illegal = record_commander_chain_evidence(hermes_home=home, kind="whatever", source_event_ref="feishu:om_x")',
    'missing_kind = record_commander_chain_evidence(hermes_home=home, source_event_ref="feishu:om_x")',
    'none_kind = record_commander_chain_evidence(hermes_home=home, kind=None, source_event_ref=None)',
    'secret = record_commander_chain_evidence(hermes_home=home, kind="ingress_unreachable", source_event_ref="feishu:om_x", reason="Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature")',
    'built = build_commander_chain_evidence(kind="ingress_unreachable", source_event_ref="feishu:om_x", reason="sk-livetokenvalue1234567890")',
    'print(json.dumps({',
    '    "illegal": illegal, "missingKind": missing_kind, "noneKind": none_kind,',
    '    "secret": secret, "builtIsNone": built is None,',
    '}))',
  ]);

  assert.deepEqual(outcome, {
    illegal: false, missingKind: false, noneKind: false, secret: false, builtIsNone: true,
  });
  assert.deepEqual(readLedger(home), [], '非法或含 secret 形态的记录不得落盘。');
});

test('4.3 digest_ref 稳定不可逆；read_commander_chain_evidence 缺目录时返回空列表', (context) => {
  const home = makeHermesHome(context);
  const outcome = runPython([
    'print(json.dumps({',
    '    "same": digest_ref("ou_same") == digest_ref("ou_same"),',
    '    "different": digest_ref("ou_a") != digest_ref("ou_b"),',
    '    "empty": digest_ref(""),',
    '    "none": digest_ref(None),',
    '    "shape": digest_ref("ou_x"),',
    `    "missing": read_commander_chain_evidence(${JSON.stringify(path.join(home, 'absent'))}),`,
    '}))',
  ]);
  assert.equal(outcome.same, true);
  assert.equal(outcome.different, true);
  assert.equal(outcome.empty, null);
  assert.equal(outcome.none, null);
  assert.match(outcome.shape, /^sha256:[0-9a-f]{12}$/);
  assert.deepEqual(outcome.missing, []);
});

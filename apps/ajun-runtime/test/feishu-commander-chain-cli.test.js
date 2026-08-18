// 切片 A · 诊断 CLI 端到端集成测试（任务 3.6）
//
// 最坏环境：无真实 HERMES_HOME、4321 未监听、launchd 标签不存在、依赖未安装。
// 断言 CLI 仍能跑完、六项齐全、退出码正确、输出零凭据、只读不写。
//
// 原生 node --test，不引入 Jest / Vitest / fast-check（需求 3.9）。
//
// **Validates: Requirements 2.9, 2.11**

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CHAIN_CHECK_IDS } from '../src/feishu-commander-chain-diagnosis.ts';
import { createFeishuCommanderChainEvidenceLedger } from '../src/feishu-commander-chain-evidence.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.resolve(here, '..');
const repoRoot = path.resolve(runtimeRoot, '../..');
const CLI_PATH = path.join(runtimeRoot, 'scripts', 'diagnose-feishu-commander-chain.mjs');
const SECRET_SHAPES = /sk-|bearer|token|cookie|password/i;

const PATCHED_ADAPTER = [
  'class FeishuPlatform(Platform):',
  '    async def _route_ajun_commander_event(self, event: MessageEvent) -> bool:',
  '        ingress_url = os.getenv("AJUN_FEISHU_COMMANDER_INGRESS_URL", "").strip()',
  '        # AGENT_ARMY_FEISHU_COMMANDER_PROFILE_GUARD_V1: only AJun owns commander ingress.',
  '        # AGENT_ARMY_FEISHU_COMMANDER_DIRECT_REPLY_V1',
  '        # AGENT_ARMY_HERMES_FEISHU_ADAPTER_SEAM_V1',
  '        return True',
].join('\n');

async function makeHermesFixture(context, { patched = false } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'chain-cli-home-'));
  const hermesHome = path.join(home, '.hermes');
  await fs.mkdir(hermesHome, { recursive: true });
  // 运行时侧账本目录与 HERMES_HOME 夹具分开：CLI 的 diagnosis_completed 只允许写这里（需求 3.8）。
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chain-cli-data-'));
  context.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  if (patched) {
    const adapterDir = path.join(hermesHome, 'hermes-agent', 'plugins', 'platforms', 'feishu');
    await fs.mkdir(adapterDir, { recursive: true });
    await fs.writeFile(path.join(adapterDir, 'adapter.py'), PATCHED_ADAPTER, 'utf8');
    await fs.writeFile(path.join(hermesHome, 'hermes-agent', 'pyproject.toml'), 'version = "0.19.0"\n', 'utf8');
    await fs.writeFile(
      path.join(hermesHome, 'config.yaml'),
      'platforms:\n  feishu:\n    allowed_users:\n      - ou_fixture00000000000000000001\n',
      'utf8',
    );
  }
  context.after(() => fs.rm(home, { recursive: true, force: true }));
  return { home, hermesHome, dataDir };
}

function runCli(args, { home, hermesHome, dataDir }) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, HERMES_HOME: hermesHome, AGENT_ARMY_DATA_DIR: dataDir },
  });
}

async function readEvidence(directory) {
  const records = [];
  let entries;
  try {
    entries = (await fs.readdir(directory)).sort();
  } catch {
    return records;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;
    const content = await fs.readFile(path.join(directory, entry), 'utf8');
    for (const line of content.split('\n')) {
      if (line.trim()) records.push(JSON.parse(line));
    }
  }
  return records;
}

async function snapshotTree(root) {
  const rows = [];
  async function walk(directory) {
    const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        rows.push(`dir:${path.relative(root, full)}`);
        await walk(full);
      } else {
        rows.push(`file:${path.relative(root, full)}:${await fs.readFile(full, 'utf8')}`);
      }
    }
  }
  await walk(root);
  return rows;
}

test('3.6 最坏环境（HERMES_HOME 不存在 + 4321 未监听 + launchd 标签不存在）下 CLI 仍跑完并输出六项', async (context) => {
  const fixture = await makeHermesFixture(context);
  const missingHermesHome = path.join(fixture.home, 'absent-hermes-home');
  const run = runCli(['--json'], { ...fixture, hermesHome: missingHermesHome });

  assert.ok([0, 1].includes(run.status), `退出码应 ∈ {0,1}，实际 ${run.status}；stderr=${run.stderr}`);
  assert.equal(run.stderr.trim(), '', `不得出现未捕获异常或告警：${run.stderr}`);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.schemaVersion, 'agent.army/feishu-commander-chain-diagnosis/v1');
  assert.deepEqual(payload.checks.map((check) => check.id), [...CHAIN_CHECK_IDS]);
  assert.equal(payload.safety.readOnly, true);
  assert.equal(payload.safety.secretsRead, false);
  assert.equal(payload.safety.externalEffects, false);
  // 两侧账本都为空时最近证据必须是空数组（切片 A 的独立交付判据在切片 B 之后依然成立）。
  assert.deepEqual(payload.recentEvidence, []);
  assert.equal(payload.verdict, 'blocking_gap');
  assert.ok(payload.uniqueNextStep);
  assert.match(payload.uniqueNextStep, /patch-feishu-agent-proposal-router\.mjs/);
  assert.equal(run.status, 1);
});

test('3.6 --json 输出零凭据（需求 2.11）', async (context) => {
  const fixture = await makeHermesFixture(context, { patched: true });
  const run = runCli(['--json', '--requester', 'ou_fixture00000000000000000001'], fixture);
  assert.ok([0, 1, 2].includes(run.status));
  assert.ok(!SECRET_SHAPES.test(run.stdout), `--json 输出含 secret 形态：${run.stdout.slice(0, 400)}`);
  const payload = JSON.parse(run.stdout);
  // requester 只以摘要出现，原值不得回显。
  const serialized = JSON.stringify(payload);
  assert.ok(!serialized.includes('ou_fixture00000000000000000001'), 'requester 原值被回显。');
  const admission = payload.checks.find((check) => check.id === 'feishu-admission');
  assert.match(admission.evidence.requesterRefDigest, /^sha256:[0-9a-f]{12}$/);
  assert.equal(admission.status, 'pass');
  assert.equal(admission.truthLayer, 'configured');
});

test('3.6 打过补丁的 adapter 夹具让 adapter-patch 转 pass，但层级不得超过 configured', async (context) => {
  const fixture = await makeHermesFixture(context, { patched: true });
  const run = runCli(['--json'], fixture);
  const payload = JSON.parse(run.stdout);
  const adapterPatch = payload.checks.find((check) => check.id === 'adapter-patch');
  assert.equal(adapterPatch.status, 'pass');
  assert.equal(adapterPatch.truthLayer, 'configured');
  assert.equal(adapterPatch.truthLayerCeiling, 'configured');
  assert.equal(adapterPatch.requiresRealMachineVerification, true);
  assert.equal(adapterPatch.evidence.loadedByGatewayProcess, 'unproven');
  // 4321 仍未监听，因此整体仍是阻断缺口。
  assert.equal(payload.verdict, 'blocking_gap');
  assert.equal(run.status, 1);
});

test('4.7 CLI 对被诊断对象只读：HERMES_HOME 夹具逐字节不变，留痕只落在 dataDir', async (context) => {
  const fixture = await makeHermesFixture(context, { patched: true });
  const before = await snapshotTree(fixture.home);
  runCli(['--json'], fixture);
  runCli([], fixture);

  // 收紧（任务 4.7）：诊断对 Hermes 侧与 launchd 侧仍是纯只读 —— 夹具目录逐字节不变；
  // 唯一允许的写入是运行时侧 dataDir 里的 diagnosis_completed 留痕。
  assert.deepEqual(await snapshotTree(fixture.home), before, 'CLI 写入了被诊断对象（对 HERMES_HOME 必须只读）。');
  const records = await readEvidence(path.join(fixture.dataDir, 'feishu-commander-chain'));
  assert.equal(records.length, 2, '两次诊断应各留一条痕迹。');
  for (const record of records) {
    assert.equal(record.kind, 'diagnosis_completed');
    assert.equal(record.side, 'ajun-runtime');
    assert.equal(record.externalActionStarted, false);
    assert.equal(record.reason, 'blocking_gap');
  }
});

test('4.7 两侧账本按 recordedAt 合并，同一 sourceEventRef 可关联（需求 2.4 / 2.5 / 2.8）', async (context) => {
  const fixture = await makeHermesFixture(context, { patched: true });
  const sourceEventRef = 'feishu:om_cli_merge_1';
  const runtimeLedger = createFeishuCommanderChainEvidenceLedger({
    dataDir: fixture.dataDir,
    now: () => new Date('2026-08-18T02:00:00.000Z'),
  });
  await runtimeLedger.record({ kind: 'no_task_by_design', sourceEventRef, reason: 'explicit_direct_reply_without_task' });
  await fs.writeFile(
    path.join(fixture.hermesHome, `agent_army_commander_evidence-${new Date().toISOString().slice(0, 10)}.jsonl`),
    `${JSON.stringify({
      schemaVersion: 'agent.army/feishu-commander-chain-evidence/v1',
      recordedAt: '2026-08-18T01:00:00.000Z',
      side: 'hermes-gateway',
      kind: 'ingress_unreachable',
      sourceEventRef,
      chatRefDigest: 'sha256:0123456789ab',
      outcome: '本机 A君 总管入口不可达；未启动任何外部动作。',
      externalActionStarted: false,
    })}\n`,
    'utf8',
  );

  const payload = JSON.parse(runCli(['--json'], fixture).stdout);
  assert.deepEqual(
    payload.recentEvidence.map((record) => `${record.recordedAt}:${record.side}`),
    ['2026-08-18T01:00:00.000Z:hermes-gateway', '2026-08-18T02:00:00.000Z:ajun-runtime'],
    '两侧账本必须按 recordedAt 合并排序。',
  );
  assert.equal(new Set(payload.recentEvidence.map((record) => record.sourceEventRef)).size, 1, '同一事件必须可关联。');
  assert.ok(!SECRET_SHAPES.test(JSON.stringify(payload.recentEvidence)));

  const humanReadable = runCli([], fixture).stdout;
  assert.match(humanReadable, /最近证据：\d+ 条（已脱敏，两侧账本按时间合并）/);
  assert.match(humanReadable, /hermes-gateway ingress_unreachable 事件=feishu:om_cli_merge_1/);
  assert.match(humanReadable, /诊断留痕：已写入/);
});

test('4.7 adapter-patch 由 gap 变 pass 后层级仍不超过 configured（不因刚打完补丁就冒充运行可达）', async (context) => {
  const unpatched = await makeHermesFixture(context);
  const before = JSON.parse(runCli(['--json'], unpatched).stdout)
    .checks.find((check) => check.id === 'adapter-patch');
  assert.equal(before.status, 'gap');
  assert.equal(before.blocking, true);
  assert.match(before.nextStep, /patch-feishu-agent-proposal-router\.mjs/);

  const patched = await makeHermesFixture(context, { patched: true });
  const after = JSON.parse(runCli(['--json'], patched).stdout)
    .checks.find((check) => check.id === 'adapter-patch');
  assert.equal(after.status, 'pass');
  assert.equal(after.truthLayer, 'configured');
  assert.equal(after.truthLayerCeiling, 'configured');
  assert.equal(after.requiresRealMachineVerification, true);
  assert.equal(after.evidence.loadedByGatewayProcess, 'unproven');
});

test('3.6 人类可读输出每项固定四行并打印总判定与告示', async (context) => {
  const fixture = await makeHermesFixture(context);
  const run = runCli([], fixture);
  assert.ok([0, 1].includes(run.status));
  const lines = run.stdout.split('\n');
  for (const [index, id] of CHAIN_CHECK_IDS.entries()) {
    const headerIndex = lines.findIndex((line) => line.startsWith(`${index + 1}. `));
    assert.ok(headerIndex > 0, `缺少第 ${index + 1} 项标题（${id}）`);
    assert.match(lines[headerIndex + 1], /^ {3}结论：/);
    assert.match(lines[headerIndex + 2], /^ {3}能力真相层级：/);
    assert.match(lines[headerIndex + 3], /^ {3}已脱敏证据：/);
    assert.match(lines[headerIndex + 4], /^ {3}唯一下一步：/);
  }
  assert.match(run.stdout, /总判定：blocking_gap/);
  assert.match(run.stdout, /飞书私聊发一条真实文本消息/);
  assert.match(run.stdout, /最近证据：本机暂无链路证据记录。/);
  assert.ok(!SECRET_SHAPES.test(run.stdout));
});

test('3.6 参数错误时退出码为 2 并打印用法；--help 退出码为 0', async (context) => {
  const fixture = await makeHermesFixture(context);
  const bogus = runCli(['--bogus'], fixture);
  assert.equal(bogus.status, 2);
  assert.match(bogus.stderr, /无法识别的参数/);

  const missingValue = runCli(['--requester'], fixture);
  assert.equal(missingValue.status, 2);
  assert.match(missingValue.stderr, /--requester 需要一个飞书 open_id 参数/);

  const help = runCli(['--help'], fixture);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /diagnose:feishu-chain/);
});

test('3.6 根 package.json 与 A君 package.json 都登记了 diagnose:feishu-chain（需求 2.9）', async () => {
  const rootManifest = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  const runtimeManifest = JSON.parse(await fs.readFile(path.join(runtimeRoot, 'package.json'), 'utf8'));
  assert.equal(rootManifest.scripts['diagnose:feishu-chain'], 'node apps/ajun-runtime/scripts/diagnose-feishu-commander-chain.mjs');
  assert.equal(runtimeManifest.scripts['diagnose:feishu-chain'], 'node scripts/diagnose-feishu-commander-chain.mjs');
});

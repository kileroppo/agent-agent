// 阶段一 · 探索性 Bug 条件检查（Property 1: Bug Condition）
//
// 本文件在**未修复代码**上必须 FAIL —— 失败即证明「飞书无回复」是不可归因的黑箱。
// 它同时编码了期望行为：任务 3.7 会重跑本文件确认 ①④⑥ 转 PASS，任务 4.9 确认全部转 PASS。
// 缺陷是确定性的，因此属性收敛到 design.md《Exploratory Bug Condition Checking》的具体失败用例，
// 不引入随机化，也不引入 Jest / Vitest / fast-check（需求 3.9）。
//
// 覆盖：① 诊断入口缺失、② 403 无证据、③ handled:false 无证据、④ 补丁存活性不可判定、⑥ 4321 关闭时诊断仍可跑。
// 第 ⑤ 条（已迁移 adapter 收不到新补丁）在 integrations/hermes/test/feishu-commander-router-distribution.test.mjs。
//
// **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 2.9**

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createAjunHttpHandler } from '../src/runtime-http-handler.ts';
import { coordinator, setupTaskService } from './support/task-service-fixture.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.resolve(here, '..');
const repoRoot = path.resolve(runtimeRoot, '../..');

// 六项检查的固定顺序（design.md §2）。诊断模块落地后应导出同一份常量。
const EXPECTED_CHAIN_CHECK_IDS = [
  'gateway-process',
  'adapter-patch',
  'required-env',
  'runtime-ingress',
  'profile-guard',
  'feishu-admission',
];

const DIAGNOSIS_CLI_RELATIVE_PATH = 'apps/ajun-runtime/scripts/diagnose-feishu-commander-chain.mjs';
const DIAGNOSIS_SCRIPT_NAME = 'diagnose:feishu-chain';

test('①诊断入口缺失：仓库必须提供一条可执行的 diagnose:feishu-chain 自检命令（需求 1.9 / 2.9）', async () => {
  const rootManifest = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  const runtimeManifest = JSON.parse(await fs.readFile(path.join(runtimeRoot, 'package.json'), 'utf8'));

  assert.ok(
    rootManifest.scripts?.[DIAGNOSIS_SCRIPT_NAME],
    `根 package.json 缺少 "${DIAGNOSIS_SCRIPT_NAME}" script；用户没有任何一次性诊断入口，只能逐个环节猜测（需求 1.9）。`
      + ` 现有 scripts：${Object.keys(rootManifest.scripts || {}).join(', ')}`,
  );
  assert.ok(
    runtimeManifest.scripts?.[DIAGNOSIS_SCRIPT_NAME],
    `apps/ajun-runtime/package.json 缺少 "${DIAGNOSIS_SCRIPT_NAME}" script。`,
  );

  const cliPath = path.join(repoRoot, DIAGNOSIS_CLI_RELATIVE_PATH);
  await assert.doesNotReject(
    fs.access(cliPath),
    `诊断 CLI ${DIAGNOSIS_CLI_RELATIVE_PATH} 不存在。`,
  );

  const run = spawnSync(process.execPath, [cliPath, '--json'], { cwd: repoRoot, encoding: 'utf8' });
  assert.ok(
    [0, 1].includes(run.status),
    `诊断入口退出码应 ∈ {0,1}，实际 ${run.status}；stderr=${String(run.stderr).slice(0, 400)}`,
  );
});

test('②403 无证据：非本机调用被拒后必须在本机留下 ingress_rejected_non_local 证据（需求 1.5 / 2.5）', async (context) => {
  const dataDir = await makeTempDataDir();
  const fixture = await startCommanderHandler(context, {
    dataDir,
    remoteAddress: '203.0.113.10',
    commander: { async handle() { assert.fail('非本机调用不得进入 commander.handle'); } },
  });

  const rejected = await postJson(`${fixture.baseUrl}/api/feishu/commander`, {
    text: '帮我整理一下这周的公开资料',
    sourceEventRef: 'feishu:exploration-403-1',
    chatRef: 'chat-exploration-403',
    requesterRef: 'exploration-user',
  });

  // 403 语义本身是既有正确行为（需求 3.3），必须保留。
  assert.equal(rejected.status, 403);
  assert.deepEqual(rejected.body, { error: '飞书军团总管入口只能由本机 Hermes 适配器调用。' });

  const evidence = await readChainEvidence(dataDir);
  const matched = evidence.filter((record) => record.kind === 'ingress_rejected_non_local');
  assert.ok(
    matched.length >= 1,
    '403 拒绝没有留下任何可判定证据：dataDir 下找不到 kind=ingress_rejected_non_local 的记录，'
      + `该次拒绝无法与某条飞书消息对齐（需求 1.5）。实际读到的证据记录：${JSON.stringify(evidence)}`,
  );
  assert.equal(matched[0].httpStatus, 403);
  assert.equal(matched[0].sourceEventRef, 'feishu:exploration-403-1');
  assert.equal(matched[0].externalActionStarted, false);
  assert.match(String(matched[0].nextStep || ''), /diagnose:feishu-chain/);
});

test('③handled:false 无证据：有意不建任务必须留下 no_task_by_design 判定痕迹（需求 1.8 / 2.8）', async (context) => {
  const dataDir = await makeTempDataDir();
  const { service } = setupTaskService({ agents: [coordinator] });
  const fixture = await startCommanderHandler(context, {
    dataDir,
    work: { store: service.store, tasks: service },
    commander: {
      async handle() { return { handled: false, reason: 'explicit_direct_reply_without_task' }; },
    },
  });

  const accepted = await postJson(`${fixture.baseUrl}/api/feishu/commander`, {
    text: '不要创建任务，直接回复我这句话的意思',
    sourceEventRef: 'feishu:exploration-no-task-1',
    chatRef: 'chat-exploration-no-task',
    requesterRef: 'exploration-user',
  });

  // 交回 Hermes 普通聊天是既有正确行为（需求 3.1），必须原样保留。
  assert.equal(accepted.status, 202);
  assert.equal(accepted.body.handled, false);
  assert.equal(accepted.body.reason, 'explicit_direct_reply_without_task');

  const evidence = await readChainEvidence(dataDir);
  const matched = evidence.filter((record) => record.kind === 'no_task_by_design');
  assert.ok(
    matched.length >= 1,
    '「有意不建任务」没有留下任何判定痕迹：dataDir 下找不到 kind=no_task_by_design 的记录，'
      + `用户视角无法把它与 Hermes 模型侧异常区分（需求 1.8）。实际读到的证据记录：${JSON.stringify(evidence)}`,
  );
  assert.equal(matched[0].reason, 'explicit_direct_reply_without_task');
  assert.equal(matched[0].sourceEventRef, 'feishu:exploration-no-task-1');
  assert.equal(matched[0].externalActionStarted, false);
});

test('④补丁存活性不可判定：删去 _route_ajun_commander_event 的 adapter 夹具必须被只读判定报出（需求 1.3 / 2.3）', async () => {
  const diagnosis = await importOptional('../src/feishu-commander-chain-diagnosis.ts');
  assert.ok(
    diagnosis,
    '不存在任何只读判定模块 src/feishu-commander-chain-diagnosis.ts：'
      + 'adapter.py 不在本仓库且会被 Hermes 升级覆盖，补丁是否还在位当前只能靠人记得重跑（需求 1.3）。',
  );
  assert.deepEqual([...diagnosis.CHAIN_CHECK_IDS], EXPECTED_CHAIN_CHECK_IDS);

  // 仓库内自造夹具：只保留结构轮廓，不触达真实 ~/.hermes/ 的 adapter.py。
  const adapterWithoutCommanderRoute = [
    'class FeishuPlatform(Platform):',
    '    async def _handle_message_with_guards(self, event: MessageEvent) -> None:',
    '        await self.handle_message(event)',
    '',
    '    async def _route_ajun_agent_proposal_event(self, event: MessageEvent) -> bool:',
    '        return False',
    '',
  ].join('\n');
  assert.ok(!adapterWithoutCommanderRoute.includes('_route_ajun_commander_event'));

  const result = diagnosis.diagnoseFeishuCommanderChain(
    adapterPatchObservationsFor(adapterWithoutCommanderRoute),
    { now: () => new Date('2026-08-18T00:00:00.000Z') },
  );
  const check = result.checks.find((item) => item.id === 'adapter-patch');
  assert.equal(check.status, 'gap');
  assert.equal(check.blocking, true);
  assert.match(check.conclusion, /补丁/);
  assert.match(String(check.nextStep || ''), /patch-feishu-agent-proposal-router\.mjs/);
  // 刚判定出补丁缺失只到「已配置」层，不得冒充运行可达（能力真相五层）。
  assert.equal(check.truthLayerCeiling, 'configured');
  assert.equal(check.requiresRealMachineVerification, true);
});

test('⑥4321 关闭时诊断仍可跑：无 4321 监听、无真实 HERMES_HOME 时六项检查仍齐全（需求 1.9 / 边界）', async (context) => {
  const cliPath = path.join(repoRoot, DIAGNOSIS_CLI_RELATIVE_PATH);
  await assert.doesNotReject(
    fs.access(cliPath),
    `诊断 CLI ${DIAGNOSIS_CLI_RELATIVE_PATH} 不存在：诊断能力与被诊断对象同生共死，`
      + '4321 未起时用户没有任何入口可跑（design.md 假设 3）。',
  );

  const hermesHome = await fs.mkdtemp(path.join(os.tmpdir(), 'exploration-hermes-home-'));
  context.after(() => fs.rm(hermesHome, { recursive: true, force: true }));

  const run = spawnSync(process.execPath, [cliPath, '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, HERMES_HOME: hermesHome },
  });
  assert.ok(
    [0, 1].includes(run.status),
    `4321 未监听时诊断入口退出码应 ∈ {0,1}，实际 ${run.status}；stderr=${String(run.stderr).slice(0, 400)}`,
  );
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.schemaVersion, 'agent.army/feishu-commander-chain-diagnosis/v1');
  assert.deepEqual(payload.checks.map((check) => check.id), EXPECTED_CHAIN_CHECK_IDS);
});

// --- 支持函数（仓库内夹具，不触达真实 Hermes / 飞书 / launchd） ---

function adapterPatchObservationsFor(adapterSource) {
  return {
    adapterPatch: {
      status: 'observed',
      exists: true,
      hasCommanderRoute: adapterSource.includes('_route_ajun_commander_event'),
      duplicateRouteDefinitions: 0,
      markers: {
        PROFILE_GUARD_V1: adapterSource.includes('AGENT_ARMY_FEISHU_COMMANDER_PROFILE_GUARD_V1'),
        INGRESS_TIMEOUT_V1: adapterSource.includes('AJUN_COMMANDER_INGRESS_TIMEOUT_V1'),
        DIRECT_REPLY_V1: adapterSource.includes('AGENT_ARMY_FEISHU_COMMANDER_DIRECT_REPLY_V1'),
        ADAPTER_SEAM_V1: adapterSource.includes('AGENT_ARMY_HERMES_FEISHU_ADAPTER_SEAM_V1'),
        SILENT_FAILURE_EVIDENCE_V1: adapterSource.includes('AGENT_ARMY_FEISHU_COMMANDER_SILENT_FAILURE_EVIDENCE_V1'),
      },
    },
    gatewayProcess: { status: 'unknown', loaded: false, pid: null },
    requiredEnv: { status: 'unknown', variables: {} },
    runtimeIngress: { status: 'unknown', reachable: false },
    profileGuard: { status: 'unknown', agentId: null },
    feishuAdmission: { status: 'unknown', configured: false },
  };
}

async function importOptional(specifier) {
  try {
    return await import(specifier);
  } catch (error) {
    if (['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'].includes(error?.code)) return null;
    throw error;
  }
}

async function makeTempDataDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'exploration-chain-data-'));
}

async function readChainEvidence(dataDir) {
  const records = [];
  const files = await collectJsonlFiles(dataDir);
  for (const file of files) {
    const content = await fs.readFile(file, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed));
      } catch {
        records.push({ kind: 'unparsable_line', raw: trimmed.slice(0, 120) });
      }
    }
  }
  return records;
}

async function collectJsonlFiles(directory) {
  const found = [];
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await collectJsonlFiles(full));
    else if (entry.name.endsWith('.jsonl')) found.push(full);
  }
  return found;
}

async function startCommanderHandler(context, { dataDir, remoteAddress = null, commander, work = {} }) {
  const handler = createAjunHttpHandler({
    environment: {},
    publicDir: path.join(runtimeRoot, 'public'),
    dataDir,
    detailBaseUrl: 'http://127.0.0.1:4321',
    network: { deploymentMode: 'local', lanEnabled: false, lanAccess: { enabled: false, key: null } },
    paperclip: {},
    work: {
      proposals: {}, missions: {}, macWorker: {}, xiaod: {},
      boomMonitor: null, boomMonitorEnabled: false,
      store: { async list() { return []; }, async listApprovals() { return []; } },
      tasks: { async recoveryView() { return { actions: [] }; } },
      ...work,
    },
    connections: {},
    localAi: null,
    feishu: {
      officialFeishuChannel: {}, hermesNativeCompletionWatcher: {},
      resolveFeishuApproval: async () => {},
      commander,
    },
    m5: {},
  });
  const server = http.createServer((request, response) => {
    // 真实 socket 上改写来源地址，让 isLocalAddress 走到既有非本机分支。
    if (remoteAddress) {
      Object.defineProperty(request.socket, 'remoteAddress', { value: remoteAddress, configurable: true });
    }
    return handler(request, response);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  context.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return { baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

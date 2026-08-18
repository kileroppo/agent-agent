// 阶段一 · 保持性基线（Property 2: Preservation）
//
// 本文件必须在**未修复代码**上全部 PASS —— 它锁住的是「不落在 Bug_Condition 内的输入」的既有行为。
// 严格遵循**观测优先**：下面每一条 `*_BASELINE` 都是先在未修复代码上跑出真实输出后落为夹具的，
// 不是按设计文档假设写的期望值。观测记录见本文件各条注释。
//
// 属性式测试用原生 `node --test` 的「确定性输入枚举 + 固定种子伪随机生成器」实现，
// 种子写死在 PRNG_SEED 并在断言失败时打印，保证反例可复现；不引入 Jest / Vitest / fast-check（需求 3.9）。
//
// P2-1 / P2-3 / P2-9 中涉及**新增证据落盘**的断言，阶段一以「账本为空即视为满足」的宽松形式写，
// 使本文件能在未修复代码上通过；切片 B 落地后（任务 4.10）已**收紧**为「落盘确实存在**且**对外行为
// 逐字节不变」。收紧只加强、不放宽：基线响应体、状态码与文案的断言一字未改。
//
// **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9**

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createAjunHttpHandler } from '../src/runtime-http-handler.ts';
import { FeishuCommander } from '../src/feishu-commander.ts';
import { isDirectReplyWithoutTask } from '../src/feishu-commander-replies.ts';
import { collectRuntimeFingerprint } from '../../../scripts/runtime-fingerprint.mjs';
import { applyPatch } from '../../../integrations/hermes/scripts/patch-feishu-agent-proposal-router.mjs';
import { migrateFeishuCommanderRouter } from '../../../integrations/hermes/scripts/feishu-commander-router-patches.mjs';
import { upgradeFeishuCommanderIngressProtocol } from '../../../integrations/hermes/scripts/feishu-commander-ingress-protocol.mjs';
import { coordinator, setupTaskService } from './support/task-service-fixture.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.resolve(here, '..');

// 固定种子：失败时随断言消息一起打印，保证反例可复现。
const PRNG_SEED = 20260818;

const DETAIL_BASE_URL = 'http://127.0.0.1:4321';

// 诊断/降级字样的正向排除清单（需求 3.1：直答分支不得插入任何诊断或降级文案）。
const FORBIDDEN_DIAGNOSTIC_PHRASES = Object.freeze(['自检', '诊断', '未启动任何外部动作', '降级']);

// --- 未修复代码上的实际观测基线（observation-first） ---

// 观测：POST /api/feishu/commander，文本命中 isDirectReplyWithoutTask。
// 实测 → 202 {"handled":false,"reason":"explicit_direct_reply_without_task"}
const DIRECT_REPLY_BASELINE = Object.freeze({
  status: 202,
  body: Object.freeze({ handled: false, reason: 'explicit_direct_reply_without_task' }),
});

// 观测：POST /api/feishu/commander，socket.remoteAddress 为非本机。
// 实测（203.0.113.10 / ::ffff:203.0.113.10 / 192.168.1.20 / 10.0.0.5 / ::ffff:10.1.2.3 五种）
// → 403 {"error":"飞书军团总管入口只能由本机 Hermes 适配器调用。"}
const FORBIDDEN_BASELINE = Object.freeze({
  status: 403,
  body: Object.freeze({ error: '飞书军团总管入口只能由本机 Hermes 适配器调用。' }),
});

// 观测：成功建任务时 presentCommanderReply() 的四字段（固定任务夹具，逐字节落盘）。
const GOLDEN_TASK = Object.freeze({
  taskId: '7df3c85a-1111-2222-3333-444444444444',
  status: 'queued',
  input: Object.freeze({ title: '整理这个视频' }),
  updatedAt: '2026-08-12T03:00:00.000Z',
});
const GOLDEN_TASK_REPLY_INPUT = '已交给小D处理公开素材，任务号：7df3c85a-1111-2222-3333-444444444444。完成后会回到当前飞书会话。';
const GOLDEN_PROJECTION_BASELINE = Object.freeze({
  reply: '已交给小D处理公开素材，任务号：[查看任务 #7DF3C85A](http://127.0.0.1:4321/tasks/7df3c85a-1111-2222-3333-444444444444)。完成后会回到当前飞书会话。\n\n下一步：无需重复提交；开始处理后会更新进度。',
  presentation: Object.freeze({
    taskRef: '#7DF3C85A',
    statusLabel: '等待开始',
    tone: 'active',
    summary: '整理这个视频：任务已登记，正在等待开始。',
    nextAction: '无需重复提交；开始处理后会更新进度。',
    detailPath: '/tasks/7df3c85a-1111-2222-3333-444444444444',
    detailUrl: 'http://127.0.0.1:4321/tasks/7df3c85a-1111-2222-3333-444444444444',
    attention: null,
    technical: Object.freeze({
      taskId: '7df3c85a-1111-2222-3333-444444444444',
      status: 'queued',
      currentStage: null,
      errorCode: null,
      analysisIntent: null,
      reportVersion: null,
    }),
  }),
  sourceRevision: '2026-08-12T03:00:00.000Z:card-ux4',
  contentHash: '12133fc3b726dc6cdd2579de0c81fc77652963934c2bf7216044c2b6168f1c14',
});

// 观测：GET /api/health → 200 且 schemaVersion = agent.army/runtime-health/v1
const RUNTIME_HEALTH_SCHEMA_BASELINE = 'agent.army/runtime-health/v1';
// 观测：collectRuntimeFingerprint() → schemaVersion = agent.army/runtime-fingerprint/v1
const RUNTIME_FINGERPRINT_SCHEMA_BASELINE = 'agent.army/runtime-fingerprint/v1';

// 观测：已安装总管路由的 adapter 源码中，DIRECT_REPLY_V1 代码块逐字符如下（标记恰好出现一次）。
const DIRECT_REPLY_BLOCK_BASELINE = '            # AGENT_ARMY_FEISHU_COMMANDER_DIRECT_REPLY_V1: explicit no-task messages stay in normal Hermes chat.\n'
  + '            if status in {200, 201, 202} and isinstance(body, dict) and body.get("handled") is False:\n'
  + '                # Explicit no-task/direct-reply messages belong to the normal\n'
  + '                # Hermes conversation path with its own Profile and memory.\n'
  + '                setattr(event, "_ajun_commander_routed", False)\n'
  + '                return False\n';

// 观测：Profile guard 与非 TEXT 短路条件在已安装源码中逐字符如下。
const COMMANDER_GUARD_BLOCK_BASELINE = '        if not ingress_url or event.message_type != MessageType.TEXT:\n'
  + '            return False\n'
  + '        # AGENT_ARMY_FEISHU_COMMANDER_PROFILE_GUARD_V1: only AJun owns commander ingress.\n'
  + '        entry_agent_id = (os.getenv("AGENT_ARMY_FEISHU_AGENT_ID", "") or os.getenv("AJUN_FEISHU_ENTRY_AGENT_ID", "") or "ajun").strip()\n'
  + '        if entry_agent_id != "ajun":\n'
  + '            # A stale commander URL in an employee profile must never capture\n'
  + '            # ordinary employee conversation.\n'
  + '            return False\n';

// 观测（真机采样的等价结构在仓库内自造）：最小 adapter 夹具，与
// integrations/hermes/test/patch-feishu-agent-proposal-router.test.mjs 同源结构轮廓。
// 不读取、不触达真实 ~/.hermes/ 下的 adapter.py。
const ADAPTER_FIXTURE = `_XIAOD_HTTP_URL_RE = re.compile(r"https?://[^\\s<>\\u3002\\uff0c\\uff01\\uff1f]+", re.IGNORECASE)
    def __init__(self):
        self._xiaod_latest_job_by_chat: Dict[str, tuple[str, str]] = {}
    async def connect(self):
            self._mark_connected()
            logger.info("[Feishu] Connected in %s mode (%s)", self._connection_mode, self._domain_name)
    async def _handle_message_with_guards(self, event: MessageEvent) -> None:
            if await self._route_xiaod_retry_query(event):
                return
            await self.handle_message(event)
    async def _route_xiaod_status_query(self, event: MessageEvent) -> bool:
        pass
    async def _dispatch_inbound_event(self, event: MessageEvent) -> None:
        if await self._route_xiaod_retry_query(event):
            return
        if event.message_type == MessageType.TEXT:
            pass
    async def send_exec_approval(
        self,
    ) -> SendResult:
        pass
    def _on_card_action_trigger(self, data: Any) -> Any:
        if hermes_action:
            return self._handle_approval_card_action(event=event, action_value=action_value, loop=loop)
    async def _handle_card_action_event(self, data: Any) -> None:
        event = getattr(data, "event", None)
        token = str(getattr(event, "token", "") or "")
        context = getattr(event, "context", None)
        action_tag = "button"
        action_value = {}
        synthetic_text = f"/card {action_tag}"
        if action_value:
            try:
                synthetic_text += f" {json.dumps(action_value, ensure_ascii=False)}"
            except Exception:
                pass
        synthetic_event = MessageEvent(
            text=synthetic_text,
            message_id=token or str(uuid.uuid4()),
        )
    def _handle_approval_card_action(self, *, event: Any, action_value: Dict[str, Any], loop: Any) -> Any:
        pass
    async def _resolve_approval(
        self,
    ) -> None:
        pass
`;

// 其他四个常驻 Gateway 的 HERMES_HOME 相对路径（来源：integrations/hermes/README.md 的标签与 Home 对照表）。
const NON_AJUN_PROFILE_HOMES = Object.freeze(['xiaod', 'intel-researcher', 'office-assistant', 'operator']);

test('P2-1（需求 3.1，最高优先）handled:false 直答分支的响应体与基线深度相等，且不含任何诊断或降级字样', async (context) => {
  const dataDir = await makeTempDataDir(context);
  const fixture = await startCommanderHandler(context, { dataDir, commander: realCommander() });
  const random = createSeededRandom(PRNG_SEED);

  for (let index = 0; index < 24; index += 1) {
    const text = randomDirectReplyText(random);
    const trace = `seed=${PRNG_SEED} index=${index} text=${JSON.stringify(text)}`;

    // 生成器守卫：只有真正命中既有直答判定的输入才落在本属性的输入域内。
    assert.equal(isDirectReplyWithoutTask(text), true, `生成器越界：${trace}`);

    const result = await postJson(`${fixture.baseUrl}/api/feishu/commander`, {
      text,
      sourceEventRef: `feishu:preservation-direct-${index}`,
      chatRef: 'chat-preservation-direct',
      requesterRef: 'preservation-user',
    });

    assert.equal(result.status, DIRECT_REPLY_BASELINE.status, `状态码偏离基线：${trace}`);
    assert.deepEqual(result.body, DIRECT_REPLY_BASELINE.body, `响应体偏离基线：${trace}`);
    assert.equal(result.body.handled, false, trace);
    assert.equal(result.body.reason, 'explicit_direct_reply_without_task', trace);

    const serialized = JSON.stringify(result.body);
    for (const phrase of FORBIDDEN_DIAGNOSTIC_PHRASES) {
      assert.ok(!serialized.includes(phrase), `直答响应体不得出现「${phrase}」：${trace} body=${serialized}`);
    }
  }

  // 收紧（任务 4.10）：落盘**确实存在**，且上面的对外行为逐字节不变。
  const evidence = await readChainEvidence(dataDir);
  assert.equal(evidence.length, 24, `每条直答消息都必须留下一条判定证据，实际：${evidence.length}`);
  assert.deepEqual(
    evidence.map((record) => record.sourceEventRef).sort(),
    Array.from({ length: 24 }, (_unused, index) => `feishu:preservation-direct-${index}`).sort(),
    '每条飞书消息都必须能按 sourceEventRef 对齐到一条证据。',
  );
  for (const record of evidence) {
    assert.equal(record.kind, 'no_task_by_design');
    assert.equal(record.side, 'ajun-runtime');
    assert.equal(record.httpStatus, 202);
    assert.equal(record.reason, 'explicit_direct_reply_without_task', '证据必须带 reason，使有意静默与链路故障可区分。');
    assert.equal(record.externalActionStarted, false);
    // 只出摘要：原始 chatRef / requesterRef 不得出现在证据里（需求 2.11）。
    assert.match(record.chatRefDigest, /^sha256:[0-9a-f]{12}$/);
    assert.match(record.requesterRefDigest, /^sha256:[0-9a-f]{12}$/);
    const serializedRecord = JSON.stringify(record);
    assert.ok(!serializedRecord.includes('chat-preservation-direct'));
    assert.ok(!serializedRecord.includes('preservation-user'));
  }
});

test('P2-1（需求 3.1）Hermes 侧 DIRECT_REPLY_V1 代码块在补丁变换前后逐字符相等', () => {
  const installed = applyPatch(ADAPTER_FIXTURE);
  const before = extractBlock(installed, DIRECT_REPLY_BLOCK_START, DIRECT_REPLY_BLOCK_END);

  assert.equal(before, DIRECT_REPLY_BLOCK_BASELINE);
  assert.equal(installed.split('AGENT_ARMY_FEISHU_COMMANDER_DIRECT_REPLY_V1').length - 1, 1);

  const transforms = {
    migrateFeishuCommanderRouter: (source) => migrateFeishuCommanderRouter(source).source,
    upgradeFeishuCommanderIngressProtocol: (source) => upgradeFeishuCommanderIngressProtocol(source),
    applyPatch: (source) => applyPatch(source),
  };
  for (const [name, transform] of Object.entries(transforms)) {
    const after = extractBlock(transform(installed), DIRECT_REPLY_BLOCK_START, DIRECT_REPLY_BLOCK_END);
    assert.equal(after, DIRECT_REPLY_BLOCK_BASELINE, `${name} 改动了 DIRECT_REPLY_V1 分支（需求 3.1 的结构性保证被破坏）。`);
  }
});

test('P2-2（需求 3.2）成功建任务继续返回 202，且投影四字段与基线一致', async (context) => {
  const dataDir = await makeTempDataDir(context);
  const { service } = setupTaskService({ agents: [coordinator] });

  // 固定夹具：逐字节比对观测基线。
  const golden = await startCommanderHandler(context, {
    dataDir,
    work: { store: service.store, tasks: service },
    commander: { async handle() { return { kind: 'media_task', task: GOLDEN_TASK, reply: GOLDEN_TASK_REPLY_INPUT }; } },
  });
  const goldenResult = await postJson(`${golden.baseUrl}/api/feishu/commander`, {
    text: '整理这个视频', sourceEventRef: 'feishu:preservation-202-golden',
  });
  assert.equal(goldenResult.status, 202);
  assert.equal(goldenResult.body.reply, GOLDEN_PROJECTION_BASELINE.reply);
  assert.deepEqual(goldenResult.body.presentation, GOLDEN_PROJECTION_BASELINE.presentation);
  assert.equal(goldenResult.body.taskCard.sourceRevision, GOLDEN_PROJECTION_BASELINE.sourceRevision);
  assert.equal(goldenResult.body.taskCard.contentHash, GOLDEN_PROJECTION_BASELINE.contentHash);

  // 属性式：随机标题/描述下，投影的结构不变量与确定性恒成立。
  const random = createSeededRandom(PRNG_SEED);
  for (let index = 0; index < 12; index += 1) {
    const title = randomTaskTitle(random);
    const description = randomTaskTitle(random);
    const taskId = `7df3c85a-1111-2222-3333-4444444444${String(index).padStart(2, '0')}`;
    const task = { taskId, status: 'queued', input: { title, description }, updatedAt: '2026-08-12T03:00:00.000Z' };
    const trace = `seed=${PRNG_SEED} index=${index} title=${JSON.stringify(title)}`;
    const fixture = await startCommanderHandler(context, {
      dataDir,
      work: { store: service.store, tasks: service },
      commander: { async handle() { return { kind: 'media_task', task, reply: `已登记：${title}。` }; } },
    });

    const first = await postJson(`${fixture.baseUrl}/api/feishu/commander`, {
      text: title, sourceEventRef: `feishu:preservation-202-${index}`,
    });
    const second = await postJson(`${fixture.baseUrl}/api/feishu/commander`, {
      text: title, sourceEventRef: `feishu:preservation-202-${index}`,
    });

    assert.equal(first.status, 202, trace);
    assert.equal(first.body.presentation.taskRef, `#${taskId.slice(0, 8).toUpperCase()}`, trace);
    assert.equal(first.body.presentation.detailPath, `/tasks/${taskId}`, trace);
    assert.equal(first.body.presentation.detailUrl, `${DETAIL_BASE_URL}/tasks/${taskId}`, trace);
    assert.equal(first.body.taskCard.sourceRevision, `${task.updatedAt}:card-ux4`, trace);
    assert.match(first.body.taskCard.contentHash, /^[0-9a-f]{64}$/, trace);
    assert.equal(first.body.reply.match(/下一步：/g)?.length, 1, trace);
    // 同一输入的投影必须逐字节可复现。
    assert.deepEqual(second.body, first.body, `同一输入的 202 投影不可复现：${trace}`);
  }
});

test('P2-3（需求 3.3）随机非本机来源恒为 403，错误文案逐字节不变', async (context) => {
  const dataDir = await makeTempDataDir(context);
  const random = createSeededRandom(PRNG_SEED);
  const addresses = [
    // 确定性枚举：观测基线里实际跑过的五种。
    '203.0.113.10', '::ffff:203.0.113.10', '192.168.1.20', '10.0.0.5', '::ffff:10.1.2.3',
    // 固定种子随机：公网段、LAN 段与 ::ffff: 前缀变体。
    ...Array.from({ length: 12 }, () => randomNonLocalAddress(random)),
  ];

  for (const [index, remoteAddress] of addresses.entries()) {
    const trace = `seed=${PRNG_SEED} index=${index} remoteAddress=${remoteAddress}`;
    const fixture = await startCommanderHandler(context, {
      dataDir,
      remoteAddress,
      commander: { async handle() { assert.fail(`非本机调用不得进入 commander.handle：${trace}`); } },
    });
    const result = await postJson(`${fixture.baseUrl}/api/feishu/commander`, {
      text: '帮我看一下这周的公开资料', sourceEventRef: `feishu:preservation-403-${index}`,
    });

    assert.equal(result.status, FORBIDDEN_BASELINE.status, trace);
    assert.deepEqual(result.body, FORBIDDEN_BASELINE.body, trace);
    assert.equal(result.body.error, FORBIDDEN_BASELINE.body.error, trace);
  }

  // 收紧（任务 4.10）：每次 403 都确实落了一条同一事件的证据，且 403 的对外行为逐字节不变。
  const evidence = await readChainEvidence(dataDir);
  assert.equal(evidence.length, addresses.length, `每次 403 拒绝都必须留下一条证据，实际：${evidence.length}`);
  assert.deepEqual(
    evidence.map((record) => record.sourceEventRef).sort(),
    addresses.map((_unused, index) => `feishu:preservation-403-${index}`).sort(),
  );
  for (const record of evidence) {
    assert.equal(record.kind, 'ingress_rejected_non_local');
    assert.equal(record.side, 'ajun-runtime');
    assert.equal(record.httpStatus, 403);
    assert.equal(record.externalActionStarted, false);
    assert.match(record.nextStep, /npm run diagnose:feishu-chain/);
    // 证据里不得出现来源 IP 之外的任何原文，也不得出现被拒绝请求的正文。
    assert.ok(!JSON.stringify(record).includes('帮我看一下这周的公开资料'));
  }
});

test('P2-4（需求 3.4）非 ajun Profile 的 guard 恒不进入总管路由', () => {
  const installed = applyPatch(ADAPTER_FIXTURE);
  const guardBlock = extractBlock(installed, GUARD_BLOCK_START, GUARD_BLOCK_END);
  assert.equal(guardBlock, COMMANDER_GUARD_BLOCK_BASELINE);

  // 观测所得的确定性基线表（在未修复代码的真实 guard 文本上由 python3 执行得到）。
  // 注意：空串与仅含空白的取值会**回退到 ajun**（`or "ajun"`），因此继续进入总管路由 ——
  // 这是既有正确行为（A君自己的 Profile 默认值），不是缺陷。
  const observedBaseline = [
    ['ajun', true],
    [' ajun ', true],
    ['ajun\n', true],
    ['', true],
    ['xiaod', false],
    ['AJUN', false],
    ['Ajun', false],
    ['ajun-runtime', false],
    ['小D', false],
  ];
  for (const [agentId, entersCommanderRoute] of observedBaseline) {
    assert.equal(
      runAdapterGuard(guardBlock, { agentId, messageType: 'TEXT' }).entersCommanderRoute,
      entersCommanderRoute,
      `guard 基线偏离：agentId=${JSON.stringify(agentId)}`,
    );
  }

  // 属性式：固定种子生成归一化后 ≠ 'ajun' 的取值，断言恒被拒绝。
  const random = createSeededRandom(PRNG_SEED);
  for (let index = 0; index < 16; index += 1) {
    const agentId = randomNonAjunAgentId(random);
    const trace = `seed=${PRNG_SEED} index=${index} agentId=${JSON.stringify(agentId)}`;
    assert.notEqual(agentId.trim(), 'ajun', `生成器越界：${trace}`);
    assert.notEqual(agentId.trim(), '', `生成器越界：${trace}`);
    assert.equal(
      runAdapterGuard(guardBlock, { agentId, messageType: 'TEXT' }).entersCommanderRoute,
      false,
      `非 ajun Profile 被放进了总管路由：${trace}`,
    );
  }
});

test('P2-5（需求 3.5）5 类 adapter 夹具连续应用补丁 3 次逐字节相等', () => {
  const installed = applyPatch(ADAPTER_FIXTURE);
  const fixtures = {
    // 五类：未打补丁 / notifyV3 / notifyV4 / precedence / 已 seam。
    // 后三类为标记级夹具，与 patch-feishu-agent-proposal-router.test.mjs 的迁移矩阵用例同源。
    unpatched: ADAPTER_FIXTURE,
    notifyV3: 'AJUN_COMMANDER_TASK_NOTIFY_V3',
    notifyV4: 'AJUN_COMMANDER_TASK_NOTIFY_V4',
    precedence: 'AJUN_COMMANDER_INGRESS_PRECEDENCE_V1\nAJUN_COMMANDER_TASK_NOTIFY_V4',
    installedSeam: installed,
  };

  for (const [name, source] of Object.entries(fixtures)) {
    const first = applyPatch(source);
    const second = applyPatch(first);
    const third = applyPatch(second);
    assert.equal(second, first, `${name}：第 2 次应用补丁与第 1 次不相等（幂等被破坏）。`);
    assert.equal(third, first, `${name}：第 3 次应用补丁与第 1 次不相等（幂等被破坏）。`);
    // 收紧（任务 4.10）：装上了总管路由的源码里，新标记恰好出现一次；
    // 只含迁移标记的最小夹具本来就没有总管路由，因此该单元跳过（0 次）。
    const markerCount = third.split('AGENT_ARMY_FEISHU_COMMANDER_SILENT_FAILURE_EVIDENCE_V1').length - 1;
    assert.equal(
      markerCount,
      third.includes('AJUN_FEISHU_COMMANDER_INGRESS_URL') ? 1 : 0,
      `${name}：静默失败证据标记出现 ${markerCount} 次（应恰好一次或整体跳过）。`,
    );
  }

  // 观测记录：已安装 Adapter Seam 的源码在 migrateFeishuCommanderRouter 上恒为 terminal 且原样返回。
  // 逐字节幂等的真正保证来自补丁脚本入口 applyPatch（它会装上 Adapter Seam，使后续执行落到 terminal 分支）。
  const migrated = migrateFeishuCommanderRouter(installed);
  assert.equal(migrated.migration, 'installed-adapter-seam-v1');
  assert.equal(migrated.terminal, true);
});

test('P2-6（需求 3.6）非 TEXT 消息恒不进入总管文本路由', () => {
  const installed = applyPatch(ADAPTER_FIXTURE);
  const guardBlock = extractBlock(installed, GUARD_BLOCK_START, GUARD_BLOCK_END);

  // 短路条件本身逐字符不变。
  assert.ok(guardBlock.startsWith('        if not ingress_url or event.message_type != MessageType.TEXT:\n            return False\n'));

  // 枚举非 TEXT 取值。真实 Hermes 的 MessageType 枚举不在本仓库内，
  // 因此这里的成员集合是仓库侧替身；「真实枚举成员是否恰为这些」标记**未验证**（需真机确认）。
  const nonTextMessageTypes = [
    'IMAGE', 'FILE', 'AUDIO', 'MEDIA', 'POST', 'STICKER', 'INTERACTIVE', 'SHARE_CHAT', 'SHARE_USER', 'SYSTEM',
  ];
  for (const messageType of nonTextMessageTypes) {
    assert.equal(
      runAdapterGuard(guardBlock, { agentId: 'ajun', messageType }).entersCommanderRoute,
      false,
      `非 TEXT 消息 ${messageType} 进入了总管文本路由。`,
    );
  }
  assert.equal(runAdapterGuard(guardBlock, { agentId: 'ajun', messageType: 'TEXT' }).entersCommanderRoute, true);
  // ingress_url 缺失时同样短路（需求 1.1 的既有行为，本阶段只锁住它不变）。
  assert.equal(runAdapterGuard(guardBlock, { agentId: 'ajun', messageType: 'TEXT', ingressUrl: '' }).entersCommanderRoute, false);
});

test('P2-7（需求 3.7）/api/health 与 runtime-fingerprint 的契约版本不变', async (context) => {
  const dataDir = await makeTempDataDir(context);
  const { service } = setupTaskService({ agents: [coordinator] });
  const fixture = await startCommanderHandler(context, {
    dataDir,
    work: { store: service.store, tasks: service },
    commander: { async handle() { return { kind: 'identity', reply: '我是A君。' }; } },
  });

  const response = await fetch(`${fixture.baseUrl}/api/health`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.schemaVersion, RUNTIME_HEALTH_SCHEMA_BASELINE);

  const fingerprint = await collectRuntimeFingerprint({ probeTimeoutMs: 200 });
  assert.equal(fingerprint.schemaVersion, RUNTIME_FINGERPRINT_SCHEMA_BASELINE);
});

test('P2-8（需求 3.8）账本路径只由 dataDir 决定，其他四个 Gateway 的 Home 不被写入', async (context) => {
  const dataDir = await makeTempDataDir(context);
  const hermesRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'preservation-hermes-root-'));
  context.after(() => fs.rm(hermesRoot, { recursive: true, force: true }));

  for (const profile of NON_AJUN_PROFILE_HOMES) {
    const home = path.join(hermesRoot, 'profiles', profile);
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(home, 'agent_army_task_cards.json'), '{}\n', 'utf8');
  }
  const before = await snapshotTree(hermesRoot);

  const { service } = setupTaskService({ agents: [coordinator] });
  const fixture = await startCommanderHandler(context, {
    dataDir,
    work: { store: service.store, tasks: service },
    commander: realCommander(),
  });
  await postJson(`${fixture.baseUrl}/api/feishu/commander`, {
    text: '不要创建任务，直接回复我这句话的意思',
    sourceEventRef: 'feishu:preservation-isolation-1',
    chatRef: 'chat-preservation-isolation',
  });
  const rejected = await startCommanderHandler(context, {
    dataDir, remoteAddress: '203.0.113.10', commander: { async handle() { assert.fail('不该进入'); } },
  });
  await postJson(`${rejected.baseUrl}/api/feishu/commander`, {
    text: '你好', sourceEventRef: 'feishu:preservation-isolation-2',
  });

  // 本条只断言「不被写入」：读取行为无法在本沙箱内可靠观测，因此不冒充为已验证。
  assert.deepEqual(await snapshotTree(hermesRoot), before, '非 ajun Profile 的 Home 被改写了。');
  const evidence = await readChainEvidence(hermesRoot);
  assert.deepEqual(evidence, [], '非 ajun Profile 的 Home 里出现了链路证据账本。');
});

test('P2-9 证据写入不得成为新故障模式：账本抛异常或 dataDir 不可写时 403/202 不变', async (context) => {
  // 收紧（任务 4.10）：不仅响应体不变，还要证明落盘接缝**确实被调用过** ——
  // 否则「响应体不变」可能只是因为这条路径根本没接上证据写入。
  const recordCalls = [];
  const throwingLedger = {
    async record(input) { recordCalls.push(input?.kind); throw new Error('证据写入故意失败'); },
    async readRecent() { throw new Error('证据读取故意失败'); },
  };

  // 沙箱以 root 运行，仅靠 0500 权限位无法真实构造不可写目录；
  // 因此把 dataDir 指到「父路径是普通文件」的位置，制造真实不可写（ENOTDIR）条件。
  const blockingFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'preservation-blocked-')), 'not-a-directory');
  await fs.writeFile(blockingFile, 'x', 'utf8');
  context.after(() => fs.rm(path.dirname(blockingFile), { recursive: true, force: true }));
  const unwritableDataDir = path.join(blockingFile, 'nested-data-dir');

  const { service } = setupTaskService({ agents: [coordinator] });

  const accepted = await startCommanderHandler(context, {
    dataDir: unwritableDataDir,
    keepDataDir: true,
    work: { store: service.store, tasks: service },
    commander: realCommander(),
    extraFeishu: { commanderChainEvidence: throwingLedger },
  });
  const directReply = await postJson(`${accepted.baseUrl}/api/feishu/commander`, {
    text: '不要创建任务，直接回复我这句话的意思',
    sourceEventRef: 'feishu:preservation-p29-1',
    chatRef: 'chat-preservation-p29',
  });
  assert.equal(directReply.status, DIRECT_REPLY_BASELINE.status);
  assert.deepEqual(directReply.body, DIRECT_REPLY_BASELINE.body);

  const rejected = await startCommanderHandler(context, {
    dataDir: unwritableDataDir,
    keepDataDir: true,
    remoteAddress: '203.0.113.10',
    commander: { async handle() { assert.fail('不该进入'); } },
    extraFeishu: { commanderChainEvidence: throwingLedger },
  });
  const forbidden = await postJson(`${rejected.baseUrl}/api/feishu/commander`, {
    text: '你好', sourceEventRef: 'feishu:preservation-p29-2',
  });
  assert.equal(forbidden.status, FORBIDDEN_BASELINE.status);
  assert.deepEqual(forbidden.body, FORBIDDEN_BASELINE.body);

  // 两处接缝都被调用过、都抛了异常，而对外行为一字未变。
  assert.deepEqual(recordCalls, ['no_task_by_design', 'ingress_rejected_non_local']);
  // dataDir 不可写时也没有任何文件被创建（写入失败只是「这次没留下证据」）。
  assert.deepEqual(await readChainEvidence(path.dirname(blockingFile)), []);

  // Hermes 侧同一约束：目录不可创建时 record_commander_chain_evidence 返回 False 且不抛异常。
  const pythonModule = path.resolve(here, '../../../integrations/hermes/runtime/agent_army_feishu_commander_evidence.py');
  const pythonRun = spawnSync('python3', ['-c', [
    'import importlib.util, json, sys',
    'spec = importlib.util.spec_from_file_location("evidence", sys.argv[1])',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'result = module.record_commander_chain_evidence(',
    '    hermes_home=sys.argv[2], kind="ingress_unreachable", source_event_ref="feishu:p29")',
    'print(json.dumps({"result": result}))',
  ].join('\n'), pythonModule, path.join(blockingFile, 'nested-hermes-home')], { encoding: 'utf8' });
  assert.equal(pythonRun.status, 0, `Python 侧不得抛异常：${pythonRun.stderr}`);
  assert.equal(JSON.parse(pythonRun.stdout).result, false, 'Python 侧写入失败必须返回 False。');
});

// --- 固定种子伪随机生成器（mulberry32；不引入 PBT 库） ---

function createSeededRandom(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(random, values) {
  return values[Math.floor(random() * values.length) % values.length];
}

function randomDirectReplyText(random) {
  const negation = pick(random, ['不要', '不用', '无需', '不需要', '禁止', '别']);
  const verb = pick(random, ['创建', '新建', '发起', '安排']);
  const quantifier = pick(random, ['', '一个', '一项', '个', '项']);
  const noun = pick(random, ['任务', '测试任务']);
  const lead = pick(random, ['', '这次', '这个问题', '关于上周的公开资料', '先说清楚一件事：']);
  const tail = pick(random, [
    '，直接回复我',
    '，只需回复一句结论',
    '，只要在当前会话回复就行',
    '，不要调用任何工具，直接在本会话回复',
    '，请直接回复你的判断',
  ]);
  return `${lead}${negation}${verb}${quantifier}${noun}${tail}`;
}

function randomTaskTitle(random) {
  const subject = pick(random, ['这周的公开资料', '上季度的对外说明', '这个公开视频', '客户提的三个问题', '本月的公开数据']);
  const action = pick(random, ['整理成一页说明', '做一份要点摘要', '核对一遍口径', '归档并标注来源', '写一段对外口径']);
  return `${action}：${subject}`;
}

function randomNonLocalAddress(random) {
  const prefix = pick(random, ['', '::ffff:']);
  const segment = pick(random, [
    () => `203.0.113.${1 + Math.floor(random() * 250)}`,
    () => `198.51.100.${1 + Math.floor(random() * 250)}`,
    () => `192.168.${Math.floor(random() * 256)}.${1 + Math.floor(random() * 250)}`,
    () => `10.${Math.floor(random() * 256)}.${Math.floor(random() * 256)}.${1 + Math.floor(random() * 250)}`,
    () => `172.16.${Math.floor(random() * 256)}.${1 + Math.floor(random() * 250)}`,
  ]);
  return `${prefix}${segment()}`;
}

function randomNonAjunAgentId(random) {
  const candidates = [
    'xiaod', 'intel-researcher', 'office-assistant', 'operator', 'creator', 'reviewer',
    'AJUN', 'Ajun', 'aJuN', 'ajun-runtime', 'ajun2', 'ajun.', '小D', '运维官',
    'a jun', 'ajun ajun', '"ajun"', 'ajun;', 'ajun\u200b', '../ajun',
  ];
  const value = pick(random, candidates);
  // 归一化后仍为 'ajun' 或空的取值不在本属性输入域内（那是 A君 自己的默认 Profile）。
  return value.trim() === 'ajun' || value.trim() === '' ? 'xiaod' : value;
}

// --- adapter 源码片段提取与 python3 执行 ---

const DIRECT_REPLY_BLOCK_START = '            # AGENT_ARMY_FEISHU_COMMANDER_DIRECT_REPLY_V1';
const DIRECT_REPLY_BLOCK_END = '            reply = body.get("reply") if isinstance(body, dict) else None';
const GUARD_BLOCK_START = '        if not ingress_url or event.message_type != MessageType.TEXT:';
const GUARD_BLOCK_END = '        if not ingress_url.startswith(';

function extractBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `找不到起始锚点：${startMarker.trim().slice(0, 60)}`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end >= 0, `找不到结束锚点：${endMarker.trim().slice(0, 60)}`);
  return source.slice(start, end);
}

// 用 python3 直接执行**从补丁产物中提取出来的真实 guard 文本**（仅整体缩进减 4 以放进函数体）。
// MessageType 与 event 是仓库侧替身；不触达真实 Hermes。
function runAdapterGuard(guardBlock, { agentId, messageType, ingressUrl = 'http://127.0.0.1:4321/api/feishu/commander' }) {
  const harness = [
    'import json, sys',
    'import os',
    '',
    'class MessageType:',
    '    TEXT = "text"',
    '    IMAGE = "image"',
    '    FILE = "file"',
    '    AUDIO = "audio"',
    '    MEDIA = "media"',
    '    POST = "post"',
    '    STICKER = "sticker"',
    '    INTERACTIVE = "interactive"',
    '    SHARE_CHAT = "share_chat"',
    '    SHARE_USER = "share_user"',
    '    SYSTEM = "system"',
    '',
    'class _Event:',
    '    def __init__(self, message_type):',
    '        self.message_type = message_type',
    '',
    'def _enters_commander_route(event, ingress_url):',
    guardBlock.split('\n').map((line) => (line.startsWith('    ') ? line.slice(4) : line)).join('\n'),
    '    return True',
    '',
    'payload = json.loads(sys.argv[1])',
    'event = _Event(getattr(MessageType, payload["messageType"]))',
    'print(json.dumps({"entersCommanderRoute": _enters_commander_route(event, payload["ingressUrl"])}))',
  ].join('\n');

  const run = spawnSync('python3', ['-c', harness, JSON.stringify({ messageType, ingressUrl })], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      ...(agentId === undefined ? {} : { AGENT_ARMY_FEISHU_AGENT_ID: agentId }),
    },
  });
  assert.equal(run.status, 0, `python3 guard harness 失败：${run.stderr}`);
  return JSON.parse(run.stdout);
}

// --- 支持函数 ---

function realCommander() {
  const { service } = setupTaskService({ agents: [coordinator] });
  return new FeishuCommander({
    tasks: service,
    proposals: {},
    planner: { async decide() { throw new Error('planner 在本测试中不可用'); } },
    ajunBaseUrl: DETAIL_BASE_URL,
  });
}

async function makeTempDataDir(context) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'preservation-chain-data-'));
  context.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return dataDir;
}

async function snapshotTree(root) {
  const snapshot = [];
  async function walk(directory) {
    const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        snapshot.push({ path: path.relative(root, full), kind: 'directory' });
        await walk(full);
      } else {
        const stats = await fs.stat(full);
        snapshot.push({
          path: path.relative(root, full),
          kind: 'file',
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          content: await fs.readFile(full, 'utf8'),
        });
      }
    }
  }
  await walk(root);
  return snapshot;
}

async function readChainEvidence(root) {
  const records = [];
  for (const file of await collectJsonlFiles(root)) {
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

async function startCommanderHandler(context, {
  dataDir, remoteAddress = null, commander, work = {}, extraFeishu = {},
}) {
  const handler = createAjunHttpHandler({
    environment: {},
    publicDir: path.join(runtimeRoot, 'public'),
    dataDir,
    detailBaseUrl: DETAIL_BASE_URL,
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
      ...extraFeishu,
    },
    m5: {},
  });
  const server = http.createServer((request, response) => {
    // 在真实 socket 上改写来源地址，让 isLocalAddress 走到既有非本机分支。
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

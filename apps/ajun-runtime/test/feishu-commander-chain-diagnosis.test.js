// 切片 A · 纯判定模块单测（任务 3.1 / 3.2）
//
// 覆盖：5 条结构不变量、六项判定的 pass / gap / unknown 分支、层级上限、
// 「不得跨层冒充」规则、8 个静默点的覆盖矩阵，以及 6 项 × {pass,gap,unknown}
// 的笛卡尔枚举属性测试（固定种子，只用于在多个 gap 变体之间取样）。
//
// 原生 node --test，不引入 Jest / Vitest / fast-check（需求 3.9）。
//
// **Validates: Requirements 2.1, 2.2, 2.3, 2.6, 2.7, 2.9, 2.11, 2.12**

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_ID_ENV_KEY,
  CHAIN_CHECK_IDS,
  FEISHU_COMMANDER_CHAIN_DIAGNOSIS_SCHEMA,
  INGRESS_URL_ENV_KEY,
  LEGACY_AGENT_ID_ENV_KEY,
  NO_LOCAL_GAP_CAVEAT,
  TRUTH_LAYER_CEILINGS,
  diagnoseFeishuCommanderChain,
  layerRank,
} from '../src/feishu-commander-chain-diagnosis.ts';

const PRNG_SEED = 20260818;
const FIXED_NOW = () => new Date('2026-08-18T09:00:00.000Z');
const CONFIGURED_CEILING_CHECKS = Object.freeze(['adapter-patch', 'required-env', 'profile-guard', 'feishu-admission']);

// --- 观测替身：全 pass 基线，各条用例只覆盖需要的一项 ---

function healthyObservations() {
  return {
    gatewayProcess: { status: 'observed', loaded: true, pid: 4242, state: 'running', lastExitStatus: 0 },
    adapterPatch: {
      status: 'observed',
      exists: true,
      hasCommanderRoute: true,
      duplicateRouteDefinitions: 1,
      markers: {
        PROFILE_GUARD_V1: true,
        DIRECT_REPLY_V1: true,
        INGRESS_TIMEOUT_V1: true,
        ADAPTER_SEAM_V1: true,
        // 切片 B 才注入的标记；切片 A 的判定必须容忍它缺失。
        SILENT_FAILURE_EVIDENCE_V1: false,
      },
      hermesVersion: '0.19.0',
      hermesVersionMatchesBaseline: true,
    },
    requiredEnv: {
      status: 'observed',
      plistExists: true,
      variables: {
        [INGRESS_URL_ENV_KEY]: { present: true, classification: 'expected_loopback' },
        [AGENT_ID_ENV_KEY]: { present: true, agentId: 'ajun' },
        [LEGACY_AGENT_ID_ENV_KEY]: { present: false },
      },
    },
    runtimeIngress: {
      status: 'observed',
      reachable: true,
      healthStatus: 'healthy',
      httpStatus: 200,
      listenerPid: 1234,
      releaseStatus: 'immutable_release',
      releaseHashDigest: 'sha256:0123456789ab',
      sourceRelationship: 'same_git_head',
      devPortListening: false,
    },
    profileGuard: {
      status: 'observed', agentId: 'ajun', source: AGENT_ID_ENV_KEY, guardMarkerPresent: true,
    },
    feishuAdmission: {
      status: 'observed',
      configured: true,
      entryCount: 3,
      hit: true,
      requesterRefDigest: 'sha256:0123456789ab',
      fieldPath: 'platforms.feishu.allowed_users',
    },
  };
}

function observationsWith(overrides) {
  return { ...healthyObservations(), ...overrides };
}

function diagnose(overrides = {}, options = {}) {
  return diagnoseFeishuCommanderChain(observationsWith(overrides), { now: FIXED_NOW, ...options });
}

function checkOf(result, id) {
  const check = result.checks.find((item) => item.id === id);
  assert.ok(check, `诊断输出缺少检查项 ${id}`);
  return check;
}

function assertStructuralInvariants(result, trace = '') {
  // 不变量 1 / 2：六项齐全且顺序固定。
  assert.equal(result.checks.length, 6, `checks 长度必须恒为 6：${trace}`);
  assert.deepEqual(result.checks.map((check) => check.id), [...CHAIN_CHECK_IDS], `checks 顺序必须等于 CHAIN_CHECK_IDS：${trace}`);
  for (const check of result.checks) {
    // 不变量 3：层级不得突破上限。
    assert.equal(check.truthLayerCeiling, TRUTH_LAYER_CEILINGS[check.id], `${check.id} 上限被改写：${trace}`);
    assert.ok(
      layerRank(check.truthLayer) <= layerRank(check.truthLayerCeiling),
      `${check.id} 的 truthLayer=${check.truthLayer} 超过上限 ${check.truthLayerCeiling}：${trace}`,
    );
    // 不变量 4：pass ⟺ nextStep 为 null。
    assert.equal(
      check.status === 'pass', check.nextStep === null,
      `${check.id} 违反 status==='pass' ⟺ nextStep===null（status=${check.status} nextStep=${check.nextStep}）：${trace}`,
    );
    assert.equal(check.requiresRealMachineVerification, true, `${check.id} 必须标注需真机验证：${trace}`);
    assert.ok(['pass', 'gap', 'unknown'].includes(check.status), `${check.id} status 非法：${trace}`);
    assert.ok(check.conclusion.length > 0, `${check.id} 缺少中文结论：${trace}`);
    // 能力真相五层：四项永不到 reachable。
    if (CONFIGURED_CEILING_CHECKS.includes(check.id)) {
      assert.notEqual(check.truthLayer, 'reachable', `${check.id} 不得冒充运行可达：${trace}`);
    }
  }
  // 不变量 5：blocking_gap ⟺ 存在阻断且非 pass 的检查。
  assert.equal(
    result.verdict === 'blocking_gap',
    result.checks.some((check) => check.blocking && check.status !== 'pass'),
    `verdict 与 blocking 集合不一致（verdict=${result.verdict}）：${trace}`,
  );
  if (result.verdict === 'blocking_gap') {
    assert.ok(result.uniqueNextStep, `blocking_gap 必须给出唯一下一步：${trace}`);
  }
  assert.equal(result.schemaVersion, FEISHU_COMMANDER_CHAIN_DIAGNOSIS_SCHEMA, trace);
  assert.equal(result.safety.readOnly, true, trace);
  assert.equal(result.safety.secretsRead, false, trace);
  assert.equal(result.safety.externalEffects, false, trace);
  // 三种 verdict 的告示都必须把「唯一能证明飞书可用的一步」写清楚。
  assert.match(result.verdictCaveat, /飞书私聊发一条真实文本消息/, trace);
  if (result.verdict === 'no_local_gap_found') {
    assert.equal(result.verdictCaveat, NO_LOCAL_GAP_CAVEAT, trace);
  } else {
    assert.notEqual(result.verdictCaveat, NO_LOCAL_GAP_CAVEAT, `非 no_local_gap_found 不得声称本机未发现缺口：${trace}`);
  }
}

// --- 任务 3.1：结构不变量与只读安全声明 ---

test('3.1 全 pass 观测下六项齐全、verdict 为 no_local_gap_found 且带真机验证告示（需求 2.9）', () => {
  const result = diagnose();
  assertStructuralInvariants(result);
  assert.equal(result.verdict, 'no_local_gap_found');
  assert.equal(result.uniqueNextStep, null);
  assert.equal(result.generatedAt, '2026-08-18T09:00:00.000Z');
  assert.match(result.verdictCaveat, /需在飞书私聊发一条真实文本消息/);
  for (const check of result.checks) assert.equal(check.status, 'pass');
  // 切片 B 的新标记尚未注入时，adapter-patch 依然判 pass（切片 A 的独立性）。
  assert.equal(checkOf(result, 'adapter-patch').evidence.markers.SILENT_FAILURE_EVIDENCE_V1, false);
});

test('3.1 全 unknown 观测下不崩溃、六项齐全、verdict 为 diagnosis_incomplete（需求 2.9）', () => {
  const unknown = {
    gatewayProcess: { status: 'unknown', loaded: false, pid: null },
    adapterPatch: { status: 'unknown', exists: false, hasCommanderRoute: false, duplicateRouteDefinitions: 0, markers: {} },
    requiredEnv: { status: 'unknown', variables: {} },
    runtimeIngress: { status: 'unknown', reachable: false },
    profileGuard: { status: 'unknown', agentId: null },
    feishuAdmission: { status: 'unknown', configured: false },
  };
  const result = diagnoseFeishuCommanderChain(unknown, { now: FIXED_NOW });
  assertStructuralInvariants(result);
  assert.equal(result.verdict, 'diagnosis_incomplete');
  for (const check of result.checks) {
    assert.equal(check.status, 'unknown');
    assert.equal(check.blocking, false);
    assert.ok(check.nextStep, `${check.id} 的 unknown 结论必须带下一步`);
  }
  assert.ok(result.uniqueNextStep);
});

test('3.1 recentEvidence 未注入时为空数组，注入后原样透传（切片 A 不依赖切片 B）', () => {
  assert.deepEqual(diagnose().recentEvidence, []);
  const records = [
    { kind: 'no_task_by_design', reason: 'explicit_direct_reply_without_task', recordedAt: '2026-08-18T08:00:00.000Z' },
  ];
  assert.deepEqual(diagnose({}, { recentEvidence: records }).recentEvidence, records);
});

// --- 任务 3.2：8 个静默点的覆盖矩阵 ---

test('3.2 静默点 1.1：ingress 变量未注入时报「已声明但未配置」且层级停在 declared（需求 2.1）', () => {
  const result = diagnose({
    requiredEnv: {
      status: 'observed',
      plistExists: true,
      variables: { [AGENT_ID_ENV_KEY]: { present: true, agentId: 'ajun' } },
    },
  });
  assertStructuralInvariants(result);
  const check = checkOf(result, 'required-env');
  assert.equal(check.status, 'gap');
  assert.equal(check.blocking, true);
  assert.equal(check.truthLayer, 'declared');
  assert.match(check.conclusion, /已声明但未配置/);
  assert.match(check.nextStep, /EnvironmentVariables/);
  assert.match(check.nextStep, /launchctl kickstart -k/);
  assert.equal(check.evidence.processInjection, 'unproven');
  assert.equal(result.verdict, 'blocking_gap');
  assert.equal(result.uniqueNextStep, check.nextStep);
});

test('3.2 静默点 1.2：agentId 非 ajun 时输出实际值与期望值并说明不拥有总管路由（需求 2.2）', () => {
  const result = diagnose({
    profileGuard: { status: 'observed', agentId: 'xiaod', source: AGENT_ID_ENV_KEY, guardMarkerPresent: true },
  });
  assertStructuralInvariants(result);
  const check = checkOf(result, 'profile-guard');
  assert.equal(check.status, 'gap');
  assert.equal(check.blocking, true);
  assert.equal(check.truthLayer, 'configured');
  assert.match(check.conclusion, /xiaod/);
  assert.match(check.conclusion, /ajun/);
  assert.match(check.conclusion, /不拥有总管文本路由/);
  assert.equal(check.evidence.effectiveAgentId, 'xiaod');
  assert.equal(check.evidence.expectedAgentId, 'ajun');
  // 需求 3.4：报 gap，不得建议放宽 guard。
  assert.match(check.nextStep, /其他岗位 Profile 必须继续被拒绝/);
});

test('3.2 实测行为：agentId 为空串或未配置时回退到 ajun，属正常状态而非缺口（需求 3.4）', () => {
  for (const agentId of [null, '', '   ', 'ajun', ' ajun ']) {
    const result = diagnose({
      profileGuard: { status: 'observed', agentId, guardMarkerPresent: true },
    });
    const check = checkOf(result, 'profile-guard');
    assert.equal(check.status, 'pass', `agentId=${JSON.stringify(agentId)} 应回退到 ajun 并判 pass`);
    assert.equal(check.evidence.effectiveAgentId, 'ajun');
    assert.equal(check.evidence.emptyValueFallsBackToExpected, true);
    assert.equal(check.truthLayer, 'configured');
  }
});

test('3.2 静默点 1.3：补丁不在位时唯一下一步指向重跑 patch-feishu-agent-proposal-router.mjs（需求 2.3）', () => {
  const missingRoute = diagnose({
    adapterPatch: {
      status: 'observed', exists: true, hasCommanderRoute: false, duplicateRouteDefinitions: 0, markers: {},
    },
  });
  assertStructuralInvariants(missingRoute);
  const check = checkOf(missingRoute, 'adapter-patch');
  assert.equal(check.status, 'gap');
  assert.equal(check.blocking, true);
  assert.equal(check.truthLayerCeiling, 'configured');
  assert.match(check.conclusion, /补丁/);
  assert.match(check.nextStep, /patch-feishu-agent-proposal-router\.mjs/);
  assert.equal(check.evidence.loadedByGatewayProcess, 'unproven');

  // 文件整体缺失、标记不全、重复定义都必须报同一条唯一下一步。
  const variants = [
    { status: 'observed', exists: false, hasCommanderRoute: false, duplicateRouteDefinitions: 0, markers: {} },
    {
      status: 'observed', exists: true, hasCommanderRoute: true, duplicateRouteDefinitions: 1,
      markers: { PROFILE_GUARD_V1: true, DIRECT_REPLY_V1: false },
    },
    {
      status: 'observed', exists: true, hasCommanderRoute: true, duplicateRouteDefinitions: 3,
      markers: { PROFILE_GUARD_V1: true, DIRECT_REPLY_V1: true },
    },
  ];
  for (const adapterPatch of variants) {
    const variant = checkOf(diagnose({ adapterPatch }), 'adapter-patch');
    assert.equal(variant.status, 'gap', JSON.stringify(adapterPatch));
    assert.match(variant.nextStep, /patch-feishu-agent-proposal-router\.mjs/);
  }
});

test('3.2 静默点 1.4：4321 不可达时报可归因结论并指向拉起正式 release（需求 2.4）', () => {
  const result = diagnose({
    runtimeIngress: { status: 'observed', reachable: false, healthStatus: 'degraded', errorCode: 'health_unreachable', devPortListening: false },
  });
  assertStructuralInvariants(result);
  const check = checkOf(result, 'runtime-ingress');
  assert.equal(check.status, 'gap');
  assert.equal(check.blocking, true);
  assert.match(check.conclusion, /降级文案/);
  assert.match(check.nextStep, /ajun-runtime/);
  assert.equal(check.evidence.feishuChainProven, 'unproven');
});

test('3.2 静默点 1.5：ingress URL 非本机或路径错误时报 403 成因（需求 2.5）', () => {
  for (const classification of ['non_loopback', 'unexpected_path', 'unparsable']) {
    const result = diagnose({
      requiredEnv: {
        status: 'observed',
        plistExists: true,
        variables: {
          [INGRESS_URL_ENV_KEY]: { present: true, classification },
          [AGENT_ID_ENV_KEY]: { present: true, agentId: 'ajun' },
        },
      },
    });
    const check = checkOf(result, 'required-env');
    assert.equal(check.status, 'gap', classification);
    assert.equal(check.blocking, true, classification);
    assert.match(check.conclusion, /403/, classification);
    assert.equal(check.evidence.ingressUrlClassification, classification);
    // 输出只含分类枚举，不回显原值。
    assert.equal(Object.hasOwn(check.evidence, 'ingressUrl'), false);
  }
});

test('3.2 静默点 1.6：Gateway 未运行时结论必须含「飞书消息此刻无人消费」（需求 2.6）', () => {
  const notLoaded = diagnose({ gatewayProcess: { status: 'observed', loaded: false, pid: null } });
  assertStructuralInvariants(notLoaded);
  const notLoadedCheck = checkOf(notLoaded, 'gateway-process');
  assert.equal(notLoadedCheck.status, 'gap');
  assert.equal(notLoadedCheck.blocking, true);
  assert.match(notLoadedCheck.conclusion, /飞书消息此刻无人消费/);
  assert.match(notLoadedCheck.nextStep, /launchctl bootstrap/);

  const loadedWithoutPid = diagnose({
    gatewayProcess: { status: 'observed', loaded: true, pid: null, state: 'not running', lastExitStatus: 1 },
  });
  const loadedCheck = checkOf(loadedWithoutPid, 'gateway-process');
  assert.equal(loadedCheck.status, 'gap');
  assert.match(loadedCheck.conclusion, /飞书消息此刻无人消费/);
  assert.match(loadedCheck.nextStep, /launchctl kickstart -k/);
  assert.notEqual(loadedCheck.truthLayer, 'reachable');
});

test('3.2 不得跨层冒充：Gateway 有 pid 时只证明进程在，不得声称飞书消息可被消费（需求 2.9）', () => {
  const check = checkOf(diagnose(), 'gateway-process');
  assert.equal(check.status, 'pass');
  assert.equal(check.truthLayer, 'reachable');
  assert.ok(!check.conclusion.includes('飞书消息可被消费'), `pass 结论不得冒充事件消费：${check.conclusion}`);
  assert.equal(check.evidence.feishuEventConsumption, 'unproven');
});

test('3.2 静默点 1.7：白名单字段读不出时必须是 unknown 且禁止输出 hit（需求 2.7）', () => {
  for (const feishuAdmission of [
    { status: 'unknown', configured: false, errorCode: 'config_unreadable' },
    { status: 'observed', configured: false, fieldPath: null },
    // 字段找不到却带着 hit 的观测：judge 必须丢掉 hit，不得升级为 pass/gap。
    { status: 'observed', configured: false, hit: true },
  ]) {
    const result = diagnose({ feishuAdmission });
    assertStructuralInvariants(result);
    const check = checkOf(result, 'feishu-admission');
    assert.equal(check.status, 'unknown', JSON.stringify(feishuAdmission));
    assert.equal(check.truthLayer, 'declared');
    assert.equal(check.blocking, false);
    assert.equal(Object.hasOwn(check.evidence, 'hit'), false, '读不出白名单时禁止输出 hit');
    assert.match(check.nextStep, /--requester/);
  }

  const missed = diagnose({
    feishuAdmission: {
      status: 'observed', configured: true, entryCount: 2, hit: false, requesterRefDigest: 'sha256:aabbccddeeff',
    },
  });
  const missedCheck = checkOf(missed, 'feishu-admission');
  assert.equal(missedCheck.status, 'gap');
  assert.equal(missedCheck.blocking, true);
  assert.match(missedCheck.conclusion, /未获准入/);
  assert.equal(missedCheck.evidence.admissionOfThisMessage, 'unproven');

  // 未指定 requester 时报不出命中，必须承认 unknown 而不是 pass。
  const withoutRequester = diagnose({
    feishuAdmission: { status: 'observed', configured: true, entryCount: 2, hit: null },
  });
  const withoutRequesterCheck = checkOf(withoutRequester, 'feishu-admission');
  assert.equal(withoutRequesterCheck.status, 'unknown');
  assert.equal(withoutRequesterCheck.truthLayer, 'configured');
  assert.match(withoutRequesterCheck.nextStep, /--requester/);
});

test('3.2 静默点 1.8：有意静默只能靠证据与真机验证区分，本机全 pass 也不得声称飞书可用', () => {
  const result = diagnose({}, {
    recentEvidence: [
      { kind: 'no_task_by_design', reason: 'explicit_direct_reply_without_task', sourceEventRef: 'feishu:m-1' },
    ],
  });
  assertStructuralInvariants(result);
  assert.equal(result.verdict, 'no_local_gap_found');
  assert.equal(result.recentEvidence[0].reason, 'explicit_direct_reply_without_task');
  assert.match(result.verdictCaveat, /这不等于飞书链路可用/);
  for (const check of result.checks) assert.equal(check.requiresRealMachineVerification, true);
});

test('3.2 静默点 1.10：4321 不可达而 4322 在监听时直接给出该结论', () => {
  const result = diagnose({
    runtimeIngress: { status: 'observed', reachable: false, devPortListening: true, errorCode: 'health_unreachable' },
  });
  const check = checkOf(result, 'runtime-ingress');
  assert.equal(check.status, 'gap');
  assert.equal(check.blocking, true);
  assert.match(check.conclusion, /4322/);
  assert.match(check.conclusion, /npm run dev/);
  assert.equal(check.evidence.devPortListening, true);
});

test('3.2 4321 可达但不是不可变 release 时只报 unknown，不冒充预期 release', () => {
  const result = diagnose({
    runtimeIngress: {
      status: 'observed', reachable: true, healthStatus: 'healthy', httpStatus: 200,
      listenerPid: 999, releaseStatus: 'mutable_or_unknown_runtime', devPortListening: false,
    },
  });
  assertStructuralInvariants(result);
  const check = checkOf(result, 'runtime-ingress');
  assert.equal(check.status, 'unknown');
  assert.equal(check.blocking, false);
  assert.match(check.nextStep, /runtime:fingerprint/);
  assert.equal(result.verdict, 'diagnosis_incomplete');
});

test('3.2 profile-guard 在 PROFILE_GUARD_V1 标记缺失时只报 unknown，不冒充 pass', () => {
  const result = diagnose({
    profileGuard: { status: 'observed', agentId: 'ajun', guardMarkerPresent: false },
  });
  const check = checkOf(result, 'profile-guard');
  assert.equal(check.status, 'unknown');
  assert.equal(check.truthLayer, 'declared');
  assert.match(check.nextStep, /patch-feishu-agent-proposal-router\.mjs/);
  assert.equal(check.evidence.runtimeBranchValue, 'unproven');
});

test('3.2 多个阻断缺口时唯一下一步取 CHAIN_CHECK_IDS 顺序上第一个阻断项', () => {
  const result = diagnose({
    gatewayProcess: { status: 'observed', loaded: false, pid: null },
    adapterPatch: { status: 'observed', exists: false, hasCommanderRoute: false, duplicateRouteDefinitions: 0, markers: {} },
    runtimeIngress: { status: 'observed', reachable: false, devPortListening: false },
  });
  assertStructuralInvariants(result);
  assert.equal(result.verdict, 'blocking_gap');
  assert.equal(result.uniqueNextStep, checkOf(result, 'gateway-process').nextStep);
});

test('3.2 期望值可注入：expectedAgentId / expectedPort / expectedIngressPath 参与结论渲染', () => {
  const result = diagnose(
    {
      profileGuard: { status: 'observed', agentId: 'ajun', guardMarkerPresent: true },
      requiredEnv: { status: 'observed', plistExists: true, variables: {} },
    },
    { expectedAgentId: 'ajun-next', expectedPort: 4399, expectedIngressPath: '/api/feishu/commander' },
  );
  assert.equal(checkOf(result, 'profile-guard').status, 'gap');
  assert.match(checkOf(result, 'profile-guard').conclusion, /ajun-next/);
  assert.match(checkOf(result, 'required-env').nextStep, /127\.0\.0\.1:4399\/api\/feishu\/commander/);
});

// --- 任务 3.2：属性测试（6 项 × {pass, gap, unknown} 笛卡尔枚举，固定种子选取 gap 变体） ---

const VARIANTS = Object.freeze({
  'gateway-process': {
    pass: () => ({ status: 'observed', loaded: true, pid: 4242, state: 'running' }),
    gap: (random) => (random() < 0.5
      ? { status: 'observed', loaded: false, pid: null }
      : { status: 'observed', loaded: true, pid: null, state: 'not running' }),
    unknown: () => ({ status: 'unknown', loaded: false, pid: null, errorCode: 'launchctl_unavailable' }),
  },
  'adapter-patch': {
    pass: () => healthyObservations().adapterPatch,
    gap: (random) => (random() < 0.5
      ? { status: 'observed', exists: false, hasCommanderRoute: false, duplicateRouteDefinitions: 0, markers: {} }
      : {
        status: 'observed', exists: true, hasCommanderRoute: true, duplicateRouteDefinitions: 2,
        markers: { PROFILE_GUARD_V1: true, DIRECT_REPLY_V1: true },
      }),
    unknown: () => ({
      status: 'unknown', exists: false, hasCommanderRoute: false, duplicateRouteDefinitions: 0,
      markers: {}, errorCode: 'adapter_unreadable',
    }),
  },
  'required-env': {
    pass: () => healthyObservations().requiredEnv,
    gap: (random) => (random() < 0.5
      ? { status: 'observed', plistExists: true, variables: {} }
      : {
        status: 'observed',
        plistExists: true,
        variables: { [INGRESS_URL_ENV_KEY]: { present: true, classification: 'non_loopback' } },
      }),
    unknown: () => ({ status: 'unknown', variables: {}, errorCode: 'plist_unreadable' }),
  },
  'runtime-ingress': {
    pass: () => healthyObservations().runtimeIngress,
    gap: (random) => ({
      status: 'observed', reachable: false, devPortListening: random() < 0.5, errorCode: 'health_unreachable',
    }),
    unknown: () => ({ status: 'unknown', reachable: false, errorCode: 'probe_failed' }),
  },
  'profile-guard': {
    pass: () => ({ status: 'observed', agentId: 'ajun', guardMarkerPresent: true }),
    gap: (random) => ({
      status: 'observed', agentId: random() < 0.5 ? 'xiaod' : 'AJUN', guardMarkerPresent: true,
    }),
    unknown: () => ({ status: 'unknown', agentId: null, errorCode: 'plist_unreadable' }),
  },
  'feishu-admission': {
    pass: () => healthyObservations().feishuAdmission,
    gap: () => ({ status: 'observed', configured: true, entryCount: 2, hit: false, requesterRefDigest: 'sha256:aabbccddeeff' }),
    unknown: (random) => (random() < 0.5
      ? { status: 'unknown', configured: false, errorCode: 'config_unreadable' }
      : { status: 'observed', configured: true, entryCount: 2, hit: null }),
  },
});

const OBSERVATION_FIELD_BY_CHECK = Object.freeze({
  'gateway-process': 'gatewayProcess',
  'adapter-patch': 'adapterPatch',
  'required-env': 'requiredEnv',
  'runtime-ingress': 'runtimeIngress',
  'profile-guard': 'profileGuard',
  'feishu-admission': 'feishuAdmission',
});

// 只有这些检查在 gap 时阻断飞书链路；feishu-admission 未命中同样阻断该发送者。
const BLOCKING_CHECKS = Object.freeze([
  'gateway-process', 'adapter-patch', 'required-env', 'runtime-ingress', 'profile-guard', 'feishu-admission',
]);

test('3.2 属性：6 项 × {pass,gap,unknown} 全部 729 种组合恒满足四条不变量且 verdict 与 blocking 集合一致', () => {
  const random = createSeededRandom(PRNG_SEED);
  const statuses = ['pass', 'gap', 'unknown'];
  let combinations = 0;
  for (let index = 0; index < 3 ** 6; index += 1) {
    const plan = {};
    let cursor = index;
    for (const id of CHAIN_CHECK_IDS) {
      plan[id] = statuses[cursor % 3];
      cursor = Math.floor(cursor / 3);
    }
    const observations = {};
    for (const id of CHAIN_CHECK_IDS) {
      observations[OBSERVATION_FIELD_BY_CHECK[id]] = VARIANTS[id][plan[id]](random);
    }
    const trace = `seed=${PRNG_SEED} combination=${index} plan=${JSON.stringify(plan)}`;
    const result = diagnoseFeishuCommanderChain(observations, { now: FIXED_NOW });
    assertStructuralInvariants(result, trace);
    for (const check of result.checks) {
      assert.equal(check.status, plan[check.id], `${check.id} 判定与计划不一致：${trace}`);
      assert.equal(
        check.blocking,
        plan[check.id] === 'gap' && BLOCKING_CHECKS.includes(check.id),
        `${check.id} 的 blocking 与预期不一致：${trace}`,
      );
    }
    const expectedVerdict = Object.values(plan).some((status) => status === 'gap')
      ? 'blocking_gap'
      : (Object.values(plan).every((status) => status === 'pass') ? 'no_local_gap_found' : 'diagnosis_incomplete');
    assert.equal(result.verdict, expectedVerdict, `verdict 与计划不一致：${trace}`);
    combinations += 1;
  }
  assert.equal(combinations, 729);
});

test('3.2 属性：注入 secret 形态的观测值时输出恒不含原文（需求 2.11）', () => {
  const random = createSeededRandom(PRNG_SEED);
  const poisons = [
    'sk-live-0123456789abcdefghijklmnop',
    'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    'http://127.0.0.1:4321/api/feishu/commander?token=abcdef123456',
    'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5YWJjZGVmZ2hpamtsbW5vcA==',
    '密码=hunter2；Cookie: session=abc123',
  ];
  for (let index = 0; index < 20; index += 1) {
    const poison = poisons[Math.floor(random() * poisons.length) % poisons.length];
    const result = diagnoseFeishuCommanderChain(
      {
        ...healthyObservations(),
        // 观测适配层绝不会回显原值；即使被恶意注入，判定输出也不得把它带出去。
        requiredEnv: {
          status: 'observed',
          plistExists: true,
          variables: { [INGRESS_URL_ENV_KEY]: { present: true, classification: 'unparsable' } },
        },
        feishuAdmission: { status: 'observed', configured: true, entryCount: 1, hit: false, requesterRefDigest: 'sha256:aabbccddeeff' },
        profileGuard: { status: 'observed', agentId: 'xiaod', guardMarkerPresent: true },
      },
      { now: FIXED_NOW, recentEvidence: [] },
    );
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(poison), `seed=${PRNG_SEED} index=${index} 输出泄漏了注入值。`);
    assert.ok(!/sk-live|Bearer |\?token=|hunter2/.test(serialized), `seed=${PRNG_SEED} index=${index} 输出含 secret 形态。`);
  }
});

// mulberry32：固定种子伪随机，失败时随断言消息打印种子，保证反例可复现。
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

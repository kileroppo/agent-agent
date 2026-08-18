// 切片 A · 观测适配层单测（任务 3.3）
//
// 全部用注入替身，不触达真实 launchctl / PlistBuddy / ~/.hermes / 飞书。
// 夹具中的 launchctl 与 PlistBuddy 输出格式**来源为真机采样，未验证**（沙箱内无 macOS launchd）。
//
// 原生 node --test，不引入 Jest / Vitest / fast-check（需求 3.9）。
//
// **Validates: Requirements 2.1, 2.2, 2.3, 2.6, 2.7, 2.11, 2.12**

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  AGENT_ID_ENV_KEY,
  INGRESS_URL_ENV_KEY,
  LEGACY_AGENT_ID_ENV_KEY,
} from '../src/feishu-commander-chain-diagnosis.ts';
import {
  ADAPTER_RELATIVE_PATH,
  classifyIngressUrl,
  deriveProfileGuard,
  digestRef,
  observeFeishuCommanderChain,
  parseLaunchctlPrint,
  resolveHermesAgentRoot,
  scanAdmissionWhitelist,
  UNPRINTABLE_AGENT_ID,
} from '../src/feishu-commander-chain-observations.ts';

const PRNG_SEED = 20260818;
const HERMES_HOME = '/tmp/fixture-hermes-home';
const AGENT_ROOT = path.join(HERMES_HOME, 'hermes-agent');
const ADAPTER_PATH = path.join(AGENT_ROOT, ADAPTER_RELATIVE_PATH);
const PYPROJECT_PATH = path.join(AGENT_ROOT, 'pyproject.toml');
const CONFIG_PATH = path.join(HERMES_HOME, 'config.yaml');
const PLIST_PATH = '/tmp/fixture-LaunchAgents/ai.hermes.gateway.plist';

// 来源为真机采样，未验证：`launchctl print gui/501/ai.hermes.gateway` 的输出轮廓。
const LAUNCHCTL_PRINT_RUNNING = [
  'ai.hermes.gateway = {',
  '\tactive count = 1',
  '\tpath = /Users/example/Library/LaunchAgents/ai.hermes.gateway.plist',
  '\ttype = LaunchAgent',
  '\tstate = running',
  '\tprogram = /Users/example/.local/bin/hermes',
  '\targuments = {',
  '\t\tgateway',
  '\t\trun',
  '\t}',
  '\tdefault environment = {',
  '\t\tPATH => /usr/bin:/bin',
  '\t}',
  '\tpid = 43127',
  '\tforks = 0',
  '\texecs = 1',
  '\tlast exit status = 0',
  '}',
].join('\n');

// 来源为真机采样，未验证：已注册但当前没有存活进程。
const LAUNCHCTL_PRINT_NOT_RUNNING = [
  'ai.hermes.gateway = {',
  '\tactive count = 0',
  '\tstate = not running',
  '\tlast exit status = 78',
  '}',
].join('\n');

// 来源为真机采样，未验证：服务未加载时 launchctl 以非零退出并输出该文案。
const LAUNCHCTL_NOT_FOUND_STDERR = 'Could not find service "ai.hermes.gateway" in domain for login';

const ADAPTER_WITH_FULL_PATCH = [
  'class FeishuPlatform(Platform):',
  '    async def _route_ajun_commander_event(self, event: MessageEvent) -> bool:',
  '        ingress_url = os.getenv("AJUN_FEISHU_COMMANDER_INGRESS_URL", "").strip()',
  '        if not ingress_url or event.message_type != MessageType.TEXT:',
  '            return False',
  '        # AGENT_ARMY_FEISHU_COMMANDER_PROFILE_GUARD_V1: only AJun owns commander ingress.',
  '        # AJUN_COMMANDER_INGRESS_TIMEOUT_V1',
  '        # AGENT_ARMY_FEISHU_COMMANDER_DIRECT_REPLY_V1',
  '        # AGENT_ARMY_HERMES_FEISHU_ADAPTER_SEAM_V1',
  '        return True',
].join('\n');

const CONFIG_WITH_WHITELIST = [
  'display:',
  '  platforms:',
  '    feishu:',
  '      memory_notifications: false',
  'platforms:',
  '  feishu:',
  '    allowed_users:',
  '      - ou_realuser000000000000000000001',
  '      - ou_realuser000000000000000000002',
  '    app_secret: "should-never-be-echoed"',
].join('\n');

function makeDeps(overrides = {}) {
  const readCalls = [];
  const commandCalls = [];
  const files = {
    [ADAPTER_PATH]: ADAPTER_WITH_FULL_PATCH,
    [PYPROJECT_PATH]: 'name = "hermes"\nversion = "0.19.0"\n',
    [CONFIG_PATH]: CONFIG_WITH_WHITELIST,
    ...(overrides.files || {}),
  };
  const plistValues = {
    [INGRESS_URL_ENV_KEY]: 'http://127.0.0.1:4321/api/feishu/commander',
    [AGENT_ID_ENV_KEY]: 'ajun',
    ...(overrides.plistValues || {}),
  };
  const deps = {
    readCalls,
    commandCalls,
    runCommand: async (file, args) => {
      commandCalls.push({ file, args: [...args] });
      if (file === 'launchctl') {
        return overrides.launchctl
          ? overrides.launchctl(args)
          : { code: 0, stdout: LAUNCHCTL_PRINT_RUNNING, stderr: '' };
      }
      if (file === '/usr/libexec/PlistBuddy') {
        if (overrides.plistBuddy) return overrides.plistBuddy(args);
        const key = String(args[1] || '').replace('Print :EnvironmentVariables:', '');
        if (!Object.hasOwn(plistValues, key)) {
          return { code: 1, stdout: '', stderr: `Print: Entry, ":EnvironmentVariables:${key}", Does Not Exist` };
        }
        return { code: 0, stdout: `${plistValues[key]}\n`, stderr: '' };
      }
      throw new Error(`观测层不得执行其他命令：${file}`);
    },
    readTextFile: async (filePath) => {
      readCalls.push(filePath);
      if (overrides.readTextFile) return overrides.readTextFile(filePath);
      if (!Object.hasOwn(files, filePath)) {
        const error = new Error(`ENOENT: ${filePath}`);
        error.code = 'ENOENT';
        throw error;
      }
      return files[filePath];
    },
    statFile: async (filePath) => (overrides.statFile
      ? overrides.statFile(filePath)
      : (filePath === PLIST_PATH ? { mode: 0o644 } : null)),
    probe: {
      checkOne: async (targetId) => (overrides.probe
        ? overrides.probe(targetId)
        : {
          schemaVersion: 'agent.army/local-health-observation/v1',
          id: targetId,
          status: 'healthy',
          evidence: { httpStatus: 200, contractSatisfied: true },
        }),
    },
    fingerprint: async () => (overrides.fingerprint ? overrides.fingerprint() : {
      schemaVersion: 'agent.army/runtime-fingerprint/v1',
      live: {
        sourceRelationship: 'same_git_head',
        services: {
          ajun: { pid: 1234, cwd: '/opt/release/apps/ajun-runtime', runtime: { status: 'immutable_release', releaseHash: 'a'.repeat(64) } },
        },
      },
    }),
    isPortListening: async (port) => (overrides.isPortListening ? overrides.isPortListening(port) : false),
    uid: 501,
    hermesHome: HERMES_HOME,
    gatewayPlistPath: PLIST_PATH,
    expectedHermesVersion: '0.19.0',
    ...(overrides.deps || {}),
  };
  return deps;
}

// --- 路径解析与白名单 ---

test('3.3 hermesAgentRoot 解析：HERMES_HOME 指向 Profile Home 时补上 hermes-agent 后缀', () => {
  assert.equal(resolveHermesAgentRoot('/Users/x/.hermes'), '/Users/x/.hermes/hermes-agent');
  assert.equal(resolveHermesAgentRoot('/Users/x/.hermes/hermes-agent'), '/Users/x/.hermes/hermes-agent');
  assert.equal(resolveHermesAgentRoot('/Users/x/.hermes', '/custom/root'), '/custom/root');
});

test('3.3 只读三个白名单路径，且任何情况下都不读 .env（需求 2.11）', async () => {
  const deps = makeDeps();
  await observeFeishuCommanderChain(deps);
  assert.deepEqual([...deps.readCalls].sort(), [ADAPTER_PATH, CONFIG_PATH, PYPROJECT_PATH].sort());
  for (const filePath of deps.readCalls) {
    assert.ok(!filePath.includes('.env'), `观测层读取了 .env：${filePath}`);
  }
  // 环境变量只读三项白名单键。
  const plistKeys = deps.commandCalls
    .filter((call) => call.file === '/usr/libexec/PlistBuddy')
    .map((call) => String(call.args[1]).replace('Print :EnvironmentVariables:', ''));
  assert.deepEqual(plistKeys, [INGRESS_URL_ENV_KEY, AGENT_ID_ENV_KEY, LEGACY_AGENT_ID_ENV_KEY]);
});

test('3.3 adapter.py 与 config.yaml 的原文不进入返回值（只返回布尔、计数与枚举）', async () => {
  const observations = await observeFeishuCommanderChain(makeDeps());
  const serialized = JSON.stringify(observations);
  assert.ok(!serialized.includes('_route_ajun_commander_event'), '返回值泄漏了 adapter.py 原文。');
  assert.ok(!serialized.includes('ou_realuser'), '返回值泄漏了 config.yaml 的白名单原文。');
  assert.ok(!serialized.includes('should-never-be-echoed'), '返回值泄漏了 config.yaml 的敏感字段。');
  assert.ok(!serialized.includes('http://127.0.0.1:4321/api/feishu/commander'), '返回值回显了环境变量原值。');
});

// --- ① launchctl ---

test('3.3 launchctl print 解析真机采样格式（running / not running）', () => {
  assert.deepEqual(parseLaunchctlPrint(LAUNCHCTL_PRINT_RUNNING), { pid: 43127, state: 'running', lastExitStatus: 0 });
  assert.deepEqual(parseLaunchctlPrint(LAUNCHCTL_PRINT_NOT_RUNNING), { pid: null, state: 'not running', lastExitStatus: 78 });
  assert.deepEqual(parseLaunchctlPrint(''), { pid: null, state: null, lastExitStatus: null });
});

test('3.3 launchctl 未找到服务时报 observed+loaded:false；命令不可用时报 unknown 且不抛异常', async () => {
  const notFound = await observeFeishuCommanderChain(makeDeps({
    launchctl: () => ({ code: 113, stdout: '', stderr: LAUNCHCTL_NOT_FOUND_STDERR }),
  }));
  assert.equal(notFound.gatewayProcess.status, 'observed');
  assert.equal(notFound.gatewayProcess.loaded, false);
  assert.equal(notFound.gatewayProcess.pid, null);

  const unavailable = await observeFeishuCommanderChain(makeDeps({
    launchctl: () => { throw new Error('spawn launchctl ENOENT'); },
  }));
  assert.equal(unavailable.gatewayProcess.status, 'unknown');
  assert.equal(unavailable.gatewayProcess.errorCode, 'launchctl_unavailable');

  const otherFailure = await observeFeishuCommanderChain(makeDeps({
    launchctl: () => ({ code: 5, stdout: '', stderr: 'Bad request' }),
  }));
  assert.equal(otherFailure.gatewayProcess.status, 'unknown');
  assert.equal(otherFailure.gatewayProcess.errorCode, 'launchctl_exit_5');
});

// --- ② adapter.py ---

test('3.3 adapter.py 标记扫描与重复定义计数（Python 只生效最后一个定义）', async () => {
  const full = await observeFeishuCommanderChain(makeDeps());
  assert.equal(full.adapterPatch.status, 'observed');
  assert.equal(full.adapterPatch.exists, true);
  assert.equal(full.adapterPatch.hasCommanderRoute, true);
  assert.equal(full.adapterPatch.duplicateRouteDefinitions, 1);
  assert.deepEqual(full.adapterPatch.markers, {
    PROFILE_GUARD_V1: true,
    INGRESS_TIMEOUT_V1: true,
    DIRECT_REPLY_V1: true,
    ADAPTER_SEAM_V1: true,
    SILENT_FAILURE_EVIDENCE_V1: false,
  });
  assert.equal(full.adapterPatch.hermesVersion, '0.19.0');
  assert.equal(full.adapterPatch.hermesVersionMatchesBaseline, true);

  const duplicated = await observeFeishuCommanderChain(makeDeps({
    files: { [ADAPTER_PATH]: `${ADAPTER_WITH_FULL_PATCH}\n${ADAPTER_WITH_FULL_PATCH}` },
  }));
  assert.equal(duplicated.adapterPatch.duplicateRouteDefinitions, 2);

  const withoutRoute = await observeFeishuCommanderChain(makeDeps({
    files: { [ADAPTER_PATH]: 'class FeishuPlatform(Platform):\n    pass\n' },
  }));
  assert.equal(withoutRoute.adapterPatch.exists, true);
  assert.equal(withoutRoute.adapterPatch.hasCommanderRoute, false);
  assert.equal(withoutRoute.adapterPatch.duplicateRouteDefinitions, 0);
});

test('3.3 adapter.py 不存在报 observed+exists:false；读取失败报 unknown（都不抛异常）', async () => {
  const absent = await observeFeishuCommanderChain(makeDeps({
    readTextFile: (filePath) => {
      const error = new Error(`ENOENT: ${filePath}`);
      error.code = 'ENOENT';
      throw error;
    },
  }));
  assert.equal(absent.adapterPatch.status, 'observed');
  assert.equal(absent.adapterPatch.exists, false);
  assert.equal(absent.feishuAdmission.errorCode, 'config_absent');

  const unreadable = await observeFeishuCommanderChain(makeDeps({
    readTextFile: () => {
      const error = new Error('EACCES');
      error.code = 'EACCES';
      throw error;
    },
  }));
  assert.equal(unreadable.adapterPatch.status, 'unknown');
  assert.equal(unreadable.adapterPatch.errorCode, 'adapter_unreadable');
  assert.equal(unreadable.feishuAdmission.status, 'unknown');
  assert.equal(unreadable.feishuAdmission.errorCode, 'config_unreadable');
});

test('3.3 Hermes 版本不匹配只报观测事实，不抛异常（只读诊断不得失败关闭）', async () => {
  const mismatched = await observeFeishuCommanderChain(makeDeps({
    files: { [PYPROJECT_PATH]: 'version = "0.20.1"\n' },
  }));
  assert.equal(mismatched.adapterPatch.status, 'observed');
  assert.equal(mismatched.adapterPatch.hermesVersion, '0.20.1');
  assert.equal(mismatched.adapterPatch.hermesVersionMatchesBaseline, false);

  const missingPyproject = await observeFeishuCommanderChain(makeDeps({
    readTextFile: (filePath) => {
      if (filePath === ADAPTER_PATH) return ADAPTER_WITH_FULL_PATCH;
      if (filePath === CONFIG_PATH) return CONFIG_WITH_WHITELIST;
      const error = new Error(`ENOENT: ${filePath}`);
      error.code = 'ENOENT';
      throw error;
    },
  }));
  assert.equal(missingPyproject.adapterPatch.hermesVersion, null);
  assert.equal(missingPyproject.adapterPatch.hermesVersionMatchesBaseline, null);
});

// --- ③ 环境变量与 classifyIngressUrl ---

test('3.3 classifyIngressUrl 五类分支，且绝不回显原值', () => {
  assert.equal(classifyIngressUrl('http://127.0.0.1:4321/api/feishu/commander'), 'expected_loopback');
  assert.equal(classifyIngressUrl(' http://127.0.0.1:4399/api/feishu/commander '), 'expected_loopback');
  assert.equal(classifyIngressUrl('http://192.168.1.20:4321/api/feishu/commander'), 'non_loopback');
  assert.equal(classifyIngressUrl('https://127.0.0.1:4321/api/feishu/commander'), 'non_loopback');
  assert.equal(classifyIngressUrl('http://localhost:4321/api/feishu/commander'), 'non_loopback');
  assert.equal(classifyIngressUrl('http://127.0.0.1:4321/api/feishu/agent-proposal'), 'unexpected_path');
  assert.equal(classifyIngressUrl('http://127.0.0.1:4321/api/feishu/commander?token=abc'), 'unexpected_path');
  assert.equal(classifyIngressUrl('http://127.0.0.1/api/feishu/commander'), 'unparsable');
  assert.equal(classifyIngressUrl('not a url'), 'unparsable');
  assert.equal(classifyIngressUrl(''), 'absent');
  assert.equal(classifyIngressUrl(null), 'absent');
  assert.equal(classifyIngressUrl(undefined), 'absent');
  assert.equal(classifyIngressUrl(12345), 'absent');
  // 返回值只有枚举，天然不可能带出原值。
  for (const value of ['http://127.0.0.1:4321/api/feishu/commander?token=secret', 'sk-live-123456']) {
    assert.ok(!classifyIngressUrl(value).includes(value));
  }
});

test('3.3 plist 缺失时判为「变量未配置」；PlistBuddy 不可用时报 unknown', async () => {
  const noPlist = await observeFeishuCommanderChain(makeDeps({ statFile: () => null }));
  assert.equal(noPlist.requiredEnv.status, 'observed');
  assert.equal(noPlist.requiredEnv.plistExists, false);
  assert.equal(noPlist.requiredEnv.variables[INGRESS_URL_ENV_KEY].present, false);
  assert.equal(noPlist.profileGuard.status, 'observed');
  assert.equal(noPlist.profileGuard.agentId, null);

  const broken = await observeFeishuCommanderChain(makeDeps({
    plistBuddy: () => { throw new Error('spawn PlistBuddy ENOENT'); },
  }));
  assert.equal(broken.requiredEnv.status, 'unknown');
  assert.equal(broken.requiredEnv.errorCode, 'plistbuddy_unavailable');
  assert.equal(broken.profileGuard.status, 'unknown');

  const denied = await observeFeishuCommanderChain(makeDeps({
    plistBuddy: () => ({ code: 1, stdout: '', stderr: 'Unexpected Character at line 1' }),
  }));
  assert.equal(denied.requiredEnv.status, 'unknown');
});

test('3.3 环境变量观测只输出分类与归一化 Agent 标识', async () => {
  const observations = await observeFeishuCommanderChain(makeDeps({
    plistValues: {
      [INGRESS_URL_ENV_KEY]: 'http://10.0.0.5:4321/api/feishu/commander',
      [AGENT_ID_ENV_KEY]: ' xiaod\n',
    },
  }));
  const variables = observations.requiredEnv.variables;
  assert.equal(variables[INGRESS_URL_ENV_KEY].present, true);
  assert.equal(variables[INGRESS_URL_ENV_KEY].classification, 'non_loopback');
  assert.equal(Object.hasOwn(variables[INGRESS_URL_ENV_KEY], 'value'), false);
  assert.equal(variables[AGENT_ID_ENV_KEY].agentId, 'xiaod');
  assert.equal(variables[LEGACY_AGENT_ID_ENV_KEY].present, false);
  assert.equal(observations.profileGuard.agentId, 'xiaod');
  assert.equal(observations.profileGuard.source, AGENT_ID_ENV_KEY);
});

// --- ⑤ profile guard 派生 ---

test('3.3 deriveProfileGuard：空值回退、旧变量兼容、标记缺失', () => {
  const adapterObserved = { status: 'observed', exists: true, hasCommanderRoute: true, duplicateRouteDefinitions: 1, markers: { PROFILE_GUARD_V1: true } };
  const env = (variables) => ({ status: 'observed', plistExists: true, variables });

  const fallback = deriveProfileGuard(env({ [AGENT_ID_ENV_KEY]: { present: true, agentId: null } }), adapterObserved);
  assert.equal(fallback.agentId, null);
  assert.equal(fallback.source, 'default_fallback');
  assert.equal(fallback.guardMarkerPresent, true);

  const legacy = deriveProfileGuard(env({
    [AGENT_ID_ENV_KEY]: { present: false },
    [LEGACY_AGENT_ID_ENV_KEY]: { present: true, agentId: 'ajun' },
  }), adapterObserved);
  assert.equal(legacy.agentId, 'ajun');
  assert.equal(legacy.source, LEGACY_AGENT_ID_ENV_KEY);

  const markerMissing = deriveProfileGuard(
    env({ [AGENT_ID_ENV_KEY]: { present: true, agentId: 'ajun' } }),
    { status: 'observed', exists: true, hasCommanderRoute: false, duplicateRouteDefinitions: 0, markers: {} },
  );
  assert.equal(markerMissing.guardMarkerPresent, false);

  const adapterUnknown = deriveProfileGuard(
    env({ [AGENT_ID_ENV_KEY]: { present: true, agentId: 'ajun' } }),
    { status: 'unknown', exists: false, hasCommanderRoute: false, duplicateRouteDefinitions: 0, markers: {} },
  );
  assert.equal(adapterUnknown.guardMarkerPresent, null);

  const envUnknown = deriveProfileGuard(
    { status: 'unknown', variables: {}, errorCode: 'plistbuddy_unavailable' }, adapterObserved,
  );
  assert.equal(envUnknown.status, 'unknown');
  assert.equal(envUnknown.errorCode, 'plistbuddy_unavailable');
});

// --- ④ 4321 可达性 ---

test('3.3 4321 观测复用健康探针与 fingerprint；探针失败时报 unknown', async () => {
  const healthy = await observeFeishuCommanderChain(makeDeps());
  assert.equal(healthy.runtimeIngress.status, 'observed');
  assert.equal(healthy.runtimeIngress.reachable, true);
  assert.equal(healthy.runtimeIngress.httpStatus, 200);
  assert.equal(healthy.runtimeIngress.listenerPid, 1234);
  assert.equal(healthy.runtimeIngress.releaseStatus, 'immutable_release');
  assert.equal(healthy.runtimeIngress.releaseHashDigest, `sha256:${'a'.repeat(12)}`);
  assert.equal(healthy.runtimeIngress.sourceRelationship, 'same_git_head');
  assert.equal(healthy.runtimeIngress.devPortListening, false);

  const degraded = await observeFeishuCommanderChain(makeDeps({
    probe: () => ({ status: 'degraded', evidence: { httpStatus: null, errorCode: 'health_unreachable' } }),
    isPortListening: (port) => port === 4322,
  }));
  assert.equal(degraded.runtimeIngress.reachable, false);
  assert.equal(degraded.runtimeIngress.errorCode, 'health_unreachable');
  assert.equal(degraded.runtimeIngress.devPortListening, true);

  const probeThrows = await observeFeishuCommanderChain(makeDeps({
    probe: () => { throw new Error('probe boom'); },
  }));
  assert.equal(probeThrows.runtimeIngress.status, 'unknown');
  assert.equal(probeThrows.runtimeIngress.errorCode, 'probe_failed');

  // fingerprint 抛异常不得影响其余观测。
  const fingerprintThrows = await observeFeishuCommanderChain(makeDeps({
    fingerprint: () => { throw new Error('git missing'); },
  }));
  assert.equal(fingerprintThrows.runtimeIngress.status, 'observed');
  assert.equal(fingerprintThrows.runtimeIngress.releaseStatus, null);
  assert.equal(fingerprintThrows.runtimeIngress.listenerPid, null);
});

// --- ⑥ 白名单扫描 ---

test('3.3 白名单扫描：列表、内联数组、字段找不到', () => {
  assert.deepEqual(scanAdmissionWhitelist(CONFIG_WITH_WHITELIST), {
    fieldPath: 'allowed_users',
    entries: ['ou_realuser000000000000000000001', 'ou_realuser000000000000000000002'],
  });
  assert.deepEqual(scanAdmissionWhitelist('feishu:\n  allowlist: ["ou_a", \'ou_b\']\n'), {
    fieldPath: 'allowlist', entries: ['ou_a', 'ou_b'],
  });
  assert.deepEqual(scanAdmissionWhitelist('model: stepfun\n'), { fieldPath: null, entries: [] });
  assert.deepEqual(scanAdmissionWhitelist(''), { fieldPath: null, entries: [] });
});

test('3.3 准入观测：命中 / 未命中 / 未指定发送者 / 字段找不到（需求 2.7）', async () => {
  const hit = await observeFeishuCommanderChain(makeDeps({
    deps: { requesterRef: 'ou_realuser000000000000000000002' },
  }));
  assert.equal(hit.feishuAdmission.status, 'observed');
  assert.equal(hit.feishuAdmission.configured, true);
  assert.equal(hit.feishuAdmission.entryCount, 2);
  assert.equal(hit.feishuAdmission.hit, true);
  assert.equal(hit.feishuAdmission.requesterRefDigest, digestRef('ou_realuser000000000000000000002'));
  assert.match(hit.feishuAdmission.requesterRefDigest, /^sha256:[0-9a-f]{12}$/);

  const missed = await observeFeishuCommanderChain(makeDeps({ deps: { requesterRef: 'ou_someone_else' } }));
  assert.equal(missed.feishuAdmission.hit, false);

  const noRequester = await observeFeishuCommanderChain(makeDeps());
  assert.equal(noRequester.feishuAdmission.hit, null);
  assert.equal(noRequester.feishuAdmission.requesterRefDigest, null);

  const fieldMissing = await observeFeishuCommanderChain(makeDeps({
    files: { [CONFIG_PATH]: 'model: stepfun\napi_key: sk-live-should-never-appear\n' },
    deps: { requesterRef: 'ou_realuser000000000000000000002' },
  }));
  assert.equal(fieldMissing.feishuAdmission.configured, false);
  assert.equal(fieldMissing.feishuAdmission.errorCode, 'admission_field_not_found');
  assert.equal(Object.hasOwn(fieldMissing.feishuAdmission, 'hit'), false);
});

// --- 属性测试：随机注入 secret 形态，输出恒不含原文 ---

test('3.3 属性：随机 secret 形态注入 plist 与 config.yaml，观测输出恒不含原文（需求 2.11）', async () => {
  const random = createSeededRandom(PRNG_SEED);
  const poisons = [
    'sk-live-0123456789abcdefghijklmnopqrstuvwxyz',
    'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdefghijklmnop',
    'http://127.0.0.1:4321/api/feishu/commander?token=abcdef1234567890',
    'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5YWJjZGVmZ2hpamtsbW5vcA==',
    `${'长'.repeat(500)}\u0000\u001b[31m`,
    'Cookie: session=abc123; password=hunter2',
  ];
  for (let index = 0; index < poisons.length * 3; index += 1) {
    const poison = poisons[Math.floor(random() * poisons.length) % poisons.length];
    const observations = await observeFeishuCommanderChain(makeDeps({
      plistValues: { [INGRESS_URL_ENV_KEY]: poison, [AGENT_ID_ENV_KEY]: poison },
      files: {
        [ADAPTER_PATH]: `${ADAPTER_WITH_FULL_PATCH}\n# ${poison}\n`,
        [PYPROJECT_PATH]: `version = "0.19.0"\napi_key = "${poison}"\n`,
        [CONFIG_PATH]: `platforms:\n  feishu:\n    app_secret: "${poison}"\n    allowed_users:\n      - ${poison}\n`,
      },
      deps: { requesterRef: poison },
      launchctl: () => ({ code: 0, stdout: `${LAUNCHCTL_PRINT_RUNNING}\n\tsecret = ${poison}`, stderr: '' }),
    }));
    const serialized = JSON.stringify(observations);
    const trace = `seed=${PRNG_SEED} index=${index} poison=${poison.slice(0, 24)}`;
    assert.ok(!serialized.includes(poison), `观测输出泄漏了注入值：${trace}`);
    assert.ok(!/sk-live|Bearer |\?token=|hunter2|session=/.test(serialized), `观测输出含 secret 形态：${trace}`);
    // 合法 Agent 标识只可能是短 slug；secret 形态与畸形值一律替换为占位符。
    const agentId = observations.requiredEnv.variables[AGENT_ID_ENV_KEY].agentId;
    assert.equal(agentId, UNPRINTABLE_AGENT_ID, `secret 形态的 Agent 标识必须被占位符替换：${trace}`);
    assert.match(observations.feishuAdmission.requesterRefDigest, /^sha256:[0-9a-f]{12}$/, trace);
  }
});

test('3.3 digestRef 稳定且不可逆', () => {
  assert.equal(digestRef('ou_abc'), digestRef('ou_abc'));
  assert.notEqual(digestRef('ou_abc'), digestRef('ou_abd'));
  assert.equal(digestRef(''), null);
  assert.equal(digestRef(null), null);
  assert.ok(!digestRef('ou_abc').includes('ou_abc'));
});

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

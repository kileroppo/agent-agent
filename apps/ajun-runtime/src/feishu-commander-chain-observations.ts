// 飞书军团总管链路诊断 · 本机观测适配层
//
// 全部依赖注入：命令执行、文件读取、健康探针、fingerprint 都由调用方（CLI）传入，
// 因此生产源码不直接依赖 ops/ 与仓库根 scripts/，沙箱内用替身即可全覆盖。
//
// 硬性约束：
// - 只读。不写文件、不启动服务、不产生任何外部副作用。
// - 只读三个白名单路径（adapter.py / pyproject.toml / config.yaml）与三项白名单环境变量键。
// - **绝不读取 .env**，绝不回显环境变量原值、config.yaml 原文或 adapter.py 原文。
// - 任何观测失败都返回 status:'unknown' + 错误码，绝不抛异常（只读诊断不得失败关闭）。

import net from 'node:net';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  AGENT_ID_ENV_KEY,
  GATEWAY_LAUNCHD_LABEL,
  INGRESS_URL_ENV_KEY,
  LEGACY_AGENT_ID_ENV_KEY,
} from './feishu-commander-chain-diagnosis.ts';
import type {
  AdapterPatchObservation,
  ChainObservations,
  EnvVariableObservation,
  FeishuAdmissionObservation,
  GatewayProcessObservation,
  IngressUrlClassification,
  ProfileGuardObservation,
  RequiredEnvObservation,
  RuntimeIngressObservation,
} from './feishu-commander-chain-diagnosis.ts';

export const ADAPTER_RELATIVE_PATH = path.join('plugins', 'platforms', 'feishu', 'adapter.py');
export const READABLE_ENV_KEYS = Object.freeze([
  INGRESS_URL_ENV_KEY, AGENT_ID_ENV_KEY, LEGACY_AGENT_ID_ENV_KEY,
] as const);

// adapter.py 内需要扫描的幂等标记（值为仓库补丁脚本注入的标记名片段）。
const ADAPTER_MARKERS = Object.freeze({
  PROFILE_GUARD_V1: 'AGENT_ARMY_FEISHU_COMMANDER_PROFILE_GUARD_V1',
  INGRESS_TIMEOUT_V1: 'AJUN_COMMANDER_INGRESS_TIMEOUT_V1',
  DIRECT_REPLY_V1: 'AGENT_ARMY_FEISHU_COMMANDER_DIRECT_REPLY_V1',
  ADAPTER_SEAM_V1: 'AGENT_ARMY_HERMES_FEISHU_ADAPTER_SEAM_V1',
  SILENT_FAILURE_EVIDENCE_V1: 'AGENT_ARMY_FEISHU_COMMANDER_SILENT_FAILURE_EVIDENCE_V1',
});

const COMMANDER_ROUTE_DEFINITION = 'def _route_ajun_commander_event(';

// 飞书用户准入白名单的候选字段名。**来源为仓库文档表述（「飞书用户准入默认白名单」），
// 真实 config.yaml 的字段名未在真机验证**；一个都匹配不上时必须报 unknown，不得猜。
const ADMISSION_FIELD_CANDIDATES = Object.freeze([
  'allowed_users', 'allowed_user_ids', 'allowed_open_ids', 'allow_users',
  'user_whitelist', 'allowlist', 'allow_list',
] as const);

export type CommandResult = Readonly<{ code: number; stdout: string; stderr: string }>;
export type CommandRunner = (file: string, args: readonly string[]) => Promise<CommandResult>;

export type ChainObservationDeps = Readonly<{
  runCommand: CommandRunner;
  readTextFile: (filePath: string) => Promise<string>;
  statFile: (filePath: string) => Promise<Readonly<{ mode: number }> | null>;
  probe: Readonly<{ checkOne(targetId: string): Promise<unknown> }>;
  fingerprint: () => Promise<unknown>;
  uid: number;
  hermesHome: string;
  hermesAgentRoot?: string;
  gatewayLabel?: string;
  gatewayPlistPath?: string;
  requesterRef?: string | null;
  devPort?: number;
  isPortListening?: (port: number) => Promise<boolean>;
  expectedHermesVersion?: string | null;
  expectedIngressPath?: string;
}>;

export function digestRef(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  return `sha256:${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
}

// URL 只在匹配预期本机总管入口时归一化输出，否则只输出分类枚举，绝不回显原值。
export function classifyIngressUrl(
  value: unknown,
  expectedPath = '/api/feishu/commander',
): IngressUrlClassification {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return 'absent';
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return 'unparsable';
  }
  if (url.protocol !== 'http:') return 'non_loopback';
  if (url.hostname !== '127.0.0.1') return 'non_loopback';
  if (!/^\d{2,5}$/.test(url.port)) return 'unparsable';
  if (url.pathname !== expectedPath || url.search || url.hash) return 'unexpected_path';
  return 'expected_loopback';
}

export function resolveHermesAgentRoot(hermesHome: string, hermesAgentRoot?: string): string {
  const explicit = String(hermesAgentRoot || '').trim();
  if (explicit) return explicit;
  const home = String(hermesHome || '').trim();
  return path.basename(home) === 'hermes-agent' ? home : path.join(home, 'hermes-agent');
}

export async function observeFeishuCommanderChain(deps: ChainObservationDeps): Promise<ChainObservations> {
  const label = String(deps.gatewayLabel || '').trim() || GATEWAY_LAUNCHD_LABEL;
  const agentRoot = resolveHermesAgentRoot(deps.hermesHome, deps.hermesAgentRoot);
  const plistPath = String(deps.gatewayPlistPath || '').trim();
  const expectedIngressPath = String(deps.expectedIngressPath || '').trim() || '/api/feishu/commander';
  const allowedReadPaths = Object.freeze([
    path.join(agentRoot, ADAPTER_RELATIVE_PATH),
    path.join(agentRoot, 'pyproject.toml'),
    path.join(String(deps.hermesHome || '').trim(), 'config.yaml'),
  ]);
  const readAllowed = async (filePath: string): Promise<string> => {
    if (!allowedReadPaths.includes(filePath)) {
      throw new Error('链路诊断只读白名单路径，拒绝读取其他文件。');
    }
    return deps.readTextFile(filePath);
  };

  const [gatewayProcess, adapterPatch, requiredEnv, runtimeIngress, feishuAdmission] = await Promise.all([
    observeGatewayProcess(deps.runCommand, deps.uid, label),
    observeAdapterPatch(readAllowed, allowedReadPaths[0]!, allowedReadPaths[1]!, deps.expectedHermesVersion),
    observeRequiredEnv(deps, label, plistPath, expectedIngressPath),
    observeRuntimeIngress(deps),
    observeFeishuAdmission(readAllowed, allowedReadPaths[2]!, deps.requesterRef),
  ]);
  return Object.freeze({
    gatewayProcess,
    adapterPatch,
    requiredEnv,
    runtimeIngress,
    profileGuard: deriveProfileGuard(requiredEnv, adapterPatch),
    feishuAdmission,
  });
}

// --- ① launchctl print 解析（真实输出格式为真机采样，沙箱内未验证） ---

export function parseLaunchctlPrint(output: string): Readonly<{
  pid: number | null; state: string | null; lastExitStatus: number | null;
}> {
  const text = String(output || '');
  const pid = Number.parseInt(text.match(/^\s*pid\s*=\s*(\d+)\s*$/m)?.[1] || '', 10);
  const lastExit = Number.parseInt(text.match(/^\s*last exit (?:status|code)\s*=\s*(-?\d+)\s*$/m)?.[1] || '', 10);
  return Object.freeze({
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    state: text.match(/^\s*state\s*=\s*(.+?)\s*$/m)?.[1] || null,
    lastExitStatus: Number.isInteger(lastExit) ? lastExit : null,
  });
}

async function observeGatewayProcess(
  runCommand: CommandRunner, uid: number, label: string,
): Promise<GatewayProcessObservation> {
  const domain = `gui/${Number.isInteger(uid) ? uid : 0}`;
  try {
    const result = await runCommand('launchctl', ['print', `${domain}/${label}`]);
    if (result.code !== 0) {
      const combined = `${result.stdout}\n${result.stderr}`;
      if (/could not find service|no such process|service is not loaded/i.test(combined)) {
        return Object.freeze({ status: 'observed', loaded: false, pid: null, label, state: null, lastExitStatus: null });
      }
      return Object.freeze({
        status: 'unknown', loaded: false, pid: null, label, errorCode: `launchctl_exit_${result.code}`,
      });
    }
    const parsed = parseLaunchctlPrint(result.stdout);
    return Object.freeze({
      status: 'observed',
      loaded: true,
      pid: parsed.pid,
      label,
      state: parsed.state,
      lastExitStatus: parsed.lastExitStatus,
    });
  } catch {
    return Object.freeze({ status: 'unknown', loaded: false, pid: null, label, errorCode: 'launchctl_unavailable' });
  }
}

// --- ② adapter.py 标记扫描与重复定义计数（只返回布尔与计数，不返回原文） ---

async function observeAdapterPatch(
  readTextFile: (filePath: string) => Promise<string>,
  adapterPath: string,
  pyprojectPath: string,
  expectedHermesVersion: string | null | undefined,
): Promise<AdapterPatchObservation> {
  let source: string;
  try {
    source = await readTextFile(adapterPath);
  } catch (error) {
    if ((error as { code?: string } | null)?.code === 'ENOENT') {
      return Object.freeze({
        status: 'observed', exists: false, hasCommanderRoute: false, duplicateRouteDefinitions: 0,
        markers: Object.freeze({}), hermesVersion: null, hermesVersionMatchesBaseline: null,
      });
    }
    return Object.freeze({
      status: 'unknown', exists: false, hasCommanderRoute: false, duplicateRouteDefinitions: 0,
      markers: Object.freeze({}), errorCode: 'adapter_unreadable',
    });
  }
  const markerEntries = Object.entries(ADAPTER_MARKERS)
    .map(([name, marker]) => [name, source.includes(marker)] as [string, boolean]);
  // Python 只生效最后一个同名定义，重复定义必须报为风险。
  const duplicateRouteDefinitions = source.split(COMMANDER_ROUTE_DEFINITION).length - 1;
  // 版本不匹配只作为观测事实输出，绝不抛异常（只读诊断不得失败关闭）。
  const hermesVersion = await readHermesVersion(readTextFile, pyprojectPath);
  const expected = String(expectedHermesVersion || '').trim();
  return Object.freeze({
    status: 'observed',
    exists: true,
    hasCommanderRoute: duplicateRouteDefinitions > 0,
    duplicateRouteDefinitions,
    markers: Object.freeze(Object.fromEntries(markerEntries)),
    hermesVersion,
    hermesVersionMatchesBaseline: expected && hermesVersion ? hermesVersion === expected : null,
  });
}

async function readHermesVersion(
  readTextFile: (filePath: string) => Promise<string>, pyprojectPath: string,
): Promise<string | null> {
  try {
    const pyproject = await readTextFile(pyprojectPath);
    return pyproject.match(/^version\s*=\s*["']([^"']+)["']/m)?.[1] || null;
  } catch {
    return null;
  }
}

// --- ③ launchd 环境变量（仅三项白名单键；绝不读 .env，绝不回显 URL 原值） ---

async function observeRequiredEnv(
  deps: ChainObservationDeps, label: string, plistPath: string, expectedIngressPath: string,
): Promise<RequiredEnvObservation> {
  if (!plistPath) {
    return Object.freeze({ status: 'unknown', variables: Object.freeze({}), errorCode: 'plist_path_unknown' });
  }
  let plistExists = false;
  try {
    plistExists = Boolean(await deps.statFile(plistPath));
  } catch {
    return Object.freeze({ status: 'unknown', variables: Object.freeze({}), errorCode: 'plist_stat_failed' });
  }
  if (!plistExists) {
    // plist 不存在是可判定事实：launchd 未安装该 Gateway ⇒ 变量未配置。
    return Object.freeze({
      status: 'observed',
      plistExists: false,
      variables: Object.freeze(Object.fromEntries(READABLE_ENV_KEYS.map(
        (key) => [key, Object.freeze({ present: false })] as [string, EnvVariableObservation],
      ))),
    });
  }
  const entries: [string, EnvVariableObservation][] = [];
  for (const key of READABLE_ENV_KEYS) {
    let raw: string | null;
    try {
      raw = await readPlistValue(deps.runCommand, plistPath, `:EnvironmentVariables:${key}`);
    } catch {
      return Object.freeze({
        status: 'unknown', plistExists: true, variables: Object.freeze({}), errorCode: 'plistbuddy_unavailable',
      });
    }
    if (key === INGRESS_URL_ENV_KEY) {
      const classification = classifyIngressUrl(raw, expectedIngressPath);
      entries.push([key, Object.freeze({ present: classification !== 'absent', classification })]);
      continue;
    }
    entries.push([key, Object.freeze({ present: raw !== null && raw.trim() !== '', agentId: sanitizeAgentId(raw) })]);
  }
  return Object.freeze({
    status: 'observed', plistExists: true, variables: Object.freeze(Object.fromEntries(entries)),
  });
}

// PlistBuddy 缺键时以非零退出并输出「Does Not Exist」（真机采样格式，沙箱内未验证）。
async function readPlistValue(
  runCommand: CommandRunner, plistPath: string, key: string,
): Promise<string | null> {
  const result = await runCommand('/usr/libexec/PlistBuddy', ['-c', `Print ${key}`, plistPath]);
  if (result.code === 0) return result.stdout.trim();
  const combined = `${result.stdout}\n${result.stderr}`;
  if (/does not exist/i.test(combined)) return null;
  throw new Error('PlistBuddy 读取失败。');
}

// 合法 Agent 标识只可能是短 slug（ajun / xiaod / intel-researcher / 小D）。
const SAFE_AGENT_ID = /^[\p{L}\p{N}_.:\- ]{1,40}$/u;
const SECRET_SHAPED = /(sk-|bearer\s|\?token=|token\s*=|password|passwd|secret|cookie|session\s*=|authorization)/i;
export const UNPRINTABLE_AGENT_ID = 'unprintable_value';

// 需求 2.2 要求输出实际 Agent 标识；但需求 2.11 要求输出零凭据。
// 因此只回显「像 Agent 标识」的短 slug，其余（含 secret 形态）一律以占位符替代。
function sanitizeAgentId(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  if (!SAFE_AGENT_ID.test(text) || SECRET_SHAPED.test(text)) return UNPRINTABLE_AGENT_ID;
  return text;
}

// --- ⑤ Profile guard：由环境变量有效取值 + adapter 标记联合派生 ---

export function deriveProfileGuard(
  requiredEnv: RequiredEnvObservation, adapterPatch: AdapterPatchObservation,
): ProfileGuardObservation {
  const guardMarkerPresent = adapterPatch.status === 'observed'
    ? adapterPatch.markers?.PROFILE_GUARD_V1 === true
    : null;
  if (requiredEnv.status !== 'observed') {
    return Object.freeze({
      status: 'unknown', agentId: null, source: null, guardMarkerPresent, errorCode: requiredEnv.errorCode ?? null,
    });
  }
  // 实测：Hermes 侧 `(os.getenv(A,"") or os.getenv(B,"") or "ajun").strip()`，
  // 因此空串与未配置都会回退到 ajun —— 这是正常状态，不是缺口。
  const primary = requiredEnv.variables[AGENT_ID_ENV_KEY]?.agentId?.trim() || '';
  const legacy = requiredEnv.variables[LEGACY_AGENT_ID_ENV_KEY]?.agentId?.trim() || '';
  const agentId = primary || legacy || null;
  return Object.freeze({
    status: 'observed',
    agentId,
    source: primary ? AGENT_ID_ENV_KEY : (legacy ? LEGACY_AGENT_ID_ENV_KEY : 'default_fallback'),
    guardMarkerPresent,
  });
}

// --- ④ 4321 可达性与 release 身份（复用既有健康探针与 runtime-fingerprint） ---

async function observeRuntimeIngress(deps: ChainObservationDeps): Promise<RuntimeIngressObservation> {
  const devPort = Number.isInteger(deps.devPort) ? Number(deps.devPort) : 4322;
  const listening = deps.isPortListening ?? defaultPortListening;
  const [health, fingerprint, devPortListening] = await Promise.all([
    settle(() => deps.probe.checkOne('ajun-runtime')),
    settle(() => deps.fingerprint()),
    settle(() => listening(devPort)),
  ]);
  if (!health.ok) {
    return Object.freeze({ status: 'unknown', reachable: false, errorCode: 'probe_failed' });
  }
  const observation = asRecord(health.value);
  const evidence = asRecord(observation.evidence);
  const ajun = asRecord(asRecord(asRecord(asRecord(fingerprint.value).live).services).ajun);
  const runtime = asRecord(ajun.runtime);
  const releaseHash = typeof runtime.releaseHash === 'string' ? runtime.releaseHash : '';
  return Object.freeze({
    status: 'observed',
    reachable: observation.status === 'healthy',
    healthStatus: typeof observation.status === 'string' ? observation.status : null,
    httpStatus: typeof evidence.httpStatus === 'number' ? evidence.httpStatus : null,
    errorCode: typeof evidence.errorCode === 'string' ? evidence.errorCode : null,
    listenerPid: typeof ajun.pid === 'number' ? ajun.pid : null,
    releaseStatus: typeof runtime.status === 'string' ? runtime.status : null,
    releaseHashDigest: /^[0-9a-f]{64}$/.test(releaseHash) ? `sha256:${releaseHash.slice(0, 12)}` : null,
    sourceRelationship: typeof asRecord(asRecord(fingerprint.value).live).sourceRelationship === 'string'
      ? String(asRecord(asRecord(fingerprint.value).live).sourceRelationship)
      : null,
    devPortListening: devPortListening.ok ? devPortListening.value === true : null,
  });
}

function defaultPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = (listening: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(400);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

// --- ⑥ 飞书准入白名单（只读 config.yaml 的白名单字段，只输出布尔与计数） ---

export function scanAdmissionWhitelist(configText: string): Readonly<{
  fieldPath: string | null; entries: readonly string[];
}> {
  const lines = String(configText || '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const match = line.match(/^(\s*)([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (!match) continue;
    const [, indent = '', key = '', rest = ''] = match;
    if (!(ADMISSION_FIELD_CANDIDATES as readonly string[]).includes(key)) continue;
    const inline = rest.trim();
    if (inline.startsWith('[')) {
      const entries = inline.replace(/^\[/, '').replace(/\]$/, '')
        .split(',').map((item) => item.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      return Object.freeze({ fieldPath: key, entries: Object.freeze(entries) });
    }
    if (inline && inline !== '|' && inline !== '>') continue;
    const entries: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor] ?? '';
      if (!candidate.trim()) continue;
      const itemMatch = candidate.match(/^(\s*)-\s+(.*)$/);
      if (!itemMatch || (itemMatch[1] ?? '').length <= indent.length) break;
      entries.push((itemMatch[2] ?? '').trim().replace(/^["']|["']$/g, ''));
    }
    return Object.freeze({ fieldPath: key, entries: Object.freeze(entries) });
  }
  return Object.freeze({ fieldPath: null, entries: Object.freeze([]) });
}

async function observeFeishuAdmission(
  readTextFile: (filePath: string) => Promise<string>,
  configPath: string,
  requesterRef: string | null | undefined,
): Promise<FeishuAdmissionObservation> {
  const requester = typeof requesterRef === 'string' ? requesterRef.trim() : '';
  let configText: string;
  try {
    configText = await readTextFile(configPath);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    return Object.freeze({
      status: 'unknown', configured: false,
      errorCode: code === 'ENOENT' ? 'config_absent' : 'config_unreadable',
    });
  }
  const scanned = scanAdmissionWhitelist(configText);
  if (!scanned.fieldPath) {
    // 字段路径找不到就必须承认报不出，不得猜成 pass 或 gap。
    return Object.freeze({ status: 'observed', configured: false, fieldPath: null, errorCode: 'admission_field_not_found' });
  }
  return Object.freeze({
    status: 'observed',
    configured: true,
    entryCount: scanned.entries.length,
    fieldPath: scanned.fieldPath,
    requesterRefDigest: digestRef(requester),
    hit: requester ? scanned.entries.some((entry) => entry === requester) : null,
  });
}

// --- 小工具 ---

async function settle<T>(run: () => Promise<T> | T): Promise<Readonly<{ ok: boolean; value: T | null }>> {
  try {
    return Object.freeze({ ok: true, value: await run() });
  } catch {
    return Object.freeze({ ok: false, value: null });
  }
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

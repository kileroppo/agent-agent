// 飞书军团总管链路诊断 · 纯判定模块（零 I/O）
//
// 全部输入由调用方注入（见 feishu-commander-chain-observations.ts 的观测适配层）。
// 本模块只做判定与中文结论渲染，不读文件、不发网络请求、不写任何东西。
//
// 能力真相五层：已声明 declared → 已配置 configured → 运行可达 reachable
// → 任务实证 / 人工验收（本模块**不产出**后两层）。禁止用前一层冒充后一层。

export const FEISHU_COMMANDER_CHAIN_DIAGNOSIS_SCHEMA = 'agent.army/feishu-commander-chain-diagnosis/v1';

export const CHAIN_CHECK_IDS = Object.freeze([
  'gateway-process',
  'adapter-patch',
  'required-env',
  'runtime-ingress',
  'profile-guard',
  'feishu-admission',
] as const);

export const GATEWAY_LAUNCHD_LABEL = 'ai.hermes.gateway';
export const EXPECTED_FEISHU_AGENT_ID = 'ajun';
export const DIAGNOSIS_COMMAND = 'npm run diagnose:feishu-chain';
export const ADAPTER_PATCH_COMMAND = 'node integrations/hermes/scripts/patch-feishu-agent-proposal-router.mjs';
export const NO_LOCAL_GAP_CAVEAT = '本机未发现阻断性缺口；这不等于飞书链路可用，需在飞书私聊发一条真实文本消息完成真机验证。';
export const BLOCKING_GAP_CAVEAT = '本机发现阻断性缺口；按唯一下一步修复后重跑诊断，并在飞书私聊发一条真实文本消息完成真机验证。';
export const INCOMPLETE_CAVEAT = '本机诊断未能覆盖全部环节；先按唯一下一步补齐可判定证据，再在飞书私聊发一条真实文本消息完成真机验证。';

const VERDICT_CAVEATS: Readonly<Record<ChainVerdict, string>> = Object.freeze({
  no_local_gap_found: NO_LOCAL_GAP_CAVEAT,
  blocking_gap: BLOCKING_GAP_CAVEAT,
  diagnosis_incomplete: INCOMPLETE_CAVEAT,
});

export type ChainCheckId = (typeof CHAIN_CHECK_IDS)[number];
export type TruthLayer = 'declared' | 'configured' | 'reachable';
export type CheckStatus = 'pass' | 'gap' | 'unknown';
export type ChainVerdict = 'blocking_gap' | 'no_local_gap_found' | 'diagnosis_incomplete';
export type ObservationStatus = 'observed' | 'unknown';
export type IngressUrlClassification =
  | 'expected_loopback' | 'non_loopback' | 'unexpected_path' | 'unparsable' | 'absent';

const LAYER_RANK: Readonly<Record<TruthLayer, number>> = Object.freeze({
  declared: 0, configured: 1, reachable: 2,
});

export function layerRank(layer: TruthLayer): number {
  return LAYER_RANK[layer] ?? 0;
}

// 每项检查在本机**最多**能证明到哪一层（design.md §2 表格）。
export const TRUTH_LAYER_CEILINGS: Readonly<Record<ChainCheckId, TruthLayer>> = Object.freeze({
  'gateway-process': 'reachable',
  'adapter-patch': 'configured',
  'required-env': 'configured',
  'runtime-ingress': 'reachable',
  'profile-guard': 'configured',
  'feishu-admission': 'configured',
});

// --- 观测结构体（由观测适配层产出，全部已脱敏） ---

export type GatewayProcessObservation = Readonly<{
  status: ObservationStatus;
  loaded: boolean;
  pid: number | null;
  label?: string | null;
  state?: string | null;
  lastExitStatus?: number | null;
  errorCode?: string | null;
}>;

export type AdapterPatchObservation = Readonly<{
  status: ObservationStatus;
  exists: boolean;
  hasCommanderRoute: boolean;
  duplicateRouteDefinitions: number;
  markers: Readonly<Record<string, boolean>>;
  hermesVersion?: string | null;
  hermesVersionMatchesBaseline?: boolean | null;
  errorCode?: string | null;
}>;

export type EnvVariableObservation = Readonly<{
  present: boolean;
  classification?: IngressUrlClassification;
  agentId?: string | null;
}>;

export type RequiredEnvObservation = Readonly<{
  status: ObservationStatus;
  plistExists?: boolean | null;
  variables: Readonly<Record<string, EnvVariableObservation>>;
  errorCode?: string | null;
}>;

export type RuntimeIngressObservation = Readonly<{
  status: ObservationStatus;
  reachable: boolean;
  healthStatus?: string | null;
  httpStatus?: number | null;
  errorCode?: string | null;
  listenerPid?: number | null;
  releaseStatus?: string | null;
  releaseHashDigest?: string | null;
  sourceRelationship?: string | null;
  devPortListening?: boolean | null;
  errorCodes?: readonly string[];
}>;

export type ProfileGuardObservation = Readonly<{
  status: ObservationStatus;
  agentId: string | null;
  source?: string | null;
  guardMarkerPresent?: boolean | null;
  errorCode?: string | null;
}>;

export type FeishuAdmissionObservation = Readonly<{
  status: ObservationStatus;
  configured: boolean;
  entryCount?: number | null;
  hit?: boolean | null;
  requesterRefDigest?: string | null;
  fieldPath?: string | null;
  errorCode?: string | null;
}>;

export type ChainObservations = Readonly<{
  gatewayProcess: GatewayProcessObservation;
  adapterPatch: AdapterPatchObservation;
  requiredEnv: RequiredEnvObservation;
  runtimeIngress: RuntimeIngressObservation;
  profileGuard: ProfileGuardObservation;
  feishuAdmission: FeishuAdmissionObservation;
}>;

// 切片 A 不依赖证据账本（切片 B 才落地），因此这里只用最宽的只读摘要类型。
export type ChainEvidenceSummary = Readonly<Record<string, unknown>>;

export type ChainCheck = Readonly<{
  id: ChainCheckId;
  title: string;
  status: CheckStatus;
  truthLayer: TruthLayer;
  truthLayerCeiling: TruthLayer;
  requiresRealMachineVerification: boolean;
  conclusion: string;
  evidence: Readonly<Record<string, unknown>>;
  nextStep: string | null;
  blocking: boolean;
}>;

export type FeishuCommanderChainDiagnosis = Readonly<{
  schemaVersion: typeof FEISHU_COMMANDER_CHAIN_DIAGNOSIS_SCHEMA;
  generatedAt: string;
  safety: Readonly<{ readOnly: true; secretsRead: false; externalEffects: false }>;
  verdict: ChainVerdict;
  verdictCaveat: string;
  checks: readonly ChainCheck[];
  uniqueNextStep: string | null;
  recentEvidence: readonly ChainEvidenceSummary[];
}>;

export type DiagnoseOptions = Readonly<{
  now?: () => Date;
  expectedAgentId?: string;
  expectedPort?: number;
  expectedIngressPath?: string;
  recentEvidence?: readonly ChainEvidenceSummary[];
}>;

type CheckDraft = Readonly<{
  status: CheckStatus;
  truthLayer: TruthLayer;
  conclusion: string;
  evidence: Readonly<Record<string, unknown>>;
  nextStep?: string | null;
  blocking?: boolean;
}>;

const CHECK_TITLES: Readonly<Record<ChainCheckId, string>> = Object.freeze({
  'gateway-process': 'Hermes Gateway 进程',
  'adapter-patch': 'adapter.py 总管路由补丁',
  'required-env': '必需环境变量注入',
  'runtime-ingress': 'A君 4321 总管入口',
  'profile-guard': 'Profile guard 匹配',
  'feishu-admission': '飞书用户准入白名单',
});

export function diagnoseFeishuCommanderChain(
  observations: ChainObservations,
  options: DiagnoseOptions = {},
): FeishuCommanderChainDiagnosis {
  const now = options.now ?? ((): Date => new Date());
  const expectedAgentId = normalizeText(options.expectedAgentId) || EXPECTED_FEISHU_AGENT_ID;
  const expectedPort = Number.isInteger(options.expectedPort) ? Number(options.expectedPort) : 4321;
  const expectedIngressPath = normalizeText(options.expectedIngressPath) || '/api/feishu/commander';
  const context = { expectedAgentId, expectedPort, expectedIngressPath };

  const drafts: Readonly<Record<ChainCheckId, CheckDraft>> = {
    'gateway-process': judgeGatewayProcess(observations?.gatewayProcess),
    'adapter-patch': judgeAdapterPatch(observations?.adapterPatch),
    'required-env': judgeRequiredEnv(observations?.requiredEnv, context),
    'runtime-ingress': judgeRuntimeIngress(observations?.runtimeIngress, context),
    'profile-guard': judgeProfileGuard(observations?.profileGuard, observations?.adapterPatch, context),
    'feishu-admission': judgeFeishuAdmission(observations?.feishuAdmission),
  };

  const checks: readonly ChainCheck[] = Object.freeze(CHAIN_CHECK_IDS.map(
    (id): ChainCheck => sealCheck(id, drafts[id]),
  ));
  const verdict = decideVerdict(checks);
  return Object.freeze({
    schemaVersion: FEISHU_COMMANDER_CHAIN_DIAGNOSIS_SCHEMA,
    generatedAt: now().toISOString(),
    safety: Object.freeze({ readOnly: true as const, secretsRead: false as const, externalEffects: false as const }),
    verdict,
    verdictCaveat: VERDICT_CAVEATS[verdict],
    checks,
    uniqueNextStep: decideUniqueNextStep(checks),
    recentEvidence: Object.freeze([...(options.recentEvidence ?? [])]),
  });
}

// --- ① Hermes Gateway 进程（层级上限 reachable） ---

function judgeGatewayProcess(raw: GatewayProcessObservation | undefined): CheckDraft {
  const label = normalizeText(raw?.label) || GATEWAY_LAUNCHD_LABEL;
  const evidence = {
    launchdLabel: label,
    loaded: raw?.loaded === true,
    pid: integerOrNull(raw?.pid),
    state: normalizeText(raw?.state) || null,
    lastExitStatus: integerOrNull(raw?.lastExitStatus),
    // 进程在线永远不能证明飞书事件已被消费（能力真相五层）。
    feishuEventConsumption: 'unproven',
    ...(raw?.errorCode ? { errorCode: String(raw.errorCode) } : {}),
  };
  if (raw?.status !== 'observed') {
    return {
      status: 'unknown',
      truthLayer: 'declared',
      conclusion: `读不出 launchd 服务 ${label} 的状态，无法判定 Hermes Gateway 进程是否在运行。`,
      evidence,
      nextStep: `在本机执行 launchctl print gui/$UID/${label} 手工确认服务状态，再重跑 ${DIAGNOSIS_COMMAND}。`,
    };
  }
  if (!evidence.loaded) {
    return {
      status: 'gap',
      truthLayer: 'declared',
      conclusion: `launchd 未加载 ${label}：Hermes Gateway 没有在运行，飞书消息此刻无人消费。`,
      evidence,
      nextStep: `执行 launchctl bootstrap gui/$UID ~/Library/LaunchAgents/${label}.plist 加载 Gateway，再重跑 ${DIAGNOSIS_COMMAND}。`,
      blocking: true,
    };
  }
  if (evidence.pid === null) {
    return {
      status: 'gap',
      truthLayer: 'configured',
      conclusion: `${label} 已在 launchd 注册但没有存活进程（state=${evidence.state ?? 'unknown'}），飞书消息此刻无人消费。`,
      evidence,
      nextStep: `执行 launchctl kickstart -k gui/$UID/${label} 拉起 Gateway，再重跑 ${DIAGNOSIS_COMMAND}。`,
      blocking: true,
    };
  }
  return {
    status: 'pass',
    truthLayer: 'reachable',
    conclusion: `${label} 已加载且进程存活（pid=${evidence.pid}）；进程在线不等于飞书事件已被处理，需真机发一条真实消息验证。`,
    evidence,
  };
}

// --- ② adapter.py 补丁在位（层级上限 configured） ---

const REQUIRED_ADAPTER_MARKERS = Object.freeze([
  'PROFILE_GUARD_V1',
  'DIRECT_REPLY_V1',
] as const);

function judgeAdapterPatch(raw: AdapterPatchObservation | undefined): CheckDraft {
  const markers = plainBooleanRecord(raw?.markers);
  const duplicates = Math.max(0, integerOrNull(raw?.duplicateRouteDefinitions) ?? 0);
  const evidence = {
    adapterFileExists: raw?.exists === true,
    hasCommanderRoute: raw?.hasCommanderRoute === true,
    duplicateRouteDefinitions: duplicates,
    markers,
    hermesVersion: normalizeText(raw?.hermesVersion) || null,
    hermesVersionMatchesBaseline: booleanOrNull(raw?.hermesVersionMatchesBaseline),
    // 文件在位不等于当前 Gateway 进程已加载它。
    loadedByGatewayProcess: 'unproven',
    ...(raw?.errorCode ? { errorCode: String(raw.errorCode) } : {}),
  };
  const rerun = `重跑补丁脚本：${ADAPTER_PATCH_COMMAND}（幂等；随后 launchctl kickstart -k gui/$UID/${GATEWAY_LAUNCHD_LABEL} 重载 Gateway）。`;
  if (raw?.status !== 'observed') {
    return {
      status: 'unknown',
      truthLayer: 'declared',
      conclusion: '读不出 Hermes 安装内的 adapter.py，无法判定总管路由补丁是否在位。',
      evidence,
      nextStep: `确认 HERMES_HOME 指向可读的 Hermes 安装后重跑 ${DIAGNOSIS_COMMAND}；确认补丁缺失时执行 ${ADAPTER_PATCH_COMMAND}。`,
    };
  }
  if (!evidence.adapterFileExists) {
    return {
      status: 'gap',
      truthLayer: 'declared',
      conclusion: '找不到 Hermes 的 adapter.py，总管路由补丁不在位：飞书文本消息不会进入 A君总管链。',
      evidence,
      nextStep: rerun,
      blocking: true,
    };
  }
  if (!evidence.hasCommanderRoute) {
    return {
      status: 'gap',
      truthLayer: 'configured',
      conclusion: 'adapter.py 在位但 _route_ajun_commander_event 缺失，总管路由补丁已丢失（Hermes 升级会覆盖该文件）：消息落回普通聊天。',
      evidence,
      nextStep: rerun,
      blocking: true,
    };
  }
  if (duplicates > 1) {
    return {
      status: 'gap',
      truthLayer: 'configured',
      conclusion: `adapter.py 内 _route_ajun_commander_event 出现 ${duplicates} 次重复定义，Python 只生效最后一个，补丁状态不可信。`,
      evidence,
      nextStep: `先备份 adapter.py，再${rerun}`,
      blocking: true,
    };
  }
  const missing = REQUIRED_ADAPTER_MARKERS.filter((marker) => markers[marker] !== true);
  if (missing.length > 0) {
    return {
      status: 'gap',
      truthLayer: 'configured',
      conclusion: `总管路由在位但补丁标记不全（缺 ${missing.join('、')}），路由语义与仓库基线不一致。`,
      evidence,
      nextStep: rerun,
      blocking: true,
    };
  }
  return {
    status: 'pass',
    truthLayer: 'configured',
    conclusion: 'adapter.py 内总管路由补丁在位且必需标记齐全；该文件是否已被当前 Gateway 进程加载未证明。',
    evidence,
  };
}

// --- ③ 必需环境变量注入（层级上限 configured） ---

export const INGRESS_URL_ENV_KEY = 'AJUN_FEISHU_COMMANDER_INGRESS_URL';
export const AGENT_ID_ENV_KEY = 'AGENT_ARMY_FEISHU_AGENT_ID';
export const LEGACY_AGENT_ID_ENV_KEY = 'AJUN_FEISHU_ENTRY_AGENT_ID';

function judgeRequiredEnv(
  raw: RequiredEnvObservation | undefined,
  context: Readonly<{ expectedPort: number; expectedIngressPath: string }>,
): CheckDraft {
  const variables = raw?.variables && typeof raw.variables === 'object' ? raw.variables : {};
  const ingress = variables[INGRESS_URL_ENV_KEY];
  const expectedUrl = `http://127.0.0.1:${context.expectedPort}${context.expectedIngressPath}`;
  const evidence = {
    launchdLabel: GATEWAY_LAUNCHD_LABEL,
    plistExists: booleanOrNull(raw?.plistExists),
    readKeys: Object.freeze([INGRESS_URL_ENV_KEY, AGENT_ID_ENV_KEY, LEGACY_AGENT_ID_ENV_KEY]),
    ingressUrlPresent: ingress?.present === true,
    ingressUrlClassification: normalizeText(ingress?.classification) || 'absent',
    agentIdPresent: variables[AGENT_ID_ENV_KEY]?.present === true,
    legacyAgentIdPresent: variables[LEGACY_AGENT_ID_ENV_KEY]?.present === true,
    // plist 写了变量不等于运行进程已注入（改 plist 后必须重载 Gateway）。
    processInjection: 'unproven',
    ...(raw?.errorCode ? { errorCode: String(raw.errorCode) } : {}),
  };
  const reload = `写入后必须执行 launchctl kickstart -k gui/$UID/${GATEWAY_LAUNCHD_LABEL} 重载 Gateway，再重跑 ${DIAGNOSIS_COMMAND}。`;
  if (raw?.status !== 'observed') {
    return {
      status: 'unknown',
      truthLayer: 'declared',
      conclusion: `读不出 ${GATEWAY_LAUNCHD_LABEL} 的 launchd 环境变量，无法判定 ${INGRESS_URL_ENV_KEY} 是否已注入。`,
      evidence,
      nextStep: `在本机执行 /usr/libexec/PlistBuddy -c "Print :EnvironmentVariables" ~/Library/LaunchAgents/${GATEWAY_LAUNCHD_LABEL}.plist 手工确认，再重跑 ${DIAGNOSIS_COMMAND}。`,
    };
  }
  if (!evidence.ingressUrlPresent) {
    return {
      status: 'gap',
      truthLayer: 'declared',
      conclusion: `${INGRESS_URL_ENV_KEY} 已声明但未配置到 launchd 环境：Hermes 侧总管路由会在开头静默 return False，飞书里不会有任何说明。`,
      evidence,
      nextStep: `在 ${GATEWAY_LAUNCHD_LABEL}.plist 的 EnvironmentVariables 写入 ${INGRESS_URL_ENV_KEY}=${expectedUrl}；${reload}`,
      blocking: true,
    };
  }
  if (evidence.ingressUrlClassification !== 'expected_loopback') {
    return {
      status: 'gap',
      truthLayer: 'configured',
      conclusion: `${INGRESS_URL_ENV_KEY} 已配置但不是预期的本机总管入口（判定为 ${evidence.ingressUrlClassification}）：非本机来源会被 4321 直接 403 拒绝。`,
      evidence,
      nextStep: `把 ${INGRESS_URL_ENV_KEY} 改为 ${expectedUrl}；${reload}`,
      blocking: true,
    };
  }
  return {
    status: 'pass',
    truthLayer: 'configured',
    conclusion: `${INGRESS_URL_ENV_KEY} 已配置且指向本机 ${context.expectedPort} 总管入口；plist 有值不等于运行进程已注入，改过 plist 必须重载 Gateway。`,
    evidence,
  };
}

// --- ④ A君 4321 总管入口（层级上限 reachable） ---

function judgeRuntimeIngress(
  raw: RuntimeIngressObservation | undefined,
  context: Readonly<{ expectedPort: number }>,
): CheckDraft {
  const evidence = {
    port: context.expectedPort,
    reachable: raw?.reachable === true,
    healthStatus: normalizeText(raw?.healthStatus) || null,
    httpStatus: integerOrNull(raw?.httpStatus),
    listenerPid: integerOrNull(raw?.listenerPid),
    releaseStatus: normalizeText(raw?.releaseStatus) || null,
    releaseHashDigest: normalizeText(raw?.releaseHashDigest) || null,
    sourceRelationship: normalizeText(raw?.sourceRelationship) || null,
    devPortListening: booleanOrNull(raw?.devPortListening),
    // 4321 可达不等于「飞书 → Hermes → 4321」整链打通。
    feishuChainProven: 'unproven',
    ...(raw?.errorCode ? { errorCode: String(raw.errorCode) } : {}),
  };
  const bringUp = '按 launchd 拉起正式 4321 不可变 release（launchctl kickstart -k gui/$UID/ai.agent-army.ajun-runtime；未发布时先 npm run release:immutable），'
    + `再重跑 ${DIAGNOSIS_COMMAND}。`;
  if (raw?.status !== 'observed') {
    return {
      status: 'unknown',
      truthLayer: 'declared',
      conclusion: `读不出 A君 ${context.expectedPort} 的运行状态，无法判定总管入口是否可达。`,
      evidence,
      nextStep: `执行 npm run runtime:fingerprint 手工确认 ${context.expectedPort} 的 listener 与 release 身份，再重跑 ${DIAGNOSIS_COMMAND}。`,
    };
  }
  if (!evidence.reachable) {
    if (evidence.devPortListening === true) {
      return {
        status: 'gap',
        truthLayer: 'configured',
        conclusion: `A君 ${context.expectedPort} 未监听，但开发实例 4322 在监听：npm run dev 关闭了飞书等后台协调服务，飞书链路在 4322 上不通，在这里「验证成功」是误判。`,
        evidence,
        nextStep: bringUp,
        blocking: true,
      };
    }
    return {
      status: 'gap',
      truthLayer: 'declared',
      conclusion: `A君 ${context.expectedPort} 的 /api/health 不可读：Hermes 侧只会发不含归因的降级文案，self.send 也失败时飞书会话内彻底无声。`,
      evidence,
      nextStep: bringUp,
      blocking: true,
    };
  }
  if (evidence.releaseStatus !== 'immutable_release') {
    return {
      status: 'unknown',
      truthLayer: 'reachable',
      conclusion: `A君 ${context.expectedPort} 可达且健康，但运行进程未被证明为预期的不可变 release（实测 runtime.status=${evidence.releaseStatus ?? 'unknown'}）。`,
      evidence,
      nextStep: `执行 npm run runtime:fingerprint 核对 ${context.expectedPort} 的 release 身份；跑的是工作树代码时需先 npm run release:immutable 发布。`,
    };
  }
  return {
    status: 'pass',
    truthLayer: 'reachable',
    conclusion: `A君 ${context.expectedPort} 可达、健康且运行的是不可变 release；这不等于「飞书 → Hermes → 4321」整链已打通。`,
    evidence,
  };
}

// --- ⑤ Profile guard 匹配（层级上限 configured） ---

function judgeProfileGuard(
  raw: ProfileGuardObservation | undefined,
  adapter: AdapterPatchObservation | undefined,
  context: Readonly<{ expectedAgentId: string }>,
): CheckDraft {
  // 实测行为：Hermes 侧 `(os.getenv(A,"") or os.getenv(B,"") or "ajun").strip()`。
  // 因此变量为空串或未设置会**回退到 ajun**，属于正常状态，不是缺口。
  const declared = normalizeText(raw?.agentId);
  const effectiveAgentId = declared || context.expectedAgentId;
  const guardMarkerPresent = booleanOrNull(raw?.guardMarkerPresent)
    ?? (adapter?.status === 'observed' ? plainBooleanRecord(adapter?.markers).PROFILE_GUARD_V1 === true : null);
  const evidence = {
    declaredAgentId: declared || null,
    effectiveAgentId,
    expectedAgentId: context.expectedAgentId,
    agentIdSource: normalizeText(raw?.source) || (declared ? 'launchd_environment' : 'default_fallback'),
    emptyValueFallsBackToExpected: true,
    guardMarkerPresent,
    // 运行时该分支的实际取值只能真机验证。
    runtimeBranchValue: 'unproven',
    ...(raw?.errorCode ? { errorCode: String(raw.errorCode) } : {}),
  };
  if (raw?.status !== 'observed') {
    return {
      status: 'unknown',
      truthLayer: 'declared',
      conclusion: '读不出 launchd 环境里的 Agent 标识，无法判定 Profile guard 是否允许进入总管文本路由。',
      evidence,
      nextStep: `先解决 ${GATEWAY_LAUNCHD_LABEL} 环境变量读取问题（见「必需环境变量注入」一项），再重跑 ${DIAGNOSIS_COMMAND}。`,
    };
  }
  if (effectiveAgentId !== context.expectedAgentId) {
    return {
      status: 'gap',
      truthLayer: 'configured',
      conclusion: `launchd 环境里的 ${AGENT_ID_ENV_KEY} 实际为「${effectiveAgentId}」，期望「${context.expectedAgentId}」：该 Profile 不拥有总管文本路由，消息会在 guard 处被静默拒绝。`,
      evidence,
      nextStep: `把 ${AGENT_ID_ENV_KEY} 改为 ${context.expectedAgentId}（或移除该变量让它回退到 ${context.expectedAgentId}），`
        + `再执行 launchctl kickstart -k gui/$UID/${GATEWAY_LAUNCHD_LABEL} 重载 Gateway。注意：其他岗位 Profile 必须继续被拒绝，不得为此放宽 guard。`,
      blocking: true,
    };
  }
  if (guardMarkerPresent !== true) {
    return {
      status: 'unknown',
      truthLayer: 'declared',
      conclusion: `有效 Agent 标识归一化后为 ${effectiveAgentId}，但 adapter.py 内没有 PROFILE_GUARD_V1 标记，无法判定运行时 guard 分支的实际取值。`,
      evidence,
      nextStep: `重跑补丁脚本 ${ADAPTER_PATCH_COMMAND} 恢复 guard 标记，再重跑 ${DIAGNOSIS_COMMAND}。`,
    };
  }
  return {
    status: 'pass',
    truthLayer: 'configured',
    conclusion: `有效 Agent 标识为 ${effectiveAgentId}（来源：${evidence.agentIdSource}），Profile guard 允许进入总管文本路由；运行时实际取值需真机验证。`,
    evidence,
  };
}

// --- ⑥ 飞书用户准入白名单（层级上限 configured） ---

function judgeFeishuAdmission(raw: FeishuAdmissionObservation | undefined): CheckDraft {
  const configured = raw?.configured === true;
  const hit = booleanOrNull(raw?.hit);
  const evidence = {
    whitelistConfigured: configured,
    entryCount: integerOrNull(raw?.entryCount),
    fieldPath: normalizeText(raw?.fieldPath) || null,
    requesterRefDigest: normalizeText(raw?.requesterRefDigest) || null,
    // 只有真实事件能证明本次消息实际获准入。
    admissionOfThisMessage: 'unproven',
    ...(raw?.errorCode ? { errorCode: String(raw.errorCode) } : {}),
    // 字段路径找不到时禁止输出 hit。
    ...(configured && hit !== null ? { hit } : {}),
  };
  if (raw?.status !== 'observed' || !configured) {
    return {
      status: 'unknown',
      truthLayer: 'declared',
      conclusion: '读不出飞书用户准入白名单字段（Hermes config.yaml），无法判定发送者是否获准入；未获准入的消息会被直接丢弃且用户收不到说明。',
      evidence,
      nextStep: `在本机确认 Hermes config.yaml 的飞书准入白名单配置后重跑 ${DIAGNOSIS_COMMAND} -- --requester <你的飞书 open_id>。`,
    };
  }
  if (hit === null) {
    return {
      status: 'unknown',
      truthLayer: 'configured',
      conclusion: `飞书用户准入白名单已配置（${evidence.entryCount ?? 0} 项），但本次未指定发送者，因此没有判定是否命中。`,
      evidence,
      nextStep: `重跑 ${DIAGNOSIS_COMMAND} -- --requester <你的飞书 open_id> 判定该发送者是否在准入白名单内。`,
    };
  }
  if (hit === false) {
    return {
      status: 'gap',
      truthLayer: 'configured',
      conclusion: `指定发送者（摘要 ${evidence.requesterRefDigest ?? '未知'}）不在飞书准入白名单内：消息会因未获准入被丢弃，用户收不到任何说明。`,
      evidence,
      nextStep: '把该发送者的 open_id 加入 Hermes config.yaml 的飞书准入白名单，重载 Gateway 后重跑诊断。',
      blocking: true,
    };
  }
  return {
    status: 'pass',
    truthLayer: 'configured',
    conclusion: `指定发送者（摘要 ${evidence.requesterRefDigest ?? '未知'}）命中飞书准入白名单（共 ${evidence.entryCount ?? 0} 项）；本次消息是否实际获准入只有真实事件能证明。`,
    evidence,
  };
}

// --- 收口：层级上限、blocking、nextStep 不变量 ---

function sealCheck(id: ChainCheckId, draft: CheckDraft): ChainCheck {
  const ceiling = TRUTH_LAYER_CEILINGS[id];
  const truthLayer = layerRank(draft.truthLayer) <= layerRank(ceiling) ? draft.truthLayer : ceiling;
  const status = draft.status;
  const nextStep = status === 'pass' ? null : (normalizeText(draft.nextStep) || `重跑 ${DIAGNOSIS_COMMAND} 并核对该项证据。`);
  return Object.freeze({
    id,
    title: CHECK_TITLES[id],
    status,
    truthLayer,
    truthLayerCeiling: ceiling,
    // 六项检查都不能证明「飞书链路可用」，因此恒需真机验证。
    requiresRealMachineVerification: true,
    conclusion: draft.conclusion,
    evidence: Object.freeze({ ...draft.evidence }),
    nextStep,
    blocking: status === 'gap' && draft.blocking === true,
  });
}

function decideVerdict(checks: readonly ChainCheck[]): ChainVerdict {
  if (checks.some((check) => check.blocking && check.status !== 'pass')) return 'blocking_gap';
  if (checks.some((check) => check.status !== 'pass')) return 'diagnosis_incomplete';
  return 'no_local_gap_found';
}

function decideUniqueNextStep(checks: readonly ChainCheck[]): string | null {
  const blocking = checks.find((check) => check.blocking && check.status !== 'pass');
  if (blocking) return blocking.nextStep;
  return checks.find((check) => check.status !== 'pass')?.nextStep ?? null;
}

// --- 小工具 ---

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function integerOrNull(value: unknown): number | null {
  // 只接受真正的整数：null / undefined / 空串不得被 Number() 折叠成 0。
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function plainBooleanRecord(value: unknown): Readonly<Record<string, boolean>> {
  if (!value || typeof value !== 'object') return Object.freeze({});
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, flag]) => typeof flag === 'boolean') as [string, boolean][];
  return Object.freeze(Object.fromEntries(entries));
}

# 飞书军团总管无回复 Bugfix Design

## Overview

缺陷不是链上某个环节坏了，而是**至少 8 个环节会静默失败**，使「飞书里没有任何回复」成为不可归因的黑箱。修复范围是**可归因性与可自检**，不改路由语义。

本设计交付三件事：

1. **一条命令跑出结论的本机诊断入口**，实现为仓库根 npm script（`npm run diagnose:feishu-chain`），**在 4321 未监听时依然可跑**。它复用 `deterministic-local-health-probe.ts`、`/api/health`、`scripts/runtime-fingerprint.mjs` 与 `ops/ajun-release-helper/` 的既有机制，**不新增任何 HTTP 诊断端点、不新建平行控制面**。
2. **两侧失败证据落盘**：A君运行时侧（403 拒绝、`handled:false` 有意不建任务）与 Hermes 侧（4321 不可达、降级文案发送失败）各写自己拥有的账本，诊断入口合并读取。
3. **文档纠正**：根 `README.md` 把开发实例写成 4321，导致用户误判飞书链路已就绪。

**交付模式约束**：故障链上的 `adapter.py`（`~/.hermes/`）、4321 launchd 不可变 release、飞书与 StepFun 都不在沙箱内。凡沙箱无法触达的行为，本文档一律显式标注**需真机验证**，并在《真机验证账本》给出用户在自己 Mac 上的具体命令与预期输出。**「代码已写」不等于「能力可用」。**

### 核心设计判断

| 判断 | 结论 | 理由 |
|---|---|---|
| 诊断入口形态 | **只有 CLI（npm script）一个入口，不新增 HTTP 诊断端点** | 用户的故障可能正是「4321 没起」。诊断入口若挂在 4321 内部，服务没起时诊断也跑不了 —— 这正是 1.9 的成因 |
| 对 4321 的判定 | 复用既有 `/api/health` + `DeterministicLocalHealthProbe` + `collectRuntimeFingerprint()` | 需求 2.12 禁止新建平行诊断；这三者已经是 4321 可达性与 release 身份的现成真相来源 |
| Hermes 侧改动范围 | **只改 `except` 异常分支与降级发送块，绝不触碰 `DIRECT_REPLY_V1` 分支** | 3.1 要求 `handled:false` 交回普通聊天的语义不得插入诊断文案；不碰该分支是最强保证 |
| `handled:false` 证据 | 由 A君运行时在 202 分支落盘，不由 Hermes 写 | 运行时已持有 `reason`，且写文件不影响飞书回复路径 |

### 关于 `isLocalAddress` 校验如何适用

- **不新增受 `isLocalAddress` 保护的诊断端点。** 唯一被诊断入口读取的 HTTP 接口是既有 `GET /api/health`（`runtime-http-health.ts`，本身不含 secret，沿用现状），以及 `collectRuntimeFingerprint()` 内部对 `127.0.0.1:{4321,4318,3100,4390}` 的只读探测。
- `POST /api/feishu/commander` 的 `isLocalAddress` 校验与 403 语义**完全不变**（3.3）。本设计只在既有 403 分支**之后追加一次证据落盘**，返回体、状态码与错误文案逐字节不变。
- 诊断入口是本机 CLI，权限边界由「谁能在这台 Mac 上执行 shell」决定，不引入新的网络暴露面。

---

## Glossary

- **Bug_Condition (C)**：一条飞书文本消息在 A君 Profile 上进入总管链后，**既没有用户可见的中文归因说明，也没有可判定的本机证据**的状态。
- **Property (P)**：C 成立时的期望行为 —— 飞书会话内出现可归因中文说明，或本机留下可判定证据；且存在一条不依赖 4321 的诊断命令能逐项判定六项检查。
- **Preservation**：`handled:false` 交回 Hermes 普通聊天、202 任务卡契约、403 本机校验、非 `ajun` Profile 拒绝、补丁 `_V1` 幂等、非文本消息不进入路由 —— 全部保持不变。
- **诊断入口（Chain Diagnosis Entry）**：`npm run diagnose:feishu-chain`。仓库根 npm script → `apps/ajun-runtime/scripts/diagnose-feishu-commander-chain.mjs`。零 `node_modules` 依赖，4321 未监听时仍可跑。
- **能力真相层级（Truth Layer）**：`declared`（仓库基线声明该环节应存在）→ `configured`（本机配置/文件可读且内容匹配）→ `reachable`（本机运行时可读回执）。本设计**不产出** `task_proven` 与 `human_accepted`；诊断入口不得用前一层冒充后一层。
- **层级上限（Truth Layer Ceiling）**：某项检查在本机**最多**能证明到哪一层。超出上限的结论一律标 `unproven` + `requiresRealMachineVerification: true`。
- **`_route_ajun_commander_event`**：`~/.hermes/hermes-agent/plugins/platforms/feishu/adapter.py` 中由 `integrations/hermes/scripts/patch-feishu-agent-proposal-router.mjs` 注入的总管路由方法。**该文件不在本仓库，Hermes 升级会覆盖它。**
- **证据账本（Evidence Ledger）**：按日切分的 JSONL 追加文件，`0600`。运行时侧在 `dataDir` 下，Hermes 侧在 `HERMES_HOME` 下。
- **非异常型拒绝记录（Rejection Record）**：Hermes 日志里**不带 traceback** 的单行结构化拒绝/丢弃记录，典型为用户准入拒绝。与 traceback 相对，它没有栈帧，因此不能用「最深非第三方栈帧」归属。
- **措辞溯源（Signature Provenance）**：每条拒绝措辞必须登记的三元组 —— 仓库内来源位置、适用的 Hermes 版本、适用性判定（`current_version` / `other_version` / `unknown`）。来源未登记版本时适用性恒为 `unknown`，按 2.35 不得表述为「未命中」。
- **窗口覆盖（Scan Window Coverage）**：本次扫描实际覆盖的行范围与时间范围。用于把「该措辞未出现」与「窗口没覆盖到事发时间」区分开。

---

## Bug Details

### Bug Condition

当一条飞书文本消息在 A君 Profile 上进入总管链，而链上任一静默点触发时，系统既不在飞书会话内说明发生了什么，也不在本机留下可判定证据；用户想自行定位时没有任何一次性诊断入口。

**Formal Specification:**

```
FUNCTION isBugCondition(input)
  INPUT: input of type FeishuCommanderChainAttempt
  OUTPUT: boolean

  SILENT_FAILURE_POINTS := {
    ingress_url_not_injected,          // 1.1
    profile_guard_mismatch,            // 1.2
    adapter_patch_missing,             // 1.3
    runtime_4321_unreachable,          // 1.4
    ingress_rejected_non_local,        // 1.5
    gateway_process_not_running,       // 1.6
    feishu_admission_miss,             // 1.7
    no_task_by_design_then_model_error // 1.8
  }

  RETURN input.platform == 'feishu'
         AND input.messageType == MessageType.TEXT
         AND input.declaredProfileAgentId == 'ajun'
         AND chainOutcome(input) IN SILENT_FAILURE_POINTS
         AND NOT userVisibleAttribution(input)      // 飞书会话内无可归因中文说明
         AND NOT locallyDecidableEvidence(input)    // 本机无可判定证据
END FUNCTION
```

`chainOutcome` 与 `userVisibleAttribution` 只能在真机观测；沙箱内以注入观测替身求值。

### Examples

- **1.1 环境变量未注入**：launchd 的 `ai.hermes.gateway` 缺 `AJUN_FEISHU_COMMANDER_INGRESS_URL`。期望：诊断入口报告「已声明但未配置」并给出唯一下一步。实际：`_route_ajun_commander_event` 开头 `return False`，飞书里没有任何说明。
- **1.3 补丁丢失**：Hermes 升级覆盖 `adapter.py`，`_route_ajun_commander_event` 整体消失。期望：诊断入口报告补丁不在位并指向重跑 `patch-feishu-agent-proposal-router.mjs`。实际：消息落回普通 `handle_message`，无人提示补丁已失效。
- **1.4 4321 未监听**：launchd 未加载不可变 release。期望：飞书回复「未启动任何外部动作 + 指向本机自检」，`self.send` 亦失败时本机留下带 `sourceEventRef` 的证据。实际：降级文案不含归因；`self.send` 失败则彻底无声。
- **1.6 Gateway 未运行**：`launchctl print gui/$UID/ai.hermes.gateway` 无此服务。期望：诊断入口明确「飞书消息此刻无人消费」。实际：本机不产生任何「消息是否到达」的证据。
- **1.9 无诊断入口（边界示例）**：4321 与 Gateway 同时未起。期望：诊断命令**仍能跑完并给出结论** —— 这是入口不能挂在 4321 内部的直接原因。
- **1.10 端口误判**：用户按 `README.md` 跑 `npm run dev`，实际起在 4322 且 `AJUN_DISABLE_BACKGROUND_SERVICES=true`。期望：文档区分正式 4321 与开发 4322；诊断入口在「4321 不可达但 4322 在监听」时直接给出该结论。

---

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**

- `handled:false`（`explicit_direct_reply_without_task`）在 Hermes 模型侧正常时，继续由 Hermes 普通聊天路径回复，**不插入任何诊断或降级文案**（3.1）。
- 文本消息成功建任务时继续返回 202，并按 `presentCommanderReply()` 现有契约输出 `reply` / `presentation` / `taskCard`（3.2）。
- `POST /api/feishu/commander` 对非本机来源继续 403 拒绝，错误文案与状态码不变；**不为诊断需要放宽本机校验**（3.3）。
- 非 `ajun` 的 Feishu Profile 继续被 `AGENT_ARMY_FEISHU_COMMANDER_PROFILE_GUARD_V1` 拒绝进入总管路由（3.4）。
- `integrations/hermes/scripts/` 下补丁脚本继续按 `_V1` 标记幂等，重复执行不重复注入（3.5）。
- 非 `MessageType.TEXT` 消息继续不进入总管文本路由（3.6）。
- `/api/health` 继续满足 `agent.army/runtime-health/v1`，`runtime-fingerprint` 继续满足 `agent.army/runtime-fingerprint/v1`（3.7）。
- 其他四个常驻 Gateway 继续使用独立 `HERMES_HOME`、launchd 环境与卡片账本（3.8）。
- 测试继续使用原生 `node --test`，不引入 Jest / Vitest / fast-check（3.9）。

**Scope:**

所有不落在 Bug_Condition 内的输入完全不受影响，包括：

- 成功建任务的文本消息（含任务卡投影与后续刷新）；
- `handled:false` 的直答消息（运行时侧只追加一条文件证据，飞书侧行为零变化）；
- 非文本消息（图片、语音、文件、卡片回调）；
- 其他四个 Profile（小D、小R、小办、运维官）的全部消息；
- 非本机来源对 `/api/feishu/commander` 的调用（继续 403）。

**不删除现有能力**：不移除任何既有路由分支、降级文案或补丁单元；本设计只做追加。

### 需真机验证的边界（不得冒充）

| 结论 | 沙箱能证明 | 真机才能证明 |
|---|---|---|
| 六项检查的判定逻辑 | ✅ 注入观测替身可全覆盖 | — |
| `launchctl` / PlistBuddy 真实输出的解析 | 仅解析器单测 | ✅ 真实输出格式 |
| `adapter.py` 补丁在位 / 版本匹配 | 仅字符串变换单测 | ✅ 真实安装 |
| 白名单是否命中 | ❌ | ✅ 只有真实事件能证明 |
| 4321 为预期不可变 release | ❌ | ✅ |
| 飞书会话内确实出现可归因回复 | ❌ | ✅ |

---

## Hypothesized Root Cause

### 已确认根因（第四轮 · 已实测）

**Hermes 网关侧用户准入白名单拒绝了发送者。** 飞书消息到达网关后被当作未授权用户丢弃，且不产生任何用户可见说明。日志签名形状为「`Unauthorized user:` + 账号标识 + 姓名 + `on feishu`」（涉及三条消息）。**本文档只记录签名形状，不记录任何真实取值。**

- **来源限制**：该结论由**外部直连诊断**实测取得，**不是**由本 spec 交付的诊断入口取得。本 spec 的诊断入口在真机上把 `feishu-admission` 一项报为 `unknown`（`errorCode:"admission_field_not_found"`），即按 1.19 预期在安全边界内结构上不可判定。
- **交付归属（必须如实记录）**：真机上「飞书已能正常回复」（真机验证清单步骤 6 通过）是由**配置变更**（两套白名单对齐）达成的，**不是由本 spec 交付的代码达成**。因此 **Property 1（Fix Checking）在真机上未被本 spec 的代码满足** —— 诊断入口对已确认的准入拒绝这一项仍报 `unknown`。这一差距是第四轮新增条款 2.38–2.45 的直接动因，不得记为「已修复」。
- **确认的既有条款**：1.7 / 2.7（发送者不在白名单内 → 消息被丢弃、用户收不到说明）。历史先例见 `docs/reviews/m1-xiaod-feishu-closure/acceptance.md`（2026-07-19，当时措辞为 `dm_policy_rejected`；**该记录未登记当时的 Hermes 版本**）。

### 假设迁移（四轮）

| 轮次 | 主导假设 | 结局 |
|---|---|---|
| 第一轮 | 假设 2 · adapter 补丁存活性无人校验（1.3） | **充分性被证伪** —— 补丁缺口是真实缺口，但消息会落回路径 B，不足以解释完全零回复 |
| 第二轮 | 出站 HTTP 连接持续失败 + 回退链按 ADR-0013 显式为空 → 必然静默 | **已撤回** —— 归属于 Telegram 平台插件，与飞书链路及模型 provider 均无关 |
| 第三轮 | （方法修正轮，未提出新根因） | 按子系统归属后证伪第二轮，交付 `hermes-log-attribution`（PR #12） |
| 第四轮 | Hermes 网关侧准入白名单拒绝发送者 | **已确认为直接原因**（外部直连诊断实测） |

**第二轮出站失败假设已撤回**：`ConnectError` 974 / `NetworkError` 349 / `ConnectTimeout` 34 经模块名与主机名直方图归属于 **Telegram 平台插件**（已实测），与飞书链路无关；该批证据不再构成任何候选的依据。

**三次连续证伪的共同原因是同一个方法缺陷：依赖猜测的外部标识符 + 缺少证据归属。** 第三轮交付的归属工具修掉了「缺少归属」这一半，但它自身仍犯了「标识符只覆盖单一形状」这另一半 —— 见下方 §10。

**本轮复核更正一条 bugfix.md 的事实**：bugfix.md 1.26 与第二轮记录称 `no llm provider`「在本仓库任何文件中都检索不到，来源无据（已核实）」。**该结论不成立** —— 该措辞以 `RuntimeError: No LLM provider configured` 的形式记录在 `docs/reviews/m1-xiaod-feishu-closure/acceptance.md:92`（2026-07-19，同样**未登记 Hermes 版本**）。原判断应为大小写敏感检索造成的漏检。这不改变 1.26 的结论方向（旧措辞计数为 0 仍不构成「模型配置正常」的证据），但它本身又是一次「未溯源即断言」，正是 2.35 / 2.45 要消除的错误类型。bugfix.md 属本轮范围外，不改动；此处留档，供下一次进入需求阶段时更正。

### 本轮（第四轮）待修缺陷的根因假设

本轮修复范围只含 1.34–1.36 / 2.43–2.45 / 3.24–3.27，即 PR #12 交付物自身的缺陷。根因**已在代码中定位，不是假设**：

`apps/ajun-runtime/src/hermes-log-attribution.ts:188` 的解析由 `TRACEBACK_HEADER`（`/Traceback \(most recent call last\):\s*$/`）门控 —— 只有匹配该行才会新开一个 `MutableGroup`。非 traceback 行只做两件事：喂 `loggerNameCounts`（`LOGGER_TOKEN`，且要求 `plugins|gateway|hermes|integrations` 前缀）与更新 `lastHeaderLine`。因此**不带 traceback 的结构化准入拒绝行永远不进入 `subsystems` 与 `feishuChainTracebacks`**，而 `renderAttributionVerdict()` 与 `decideExitCode()` 只读这两者，`loggerNameCounts` 对结论零影响。

后果链（已核实为既有行为）：`feishuChainTracebacks` 为空 → `renderAttributionVerdict()` 走 `feishuRelated.length === 0` 分支（`hermes-log-attribution.ts:429-434`）输出「扫描窗口内**没有任何**归属到飞书链路的 traceback…飞书侧的失败根本没有被记录到错误日志…这本身是一个证据缺口」→ `decideExitCode()`（`scripts/attribute-hermes-logs.mjs:223-229`）返回 `1`。**而真机上失败被记录得非常明确。** 为消除误导而建的工具在主动误导。

**另有两个独立放大该缺陷的事实（本轮一并修）**：

1. **默认扫描文件集不含 `gateway.log`**：`DEFAULT_LOG_NAME = 'gateway.error.log'`（`attribute-hermes-logs.mjs:29`），而准入拒绝是 WARNING 级记录，最可能只写在 `gateway.log`。即使解析修好，默认调用仍扫不到该行。
2. **窗口覆盖范围不可见**：默认只读尾部 8 MiB（`DEFAULT_TAIL_BYTES`），真机 `gateway.error.log` 46 万行远超该窗口，而输出不报告窗口覆盖的时间范围。「未命中」因此无法与「窗口未覆盖」区分 —— 这正是 2.35 所禁止的表述混淆。

### 初始七条假设（历史记录，覆盖 1.1–1.10，未删除）

本 bug 的可观测性缺口部分仍由以下假设解释；第一轮真机验证确认了假设 2，其余未被推翻也未被逐项关闭：

1. **失败路径全部走「静默 return False」**：`_route_ajun_commander_event` 在缺 `ingress_url`、Profile guard 不匹配、非 TEXT 三处直接 `return False`，语义上等于「本路由不处理」，无法与「本该处理但配置缺失」区分。这是 1.1 / 1.2 的直接成因。
2. **补丁存活性无人校验**：`adapter.py` 不在仓库内且会被 Hermes 升级覆盖；仓库有 8 个补丁脚本但**没有只读的「补丁是否还在位」判定**，只能靠人记得重跑。这是 1.3 的直接成因。
3. **诊断能力与被诊断对象同生共死**：`DeterministicLocalHealthProbe` 和 `/api/health` 都跑在 4321 内。4321 一旦不起，既有诊断能力全部失效，用户只剩逐环节猜测。这是 1.9 的结构性成因，也决定了新入口必须在进程外。
4. **失败只写本机 log，不写可判定证据**：403 分支只写 warning 日志（1.5），Hermes 侧 `except` 只 `logger.warning`（1.4）。`*.log` 无 schema、无 `sourceEventRef`，无法与某条飞书消息对齐。
5. **有意静默与故障静默同形**：`handled:false` 是正确行为，但不留判定痕迹，与 1.8 的模型侧异常在用户视角完全一样。
6. **launchd 环境注入没有只读回读**：plist 写了变量不等于运行进程已注入（需重载 Gateway），当前无任何地方校验这一层差异。
7. **文档把开发端口写成正式端口**：`README.md:146` 写 `4321`，实际 `npm run dev` 起 4322 且关闭飞书后台协调服务，使用户在错误实例上「验证成功」。

---

## Correctness Properties

Property 1: Bug Condition - 静默失败必须可归因且可自检

_For any_ input where the bug condition holds (`isBugCondition` returns true), the fixed system SHALL 产出飞书会话内可读的中文归因说明（发生了什么、是否启动了外部动作、下一步做什么）**或**在本机写入带 `sourceEventRef` 的可判定证据；并且诊断入口 SHALL 在 4321 未监听时仍能跑完，逐项输出 `gateway-process`、`adapter-patch`、`required-env`、`runtime-ingress`、`profile-guard`、`feishu-admission` 六项判定，每项标注 `truthLayer` 且不超过其 `truthLayerCeiling`，输出中不含 secret、token、Cookie、授权链接或真实 `.env` 内容。

**Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.11, 2.12**

Property 2: Preservation - 非缺陷输入行为逐字节不变

_For any_ input where the bug condition does NOT hold (`isBugCondition` returns false), the fixed system SHALL 产出与修复前完全相同的对外结果：`handled:false`（`explicit_direct_reply_without_task`）继续原样交回 Hermes 普通聊天且回复文本不含任何诊断或降级文案；成功建任务继续返回 202 与相同的 `presentCommanderReply()` 投影；非本机调用继续 403 且错误文案不变；非 `ajun` Profile 继续被拒；非 TEXT 消息继续不进入路由；补丁脚本继续按 `_V1` 幂等。

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9**

Property 3: Bug Condition - 非异常型飞书拒绝记录必须被归属并如实报为已定位证据

_For any_ Hermes 日志文本，若其中存在至少一条可归属到飞书链路的非 traceback 拒绝记录（`isRejectionBugCondition` 返回 true），则修复后的 `attributeHermesLog()` SHALL 把该记录归属到 `feishu-platform` 并计入 `feishuChainRejections`；`renderAttributionVerdict()` SHALL NOT 输出「失败根本没有被记录」或任何等价表述，SHALL 把它报为**已定位的失败证据**并给出对应的唯一下一步；`decideExitCode()` SHALL 返回「已找到飞书归属证据」的退出码；且输出中 SHALL NOT 出现该记录的账号标识、真实姓名、`open_id` 或其任何片段与日志正文，只出现签名类型、计数、时间与行范围。

**Validates: Requirements 2.43, 2.44, 2.45**

Property 4: Preservation - traceback 归属与安全边界逐字节不变

_For any_ 不含任何可归属飞书拒绝记录的日志文本（`isRejectionBugCondition` 返回 false），修复后的 `attributeHermesLog()` SHALL 产出与修复前完全相同的 `scanned.tracebackCount`、`subsystems[].tracebackCount` / `exceptionClassCounts` / `ownedFrameCounts`、`feishuChainTracebacks`、`loggerNameCounts` 与 `redactedFieldCount`；`summarizeSignatures()` 的入参与返回形状不变；`renderAttributionVerdict()` 在无任何飞书证据时 SHALL CONTINUE TO 把「失败未被记录」本身报为证据缺口；归属到无关子系统的主导签名 SHALL CONTINUE TO 被明确判为与本 bug 无关；只读文件尾部、不整体载入内存、不读 `.env`、零外部副作用、零第三方 npm 依赖、形状白名单失败关闭（形状不符即丢弃并计入 `redactedFieldCount`）SHALL CONTINUE TO 全部保持。

**Validates: Requirements 3.24, 3.25, 3.26, 3.27**

**与 Property 1 / 2 的关系**：Property 3 是 Property 1（Fix Checking）在本轮增量上的具体实例化，Property 4 是 Property 2（Preservation）的实例化。本轮只验证 Property 3 / 4；Property 1 在真机上仍未被本 spec 代码满足（见《Hypothesized Root Cause》的交付归属声明）。

---

## Fix Implementation

### 模块边界

```
仓库根
  package.json                                        新增 script: diagnose:feishu-chain
  README.md                                           修正 4321/4322 表述（2.10）

apps/ajun-runtime/
  scripts/diagnose-feishu-commander-chain.mjs         【新】CLI 入口（进程外，唯一诊断入口）
  src/feishu-commander-chain-diagnosis.ts             【新】纯判定逻辑（无 I/O）
  src/feishu-commander-chain-observations.ts          【新】本机观测适配（全部依赖注入）
  src/feishu-commander-chain-evidence.ts              【新】运行时侧证据账本读写
  src/runtime-http-handler.ts                         【改】403 与 202 分支后追加证据落盘
  module-policy.json                                  【改】登记 3 个新模块 + affectedTests
  package.json                                        【改】新增 script

integrations/hermes/
  runtime/agent_army_feishu_commander_evidence.py     【新】Hermes 侧证据写入（纯 stdlib）
  scripts/feishu-commander-ingress-protocol.mjs       【改】新增 upgradeCommanderSilentFailureEvidence
  scripts/feishu-commander-router-patches.mjs         【改】terminal 分支执行 post-seam 幂等升级
  scripts/patch-feishu-agent-proposal-router.mjs      【改】原子安装第三个 py module
  README.md                                           【改】登记新标记与证据路径
```

不新增目录，因此 `repository-catalog.json` 与 `npm run check:architecture` 的目录分类无需改动。后端全部为原生 ESM 直跑 TS，相对导入带 `.ts` 后缀。**不改前端**，因此无需 `npm run build:frontend`。

### 1. 纯判定模块 `src/feishu-commander-chain-diagnosis.ts`

零 I/O，全部输入由调用方注入，便于 `node --test` 全覆盖。

```ts
export const FEISHU_COMMANDER_CHAIN_DIAGNOSIS_SCHEMA = 'agent.army/feishu-commander-chain-diagnosis/v1';

export const CHAIN_CHECK_IDS = Object.freeze([
  'gateway-process', 'adapter-patch', 'required-env',
  'runtime-ingress', 'profile-guard', 'feishu-admission',
] as const);

export type TruthLayer = 'declared' | 'configured' | 'reachable';
export type CheckStatus = 'pass' | 'gap' | 'unknown';

export type ChainCheck = Readonly<{
  id: typeof CHAIN_CHECK_IDS[number];
  title: string;                        // 中文标题
  status: CheckStatus;
  truthLayer: TruthLayer;               // 本次实际证明到的层级
  truthLayerCeiling: TruthLayer;        // 本机最多能证明到的层级
  requiresRealMachineVerification: boolean;
  conclusion: string;                   // 中文结论，一句话
  evidence: Readonly<Record<string, unknown>>;  // 已脱敏事实
  nextStep: string | null;              // 唯一下一步；status==='pass' 时为 null
  blocking: boolean;                    // 是否阻断飞书链路
}>;

export type FeishuCommanderChainDiagnosis = Readonly<{
  schemaVersion: typeof FEISHU_COMMANDER_CHAIN_DIAGNOSIS_SCHEMA;
  generatedAt: string;
  safety: Readonly<{ readOnly: true; secretsRead: false; externalEffects: false }>;
  verdict: 'blocking_gap' | 'no_local_gap_found' | 'diagnosis_incomplete';
  verdictCaveat: string;                // 固定说明：no_local_gap_found ≠ 飞书可用，需真机一条真实消息
  checks: readonly ChainCheck[];        // 顺序与 CHAIN_CHECK_IDS 一致，长度恒为 6
  uniqueNextStep: string | null;        // 第一个 blocking gap 的 nextStep
  recentEvidence: readonly CommanderChainEvidenceRecord[];
}>;

export function diagnoseFeishuCommanderChain(
  observations: ChainObservations,
  options?: Readonly<{
    now?: () => Date;
    expectedAgentId?: string;           // 默认 'ajun'
    expectedPort?: number;              // 默认 4321
    expectedIngressPath?: string;       // 默认 '/api/feishu/commander'
    recentEvidence?: readonly CommanderChainEvidenceRecord[];
  }>,
): FeishuCommanderChainDiagnosis;
```

不变量（由单测强制）：`checks.length === 6`、`checks[i].id === CHAIN_CHECK_IDS[i]`、`layerRank(truthLayer) <= layerRank(truthLayerCeiling)`、`status === 'pass' ⟺ nextStep === null`、`verdict === 'blocking_gap' ⟺ checks.some(c => c.blocking && c.status !== 'pass')`。

### 2. 六项判定的实现方式与层级上限

| # | id | 观测手段（全部只读） | 复用来源 | `truthLayerCeiling` | 本机永远不能证明 |
|---|---|---|---|---|---|
| ① | `gateway-process` | `launchctl print gui/<uid>/ai.hermes.gateway` → 是否加载、`state`、`pid`、`last exit status` | 语义沿用 `AjunReleaseSystemAdapter.serviceLoaded()`；命令执行复用其导出的 `defaultRunCommand` | `reachable`（pid 存活） | 「飞书事件已被消费」→ `feishuEventConsumption: 'unproven'` |
| ② | `adapter-patch` | 读 `$HERMES_HOME/plugins/platforms/feishu/adapter.py`，扫描 `async def _route_ajun_commander_event(` 及 `PROFILE_GUARD_V1` / `INGRESS_TIMEOUT_V1` / `DIRECT_REPLY_V1` / `ADAPTER_SEAM_V1` / 新 `SILENT_FAILURE_EVIDENCE_V1`；统计重复定义数；读 `pyproject.toml` 版本并与 `SUPPORTED_HERMES_VERSION` / `SUPPORTED_HERMES_GIT_COMMIT` 比对 | 路径来自 `patch-support.mjs` 的 `defaultHermesTarget()`；常量来自同文件 | `configured` | 「该文件已被当前 Gateway 进程加载」 |
| ③ | `required-env` | PlistBuddy 读 `ai.hermes.gateway` plist 的 `:EnvironmentVariables:<KEY>`，KEY 仅限白名单三项：`AJUN_FEISHU_COMMANDER_INGRESS_URL`、`AGENT_ARMY_FEISHU_AGENT_ID`、`AJUN_FEISHU_ENTRY_AGENT_ID`（旧安装兼容） | 机制沿用 `AjunReleaseSystemAdapter.plistValue()` | `configured` | 「进程已真正注入」（plist 改了但未重载 Gateway ⇒ 未注入）→ `processInjection: 'unproven'` |
| ④ | `runtime-ingress` | `DeterministicLocalHealthProbe.checkOne('ajun-runtime')` 得 `agent.army/local-health-observation/v1`；`collectRuntimeFingerprint()` 得 4321 的 pid/cwd、`runtime.status`、`releaseHash`、`live.sourceRelationship`；另探测 4322 是否在监听 | 直接复用 `deterministic-local-health-probe.ts` 与 `scripts/runtime-fingerprint.mjs` 的导出 | `reachable` | 「飞书 → Hermes → 4321 整链打通」 |
| ⑤ | `profile-guard` | 由 ③ 的有效 `agentId`（`AGENT_ARMY_FEISHU_AGENT_ID` 优先，回退旧变量，再回退 `'ajun'`）与 ② 的 `PROFILE_GUARD_V1` 标记联合判定；不匹配时输出实际值 vs 期望 `ajun`，并说明「该 Profile 不拥有总管文本路由」 | 判定规则镜像 `feishu-commander-ingress-protocol.mjs` 中 guard 的真实逻辑 | `configured` | 「运行时该分支的实际取值」 |
| ⑥ | `feishu-admission` | 只读 `$HERMES_HOME/config.yaml`，仅提取飞书准入白名单字段，输出 `configured` 布尔与 `entryCount`；仅当调用方显式传 `--requester <open_id>` 时输出 `hit` 布尔（requester 以摘要呈现）。字段路径找不到时 `status:'unknown'`、`truthLayer:'declared'` | 路径解析复用 `defaultHermesRoot()`；`config.yaml` 是 `reconcile-hermes-skill-whitelist.mjs` 已认定的 Profile 私有配置 | `configured` | 「本次消息实际获准入」→ 只有真实事件能证明 |

**跨层冒充的具体禁止规则**（写入单测）：

- ① `pid` 存在只置 `truthLayer:'reachable'`，`conclusion` 不得出现「飞书消息可被消费」；`pid` 缺失时 `conclusion` 必须包含「飞书消息此刻无人消费」（2.6）。
- ② / ③ / ⑤ / ⑥ 的 `truthLayer` 永不为 `'reachable'`，且 `requiresRealMachineVerification` 恒为 `true`。
- ③ 变量缺失时 `truthLayer:'declared'` + `conclusion` 含「已声明但未配置」（2.1）。
- ⑥ 字段找不到时**禁止**输出 `hit`，`status` 必须是 `'unknown'` 而非 `'pass'` 或 `'gap'`（2.7 只要求报告是否命中，报不出就必须承认报不出）。
- 全部 6 项 `pass` 时 `verdict` 为 `no_local_gap_found`，`verdictCaveat` 固定为「本机未发现阻断性缺口；这不等于飞书链路可用，需在飞书私聊发一条真实文本消息完成真机验证」。

### 3. 观测适配 `src/feishu-commander-chain-observations.ts`

全部依赖注入，生产源码不直接依赖 `ops/`（`defaultRunCommand` 由 CLI 注入），沙箱内用替身即可全覆盖。

```ts
export type CommandRunner =
  (file: string, args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export async function observeFeishuCommanderChain(deps: Readonly<{
  runCommand: CommandRunner;                    // 由 CLI 注入 ops/ajun-release-helper 的 defaultRunCommand
  readTextFile: (filePath: string) => Promise<string>;
  statFile: (filePath: string) => Promise<Readonly<{ mode: number }> | null>;
  probe: Readonly<{ checkOne(targetId: string): Promise<unknown> }>;
  fingerprint: () => Promise<unknown>;          // collectRuntimeFingerprint
  uid: number;
  hermesHome: string;                           // defaultHermesRoot()
  gatewayLabel?: string;                        // 默认 'ai.hermes.gateway'
  gatewayPlistPath?: string;                    // 默认 ~/Library/LaunchAgents/<label>.plist
  requesterRef?: string | null;
  devPort?: number;                             // 默认 4322
}>): Promise<ChainObservations>;

// 环境变量脱敏：仅白名单键；URL 只在匹配 ^http://127\.0\.0\.1:\d{2,5}/api/feishu/commander$ 时
// 归一化输出，否则输出 'non_loopback' | 'unexpected_path' | 'unparsable'，绝不回显原值。
export function classifyIngressUrl(value: unknown):
  'expected_loopback' | 'non_loopback' | 'unexpected_path' | 'unparsable' | 'absent';
```

**安全约束（写入单测）**：`readTextFile` 只接受上表列出的三个具体路径；任何观测函数都不读 `.env`；`config.yaml` 与 `adapter.py` 的原文不进入返回值（只返回布尔、计数与枚举）；观测失败一律返回 `status:'unknown'` + 错误码，不抛异常。

### 4. 证据账本

#### 4.1 运行时侧 `src/feishu-commander-chain-evidence.ts`

```ts
export const FEISHU_COMMANDER_CHAIN_EVIDENCE_SCHEMA = 'agent.army/feishu-commander-chain-evidence/v1';

export type CommanderChainEvidenceKind =
  | 'ingress_rejected_non_local'   // 2.5：403 分支
  | 'no_task_by_design'            // 2.8：handled:false + reason
  | 'diagnosis_completed';         // 诊断入口自身留痕

export type CommanderChainEvidenceRecord = Readonly<{
  schemaVersion: typeof FEISHU_COMMANDER_CHAIN_EVIDENCE_SCHEMA;
  recordedAt: string;              // ISO
  side: 'ajun-runtime' | 'hermes-gateway';
  kind: CommanderChainEvidenceKind | string;
  sourceEventRef: string | null;   // 'feishu:<message_id>'，2.4 要求
  chatRefDigest: string | null;    // 'sha256:<12hex>'
  requesterRefDigest: string | null;
  profileAgentId: string | null;
  httpStatus: number | null;
  reason: string | null;           // 如 'explicit_direct_reply_without_task'
  outcome: string;                 // 中文一句话
  truthLayer: TruthLayer;
  externalActionStarted: false;    // 恒 false
  nextStep: string | null;
}>;

export function createFeishuCommanderChainEvidenceLedger(options: Readonly<{
  dataDir: string;                 // = AGENT_ARMY_DATA_DIR || <root>/apps/ajun-runtime/data
  now?: () => Date;
  retentionDays?: number;          // 默认 14
}>): Readonly<{
  record(input: CommanderChainEvidenceInput): Promise<CommanderChainEvidenceRecord | null>;
  readRecent(options?: Readonly<{ days?: number; limit?: number }>): Promise<readonly CommanderChainEvidenceRecord[]>;
}>;

export function digestRef(value: unknown): string | null;   // sha256 前 12 位，加 'sha256:' 前缀
```

**落盘位置**：`${dataDir}/feishu-commander-chain/runtime-evidence-<YYYY-MM-DD>.jsonl`。

`dataDir` 取值沿用 `src/runtime/runtime-configuration.ts` 的既有解析：`AGENT_ARMY_DATA_DIR || <repoRoot>/apps/ajun-runtime/data`。默认值已被 `.gitignore` 的 `apps/ajun-runtime/data/`（以及 `data/`）覆盖，**无需修改 `.gitignore`**。目录以 `0700`、文件以 `0600` 创建，路径经既有 `prepareWorkspaceFile()` 越界与符号链接守卫；解析后不在 `dataDir` 内即拒写。若 `AGENT_ARMY_DATA_DIR` 被指到仓库内非忽略路径，写入者不做特殊处理，但诊断输出会提示该配置不受 `.gitignore` 覆盖。

**脱敏（2.11）**：记录中不含消息正文、`.env` 内容、token、Cookie、授权链接。`chatRef` / `requesterRef` 只以 sha256 摘要出现。`sourceEventRef` 保留 `feishu:<message_id>`（消息 ID 非凭据，且 2.4 明确要求）。写入前经统一 `assertNoSecretShaped(record)` 断言（拒绝 `sk-`、`Bearer `、`?token=`、长 base64 等形态）。

**保留期**：按日切分，`readRecent` 默认读最近 3 天、最多 200 条；`record` 顺带清理超过 `retentionDays` 的旧文件。写入失败绝不影响主流程 —— `record` 捕获全部异常并返回 `null`。

#### 4.2 Hermes 侧 `integrations/hermes/runtime/agent_army_feishu_commander_evidence.py`

4321 不可达时运行时侧无法落盘，只有 Hermes 侧能留证据（2.4）。按仓库既有 Module 模式（对齐 `agent_army_feishu_layout.py` / `agent_army_feishu_task_card.py`），由 `patch-feishu-agent-proposal-router.mjs` 原子安装为 adapter 同目录的 `agent_army_commander_evidence.py`。

```python
EVIDENCE_SCHEMA = "agent.army/feishu-commander-chain-evidence/v1"

def record_commander_chain_evidence(
    *, hermes_home, kind, source_event_ref,
    chat_ref=None, requester_ref=None, http_status=None,
    reason=None, profile_agent_id=None, now=None,
) -> bool:
    """追加一行证据到 hermes_home/agent_army_commander_evidence-<YYYY-MM-DD>.jsonl。

    纯 stdlib（json / hashlib / datetime / pathlib / os）。
    永不抛异常：任何失败返回 False，绝不成为新的故障模式。
    不写消息正文；chat_ref / requester_ref 只写 sha256 前 12 位。
    文件 0600，目录沿用 get_hermes_home()（与既有 agent_army_task_cards.json 同级）。
    """
```

`kind` 取值：`ingress_unreachable`（URLError / OSError）、`ingress_http_error`（HTTPError，带 `http_status`，涵盖 403 的 Hermes 侧视角）、`ingress_bad_response`（ValueError / JSONDecodeError）、`degraded_notice_sent`、`degraded_notice_send_failed`（2.4 的「彻底无声」情形）。

`side` 字段为 `hermes-gateway`，schema 与运行时侧同版本，CLI 合并两侧账本按 `recordedAt` 排序。

### 5. 运行时侧 HTTP 改动（`src/runtime-http-handler.ts`）

只在两处**已存在**的分支之后追加一次 `await evidence.record(...)`，返回体不变：

- **403 分支**（现 `runtime-http-handler.ts:302-304`，`/api/feishu/commander`）：`isLocalAddress` 判定与 `sendJson(response, 403, { error: '飞书军团总管入口只能由本机 Hermes 适配器调用。' })` **逐字节保留**（3.3）；在 `sendJson` 之前追加 `ingress_rejected_non_local` 证据，`nextStep` 指向 `npm run diagnose:feishu-chain`（2.5）。
- **202 分支**（现 `runtime-http-handler.ts:305-311`）：在既有 `presentCommanderReply(...)` 之后、`sendJson` 之前，若 `result?.handled === false` 则追加 `no_task_by_design` 证据（含 `reason`，来自 `feishu-commander-routing.ts:28` 的 `explicit_direct_reply_without_task`）（2.8）。**`presentCommanderReply` 的返回值不做任何修改**，`reply` / `taskCard` 字段原样返回（3.1、3.2）。

账本实例由 `dataDir` 在运行时组合层构造并注入 handler 依赖；未注入时 handler 使用 no-op 账本，保证既有测试与非飞书部署不受影响。**不新增任何 HTTP 路由。**

### 6. Hermes 侧补丁：锚点与幂等标记

**新标记**：`AGENT_ARMY_FEISHU_COMMANDER_SILENT_FAILURE_EVIDENCE_V1`

**新单元**（加入 `integrations/hermes/scripts/feishu-commander-ingress-protocol.mjs`，写法对齐既有 `upgradeCommanderDirectReplyBypass` / `upgradeCommanderProfileGuard`，复用同文件的 `transformPythonMethod` 与 `patch-support.mjs` 的 `replaceRequired`）：

```js
export function upgradeCommanderSilentFailureEvidence(source) {
  if (source.includes('AGENT_ARMY_FEISHU_COMMANDER_SILENT_FAILURE_EVIDENCE_V1')) return source;
  if (!source.includes('AJUN_FEISHU_COMMANDER_INGRESS_URL')) return source;   // 未安装总管路由则跳过
  let result = insertEvidenceImport(source);
  return transformPythonMethod(result, '_route_ajun_commander_event', (body) => {
    let upgraded = replaceRequired(body, ANCHOR_EXCEPT, EXCEPT_WITH_EVIDENCE, '找不到总管路由异常锚点');
    return replaceRequired(upgraded, ANCHOR_DEGRADED_SEND, DEGRADED_SEND_WITH_EVIDENCE, '找不到降级发送锚点');
  });
}
```

调用点（`upgradeFeishuCommanderIngressProtocol` 末位，**在 timeout 升级之后**，以便锚点已是升级后的文案）：

```js
export function upgradeFeishuCommanderIngressProtocol(source, { precedence = false } = {}) {
  let result = upgradeCommanderIngressTimeout(source);
  if (precedence) result = upgradeCommanderIngressPrecedence(result);
  result = upgradeCommanderProfileGuard(result);
  result = upgradeCommanderDirectReplyBypass(result);
  return upgradeCommanderSilentFailureEvidence(result);   // 新增，末位
}
```

**三个锚点**：

| 锚点 | 精确文本 | 插入内容 |
|---|---|---|
| A：模块导入 | `'from .agent_army_task_card import install_agent_army_feishu_task_card_adapter'` | 在其后追加 `from .agent_army_commander_evidence import record_commander_chain_evidence` |
| B：异常处理 | `'        except (HTTPError, URLError, OSError, ValueError, json.JSONDecodeError) as exc:\n            logger.warning("[Feishu] A君 commander ingress failed: %s", exc)\n'` | 保留原 `logger.warning` 一字不改，其后追加带 `# AGENT_ARMY_FEISHU_COMMANDER_SILENT_FAILURE_EVIDENCE_V1` 注释的 `record_commander_chain_evidence(...)` 调用；`kind` 由异常类型派生 |
| C：降级发送 | `'        if chat_id:\n            await self.send(chat_id, "我这次没能及时理解完这句话，也没有启动任何动作。请直接再说一次你想要的结果。", reply_to=event.message_id)\n        return True'`（`AJUN_COMMANDER_INGRESS_TIMEOUT_V1` 升级后的文案） | 把 `self.send` 包进 `try/except`：成功记 `degraded_notice_sent`，异常记 `degraded_notice_send_failed` 后吞掉；`return True` 保留 |

**锚点 C 的版本收敛**：`upgradeCommanderIngressTimeout` 的 `.replace` 对已升级源码是 no-op，且新单元在其之后运行，因此无论 adapter 处于「未升级」还是「已带 `AJUN_COMMANDER_INGRESS_TIMEOUT_V1`」状态，锚点 C 都收敛到同一段文本，单锚点即可。

**明确不碰的锚点**：`AGENT_ARMY_FEISHU_COMMANDER_DIRECT_REPLY_V1` 分支（`handled is False` → `setattr(event, "_ajun_commander_routed", False)` → `return False`）**一字不改**。这是 3.1 的结构性保证：Hermes 侧在该路径上没有任何新代码，回复文案与后续普通聊天路径不可能被影响。

**必须同时修的分发缺口**：`feishu-commander-router-patches.mjs` 的 `LEGACY_MIGRATION_MATRIX` 首项 `installed-adapter-seam-v1` 是 `terminal: true`，命中后 `migrateFeishuCommanderRouter` 直接 `return { source, terminal: true }` —— 已完整迁移的 adapter（也就是用户真机上最可能的状态）**收不到任何新补丁**。修法：

```js
const POST_SEAM_IDEMPOTENT_UPGRADES = Object.freeze([upgradeCommanderSilentFailureEvidence]);

export function migrateFeishuCommanderRouter(source) {
  const migration = LEGACY_MIGRATION_MATRIX.find(({ marker }) => !marker || source.includes(marker));
  if (migration.terminal) {
    assertInstalledAdapterSeam(source);
    const upgraded = POST_SEAM_IDEMPOTENT_UPGRADES
      .reduce((current, upgrade) => upgrade(current), source);
    return { source: upgraded, terminal: true, migration: migration.name };
  }
  /* 其余不变 */
}
```

同时把 `'from .agent_army_commander_evidence import record_commander_chain_evidence'` 加入 `assertInstalledAdapterSeam` 的 `required` 列表 —— 但仅在该 import 已被本次升级注入之后校验，避免对旧安装误报失败关闭。

**幂等（3.5）**：单元首行的标记短路 + `atomicWriteFile` 的内容相等短路，重复执行 `patch-feishu-agent-proposal-router.mjs` 不追加代码、不改文件 mtime。

**Module 安装**：`patch-feishu-agent-proposal-router.mjs` 已用 `semanticLayoutSource` / `taskCardRuntimeSource` 两个常量原子安装 py module，按同一模式新增第三个：`commanderEvidenceSource` → `agent_army_commander_evidence.py`，纳入既有 `Promise.all` 读取与 `atomicWriteFile` 的 `changed` 聚合。

### 7. 诊断 CLI `apps/ajun-runtime/scripts/diagnose-feishu-commander-chain.mjs`

```
npm run diagnose:feishu-chain                     # 中文逐项表格
npm run diagnose:feishu-chain -- --json           # 机器可读 diagnosis/v1
npm run diagnose:feishu-chain -- --requester <open_id>   # 额外判定白名单是否命中
```

根 `package.json`：`"diagnose:feishu-chain": "node apps/ajun-runtime/scripts/diagnose-feishu-commander-chain.mjs"`；`apps/ajun-runtime/package.json` 同名 script 指向 `node scripts/...`。命名与既有 `runtime:fingerprint`、`local-ai:status` 一致。

**关键属性：不依赖 4321，也不依赖 `npm install`。** CLI 只 import Node 内建模块与仓库内文件（`../src/*.ts` 沿用 `apps/ajun-runtime/scripts/*.mjs` 既有的 TS 直引模式；`../../../scripts/runtime-fingerprint.mjs`、`../../../ops/ajun-release-helper/system-adapter.mjs` 的 `defaultRunCommand` 通过 node 调用层引入，不构成生产源码跨 workspace 深相对导入）。这些文件均零第三方依赖，因此在依赖未安装、4321 未起、Gateway 未起的最坏情况下仍能跑完。

装配顺序：`observeFeishuCommanderChain(...)` → `diagnoseFeishuCommanderChain(...)` → 渲染 → 尽力写一条 `diagnosis_completed` 证据（失败仅提示，不影响输出）。

退出码：`0` = `no_local_gap_found`；`1` = `blocking_gap`；`2` = `diagnosis_incomplete`（诊断自身无法完成，例如 `HERMES_HOME` 不可读）。

人类可读输出每项固定四行：结论、能力真相层级（含是否需真机验证）、已脱敏证据、唯一下一步；末尾打印 `verdictCaveat` 与最近证据摘要。

### 8. 文档修正（2.10）

`README.md` 的「运行 A君运行台」段落（现 `README.md:138-146`）改为区分两个实例：

- **正式 4321**：launchd 受控（`ai.agent-army.ajun-runtime`），跑不可变 release，**飞书链路在此生效**；改工作树代码不会影响它，需走 `npm run release:immutable`；实时事实用 `npm run runtime:fingerprint` 读取，不手写 release hash。
- **开发 4322**：`npm run dev`，`AJUN_DISABLE_BACKGROUND_SERVICES=true`，关闭 Paperclip / 飞书 / 小D 后台协调服务，**飞书链路不通**，「本机能收到飞书消息」在 4322 上验证不了。

并在该段落指向 `npm run diagnose:feishu-chain` 作为飞书无回复时的唯一自检入口。`integrations/hermes/README.md` 追加新标记 `AGENT_ARMY_FEISHU_COMMANDER_SILENT_FAILURE_EVIDENCE_V1`、新 py module 与 Hermes 侧证据文件路径；补丁命令清单条数不变（新单元随 `patch-feishu-agent-proposal-router.mjs` 一起分发）。

### 9. 改动范围清单（沙箱可验证 vs 需真机验证）

| 文件 | 变更 | 沙箱可验证 | 需真机验证 |
|---|---|---|---|
| `apps/ajun-runtime/src/feishu-commander-chain-diagnosis.ts` | 新增 | ✅ 判定逻辑与全部层级不变量 | — |
| `apps/ajun-runtime/src/feishu-commander-chain-observations.ts` | 新增 | ✅ 解析器与脱敏（注入替身） | ⚠️ 真实 `launchctl` / PlistBuddy / `adapter.py` / `config.yaml` 的实际输出格式 |
| `apps/ajun-runtime/src/feishu-commander-chain-evidence.ts` | 新增 | ✅ schema、脱敏、`0600`、保留期、越界拒写 | — |
| `apps/ajun-runtime/src/runtime-http-handler.ts` | 改：403 / 202 分支后追加落盘 | ✅ 返回体不变 + 证据写入 | — |
| `apps/ajun-runtime/scripts/diagnose-feishu-commander-chain.mjs` | 新增 CLI | ✅ 能跑完并给出 degraded 结论（沙箱无 launchd / Hermes） | ⚠️ 真实六项判定结论、退出码 |
| `apps/ajun-runtime/module-policy.json` | 改：登记 3 个新模块 + affectedTests | ✅ `npm run check` | — |
| `apps/ajun-runtime/package.json`、根 `package.json` | 改：新增 script | ✅ | — |
| `apps/ajun-runtime/test/feishu-commander-chain-diagnosis.test.js` | 新增 | ✅ | — |
| `apps/ajun-runtime/test/feishu-commander-chain-evidence.test.js` | 新增 | ✅ | — |
| `apps/ajun-runtime/test/feishu-commander-ingress-preservation.test.js` | 新增（3.1 / 3.2 / 3.3 保持性） | ✅ | — |
| `integrations/hermes/scripts/feishu-commander-ingress-protocol.mjs` | 改：新增 evidence 单元 | ✅ 纯字符串变换 + 幂等 | — |
| `integrations/hermes/scripts/feishu-commander-router-patches.mjs` | 改：terminal 分支 post-seam 升级 | ✅ | — |
| `integrations/hermes/scripts/patch-feishu-agent-proposal-router.mjs` | 改：安装第三个 py module | ✅ 变换与安装逻辑 | ⚠️ 真实 Hermes 安装的写入与版本门禁 |
| `integrations/hermes/runtime/agent_army_feishu_commander_evidence.py` | 新增 | ✅ `python3` 单测（纯 stdlib） | ⚠️ Hermes venv 内的实际写入与权限 |
| `integrations/hermes/test/patch-feishu-agent-proposal-router.test.mjs` | 改：补锚点与幂等 case | ✅ | — |
| `integrations/hermes/test/feishu-commander-evidence.test.mjs` | 新增 | ✅ | — |
| `README.md` | 改：4321 / 4322 区分（2.10） | ✅ | — |
| `integrations/hermes/README.md` | 改：登记新标记与证据路径 | ✅ | — |
| `.gitignore` | **不改** | ✅ 默认路径已被 `apps/ajun-runtime/data/` 覆盖 | — |
| `repository-catalog.json` | **不改** | ✅ 未新增目录 | — |

不新增前端文件，因此不需要 `npm run build:frontend`。

---

### 10. 本轮修复：非异常型拒绝记录的归属（1.34–1.36 / 2.43–2.45 / 3.24–3.27）

**范围**：只修 PR #12（分支 `fix/hermes-log-subsystem-attribution`）已交付的三个文件。其余 30 余条缺陷留档不做。**不新增文件、不新增目录、不新增依赖。**

| 文件 | 变更性质 |
|---|---|
| `apps/ajun-runtime/src/hermes-log-attribution.ts` | 改：新增非 traceback 记录识别、归属、措辞溯源与结论渲染分支。**保持纯解析、零 I/O。** |
| `apps/ajun-runtime/scripts/attribute-hermes-logs.mjs` | 改：默认文件集、退出码判定式、人类可读渲染 |
| `apps/ajun-runtime/test/hermes-log-attribution.test.js` | 改：新增用例与夹具；既有 13 项断言的处置见《Testing Strategy》 |

#### 10.1 识别哪些非异常型记录 · 措辞溯源（2.45）

措辞表是**唯一**的识别来源，每条必须登记来源位置与适用版本。**表内不含任何真实取值。**

```ts
export type RejectionSignatureId =
  | 'admission-unauthorized-user'      // Hermes 0.20.1 形状
  | 'admission-dm-policy-rejected'     // 0.19 时代形状
  | 'feishu-inbound-received'          // 正向签名（入站到达）
  | 'feishu-response-ready'            // 正向签名（回复就绪）
  | 'feishu-response-sending';         // 正向签名（出站发送）

export type SignatureApplicability = 'current_version' | 'other_version' | 'unknown';

export type RejectionSignatureSpec = Readonly<{
  id: RejectionSignatureId;
  kind: 'admission_rejection' | 'positive_milestone';
  /** 仓库内来源位置。用于 2.35 的溯源，不含真实取值。 */
  source: string;
  /** 来源登记的适用 Hermes 版本；null = 来源未登记版本 ⇒ 适用性只能是 'unknown'。 */
  sourceHermesVersion: string | null;
  /** 只判定是否匹配的形状正则。零捕获组。 */
  pattern: RegExp;
  /** 签名自带的平台归属线索（措辞里含 `feishu` 时为 'feishu-platform'）。 */
  platformHint: SubsystemId | null;
}>;

export const REJECTION_SIGNATURES: readonly RejectionSignatureSpec[];
```

登记内容（`source` / `sourceHermesVersion` 逐条取自仓库，已核实）：

| id | 形状（占位符表示） | `source` | `sourceHermesVersion` |
|---|---|---|---|
| `admission-unauthorized-user` | `Unauthorized user:` … `on feishu` | `.kiro/specs/feishu-commander-no-reply-fix/bugfix.md`《第四轮外部直连诊断实测》 | `0.20.1` |
| `admission-dm-policy-rejected` | `dm_policy_rejected` | `docs/reviews/m1-xiaod-feishu-closure/acceptance.md`（2026-07-19） | `null`（该记录未登记 Hermes 版本） |
| `feishu-inbound-received` | `[Feishu] Inbound dm message received` / `inbound message: platform=feishu` | `docs/guides/创建Hermes-Agent与飞书Bot接线教程.md`、`docs/archive/handoffs/av-transcriber-feishu-provisioning-handoff.md` | `null`（两处均未登记版本） |
| `feishu-response-ready` | `response ready: platform=feishu` | 同上 | `null` |
| `feishu-response-sending` | `[Feishu] Sending response` | 同上 | `null` |

正向签名一并纳入的理由：真机上「入站到达但被拒绝」与「入站根本没到」是两个不同结论，只有同时看正向里程碑签名才能区分；且它们已在仓库内被标记「已验证」，属现成可复用事实。

**适用性判定与表述规则（2.45 / 2.35）**：

```ts
export function classifyApplicability(
  spec: RejectionSignatureSpec,
  runningHermesVersion: string | null,
): SignatureApplicability;
// sourceHermesVersion === null           → 'unknown'
// runningHermesVersion === null          → 'unknown'
// 两者相等                                → 'current_version'
// 两者不等                                → 'other_version'
```

- `runningHermesVersion` 由**调用方注入**（CLI 从既有观测层取，纯解析模块不做 I/O）。未注入时全部为 `unknown`。
- 渲染时每条措辞固定输出「来源位置 + 适用版本 + 适用性」。
- 某措辞**未命中**时 SHALL 输出「该措辞在当前版本不适用」（`other_version`）或「适用性未知」（`unknown`），**SHALL NOT 输出「未发生该类拒绝」**。
- 若窗口未覆盖事发时间，SHALL 优先输出窗口覆盖范围这一事实（见 10.5），不得把「窗口外」表述为「未命中」。

#### 10.2 PII 硬约束（2.43 / 2.40）—— 最重要

拒绝日志行**本身就含真实姓名与账号标识**，因此识别与输出必须彻底解耦。

**正则：零捕获组，只用于 `test()`。**

```ts
// 每条 pattern 均满足：不含任何 `(` 捕获组，只用 `(?:…)`；不含反向引用；长度有界。
const ADMISSION_UNAUTHORIZED_USER =
  /Unauthorized user:[^\n]{1,200}?\bon\s+feishu\b/i;
const ADMISSION_DM_POLICY_REJECTED =
  /\bdm_policy_rejected\b/;
const FEISHU_INBOUND_RECEIVED =
  /(?:\[Feishu\]\s+Inbound\s+(?:dm|group)\s+message\s+received|inbound\s+message:\s*platform=feishu)/i;
const FEISHU_RESPONSE_READY =
  /response\s+ready:\s*platform=feishu/i;
const FEISHU_RESPONSE_SENDING =
  /\[Feishu\]\s+Sending\s+response/i;
```

`Unauthorized user:` 与 `on feishu` 之间的账号标识与姓名落在 `[^\n]{1,200}?` 内，该片段**既无捕获组，也从不被读取**。

**实现约束（逐条写入单测）**：

1. **只判定是否匹配，不保留捕获组**：识别函数只允许调用 `spec.pattern.test(line)`。**禁止** `String.prototype.match` / `RegExp.prototype.exec` / `matchAll` / 替换回调作用于拒绝行。
2. **零捕获组自证**：单测对每条 `pattern` 断言 `new RegExp(spec.pattern.source + '|').exec('')!.length - 1 === 0`（捕获组数为 0）。任何后续新增措辞若带捕获组，该断言立即失败。
3. **日志行文本不进入任何返回值**：识别函数的返回类型里没有 `string` 字段承载行内容。行本身只在函数内作为参数存在。
4. **只输出「签名类型 + 计数 + 时间 + 行范围」**，与既有 traceback 输出的字段粒度一致。
5. **时间戳沿用既有形状白名单并加严**：先 `line.match(TIMESTAMP)?.[0]`（`TIMESTAMP` 本身零捕获组，`[0]` 是固定形状的整段），再用锚定的 `SAFE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/` 全量校验；不通过即**丢弃并 `redactedFieldCount += 1`**（失败关闭，沿用既有 `SAFE_*` 模式，3.25 要求不放宽）。
6. **归属线索也走白名单**：日志器名沿用既有 `extractLoggerName()` + `SAFE_LOGGER_NAME`，不新增取值通道。
7. **不进入摘要**：`summarizeRejectionSignatures()` 的折叠键只由 `subsystem` + `signatureId` 组成，**不含任何来自日志行的取值**，因此摘要在结构上不可能承载 PII。

#### 10.3 数据结构变更（保持既有字段语义不动）

**判断：新增字段，不改造 `feishuChainTracebacks`。** 理由 —— 该字段的元素类型 `TracebackGroup` 含 `ownedFrames` / `exceptionChain` 等 traceback 专有语义，非 traceback 记录塞不进去；且既有 4 项测试直接依赖该字段名与元素形状（见《Testing Strategy》影响表）。统一抽象会同时破坏语义与测试，收益为零。

```ts
export type RejectionRecord = Readonly<{
  subsystem: SubsystemId;
  /** 归属依据。非 traceback 记录没有栈帧，因此不能用 owning_frame。 */
  attributionBasis: 'signature_platform' | 'logger_name' | 'none';
  /** 日志器名与签名自带平台线索冲突时为 true，不得静默吞掉。 */
  attributionConflict: boolean;
  signatureId: RejectionSignatureId;
  kind: RejectionSignatureSpec['kind'];
  applicability: SignatureApplicability;
  loggerName: string | null;
  timestamp: string | null;
  line: number;
}>;
```

归属顺序：签名自带 `platformHint`（如措辞含 `on feishu` / `platform=feishu`）优先 → 否则 `classifyLoggerName(extractLoggerName(line))` → 否则 `'unattributed'` + `basis:'none'`。两者都存在且不一致时取 `platformHint`，并置 `attributionConflict:true`。

**`SubsystemReport` 新增三个字段**（既有字段一个不改，`tracebackCount` **保持 traceback-only**）：

```ts
  rejectionRecordCount: number;
  rejectionSignatureCounts: readonly Readonly<{ signatureId: RejectionSignatureId; count: number }>[];
  /** 该子系统内非 traceback 记录的最近时间；与既有 lastTimestamp 分开，避免改变既有字段语义。 */
  lastRejectionTimestamp: string | null;
```

- `subsystems` 的排序键由 `tracebackCount` 改为 `tracebackCount + rejectionRecordCount`（降序），tiebreak 仍为 `subsystem.localeCompare`。
- `firstLine` / `lastLine` 扩展为同时覆盖 traceback 与拒绝记录。**必须加空集合守卫**：既有实现用 `Math.min(...bucket.map(...))`，当某子系统只有拒绝记录、无 traceback 时展开空数组会得到 `Infinity` / `-Infinity`。
- 只有拒绝记录、无 traceback 的子系统**也要生成 `SubsystemReport` 条目**（`tracebackCount:0`）。

**`HermesLogAttribution` 新增四个顶层字段**：

```ts
  /** 归属到飞书链路的非 traceback 记录明细。与 feishuChainTracebacks 平行。 */
  feishuChainRejections: readonly RejectionRecord[];
  /** 每条登记措辞的溯源与本次是否命中。未命中也必须出现在这里（2.45）。 */
  signatureProvenance: readonly Readonly<{
    signatureId: RejectionSignatureId;
    source: string;
    sourceHermesVersion: string | null;
    applicability: SignatureApplicability;
    matchCount: number;
  }>[];
  /** 证据类别，使退出码 0 的两种情形在机器可读输出里可区分。 */
  evidenceClass: 'traceback' | 'rejection' | 'both' | 'none';
```

`scanned` 新增（既有三个字段不动）：

```ts
    rejectionRecordCount: number;
    /** 窗口覆盖的时间范围，用于把「未命中」与「窗口未覆盖」区分开。 */
    windowFirstTimestamp: string | null;
    windowLastTimestamp: string | null;
```

**`summarizeSignatures()` 不改**（签名、入参类型 `readonly TracebackGroup[]`、返回 `SignatureSummary[]` 全部不动）。新增平行函数：

```ts
export type RejectionSignatureSummary = Readonly<{
  subsystem: SubsystemId;
  signatureId: RejectionSignatureId;
  applicability: SignatureApplicability;
  count: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  firstLine: number;
  lastLine: number;
}>;

export function summarizeRejectionSignatures(
  records: readonly RejectionRecord[],
): readonly RejectionSignatureSummary[];
```

**`loggerNameCounts` 元素形状严禁增删字段** —— 既有测试用 `assert.deepEqual` 全量比对（见影响表第 7 项）。

**Schema 版本：保持 `agent.army/hermes-log-attribution/v1`，不升版。** 判据：本轮变更**纯追加** —— 没有删除任何字段，没有改变任何既有字段的含义（`tracebackCount` 仍只计 traceback，`feishuChainTracebacks` 仍只装 traceback，`loggerNameCounts` 形状不变）。仓库内该 schema 的消费方只有 `attribute-hermes-logs.mjs` 与其单测（已核实：`git grep` 无其他引用），无外部契约。若后续需要改变既有字段语义，届时才升 `v2`。

#### 10.4 结论渲染与退出码（2.44）

**`renderAttributionVerdict()` 的分支改造**：

| 条件 | 结论 | 唯一下一步 |
|---|---|---|
| 无 traceback **且** 无拒绝记录 | 保留既有文案（含子串 `没有解析到任何 traceback`），并补充「非异常型拒绝记录同样为零」 | 扩大 `--tail-mb` 窗口 / 用 `--all` 覆盖 `gateway.log` 后重跑 |
| 有飞书拒绝记录（`feishuChainRejections.length > 0`） | **报为已定位的失败证据**：逐条给出签名类型、计数、时间、行范围与措辞溯源 | 命中准入拒绝签名时：核对两套白名单（军团侧 store 与 Hermes Profile 环境文件）是否对齐，对齐后重启 Gateway。**不输出任何取值。** |
| 有飞书 traceback、无拒绝记录 | 保留既有文案（归属到飞书链路的 traceback 共 N 条…） | 不变 |
| 无飞书 traceback **且**无飞书拒绝记录，但存在无关子系统主导签名 | 保留既有两段文案 | 不变 |

**关键约束**：既有「失败根本没有被记录…这本身是一个证据缺口」这一段的触发条件，从 `feishuRelated.length === 0` **收紧**为 `飞书 traceback 数 === 0 && 飞书拒绝记录数 === 0`。文案本身保留（该夹具下结论仍然正确），只收紧触发条件 —— 这样既满足 2.44，也让既有测试的断言无需改写。

同时保留既有 3.25 要求的两段措辞不变：`与「飞书消息无回复」无关` 与 `不得据此推导飞书侧根因`（含 `无回退链`）。

**退出码语义扩展**（`decideExitCode()`）：仍是三个码，**不新增码**。只把「找到证据」的判定式从 traceback 扩为 traceback ∪ 拒绝记录。

| 码 | 修复前 | 修复后 |
|---|---|---|
| `0` | 找到飞书归属 **traceback** | 找到飞书归属证据（**traceback 或非 traceback 拒绝记录**） |
| `1` | 未找到飞书归属 traceback（报为证据缺口） | 未找到**任何**飞书归属证据（两类都为零，才是真正的证据缺口） |
| `2` | 日志读不出，工具自身无法完成 | 不变 |

判定式：

```js
export function decideExitCode(result) {
  if (!result.ok) return 2;
  const found = result.reports.some((report) =>
    (report.attribution?.feishuChainTracebacks.length ?? 0) > 0
    || (report.attribution?.feishuChainRejections.length ?? 0) > 0);
  return found ? 0 : 1;
}
```

「0 覆盖两种情形」这一信息损失由 `evidenceClass` 在 `--json` 输出里补齐，不靠新增退出码解决 —— 保持三码可避免调用方脚本改造，也与既有 13 项测试的退出码断言兼容。

#### 10.5 CLI 侧改动（`attribute-hermes-logs.mjs`）

1. **默认文件集**：`DEFAULT_LOG_NAME`（单值）改为 `DEFAULT_LOG_NAMES = Object.freeze(['gateway.error.log', 'gateway.log'])`。理由见《Hypothesized Root Cause》：准入拒绝是 WARNING 级，最可能只在 `gateway.log`；不改这一项，解析修好也扫不到。`selectFiles()` 相应返回两个路径；单个文件缺失沿用既有 `log_absent` 逐文件报错，不影响 `ok`。
2. **注入运行版本**：新增 `--hermes-version <x.y.z>` 可选参数，透传给 `attributeHermesLog(text, { tailWindow, hermesVersion })` 以驱动 `classifyApplicability`。未提供时全部措辞报「适用性未知」。**不新增任何自动探测 I/O**（保持零第三方依赖与只读边界）。
3. **窗口覆盖输出**：人类可读输出新增一行「本次窗口覆盖时间：`windowFirstTimestamp` → `windowLastTimestamp`」，并在未命中任何飞书证据时提示该窗口可能未覆盖事发时间。
4. **措辞溯源输出**：新增「措辞溯源」块，逐条打印 `signatureId`、来源位置、适用版本、适用性、命中计数。未命中的措辞照样打印，标注「该措辞在当前版本不适用 / 适用性未知」。
5. **拒绝记录明细**：新增「飞书链路非 traceback 拒绝记录」块，输出 `summarizeRejectionSignatures()` 的折叠结果（签名类型 ×计数、首次/最近时间、覆盖行范围）。**不输出任何行内容。**
6. `--help` 文案与文件头注释里的退出码说明同步为 10.4 的表述。

#### 10.6 必须保持不变（3.24–3.27）

| 保持项 | 保证方式 |
|---|---|
| traceback 子系统归属逻辑（最深非第三方栈帧 / 日志器名） | `sealGroup()`、`classifyOwningPath()`、`classifyLoggerName()`、`LIBRARY_FRAME` **一字不改**；拒绝记录走完全独立的代码路径 |
| 归属到无关子系统的主导签名继续判为与本 bug 无关 | `renderAttributionVerdict()` 的 `!dominant.feishuChainRelated` 分支两段文案不改；`FEISHU_CHAIN_SUBSYSTEMS` 与 `isFeishuChainRelated()` 不改 |
| 只读文件尾部、不整体载入内存 | `readTail()` 不改；默认文件集变为两个，仍按文件逐个尾读，窗口大小仍由 `--tail-mb` 控制 |
| 零第三方 npm 依赖 | 只新增纯正则与纯函数，无 import 变化 |
| 只读、不读 `.env`、零外部副作用、输出零凭据 | 纯解析模块仍零 I/O；CLI 仍只 `fs.open` + `read`；新增参数是版本号字符串，不引入任何配置读取 |
| 既有形状白名单与失败关闭语义不放宽 | 新增 `SAFE_TIMESTAMP` 沿用同一模式；不通过即丢弃并 `redactedFieldCount += 1`；`SAFE_CLASS_NAME` / `SAFE_PY_BASENAME` / `SAFE_FUNC_NAME` / `SAFE_LOGGER_NAME` 全部不改 |
| 既有 13 项测试中不涉及本次变更的断言继续通过 | 逐项影响见《Testing Strategy》影响表；设计已按「保留字段名、保留字段语义、保留被断言的文案子串」倒推 |

**顺带记录（不在本轮范围，留档）**：`apps/ajun-runtime/module-policy.json` 内**没有** `src/hermes-log-attribution.ts` 的条目（已核实）。该文件是选择性登记表（现登记 122 项），未登记不必然违规，但与本设计 §模块边界「登记新模块 + affectedTests」的既有约定不一致。本轮按范围约束不处理。

---

## Testing Strategy

### Validation Approach

两阶段：先在**未修复代码**上跑出反例、确认或推翻根因假设；再验证修复生效且既有行为不变。测试全部使用原生 `node --test`（3.9），不引入 Jest / Vitest / fast-check。

### Exploratory Bug Condition Checking

**Goal**：在实现修复前surface反例，确认或推翻《Hypothesized Root Cause》。若被推翻则必须重新假设根因。

**Test Plan**：在未修复代码上运行下列检查，观察失败与缺失。

**Test Cases**：

1. **诊断入口缺失**：断言存在可执行的 `diagnose:feishu-chain`（未修复必然失败 —— 直接证明假设 3）。
2. **403 无证据**：以非本机 `remoteAddress` 调 `/api/feishu/commander`，断言返回 403 **且** `dataDir` 下出现一条 `ingress_rejected_non_local`（未修复时 403 通过、证据缺失 —— 证明假设 4）。
3. **`handled:false` 无证据**：以「不要建任务，直接回答」类文本调 handler，断言返回 202 且 `handled === false`，同时应出现 `no_task_by_design` 证据（未修复时证据缺失 —— 证明假设 5）。
4. **补丁存活性不可判定**：给出一份删去 `_route_ajun_commander_event` 的 `adapter.py` 夹具，断言存在一个只读判定能报出「补丁不在位 + 重跑 `patch-feishu-agent-proposal-router.mjs`」（未修复时无此能力 —— 证明假设 2）。
5. **已迁移 adapter 收不到新补丁（边界）**：对含 `AGENT_ARMY_HERMES_FEISHU_ADAPTER_SEAM_V1` 的夹具调 `migrateFeishuCommanderRouter`，断言输出包含新标记（未修复时 terminal 分支原样返回 —— 这条反例决定了 §6 的分发缺口必须一起修）。
6. **4321 关闭时诊断仍可跑（边界）**：在无 4321 监听的环境执行诊断入口，断言进程退出码 ∈ {0,1} 且六项检查齐全（未修复时命令不存在 —— 证明入口不能挂在 4321 内部）。

**Expected Counterexamples**：

- 无任何一次性诊断命令；
- 403 与 Hermes 侧 `except` 只留无 schema 的 `*.log`，无法与某条飞书消息对齐；
- `handled:false` 与模型侧异常在用户视角完全同形；
- 已完整打过补丁的 adapter 处于 terminal 分支，新补丁分发不到；
- 可能推翻假设的情形：若真机上 `_route_ajun_commander_event` 在位、六项全 `pass` 而飞书仍无回复，则根因落在 1.8（Hermes 模型侧入口 / 密钥 / 预算 / 轮次上限）或飞书应用事件订阅侧，须回到需求重新假设，**不得**用「已修复」结案。

### Fix Checking

**Goal**：验证 Bug_Condition 成立的所有输入都产出期望行为。

**Pseudocode:**

```
FOR ALL input WHERE isBugCondition(input) DO
  result := diagnoseFeishuCommanderChain(observationsOf(input))
  ASSERT expectedBehavior(result)
END FOR

FUNCTION expectedBehavior(result)
  RETURN result.checks.length == 6
     AND idsOf(result.checks) == CHAIN_CHECK_IDS
     AND FOR ALL c IN result.checks:
              layerRank(c.truthLayer) <= layerRank(c.truthLayerCeiling)
              AND (c.status == 'pass') == (c.nextStep == null)
     AND (result.verdict == 'blocking_gap') IMPLIES result.uniqueNextStep != null
     AND (result.verdict == 'no_local_gap_found') IMPLIES result.verdictCaveat CONTAINS '需在飞书私聊发一条真实文本消息'
     AND containsNoSecret(result)
     AND result.safety.externalEffects == false
END FUNCTION
```

覆盖矩阵：对 8 个静默点各构造一组观测替身，断言对应检查 `status:'gap'`、`blocking:true`、`nextStep` 为需求指定的唯一下一步（如 1.3 → 重跑 `patch-feishu-agent-proposal-router.mjs`；1.1 → 「已声明但未配置」+ 注入变量后重载 Gateway；1.6 → 含「飞书消息此刻无人消费」）。

### Preservation Checking

**Goal**：验证 Bug_Condition 不成立的所有输入，修复后结果与修复前完全一致。

**Pseudocode:**

```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT commanderIngress_original(input) == commanderIngress_fixed(input)
  ASSERT adapterRoute_original(input)     == adapterRoute_fixed(input)
END FOR
```

**Testing Approach**：用属性式（property-style）测试覆盖输入域。因 3.9 禁止引入新框架，实现方式为 `node --test` 内的**确定性输入枚举 + 固定种子伪随机生成器**（种子写死并在断言失败时打印，保证反例可复现）；不引入 PBT 库。理由不变：自动生成大量用例、覆盖手写单测容易漏的边界、为「非缺陷输入行为不变」提供强保证。

**Test Plan**：先在未修复代码上记录基线输出（`handled:false` 响应体、202 投影、403 响应体、非 TEXT 与非 `ajun` Profile 的返回值），落为夹具；修复后逐字节比对。

**Test Cases**：

1. **`handled:false` 语义保持（3.1，最高优先）**：种子生成一批命中 `isDirectReplyWithoutTask` 的中文文本，断言修复前后 `/api/feishu/commander` 响应体深度相等、`handled === false`、`reason === 'explicit_direct_reply_without_task'`，且响应体中**不出现**任何诊断/降级字样（正向断言：不含「自检」「诊断」「未启动任何外部动作」「降级」）。同时断言 Hermes 侧变换后的 `DIRECT_REPLY_V1` 代码块与变换前逐字符相等 —— 即该分支零改动。
2. **202 任务投影保持（3.2）**：随机任务标题/描述，断言 `presentCommanderReply` 的 `reply` / `presentation` / `taskCard.sourceRevision` / `taskCard.contentHash` 与基线一致。
3. **403 语义保持（3.3）**：随机非本机 `remoteAddress`（含 `::ffff:` 前缀与 LAN 段），断言恒为 403 且错误文案逐字节不变；同时断言确有一条证据落盘（新增能力不改变对外行为）。
4. **非 `ajun` Profile 拒绝保持（3.4）**：随机 `agentId ≠ 'ajun'`（含空、非法字符、大小写变体），断言 guard 判定为不进入总管路由，且诊断输出把该情形报为 `profile-guard` gap 而非放宽 guard。
5. **补丁幂等保持（3.5）**：对 5 类 adapter 夹具（未打补丁 / notifyV3 / notifyV4 / precedence / 已 seam）各连续应用补丁 3 次，断言第 2、3 次输出与第 1 次逐字节相等，且新标记恰好出现 1 次。
6. **非 TEXT 不进入路由（3.6）**：枚举 `MessageType` 全部非 TEXT 取值，断言变换后代码的短路条件不变。
7. **既有健康契约保持（3.7）**：断言 `/api/health` 仍返回 `agent.army/runtime-health/v1`，`collectRuntimeFingerprint()` 仍返回 `agent.army/runtime-fingerprint/v1`，且诊断入口只读不写这两者。
8. **其他 Gateway 隔离保持（3.8）**：断言证据账本路径由 `HERMES_HOME` / `dataDir` 决定，四个非 `ajun` 标签的 Home 与账本不被读写。
9. **证据写入不可成为新故障模式**：注入抛异常的 `record` 与只读 `dataDir`，断言 403 / 202 分支的响应体与状态码不变；注入抛异常的文件系统，断言 Python 侧 `record_commander_chain_evidence` 返回 `False` 且不抛出。

### Unit Tests

- 六项判定的逐项分支：`pass` / `gap` / `unknown`，以及层级上限不可突破；
- `classifyIngressUrl` 对 loopback、非 loopback、错误路径、空值、畸形值的分类；
- 环境变量白名单：非白名单键一律不读；任何值都不进入输出原文；
- `launchctl print` / PlistBuddy 输出解析（真实格式夹具，标注来源为真机采样）；
- `adapter.py` 标记扫描与**重复定义计数**（Python 取最后一个定义，重复必须报为风险）；
- Hermes 版本与 Git 身份比对：不匹配时报为观测事实，**不抛异常**（只读诊断不得失败关闭）；
- 证据 schema、`0600` 权限、按日切分、保留期清理、越界路径拒写、`assertNoSecretShaped` 拒绝 secret 形态；
- `digestRef` 稳定性与不可逆；
- CLI 参数解析与三个退出码；
- Python 模块：正常写入、目录不存在、权限不足、`kind` 非法 —— 全部返回布尔且不抛。

### Property-Based Tests

（均以 `node --test` + 固定种子生成器实现，不引入 PBT 库）

- 随机观测组合（6 项 × {pass, gap, unknown} 的笛卡尔采样）下，诊断输出恒满足 §Fix Checking 的四条不变量，且 `verdict` 与 `blocking` 集合一致；
- 随机字符串注入 `chatRef` / `requesterRef` / `reason` / plist 值（含 `sk-…`、`Bearer …`、`?token=…`、长 base64、超长 Unicode），断言证据记录与诊断输出中恒不出现原文，且摘要长度恒定（2.11）；
- 随机 adapter 夹具序列上重复应用补丁，断言幂等与「标记恰好一次」恒成立（3.5）。

### Integration Tests

- **诊断入口端到端（沙箱）**：以临时 `HERMES_HOME` 夹具与关闭的 4321 执行 CLI，断言六项齐全、退出码正确、`--json` 输出符合 `agent.army/feishu-commander-chain-diagnosis/v1`；
- **证据链对齐**：同一 `sourceEventRef` 分别由运行时侧与 Hermes 侧写入，断言 CLI 合并读取后按 `recordedAt` 排序、同一事件可关联；
- **补丁 → 诊断闭环**：对未打补丁的 adapter 夹具运行补丁，再运行诊断，断言 `adapter-patch` 由 `gap` 变 `pass`，且 `truthLayer` 仍不超过 `configured`（不因为刚打完补丁就冒充运行可达）。

### 本轮（第四轮）增量测试策略 —— 非异常型拒绝记录归属

被测对象是 `apps/ajun-runtime/test/hermes-log-attribution.test.js`，仍用原生 `node --test`（3.9）。

#### 夹具（占位符，零真实取值）

三份新夹具，全部只用占位符，**不得写入任何真实姓名、`open_id`、账号标识或其片段**：

```
ADMISSION_REJECTION_LINE   = '2026-08-19 14:42:01 WARNING plugins.platforms.feishu Unauthorized user: <account-placeholder> <name-placeholder> on feishu'
LEGACY_REJECTION_LINE      = '2026-07-19 11:19:02 WARNING gateway.platforms.feishu dm_policy_rejected'
POSITIVE_MILESTONE_LINES   = '[Feishu] Inbound dm message received' / 'inbound message: platform=feishu' / 'response ready: platform=feishu' / '[Feishu] Sending response'
```

真机形态复刻：`ADMISSION_REJECTION_LINE` **单行、不带 traceback**，且与既有 `TELEGRAM_TRACEBACK` 混排 —— 这正是真机上 46 万行被 Telegram 噪音主导、飞书证据只有一行的形态。

#### 探索性检查（Property 3）—— 必须先在未修复代码上跑出反例

**Goal**：用含准入拒绝行的夹具，在**未修复代码**上证明当前工具会把「已明确记录的失败」误报为「失败未被记录」。反例跑不出来则说明缺陷描述有误，必须回到需求重新假设，**不得直接实现修复**。

**执行顺序（强制）**：先在 `fix/hermes-log-subsystem-attribution` 的**当前**代码上运行下列三条断言并观察失败，再改代码。

| # | 反例断言 | 未修复代码上的预期观测 |
|---|---|---|
| E1 | `attributeHermesLog(TELEGRAM_TRACEBACK + ADMISSION_REJECTION_LINE).feishuChainRejections.length === 1` | **失败**：`feishuChainRejections` 字段不存在（`undefined`）—— 直接证明 `TRACEBACK_HEADER` 门控漏掉该记录 |
| E2 | `renderAttributionVerdict(...)` **不匹配** `/失败根本没有被记录/` | **失败**：仍输出「飞书侧的失败根本没有被记录到错误日志…这本身是一个证据缺口」—— 即主动误导 |
| E3 | `decideExitCode({ ok:true, reports:[{ attribution: attributeHermesLog(ADMISSION_REJECTION_LINE) }] }) === 0` | **失败**：返回 `1`（未找到）—— 证据存在却报「未找到」，违反 2.44 |

**补充反例（证明放大缺陷同样存在）**：

| # | 反例断言 | 未修复代码上的预期观测 |
|---|---|---|
| E4 | 默认文件集包含 `gateway.log` | **失败**：`DEFAULT_LOG_NAME` 为单值 `'gateway.error.log'` |
| E5 | `signatureProvenance` 逐条给出来源与适用版本 | **失败**：无任何措辞登记结构 |
| E6 | 未命中措辞被表述为「不适用 / 适用性未知」而非「未发生该类拒绝」 | **失败**：无该表述通道 |

**若反例未按预期失败**（例如 E2 在未修复代码上竟然通过），则说明对 `renderAttributionVerdict()` 触发条件的理解有误，SHALL 回到《Hypothesized Root Cause》重新核对代码，**SHALL NOT** 继续实现。

#### Fix Checking（Property 3）

```
FOR ALL logText WHERE isRejectionBugCondition(logText) DO
  result := attributeHermesLog(logText, { hermesVersion })
  ASSERT result.feishuChainRejections.length > 0
  ASSERT result.evidenceClass IN {'rejection', 'both'}
  ASSERT NOT matches(renderAttributionVerdict(result), /失败根本没有被记录|没有任何.*归属到飞书链路/)
  ASSERT decideExitCode(wrap(result)) == 0
  ASSERT containsNoPlaceholderValue(result)   // 账号/姓名占位符不出现在任何字段
END FOR
```

覆盖矩阵：`{当前版本措辞, 0.19 措辞, 正向签名} × {单独出现, 与 Telegram 噪音混排, 与飞书 traceback 并存} × {注入版本号, 未注入}`。

#### Preservation Checking（Property 4）—— observation-first

**Goal**：Bug_Condition 不成立的输入（不含任何可归属飞书拒绝记录的日志），修复后输出与修复前完全一致。

**执行顺序（强制）**：先在**未修复代码**上对既有两份夹具（`TELEGRAM_TRACEBACK` / `FEISHU_TRACEBACK`）跑基线并**确认通过**，把 `attributeHermesLog()` 的完整返回值序列化落为基线夹具；修复后逐字段比对既有字段。

```
FOR ALL logText WHERE NOT isRejectionBugCondition(logText) DO
  before := baselineFixture(logText)          // 未修复代码上采集
  after  := attributeHermesLog(logText)
  ASSERT after.scanned.tracebackCount        == before.scanned.tracebackCount
  ASSERT after.feishuChainTracebacks         DEEP_EQUALS before.feishuChainTracebacks
  ASSERT after.loggerNameCounts              DEEP_EQUALS before.loggerNameCounts
  ASSERT after.redactedFieldCount            == before.redactedFieldCount
  ASSERT projectExistingFields(after.subsystems) DEEP_EQUALS before.subsystems
  ASSERT summarizeSignatures(after.feishuChainTracebacks)
           DEEP_EQUALS summarizeSignatures(before.feishuChainTracebacks)
END FOR
```

`projectExistingFields()` 只投影修复前已存在的 `SubsystemReport` 字段，使新增三字段不影响比对 —— 这是本轮唯一允许的差异。

#### 既有 13 项测试的影响（逐项）

**直接受影响（4 项）**：

| # | 用例（行号） | 影响与处置 |
|---|---|---|
| 4 | 输出零凭据：不含消息正文、URL、IP、open_id 与绝对路径（`:86`） | **既有 7 条禁词断言全部不改**，但夹具与禁词表**必须扩展**：加入 `ADMISSION_REJECTION_LINE`，并把账号/姓名占位符加入禁词。否则新代码路径完全没有 PII 覆盖 |
| 6 | 没有任何飞书归属签名时，把「失败未被记录」本身报为证据缺口（`:104`） | **被测条件改，断言不改**。触发条件收紧为「飞书 traceback 与拒绝记录都为零」。该夹具（telegram-only，确无飞书证据）下结论仍正确，故 `/没有任何.*归属到飞书链路/` 与 `/「没有错误记录」不等于「飞书侧正常」/` 两条断言原样通过 —— 前提是改写文案时**保留这两段子串**。另需**新增**一条对照用例：同一夹具追加 `ADMISSION_REJECTION_LINE` 后，该文案不得出现 |
| 8 | 空日志与无 traceback 日志都不抛异常（`:123`） | **两处约束**：（a）`attributeHermesLog('普通一行日志\n').subsystems.length === 0` 要求非匹配的普通行不得生成 `SubsystemReport` 条目；（b）`renderAttributionVerdict(attributeHermesLog(''))` 匹配 `/没有解析到任何 traceback/`，要求改写后的空日志文案**保留该子串**。同时空日志早退条件须从 `!dominant` 扩为「无 subsystems **且**无拒绝记录」。断言不改 |
| 13 | CLI 参数解析与退出码语义（`:180`） | `decideExitCode` 判定式扩展。两条既有退出码断言在扩展后仍成立（telegram-only → `1`；`FEISHU_TRACEBACK` → `0`），**断言不改**；需**新增**「只含 `ADMISSION_REJECTION_LINE` → `0`」与「`evidenceClass` 取值正确」两条断言。`parseArguments` 新增 `--hermes-version`，既有 6 条参数断言不受影响 |

**未直接受影响，但对设计构成硬约束（6 项）** —— 这些断言正是 10.3 各项设计决定的倒推来源：

| # | 用例（行号） | 施加的约束 |
|---|---|---|
| 1 | 按子系统归属（`:48`） | `scanned.tracebackCount` 与 `subsystems[].tracebackCount` **必须保持 traceback-only**；`subsystems` 排序键改为 traceback+拒绝记录总数后，该夹具下顺序不变（telegram 2 > feishu 1），故 `subsystems[0] === 'telegram-platform'` 仍成立 |
| 3 | 飞书链路 traceback 逐条（`:74`） | `feishuChainTracebacks` **不得改名、不得混入非 traceback 记录**；`TracebackGroup` 不得删字段 |
| 5 | 主导签名无关时禁止套用无回退说明（`:97`） | `与「飞书消息无回复」无关` / `不得据此推导飞书侧根因` / `无回退链` 三段措辞**不得改动** |
| 7 | 日志器名体量按子系统归属（`:110`） | `assert.deepEqual` 全量比对数组元素 ⇒ **严禁给 `loggerNameCounts` 元素增删任何字段** |
| 9 | 同签名折叠（`:129`） | `summarizeSignatures()` 的入参类型与返回形状**不得改动**；非 traceback 折叠另立 `summarizeRejectionSignatures()` |
| 10 | 栈帧位置不同即不同签名（`:146`） | 同上 |

**完全不受影响（3 项）**：#2 异常类名与归属依据（`:62`）、#11 飞书链路子系统集合（`:154`，不新增 `SubsystemId`）、#12 尾部窗口读取（`:163`，`readTail()` 不改）。

#### 新增用例（本轮）

1. **非 traceback 准入拒绝被归属到 `feishu-platform`**，`attributionBasis === 'signature_platform'`，`tracebackCount` 不变。
2. **Telegram 噪音混排下拒绝记录仍被找到**：主导子系统仍是 Telegram 且判为无关，同时飞书拒绝记录数为 1 —— 这是真机形态的直接复刻。
3. **结论不得再说「失败未被记录」**（Property 3 的核心断言）。
4. **退出码语义**：拒绝记录存在 → `0`；两类证据都为零 → `1`；读不出 → `2`。
5. **措辞溯源**：每条登记措辞都出现在 `signatureProvenance`，含来源位置与适用版本；`dm_policy_rejected` 与四条正向签名的 `sourceHermesVersion` 为 `null` ⇒ `applicability === 'unknown'`。
6. **未命中的表述**：`0.19` 措辞未命中时输出「不适用 / 适用性未知」，**不得**出现「未发生该类拒绝」。
7. **零捕获组自证**：逐条断言 `REJECTION_SIGNATURES` 的 `pattern` 捕获组数为 `0`。
8. **PII 不外泄**：含占位符账号与姓名的拒绝行，序列化输出中占位符零出现；`summarizeRejectionSignatures()` 折叠键不含行内取值。
9. **时间戳失败关闭**：畸形时间戳的拒绝行 → `timestamp === null` 且 `redactedFieldCount` 递增。
10. **窗口覆盖**：`scanned.windowFirstTimestamp` / `windowLastTimestamp` 正确；无飞书证据时结论包含窗口范围提示。
11. **只有拒绝记录、无 traceback**：`SubsystemReport` 条目正常生成，`firstLine` / `lastLine` 为有限值（回归守卫：空集合 `Math.min(...[])` 会得到 `Infinity`）。
12. **默认文件集含 `gateway.log`**。
13. **归属冲突**：日志器名指向 Telegram 而签名含 `on feishu` 时，`attributionConflict === true` 且不被静默吞掉。

### 真机验证账本（用户在自己 Mac 上执行）

沙箱无法触达 `adapter.py`、launchd、飞书与 StepFun，以下为唯一可关闭结论的步骤。

```bash
# 0. 前置：拉取分支，进入仓库根
cd <repo-root>

# 1. 一条命令跑出结论（4321 未起也必须能跑完）
npm run diagnose:feishu-chain
# 预期：六项逐条输出「结论 / 能力真相层级 / 已脱敏证据 / 唯一下一步」；
#      有阻断缺口时退出码 1 并给出唯一下一步；全 pass 时退出码 0 并打印
#      「本机未发现阻断性缺口；这不等于飞书链路可用……」

# 2. 确认输出零凭据
npm run diagnose:feishu-chain -- --json | grep -Ei 'sk-|bearer|token|cookie|password'
# 预期：无匹配（退出码 1）

# 3. 若报 adapter 补丁不在位，按唯一下一步重跑（维护窗口内执行）
node integrations/hermes/scripts/patch-feishu-agent-proposal-router.mjs
node integrations/hermes/scripts/patch-hermes-agent-army-task-card-events.mjs
# 预期：首次输出「已安装…」，再次执行输出「已存在…」（幂等，3.5）

# 4. 若报环境变量未注入：写入 launchd 后必须重载，否则进程仍未注入
launchctl kickstart -k "gui/$UID/ai.hermes.gateway"
npm run diagnose:feishu-chain
# 预期：required-env 与 profile-guard 转为 pass

# 5. 核对 4321 是正式不可变 release，而不是 4322 开发实例
npm run runtime:fingerprint
# 预期：live.services.ajun.runtime.status === 'immutable_release'，且 4321 有 listener pid

# 6. 最终真机验收（唯一能证明「飞书可用」的一步）
#    在飞书私聊「A君·军团总管」发一条普通文本消息
# 预期：会话内出现业务回复，或出现可归因中文说明（含是否启动外部动作 + 下一步）

# 7. 制造一次失败并确认证据落盘（可选，验证可归因性）
launchctl bootout "gui/$UID/ai.agent-army.ajun-runtime" 2>/dev/null || true
#    再发一条飞书消息，然后：
ls -l "$HERMES_HOME/"agent_army_commander_evidence-*.jsonl
tail -n 3 "$HERMES_HOME/"agent_army_commander_evidence-*.jsonl
# 预期：文件权限 0600；出现 kind='ingress_unreachable' 或 'degraded_notice_send_failed'，
#      带 sourceEventRef，且不含消息正文与任何凭据
launchctl bootstrap "gui/$UID" ~/Library/LaunchAgents/ai.agent-army.ajun-runtime.plist
```

**未验证声明**：本设计中所有涉及飞书、Hermes、StepFun 与 launchd 真机状态的结论，在上述步骤 1–7 完成前一律**标记未验证**。沙箱内可完成的仅为判定逻辑、脱敏、schema、幂等与保持性测试。

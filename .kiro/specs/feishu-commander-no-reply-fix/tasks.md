# Implementation Plan

## Overview

本文件是「飞书总管无回复」缺陷的实施计划：先在未修复代码上采集反例与保持性基线，再分两个切片落地修复。切片 A 交付诊断 CLI `npm run diagnose:feishu-chain`（可独立成 PR，用户一条命令定位坏在哪一环），切片 B 交付可归因性兜底（两侧证据账本、补丁分发缺口、文档修正）。

## 交付切片

本计划切成两个**可独立交付**的切片，排序原则是「先让用户能自己定位，再做兜底修复」。

| 切片 | 内容 | 交付价值 | 任务 |
|---|---|---|---|
| **A（最高优先）** | 诊断 CLI `npm run diagnose:feishu-chain` | **可独立交付的最小闭环**：切片 A 合并后，用户在自己 Mac 上跑一条命令就能得出「到底坏在哪一环 + 唯一下一步」，无需切片 B 的任何代码。这是本次修复最高价值的交付物。 | 3.1 – 3.8 |
| **B（其后）** | 可归因性兜底：两侧证据账本、403/202 落盘、Hermes 新补丁单元、terminal 分支分发缺口、文档修正 | 让失败在事后可对齐到具体一条飞书消息 | 4.1 – 4.10 |

**切片 A 的独立交付判据**（必须全部成立才算切片 A 完成）：
1. `npm run diagnose:feishu-chain` 在**依赖未安装、4321 未监听、Hermes Gateway 未起**的最坏情况下仍能跑完并输出六项结论；
2. 不依赖切片 B 的任何文件（缺少证据账本时 `recentEvidence` 为空数组，不报错）；
3. 只读、零外部副作用、输出零凭据。

**标注约定**：每个任务标注 `【沙箱可验证】` 或 `【需真机验证】`。测试统一用原生 `node --test`（Python 侧用 `python3` + `node --test` 驱动），**不引入 Jest / Vitest / fast-check**（需求 3.9）。

---

## Tasks

### 阶段一：探索性 Bug 条件检查（必须在任何实现之前完成）

- [x] 1. 在未修复代码上写并运行 Bug 条件探索测试
  - **Property 1: Bug Condition** - 静默失败必须可归因且可自检
  - **CRITICAL**: 本测试 MUST 在未修复代码上 **FAIL** —— 失败即证明缺陷存在
  - **DO NOT** 在它失败时去修测试或改代码；本任务的产出是**反例记录**，不是绿灯
  - **NOTE**: 本测试同时编码了期望行为，任务 3.7 / 4.9 会重新运行**同一个测试**来验证修复
  - **GOAL**: surface 反例，确认或推翻 design.md《Hypothesized Root Cause》的 7 条假设
  - **Scoped PBT Approach**: 本缺陷是确定性的，因此把属性收敛到 design.md《Exploratory Bug Condition Checking》列出的 6 个具体失败用例，保证可复现；随机化只用于后续 4.x 的脱敏与幂等属性
  - 新建 `apps/ajun-runtime/test/feishu-commander-chain-exploration.test.js` 与 `integrations/hermes/test/feishu-commander-router-distribution.test.mjs`，覆盖以下 6 条：
    - **①诊断入口缺失**：断言存在可执行的 `diagnose:feishu-chain` script 且能退出码 ∈ {0,1}。未修复必然失败 → 证明假设 3（诊断能力与被诊断对象同生共死）
    - **②403 无证据**：以非本机 `remoteAddress` 调 `/api/feishu/commander`，断言返回 403 **且** `dataDir` 下出现一条 `ingress_rejected_non_local`。未修复时 403 通过、证据缺失 → 证明假设 4
    - **③`handled:false` 无证据**：以「不要建任务，直接回答」类中文文本调 handler，断言 202 + `handled === false` **且**出现 `no_task_by_design` 证据（含 `reason`）。未修复时证据缺失 → 证明假设 5
    - **④补丁存活性不可判定**：构造一份删去 `_route_ajun_commander_event` 的 `adapter.py` 夹具，断言存在一个只读判定能报出「补丁不在位 + 重跑 `patch-feishu-agent-proposal-router.mjs`」。未修复时无此能力 → 证明假设 2
    - **⑤已迁移 adapter 收不到新补丁（关键反例，边界）**：对含 `AGENT_ARMY_HERMES_FEISHU_ADAPTER_SEAM_V1` 的夹具调 `migrateFeishuCommanderRouter`，断言输出包含 `AGENT_ARMY_FEISHU_COMMANDER_SILENT_FAILURE_EVIDENCE_V1`。未修复时 `LEGACY_MIGRATION_MATRIX` 首项 `terminal: true` 原样 `return` → **这条反例决定了任务 4.5 的分发缺口必须与本次修复一起修，否则用户真机（最可能已完整迁移）永远拿不到新补丁**
    - **⑥4321 关闭时诊断仍可跑（边界）**：在无 4321 监听、无 `HERMES_HOME` 的环境执行诊断入口，断言退出码 ∈ {0,1} 且六项检查齐全。未修复时命令不存在 → 证明入口不能挂在 4321 内部
  - 在未修复代码上运行：`node --test apps/ajun-runtime/test/feishu-commander-chain-exploration.test.js` 与 `node --test integrations/hermes/test/feishu-commander-router-distribution.test.mjs`
  - **EXPECTED OUTCOME**: 全部 6 条 FAIL（这是正确的，它证明缺陷存在）
  - 把每条的实际失败输出逐条记录为反例（写入 PR 描述或本任务的执行记录），特别注明第 ⑤ 条的 terminal 分支返回值
  - **推翻条件**：若第 ⑤ 条在未修复代码上就通过，说明分发缺口假设不成立，须回到 design.md §6 重新确认；若真机六项全 `pass` 而飞书仍无回复，根因落在需求 1.8（Hermes 模型侧入口/密钥/预算/轮次上限）或飞书事件订阅侧，**必须回到需求重新假设，不得用「已修复」结案**
  - 任务在测试写完、跑完、失败已记录时标记完成
  - 【沙箱可验证】（第 ④⑤ 条用仓库内夹具，不触达真实 `adapter.py`）
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 2.9_

- [x] 2. 在未修复代码上写并运行保持性测试（**先于任何实现**）
  - **Property 2: Preservation** - 非缺陷输入行为逐字节不变
  - **IMPORTANT**: 严格遵循**观测优先（observation-first）**方法：先在未修复代码上跑出真实输出，落为基线夹具，再写断言。不得凭假设写期望值
  - 新建 `apps/ajun-runtime/test/feishu-commander-ingress-preservation.test.js`
  - **观测步骤（在未修复代码上执行并记录实际输出）**：
    - 观测 `/api/feishu/commander` 对命中 `isDirectReplyWithoutTask` 的中文文本的响应体（应为 202 + `handled:false` + `reason: 'explicit_direct_reply_without_task'`），逐字节落为基线夹具
    - 观测成功建任务时 `presentCommanderReply()` 的 `reply` / `presentation` / `taskCard.sourceRevision` / `taskCard.contentHash`，落为基线
    - 观测非本机 `remoteAddress`（含 `::ffff:` 前缀与 LAN 段）的 403 响应体与错误文案 `飞书军团总管入口只能由本机 Hermes 适配器调用。`，逐字节落为基线
    - 观测 `agentId ≠ 'ajun'` 时 guard 的返回值、非 `MessageType.TEXT` 时的短路条件、`/api/health` 的 `agent.army/runtime-health/v1`、`collectRuntimeFingerprint()` 的 `agent.army/runtime-fingerprint/v1`
    - 观测 5 类 adapter 夹具（未打补丁 / notifyV3 / notifyV4 / precedence / 已 seam）连续 3 次应用补丁的逐字节输出
  - **写属性式测试**（`node --test` 内**确定性输入枚举 + 固定种子伪随机生成器**，种子写死并在失败时打印，保证反例可复现；不引入 PBT 库）：
    - **P2-1（最高优先，需求 3.1）**：种子生成一批命中 `isDirectReplyWithoutTask` 的中文文本，断言响应体与基线**深度相等**、`handled === false`、`reason === 'explicit_direct_reply_without_task'`，且响应体中**不出现**任何诊断/降级字样 —— 正向断言不含「自检」「诊断」「未启动任何外部动作」「降级」。同时断言 Hermes 侧变换后的 `AGENT_ARMY_FEISHU_COMMANDER_DIRECT_REPLY_V1` 代码块与变换前**逐字符相等**（该分支零改动）
    - **P2-2（3.2）**：随机任务标题/描述，断言 202 投影四字段与基线一致
    - **P2-3（3.3）**：随机非本机 `remoteAddress`，断言恒 403 且错误文案逐字节不变
    - **P2-4（3.4）**：随机 `agentId ≠ 'ajun'`（含空串、非法字符、大小写变体），断言恒不进入总管路由
    - **P2-5（3.5）**：5 类夹具各连续应用补丁 3 次，断言第 2、3 次与第 1 次逐字节相等
    - **P2-6（3.6）**：枚举 `MessageType` 全部非 TEXT 取值，断言短路条件不变
    - **P2-7（3.7）**：断言 `/api/health` 与 `runtime-fingerprint` 契约版本不变
    - **P2-8（3.8）**：断言账本路径只由 `HERMES_HOME` / `dataDir` 决定，四个非 `ajun` 标签的 Home 与账本不被读写
    - **P2-9**：注入抛异常的 `record` 与只读 `dataDir`，断言 403 / 202 响应体与状态码不变（证据写入不得成为新故障模式）
  - **说明**：P2-1 / P2-3 / P2-9 中涉及新增证据落盘的断言，在未修复代码上以「账本为空即视为满足」的宽松形式写，使本测试能在未修复代码上通过；修复后收紧为「落盘存在且对外行为仍不变」由 4.10 验证
  - 运行：`node --test apps/ajun-runtime/test/feishu-commander-ingress-preservation.test.js`
  - **EXPECTED OUTCOME**: 全部 PASS（确认这是必须原样保留的基线行为）
  - 任务在测试写完、跑完、在未修复代码上通过时标记完成
  - 【沙箱可验证】
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9_

---

### 阶段二：切片 A —— 诊断 CLI（可独立交付的最小闭环）

- [x] 3. 切片 A：本机一条命令跑出结论的诊断入口

  - [x] 3.1 实现纯判定模块骨架与层级不变量
    - 新建 `apps/ajun-runtime/src/feishu-commander-chain-diagnosis.ts`：**零 I/O**，全部输入由调用方注入
    - 导出 `FEISHU_COMMANDER_CHAIN_DIAGNOSIS_SCHEMA = 'agent.army/feishu-commander-chain-diagnosis/v1'`、`CHAIN_CHECK_IDS`（6 项固定顺序）、`TruthLayer` / `CheckStatus` / `ChainCheck` / `FeishuCommanderChainDiagnosis` 类型
    - 实现 `diagnoseFeishuCommanderChain(observations, options?)`，`options` 支持 `now` / `expectedAgentId`（默认 `'ajun'`）/ `expectedPort`（默认 `4321`）/ `expectedIngressPath` / `recentEvidence`
    - `recentEvidence` 未注入时输出空数组（切片 A 不依赖切片 B）
    - 新建 `apps/ajun-runtime/test/feishu-commander-chain-diagnosis.test.js`，用单测强制 5 条不变量：`checks.length === 6`；`checks[i].id === CHAIN_CHECK_IDS[i]`；`layerRank(truthLayer) <= layerRank(truthLayerCeiling)`；`status === 'pass' ⟺ nextStep === null`；`verdict === 'blocking_gap' ⟺ checks.some(c => c.blocking && c.status !== 'pass')`
    - 断言 `safety.externalEffects === false`、`safety.readOnly === true`、`safety.secretsRead === false`
    - 独立验证：`node --test apps/ajun-runtime/test/feishu-commander-chain-diagnosis.test.js`
    - _Bug_Condition: isBugCondition(input) 中 `NOT locallyDecidableEvidence(input)` 与需求 1.9「无一次性诊断入口」_
    - _Expected_Behavior: expectedBehavior(result) 前四条不变量（design.md §Fix Checking）_
    - _Preservation: 纯新增模块，不 import 任何既有路由模块，不可能影响既有行为_
    - 【沙箱可验证】
    - _Requirements: 2.9, 2.12_

  - [x] 3.2 实现六项判定分支与「不得跨层冒充」规则
    - 在 3.1 的模块内实现 `gateway-process`、`adapter-patch`、`required-env`、`runtime-ingress`、`profile-guard`、`feishu-admission` 六项判定，每项产出中文 `title` / `conclusion` / `nextStep` / `truthLayer` / `truthLayerCeiling` / `blocking`
    - 按 design.md §2 表格设定层级上限：`gateway-process` 与 `runtime-ingress` 上限 `reachable`；`adapter-patch` / `required-env` / `profile-guard` / `feishu-admission` 上限 `configured` 且 `requiresRealMachineVerification` 恒 `true`
    - 实现禁止冒充规则（逐条写入单测）：
      - `gateway-process` 有 pid 时 `conclusion` **不得**出现「飞书消息可被消费」；pid 缺失时 `conclusion` **必须**包含「飞书消息此刻无人消费」（2.6）
      - `required-env` 变量缺失时 `truthLayer: 'declared'` + `conclusion` 含「已声明但未配置」（2.1）；plist 有值也只到 `configured`，另出 `processInjection: 'unproven'`
      - `adapter-patch` 缺 `_route_ajun_commander_event` 时 `nextStep` 唯一指向重跑 `integrations/hermes/scripts/patch-feishu-agent-proposal-router.mjs`（2.3）
      - `profile-guard` 不匹配时输出实际 `agentId` vs 期望 `ajun`，并说明「该 Profile 不拥有总管文本路由」（2.2）
      - `feishu-admission` 字段路径找不到时**禁止**输出 `hit`，`status` 必须为 `'unknown'`（不是 `pass`/`gap`），`truthLayer: 'declared'`（2.7）
      - `runtime-ingress` 在「4321 不可达但 4322 在监听」时直接给出该结论（1.10）
    - 补齐覆盖矩阵单测：对 8 个静默点各构造一组观测替身，断言对应检查 `status: 'gap'`、`blocking: true`、`nextStep` 为需求指定的唯一下一步
    - 全 6 项 `pass` 时 `verdict === 'no_local_gap_found'`，`verdictCaveat` 固定为「本机未发现阻断性缺口；这不等于飞书链路可用，需在飞书私聊发一条真实文本消息完成真机验证」
    - 新增属性式测试：6 项 × {pass, gap, unknown} 笛卡尔采样（固定种子），断言四条不变量与 `verdict`/`blocking` 集合恒一致
    - 独立验证：`node --test apps/ajun-runtime/test/feishu-commander-chain-diagnosis.test.js`
    - _Bug_Condition: SILENT_FAILURE_POINTS 全部 8 项_
    - _Expected_Behavior: expectedBehavior(result) 全部条件，含 `verdictCaveat` 与逐项 truthLayer 约束_
    - _Preservation: 判定模块只读观测结构体，不改任何路由分支；`profile-guard` 不匹配报 gap 而**不放宽 guard**（3.4）_
    - 【沙箱可验证】
    - _Requirements: 2.1, 2.2, 2.3, 2.6, 2.7, 2.9, 2.11_

  - [x] 3.3 实现观测适配层（全依赖注入 + 脱敏）
    - 新建 `apps/ajun-runtime/src/feishu-commander-chain-observations.ts`，导出 `observeFeishuCommanderChain(deps)`，`deps` 为 `runCommand` / `readTextFile` / `statFile` / `probe` / `fingerprint` / `uid` / `hermesHome` / `gatewayLabel` / `gatewayPlistPath` / `requesterRef` / `devPort` —— **生产源码不直接依赖 `ops/`**，`defaultRunCommand` 由 CLI 注入
    - 实现观测手段（全部只读）：`launchctl print gui/<uid>/ai.hermes.gateway` 解析；`adapter.py` 标记扫描（`_route_ajun_commander_event` / `PROFILE_GUARD_V1` / `INGRESS_TIMEOUT_V1` / `DIRECT_REPLY_V1` / `ADAPTER_SEAM_V1` / `SILENT_FAILURE_EVIDENCE_V1`）与**重复定义计数**；PlistBuddy 读三项白名单变量；`DeterministicLocalHealthProbe.checkOne('ajun-runtime')` + `collectRuntimeFingerprint()` + 4322 探测；`config.yaml` 白名单字段只读
    - 导出 `classifyIngressUrl(value)`，仅在匹配 `^http://127\.0\.0\.1:\d{2,5}/api/feishu/commander$` 时归一化输出，否则返回 `'non_loopback' | 'unexpected_path' | 'unparsable' | 'absent'`，**绝不回显原值**
    - 安全约束（写入单测）：`readTextFile` 只接受 `adapter.py` / `pyproject.toml` / `config.yaml` 三个具体路径；**任何观测函数都不读 `.env`**；`config.yaml` 与 `adapter.py` 原文不进入返回值（只返回布尔、计数与枚举）；环境变量非白名单键一律不读；观测失败一律返回 `status: 'unknown'` + 错误码，**不抛异常**（只读诊断不得失败关闭）
    - Hermes 版本与 Git 身份比对不匹配时只报为观测事实，不抛异常
    - 新建单测覆盖：`launchctl` / PlistBuddy 真实格式夹具（夹具标注「来源为真机采样」）、`adapter.py` 重复定义计数、`classifyIngressUrl` 五类分支、随机字符串注入（含 `sk-…`、`Bearer …`、`?token=…`、长 base64、超长 Unicode）断言输出恒不含原文
    - 独立验证：`node --test apps/ajun-runtime/test/feishu-commander-chain-observations.test.js`
    - _Bug_Condition: 需求 1.1 / 1.2 / 1.3 / 1.6 / 1.7 的观测缺口_
    - _Expected_Behavior: `containsNoSecret(result)` 与逐项 `truthLayer` 的证据来源_
    - _Preservation: 全部只读，不写任何文件，不调用既有写路径（3.7 只读 `/api/health` 与 fingerprint）_
    - 【沙箱可验证（注入替身全覆盖）】+ 【需真机验证：真实 `launchctl` / PlistBuddy / `adapter.py` / `config.yaml` 的实际输出格式】
    - _Requirements: 2.1, 2.2, 2.3, 2.6, 2.7, 2.11, 2.12_

  - [x] 3.4 实现诊断 CLI（4321 未起、依赖未装时仍能跑完）
    - 新建 `apps/ajun-runtime/scripts/diagnose-feishu-commander-chain.mjs`
    - 装配顺序：`observeFeishuCommanderChain(...)` → `diagnoseFeishuCommanderChain(...)` → 渲染
    - 参数：无参（中文逐项表格）、`--json`（输出 `agent.army/feishu-commander-chain-diagnosis/v1`）、`--requester <open_id>`（额外判定白名单命中，requester 以摘要呈现）
    - 退出码：`0` = `no_local_gap_found`；`1` = `blocking_gap`；`2` = `diagnosis_incomplete`（如 `HERMES_HOME` 不可读）
    - 人类可读输出每项固定四行：结论 / 能力真相层级（含是否需真机验证）/ 已脱敏证据 / 唯一下一步；末尾打印 `verdictCaveat`
    - **关键属性**：只 import Node 内建模块与仓库内零第三方依赖文件（`../src/*.ts` 沿用既有 TS 直引模式；`../../../scripts/runtime-fingerprint.mjs` 与 `ops/ajun-release-helper/system-adapter.mjs` 的 `defaultRunCommand` 在 node 调用层引入）—— 依赖未安装、4321 未起、Gateway 未起时仍能跑完
    - **不新增任何 HTTP 端点**，不新建平行控制面（2.12）
    - 独立验证：`node apps/ajun-runtime/scripts/diagnose-feishu-commander-chain.mjs --json`（沙箱内应得 degraded 结论且退出码 ∈ {0,1,2}）
    - _Bug_Condition: 需求 1.9「无一次性诊断入口」+ design.md 探索用例 ⑥（4321 与 Gateway 同时未起）_
    - _Expected_Behavior: 诊断入口在 4321 未监听时仍能跑完并逐项输出六项判定_
    - _Preservation: 进程外 CLI，不修改运行时任何分支；不放宽 `isLocalAddress`（3.3）_
    - 【沙箱可验证】+ 【需真机验证：真实六项判定结论与退出码】
    - _Requirements: 2.9, 2.11, 2.12_

  - [x] 3.5 登记 script 与模块策略
    - 根 `package.json` 新增 `"diagnose:feishu-chain": "node apps/ajun-runtime/scripts/diagnose-feishu-commander-chain.mjs"`（命名对齐既有 `runtime:fingerprint`）
    - `apps/ajun-runtime/package.json` 新增同名 script 指向 `node scripts/diagnose-feishu-commander-chain.mjs`
    - `apps/ajun-runtime/module-policy.json` 登记 `src/feishu-commander-chain-diagnosis.ts` 与 `src/feishu-commander-chain-observations.ts`，各自填 `affectedTests` 与 `lineLimit`
    - **不改** `repository-catalog.json`（未新增目录）、**不改** `.gitignore`、**不改**前端（无需 `npm run build:frontend`）
    - 独立验证：`npm run diagnose:feishu-chain -- --json` 与 `npm run check:architecture`
    - _Bug_Condition: 需求 1.9 —— 入口不可发现等于不存在_
    - _Expected_Behavior: 用户以 `npm run diagnose:feishu-chain` 一条命令触发_
    - _Preservation: 仅追加 script 与策略条目，不改既有条目（3.9 测试框架不变）_
    - 【沙箱可验证】
    - _Requirements: 2.9, 2.12_

  - [x] 3.6 切片 A 端到端集成测试（最坏环境）
    - 新建 `apps/ajun-runtime/test/feishu-commander-chain-cli.test.js`
    - 用临时 `HERMES_HOME` 夹具 + 关闭的 4321 + 不存在的 launchd 标签，spawn CLI，断言：六项检查齐全且顺序等于 `CHAIN_CHECK_IDS`、退出码正确、`--json` 输出符合 `agent.army/feishu-commander-chain-diagnosis/v1`
    - 断言最坏情况（`HERMES_HOME` 不存在 + 4321 未监听 + Gateway 未加载）下进程**不崩溃**、不抛未捕获异常
    - 断言 `--json` 输出经 `grep -Ei 'sk-|bearer|token|cookie|password'` 无匹配（2.11）
    - 断言 `recentEvidence` 在切片 B 未落地时为空数组（切片 A 独立性）
    - 独立验证：`node --test apps/ajun-runtime/test/feishu-commander-chain-cli.test.js`
    - _Bug_Condition: design.md 探索用例 ⑥_
    - _Expected_Behavior: 诊断入口不与被诊断对象同生共死_
    - _Preservation: 测试只读，不启动 4321，不触达真实 Hermes_
    - 【沙箱可验证】
    - _Requirements: 2.9, 2.11_

  - [x] 3.7 验证 Bug 条件探索测试的切片 A 部分现在通过
    - **Property 1: Expected Behavior** - 静默失败必须可归因且可自检（切片 A 范围）
    - **IMPORTANT**: 重新运行任务 1 的**同一个测试**，不要写新测试
    - 运行 `node --test apps/ajun-runtime/test/feishu-commander-chain-exploration.test.js`
    - **EXPECTED OUTCOME**: 第 ①（诊断入口存在）、④（补丁存活性可判定）、⑥（4321 关闭时仍可跑）三条从 FAIL 转为 PASS
    - 第 ②③⑤ 条仍应 FAIL —— 它们属于切片 B，由任务 4.9 关闭。在执行记录中明确标注这一预期分界
    - _Requirements: Expected Behavior Properties from design（2.1, 2.2, 2.3, 2.6, 2.7, 2.9, 2.11, 2.12）_
    - 【沙箱可验证】

  - [x] 3.8 验证保持性测试在切片 A 后仍全部通过
    - **Property 2: Preservation** - 非缺陷输入行为逐字节不变（切片 A 范围）
    - **IMPORTANT**: 重新运行任务 2 的**同一批测试**，不要写新测试
    - 运行 `node --test apps/ajun-runtime/test/feishu-commander-ingress-preservation.test.js`
    - **EXPECTED OUTCOME**: 全部 PASS，无回归。重点确认：
      - **需求 3.1**：`handled:false` / `explicit_direct_reply_without_task` 仍原样交回 Hermes 普通聊天，响应体**不含**任何诊断文案（切片 A 未触碰该路径，此处是零改动的正向确认）
      - **需求 3.3**：`/api/feishu/commander` 的 403 语义与文案未因诊断需要被放宽
      - **需求 3.7**：`/api/health` 与 `runtime-fingerprint` 契约不变，诊断入口只读不写
    - 追加运行 `npm run check` 确认既有测试与架构校验未回归
    - _Requirements: 3.1, 3.3, 3.4, 3.6, 3.7, 3.8, 3.9_
    - 【沙箱可验证】

**切片 A 交付点**：3.1 – 3.8 全部完成后，切片 A 可独立成 PR 交付。用户拉取后即可 `npm run diagnose:feishu-chain` 定位故障环节，无需等待切片 B。

---

### 阶段三：切片 B —— 可归因性兜底

- [ ] 4. 切片 B：两侧证据账本、补丁分发与文档修正

  - [ ] 4.1 实现运行时侧证据账本
    - 新建 `apps/ajun-runtime/src/feishu-commander-chain-evidence.ts`：`FEISHU_COMMANDER_CHAIN_EVIDENCE_SCHEMA = 'agent.army/feishu-commander-chain-evidence/v1'`、`CommanderChainEvidenceKind`（`ingress_rejected_non_local` / `no_task_by_design` / `diagnosis_completed`）、`CommanderChainEvidenceRecord`、`createFeishuCommanderChainEvidenceLedger(options)`、`digestRef(value)`
    - 落盘 `${dataDir}/feishu-commander-chain/runtime-evidence-<YYYY-MM-DD>.jsonl`；`dataDir` 沿用 `src/runtime/runtime-configuration.ts` 既有解析（`AGENT_ARMY_DATA_DIR || <repoRoot>/apps/ajun-runtime/data`）
    - 目录 `0700`、文件 `0600`；路径经既有 `prepareWorkspaceFile()` 越界与符号链接守卫；解析后不在 `dataDir` 内即拒写
    - 脱敏：`chatRef` / `requesterRef` 只以 `sha256:<12hex>` 出现；保留 `sourceEventRef = 'feishu:<message_id>'`；写入前经 `assertNoSecretShaped(record)` 拒绝 `sk-`、`Bearer `、`?token=`、长 base64 等形态；不含消息正文与 `.env` 内容
    - `externalActionStarted` 恒 `false`；保留期默认 14 天，`readRecent` 默认最近 3 天、最多 200 条，`record` 顺带清理过期文件
    - **`record` 捕获全部异常并返回 `null`，写入失败绝不影响主流程**
    - 新建 `apps/ajun-runtime/test/feishu-commander-chain-evidence.test.js`：schema、`0600` 权限、按日切分、保留期清理、越界路径拒写、`assertNoSecretShaped`、`digestRef` 稳定性与不可逆、随机 secret 形态注入属性式测试（固定种子）
    - 独立验证：`node --test apps/ajun-runtime/test/feishu-commander-chain-evidence.test.js`
    - _Bug_Condition: 需求 1.4 / 1.5 / 1.8 —— 失败只写无 schema 的 `*.log`，无法与某条飞书消息对齐_
    - _Expected_Behavior: 本机留下带 `sourceEventRef` 的可判定证据，且输出零凭据_
    - _Preservation: 纯新增模块；`.gitignore` 无需改动（默认路径已被 `apps/ajun-runtime/data/` 覆盖）_
    - 【沙箱可验证】
    - _Requirements: 2.4, 2.5, 2.8, 2.11_

  - [ ] 4.2 在 403 与 202 分支之后追加证据落盘（返回体逐字节不变）
    - 改 `apps/ajun-runtime/src/runtime-http-handler.ts`，**只在两处已存在的分支之后追加一次 `await evidence.record(...)`**
    - **403 分支**（现 `runtime-http-handler.ts:302-304`）：`isLocalAddress` 判定与 `sendJson(response, 403, { error: '飞书军团总管入口只能由本机 Hermes 适配器调用。' })` **逐字节保留**；在 `sendJson` 之前追加 `ingress_rejected_non_local` 证据，`nextStep` 指向 `npm run diagnose:feishu-chain`
    - **202 分支**（现 `runtime-http-handler.ts:305-311`）：在既有 `presentCommanderReply(...)` 之后、`sendJson` 之前，若 `result?.handled === false` 追加 `no_task_by_design` 证据（含 `reason`，来自 `feishu-commander-routing.ts:28` 的 `explicit_direct_reply_without_task`）。**`presentCommanderReply` 返回值不做任何修改**，`reply` / `taskCard` 原样返回
    - 账本实例由 `dataDir` 在运行时组合层构造并注入 handler 依赖；**未注入时使用 no-op 账本**，保证既有测试与非飞书部署不受影响
    - **不新增任何 HTTP 路由**
    - `module-policy.json` 更新 `src/runtime-http-handler.ts` 的 `affectedTests`
    - 独立验证：`node --test apps/ajun-runtime/test/runtime-http-feishu.test.js apps/ajun-runtime/test/feishu-commander-ingress-preservation.test.js`
    - _Bug_Condition: isBugCondition 中 `ingress_rejected_non_local`（1.5）与 `no_task_by_design_then_model_error`（1.8）_
    - _Expected_Behavior: 403 与 `handled:false` 在本机留下同一事件的可判定证据，使「有意静默」与「链路故障」可区分_
    - _Preservation: 3.1（`handled:false` 回复文案零变化）、3.2（202 投影不变）、3.3（403 状态码与文案逐字节不变，不放宽本机校验）_
    - 【沙箱可验证】
    - _Requirements: 2.5, 2.8_

  - [ ] 4.3 实现 Hermes 侧证据模块（纯 stdlib，永不抛异常）
    - 新建 `integrations/hermes/runtime/agent_army_feishu_commander_evidence.py`，对齐既有 `agent_army_feishu_layout.py` / `agent_army_feishu_task_card.py` 的 Module 模式
    - 导出 `EVIDENCE_SCHEMA = "agent.army/feishu-commander-chain-evidence/v1"` 与 `record_commander_chain_evidence(*, hermes_home, kind, source_event_ref, chat_ref=None, requester_ref=None, http_status=None, reason=None, profile_agent_id=None, now=None) -> bool`
    - 追加到 `hermes_home/agent_army_commander_evidence-<YYYY-MM-DD>.jsonl`，文件 `0600`，目录沿用 `get_hermes_home()`
    - 纯 stdlib（`json` / `hashlib` / `datetime` / `pathlib` / `os`）；**任何失败返回 `False`，绝不抛异常**，不成为新的故障模式
    - 不写消息正文；`chat_ref` / `requester_ref` 只写 sha256 前 12 位；`side` 恒为 `hermes-gateway`
    - `kind` 取值：`ingress_unreachable`、`ingress_http_error`（带 `http_status`）、`ingress_bad_response`、`degraded_notice_sent`、`degraded_notice_send_failed`
    - 新建 `integrations/hermes/test/feishu-commander-evidence.test.mjs`，由 `node --test` 驱动 `python3` 覆盖：正常写入、目录不存在、权限不足、`kind` 非法 —— 全部返回布尔且不抛
    - 独立验证：`node --test integrations/hermes/test/feishu-commander-evidence.test.mjs`
    - _Bug_Condition: 需求 1.4 —— 4321 不可达时运行时侧无法落盘，只有 Hermes 侧能留证据_
    - _Expected_Behavior: `self.send` 亦失败时本机留下带 `sourceEventRef` 的失败证据_
    - _Preservation: 新增独立 py module，不 import 也不修改 adapter 既有分支_
    - 【沙箱可验证（python3 单测）】+ 【需真机验证：Hermes venv 内的实际写入与权限】
    - _Requirements: 2.4_

  - [ ] 4.4 新增 Hermes 补丁单元 `AGENT_ARMY_FEISHU_COMMANDER_SILENT_FAILURE_EVIDENCE_V1`
    - 改 `integrations/hermes/scripts/feishu-commander-ingress-protocol.mjs`，新增 `upgradeCommanderSilentFailureEvidence(source)`，写法对齐既有 `upgradeCommanderDirectReplyBypass` / `upgradeCommanderProfileGuard`，复用同文件 `transformPythonMethod` 与 `patch-support.mjs` 的 `replaceRequired`
    - 首行标记短路：已含 `AGENT_ARMY_FEISHU_COMMANDER_SILENT_FAILURE_EVIDENCE_V1` 直接返回；未含 `AJUN_FEISHU_COMMANDER_INGRESS_URL` 直接返回（未安装总管路由则跳过）
    - 三个锚点：**A 模块导入**（在 `from .agent_army_task_card import install_agent_army_feishu_task_card_adapter` 后追加 evidence import）；**B 异常处理**（保留原 `logger.warning` 一字不改，其后追加带标记注释的 `record_commander_chain_evidence(...)`，`kind` 由异常类型派生）；**C 降级发送**（把 `self.send` 包进 `try/except`，成功记 `degraded_notice_sent`、异常记 `degraded_notice_send_failed` 后吞掉，`return True` 保留）
    - 调用点接到 `upgradeFeishuCommanderIngressProtocol` **末位**（在 timeout 升级之后，使锚点 C 收敛到升级后的文案，单锚点即可）
    - **明确不碰**：`AGENT_ARMY_FEISHU_COMMANDER_DIRECT_REPLY_V1` 分支（`handled is False` → `setattr(event, "_ajun_commander_routed", False)` → `return False`）**一字不改** —— 这是需求 3.1 的结构性保证
    - 改 `integrations/hermes/test/patch-feishu-agent-proposal-router.test.mjs` 补三个锚点 case 与幂等 case；断言变换后 `DIRECT_REPLY_V1` 代码块与变换前逐字符相等
    - 独立验证：`node --test integrations/hermes/test/patch-feishu-agent-proposal-router.test.mjs`
    - _Bug_Condition: 需求 1.4 —— Hermes 侧 `except` 只 `logger.warning`，降级发送失败则彻底无声_
    - _Expected_Behavior: 4321 不可达时飞书会话内出现可归因说明；`self.send` 亦失败时本机留证据_
    - _Preservation: 3.1（`DIRECT_REPLY_V1` 零改动）、3.5（`_V1` 标记幂等）、3.6（非 TEXT 短路条件不变）_
    - 【沙箱可验证（纯字符串变换）】
    - _Requirements: 2.4_

  - [ ] 4.5 修补丁分发缺口：terminal 分支执行 post-seam 幂等升级
    - 改 `integrations/hermes/scripts/feishu-commander-router-patches.mjs`
    - 新增 `POST_SEAM_IDEMPOTENT_UPGRADES = Object.freeze([upgradeCommanderSilentFailureEvidence])`
    - `migrateFeishuCommanderRouter` 命中 `terminal: true`（`installed-adapter-seam-v1`）时，先 `assertInstalledAdapterSeam(source)`，再 `reduce` 应用 `POST_SEAM_IDEMPOTENT_UPGRADES`，返回 `{ source: upgraded, terminal: true, migration: migration.name }`；其余分支不变
    - 把 `'from .agent_army_commander_evidence import record_commander_chain_evidence'` 加入 `assertInstalledAdapterSeam` 的 `required` 列表，但**仅在该 import 已被本次升级注入之后校验**，避免对旧安装误报失败关闭
    - **这是任务 1 第 ⑤ 条反例直接要求的修复**：不修则用户真机上已完整迁移的 adapter（最可能的状态）永远收不到新补丁
    - 独立验证：`node --test integrations/hermes/test/feishu-commander-router-distribution.test.mjs`
    - _Bug_Condition: design.md 探索用例 ⑤ —— 已迁移 adapter 处于 terminal 分支，新补丁分发不到_
    - _Expected_Behavior: 对含 `ADAPTER_SEAM_V1` 的源码，`migrateFeishuCommanderRouter` 输出包含新标记_
    - _Preservation: 3.5（重复执行按 `_V1` 幂等，标记恰好出现一次）；非 terminal 分支逻辑不变_
    - 【沙箱可验证】
    - _Requirements: 2.3, 2.4_

  - [ ] 4.6 原子安装第三个 py module
    - 改 `integrations/hermes/scripts/patch-feishu-agent-proposal-router.mjs`，按既有 `semanticLayoutSource` / `taskCardRuntimeSource` 模式新增 `commanderEvidenceSource` → 安装为 adapter 同目录的 `agent_army_commander_evidence.py`
    - 纳入既有 `Promise.all` 读取与 `atomicWriteFile` 的 `changed` 聚合；内容相等时短路，不改文件 mtime
    - 补丁命令清单条数不变（新单元随本脚本一起分发）
    - 补测试：连续执行 3 次断言第 2、3 次输出「已存在…」且文件逐字节不变（幂等）
    - 独立验证：`node --test integrations/hermes/test/patch-feishu-agent-proposal-router.test.mjs`
    - _Bug_Condition: 需求 1.3 —— 补丁丢失后无人提示，且新 module 不随补丁分发则 4.4 的 import 会失败_
    - _Expected_Behavior: 重跑 `patch-feishu-agent-proposal-router.mjs` 即恢复完整补丁与证据模块_
    - _Preservation: 3.5（幂等，不重复注入）_
    - 【沙箱可验证（变换与安装逻辑）】+ 【需真机验证：真实 Hermes 安装的写入与版本门禁】
    - _Requirements: 2.3_

  - [ ] 4.7 诊断 CLI 合并读取两侧账本并留痕
    - 在 `diagnose-feishu-commander-chain.mjs` 中接入 `readRecent()`（运行时侧）与 Hermes 侧 `agent_army_commander_evidence-*.jsonl` 只读解析，合并后按 `recordedAt` 排序注入 `options.recentEvidence`
    - 输出末尾打印最近证据摘要（已脱敏）
    - 诊断结束后**尽力**写一条 `diagnosis_completed` 证据；写入失败仅提示，不影响输出与退出码
    - 补集成测试：同一 `sourceEventRef` 由两侧分别写入，断言 CLI 合并读取后按 `recordedAt` 排序、同一事件可关联；`adapter-patch` 在夹具打完补丁后由 `gap` 变 `pass` 且 `truthLayer` 仍不超过 `configured`（不因刚打完补丁就冒充运行可达）
    - 独立验证：`node --test apps/ajun-runtime/test/feishu-commander-chain-cli.test.js`
    - _Bug_Condition: 需求 1.5 / 1.8 —— 证据存在但无人合并呈现等于不可归因_
    - _Expected_Behavior: 诊断入口逐项输出 + 最近证据摘要，`truthLayer` 不超上限_
    - _Preservation: 3.7（只读 `/api/health` 与 fingerprint）、3.8（账本路径只由 `HERMES_HOME` / `dataDir` 决定，不读其他四个 Gateway）_
    - 【沙箱可验证】
    - _Requirements: 2.4, 2.5, 2.8, 2.9, 2.11_

  - [ ] 4.8 修正文档中的 4321 / 4322 表述
    - 改根 `README.md`「运行 A君运行台」段落（现 `README.md:138-146`，其中 `README.md:146` 把开发地址错写为 4321），区分两个实例：
      - **正式 4321**：launchd 受控（`ai.agent-army.ajun-runtime`），跑不可变 release，**飞书链路在此生效**；改工作树代码不影响它，需走 `npm run release:immutable`；实时事实用 `npm run runtime:fingerprint` 读取，不手写 release hash
      - **开发 4322**：`npm run dev`，`AJUN_DISABLE_BACKGROUND_SERVICES=true`，关闭 Paperclip / 飞书 / 小D 后台协调服务，**飞书链路不通**，「本机能收到飞书消息」在 4322 上验证不了
    - 在该段落指向 `npm run diagnose:feishu-chain` 作为飞书无回复时的唯一自检入口
    - 改 `integrations/hermes/README.md`：登记新标记 `AGENT_ARMY_FEISHU_COMMANDER_SILENT_FAILURE_EVIDENCE_V1`、新 py module `agent_army_commander_evidence.py`、Hermes 侧证据文件路径；补丁命令清单条数不变
    - 独立验证：`npm run check:architecture` + 人工复核两处文档不再把 `npm run dev` 标为 4321
    - _Bug_Condition: 需求 1.10 —— 用户在 4322 开发实例上「验证成功」，误判飞书链路已就绪_
    - _Expected_Behavior: 文档明确区分正式 4321 与开发 4322_
    - _Preservation: 仅改文档表述，不改任何脚本行为_
    - 【沙箱可验证】
    - _Requirements: 1.10, 2.10_

  - [ ] 4.9 验证 Bug 条件探索测试全部通过
    - **Property 1: Expected Behavior** - 静默失败必须可归因且可自检（全量）
    - **IMPORTANT**: 重新运行任务 1 的**同一批测试**，不要写新测试
    - 运行 `node --test apps/ajun-runtime/test/feishu-commander-chain-exploration.test.js integrations/hermes/test/feishu-commander-router-distribution.test.mjs`
    - **EXPECTED OUTCOME**: 6 条全部 PASS（确认缺陷已修）。逐条对照：① 诊断入口存在；② 403 落盘 `ingress_rejected_non_local`；③ `handled:false` 落盘 `no_task_by_design`；④ 补丁存活性可判定；⑤ 已迁移 adapter 收到新标记；⑥ 4321 关闭时诊断仍可跑
    - 追加断言 `containsNoSecret(result)` 与 `safety.externalEffects === false`
    - _Requirements: Expected Behavior Properties from design（2.1 – 2.9, 2.11, 2.12）_
    - 【沙箱可验证】

  - [ ] 4.10 验证保持性测试在切片 B 后仍全部通过
    - **Property 2: Preservation** - 非缺陷输入行为逐字节不变（全量）
    - **IMPORTANT**: 重新运行任务 2 的**同一批测试**，不要写新测试；把 P2-1 / P2-3 / P2-9 的宽松形式收紧为「落盘存在**且**对外行为逐字节不变」
    - 运行 `node --test apps/ajun-runtime/test/feishu-commander-ingress-preservation.test.js`
    - **EXPECTED OUTCOME**: 全部 PASS，无回归。逐条确认：
      - **需求 3.1（最高优先）**：`handled:false` / `explicit_direct_reply_without_task` 仍由 Hermes 普通聊天路径回复，响应体与基线深度相等，**不含**「自检」「诊断」「未启动任何外部动作」「降级」任何字样；Hermes 侧 `DIRECT_REPLY_V1` 代码块与变换前逐字符相等
      - 3.2 202 投影四字段不变；3.3 403 状态码与文案逐字节不变；3.4 非 `ajun` Profile 继续被拒且诊断只报 gap；3.5 补丁 3 次幂等且新标记恰好一次；3.6 非 TEXT 不进入路由；3.7 健康与 fingerprint 契约不变；3.8 其他四个 Gateway 隔离；3.9 无新测试框架
      - P2-9：注入抛异常的 `record` 与只读 `dataDir` 时，403 / 202 响应体与状态码不变；Python 侧 `record_commander_chain_evidence` 返回 `False` 且不抛
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9_
    - 【沙箱可验证】

---

### 阶段四：收尾

- [ ] 5. Checkpoint - 确保全部测试通过
  - 运行 `npm run check` 与 `npm test`，确保全部测试通过；有问题时向用户提问，不要自行放宽断言
  - 运行 `npm run diagnose:feishu-chain -- --json | grep -Ei 'sk-|bearer|token|cookie|password'`，确认无匹配（2.11）
  - 确认未新增目录（`repository-catalog.json` 无需改动）、未改 `.gitignore`、未改前端
  - 【沙箱可验证】
  - _Requirements: 2.11, 3.7, 3.9_

- [ ] 6. 整理真机验证清单交付给用户
  - 把 design.md《真机验证账本》的 7 步整理为用户可直接照做的清单，输出到 `.kiro/specs/feishu-commander-no-reply-fix/real-machine-verification.md`（**只写 markdown，不含代码改动**），并在 PR 描述中同步
  - 每步必须包含：要执行的命令、预期输出、判定标准、失败时的唯一下一步
  - 七步：① `npm run diagnose:feishu-chain`（4321 未起也必须跑完）；② `--json | grep` 确认零凭据；③ 报补丁不在位则重跑两个补丁脚本（维护窗口内，幂等）；④ 报环境变量未注入则写 launchd 后 `launchctl kickstart -k` 重载再复跑；⑤ `npm run runtime:fingerprint` 核对 4321 为 `immutable_release` 而非 4322 开发实例；⑥ 在飞书私聊「A君·军团总管」发一条真实文本消息（**唯一能证明「飞书可用」的一步**）；⑦ 可选地 bootout 运行时制造一次失败，确认 `$HERMES_HOME/agent_army_commander_evidence-*.jsonl` 权限 `0600`、含 `sourceEventRef`、不含消息正文与凭据，然后 bootstrap 恢复
  - 清单开头写明**未验证声明**：所有涉及飞书、Hermes、StepFun 与 launchd 真机状态的结论，在步骤 1–7 完成前一律标记未验证；「代码已写」不等于「能力可用」
  - 清单结尾写明**推翻条件**：若六项全 `pass` 且 `adapter.py` 补丁在位而飞书仍无回复，根因落在需求 1.8（Hermes 模型侧入口 / 密钥 / 预算 / 轮次上限）或飞书应用事件订阅侧，须回到需求重新假设，**不得用「已修复」结案**
  - 【需真机验证】（清单本身沙箱可写，清单要验证的结论只能在用户 Mac 上关闭）
  - _Requirements: 2.9, 2.10, 2.11, 1.8_

---

## Task Dependency Graph

```
                      ┌──────────────────────────────────────┐
                      │ 阶段一：探索 + 保持性基线（先于实现） │
                      └──────────────────────────────────────┘
                     1. Property 1: Bug Condition 探索测试
                     （6 条反例，其中 ⑤ 决定 4.5 必须一起修）
                                    │
                     2. Property 2: Preservation 基线
                     （观测优先，在未修复代码上 PASS）
                                    │
        ┌───────────────────────────┴───────────────────────────┐
        ▼                                                       ▼
┌────────────────────────── 切片 A（可独立交付） ──────────────────────────┐
│  3.1 纯判定模块骨架 + 不变量                                            │
│        │                                                                │
│        ▼                                                                │
│  3.2 六项判定分支 + 层级上限规则 ◄──┐                                   │
│        │                            │                                   │
│        │              3.3 观测适配层（全依赖注入 + 脱敏）                │
│        │                            │  （3.2 与 3.3 可并行，3.4 需二者） │
│        └──────────┬─────────────────┘                                   │
│                   ▼                                                     │
│              3.4 诊断 CLI（4321/依赖缺失时仍可跑）                       │
│                   │                                                     │
│                   ▼                                                     │
│              3.5 script + module-policy 登记                            │
│                   │                                                     │
│                   ▼                                                     │
│              3.6 端到端集成测试（最坏环境）                              │
│                   │                                                     │
│         ┌─────────┴─────────┐                                           │
│         ▼                   ▼                                           │
│  3.7 验证 Property 1   3.8 验证 Property 2                              │
│   （①④⑥ 转 PASS）      （全 PASS，重点 3.1/3.3/3.7）                    │
└─────────────────────────────┬───────────────────────────────────────────┘
                              │  ★ 切片 A 交付点：用户可自行定位故障环节
                              ▼
┌────────────────────────── 切片 B ───────────────────────────────────────┐
│  4.1 运行时侧证据账本 ──────┬──────► 4.2 403/202 追加落盘               │
│                             │                                          │
│  4.3 Hermes 侧 py 证据模块 ─┼──────► 4.4 新补丁单元 SILENT_FAILURE_V1   │
│                             │              │                           │
│                             │              ▼                           │
│                             │        4.5 terminal 分支 post-seam 升级   │
│                             │        （关闭反例 ⑤ 的分发缺口）          │
│                             │              │                           │
│                             │              ▼                           │
│                             │        4.6 安装第三个 py module           │
│                             │                                          │
│                             └──────► 4.7 CLI 合并两侧账本 + 留痕        │
│                                            │                           │
│  4.8 文档修正（README / hermes README，独立，可并行）                    │
│                                            │                           │
│         ┌──────────────────────────────────┴──────────┐                 │
│         ▼                                             ▼                 │
│  4.9 验证 Property 1（6 条全 PASS）      4.10 验证 Property 2（全量）    │
└─────────────────────────────┬───────────────────────────────────────────┘
                              ▼
                     5. Checkpoint（npm run check / npm test / 零凭据检查）
                              ▼
                     6. 真机验证清单（7 步，交给用户在自己 Mac 上关闭结论）
```

**关键依赖说明**

| 依赖 | 原因 |
|---|---|
| 1 → 所有实现任务 | 探索测试必须在未修复代码上跑出反例，否则无法确认根因假设 |
| 2 → 所有实现任务 | 保持性基线必须在改动前采集真实输出（观测优先） |
| 1 的反例 ⑤ → 4.5 | 已迁移 adapter 处于 terminal 分支，不修分发缺口则真机永远收不到新补丁 |
| 3.2 + 3.3 → 3.4 | CLI 装配需要判定模块与观测层同时就绪 |
| 3.1 → 3.2 | 六项判定实现在骨架与不变量之上 |
| 4.3 → 4.4 | 补丁单元注入的 import 指向 4.3 的 py module |
| 4.4 → 4.5 | `POST_SEAM_IDEMPOTENT_UPGRADES` 引用 `upgradeCommanderSilentFailureEvidence` |
| 4.4 → 4.6 | 安装脚本必须与新单元一起分发，否则 import 在真机失败 |
| 4.1 + 4.3 → 4.7 | 合并读取需要两侧账本格式都已确定 |
| 3.7/3.8 → 切片 A 交付 | 切片 A 只在两个 Property 的切片 A 范围验证通过后才可独立交付 |
| 4.8 独立 | 文档修正无代码依赖，可与 4.1 – 4.7 任意并行 |
| 5 → 6 | 真机清单必须在沙箱内全部测试通过后才交给用户执行 |

**并行批次（wave）定义**

同一 wave 内的任务可并行执行，wave 之间严格串行。父任务 3 与 4 是容器，其完成由所属子任务全部完成隐含，不单列入 wave。

```json
{
  "waves": [
    {
      "wave": 1,
      "tasks": ["1", "2"],
      "dependsOn": [],
      "rationale": "探索反例与保持性基线都必须在未修复代码上采集；两者互不依赖，可并行，但必须先于所有实现任务。"
    },
    {
      "wave": 2,
      "tasks": ["3.1"],
      "dependsOn": [1],
      "rationale": "纯判定模块骨架与五条不变量是切片 A 其余判定实现的地基。"
    },
    {
      "wave": 3,
      "tasks": ["3.2", "3.3"],
      "dependsOn": [2],
      "rationale": "3.2 六项判定分支建立在 3.1 的骨架之上；3.3 观测适配层与 3.2 无耦合（全依赖注入），二者可并行。"
    },
    {
      "wave": 4,
      "tasks": ["3.4"],
      "dependsOn": [3],
      "rationale": "CLI 装配需要判定模块（3.2）与观测层（3.3）同时就绪。"
    },
    {
      "wave": 5,
      "tasks": ["3.5"],
      "dependsOn": [4],
      "rationale": "script 与 module-policy 登记的目标是 3.4 产出的 CLI 文件。"
    },
    {
      "wave": 6,
      "tasks": ["3.6"],
      "dependsOn": [5],
      "rationale": "端到端集成测试通过 npm script spawn CLI，需要 3.5 的入口已登记。"
    },
    {
      "wave": 7,
      "tasks": ["3.7", "3.8"],
      "dependsOn": [6],
      "rationale": "两个 Property 的切片 A 范围验证，互不依赖可并行；二者通过即为切片 A 交付点。"
    },
    {
      "wave": 8,
      "tasks": ["4.1", "4.3", "4.8"],
      "dependsOn": [7],
      "rationale": "切片 B 起点：两侧证据账本格式（4.1 运行时侧、4.3 Hermes 侧）互相独立；4.8 文档修正无代码依赖，可与整个 4.x 并行。"
    },
    {
      "wave": 9,
      "tasks": ["4.2", "4.4", "4.7"],
      "dependsOn": [8],
      "rationale": "4.2 需要 4.1 的账本；4.4 补丁单元注入的 import 指向 4.3 的 py module；4.7 合并读取需要 4.1 与 4.3 两侧格式都已确定。"
    },
    {
      "wave": 10,
      "tasks": ["4.5", "4.6"],
      "dependsOn": [9],
      "rationale": "两者都只依赖 4.4：4.5 的 POST_SEAM_IDEMPOTENT_UPGRADES 引用 upgradeCommanderSilentFailureEvidence，4.6 负责随补丁分发新 py module；互不依赖可并行。"
    },
    {
      "wave": 11,
      "tasks": ["4.9", "4.10"],
      "dependsOn": [10],
      "rationale": "全量重跑 Property 1 / Property 2，必须在 4.x 全部实现落地之后；两者互不依赖可并行。"
    },
    {
      "wave": 12,
      "tasks": ["5"],
      "dependsOn": [11],
      "rationale": "Checkpoint 汇总 npm run check / npm test / 零凭据检查。"
    },
    {
      "wave": 13,
      "tasks": ["6"],
      "dependsOn": [12],
      "rationale": "真机验证清单必须在沙箱内全部测试通过后才交给用户执行。"
    }
  ]
}
```

## Notes

执行过程中已确认的实测事实，后续任务不得与之相矛盾：

- **`AGENT_ARMY_FEISHU_AGENT_ID` 为空串或未设置是正常状态，不是缺口**：Hermes 侧读取时带 `or "ajun"` 回退并做 `.strip()`，因此空值等价于 `ajun`。诊断的 `required-env` 判定不得把该变量的空值报成 `gap`。
- **`migrateFeishuCommanderRouter` 单独调用在最小未打补丁夹具上不是逐字节幂等的**：需求 3.5 的幂等性由脚本入口 `applyPatch` 保证（其上游会先补齐前置单元），保持性测试的幂等断言应针对 `applyPatch` 而非单独的 migrate 函数。
- **飞书准入白名单在 `config.yaml` 中的真实字段名未在真机验证**：候选字段路径全部不命中时，`feishu-admission` 检查必须报 `status: 'unknown'`（不是 `pass` 也不是 `gap`、`truthLayer: 'declared'`），不得猜字段名、不得输出 `hit`。

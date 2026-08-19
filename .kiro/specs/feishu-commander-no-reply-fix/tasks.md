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

- [x] 4. 切片 B：两侧证据账本、补丁分发与文档修正

  - [x] 4.1 实现运行时侧证据账本
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

  - [x] 4.2 在 403 与 202 分支之后追加证据落盘（返回体逐字节不变）
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

  - [x] 4.3 实现 Hermes 侧证据模块（纯 stdlib，永不抛异常）
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

  - [x] 4.4 新增 Hermes 补丁单元 `AGENT_ARMY_FEISHU_COMMANDER_SILENT_FAILURE_EVIDENCE_V1`
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

  - [x] 4.5 修补丁分发缺口：terminal 分支执行 post-seam 幂等升级
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

  - [x] 4.6 原子安装第三个 py module
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

  - [x] 4.7 诊断 CLI 合并读取两侧账本并留痕
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

  - [x] 4.8 修正文档中的 4321 / 4322 表述
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

  - [x] 4.9 验证 Bug 条件探索测试全部通过
    - **Property 1: Expected Behavior** - 静默失败必须可归因且可自检（全量）
    - **IMPORTANT**: 重新运行任务 1 的**同一批测试**，不要写新测试
    - 运行 `node --test apps/ajun-runtime/test/feishu-commander-chain-exploration.test.js integrations/hermes/test/feishu-commander-router-distribution.test.mjs`
    - **EXPECTED OUTCOME**: 6 条全部 PASS（确认缺陷已修）。逐条对照：① 诊断入口存在；② 403 落盘 `ingress_rejected_non_local`；③ `handled:false` 落盘 `no_task_by_design`；④ 补丁存活性可判定；⑤ 已迁移 adapter 收到新标记；⑥ 4321 关闭时诊断仍可跑
    - 追加断言 `containsNoSecret(result)` 与 `safety.externalEffects === false`
    - _Requirements: Expected Behavior Properties from design（2.1 – 2.9, 2.11, 2.12）_
    - 【沙箱可验证】

  - [x] 4.10 验证保持性测试在切片 B 后仍全部通过
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

- [x] 5. Checkpoint - 确保全部测试通过
  - 运行 `npm run check` 与 `npm test`，确保全部测试通过；有问题时向用户提问，不要自行放宽断言
  - 运行 `npm run diagnose:feishu-chain -- --json | grep -Ei 'sk-|bearer|token|cookie|password'`，确认无匹配（2.11）
  - 确认未新增目录（`repository-catalog.json` 无需改动）、未改 `.gitignore`、未改前端
  - 【沙箱可验证】
  - _Requirements: 2.11, 3.7, 3.9_

- [x] 6. 整理真机验证清单交付给用户
  - 把 design.md《真机验证账本》的 7 步整理为用户可直接照做的清单，输出到 `.kiro/specs/feishu-commander-no-reply-fix/real-machine-verification.md`（**只写 markdown，不含代码改动**），并在 PR 描述中同步
  - 每步必须包含：要执行的命令、预期输出、判定标准、失败时的唯一下一步
  - 七步：① `npm run diagnose:feishu-chain`（4321 未起也必须跑完）；② `--json | grep` 确认零凭据；③ 报补丁不在位则重跑两个补丁脚本（维护窗口内，幂等）；④ 报环境变量未注入则写 launchd 后 `launchctl kickstart -k` 重载再复跑；⑤ `npm run runtime:fingerprint` 核对 4321 为 `immutable_release` 而非 4322 开发实例；⑥ 在飞书私聊「A君·军团总管」发一条真实文本消息（**唯一能证明「飞书可用」的一步**）；⑦ 可选地 bootout 运行时制造一次失败，确认 `$HERMES_HOME/agent_army_commander_evidence-*.jsonl` 权限 `0600`、含 `sourceEventRef`、不含消息正文与凭据，然后 bootstrap 恢复
  - 清单开头写明**未验证声明**：所有涉及飞书、Hermes、StepFun 与 launchd 真机状态的结论，在步骤 1–7 完成前一律标记未验证；「代码已写」不等于「能力可用」
  - 清单结尾写明**推翻条件**：若六项全 `pass` 且 `adapter.py` 补丁在位而飞书仍无回复，根因落在需求 1.8（Hermes 模型侧入口 / 密钥 / 预算 / 轮次上限）或飞书应用事件订阅侧，须回到需求重新假设，**不得用「已修复」结案**
  - 【需真机验证】（清单本身沙箱可写，清单要验证的结论只能在用户 Mac 上关闭）
  - _Requirements: 2.9, 2.10, 2.11, 1.8_

---

### 阶段五：第四轮 —— 非异常型拒绝记录的日志归属（1.34–1.36 / 2.43–2.45 / 3.24–3.27）

**本阶段与前四个阶段的关系**：阶段一到阶段四对应切片 A / B 的旧计划，任务 4.x / 5 / 6 中仍为 `- [ ]` 的部分属**留档不做**范围，本阶段不接管、不改写、不勾选它们。

**本阶段为什么存在**：飞书已能正常回复（白名单修好后真机步骤 ⑥ 通过），**本阶段不是为了修复用户的阻断**，而是修掉一个**会误导下一个排查者**的工具缺陷 —— PR #12 交付的日志归属工具只解析 traceback，把真机上「已被明确记录的准入拒绝」误报为「失败根本没有被记录」，并返回退出码 `1`。缺陷恰好发生在为消除误导而建的工具上。

**范围严格限定**：只修 `bugfix.md` 的 **1.34 / 1.35 / 1.36**（缺陷），落实 **2.43 / 2.44 / 2.45**（期望行为），保持 **3.24 / 3.25 / 3.26 / 3.27**（保持性）。bugfix.md 中其余 30 余条缺陷（含 1.37 / 2.46）**留档不做，不在本阶段任何任务内**。

**只改三个文件**（均在 `fix/hermes-log-subsystem-attribution`，PR #12），**不新增文件、不新增目录、不新增依赖**：

| 文件 | 变更性质 |
|---|---|
| `apps/ajun-runtime/src/hermes-log-attribution.ts` | 改：拒绝记录识别、归属、措辞溯源、结论渲染。**保持纯解析、零 I/O** |
| `apps/ajun-runtime/scripts/attribute-hermes-logs.mjs` | 改：默认文件集、`--hermes-version`、退出码判定式、渲染 |
| `apps/ajun-runtime/test/hermes-log-attribution.test.js` | 改：新增用例与夹具；既有 13 项断言按影响表处置 |

（唯一例外是任务 10 的顺带项，只改 `apps/ajun-runtime/module-policy.json` 一处登记条目。）

#### 设计复核记录：design.md §10 中不可直接实施、需在实现时裁决的点

以下 8 条是复核 design.md §10.1–10.6 与《本轮（第四轮）增量测试策略》时发现的问题。**F1 / F2 / F3 会导致按字面实现失败或产生错误结论，必须在对应任务内先裁决**；F4–F8 是必须遵守的实现细节，写入任务以免实现者踩坑。

| # | 问题 | 影响 | 建议裁决（在任务内执行） |
|---|---|---|---|
| **F1** | §10.2 第 5 条的时间戳失败关闭**结构上不可达**：既有 `TIMESTAMP = /\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/` 与新增 `SAFE_TIMESTAMP = /^…同一正文…$/` 正文完全相同，而 `line.match(TIMESTAMP)?.[0]` 返回的就是该正文匹配到的整段，锚定复校**永远通过**。畸形时间戳（如 `2026-8-9 1:2:3`）根本不被 `TIMESTAMP` 匹配 ⇒ 只会得到 `timestamp === null`，`redactedFieldCount` **永不递增** | 新增用例 #9「畸形时间戳 → `timestamp === null` **且** `redactedFieldCount` 递增」按字面写**必然失败** | **选 A**：为拒绝行另设**更宽**的 `LOOSE_TIMESTAMP`（零捕获组，如 `/\d{2,4}-\d{1,2}-\d{1,2}[ T]\d{1,2}:\d{1,2}:\d{1,2}/`）做提取，再用严格的 `SAFE_TIMESTAMP` 全量校验 —— 失败关闭分支即可达，`redactedFieldCount` 语义与既有 `SAFE_*` 模式一致。**不得**改动既有 `TIMESTAMP`（traceback 路径复用它，属 3.25 保持项）。若不选 A，则必须把用例 #9 拆为只断言 `timestamp === null`，并在 design 中撤回「递增」表述 |
| **F2** | §10.1 把四条**正向签名**（`kind: 'positive_milestone'`）与准入拒绝一起放进 `feishuChainRejections`，而 §10.4 表格第 2 行对 `feishuChainRejections.length > 0` 一律「**报为已定位的失败证据**」。正向里程碑不是失败 ⇒ 会把「回复已发出」误报为失败证据，与本阶段「不再误导排查者」的目的相反 | 渲染分支缺 `kind` 维度；同时 Fix Checking 覆盖矩阵要求正向签名也 `decideExitCode == 0`，两处口径需统一 | **按 `kind` 分叉渲染**：数组保留全部（Fix Checking 矩阵要求），但「已定位的失败证据 + 核对两套白名单」文案**只对 `kind === 'admission_rejection'`** 输出；只有正向里程碑时输出「入站到达 / 回复就绪已被记录，但窗口内无飞书失败记录」并给出对应的唯一下一步。退出码仍按 2.44「是否找到飞书归属证据」判 `0`（正向签名也是归属证据），信息损失由 `evidenceClass` 补齐 |
| **F3** | §10.3 把 `subsystems` 排序键改为 `tracebackCount + rejectionRecordCount`，于是主导子系统**可能 0 条 traceback**（如只含一行准入拒绝的输入，正是 E3 的夹具）。`renderAttributionVerdict()` 首行固定输出「主导签名归属：X（N 条 traceback，最常见异常 …）」，此时会输出「0 条 traceback，最常见异常 未解析」 | §10.4 表格未覆盖该分支，会产出自相矛盾的结论首行 | 首行渲染增加分支：`dominant.tracebackCount === 0 && dominant.rejectionRecordCount > 0` 时改为「主导记录归属：X（0 条 traceback，N 条非 traceback 拒绝/里程碑记录）」，不打印「最常见异常」 |
| **F4** | §10.4 表格第 1 行把「保留既有文案（含子串 `没有解析到任何 traceback`）」与证据缺口文案写在同一行，但既有代码里这是**两个不同分支**：`!dominant` 的提前 return（测试 #8 依赖 `/没有解析到任何 traceback/`）与 `feishuRelated.length === 0` 的证据缺口段（测试 #6 依赖 `/没有任何.*归属到飞书链路/` 与 `/「没有错误记录」不等于「飞书侧正常」/`） | 合并两分支会打破 #8 或 #6 | 两分支**分别**保留并**分别**收紧触发条件：提前 return 收紧为「无 subsystems **且**无拒绝记录」；证据缺口段收紧为「飞书 traceback 数 `=== 0` **且**飞书拒绝记录数 `=== 0`」。三段被断言的子串一字不改 |
| **F5** | 拒绝行识别的**代码位置**：`attributeHermesLog` 主循环里，顶格且不匹配 traceback 形状的行会走 `closeCurrent()` 分支；若把识别写在 `if (!current)` 之后，则 E1 夹具（Telegram traceback **紧接** 拒绝行）会漏掉该记录 | 反例 E1 在修复后仍失败 | 识别必须放在**每行的前置段**（与既有 `LOGGER_TOKEN` 计数同一位置），无条件对每行执行，与 `current` 状态无关。同时用单测钉住「拒绝行紧跟 traceback 末行时仍被识别」 |
| **F6** | 反例 E1 按字面 `…feishuChainRejections.length === 1` 在未修复代码上会抛 `TypeError`（读 `undefined` 的 `length`），不是断言差异 | 不影响「必须 FAIL」的结论，但反例记录会失真 | 反例记录里如实写「字段不存在（`undefined`），读 `.length` 抛 `TypeError`」，并另写一条 `assert.equal(typeof result.feishuChainRejections, 'undefined')` 作为可读反例证据 |
| **F7** | `tasks.meta.json` 的 `pbtResults` 以**任务标题原文**为键，目前只有任务 1、2 两条 | 新增 Property 3 / 4 的状态由工具在执行时写入，本次**不手工编辑该文件** | 本阶段只改 `tasks.md`；任务 7 / 8 / 9.6 / 9.7 的 PBT 状态在实际执行时登记 |
| **F8** | 任务 10 若给 `src/hermes-log-attribution.ts` 登记过紧的 `lineLimit` 会让 `npm run check:architecture` 失败：该文件当前 440 行，本轮为纯追加（措辞表、拒绝识别、溯源、平行折叠函数），预计增至 650–750 行 | 顺带项反而阻断 CI | `lineLimit` 取 **750**（与同目录 `src/feishu-commander-chain-diagnosis.ts` 的 700 同量级），并在实现落地后按实际行数复核一次 |

---

- [ ] 7. 在未修复代码上写并运行非异常型拒绝记录的 Bug 条件探索测试
  - **Property 3: Bug Condition** - 已明确记录的失败被误报为「失败未被记录」
  - **CRITICAL**: 本测试 MUST 在 `fix/hermes-log-subsystem-attribution` 的**当前（未修复）**代码上 **FAIL** —— 失败即证明缺陷存在
  - **DO NOT** 在它失败时去修测试或改代码；本任务的产出是**反例记录**，不是绿灯
  - **NOTE**: 本测试同时编码了期望行为，任务 9.6 会重新运行**同一个测试**来验证修复
  - **GOAL**: 用含准入拒绝行的夹具证明当前工具会输出「失败根本没有被记录到错误日志」**且**退出码为 `1`，而真机上失败被记录得非常明确（1.35）
  - **Scoped PBT Approach**: 本缺陷是确定性的，因此把属性收敛到 design.md《本轮（第四轮）增量测试策略》列出的 E1–E6 六个具体夹具，保证可复现；随机化只用于 9.5 的 PII 与折叠属性
  - **夹具（占位符，零真实取值）**：在 `apps/ajun-runtime/test/hermes-log-attribution.test.js` 内新增 `ADMISSION_REJECTION_LINE`（`WARNING plugins.platforms.feishu Unauthorized user: <account-placeholder> <name-placeholder> on feishu`，**单行、不带 traceback**）、`LEGACY_REJECTION_LINE`（`dm_policy_rejected`）、`POSITIVE_MILESTONE_LINES`（四条）。**严禁写入任何真实姓名、`open_id`、账号标识或其片段**
  - **真机形态复刻**：`ADMISSION_REJECTION_LINE` 必须与既有 `TELEGRAM_TRACEBACK` 混排 —— 真机上 46 万行被 Telegram 噪音主导、飞书证据只有一行，这是缺陷成立的形态前提
  - **在未修复代码上运行下列六条并逐条记录实际观测**：
    - **E1 拒绝记录被完全漏掉**：`attributeHermesLog(TELEGRAM_TRACEBACK + '\n' + ADMISSION_REJECTION_LINE).feishuChainRejections.length === 1` → 预期 **FAIL**：字段不存在。按 **F6** 另写 `typeof … === 'undefined'` 作为可读反例，并如实记录「读 `.length` 抛 `TypeError`」。直接证明 `TRACEBACK_HEADER` 门控漏掉该记录（1.34）
    - **E2 主动误导**：同一夹具的 `renderAttributionVerdict(...)` **不匹配** `/失败根本没有被记录/` → 预期 **FAIL**：仍输出「飞书侧的失败根本没有被记录到错误日志…这本身是一个证据缺口」（1.35 / 2.44）
    - **E3 证据存在却报未找到**：`decideExitCode({ ok:true, reports:[{ attribution: attributeHermesLog(ADMISSION_REJECTION_LINE) }] }) === 0` → 预期 **FAIL**：返回 `1`（2.44）
    - **E4 放大缺陷①**：默认文件集包含 `gateway.log` → 预期 **FAIL**：`DEFAULT_LOG_NAME` 为单值 `'gateway.error.log'`。准入拒绝是 WARNING 级，最可能只在 `gateway.log`，不修这一项则解析修好也扫不到
    - **E5 无措辞溯源**：`signatureProvenance` 逐条给出来源位置与适用版本 → 预期 **FAIL**：无任何措辞登记结构（1.36 / 2.45）
    - **E6 无「不适用」表述通道**：未命中措辞被表述为「不适用 / 适用性未知」而非「未发生该类拒绝」 → 预期 **FAIL**：无该表述通道（2.45）
  - 运行：`node --test apps/ajun-runtime/test/hermes-log-attribution.test.js`
  - **EXPECTED OUTCOME**: E1–E6 全部 FAIL（这是正确的，它证明缺陷存在）；**既有 13 项测试同时必须仍全部 PASS**（本任务只加不改）
  - **推翻条件**：若任一反例在未修复代码上竟然通过（尤其 E2），说明对 `renderAttributionVerdict()` 触发条件或 `TRACEBACK_HEADER` 门控的理解有误，SHALL 回到 design.md《Hypothesized Root Cause》重新核对代码，**SHALL NOT 继续实现修复**
  - 任务在测试写完、跑完、六条失败已逐条记录时标记完成
  - 【沙箱可验证】
  - _Requirements: 1.34, 1.35, 1.36_

- [ ] 8. 在未修复代码上写并运行拒绝记录归属的保持性基线（**先于任何实现**）
  - **Property 4: Preservation** - Bug_Condition 不成立的输入，既有字段输出完全一致
  - **IMPORTANT**: 严格遵循**观测优先（observation-first）**方法：先在**未修复代码**上对既有两份夹具（`TELEGRAM_TRACEBACK` / `FEISHU_TRACEBACK`）跑基线并**确认通过**，把 `attributeHermesLog()` 的完整返回值序列化落为基线夹具，再写断言。不得凭假设写期望值
  - **观测步骤（在未修复代码上执行并记录实际输出）**：
    - 观测并落盘 `attributeHermesLog(TELEGRAM_TRACEBACK)`、`attributeHermesLog(FEISHU_TRACEBACK)`、`attributeHermesLog(TELEGRAM_TRACEBACK + '\n' + FEISHU_TRACEBACK)` 的完整返回值（`JSON.stringify`，作为测试文件内联常量，**不新增夹具文件**）
    - 观测 `renderAttributionVerdict()` 对上述三份输入的完整文本，逐字节落为基线
    - 观测 `summarizeSignatures(attribution.feishuChainTracebacks)` 的返回形状与取值
    - 观测 `decideExitCode()` 对 telegram-only（`1`）与 `FEISHU_TRACEBACK`（`0`）的取值
    - 确认三份夹具中**不含任何**匹配 `REJECTION_SIGNATURES` 的行（含四条正向签名）—— 否则它们不属于 Bug_Condition 不成立的域，基线选取本身有误
  - **写属性式测试**（`node --test` 内**确定性输入枚举 + 固定种子伪随机生成器**，种子写死并在失败时打印；不引入 PBT 库，3.9）：
    - **P4-1（3.25 最高优先）**：`after.scanned.tracebackCount === before.scanned.tracebackCount` —— `tracebackCount` **必须保持 traceback-only**，不得混入拒绝记录计数
    - **P4-2（3.25）**：`after.feishuChainTracebacks` 与基线**深度相等** —— 该字段不得改名、不得混入非 traceback 记录
    - **P4-3（3.25，硬约束）**：`after.loggerNameCounts` 与基线**深度相等** —— 既有测试 #7 用 `assert.deepEqual` 全量比对元素，**严禁给元素增删任何字段**
    - **P4-4（3.25）**：`after.redactedFieldCount === before.redactedFieldCount` —— 形状白名单与失败关闭语义不放宽，也不得因新增时间戳校验而对既有夹具多计
    - **P4-5**：`projectExistingFields(after.subsystems)` 与基线 `subsystems` 深度相等。`projectExistingFields()` 只投影修复前已存在的 `SubsystemReport` 字段（新增三字段不参与比对）—— **这是本轮唯一允许的差异**
    - **P4-6（3.25）**：`summarizeSignatures(after.feishuChainTracebacks)` 与基线深度相等；`summarizeSignatures()` 的签名、入参类型与返回形状不得改动
    - **P4-7（3.25）**：`renderAttributionVerdict()` 对三份基线输入的输出中，`与「飞书消息无回复」无关` / `不得据此推导飞书侧根因` / `无回退链` 三段措辞逐字节不变；归属到无关子系统的主导签名继续被判为与本 bug 无关
    - **P4-8（3.25）**：随机构造只含第三方栈帧、只含普通日志行、只含空行的输入，断言 `readTail()` 与尾部窗口语义不变、`subsystems.length === 0`（非匹配普通行不得生成 `SubsystemReport` 条目，既有测试 #8 依赖）
    - **P4-9（3.24）**：断言 `hermes-log-attribution.ts` 的 import 列表为空（纯解析、零 I/O、零第三方 npm 依赖）、CLI 只 `import` Node 内建模块与仓库内文件；断言全流程不读 `.env`、无 provider 网络调用、无计费
    - **P4-10（3.26 / 3.27，本轮零改动的正向确认）**：断言 `src/feishu-commander-chain-diagnosis.ts` 的 `CHAIN_CHECK_IDS`、六项 `truthLayerCeiling` 与其退出码语义**未被本轮触碰**；断言 `ou_` 前缀格式校验、`0o600` 权限与 `dmMode:'allowlist'` 默认拒绝语义未被放宽，未引入任何「允许全部用户」旁路
  - 运行：`node --test apps/ajun-runtime/test/hermes-log-attribution.test.js`
  - **EXPECTED OUTCOME**: 全部 PASS（确认这是必须原样保留的基线行为）
  - 任务在测试写完、跑完、在未修复代码上通过时标记完成
  - 【沙箱可验证】
  - _Requirements: 3.24, 3.25, 3.26, 3.27_

- [ ] 9. 修复：日志归属工具覆盖非异常型拒绝记录

  - [ ] 9.1 措辞登记表：多版本容纳、来源溯源与适用性判定
    - 改 `apps/ajun-runtime/src/hermes-log-attribution.ts`，新增 `RejectionSignatureId`（5 条：`admission-unauthorized-user` / `admission-dm-policy-rejected` / `feishu-inbound-received` / `feishu-response-ready` / `feishu-response-sending`）、`SignatureApplicability`、`RejectionSignatureSpec`、`REJECTION_SIGNATURES`
    - 每条 `spec` 必须登记 `source`（仓库内具体位置）与 `sourceHermesVersion`，取值按 design.md §10.1 表格：`admission-unauthorized-user` → `0.20.1`；`admission-dm-policy-rejected` → `null`（`docs/reviews/m1-xiaod-feishu-closure/acceptance.md` 未登记版本）；三条正向签名 → `null`。**表内不含任何真实取值**
    - 实现 `classifyApplicability(spec, runningHermesVersion)`：`sourceHermesVersion === null` 或 `runningHermesVersion === null` → `'unknown'`；相等 → `'current_version'`；不等 → `'other_version'`
    - **正则硬约束（2.43 / PII 最高优先）**：五条 `pattern` 全部**零捕获组**，只用 `(?:…)`，无反向引用，长度有界。`Unauthorized user:` 与 `on feishu` 之间的账号标识与姓名落在 `[^\n]{1,200}?` 内，该片段**既无捕获组也从不被读取**
    - 单测：逐条断言 `new RegExp(spec.pattern.source + '|').exec('').length - 1 === 0`（捕获组数为 0）—— 任何后续新增措辞若带捕获组，该断言立即失败
    - _Bug_Condition: isBugCondition —— 1.36「没有任何拒绝措辞的来源与适用版本登记」，当前版本签名形状与 0.19 时代 `dm_policy_rejected` 措辞不同且并存_
    - _Expected_Behavior: 2.45 —— 措辞按 2.35 标注来源与适用版本，同时容纳多版本措辞并分别标注适用范围_
    - _Preservation: 3.25 —— 纯追加常量与纯函数，不改既有 `SAFE_*` 白名单、不改 `LIBRARY_FRAME`，无 import 变化（3.24 零第三方依赖）_
    - 【沙箱可验证】
    - _Requirements: 1.36, 2.45_

  - [ ] 9.2 识别、归属与数据结构追加（含 PII 硬约束与两个放大缺陷之一）
    - **识别位置（复核 F5，强制）**：拒绝行识别写在主循环**每行的前置段**，与既有 `LOGGER_TOKEN` 计数同一位置，**无条件对每行执行**，与 `current`（是否处在 traceback 内）状态无关；否则 E1 夹具（拒绝行紧跟 traceback 末行）会漏识别。单测钉住该场景
    - **只判定不提取（2.43，最高优先）**：识别函数只允许 `spec.pattern.test(line)`。**禁止** `String.prototype.match` / `RegExp.prototype.exec` / `matchAll` / 替换回调作用于拒绝行。日志行文本**不进入任何返回值**（返回类型里没有承载行内容的 `string` 字段），行本身只在函数内作为参数存在
    - 新增 `RejectionRecord`：`subsystem` / `attributionBasis: 'signature_platform' | 'logger_name' | 'none'` / `attributionConflict: boolean` / `signatureId` / `kind` / `applicability` / `loggerName` / `timestamp` / `line`。**只输出签名类型、计数、时间与行范围**，与既有 traceback 输出的字段粒度一致
    - 归属顺序：签名自带 `platformHint`（措辞含 `on feishu` / `platform=feishu`）优先 → 否则 `classifyLoggerName(extractLoggerName(line))` → 否则 `'unattributed'` + `basis:'none'`。两者都存在且不一致时取 `platformHint` 并置 `attributionConflict: true`，**不得静默吞掉**
    - **时间戳（按复核 F1 选项 A 实施）**：为拒绝行另设更宽的 `LOOSE_TIMESTAMP`（零捕获组）做提取，再用锚定的 `SAFE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/` 全量校验；不通过即**丢弃并 `redactedFieldCount += 1`**（失败关闭，沿用既有 `SAFE_*` 模式）。**既有 `TIMESTAMP` 一字不改**（traceback 路径复用它，属 3.25 保持项）
    - 归属线索也走白名单：日志器名沿用既有 `extractLoggerName()` + `SAFE_LOGGER_NAME`，**不新增取值通道**
    - `SubsystemReport` **新增三字段**（既有字段一个不改）：`rejectionRecordCount` / `rejectionSignatureCounts` / `lastRejectionTimestamp`。**`tracebackCount` 保持 traceback-only**
    - `subsystems` 排序键改为 `tracebackCount + rejectionRecordCount` 降序，tiebreak 仍为 `subsystem.localeCompare`；只有拒绝记录、无 traceback 的子系统**也要生成条目**（`tracebackCount: 0`）
    - `firstLine` / `lastLine` 扩展为同时覆盖 traceback 与拒绝记录，**必须加空集合守卫** —— 既有实现用 `Math.min(...bucket.map(...))`，某子系统只有拒绝记录时展开空数组会得到 `Infinity` / `-Infinity`
    - `HermesLogAttribution` **新增三个顶层字段**：`feishuChainRejections`（与 `feishuChainTracebacks` 平行）、`signatureProvenance`（每条登记措辞的 `source` / `sourceHermesVersion` / `applicability` / `matchCount`，**未命中也必须出现**）、`evidenceClass: 'traceback' | 'rejection' | 'both' | 'none'`
    - `scanned` **新增三字段**（既有三个不动）：`rejectionRecordCount` / `windowFirstTimestamp` / `windowLastTimestamp` —— 使「未命中」与「窗口未覆盖」可区分（放大缺陷②）。窗口时间戳取窗口内**首个与末个通过 `SAFE_TIMESTAMP` 校验**的时间戳；**行内无时间戳形状时静默跳过，不计入 `redactedFieldCount`**（否则 P4-4 会因既有夹具的无时间戳行而回归）
    - `summarizeSignatures()` **签名、入参类型、返回形状全部不动**；新增平行函数 `summarizeRejectionSignatures(records)` → `RejectionSignatureSummary[]`。折叠键**只由 `subsystem` + `signatureId` 组成**，不含任何来自日志行的取值 ⇒ 摘要在结构上不可能承载 PII
    - **`loggerNameCounts` 元素形状严禁增删字段**（既有测试 #7 `assert.deepEqual` 全量比对）
    - **Schema 保持 `agent.army/hermes-log-attribution/v1`，不升版**：本轮纯追加，无字段删除、无既有字段语义变化；已核实仓库内该 schema 的消费方只有 `attribute-hermes-logs.mjs` 与其单测，无外部契约
    - _Bug_Condition: 1.34 —— 解析由 `TRACEBACK_HEADER` 门控，而真机准入拒绝是一条**不带 traceback 的结构化日志行**，该类飞书相关拒绝记录被完全漏掉_
    - _Expected_Behavior: 2.43 —— 同时覆盖非异常型结构化拒绝/丢弃记录，与 traceback 一样先归属子系统再报告，且只输出签名形状、计数、时间与行范围_
    - _Preservation: 3.25 —— `sealGroup()` / `classifyOwningPath()` / `classifyLoggerName()` / `LIBRARY_FRAME` **一字不改**，拒绝记录走完全独立的代码路径；`tracebackCount` 保持 traceback-only；`feishuChainTracebacks` 不改名不混入；`loggerNameCounts` 形状不变；既有白名单与失败关闭不放宽。3.24 —— 仍纯解析、零 I/O_
    - 【沙箱可验证】
    - _Requirements: 1.34, 2.43_

  - [ ] 9.3 结论渲染与退出码：证据存在时不得再说「失败未被记录」
    - **`renderAttributionVerdict()` 四条分支改造（触发条件收紧，被断言的文案子串一字不改）**：
      - **提前 return 分支**（复核 F4）：条件从 `!dominant` 收紧为「无 `subsystems` **且**无拒绝记录」；文案**必须保留** `/没有解析到任何 traceback/` 子串（既有测试 #8 依赖），可追加「非异常型拒绝记录同样为零」与扩大窗口的下一步
      - **证据缺口分支**（2.44 核心）：条件从 `feishuRelated.length === 0` 收紧为「飞书 traceback 数 `=== 0` **且**飞书拒绝记录数 `=== 0`」；文案**必须保留** `/没有任何.*归属到飞书链路/` 与 `/「没有错误记录」不等于「飞书侧正常」/` 两段子串（既有测试 #6 依赖）
      - **有飞书拒绝记录分支**（按复核 F2 分叉）：`kind === 'admission_rejection'` 命中时**报为已定位的失败证据**，逐条给出签名类型、计数、时间、行范围与措辞溯源，唯一下一步为「核对两套白名单（军团侧 store 与 Hermes Profile 环境文件）是否对齐，对齐后重启 Gateway」；**只有正向里程碑时**改为「入站到达 / 回复就绪已被记录，但窗口内无飞书失败记录」并给出对应下一步。**两种情形都不输出任何取值**
      - **有飞书 traceback、无拒绝记录分支**：既有文案不变
      - **无飞书证据但存在无关子系统主导签名**：既有两段文案不变（3.25）
    - **首行渲染新增分支（复核 F3）**：`dominant.tracebackCount === 0 && dominant.rejectionRecordCount > 0` 时输出「主导记录归属：X（0 条 traceback，N 条非 traceback 记录）」，**不打印「最常见异常」** —— 避免输出「0 条 traceback，最常见异常 未解析」这种自相矛盾的首行
    - **未命中措辞的表述（2.45）**：`other_version` 输出「该措辞在当前版本不适用」，`unknown` 输出「适用性未知」，**SHALL NOT 输出「未发生该类拒绝」**
    - **窗口优先规则**：若 `windowFirstTimestamp` / `windowLastTimestamp` 显示窗口未覆盖事发时间，SHALL 优先输出窗口覆盖范围这一事实，不得把「窗口外」表述为「未命中」
    - **`decideExitCode()` 判定式扩展**：仍是三个码，**不新增码**。`0` 的判定式从「找到飞书 traceback」扩为「找到飞书归属证据（`feishuChainTracebacks` ∪ `feishuChainRejections`）」；`1` 为两类都为零（真正的证据缺口）；`2` 不变。「`0` 覆盖两种情形」的信息损失由 `evidenceClass` 在 `--json` 输出里补齐，不靠新增退出码解决 —— 保持三码可避免调用方脚本改造，也与既有 13 项测试的退出码断言兼容
    - _Bug_Condition: 1.35 —— 飞书失败全以非异常型记录存在时，工具输出「失败根本没有被记录…这本身是一个证据缺口」且退出码 `1`，而真机上失败被记录得非常明确；该工具主动误导排查者_
    - _Expected_Behavior: 2.44 —— 存在归属到飞书链路的非 traceback 失败记录时，SHALL NOT 输出「失败未被记录到任何可判定位置」或等价表述，SHALL 报为已定位的失败证据并给出唯一下一步；退出码语义与「是否找到飞书归属证据」一致_
    - _Preservation: 3.25 —— `!dominant.feishuChainRelated` 分支两段文案不改，`FEISHU_CHAIN_SUBSYSTEMS` 与 `isFeishuChainRelated()` 不改；测试 #5 / #6 / #8 依赖的全部文案子串保留_
    - 【沙箱可验证】
    - _Requirements: 1.35, 2.44, 2.45_

  - [ ] 9.4 CLI 侧：默认文件集补 `gateway.log`、注入运行版本、窗口与溯源输出
    - 改 `apps/ajun-runtime/scripts/attribute-hermes-logs.mjs`
    - **放大缺陷①（必须与解析一起修）**：`DEFAULT_LOG_NAME`（单值）改为 `DEFAULT_LOG_NAMES = Object.freeze(['gateway.error.log', 'gateway.log'])`，`selectFiles()` 相应返回两个路径。理由：准入拒绝是 **WARNING 级**，最可能只在 `gateway.log`；**不改这一项，解析修好也扫不到**。单个文件缺失沿用既有 `log_absent` 逐文件报错，不影响 `ok`
    - 新增 `--hermes-version <x.y.z>` 可选参数，透传 `attributeHermesLog(text, { tailWindow, hermesVersion })` 驱动 `classifyApplicability`。**由调用方注入，纯解析模块不做任何版本 I/O 探测**；未提供时全部措辞报「适用性未知」
    - 人类可读输出新增「本次窗口覆盖时间：`windowFirstTimestamp` → `windowLastTimestamp`」一行；未命中任何飞书证据时提示该窗口可能未覆盖事发时间
    - 新增「措辞溯源」块：逐条打印 `signatureId`、来源位置、适用版本、适用性、命中计数；**未命中的措辞照样打印**，标注「该措辞在当前版本不适用 / 适用性未知」
    - 新增「飞书链路非 traceback 拒绝记录」块：输出 `summarizeRejectionSignatures()` 的折叠结果（签名类型 ×计数、首次/最近时间、覆盖行范围）。**不输出任何行内容**
    - `--help` 文案（`renderUsage()`）与文件头注释里的默认文件集、退出码说明同步为本轮表述
    - 独立验证：`npm run diagnose:hermes-logs -- --json` 与 `npm run diagnose:hermes-logs -- --help`（沙箱内无 Hermes 日志目录，应得 `log_directory_not_found` 且退出码 `2`）
    - _Bug_Condition: 1.34 的放大条件 —— 默认只扫 `gateway.error.log`，WARNING 级拒绝记录不在其中；1.36 —— 无措辞溯源输出通道_
    - _Expected_Behavior: 2.43（扫描范围覆盖到该类记录）、2.44（退出码语义一致）、2.45（逐条输出来源与适用版本）_
    - _Preservation: 3.25 —— `readTail()` 不改，仍只读文件尾部、不整体载入内存，窗口大小仍由 `--tail-mb` 控制；3.24 —— 仍只 `fs.open` + `read`，新增参数只是版本号字符串，不引入任何配置读取、不读 `.env`、零第三方依赖_
    - 【沙箱可验证（参数解析与渲染）】+ 【需真机验证：真机 `gateway.log` 内准入拒绝行的实际形状与 `--hermes-version` 注入后的适用性判定】
    - _Requirements: 1.34, 1.36, 2.43, 2.44, 2.45_

  - [ ] 9.5 扩展既有 13 项测试并新增本轮用例
    - **直接受影响的 4 项（被测条件改，既有断言不改）**：
      - **#4 输出零凭据（`:86`）**：既有 7 条禁词断言**全部不改**，但夹具与禁词表**必须扩展** —— 加入 `ADMISSION_REJECTION_LINE`，并把账号占位符与姓名占位符加入禁词。否则新代码路径完全没有 PII 覆盖
      - **#6 证据缺口（`:104`）**：触发条件收紧后该夹具（telegram-only，确无飞书证据）下结论仍正确，两条断言原样通过；**另新增一条对照用例** —— 同一夹具追加 `ADMISSION_REJECTION_LINE` 后，`/失败根本没有被记录/` 与 `/没有任何.*归属到飞书链路/` **均不得出现**
      - **#8 空日志与无 traceback（`:123`）**：`attributeHermesLog('普通一行日志\n').subsystems.length === 0` 与 `/没有解析到任何 traceback/` 两条断言不改；早退条件扩为「无 `subsystems` **且**无拒绝记录」后须复验
      - **#13 CLI 参数与退出码（`:180`）**：两条既有退出码断言在扩展后仍成立（telegram-only → `1`；`FEISHU_TRACEBACK` → `0`），**断言不改**；`parseArguments` 新增 `--hermes-version` 后既有 6 条参数断言不受影响；**新增**「只含 `ADMISSION_REJECTION_LINE` → `0`」与「`evidenceClass` 取值正确」两条断言
    - **施加硬约束的 6 项（断言不改，实现必须服从）**：#1（`tracebackCount` 保持 traceback-only；排序键改为 traceback+拒绝记录后该夹具下顺序不变，`subsystems[0] === 'telegram-platform'` 仍成立）、#3（`feishuChainTracebacks` 不改名、不混入非 traceback，`TracebackGroup` 不删字段）、#5（三段措辞不得改动）、**#7（`assert.deepEqual` 全量比对 ⇒ 严禁给 `loggerNameCounts` 元素增删字段）**、#9 / #10（`summarizeSignatures()` 签名与返回形状不得改，非 traceback 折叠另立 `summarizeRejectionSignatures()`）
    - **完全不受影响的 3 项**：#2（`:62`）、#11（`:154`，不新增 `SubsystemId`）、#12（`:163`，`readTail()` 不改）—— 只需复验通过
    - **新增 13 条用例**：
      1. 非 traceback 准入拒绝被归属到 `feishu-platform`，`attributionBasis === 'signature_platform'`，`tracebackCount` 不变
      2. Telegram 噪音混排下拒绝记录仍被找到：主导子系统仍是 Telegram 且判为无关，同时飞书拒绝记录数为 1（真机形态的直接复刻）
      3. 结论不得再说「失败未被记录」（Property 3 的核心断言）
      4. 退出码语义：拒绝记录存在 → `0`；两类证据都为零 → `1`；读不出 → `2`
      5. 措辞溯源：每条登记措辞都出现在 `signatureProvenance` 且含来源位置与适用版本；`dm_policy_rejected` 与四条正向签名的 `sourceHermesVersion` 为 `null` ⇒ `applicability === 'unknown'`
      6. 未命中的表述：`0.19` 措辞未命中时输出「不适用 / 适用性未知」，**不得**出现「未发生该类拒绝」
      7. 零捕获组自证：逐条断言 `REJECTION_SIGNATURES` 的 `pattern` 捕获组数为 `0`
      8. PII 不外泄：含占位符账号与姓名的拒绝行，序列化输出中占位符零出现；`summarizeRejectionSignatures()` 折叠键不含行内取值。用固定种子随机注入 `sk-…` / `Bearer …` / `?token=…` / 长 base64 / 超长 Unicode 到拒绝行，断言输出恒不含原文
      9. 时间戳失败关闭：畸形时间戳的拒绝行 → `timestamp === null` **且** `redactedFieldCount` 递增（**依赖复核 F1 选项 A 已落地**；若最终未采纳选项 A，本条须按 F1 拆分并同步 design.md）
      10. 窗口覆盖：`scanned.windowFirstTimestamp` / `windowLastTimestamp` 正确；无飞书证据时结论包含窗口范围提示
      11. 只有拒绝记录、无 traceback：`SubsystemReport` 条目正常生成，`firstLine` / `lastLine` 为**有限值**（回归守卫：空集合 `Math.min(...[])` 会得到 `Infinity`）
      12. 默认文件集含 `gateway.log`
      13. 归属冲突：日志器名指向 Telegram 而签名含 `on feishu` 时，`attributionConflict === true` 且不被静默吞掉
    - **补充用例（复核 F5 / F2 要求）**：拒绝行**紧跟 traceback 末行**时仍被识别；只含正向里程碑的输入不得被渲染为「已定位的失败证据」
    - **覆盖矩阵**：`{当前版本措辞, 0.19 措辞, 正向签名} × {单独出现, 与 Telegram 噪音混排, 与飞书 traceback 并存} × {注入版本号, 未注入}`
    - 全部用原生 `node --test`，**不引入 Jest / Vitest / fast-check**（3.9）
    - 独立验证：`node --test apps/ajun-runtime/test/hermes-log-attribution.test.js`
    - _Bug_Condition: isBugCondition —— 1.34 / 1.35 / 1.36 全部三条_
    - _Expected_Behavior: 2.43 / 2.44 / 2.45 的全部断言，含 `containsNoPlaceholderValue(result)`（账号/姓名占位符不出现在任何字段）_
    - _Preservation: 3.25 —— 既有 13 项测试中不涉及本次变更的断言继续通过；3.24 —— 测试不读 `.env`、不发起网络调用_
    - 【沙箱可验证】
    - _Requirements: 1.34, 1.35, 1.36, 2.43, 2.44, 2.45, 3.24, 3.25_

  - [ ] 9.6 验证探索测试现在通过
    - **Property 3: Expected Behavior** - 已明确记录的失败被报为已定位的失败证据
    - **IMPORTANT**: 重新运行任务 7 的**同一批测试**，不要写新测试
    - 运行 `node --test apps/ajun-runtime/test/hermes-log-attribution.test.js`
    - **EXPECTED OUTCOME**: E1–E6 全部 PASS。逐条对照：E1 拒绝记录被识别并归属；E2 结论不再说「失败根本没有被记录」；E3 退出码为 `0`；E4 默认文件集含 `gateway.log`；E5 `signatureProvenance` 逐条给出来源与适用版本；E6 未命中措辞表述为「不适用 / 适用性未知」
    - 追加断言：`evidenceClass ∈ {'rejection', 'both'}`；`containsNoPlaceholderValue(result)`
    - _Requirements: Expected Behavior Properties from design（2.43, 2.44, 2.45）_
    - 【沙箱可验证】

  - [ ] 9.7 验证保持性基线在修复后仍全部通过
    - **Property 4: Preservation** - Bug_Condition 不成立的输入，既有字段输出完全一致
    - **IMPORTANT**: 重新运行任务 8 的**同一批测试**，不要写新测试
    - 运行 `node --test apps/ajun-runtime/test/hermes-log-attribution.test.js`
    - **EXPECTED OUTCOME**: P4-1 – P4-10 全部 PASS，无回归。逐条确认：
      - **3.25（最高优先）**：traceback 既有子系统归属逻辑（最深非第三方栈帧 / 日志器名）不变；归属到无关子系统的主导签名继续被明确判为与本 bug 无关且不得据此推导飞书侧根因；既有形状白名单与失败关闭语义未放宽；只读文件尾部、不整体载入内存、零第三方 npm 依赖保持
      - **3.24**：只读、不读 `.env`、零外部副作用、输出零凭据；无 provider 网络调用、不刷新账号模型目录、不产生计费
      - **3.26**：诊断六项检查的 id、顺序、`truthLayerCeiling` 与退出码语义未变（本轮零改动的正向确认）
      - **3.27**：`ou_` 前缀格式校验、`0o600` 权限、`dmMode:'allowlist'` 默认拒绝语义未放宽，未引入「允许全部用户」旁路
      - **唯一允许的差异**：`projectExistingFields()` 排除的 `SubsystemReport` 新增三字段
    - 追加运行 `npm run check` 确认既有测试与架构校验未回归
    - _Requirements: 3.24, 3.25, 3.26, 3.27_
    - 【沙箱可验证】

- [ ] 10. 顺带项：登记 `src/hermes-log-attribution.ts` 到模块策略表
  - 已核实 `apps/ajun-runtime/module-policy.json` 内**没有** `src/hermes-log-attribution.ts` 条目，与 design.md《模块边界》「登记新模块 + `affectedTests`」的既有约定不一致（同目录 `src/feishu-commander-chain-diagnosis.ts` / `-observations.ts` / `-evidence.ts` 均已登记）
  - 该文件是**选择性**登记表（现登记 122 项），未登记不必然违规，因此本项是一致性补登，不是阻断项
  - 新增条目：`"src/hermes-log-attribution.ts": { "affectedTests": ["test/hermes-log-attribution.test.js"], "lineLimit": 750 }`
  - **`lineLimit` 取 750 的理由（复核 F8）**：该文件当前 440 行，本轮为纯追加（措辞表、拒绝识别、溯源、平行折叠函数），预计增至 650–750 行；与同目录 `src/feishu-commander-chain-diagnosis.ts` 的 700 同量级。**登记过紧会让 `npm run check:architecture` 失败** —— 实现落地后按实际行数复核一次
  - **只改这一处**，不改 `repository-catalog.json`（未新增目录）、不改 `.gitignore`、不改前端
  - 独立验证：`npm run check:architecture`
  - _Bug_Condition: 不适用（一致性补登，非缺陷修复）_
  - _Expected_Behavior: 模块登记与 design.md 模块边界约定一致，`affectedTests` 可驱动 `test:affected`_
  - _Preservation: 3.25 —— 仅追加一个条目，不改任何既有条目；不改测试框架（3.9）_
  - 【沙箱可验证】
  - _Requirements: 3.25_

- [ ] 11. Checkpoint - 阶段五全部测试通过
  - 运行 `node --test apps/ajun-runtime/test/hermes-log-attribution.test.js`，确认既有 13 项 + 本轮新增用例全部通过；有问题时向用户提问，**不要自行放宽断言**
  - 运行 `npm run check` 与 `npm test`，确认无跨模块回归
  - 运行 `npm run diagnose:hermes-logs -- --json | grep -Ei 'sk-|bearer|token|cookie|password|unauthorized user'`，确认无匹配（2.43 零凭据）
  - 复核测试文件与 spec 文档中**未写入任何真实姓名、`open_id`、账号标识及其片段**（只用占位符）
  - 确认只改了三个代码文件 + `module-policy.json` 一处，未新增文件、未新增目录、未新增依赖
  - 确认 schema 仍为 `agent.army/hermes-log-attribution/v1`（纯追加，不升版）
  - **需真机验证的部分（不得冒充已验证）**：真机 `gateway.log` 内准入拒绝行的实际形状、`--hermes-version` 注入后的适用性判定、扫描窗口是否覆盖事发时间 —— 只能由用户在自己 Mac 上 `npm run diagnose:hermes-logs -- --hermes-version <x.y.z>` 关闭。沙箱内的通过只证明「解析与渲染逻辑正确」，**不证明真机上能扫到那一行**
  - 【沙箱可验证】+ 【需真机验证：真机日志形状与窗口覆盖】
  - _Requirements: 2.43, 2.44, 2.45, 3.24, 3.25, 3.26, 3.27_

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

## Task Dependency Graph（阶段五增量 · 任务 7 – 11）

阶段五与阶段一到阶段四**无代码依赖**：它只改 PR #12 的三个文件，与切片 A / B 的产出物不相交。因此 wave 14 的前置不是 wave 13，而是「阶段五自身的探索与基线已在未修复代码上采集完毕」。留档不做的 4.x / 5 / 6 **不构成阶段五的前置**。

```
┌──────────── 阶段五：非异常型拒绝记录归属（只改 PR #12 三个文件） ────────────┐
│                                                                            │
│  7. Property 3: Bug Condition 探索测试        8. Property 4: Preservation   │
│     （E1–E6，在未修复代码上必须 FAIL）           基线（在未修复代码上 PASS）  │
│              │                                          │                  │
│              └────────────────┬─────────────────────────┘                  │
│                               │  ★ 强制排序：两者都必须先于任何实现          │
│                               ▼                                            │
│                    9.1 措辞登记表 + 零捕获组 + 适用性判定                   │
│                               │                                            │
│                               ▼                                            │
│                    9.2 识别 / 归属 / 数据结构追加（含 PII 硬约束）           │
│                               │                                            │
│              ┌────────────────┴────────────────┐                           │
│              ▼                                 ▼                           │
│      9.3 结论渲染 + 退出码 + evidenceClass   9.4 CLI：DEFAULT_LOG_NAMES     │
│              │                                 │   + --hermes-version      │
│              └────────────────┬────────────────┘                           │
│                               ▼                                            │
│                    9.5 扩展既有 13 项 + 新增 13 条用例                      │
│                               │                                            │
│                    ┌──────────┴──────────┐                                 │
│                    ▼                     ▼                                 │
│            9.6 验证 Property 3     9.7 验证 Property 4                      │
│             （E1–E6 转 PASS）       （P4-1–P4-10 全 PASS）                   │
│                    │                     │                                 │
│  10. module-policy 补登（独立，可与 9.x 任意并行，但 lineLimit 需 9.2 落地后复核）│
│                    └──────────┬──────────┘                                 │
│                               ▼                                            │
│                    11. Checkpoint（node --test / npm run check / 零凭据）    │
└────────────────────────────────────────────────────────────────────────────┘
```

**关键依赖说明**

| 依赖 | 原因 |
|---|---|
| 7 → 9.x（**强制**） | 探索性测试必须先写，且必须在**未修复代码**上跑出 E1–E6 反例；反例跑不出来则缺陷描述有误，SHALL 回到需求重新假设，**SHALL NOT 直接实现修复** |
| 8 → 9.x（**强制**） | 保持性基线按 observation-first 先在**未修复代码**上确认通过并序列化落盘，之后才允许实现；否则无从证明既有字段逐字段未变 |
| 9.1 → 9.2 | 识别与归属依赖 `REJECTION_SIGNATURES` 的 `pattern` / `platformHint` / `kind` |
| 9.2 → 9.3 | 渲染与 `decideExitCode` 读 `feishuChainRejections` / `evidenceClass` / `scanned.window*` |
| 9.2 → 9.4 | CLI 的措辞溯源块与窗口覆盖行读 9.2 新增的顶层与 `scanned` 字段；`--hermes-version` 透传目标是 9.1 的 `classifyApplicability` |
| 9.3 ∥ 9.4 | 前者只改纯解析模块，后者只改 CLI；两文件不相交，可并行 |
| 9.3 + 9.4 → 9.5 | 新增用例同时断言渲染文案（9.3）与默认文件集 / 参数解析（9.4） |
| 9.5 → 9.6 / 9.7 | 两个 Property 的重跑需要用例与夹具扩展已落地 |
| 9.2 → 10（弱） | `lineLimit: 750` 必须在实现落地后按实际行数复核，避免补登反而阻断 `check:architecture` |
| 9.6 + 9.7 + 10 → 11 | Checkpoint 汇总两个 Property 与架构校验 |
| 阶段一至四 ⊥ 阶段五 | 无代码依赖：阶段五只改 `hermes-log-attribution.ts` / `attribute-hermes-logs.mjs` / 其单测；留档不做的 4.x / 5 / 6 不构成前置 |

**并行批次（wave）定义**

同一 wave 内的任务可并行执行，wave 之间严格串行。父任务 9 是容器，其完成由所属子任务全部完成隐含，不单列入 wave。wave 编号延续既有 1 – 13。

```json
{
  "waves": [
    {
      "wave": 14,
      "tasks": ["7", "8"],
      "dependsOn": [],
      "rationale": "阶段五起点，与既有 wave 1-13 无代码依赖。探索反例（E1-E6）与保持性基线都必须在未修复代码上采集：7 必须 FAIL，8 必须 PASS。两者互不依赖可并行，但强制先于任务 9 的全部子任务。"
    },
    {
      "wave": 15,
      "tasks": ["9.1"],
      "dependsOn": [14],
      "rationale": "措辞登记表（来源位置 + 适用版本 + 零捕获组 pattern）与 classifyApplicability 是识别、归属、溯源与渲染的共同地基。"
    },
    {
      "wave": 16,
      "tasks": ["9.2"],
      "dependsOn": [15],
      "rationale": "识别位置（每行前置段）、归属顺序、PII 硬约束与全部新增字段（RejectionRecord / SubsystemReport 三字段 / 顶层三字段 / scanned 三字段 / summarizeRejectionSignatures）集中在此，后续渲染与 CLI 都读这些字段。"
    },
    {
      "wave": 17,
      "tasks": ["9.3", "9.4", "10"],
      "dependsOn": [16],
      "rationale": "9.3 只改纯解析模块的渲染与退出码判定式，9.4 只改 CLI（默认文件集、--hermes-version、窗口与溯源输出），两文件不相交可并行；10 是 module-policy 补登，独立于两者，但排在 9.2 之后以便按实际行数复核 lineLimit。"
    },
    {
      "wave": 18,
      "tasks": ["9.5"],
      "dependsOn": [17],
      "rationale": "既有 13 项的 4 项条件调整与 13 条新增用例同时断言渲染文案（9.3）与默认文件集/参数解析（9.4），必须两者都落地后才能一次跑齐。"
    },
    {
      "wave": 19,
      "tasks": ["9.6", "9.7"],
      "dependsOn": [18],
      "rationale": "重跑任务 7 与任务 8 的同一批测试（不写新测试）：E1-E6 转 PASS 证明缺陷已修，P4-1-P4-10 仍 PASS 证明既有字段零回归。两者互不依赖可并行。"
    },
    {
      "wave": 20,
      "tasks": ["11"],
      "dependsOn": [19],
      "rationale": "Checkpoint 汇总 node --test / npm run check / npm test / 零凭据检查，并明确标注真机日志形状与窗口覆盖仍属未验证。"
    }
  ]
}
```

## Notes

执行过程中已确认的实测事实，后续任务不得与之相矛盾：

- **`AGENT_ARMY_FEISHU_AGENT_ID` 为空串或未设置是正常状态，不是缺口**：Hermes 侧读取时带 `or "ajun"` 回退并做 `.strip()`，因此空值等价于 `ajun`。诊断的 `required-env` 判定不得把该变量的空值报成 `gap`。
- **`migrateFeishuCommanderRouter` 单独调用在最小未打补丁夹具上不是逐字节幂等的**：需求 3.5 的幂等性由脚本入口 `applyPatch` 保证（其上游会先补齐前置单元），保持性测试的幂等断言应针对 `applyPatch` 而非单独的 migrate 函数。
- **飞书准入白名单在 `config.yaml` 中的真实字段名未在真机验证**：候选字段路径全部不命中时，`feishu-admission` 检查必须报 `status: 'unknown'`（不是 `pass` 也不是 `gap`、`truthLayer: 'declared'`），不得猜字段名、不得输出 `hit`。


切片 B 执行过程中新增的实测事实（与 design.md 的偏离，均为实测所迫）：

- **403 分支必须读请求体**：design.md §5 只说「在 `sendJson` 之前追加一次落盘」，但任务 1 的探索用例 ②
  断言 403 证据的 `sourceEventRef === 'feishu:exploration-403-1'`，因此 403 分支必须先
  `readJsonBody(request).catch(() => ({}))` 才能拿到事件引用。落盘与读体的任何失败都被吞掉，
  403 状态码与错误文案逐字节不变（P2-3 已收紧验证）。请求体读取沿用既有 1 MiB 上限。
- **证据 import 锚点有回退路径**：`patch-feishu-agent-proposal-router.mjs` 的安装顺序里，正式 Adapter Seam
  的 `from .agent_army_task_card import ...` 在本单元**之后**才追加，因此 design.md 的锚点 A 在首次安装时
  尚不存在；实现改为「锚点存在则插其后，否则追加到模块末尾」（Python 在调用期解析全局名，
  模块级导入位置不影响路由运行），并把 import 包进 `try/except` + 兜底 no-op，保证 evidence 模块缺失
  也不会让 adapter 导入失败。
- **`assertInstalledAdapterSeam` 的 `required` 列表未改**：design.md 提到把新 import 加进该列表「但仅在
  已注入之后校验」。实测该函数在 post-seam 升级**之前**执行，加进去会对旧安装误报失败关闭；改为在升级
  单元内部用 `assertCommanderSilentFailureEvidenceInstalled(source)` 做同等强度的注入后校验。
- **`AGENT_ARMY_FEISHU_COMMANDER_SILENT_FAILURE_EVIDENCE_V1` 只对装了总管路由的源码出现一次**：
  只含迁移标记的最小夹具（notifyV3 / notifyV4 / precedence）没有 `AJUN_FEISHU_COMMANDER_INGRESS_URL`，
  本单元整体跳过（标记 0 次）；P2-5 的「标记恰好一次」断言按此条件化。
- **诊断留痕的写入边界**：`diagnosis_completed` 只写运行时侧 `dataDir`，**绝不写 `HERMES_HOME`**。
  切片 A 的 CLI 只读断言因此是**收紧**而非放宽：`HERMES_HOME` 夹具仍逐字节不变，
  `recentEvidence` 在两侧账本都为空时仍必须是空数组。

# Bugfix Requirements Document

## Introduction

用户在本机通过飞书私聊「A君·军团总管」（`agentId = ajun`）发送文本消息后，飞书会话内**没有任何回复**——既没有业务回复，也没有错误提示或降级说明。

调研确认：真正的缺陷不是链路上某一个环节坏了，而是**这条链上至少 8 个环节会静默失败**，使「无回复」成为不可归因的黑箱。

**链路修订（本轮）**：飞书文本消息实际存在**两条并存路径**，此前本文档与 design.md 只把路径 A 当作主线，是错的。

路径 A —— 确定性 commander 文本路由（叠加在原生路径之前的拦截补丁）：

```
飞书客户端 → Hermes Gateway（adapter.py 的 _route_ajun_commander_event）
→ POST $AJUN_FEISHU_COMMANDER_INGRESS_URL（正式 http://127.0.0.1:4321/api/feishu/commander）
→ commander.handle() → presentCommanderReply() → 202 { reply | handled:false | task }
→ Hermes self.send(chat_id, reply, reply_to=message_id) → 飞书客户端
```

路径 B —— Hermes 原生会话 + Agent Army MCP（`docs/adr/0007-...md`，状态「已接受，已实施」，2026-07-26 定义的日常对话主路径，**独立可用**）：

```
飞书客户端 → Hermes 原生飞书 Gateway → Hermes Session / Profile / Memory
→ 模型按需调用 Agent Army MCP（config.yaml 的 mcp_servers.agent-army）
→ A君本机任务与能力适配 → Paperclip（仅组织级治理条件）→ 业务 Agent / 工具
→ Hermes 回原飞书会话 → 飞书客户端
```

两条路径的关系：路径 A 的 `DIRECT_REPLY_V1` 分支以 `handled:false` 把消息交回路径 B；路径 A 的补丁整体丢失时，消息直接落回路径 B 的 `handle_message`。**因此路径 A 缺口只会让派活类文本失去确定性路由，路径 B 本应照常回复** —— 需求 1.3 与真机第 2 项的 gap 是真实缺口，但**不是「完全零回复」的充分原因**。

静默点包括：环境变量未注入、Profile guard 不匹配、Hermes 升级覆盖 adapter 导致补丁丢失、4321 未监听、`isLocalAddress` 403、Gateway 进程未运行、飞书准入白名单未命中、以及 `handled:false` 之后 Hermes 模型侧异常。用户还极易把 `npm run dev`（4322，且 `AJUN_DISABLE_BACKGROUND_SERVICES=true`）误判为飞书链路已就绪，因为根 `README.md` 的「运行 A君运行台」段落把开发地址写成了 4321。

这一状态违反项目自身的 fail-closed 原则与「能力真相五层」（已声明 → 已配置 → 运行可达 → 任务实证 → 人工验收）要求：进程在线被当作业务可用。

修复范围是**可归因性与可自检**，不是替换现有路由语义。特别地，`handled:false`（`explicit_direct_reply_without_task`）把消息交回 Hermes 普通聊天是既有正确行为，必须原样保留。

飞书、Hermes、StepFun 均为外部能力，本 spec 内所有涉及它们的结论在真机验证前**显式标记未验证**。

### 真机验证证据（已实测 · 切片 A+B）

用户已在本机执行 `npm run diagnose:feishu-chain`，六项检查全部跑完，总判定 `blocking_gap`、退出码 `1`，
零凭据检查（`--json` 输出 grep `sk-|bearer|token|cookie|password`）通过。以下六项判定结果为**真机实测**：

| # | 检查项 | 结果 | 关键证据 |
|---|---|---|---|
| 1 | `gateway-process` | **pass**（实测） | `loaded:true`、`pid` 存活、`state:"running"` |
| 2 | `adapter-patch` | **gap · 阻断**（实测） | `adapterFileExists:true`、`hasCommanderRoute:false`；五个补丁标记（`PROFILE_GUARD_V1` / `INGRESS_TIMEOUT_V1` / `DIRECT_REPLY_V1` / `ADAPTER_SEAM_V1` / `SILENT_FAILURE_EVIDENCE_V1`）**全部 false**；`hermesVersion:"0.20.1"`、`hermesVersionMatchesBaseline:false` |
| 3 | `required-env` | **pass**（实测） | `ingressUrlClassification:"expected_loopback"`；`agentIdPresent:false` —— 空值回退 `ajun`，属正常状态 |
| 4 | `runtime-ingress` | **pass**（实测） | `reachable:true`、`healthStatus:"healthy"`、`releaseStatus:"immutable_release"`、`sourceRelationship:"different_git_head"` |
| 5 | `profile-guard` | **unknown**（实测） | `guardMarkerPresent:false` —— 第 2 项补丁丢失的连带结果 |
| 6 | `feishu-admission` | **unknown**（实测） | `errorCode:"admission_field_not_found"` |

诊断留痕已写入运行时侧证据账本（相对路径 `<repo-root>/apps/ajun-runtime/data/feishu-commander-chain/runtime-evidence-*.jsonl`），
证明切片 B 的落盘路径在真机工作正常。

**根因确认**：Hermes 从 `0.19.0` 升级到 `0.20.1`，升级把 Agent Army 的全部补丁从 `adapter.py` 整体冲掉，
飞书文本消息因此不进入 A君总管链。这是 design.md《Hypothesized Root Cause》**假设 2（补丁存活性无人校验）
在真机上的确认**，也是需求 1.3 的实测坐实；该假设未被推翻。

仍然**未验证**的部分：飞书会话内是否出现回复（真机验证清单步骤 6 尚未通过）、Hermes 模型侧是否正常、
飞书应用事件订阅是否有效、准入白名单是否命中。

### 已知约束（附带事实，不构成新缺陷条款）

- **运行中的 4321 是旧 release**：第 4 项证据 `sourceRelationship:"different_git_head"` 表明当前不可变
  release 的 git HEAD 与工作树不同，因此切片 B 的**运行时侧**证据落盘在正式 4321 上尚未生效，
  需执行 `npm run release:immutable` 重新发布后才启用。Hermes 侧证据不受此影响。
- **诊断结论只覆盖本机**：六项检查的层级上限最高为 `configured` / `reachable`，任一项 `pass`
  都不能证明「飞书可用」。

### 尚未排除的开放项（本轮重排：路径 B 侧升为最强候选）

**「零回复」症状未被第 2 项完全解释。** 补丁丢失后，飞书文本消息会落回路径 B 的 Hermes 原生会话
（`handle_message`），而原生会话本应仍然产生回复；用户报告的是**完全无回复**。因此缺口一定在路径 B 侧或飞书应用侧。
按候选强度重排如下（三项**全部未在真机关闭，一律标记未验证**）：

**候选 1（当前最强）· 主模型传输从未验证且回退链为空 → 静默无回复。** 仓库内可核实的事实：
`integrations/hermes/profiles/ajun.profile.json` 的 `localProfile.credentialedTransportVerified` 为 `false`，
`credentialedTransportVerification.status` 为 `model-transport-pending`、`primary` 为 `stepfun / step-3.7-flash / verified:false`、
`fallback` 为 `null`；顶层 `fallbackModels` 为 `[]`。`docs/adr/0013-...md` 明确「回退链保持为空」「本次不恢复历史
DeepSeek 文本回退」，并规定「没有当前凭据调用证据前，Profile 保持 `model-transport-pending`」。
13 个 profile 里 12 个 `credentialedTransportVerified:false`，唯一 `true` 的 `task-coordinator` 已按
`integrations/hermes/README.md`「任务协调官已并入 A君并退役」退役。
**含义**：主模型调不通时没有任何回退，会直接静默失败，症状与用户报告一致，且与路径 A 补丁无关。
**必须同时说明的边界**：`credentialedTransportVerified:false` 按 ADR-0013 是「缺少凭据调用证据」的**制度性状态**，
不等于「模型已确认不可用」；它只把本项抬为**最强候选**，不构成结论。ADR-0013 另规定运行期有效模型以
外部策略文件 `stepfun-model-policy.json` 与实际 Profile 回读为准，仓库 Manifest 只是发布初始值 —— 因此
「实际生效的 provider/model」同样未验证。

**候选 2 · 飞书用户准入白名单不命中。** 该机制在本仓库有**已确认的历史真机先例**：
`docs/reviews/m1-xiaod-feishu-closure/acceptance.md` 记录 2026-07-19 的诊断结论为「飞书投递与 Hermes WebSocket
适配器正常，阻塞点是 `FEISHU_ALLOWED_USERS` 未匹配发送者的用户 `open_id`」，入站事件全部为 `dm_policy_rejected`，
修正白名单并重启 Gateway 后恢复。该症状同样是**完全零回复**。（对应新增条款 1.18。）

**候选 3 · 飞书应用事件订阅侧**（未订阅消息事件、事件回调地址失效、应用被停用）—— 与上一轮相同，仍未关闭。

**A君 Profile 的承载事实**：`ajun.profile.json` 的 `gateway.runtimeProfile` 为 `"default"`，
`reason` 记为「当前 A君飞书应用由 Hermes default Profile 常驻 Gateway 承载；独立 ajun Profile 保留为隔离与回退身份」。
即诊断必须针对 **default Profile 的 `HERMES_HOME`**，与真机 config.yaml 路径一致；独立 `ajun` Profile 目录不是承载体。

**design.md 推翻条件的实际状态（如实分级）**：该文档 §Exploratory 的字面推翻条件是
「若 `_route_ajun_commander_event` 在位、六项全 `pass` 而飞书仍无回复」。真机上第 2 项为 `gap`、第 5/6 项为 `unknown`，
**字面前提不成立，故字面条件未被触发**；但它要保护的实质推理（症状未被已定位项解释即须回到需求重新假设）
已被真机症状触发。按实质处理：**根因假设需要修订** —— 路径 A 缺口从「主线根因」降为「真实缺口但非充分原因」，
路径 B 的模型传输未验证 + 无回退升为最强候选。

据此重申：**不得因为定位到第 2 项就宣布 bug 已修复** ——
只有真机验证清单步骤 6（飞书会话内出现业务回复或可归因中文说明）通过，才可判定本 spec 的验收目标达成。

## Bug Analysis

### Current Behavior (Defect)

用户发出文本消息后，任一环节失败都可能不产生任何用户可见的说明，也不留下可判定的本机证据。

1.1 WHEN `AJUN_FEISHU_COMMANDER_INGRESS_URL` 未注入 Hermes launchd 环境 THEN 系统在 `_route_ajun_commander_event` 开头静默 `return False`，飞书会话内没有任何说明
1.2 WHEN `AGENT_ARMY_FEISHU_AGENT_ID`（旧安装兼容 `AJUN_FEISHU_ENTRY_AGENT_ID`）不等于 `ajun` THEN 系统在 Profile guard 处静默 `return False`，用户无法得知消息未进入总管路由
1.3 WHEN Hermes 升级覆盖 `adapter.py` 使 `_route_ajun_commander_event` 整体丢失 THEN 消息落回普通 `handle_message`，系统不提示补丁已失效
1.4 WHEN A君 4321 未监听（launchd 未加载或不可变 release 未上线）THEN 系统仅发送不含归因的降级文案；若 `self.send` 同时失败则飞书会话内彻底无声
1.5 WHEN 请求来源未通过 `isLocalAddress` 校验（如混合在线部署接线错误）THEN 系统返回 403 且仅写入本机 warning 日志，飞书会话内没有说明
1.6 WHEN Hermes Gateway 进程未运行 THEN 飞书事件无人消费，本机不产生可判定「消息是否到达」的证据
1.7 WHEN 发送者不在飞书用户准入白名单内 THEN 消息被丢弃，用户收不到「未获准入」的说明
1.8 WHEN A君返回 `handled:false` 而 Hermes 模型侧异常（入口、密钥、预算或轮次上限）THEN 飞书会话内没有回复，用户无法区分「有意静默」与「链路故障」
1.9 WHEN 用户想自行定位无回复原因 THEN 系统没有任何本机一次性诊断入口，只能逐个环节猜测
1.10 WHEN 用户按根 `README.md` 的「运行 A君运行台」段落启动服务 THEN 系统实际在 4322 以关闭飞书后台协调服务的开发实例运行，而文档标注为 4321，使用户误判飞书链路已就绪

以下四条由真机验证新发现（缺陷 A：1.11–1.13；缺陷 B：1.14）：

1.11 WHEN `adapter-patch` 判定为 `gap` 且证据中 `hermesVersionMatchesBaseline` 为 `false` THEN 系统仍输出「重跑补丁脚本 `patch-feishu-agent-proposal-router.mjs`」作为唯一下一步，而该脚本会被版本锁定校验拒绝执行，用户按指令操作只会得到版本门禁错误，「唯一下一步必须可执行」的初衷落空
1.12 WHEN `profile-guard` 因 `guardMarkerPresent` 为 `false` 判定为 `unknown` 且 `hermesVersionMatchesBaseline` 为 `false` THEN 系统同样输出「重跑补丁脚本恢复 guard 标记」作为下一步，该指令在版本漂移下同样无法执行
1.13 WHEN 观测层计算 `hermesVersionMatchesBaseline` THEN 系统只比对 `pyproject.toml` 的 version 与基线版本号，不比对 Hermes 安装的 git HEAD；而版本锁定校验要求版本号与 git commit **两者同时匹配**，因此该字段为 `true` 时补丁脚本仍可能被门禁拒绝，判定与门禁不同源
1.14 WHEN 飞书准入白名单在 Hermes `config.yaml` 中使用的字段名不在硬编码候选列表内 THEN 系统报 `errorCode:"admission_field_not_found"`、`configured:false`，`feishu-admission` 一项永远给不出结论，且用户无法在不改代码的情况下让该项判定生效

以下十条由本轮链路重定义与仓库事实复核新发现（缺陷 C 链路主线错位：1.15–1.17；缺陷 D 准入检查找错位置：1.18–1.19；缺陷 E 平行实现：1.20–1.21；缺陷 F 升级韧性缺失：1.22–1.24）：

1.15 WHEN 诊断给出链路结论 THEN 系统只沿「adapter 补丁路由 → 4321 → `commander.handle()`」一条路径判定，不覆盖 `docs/adr/0007-hermes-native-feishu-runtime-and-agent-army-mcp.md`（状态「已接受，已实施」）定义的 Hermes 原生会话 + Agent Army MCP 主路径，使补丁缺口被当作零回复的唯一或充分原因
1.16 WHEN 六项检查执行完毕 THEN 系统对 Hermes 原生会话侧一律无判定：`config.yaml` 的 `mcp_servers.agent-army` 是否存在且 `enabled`、主模型 provider/model 实际取值是否与 `ajun.profile.json` 的 `modelSelection` 基线一致、`credentialedTransportVerified` 是否仍为 `false`、`fallbackModels` 是否为空，均无对应字段，用户拿不到任何原生路径线索
1.17 WHEN 主模型传输未取得凭据调用证据（`credentialedTransportVerified:false`、`credentialedTransportVerification.status:"model-transport-pending"`）且 `fallbackModels` 为 `[]`（`docs/adr/0013-...md` 明确不恢复 DeepSeek 文本回退）THEN 系统不报告「模型调不通时没有任何回退、会直接静默无回复」，也不把它列为零回复候选根因，用户无法看到当前最强候选
1.18 WHEN 系统判定飞书用户准入 THEN 它在 Hermes `config.yaml` 内按七个硬编码候选字段名扫描，而仓库内可核实的真实准入配置是 **Hermes Profile 本地环境文件中的 `FEISHU_ALLOWED_USERS`**（`apps/ajun-runtime/scripts/provision-hermes-employee-feishu.mjs` 写入 `<profileDir>/.env`，`integrations/feishu/README.md` 说明它只能填授权人员的用户 `open_id` 且变更后须重启 Gateway）；检查因此找错了配置位置，永远返回 `admission_field_not_found`，并漏掉 `docs/reviews/m1-xiaod-feishu-closure/acceptance.md` 已记录过的「白名单不命中 → `dm_policy_rejected` → 完全零回复」这一已验证故障模式
1.19 WHEN 诊断入口在「只读、绝不读取 `.env`」的硬性约束下运行 THEN 由于真实准入配置只存在于 `.env`，`feishu-admission` 一项在当前约束内**结构上不可判定**，而系统用 `admission_field_not_found`（「字段找不到」）这一错误码表述，掩盖了「位置正确但按约束不可读」与「位置找错」两种情形的区别
1.20 WHEN 需要解析 Hermes `config.yaml` THEN 系统在 `apps/ajun-runtime/src/feishu-commander-chain-observations.ts` 内手写行扫描解析器 `scanAdmissionWhitelist()`，而仓库已存在两处可复用能力：`integrations/hermes/scripts/set-feishu-toolsets.py` 的 `inspect` 动作（用 Hermes 自带 venv python 安全解析，输出 `mcp`（含 `enabled`、`timeout`、按白名单过滤的 scope env、命令/参数摘要）、`feishuToolsets`、`runtimePolicy`，并内建 `audit-config-secrets` 凭据审计与失败关闭）与 `integrations/hermes/scripts/check-hermes-business-profile-policy.mjs`（`evaluateHermesBusinessProfilePolicy()` / `checkHermesBusinessProfileHomes()`），构成 `AGENTS.md`「复用优先／不得为已有工具覆盖的问题另造平行实现」的违反
1.21 WHEN `scanAdmissionWhitelist()` 扫描 `config.yaml` THEN 它按裸键名逐行匹配、不区分父级路径，任何嵌套层级下的同名键（例如其他平台段落或无关配置段内的 `allowlist`）都会被当作飞书准入白名单返回，并以 `configured:true` 连同 `entryCount` 输出，形成用户无法察觉的假阳性
1.22 WHEN 诊断计算版本基线 THEN 它从 `integrations/hermes/scripts/patch-support.mjs` 取 `SUPPORTED_HERMES_VERSION`（`0.19.0`），而仓库内版本基线已三处重复且已漂移：`patch-support.mjs` 为 `0.19.0`、`integrations/hermes/runtime/agent_army_feishu_task_card.py` 为 `0.19.0`、`integrations/hermes/scripts/install-xiaod-public-video-bridge-v2.mjs` 已适配 `0.20.1`（含独立 commit pin）；真机 `0.20.1` 因此必然判为不匹配，且没有任何地方报出「基线自身漂移」这一事实
1.23 WHEN Hermes 升级覆盖 `adapter.py` 后 Gateway 重新启动 THEN 启动门禁 `integrations/hermes/scripts/start-hermes-gateway-guarded.mjs` 只校验技能白名单收敛与 bundled skills 退出，不校验补丁是否在位、也不校验版本/commit 是否仍在基线，Gateway 照常启动，故障只能在用户发出飞书消息且收不到回复时才被发现，同一缺陷会在每次升级后重复发生
1.24 WHEN 记录长期方向 THEN 现状与 ADR-0007 的既有结论相反：该 ADR 已决定「业务工具不再写入 Hermes 安装目录补丁」，而飞书总管链目前仍依赖十余个写入 Hermes 安装目录的补丁脚本，且仓库没有记录「哪些补丁是必需的、哪些可由原生能力 + MCP 替代」，使每次升级都必须重新适配整包补丁

### Expected Behavior (Correct)

每一种失败路径都必须产出飞书会话内可读的中文说明（发生了什么、是否启动了外部动作、下一步做什么），或至少在本机留下可判定的诊断证据；并提供一次性自检入口。

2.1 WHEN `AJUN_FEISHU_COMMANDER_INGRESS_URL` 未注入 Hermes launchd 环境 THEN 系统 SHALL 在本机留下可判定的「已声明但未配置」诊断证据，并使诊断入口报告该变量缺失
2.2 WHEN `AGENT_ARMY_FEISHU_AGENT_ID` 不等于 `ajun` THEN 系统 SHALL 使诊断入口报告实际 `agentId` 与期望值 `ajun` 的差异，并说明该 Profile 不拥有总管文本路由
2.3 WHEN `_route_ajun_commander_event` 在 `adapter.py` 中缺失 THEN 系统 SHALL 通过诊断入口报告补丁不在位，并给出重跑 `integrations/hermes/scripts/patch-feishu-agent-proposal-router.mjs` 的唯一下一步
2.4 WHEN A君 4321 不可达 THEN 系统 SHALL 在飞书会话内回复可归因的中文说明，明确未启动任何外部动作，并指向本机自检；`self.send` 亦失败时 SHALL 在本机留下带 `sourceEventRef` 的失败证据
2.5 WHEN `/api/feishu/commander` 因 `isLocalAddress` 返回 403 THEN 系统 SHALL 在飞书会话内说明入口拒绝了非本机调用且未启动任何外部动作，并在本机留下同一事件的证据
2.6 WHEN Hermes Gateway 进程未运行 THEN 诊断入口 SHALL 报告 Gateway 进程与 launchd 标签 `ai.hermes.gateway` 的实际状态，并明确「飞书消息此刻无人消费」
2.7 WHEN 发送者不在飞书用户准入白名单内 THEN 系统 SHALL 使诊断入口报告白名单是否命中，并说明消息因未获准入而被丢弃
2.8 WHEN A君返回 `handled:false` THEN 系统 SHALL 在本机记录该次「有意不建任务」的判定证据（含 `reason`），使无回复可与链路故障区分
2.9 WHEN 用户或运维触发本机诊断入口 THEN 系统 SHALL 一次性判定并逐项输出：Gateway 进程、adapter 补丁是否在位、必需环境变量是否注入、4321 是否可达且为预期 release、Profile guard 是否匹配、白名单是否命中；每项 SHALL 标注结论所处的能力真相层级（已声明 / 已配置 / 运行可达），且 SHALL NOT 用前一层冒充后一层
2.10 WHEN 用户查阅运行说明以启动飞书可用的服务 THEN 文档 SHALL 明确区分正式 4321（launchd 受控、跑不可变 release、飞书链路生效）与开发 4322（`AJUN_DISABLE_BACKGROUND_SERVICES=true`、飞书链路不通）
2.11 WHEN 诊断入口输出任何结论 THEN 系统 SHALL NOT 回显 secret、token、Cookie、授权链接或真实 `.env` 内容
2.12 WHEN 需要实现上述诊断能力 THEN 系统 SHALL 复用既有 `deterministic-local-health-probe.ts`、`/api/health`、`scripts/runtime-fingerprint.mjs` 与 `ops/ajun-release-helper/`，SHALL NOT 新建平行的诊断或控制面实现

以下七条对应真机新发现的缺陷（缺陷 A：2.13–2.17；缺陷 B：2.18–2.19）：

2.13 WHEN `adapter-patch` 判定为 `gap` 且 `hermesVersionMatchesBaseline` 为 `false` THEN 该项的唯一下一步 SHALL 说明补丁脚本已被版本锁定校验挡住（并给出实际版本与基线版本），且 SHALL 指向「补丁锚点需针对当前 Hermes 版本重新适配」，SHALL NOT 把「直接重跑补丁脚本」作为唯一下一步
2.14 WHEN `profile-guard` 因 `guardMarkerPresent` 为 `false` 判定为 `unknown` 且 `hermesVersionMatchesBaseline` 为 `false` THEN 该项的下一步 SHALL 同样说明版本锁定原因并指向锚点重新适配，SHALL NOT 建议直接重跑补丁脚本
2.15 WHEN 诊断因版本漂移调整下一步 THEN 系统 SHALL NOT 建议降低、绕过、放宽或删除版本锁定校验；该门禁挡住的正是「锚点对不上却硬打补丁」，SHALL 在结论中把它表述为保护而非障碍
2.16 WHEN `hermesVersionMatchesBaseline` 为 `null`（基线版本未注入、或 `pyproject.toml` 读不出）THEN 系统 SHALL 把它原样报为观测事实并说明版本无法判定，SHALL NOT 冒充「匹配」或「不匹配」，且 SHALL NOT 因此使诊断失败退出
2.17 WHEN 判定补丁脚本是否可执行 THEN 版本基线比对 SHALL 与版本锁定校验同源（版本号与 git commit 两者），或在只比对到版本号时 SHALL 明确标注该结论不足以证明门禁会放行
2.18 WHEN 用户需要让 `feishu-admission` 一项给出结论 THEN 准入白名单的候选字段路径 SHALL 可由调用方通过 CLI 参数或环境变量配置，使用户无需改动代码即可完成该项判定
2.19 WHEN 使用调用方提供的候选字段路径 THEN 系统 SHALL 只把配置值当作字段名使用，SHALL NOT 把 Hermes `config.yaml` 的字段值回显到输出，现有脱敏与摘要化处理 SHALL NOT 因可配置而放宽

以下十二条对应本轮新发现的缺陷（缺陷 C：2.20–2.22；缺陷 D：2.23–2.25；缺陷 E：2.26–2.28；缺陷 F 升级韧性：2.29–2.31）。**2.18 在当前 Hermes 版本下前提不成立**（真实准入配置不在 `config.yaml`），其目标由 2.23–2.25 取代；design 阶段须显式说明 2.18 的处置方式：

2.20 WHEN 诊断入口运行 THEN 系统 SHALL 覆盖 Hermes 原生会话侧，至少判定三项：（a）`config.yaml` 的 `mcp_servers.agent-army` 是否存在且未被 `enabled:false` 关闭；（b）实际生效的主模型 provider/model 是否与 `ajun.profile.json` 的 `modelSelection` 基线一致；（c）`credentialedTransportVerified` 是否仍为 `false`（即主模型传输尚未取得凭据调用证据）。每项 SHALL 标注所处能力真相层级并 SHALL NOT 超过其上限
2.21 WHEN 主模型传输未验证且 `fallbackModels` 为空 THEN 系统 SHALL 明确说明「主模型调不通时没有任何回退链，会直接静默失败、飞书会话内不产生任何回复」，并 SHALL 把它列为零回复的候选根因；同时 SHALL 说明该状态按 `docs/adr/0013-...md` 是「缺少凭据调用证据」的制度性状态，SHALL NOT 表述为「模型已确认不可用」
2.22 WHEN 诊断输出总体结论 THEN 系统 SHALL 区分两条并存路径（确定性 commander 路由 / Hermes 原生会话 + MCP）并分别给出该路径的判定，SHALL NOT 把 adapter 补丁缺口表述为零回复的唯一或充分原因
2.23 WHEN 判定飞书用户准入 THEN 系统 SHALL 如实报告位置事实：仓库内可核实的准入配置是 Hermes Profile 本地环境文件中的 `FEISHU_ALLOWED_USERS`（配套 `FEISHU_ALLOW_ALL_USERS` / `FEISHU_GROUP_POLICY`），当前 Hermes 版本的 `config.yaml` 内不存在飞书准入字段；SHALL NOT 继续以推测字段名给出判定，SHALL NOT 因读不出而暗示白名单已生效或已失效
2.24 WHEN 该项在「只读且绝不读取 `.env`」边界内无法判定 THEN 系统 SHALL 明确输出「按安全约束不可判定」这一结构性结论（区别于「字段找不到」），并 SHALL 给出不涉及凭据的下一步：由所有者自行确认发送者用户 `open_id` 是否在白名单内、并核对 Gateway 侧脱敏日志是否出现 `dm_policy_rejected`（该故障模式已有真机先例可循）
2.25 WHEN 输出准入相关结论 THEN 系统 SHALL NOT 读取、回显或摘要化 `.env` 的任何键值，SHALL NOT 输出 `open_id` 原值；需要引用发送者身份时 SHALL CONTINUE TO 只用现有摘要（`requesterRefDigest`）表达
2.26 WHEN 需要读取 Hermes `config.yaml` THEN 系统 SHALL 复用既有能力（`integrations/hermes/scripts/set-feishu-toolsets.py` 的 `inspect` 安全解析与凭据审计，或 `check-hermes-business-profile-policy.mjs` 的既有策略读取），SHALL NOT 另造平行 YAML 解析实现；同时 SHALL NOT 破坏诊断 CLI 的零第三方 npm 依赖与「`npm install` 未执行仍可跑完」属性。已核实的取舍事实 SHALL 写入 design：`check-hermes-business-profile-policy.mjs` 在模块顶层 `import yaml from 'js-yaml'`，而 `js-yaml` 未在仓库任何一方 `package.json` 中声明（仅作为其他包的传递依赖出现在 `node_modules`）；`set-feishu-toolsets.py` 走 Hermes 自带 venv python，不引入任何 npm 依赖。具体选型由 design 决定，但 SHALL NOT 以「新增一个第三方 npm 依赖」作为解法
2.27 WHEN 读取 `config.yaml` 内任何键 THEN 系统 SHALL 按完整父级路径限定（例如平台段落下的具体字段路径），SHALL NOT 按裸键名做全局匹配，且 SHALL 在结构不符合预期时报 `unknown` 而非猜测
2.28 WHEN 输出涉及模型 provider、MCP 或模型策略的结论 THEN 系统 SHALL 只输出「是否配置、是否与基线一致、是否启用」，SHALL NOT 回显 `api_key`、`base_url`、token、命令行原值或 `.env` 内容；引用敏感上下文键时 SHALL 复用既有做法（哈希摘要或 `${KEY}` 占位）
2.29 WHEN Hermes 版本或 git HEAD 与补丁基线不一致，或补丁标记不在位 THEN 系统 SHALL 在用户发出飞书消息之前的确定性检查点上报告该事实（复用 `start-hermes-gateway-guarded.mjs` 既有启动门禁位或等效的升级后自检点），使升级导致的补丁丢失可被主动发现，SHALL NOT 依赖「人记得升级后重跑补丁脚本」
2.30 WHEN 需要为新 Hermes 版本重新适配补丁 THEN 系统 SHALL 复用仓库内已验证的适配模式（`install-xiaod-public-video-bridge-v2.mjs` 针对 `0.20.1` 的显式锚点拓扑断言 + 本机源码只读 dry-run + 版本与 commit 双锁），并 SHALL 使版本基线单一来源化、在多处 pin 漂移时报出漂移本身；SHALL NOT 降低锚点校验强度、SHALL NOT 改为模糊匹配、SHALL NOT 绕过双锁
2.31 WHEN 记录长期升级韧性方向 THEN 系统 SHALL 按 ADR-0007「业务工具不再写入 Hermes 安装目录补丁」的既有结论，记录当前每个补丁标记「必需 / 可由原生能力 + MCP 替代」的判定，以缩小写入 Hermes 安装目录的补丁面；SHALL NOT 在本 spec 范围内删除任何既有补丁能力（属独立决策）

### Unchanged Behavior (Regression Prevention)

3.1 WHEN A君返回 `handled:false`（`explicit_direct_reply_without_task`）且 Hermes 模型侧正常 THEN 系统 SHALL CONTINUE TO 由 Hermes 普通聊天路径回复，不插入任何诊断或降级文案
3.2 WHEN 文本消息成功创建任务 THEN 系统 SHALL CONTINUE TO 返回 202 并按 `presentCommanderReply()` 现有契约在飞书回复任务信息
3.3 WHEN `/api/feishu/commander` 收到非本机来源的调用 THEN 系统 SHALL CONTINUE TO 返回 403 拒绝，不为诊断需要放宽本机校验
3.4 WHEN Feishu Profile 的 `agentId` 不是 `ajun` THEN 系统 SHALL CONTINUE TO 拒绝进入总管路由，即使该 Profile 误留了 Commander URL
3.5 WHEN 重复执行 `integrations/hermes/scripts/` 下的补丁脚本 THEN 系统 SHALL CONTINUE TO 按 `_V1` 标记保持幂等，不重复注入
3.6 WHEN 消息类型不是 `MessageType.TEXT` THEN 系统 SHALL CONTINUE TO 不进入总管文本路由
3.7 WHEN 调用既有 `/api/health` 与 `runtime-fingerprint` THEN 系统 SHALL CONTINUE TO 满足 `agent.army/runtime-health/v1` 与现有 fingerprint 输出契约
3.8 WHEN 其他四个常驻 Gateway（非 `ajun` 标签）处理各自 Profile 的消息 THEN 系统 SHALL CONTINUE TO 使用其独立 `HERMES_HOME`、launchd 环境与卡片账本，不受本次修复影响
3.9 WHEN 运行既有测试 THEN 系统 SHALL CONTINUE TO 使用原生 `node --test`，不引入新测试框架

以下四条对应真机新发现缺陷的保持性要求：

3.10 WHEN `hermesVersionMatchesBaseline` 为 `true` THEN `adapter-patch` 与 `profile-guard` SHALL CONTINUE TO 输出原有的「重跑补丁脚本并重载 Gateway」下一步，不得因新增版本分支而回归
3.11 WHEN 配置了候选字段路径后仍读不出准入白名单字段 THEN `feishu-admission` SHALL CONTINUE TO 报 `status:'unknown'`（既不是 `pass` 也不是 `gap`）、`truthLayer:'declared'`，且 SHALL CONTINUE TO 不输出 `hit`；不得因字段可配置而退化成猜字段
3.12 WHEN 诊断入口运行 THEN 系统 SHALL CONTINUE TO 保持只读、不读 `.env`、不产生外部副作用，且六项检查的 id、顺序、`truthLayerCeiling` 与退出码语义（`0` / `1` / `2`）保持不变
3.13 WHEN 版本锁定校验被补丁脚本调用 THEN `assertSupportedHermesCompatibility` SHALL CONTINUE TO 在版本号或 git commit 任一不匹配时拒绝执行并抛出中文错误，不为诊断可执行性放宽

以下七条对应本轮新增检查与升级韧性改动的保持性要求：

3.14 WHEN 新增 Hermes 原生会话侧检查 THEN 既有六项的 id、顺序、`truthLayerCeiling` 与退出码语义（`0` / `1` / `2`）SHALL CONTINUE TO 不变；design SHALL 明确新增项是扩展还是替换，若为扩展则 `CHAIN_CHECK_IDS` 的变更 SHALL 在 design 中说明对既有测试（含以六项齐全为断言的用例）的影响与迁移方式
3.15 WHEN 实施本轮任何改动 THEN `DIRECT_REPLY_V1` 分支 SHALL CONTINUE TO 一字不改，`handled:false` 交回 Hermes 原生会话的语义 SHALL CONTINUE TO 保持
3.16 WHEN 诊断入口运行 THEN 系统 SHALL CONTINUE TO 保持只读、不读取 `.env`、不产生任何外部副作用，且输出中零凭据
3.17 WHEN 诊断入口运行在未执行 `npm install` 的环境 THEN 系统 SHALL CONTINUE TO 跑完并给出六项（或扩展后的全部）判定，即零第三方 npm 依赖属性不被打破。（该属性此前只写在 design.md，本条把它固定为需求层约束）
3.18 WHEN 复用 Hermes 侧既有安全解析能力 THEN 其既有凭据审计与失败关闭语义（如检出疑似明文凭据、解析失败、结构不安全时拒绝继续）SHALL CONTINUE TO 不被放宽，且诊断 SHALL CONTINUE TO 只读不写 `config.yaml`
3.19 WHEN Gateway 启动门禁新增补丁在位与版本基线校验 THEN 既有的技能白名单收敛校验与 bundled skills 自动注入退出校验 SHALL CONTINUE TO 原样生效，不得被新增校验弱化、跳过或改为告警
3.20 WHEN 判定实际生效的主模型 provider/model THEN 系统 SHALL CONTINUE TO 只做本机只读回读（运行期模型策略文件与 Profile 映射），SHALL CONTINUE TO 不发起任何 provider 网络调用、不刷新账号模型目录、不产生任何计费

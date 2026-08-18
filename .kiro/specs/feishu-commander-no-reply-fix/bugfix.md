# Bugfix Requirements Document

## Introduction

用户在本机通过飞书私聊「A君·军团总管」（`agentId = ajun`）发送文本消息后，飞书会话内**没有任何回复**——既没有业务回复，也没有错误提示或降级说明。

调研确认：真正的缺陷不是链路上某一个环节坏了，而是**这条链上至少 8 个环节会静默失败**，使「无回复」成为不可归因的黑箱。链路为：

```
飞书客户端 → Hermes Gateway（adapter.py 的 _route_ajun_commander_event）
→ POST $AJUN_FEISHU_COMMANDER_INGRESS_URL（正式 http://127.0.0.1:4321/api/feishu/commander）
→ commander.handle() → presentCommanderReply() → 202 { reply | handled:false | task }
→ Hermes self.send(chat_id, reply, reply_to=message_id) → 飞书客户端
```

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

### 尚未排除的开放项

**「零回复」症状未被第 2 项完全解释。** 补丁丢失后，飞书文本消息会落回 Hermes 普通聊天
（`handle_message`），而普通聊天本应仍然产生回复；用户报告的是**完全无回复**。因此很可能存在第二个原因，
候选为需求 1.8 的 Hermes 模型侧异常（模型入口、密钥、预算、轮次上限），或飞书应用事件订阅侧
（未订阅消息事件、事件回调地址失效、应用被停用）。这两处**均未在真机关闭，标记未验证**。

据此重申：design.md 的推翻条件仍然完全有效。**不得因为定位到第 2 项就宣布 bug 已修复** ——
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

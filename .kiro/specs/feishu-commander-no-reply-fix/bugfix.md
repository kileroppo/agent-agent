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

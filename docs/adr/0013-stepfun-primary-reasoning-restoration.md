# ADR-0013：正式岗位主推理模型切回 StepFun

| 字段 | 内容 |
| --- | --- |
| 状态 | 已接受并切入本机 live |
| 日期 | 2026-08-14 |
| 决策者 | A君 |

## 决策

11 个正式 Hermes 岗位的主推理模型统一切回
`stepfun/step-3.7-flash`，回退链保持为空。微信私密只读检索岗位不纳入这
11 岗，继续使用本机回环 Qwen3.5-9B OpenAI-compatible 服务且禁止云端回退。

2026-08-14 后续补充：`step-3.7-flash` 继续作为全军默认，但模型策略不再要求
每次修改仓库文件。A君“账号与接入 → 军团模型策略”提供一次性全军切换和岗位
覆盖，并把结果保存在运行数据目录的 `stepfun-model-policy.json`。策略只允许
Step Plan 官方推理目录中的 `step-3.7-flash`、`step-router-v1`、
`step-3.5-flash-2603`、`step-3.5-flash`；保存时同时写入默认 Hermes、11 个
隔离 Profile 和 Paperclip roster。仓库 Manifest 保留发布初始值和失效回退值，
运行期有效值以该外部策略和实际 Profile/Paperclip 回读为准。

控制台的“刷新账号模型”直接复用已安装 Hermes 的认证模型目录，只读取模型 ID 并与上述官方
分类交叉核对。账号返回但尚未纳入官方能力策略的新 ID 只提示、不自动开放为军团主模型，避免
把图片、语音或协议受限模型误当成 Agent 主推理模型。

官方模型目录与能力边界以 [StepFun 模型能力总览](https://platform.stepfun.com/docs/zh/guides/models/overview)
和 [Step Plan 当前支持模型](https://platform.stepfun.com/docs/zh/step-plan/overview#支持的模型)
为依据。`step-explore` 是申请制、仅支持 Messages 协议，并明确不适合持续批量无人
值守任务，因此不进入军团主模型下拉框；此边界见
[Step Explore 使用范围](https://platform.stepfun.com/docs/zh/guides/models/step-explore#使用范围与上下文长度)。

本次不恢复历史 DeepSeek 文本回退，避免 StepFun 不可用时静默产生另一家
Provider 调用与费用。M5 的 StepFun 视觉、生图、图片编辑和 TTS 仍是独立媒体
能力，继续使用原有费用、授权和产物血缘门禁。

## 运行迁移

- AgentManifest、Hermes Profile 映射和 Paperclip `hermes_local` Adapter 统一写入
  StepFun 固定模型，并显式写空 `fallbackModels`/`extraArgs`；
- 后续 UI 切换执行“先写全部 Hermes Profile，再原子保存策略，再同步 Paperclip”；
  任一 Profile 写入失败时回滚已写项，不形成半切换状态；
- Hermes 默认 Profile、11 个隔离 Profile、常驻 Gateway、Paperclip roster 和 A君
  不可变 release 必须分别回读，不能只改界面或单个 Profile；
- 季度套餐凭据仅在本机 Hermes 配置之间受控同步，不回显、不写入仓库；本次不自动
  执行付费模型探针。没有当前凭据调用证据前，Profile 保持 `model-transport-pending`。

## 后果

- 本 ADR 取代 ADR-0011 的 DeepSeek 主模型决策；ADR-0011 继续保留为历史切换记录；
- Manifest 是发布初始值；存在运行期模型策略时，恢复与 roster reconciliation
  必须收敛到运行期策略指定的 StepFun 模型，回退链仍为空；
- 图片编辑、ASR、TTS、语音理解和实时语音只作为能力专用模型展示并按任务调用，
  不允许误选为 Hermes 主对话模型；
- 配置、进程和 API 回读只证明切换已加载，不证明季度套餐、真实传输或业务质量可用。

## 2026-08-17：退役本地模型网关

LiteLLM + PostgreSQL 的本地 Docker 栈已退役，12 个 Hermes Profile 恢复为直接使用
StepFun 官方入口。该变更只收回中间转发层，不改变本 ADR 的主模型
`stepfun/step-3.7-flash`、空文本回退链，或微信私密只读检索岗位的本机模型边界。

保留的限制与治理：

- Hermes Profile 的单次 `max_tokens`、最大轮次与会话压缩继续生效；
- Paperclip 继续是组织级预算、审批和审计的唯一真相；
- 外部 Provider 后台账单仍是费用的最终依据。

随网关退役而失去的能力：每岗位独立 LiteLLM 虚拟钥匙、普通直聊的每日美元硬停、统一的
4 万输入 Token 预拒绝，以及 LiteLLM 的调用/Token/估算费用聚合报表。不得把 Paperclip
组织级预算或 Hermes 的本地参数限制表述为这些能力仍存在。

本次不以付费模型探针作为切换门槛。退役后的 `PASS` 仅表示 12 个 Profile 的配置已回到
官方入口、运行中的 Hermes Gateway 已加载该配置，并且 LiteLLM/PostgreSQL/本地 `4000`
监听已退出；这不证明真实 StepFun 传输、套餐额度或业务产物质量。真实模型调用需在另有
费用授权时单独记账和验收。

## 2026-08-14 live 证据

- 默认 Hermes 与 11 个隔离 Profile 均回读为 `custom:sstefun / step-3.7-flash`，
  endpoint 为 `api.stepfun.com/step_plan/v1`，凭据存在且 fallback 为空；
- 5 个常驻 Gateway 已以新 PID 重启；Paperclip 11/11 正式岗位均回读为
  `stepfun / step-3.7-flash`，`fallbackModels=[]`、`extraArgs=[]`；
- A君已运行不可变 release `0f3017d13a2e…`，payload `5dbd1e17420e…`，
  Git `136a95998ae8…`；切换后 PID `90356`、4321 listener、cwd、entrypoint 与
  `/api/overview=200` 均已核对；
- 本轮未主动发起模型探针、飞书消息、业务任务或发布动作，主传输仍标记待真实业务验证。

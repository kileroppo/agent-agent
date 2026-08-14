# ADR-0013：正式岗位主推理模型切回 StepFun

| 字段 | 内容 |
| --- | --- |
| 状态 | 已接受，运行切换中 |
| 日期 | 2026-08-14 |
| 决策者 | A君 |

## 决策

11 个正式 Hermes 岗位的主推理模型统一切回
`stepfun/step-3.7-flash`，回退链保持为空。微信私密只读检索岗位不纳入这
11 岗，继续使用本机回环 Qwen3.5-9B OpenAI-compatible 服务且禁止云端回退。

本次不恢复历史 DeepSeek 文本回退，避免 StepFun 不可用时静默产生另一家
Provider 调用与费用。M5 的 StepFun 视觉、生图、图片编辑和 TTS 仍是独立媒体
能力，继续使用原有费用、授权和产物血缘门禁。

## 运行迁移

- AgentManifest、Hermes Profile 映射和 Paperclip `hermes_local` Adapter 统一写入
  StepFun 固定模型，并显式写空 `fallbackModels`/`extraArgs`；
- Hermes 默认 Profile、11 个隔离 Profile、常驻 Gateway、Paperclip roster 和 A君
  不可变 release 必须分别回读，不能只改界面或单个 Profile；
- 切换过程不读取或复制密钥，不自动执行付费模型探针；没有当前凭据调用证据前，
  Profile 保持 `model-transport-pending`。

## 后果

- 本 ADR 取代 ADR-0011 的 DeepSeek 主模型决策；ADR-0011 继续保留为历史切换记录；
- Manifest 是正式岗位模型策略真相，恢复与 roster reconciliation 必须收敛到
  StepFun 主模型和空回退链；
- 配置、进程和 API 回读只证明切换已加载，不证明季度套餐、真实传输或业务质量可用。

# ADR-0011：正式岗位主推理模型切换为 DeepSeek

| 字段 | 内容 |
| --- | --- |
| 状态 | 已由 ADR-0013 取代；保留为历史切换记录 |
| 日期 | 2026-08-02 |
| 决策者 | A君 |

## 决策

11 个正式 Hermes 岗位的主推理模型统一改为 `deepseek/deepseek-v4-flash`，回退链清空，不再尝试 StepFun 文本模型。微信私密只读检索岗位不纳入这 11 岗；其原始决定使用本机 `ollama-local/qwen3:14b`，已于 2026-08-04 因模型删除而由本地 AI 能力系统迁移为回环 Qwen3.5-9B OpenAI-compatible 服务，仍禁止云端回退。

M5 的 StepFun 视觉、生图、图片编辑和 TTS 是独立媒体 Provider 能力，不属于岗位文本推理模型。本次不以 DeepSeek 文本模型冒充替代；StepFun 无额度时这些阶段保持失败关闭并等待后续媒体 Provider 决策。

## 运行迁移

- AgentManifest、Hermes Profile 映射和 Paperclip `hermes_local` Adapter 统一写入 DeepSeek 固定模型，并显式写空 `fallbackModels`/`extraArgs`，防止平台合并旧配置；
- 11 个本机 Hermes Profile 已切换，5 个常驻 Gateway 已重启；
- A君已切到包含新策略的不可变 release，启动后的岗位对账为 11/11 DeepSeek；
- 本次没有执行付费模型探针，因此 Profile 的新主传输证据保持 `model-transport-pending`，不能把配置切换写成真实调用通过。

## 后果

- 自 2026-08-14 起，本 ADR 的主模型决策由
  [ADR-0013](./0013-stepfun-primary-reasoning-restoration.md) 取代；
- ADR-0008 和 ADR-0009 中“StepFun 文本主模型、DeepSeek 仅回退”的部分被本 ADR 取代；历史 StepFun 验收账本继续作为历史证据保留；
- 在本 ADR 生效期间，恢复或同步岗位时以当时 Manifest 为模型策略真相，并清除旧 StepFun 文本配置；
- M5 媒体工具的额度、凭据、费用和真实调用仍按原独立门禁处理。

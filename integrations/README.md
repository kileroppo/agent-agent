# Integrations

这里存放军团与外部平台之间的适配层，例如：

- Hermes 的 Profile、飞书 Gateway、执行任务和 heartbeat 适配；
- M2 Paperclip 的组织投影、预算、审批和跨 Agent 审计适配；
- 飞书 Channel SDK、Lark CLI 和开放 API 适配。

平台凭据必须通过各集成自己的本地环境配置或受控密钥存储注入，不写入代码和文档。

适配器职责、数据真相和失败恢复见 [系统架构](../docs/architecture/system-architecture.md)，输入输出遵循 [核心契约](../docs/contracts/core-contracts.md)。

M1 不建立 Paperclip 执行任务适配器，避免与 Hermes Kanban 形成双任务真相。分阶段决定见 [ADR-0002](../docs/adr/0002-phase-paperclip-after-m1-runtime-closure.md)。

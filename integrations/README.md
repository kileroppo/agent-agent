# Integrations

这里存放军团与外部平台之间的适配层，例如：

- Hermes 的 Profile、飞书 Gateway、执行任务和 heartbeat 适配；
- M2 Paperclip 的组织、任务、heartbeat、预算、审批、审计和运行时适配；
- 飞书 Channel SDK、Lark CLI 和开放 API 适配。

平台凭据必须通过各集成自己的本地环境配置或受控密钥存储注入，不写入代码和文档。

适配器职责、数据真相和失败恢复见 [系统架构](../docs/architecture/system-architecture.md)，输入输出遵循 [核心契约](../docs/contracts/core-contracts.md)。

M1 不建立 Paperclip 执行任务适配器，避免与 Hermes Kanban 形成双任务真相。M2 由 Paperclip 作为军团唯一总控，运行时适配器只领取其 heartbeat 并回报结果；A君不建设第二套军团控制台。分阶段决定见 [ADR-0002](../docs/adr/0002-phase-paperclip-after-m1-runtime-closure.md)。

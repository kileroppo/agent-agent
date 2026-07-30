# Integrations

这里存放军团与外部平台之间的适配层，例如：

- Hermes 的 Profile、飞书 Gateway、执行任务和 heartbeat 适配；
- M2 Paperclip 的组织、任务、heartbeat、预算、审批、审计和运行时适配；
- 飞书 Channel SDK、Lark CLI 和开放 API 适配。

平台凭据必须通过各集成自己的本地环境配置或受控密钥存储注入，不写入代码和文档。

适配器职责、数据真相和失败恢复见 [系统架构](../docs/architecture/system-architecture.md)，输入输出遵循 [核心契约](../docs/contracts/core-contracts.md)。

M1 不建立 Paperclip 执行任务适配器，避免与 Hermes Kanban 形成双任务真相。M2 由 Paperclip 作为军团唯一总控，运行时适配器只领取其 heartbeat 并回报结果；A君不建设第二套军团控制台。分阶段决定见 [ADR-0002](../docs/adr/0002-phase-paperclip-after-m1-runtime-closure.md)。

M5 目标源码由 [Paperclip 内容流水线](./paperclip/m5-content-pipeline/README.md)、
[内容自治插件](./paperclip/plugins/content-autonomy/README.md) 和
[Publisher Gateway](./publishing/m5-publisher-gateway/README.md) 共同实现：18 阶段、
15 Routine，daily/publisher/metrics/retrospective 4 个无模型控制器；发布、指标和
复盘分别写回专用 `PublishReceipt`、`MetricSnapshot` 和版本化 Retrospective
Work Product。少于 5 条同类型真实 72h 指标时不得生成 `LearningProposal`，达到
门槛也只生成待审核建议。当前 live 已对账为 18 阶段、15 Routine 和 4 个控制器，
但活动仍是未批准草案且 Cron 关闭；本地测试或 Fake 回执不代表真实平台成功。

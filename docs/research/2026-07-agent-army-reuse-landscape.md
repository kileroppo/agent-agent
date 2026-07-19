# Agent军团：现成能力复用调研（2026-07）

## 结论

Agent军团不应从零开发一个“多 Agent 平台”。当前最短路径是：

```text
飞书传统机器人 → Hermes（消息、权限、会话）→ 小D业务应用（任务与产物）→ 飞书交付
```

M1 的缺口是一次真实、可验证的消息与交付闭环，而不是编排器、队列、仪表盘或第二个 Agent runtime。后续每增加一个平台，必须说明它消除了哪个已经发生的痛点，以及它不与现有任务真相重复。

## 现在直接复用（M1）

| 能力 | 采用方式 | 不要自研的部分 |
| --- | --- | --- |
| 飞书消息入口 | 继续使用 Hermes 官方传统机器人 WebSocket 适配器与独立 `xiaod` Profile | 收发消息、白名单、群组 @ 门禁、去重、重连、媒体收发 |
| 小D媒体处理 | 保持现有本地转录；用 `ffprobe`/`ffmpeg` 做格式识别与音频规范化 | 编解码、音轨抽取、媒体时长识别 |
| 任务可靠性 | 在现有业务任务中增加事件、任务、交付三类幂等键和阶段 checkpoint | 第二套队列或“万能重试” |
| 输入与回调校验 | 在飞书适配层使用 Zod 或 JSON Schema | 用 Prompt 判断数据是否合法 |
| 可观测与验收 | Hermes `logs`、`insights`、任务阶段账本和固定的脱敏样例人工验收 | M1 的外部 Trace/Eval 平台 |

### M1 最小可靠性门禁

1. 只接受允许的消息类型、MIME、大小与时长；用 `ffprobe` 验证实际媒体，而非信任扩展名。
2. 使用 `event_id → task_id`、`message_id + file_key + 内容哈希` 与 `delivery_key`；下载、转录、写文档、回消息分别记录状态。
3. 只重试网络、429 和短暂 5xx；转录、模型润色、建文档与最终外发必须先核对 checkpoint 和幂等键。
4. 交付要分别确认“文档已创建”和“正文完整写入”；聊天消息或摘要不能代表完整交付。
5. 日志只留任务 ID、阶段、尝试数和错误类别；不留原文、媒体链接、签名 URL、凭据或用户隐私。

小D的推荐交付格式不变：处理结论、内容导览、完整校对文本、已知不确定项。

## 等 M1 通过后再做的验证（M2）

| 目标 | 首选复用件 | 定位与边界 |
| --- | --- | --- |
| 军团组织、目标、预算、协作审计 | [Paperclip](https://github.com/paperclipai/paperclip) | 控制面，不替代 Hermes 执行层或小D业务任务库；用 `paperclipIssueId ↔ xiaodJobId` 关联，只有小D确认交付才可完成 issue。 |
| 明确需要暂停、审批、恢复的岗位流程 | [LangGraph](https://docs.langchain.com/oss/python/langgraph/overview) | 仅封装在一个业务 Agent 内；不替代飞书入口、Hermes 或 Paperclip。 |
| Prompt/模型回归 | [Promptfoo](https://www.promptfoo.dev/docs/integrations/ci-cd/) | 用 10–20 条脱敏固定样例跑离线门禁；不把真实飞书会话或生产工具接入红队。 |
| 链路观测 | [Phoenix](https://github.com/Arize-ai/phoenix) 或 [LangSmith](https://docs.langchain.com/langsmith/observability) 二选一 | 数据控制优先选 Phoenix，自建 OpenTelemetry span；接入速度优先才选 LangSmith，并先评估数据外发。 |
| 稳定后台批处理 | [Windmill](https://www.windmill.dev/docs/core_concepts/workflows_as_code) 或 [n8n](https://docs.n8n.io/hosting/scaling/queue-mode/) 二选一 | Windmill 适合代码化作业与权限/日志；n8n 适合外围 SaaS 自动化。两者都不拥有核心任务真相。 |

### Paperclip 的安全前提

Paperclip 可省去组织、目标、预算硬停、审批、审计与跨 Agent 协作的自研，但 M2 只能在隔离、非公网、最小权限环境做试点。历史安全公告涉及严重问题；升级前必须核验发行说明和 [安全公告](https://github.com/paperclipai/paperclip/security/advisories)。初期禁用与个人邮箱/连接器绑定的本地 Codex runtime，不给聊天入口全权限长期 key。

## 按真实需求再引入（M3 及以后）

- 多小时、高价值、重启后绝不能丢的流程：评估 [Temporal](https://docs.temporal.io/)，而不是现在预装。
- 多 worker 并发和定时批量任务：评估 [BullMQ](https://docs.bullmq.io/) + Redis；在此之前，`failed` 状态和人工续跑就是诚实的失败队列。
- 多模型、多人或成本需要归因：评估 [LiteLLM Proxy](https://docs.litellm.ai/docs/proxy/virtual_keys)。
- 多人会议说话人分离：按明确需求评估 [WhisperX](https://github.com/m-bain/whisperx)；它需要额外模型与授权边界。
- 用户有权处理的公开链接媒体：才评估 [yt-dlp](https://github.com/yt-dlp/yt-dlp)；不得读取浏览器 Cookie 或规避平台限制。
- 飞书进度/确认体验：先用卡片；当审批对象、审批定义和状态回写稳定后，再接飞书原生审批。卡片回调的服务端校验必须包含动作指纹、过期、单次使用与风险说明。

## 明确不在当前引入

1. **OpenClaw 与 Hermes 并行运行。** 两者都覆盖消息入口、会话、工具、记忆和调度；同一机器人双运行时会造成重复消息和双真相。OpenClaw 的飞书实现、通道隔离、队列与去重可作为可靠性参考或整体迁移备选，而不是 M1 叠加层。
2. **Dify 或 Flowise 作为生产核心。** 它们适合知识库和流程试验；稳定前会带来第二份 Prompt、模型、凭据、状态与审计。
3. **M1 的独立 Docker ASR 平台、WhisperX、URL 下载和复杂卡片审批。** 它们没有解决当前“第一条真实消息闭环”的阻塞。
4. **依赖总审核 Agent 兜底。** 工具级校验仍不可省略：OpenAI Agents SDK 的输入 guardrail 只作用在链路首 Agent、输出 guardrail 只作用在最终输出。每个外发、写入、发布或花费动作都需自己的白名单、参数校验、审批和幂等策略。

## 采用顺序与验收

1. **M1：** 传统机器人一条无敏感文本消息 → Hermes 白名单准入 → 小D任务创建 → 飞书回复；再验证一条短媒体的下载、转录和可读交付。
2. **M1 稳定后：** 为小D建立脱敏回归样例与失败续跑规则；只在出现真实批量/定时痛点时选择 Windmill 或 n8n 之一试点。
3. **M2：** Paperclip 本地隔离 PoC，仅投影一条非敏感小D任务，验收领取、进度、人工确认、预算/超时和失败恢复；不接自动外发。
4. **军团扩展前：** 每个 Agent 都必须先有职责、输入输出、工具白名单、禁止动作、升级条件、质量样例和成本上限这七项，再讨论并发数量。

## 一手资料索引

- [Hermes Feishu/Lark 指南](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/feishu)、[Profiles](https://hermes-agent.nousresearch.com/docs/user-guide/profiles)、[Kanban](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban)
- [飞书智能体接入概览](https://open.feishu.cn/document/mcp_open_tools/integrating-agents-with-feishu/overview)、[飞书 Node 长连接示例](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case)、[获取消息资源文件](https://open.feishu.cn/document/server-docs/im-v1/message/get-2)
- [Paperclip Hermes 适配器](https://github.com/paperclipai/paperclip/tree/master/packages/adapters/hermes)、[Paperclip secrets](https://github.com/paperclipai/paperclip/blob/master/docs/deploy/secrets.md)
- [OpenClaw 飞书通道](https://docs.openclaw.ai/channels/feishu)、[多 Agent 路由](https://docs.openclaw.ai/concepts/multi-agent)
- [Anthropic: Building Effective AI Agents](https://www.anthropic.com/engineering/building-effective-agents)、[OpenAI: practical guide](https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/)
- [FFmpeg](https://github.com/ffmpeg/ffmpeg)、[faster-whisper](https://github.com/SYSTRAN/faster-whisper)、[飞书文档 Block 批量更新](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document-block/batch_update)
- [p-retry](https://github.com/sindresorhus/p-retry)、[Pino redaction](https://getpino.io/#/docs/redaction)、[Zod](https://zod.dev/)

> 本文是选型与复用边界，不等于已安装或已验证这些外部产品。每一项进入实现前，仍需按当期 PRD、权限、数据和成本边界做单独验收。

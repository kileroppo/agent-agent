# M5 工具与执行框架复用调研

日期：2026-07-30

## 结论

M5 不引入新的通用 Agent 框架或自建状态机。当前本机的 Paperclip 2026.707 和 Hermes 0.19 已覆盖绝大多数底层能力，仓库只实现内容生产和发布的业务缺口。

| 需求 | 采用 | 不采用及原因 |
| --- | --- | --- |
| 持久任务、并发、预算、审批、审计、恢复 | [Paperclip](https://github.com/paperclipai/paperclip) Issue/Run/Budget/Execution Policy | Temporal、Hatchet功能成熟，但会形成第三套任务控制面 |
| 固定内容阶段与人工审核 | Paperclip Pipeline/Case + on-enter Routine | 自建 DAG/JSON 状态机与 Paperclip 重复 |
| 7 天日程和唤醒 | Paperclip Routine；Hermes 只承接岗位 Session | 自建 Cron 重复 |
| 岗位技能与工具最小权限 | Paperclip agent tool grants + Hermes 独立 Profile 的 skills/MCP/tools | 自建 SkillBundle 注册表重复；Hermes bundle 仅用于组合加载说明，不作为权限边界 |
| 插件工具隔离与审计 | [Paperclip Plugin SDK](https://github.com/paperclipai/paperclip/blob/master/doc/plugins/PLUGIN_SPEC.md) | Composio 主要解决 SaaS 应用连接，不替代本地内容/发布契约 |
| 不可信第三方 MCP | 后续需要时评估 [ToolHive](https://github.com/stacklok/toolhive) | 当前未安装，现有 MCP 是本机受控 stdio；现在引入收益不足 |
| 容器化 MCP | 暂不采用 [Docker MCP Gateway](https://github.com/docker/mcp-gateway) | 本机 Docker 当前没有 `docker mcp` 插件，升级会扩大本轮范围 |
| Agent 图执行 | 不引入 [LangGraph](https://github.com/langchain-ai/langgraph)、[Mastra](https://github.com/mastra-ai/mastra) | 持久图与 HITL 很强，但与 Hermes/Paperclip 职责重叠 |
| TypeScript 耐久工作流 | 不引入 [Temporal](https://github.com/temporalio/sdk-typescript)、[Hatchet](https://github.com/hatchet-dev/hatchet) | 适合独立工作流产品，不适合在已有 Paperclip 控制面旁再建一套 |
| 视频时间线 | 复用 [Remotion](https://github.com/remotion-dev/remotion) 与官方 Agent Skills；最终编码使用 FFmpeg | 不采用来源不明的 FFmpeg MCP；本地确定性封装更小、更可审计 |
| StepFun 多模态 | Paperclip 插件内实现薄适配 | 未发现 StepFun 官方 MCP；官方 Hermes 指南也建议 API Key、二进制和流式能力用 Plugin/Tool |

## 本机事实

- Paperclip：`2026.707.0`，已运行在 `http://localhost:3100`，具备 Plugin、Pipeline、Routine、预算、审批与审计；当前没有安装插件。
- Hermes：`0.19.0`，具备 Profile、skills audit、MCP、tools、Cron、Session、Project、Worktree 与 checkpoint。
- Docker：已安装，但当前 CLI 没有 `docker mcp` 子命令。
- ToolHive、Temporal、Hatchet：本机未安装。

## 保留的自研边界

1. CampaignGrant、ContentVersion、PublishReceipt、MetricSnapshot 的内容领域校验；
2. StepFun 视觉、生图/改图和官方音色 TTS 的薄适配；
3. 受控工作区内的 FFprobe、FFmpeg、Remotion 模板；
4. 抖音官方 API / 受控 Computer Use、小红书受控 Computer Use 发布连接器；
5. 平台幂等、重复哈希、验证码/风控停机和指标回流。

这些能力以 Paperclip 插件提供，不进入 A君运行时核心，也不替代 Paperclip/Hermes 的控制面。

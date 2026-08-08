# Agent 使用说明书问答接入交接

| 字段 | 内容 |
| --- | --- |
| 状态 | 待验收 |
| 创建时间 | 2026-08-07 21:07 CST |
| 交出者 | Codex |
| 接手者 | 负责人 |
| 关联任务 | [Agent军团使用说明书](../../guides/Agent军团使用说明书.md) |
| 截止条件 | 当前不可变运行时与 11 个 Hermes Profile 完成受控切换，并通过真实飞书问答验收 |

## 1. 接手目标

- 目标：A君可查询任一或全部已上岗 Agent 的完整说明书；每个独立 Agent 只能查询自己的说明书。
- 用户约束与不可做事项：说明书查询必须只读，不创建业务任务，不触发登录、外发、付费或权限扩大；不能用共享脏工作树直接覆盖 live。
- 做完的定义：A君飞书实测单个与 `all` 成功；任一独立 Agent 实测自己的说明书成功、查询其他岗位失败；答案包含输出示例和成功运行证据状态。
- 唯一下一步：负责人在小D真实飞书私聊再次发送“你的使用说明书是什么？”，确认只返回面向用户的说明书、不再显示 `tool_describe` 等内部工具进度；通过后继续其余三条权限边界验收。
- 允许继续的前提：小D DeepSeek 授权已由负责人在本机更新；真实消息会产生最小模型调用费用，除此之外不夹带业务执行、外发和扩权动作。

## 2. 当前事实

| 类别 | 事实 | 证据位置 | 状态 |
| --- | --- | --- | --- |
| 代码与文档 | 12 个 active Manifest 已有结构化 `userManual`；11 个正式岗位已声明 `agent_manual`；MCP 权限边界和 Prompt 已接入 | `agents/*/manifest.json`、`apps/ajun-runtime/src/agent-manual-service.js`、`integrations/hermes/profiles/` | 已验证 |
| 本地运行时 | 2026-08-07 21:19 切到 PID 8642、release `99f99c56b020…`、payload `e94025082f6b…`、gitHead `9a34c003…`；`/api/overview=200`，11 岗和 777 条任务保持，运行中为 0 | `node scripts/runtime-fingerprint.mjs`、launchd PID/cwd 和 overview 回读 | 已验证 |
| Hermes Profile | 11 岗已同步 SOUL、`agent_manual` 与 clean MCP 路径；飞书内部工具进度已统一关闭；`platforms.feishu.gateway_restart_notification` 已统一设为 `false`，A君真实默认 Home 的 Feishu 与 Telegram 也已关闭该通知。5 个常驻 Gateway 已通过 `suppress_notification=true` 的静默 drain 完成重启，均重连飞书且日志确认没有新的停机通知；A君首次使用错误 Profile drain 路径时曾向 Telegram 管理会话多发一条旧提示，随后已修正并复验 | `/tmp/agent-manual-live-profile-postcheck.json`、Hermes 配置解析回读、静默 drain 日志、launchd 回读 | 已验证 |
| 外部平台 | 小D于 2026-08-07 22:06 成功处理真实说明书问题，10.9 秒完成 3 次 API 调用并返回 420 字，证明新 DeepSeek 凭据和 `agent_manual` 路径有效；同时发现飞书默认工具进度把内部 `tool_describe` 暴露给用户。22:10 已将 11 个正式 Profile 的 `display.platforms.feishu.tool_progress` 统一设为关闭并重启 5 个常驻 Gateway，小D新 PID 45746 已重连飞书 | 负责人反馈、小D脱敏 Gateway 日志、11 Profile 配置回读和 launchd 回读 | 待无内部提示复验 |
| 人工确认 | 未做答案可读性和截图验收 | 无 | 待确认 |

## 3. 变更与决策

- 已完成：集中长版说明书；Manifest 说明书 schema；12 岗内容；只读 MCP 工具；A君全量/单岗查询；独立岗位仅自己查询；真实输出样例与证据状态；Profile、Prompt 和测试契约。
- 关键文件：`docs/guides/Agent军团使用说明书.md`、`agents/schema/agent-manifest.schema.json`、`apps/ajun-runtime/src/agent-manual-service.js`、`apps/ajun-runtime/src/agent-army-mcp-server.js`、`integrations/hermes/README.md`。
- 已确定的边界：Manifest 的 `userManual` 是 Agent 问答真相；集中说明书是长版阅读材料。后台岗位没有独立飞书入口时，A君必须明确说明转派入口。
- 不要重复创建的产物：不要新建第二套说明书数据库、任务类型或说明书业务任务；不要让独立岗位通过 Prompt 绕过 MCP 的身份限制。

## 4. 验证账本

| 层级 | 结论 | 命令或证据 | 未证明部分 |
| --- | --- | --- | --- |
| 自动化 | PASS | clean 基线 `npm test --workspace=ajun-runtime`：1189/1189；Profile/MCP/Manifest 定向测试 56/56；架构与冻结包全套验证通过 | 无 |
| 运行时 | PASS | 新 release 启动 smoke、只读 recovery smoke、4321 PID/cwd/overview、A君 12 份、小D自己和越权拒绝均通过 | 无 |
| 外部平台 | PARTIAL PASS | 小D真实说明书问题已成功返回，Provider、飞书和 `agent_manual` 均已打通；内部工具进度泄漏已通过 11 Profile 统一关闭并完成网关重启 | 再发一条相同问题，确认只保留最终说明书 |
| 人工验收 | NOT CHECKED | 无 | 真实回答排版、长答案可读性、成功截图 |

## 5. 风险、权限与关闭

- 当前阻塞或风险：小D新凭据已经真实调用验证；飞书内部工具进度已统一关闭，但尚待人工确认第二次回答不再出现 `tool_describe`。2026-08-07 23:03 的真实“你好”已确认小R和小办均能收取飞书消息，但当时各自的旧 DeepSeek 凭据被 Provider 返回 HTTP 401。小办 `.env` 已于 23:08 更新，Gateway PID 99294 已重启并重连；小R `.env` 已于 23:13:54 更新，Gateway PID 4045 已于 23:14 重启并重连。两份新凭据均尚待负责人用真实飞书消息完成 Provider 验签。其他岗位仍只确认“已配置”，尚未逐个做真实传输探针。另有精确旧版自动回滚证明缺口，但旧 release、匹配源码、plist 备份和新 release 的只读 recovery 均已保留。
- Provider 用户提示已安装中文分类补丁：DeepSeek 402/余额不足提示联系管理员补充额度；401 提示模型授权异常；429 提示等待 1–2 分钟；500/503 等提示服务暂时不可用。原始错误只保留在脱敏日志，不在聊天中展示 Provider、HTTP 状态或凭据细节。
- 不得复制或展示的信息：Hermes Profile 内凭据、飞书 App Secret、Token、Cookie、用户/会话标识和私密聊天原文。
- 需要谁确认：负责人在小D真实飞书私聊完成一条说明书问题验收；随后完成 A君单岗/全岗和独立岗位越权边界验收。
- 关闭条件：新 release 在 4321 生效；11 个 Profile 同步成功；A君单岗/全岗、独立岗位自己/越权四条真实飞书路径通过；验收记录补入时间与脱敏截图。
- 关闭证据链接：待补。

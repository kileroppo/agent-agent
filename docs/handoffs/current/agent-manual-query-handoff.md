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
- 唯一下一步：负责人在真实飞书依次验证“A君单岗、A君全部、独立 Agent 自己、独立 Agent 越权”四条问答，并确认长答案排版可读。
- 允许继续的前提：只发送说明书查询，不批准或夹带业务执行、外发、付费和扩权动作；截图前遮挡用户与会话标识。

## 2. 当前事实

| 类别 | 事实 | 证据位置 | 状态 |
| --- | --- | --- | --- |
| 代码与文档 | 12 个 active Manifest 已有结构化 `userManual`；11 个正式岗位已声明 `agent_manual`；MCP 权限边界和 Prompt 已接入 | `agents/*/manifest.json`、`apps/ajun-runtime/src/agent-manual-service.js`、`integrations/hermes/profiles/` | 已验证 |
| 本地运行时 | 2026-08-07 21:19 切到 PID 8642、release `99f99c56b020…`、payload `e94025082f6b…`、gitHead `9a34c003…`；`/api/overview=200`，11 岗和 777 条任务保持，运行中为 0 | `node scripts/runtime-fingerprint.mjs`、launchd PID/cwd 和 overview 回读 | 已验证 |
| Hermes Profile | 11 岗已同步 SOUL、`agent_manual` 与 clean MCP 路径；二次 dry-run 全部 `changed=false`；5 个常驻 Gateway 已重启并取得新 PID | `/tmp/agent-manual-live-profile-postcheck.json`、launchd 回读 | 已验证 |
| 外部平台 | 未在飞书向任何 Bot 发送说明书问题 | 无 | 未验证 |
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
| 外部平台 | PARTIAL | 11 个 Profile 二次 dry-run 零漂移，5 个常驻 Gateway 重启后 active | 尚未发送真实飞书说明书问题 |
| 人工验收 | NOT CHECKED | 无 | 真实回答排版、长答案可读性、成功截图 |

## 5. 风险、权限与关闭

- 当前阻塞或风险：真实飞书排版尚未人工验收；精确旧版自动回滚缺少可信 OS/launchd/状态快照联合证明，但旧 release、匹配源码、plist 备份和新 release 的只读 recovery 均已保留。
- 不得复制或展示的信息：Hermes Profile 内凭据、飞书 App Secret、Token、Cookie、用户/会话标识和私密聊天原文。
- 需要谁确认：负责人完成真实飞书答案验收。
- 关闭条件：新 release 在 4321 生效；11 个 Profile 同步成功；A君单岗/全岗、独立岗位自己/越权四条真实飞书路径通过；验收记录补入时间与脱敏截图。
- 关闭证据链接：待补。

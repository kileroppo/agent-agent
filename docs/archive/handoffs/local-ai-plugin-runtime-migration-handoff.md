# 本地 AI 插件运行时迁移交接

> 2026-08-17 归档：原交接已关闭；最终事实见[产品成熟度总交接](./agent-army-product-maturity-handoff.md)。

| 字段 | 内容 |
| --- | --- |
| 状态 | 已归档；原交接已关闭 |
| 创建时间 | 2026-08-16 10:31 CST |
| 关闭时间 | 2026-08-16 10:31 CST |
| 交出者 | Codex |
| 接手者 | 项目维护者 |
| 关联任务 | [本地 AI PRD](../../../tasks/prd-local-ai-capability-control.md)、[ADR-0014](../../adr/0014-local-ai-plugin-runtime-isolation.md)、[验收记录](../../reviews/local-ai-capability-system/acceptance.md) |
| 截止条件 | 本机运行物迁出项目、最终插件 release 生效、A君回读和真实 smoke 通过、换电脑安装说明完整 |

## 1. 接手目标

- 目标：让本地 AI 成为项目外、可升级、可回滚、可在另一台 Apple Silicon Mac 重建的插件。
- 用户约束与不可做事项：不得跟 A君或项目发布包一起滚版；不得把模型、venv、日志、索引、配对 token 放进仓库。
- 做完的定义：LaunchAgent 不引用 checkout，18082 与 A君 Interface 正常，真实文本/Embedding smoke 通过，新机只看项目说明即可安装。
- 唯一下一步：无当前待办；更换电脑时按[插件 README](../../../ops/local-ai/README.md)执行新机安装，并在新机器重新跑 status 与 smoke。
- 允许继续的前提：模型下载、4070 配对或外部 Provider 调用仍需对应授权；不得复制配对 token 到文档或聊天。

## 2. 当前事实

| 类别 | 事实 | 证据位置 | 状态 |
| --- | --- | --- | --- |
| 代码与文档 | 内容哈希 release、动态 plist、新机安装、运行根迁移与回滚均已实现 | `ops/local-ai/`、ADR-0014、插件 README | 已验证 |
| 本地运行时 | release `7516c36b…` 活动；18082 可达，A君控制状态 ready；LaunchAgent program/cwd/logs 全在项目外 | `npm run local-ai:plugin:status`、`npm run local-ai:status` | 已验证 |
| A君与 Paperclip | A君原不可变 release 和 Paperclip 均 HTTP 200；A君显示 `local-ai=ready` | `npm run runtime:fingerprint`、A君本地控制 API | 已验证 |
| 外部平台 | 4070 当前离线；本轮没有外发、发布或付费调用 | 18082/A君控制状态 | 已验证 |
| 人工确认 | 用户明确确认迁移，并要求可热插拔、可换电脑重建 | 当前任务 | 已确认 |

## 3. 变更与决策

- 已完成：把约 1.6 GiB Python 环境、日志、索引和产物迁到 `$HOME/Library/Application Support/AgentArmy/local-ai`；插件代码放到独立内容哈希 release；删除项目内旧运行根和重复 MLX-VLM 环境。
- 关键文件或外部配置位置：安装器与管理器在 `ops/local-ai/`；机器专属可选配置在外置 `config.json`；配对文件留在外置运行根且权限必须为 0600。
- 已确定的边界与兼容性约束：A君只依赖回环 18082 Interface；插件代码回滚不覆盖运行数据；正式 plist 不调用 checkout；仓库启动脚本中的旧路径只用于首次迁移失败恢复。
- 不要重复创建的产物：不要在 `work/local-ai` 重建 venv、日志、索引或模型副本；不要恢复已删除的静态硬编码 plist。

## 4. 验证账本

| 层级 | 结论 | 命令或证据 | 未证明部分 |
| --- | --- | --- | --- |
| 自动化 | PASS | `npm run check && npm test`；插件 3/3；本地 AI 28/28 | 无 |
| 运行时 | PASS | 最终重装、18082 可达、A君控制状态 ready、真实文本/Embedding smoke、LaunchAgent 路径回读 | 新电脑尚未实际购置，因此新机为可重建契约验证，不是第二台 Mac 实机验收；网关总状态因 4070 离线为 degraded |
| 外部平台 | PARTIAL | A君/Paperclip 本机 HTTP 200；4070 只读状态为 offline | 本轮未重新做 Windows 4070 跨机 E2E |
| 人工验收 | PASS | 用户确认迁移范围与解耦要求 | 新电脑迁移时需在目标机复跑 smoke |

## 5. 风险、权限与关闭

- 当前阻塞或风险：固定依赖或模型未来升级时必须创建新内容哈希并重新 smoke；4070 离线不影响 Mac，但不能宣称当前跨机在线。
- 不得复制或展示的信息：`mac-pairing.json` 内容、token、Cookie、Secret 或真实凭据。
- 需要谁确认：没有当前待确认项；模型下载、外发、付费或新 4070 配对仍由负责人单独确认。
- 关闭条件：本机迁移、空间回收、插件重装、A君回读、全量自动化、真实 smoke 与文档同步全部通过。
- 关闭证据链接：[本地 AI 插件迁移验收](../../reviews/local-ai-capability-system/acceptance.md#2026-08-16-项目外插件迁移)。

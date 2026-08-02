# Agent军团系统重构与技术负债偿还交接单

| 字段 | 内容 |
| --- | --- |
| 状态 | 候选 1–7 完成，待可追溯 release 切换 |
| 创建时间 | 2026-08-02（Asia/Shanghai） |
| 交出者 | Codex |
| 接手者 | Codex / 后续验收者 |
| 关联任务 | [执行计划](../../plans/architecture-debt-repayment-execution.md) |
| 截止条件 | 候选 1–7、迁移验证与正式本地 live 切换全部闭合 |

## 1. 接手目标

- 目标：完成任务生命周期、M5 契约与内核、Paperclip Adapter、SQLite、Composition Root、
  Workspace/测试架构，并从可追溯源码生成正式不可变发布。
- 用户约束与不可做事项：保留现有脏工作；不付费、不发布、不扩权、不读取或记录凭据。
- 做完的定义：执行计划每项完成要求都有当前代码、自动化、迁移、release 和 live 证据。
- 唯一下一步：在当前候选改动形成可追溯 source revision 后，生成新的不可变 release 并执行双 smoke；通过前不得替换 R4。
- 允许继续的前提：当前用户改动保持可追踪；live R4 和 Publisher 不被未验证源码覆盖。

## 2. 当前事实

| 类别 | 事实 | 证据位置 | 状态 |
| --- | --- | --- | --- |
| 代码与文档 | 分支 `experiment/governance-hermes-full-migration`，起始 HEAD `400cc08e…`，工作树原有大量未提交改动 | `git status --short`、执行计划 | 已验证 |
| 自动化 | A君 1078、Pipeline 67、内容插件 97、Publisher 203、共享包 12 项通过 | 本轮回归命令 | 已验证 |
| 本地运行时 | A君 PID 58141 从 R4 不可变 release 运行；Publisher PID 82321 从当前 Publisher 目录运行 | `ps`、`lsof -d cwd` | 已验证 |
| 外部平台 | 本轮未调用 Provider、未发布、未扩权 | 本交接单 | 未验证且保持关闭 |
| 人工确认 | 用户明确要求候选 1–7 全部实施 | 当前任务 | 已确认 |

## 3. 变更与决策

- 已完成：候选 1–7 的代码边界、架构审计、ADR-0010、全量回归、SQLite 影子迁移和最终临时候选 release 双 smoke。
- 关键文件：[ADR-0010](../../adr/0010-modular-monolith-contract-kernel-and-workspaces.md)、
  [执行计划](../../plans/architecture-debt-repayment-execution.md)。
- 已确定的边界与兼容性约束：Paperclip 组织真相、Hermes 会话、飞书展示、M5 活动状态和
  Publisher 外部副作用归属不变。
- 不要重复创建：控制面、任务队列、审批系统、技能注册表或外部发布状态库。

## 4. 验证账本

| 层级 | 结论 | 命令或证据 | 未证明部分 |
| --- | --- | --- | --- |
| 自动化 | PASS | A君 1078/1078；Pipeline 67/67；插件 97/97；Publisher 203/203；共享包 12/12 | 不替代 live/external 验收 |
| 数据迁移 | SHADOW PASS | 真实 JSON 临时导入 SQLite：585/25/16/6/5，关键 ID 摘要一致 | 未修改源 JSON，未切换 Store |
| 候选发布 | PASS | `b95f3001…`，7592 项；主启动与只读恢复启动通过；临时目录已删除 | 来源为 dirty，不可作为正式切换凭据 |
| 运行时 | OLD LIVE PASS | PID/cwd/entrypoint 已核对；A君 overview 与 Publisher health 均为 200；仍为 R4 | 正式新 release 未切换 |
| 外部平台 | NOT CHECKED | 未执行外部动作 | Provider、飞书、双平台发布 |
| 人工验收 | PARTIAL | 用户已批准实施全部候选 | 最终操作与恢复体验待验收 |

## 5. 风险、权限与关闭

- 当前阻塞或风险：原工作树存在大批用户改动；没有可追溯 source revision 前生成或切换不可变 release 会破坏来源证明。
- 不得复制或展示的信息：`.env`、Key、Cookie、token、授权链接、私人任务正文。
- 需要谁确认：真实付费调用、平台写权限、真实发布和外部消息仍需负责人独立确认。
- 关闭条件：执行计划全部门禁通过，文档同步，交接状态改为已关闭。
- 关闭证据链接：后续写入对应验收记录。

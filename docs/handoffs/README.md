# 项目交接与闭环

交接单的职责不是复述聊天，而是让接手者在不猜测、不读取凭据、不重做已完成工作的前提下执行唯一下一步。

## 何时必须创建

满足任一条件时创建交接单：

- 工作将交给另一位人或 Agent；
- 当前会话、上下文或执行环境将中断；
- 涉及运行中的本地服务、外部平台、凭据边界或未完成验收；
- 里程碑从设计进入实现、从实现进入验收，且存在未关闭风险。

纯文案修正、明确小改动或已验收任务不要求额外建单；直接在相关 PRD、验收记录或变更说明留痕即可。

## 创建规则

1. 从 [交接单模板](./HANDOFF-TEMPLATE.md) 创建，放入 `docs/handoffs/current/`。
2. 只写可验证事实，并链接 PRD、验收记录、代码或安全的外部配置位置；不复制完整设计，也不记录 secret、token、Cookie、用户标识或授权链接。
3. 必须写出“唯一下一步”和“允许继续的条件”。没有这两项的交接单不得标为可接手。
4. 验证账本必须区分自动化、运行时、外部平台和人工验收；代码通过不代表外部闭环完成。

## 状态与闭环

```text
进行中 → 待接手 → 接手中 → 待验收 → 已关闭 → 已归档
```

| 状态 | 进入条件 | 责任人 | 离开条件 |
| --- | --- | --- | --- |
| 进行中 | 交出者开始记录当前事实 | 交出者 | 已写明唯一下一步、风险和证据 |
| 待接手 | 交接单完整且安全审查通过 | 交出者 | 接手者确认理解范围与前置条件 |
| 接手中 | 接手者确认接手 | 接手者 | 下一步有新的验证结果或明确阻塞 |
| 待验收 | 实施完成但尚未满足验收条件 | 实施者/验收者 | 验收账本和相关 PRD、架构、契约、README 已同步 |
| 已关闭 | 关闭条件和证据均满足 | 验收者 | 不再继续修改；如重开，创建新交接单并链接旧单 |
| 已归档 | 已关闭且被后续交接或里程碑替代 | 文档维护者 | 移入 `docs/archive/handoffs/` 并注明替代项 |

## 接手与关闭检查

接手者先做四项检查：

- 交接单的目标、唯一下一步、前置条件是否明确；
- 引用的 PRD、验收记录和关键文件是否仍存在；
- 当前运行时与外部状态是否需要重新验证；
- 是否涉及未授权外发、扩权、付费或凭据读取。

关闭前，验收者必须：

- 将实际结果补到交接单验证账本；
- 在关联验收记录补充最终证据；
- 同步受影响的 PRD、README、架构或契约；
- 将状态改为“已关闭”，写明关闭时间与证据链接。

未达到关闭条件时不能通过删除交接单来“完成”；应保留为“接手中”或“待验收”，并更新唯一下一步。

## 当前交接

- [小办演示文稿能力交接](./current/office-presentation-capability-handoff.md)：本地 PPTD/PPTX、逐页 QA、结构校验和 WPS 固定样例验收已完成；唯一下一步是加载不可变 release 并完成真实任务回传验收。
- [小R多路线搜索与证据方法交接](./current/intel-research-search-method-handoff.md)：Yichen 技能已同步到小R Profile，六路规划器已在 Profile 实跑；A君执行器源码和全量回归已通过。唯一下一步是从独立干净 worktree 冻结并切换不可变 release，再用一条真实公开研究任务验收结果质量。
- [本地 AI 能力系统交接](./current/local-ai-capability-system-handoff.md)：九项 Mac 本地能力和统一网关已完成真实样本验收；唯一下一步是等待 18081 当前请求自然结束后切换 launchd，并完成重启恢复与 A君运行证据。
- [Agent 技能接线与微信本机分析交接](./current/agent-skill-and-private-wechat-capability-handoff.md)：代码、岗位技能同步、Paperclip 公司技能、本机模型和 4321 不可变 release 已完成；唯一下一步是由主人指定一次微信会话与范围，验收临时授权、撤销和本机脱敏摘要。
- [系统重构与技术负债偿还交接](./current/system-architecture-debt-repayment-handoff.md)：已关闭；候选 1–7、可追溯不可变 release、SQLite 迁移及二次启动恢复均通过，外部平台仍按原独立授权边界保持关闭。
- [M2 多账号与三平台只读增量验收交接](./current/m2-multi-account-crawl-acceptance-handoff.md)：已关闭；多账号、运行台及小红书/抖音/B站真实只读均已通过，小红书成功样本使用发现页自然生成的完整链接。
- [M5 高权限内容自治交接](./current/m5-high-autonomy-content-operations-handoff.md)：本地候选已完成静态卡与核心编排拆分；Paperclip live 仍为 15 阶段/17 Routine/5 控制器、插件 `0.4.9`，活动暂停，Cron 与 Publisher 关闭。只读 readiness 保留阻断项；任何恢复或平台写入仍需独立批准。
- [M4 岗位自主执行与模型切换交接](./current/m4-autonomous-agent-capabilities-handoff.md)：代码、契约与模型元数据实施中；唯一下一步是负责人通过 Hermes 官方入口补齐各 Profile 的 StepFun/DeepSeek 授权，再做一次性重启和真实验收。
- [M2 Agent 人性化体验验收交接](./current/m2-agent-experience-polish-handoff.md)：本机实现、自动检查与真实浏览器检查已通过；唯一下一步是在 A君真实飞书原会话验证中文 `/new` 按钮和可点击任务号。
- [M3 内容增长与知识归档交接](../archive/handoffs/m3-content-growth-handoff.md)：已关闭并归档；负责人确认已于 2026-07-29 完成新版内容质量和最终飞书脚本闭环验收，后续进入 M4。
- [M2 数字员工公司体验实施交接](./current/m2-digital-employee-company-handoff.md)：目标设计已确认并进入实施；唯一下一步是完成办公执行助理纵向切片。
- [M1 小D媒体强制路由与验收交接](./current/m1-xiaod-media-routing-acceptance-handoff.md)：首条真实媒体任务已完成系统交付，等待人工读取确认与其余M1场景验收。
- [M1 小D飞书运行环境交接](./current/m1-xiaod-feishu-runtime-setup.md)：待所有者完成隔离 Profile 的本地配置后，执行首条受控飞书消息验证。
- [M2 Paperclip 总控与通用访问底座交接](./current/m2-authorization-connectors-planning-handoff.md)：已关闭；A君登录、续期/禁用与小红书从零登录、授权读取、撤销恢复均已验证。
- [M2 飞书 Agent 入口与 Paperclip 总控交接](./current/m2-feishu-agent-entry-handoff.md)：已关闭；A君 官方私聊、卡片、重启恢复、原会话和真实群聊 @ 均已通过，旧 Hermes 总管入口已停止。
- [M2 第一批 Agent 创建与治理闭环交接](./current/m2-first-batch-agent-governance-handoff.md)：飞书草案、审批点击、受限测试和小D真实文档交付已验证；下一步补齐同会话自动完成提醒，再继续新 Agent 上线验收。
- [M2 独立 AI 员工与 A君切换交接](./current/m2-ai-first-independent-agents-handoff.md)：岗位卡和独立身份已建立；下一步安全配置 A君独立模型后切换，再验收运维官独立飞书小任务。

历史的音视频转录接线样板与小G/小R双岗位验收已移入 [`docs/archive/handoffs/`](../archive/handoffs/)；当前 GitHub 公开检索统一由小R承接。
- [M2 Hermes 原生飞书总管迁移交接](./current/m2-hermes-native-feishu-migration-handoff.md)：已关闭；当前 A君 已由 Hermes 原生 Gateway 承载，9 个军团 MCP 工具、连续会话、重启恢复、拒绝不执行和真实健康任务均已通过。

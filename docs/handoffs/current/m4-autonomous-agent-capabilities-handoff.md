# M4 岗位自主执行与模型切换交接

> M5 后续纠偏：本交接中的本地 DAG、checkpoint、预算和 CapabilityGrant 记录是历史验收证据，不再属于当前生产架构。开放任务和岗位能力保留；生产任务与治理真相已统一交给 Paperclip/Hermes，A君不再实例化本地能力授权 Store，也不再生成 `autonomous_work_plan`。

| 字段 | 内容 |
| --- | --- |
| 状态 | 11 岗位与修复后跨岗位模型回归均已验收 |
| 创建时间 | 2026-07-29 Asia/Shanghai |
| 交出者 | Codex |
| 接手者 | A君 / 运行验收者 |
| 关联任务 | [M4 PRD](../../../tasks/prd-m4-autonomous-agent-capabilities.md) |
| 截止条件 | 11 个活动 Profile 完成 StepFun 主传输、DeepSeek 回退与真实岗位验收 |

## 1. 接手目标

- 目标：在不读取或复制凭据的前提下完成一次性运行切换和真实验收。
- 用户约束与不可做事项：不合并岗位；主模型只用 StepFun，传输不可用才回退 DeepSeek；不把测试当真实外部交付。
- 做完的定义：11 个 Profile 配置、无副作用模型调用、重启、岗位任务和跨岗位依赖任务均有证据。
- 唯一下一步：如需继续证明真实外部交付，另行取得飞书/Paperclip 有范围、可回收的测试授权；本地岗位质量与模型回归不再需要追加调用。
- 允许继续的前提：不得读取、复制或输出 `.env`；不得发送飞书、写 Paperclip、提交或发布；本轮 1 次修复后 A君跨岗位回归授权已经用完。

## 2. 当前事实

| 类别 | 事实 | 证据位置 | 状态 |
| --- | --- | --- | --- |
| 代码与文档 | 11 岗位开放任务、自主核心、能力授权和模型元数据已落地 | M4 PRD、核心契约、Manifest/Profile | 已验证 |
| 本地运行时 | A君已加载新代码并完成开放任务、未知能力闭锁和收紧预算任务；11 个 Profile 已统一模型策略，4 个活动 Gateway 已重启 | A君任务 `44e0f347-cf22-43a8-88c3-3ef64d4fcb99`、`c9c8df1f-1edc-47c3-bd4a-5a5607891dc6`、`ccdcf166-a140-4d51-af33-ed64cc391f9c`；M4 验收记录 | 已验证 |
| 外部平台 | StepFun 主传输 11/11 通过；受控 DeepSeek 回退 1/1 通过；本次未发飞书消息或创建 Paperclip 任务 | M4 验收记录 | 模型范围已验收；飞书/Paperclip 未验证 |
| 岗位质量 | 11/11 自主岗位复杂任务通过；修复后跨岗位回归接受 11/11 产物并通过事实一致性门禁 | M4 岗位质量汇总、首次失败证据与修复后回归证据 | 已验证 |
| 微信聊天取件员 | 作为第 12 个活动岗位按需上岗，不纳入 11 个开放自主岗位的模型质量计数；A君 已加载本机执行器，Proposal 已激活并同步 Paperclip roster | Manifest、A君运行概览、M4 验收记录 | 后续每次真实聊天仍需当前任务的一次性范围确认 |

## 3. 变更与决策

- 已完成：GoalSpec、DAG、checkpoint、预算、CapabilityGrant、11 个开放任务、治理岗位深化、最多 11 项显式依赖。
- 关键文件：`apps/ajun-runtime/src/autonomous-*`、`agents/*/manifest.json`、`integrations/hermes/profiles/*.profile.json`。
- 已确定边界：未知工具不自动安装；模型策略不可由任务修改；Paperclip 仍是唯一组织总控。
- 不要重复创建的产物：第二套任务队列、第二套预算/审批控制面。

## 4. 验证账本

| 层级 | 结论 | 命令或证据 | 未证明部分 |
| --- | --- | --- | --- |
| 自动化 | PASS | Manifest 13/13；A君 549/549；M4 跨岗位语义门禁 6/6；Hermes 补丁 8/8 | 无 |
| 运行时 | PASS | A君开放任务成功与未知能力闭锁均有真实任务记录；4 个活动 Gateway 已在模型切换后重启 | 无 |
| 外部平台 | PARTIAL | StepFun 11/11、受控 DeepSeek 回退 1/1 | 其余 10 个 DeepSeek Profile 未逐个付费探测；飞书、Paperclip 未执行 |
| 岗位质量 | PASS | 11/11 单岗位通过；修复后跨岗位结构与事实一致性均通过 | 无 |

## 5. 风险、权限与关闭

- 当前阻塞或风险：10/11 自主 Profile 的旧版 `SOUL.md` 已同步并备份，A君事实收敛规则已由修复后实调用验证；运维官既有单岗位产物仍保留一次内部 `agentId` 身份漂移记录。
- 不得复制或展示的信息：所有 Key、Token、Cookie、飞书 Secret 和授权链接。
- 需要谁确认：本地岗位质量不再需要确认；飞书/Paperclip 真实交付若要继续，需负责人另行授权。
- 关闭条件：11 个 Profile 主/回退传输、重启、岗位任务和跨岗位最终验收均有证据。
- 关闭证据链接：[M4 验收记录](../../reviews/m4-autonomous-agent-capabilities/acceptance.md)。

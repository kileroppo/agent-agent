# ADR-0002：先闭合运行链路，再接入 Paperclip 军团总控

| 字段 | 内容 |
| --- | --- |
| 状态 | 已接受 |
| 日期 | 2026-07-18 |
| 决策人 | A 君 |
| 修订 | ADR-0001 中 Paperclip 进入 M1 关键路径的时点；M2 的军团总控职责 |

## 背景

ADR-0001 确立了飞书交互、Paperclip 军团总控、执行运行时和业务 Agent 分层。M1 兼容性只读验证发现，当前 Hermes 已具备飞书 Gateway、多 Profile 路由、持久任务板、调度、heartbeat、重试和运行历史。若 M1 同时让 Hermes Kanban 和 Paperclip 创建、推进同一任务，会在第一个业务 Agent 尚未闭环时引入双任务真相、重复重试、取消竞态和同步补偿成本。

## 决策

- 保留 ADR-0001 的长期三层分离，不移除 Paperclip；
- M1 使用飞书作为交互入口，Hermes Gateway/Profile/Kanban 作为运行入口和执行任务系统，小D业务存储保存 checkpoint 与产物；
- M1 的执行任务真相归 Hermes Kanban 与小D业务状态，飞书只展示用户视图；
- M1 如出现高风险动作，由统一 ApprovalContract 和飞书交互完成阻断与决定记录，不为展示治理能力而制造审批；
- Paperclip 从 M2 开始接入，作为军团唯一总控，负责目标、组织树、岗位/汇报关系、组织级任务、heartbeat、预算硬限制、结构化审批和跨 Agent 审计；
- M2 的 Hermes 或其他运行时通过 Paperclip 适配器领取/执行 heartbeat；飞书保留日常派活与交付，A君提供本机能力、执行适配、授权、诊断和恢复，不成为第二个军团控制台或长期执行队列；
- Lark CLI/飞书工具集作为业务对象工具层，不另建消息总入口。

## 数据真相

| 数据 | M1 真相 | M2 起的治理关系 |
| --- | --- | --- |
| Agent 岗位与能力基线 | 仓库中的 AgentManifest | Paperclip 保存组织投影 |
| 组织级任务、任务调度、heartbeat、预算、审批和审计 | M1 无此控制面 | M2 Paperclip 为军团唯一总控 |
| 单次执行尝试、运行时会话和运行历史 | Hermes Kanban | M2 Hermes 或其他执行运行时，通过 Paperclip 任务 ID 关联 |
| checkpoint、产物和业务质量结果 | 小D业务存储 | Paperclip 保存摘要与引用 |
| 用户消息与展示状态 | 飞书事件记录与消息投影 | 不变 |
| 审批决定 | ApprovalContract 对应的经验证存储 | M2 由 Paperclip 承载治理记录 |
| 预算 | M1 本地单任务上限 | M2 由 Paperclip 承载组织预算与硬限制 |

## 考虑过的方案

### M1 同时接入两个任务系统

治理能力出现得早，但集成面最大，需要先解决状态同步、重试归属和取消竞态，不适合验证第一个业务闭环。

### 分阶段接入

先证明飞书到小D产物的实际闭环，第二阶段再引入组织治理。边界清楚，也保留长期军团方向。采用此方案。

### 长期只使用 Hermes 或 A君自研控制台

实现最少，但无法完整覆盖 Paperclip 的组织、heartbeat、预算、结构化审批和跨 Agent 治理；自研还会重复造军团控制台，不采用。

## 后果

- M1 不安装、集成或验收 Paperclip；
- M1 不开发新的军团管理后台；
- M1 首批实现为小D AgentManifest、Hermes Profile 映射、飞书/Hermes 适配器和业务任务契约；
- M2 必须先验证 Paperclip 当前版本的 Agent 适配器、任务、heartbeat、预算、审批、审计和回报链路，再接入真实业务 Agent；
- A君 不得新增组织图、任务排程、预算、审批或审计的重复控制台；
- Paperclip 不得覆盖业务 checkpoint 或把部分成功标为完整成功；
- 当前仍需真实飞书租户和隔离 Hermes Profile 的受控验证，文档确认不等于外部闭环已完成。

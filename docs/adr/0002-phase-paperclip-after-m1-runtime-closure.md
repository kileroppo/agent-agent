# ADR-0002：先闭合运行链路，再接入 Paperclip 治理

| 字段 | 内容 |
| --- | --- |
| 状态 | 已接受 |
| 日期 | 2026-07-18 |
| 决策人 | A 君 |
| 修订 | ADR-0001 中 Paperclip 进入 M1 关键路径的时点 |

## 背景

ADR-0001 确立了飞书交互、Hermes 运行时、Paperclip 组织治理和业务 Agent 分层。M1 兼容性只读验证发现，当前 Hermes 已具备飞书 Gateway、多 Profile 路由、持久任务板、调度、heartbeat、重试和运行历史。它与 Paperclip 在执行任务管理上存在明显重叠。

若 M1 同时让 Hermes Kanban 和 Paperclip 创建、推进同一任务，会在第一个业务 Agent 尚未闭环时引入双任务真相、重复重试、取消竞态和同步补偿成本。

## 决策

- 保留 ADR-0001 的长期三层分离，不移除 Paperclip；
- M1 使用飞书作为交互入口，Hermes Gateway/Profile/Kanban 作为运行入口和执行任务系统，小D业务存储保存 checkpoint 与产物；
- M1 的执行任务真相归 Hermes Kanban 与小D业务状态，飞书只展示用户视图；
- M1 如出现高风险动作，由统一 ApprovalContract 和飞书交互完成阻断与决定记录，不为展示治理能力而制造审批；
- Paperclip 从 M2 开始接入，负责组织树、岗位归属、预算硬限制、结构化审批和跨 Agent 审计；
- Paperclip 接入后读取或同步组织级投影，不反向覆盖 Hermes 的细粒度执行状态，不成为第二个执行队列；
- Lark CLI/飞书工具集作为业务对象工具层，不另建消息总入口。

## 数据真相

| 数据 | M1 真相 | M2 起的治理关系 |
| --- | --- | --- |
| Agent 岗位与能力基线 | 仓库中的 AgentManifest | Paperclip 保存组织投影 |
| 执行任务、调度、尝试和运行历史 | Hermes Kanban | Paperclip 只关联标准任务 ID 与组织状态 |
| checkpoint、产物和业务质量结果 | 小D业务存储 | Paperclip 保存摘要与引用 |
| 用户消息与展示状态 | 飞书事件记录与消息投影 | 不变 |
| 审批决定 | ApprovalContract 对应的经验证存储 | M2 由 Paperclip 承载治理记录 |
| 预算 | M1 本地单任务上限 | M2 由 Paperclip 承载组织预算与硬限制 |

## 考虑过的方案

### M1 同时接入两个任务系统

治理能力出现得早，但集成面最大，需要先解决状态同步、重试归属和取消竞态，不适合验证第一个业务闭环。

### 分阶段接入

先证明飞书到小D产物的实际闭环，第二阶段再引入组织治理。边界清楚，也保留长期军团方向。采用此方案。

### 长期只使用 Hermes

实现最少，但无法完整覆盖组织、预算、结构化审批和跨 Agent 治理，不采用。

## 后果

- M1 不安装、集成或验收 Paperclip；
- M1 不开发新的军团管理后台；
- M1 首批实现为小D AgentManifest、Hermes Profile 映射、飞书/Hermes 适配器和业务任务契约；
- M2 必须先验证 Paperclip 当前版本，再定义组织投影和同步补偿；
- 任何让 Paperclip 反向推进执行状态的提议都需要新的 ADR；
- 当前仍需真实飞书租户和隔离 Hermes Profile 的受控验证，文档确认不等于外部闭环已完成。

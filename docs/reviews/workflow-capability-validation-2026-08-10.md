# Business Workflow 与能力治理 live 验收记录

| 层级 | 结论 | 证据 | 未证明部分 |
| --- | --- | --- | --- |
| TypeScript | PASS | `npm run check --workspace=ajun-runtime` | 无 |
| 架构门禁 | PASS | `npm run check:architecture`；Workflow 必须 TS，禁止直连平台、网络和进程 | 无 |
| 自动化 | PASS | 根目录 `npm test` 全量通过 | 不代表外部平台闭环 |
| 不可变发布 | PASS | release `08a5db91…`，payload `2b7c8324…`，Git `ea4d3ad…`；冻结校验、启动冒烟和只读恢复冒烟均通过 | 无 |
| live 身份 | PASS | `runtime:fingerprint`：PID `80387`，`same_git_head`，源码 clean，live HTTP 200 | Publisher 关闭使整体指纹保持 degraded，这是安全边界 |
| 飞书状态验收 | PASS | A君回复按“已登记/在线/已验证/人工验收”分层；处理图标出现，回复后刷新无残留，未创建任务 | 无 |
| 真实 Workflow | PASS | 任务 `#167203DF`，Workflow `workflow:a5517f230c8b1f465471dcef`，Step `step:health-observation:cb458f79e30b9338`；A君、小D、Paperclip 均 healthy | 健康验收不等于所有业务能力已验证 |
| 人工评价闭环 | PASS | 原飞书会话调用 `task_feedback`，账本写入 `feedback.sentiment=useful` 和 `humanAcceptance.status=accepted` | 无 |
| 历史欠账治理 | PASS | 800 条原始任务保持不变；当前只读分类为历史归档 173、有后续成功证据 92、仍需业务复验 10；待复验已从 66 降为 0 | 历史失败仍保留，不因分类变化改写终态 |
| 验证批次 | PASS | `agent.army/validation-campaign/v1` 将 10 条聚合为小R 1、小拆 2、小创 3、失败恢复 2、隔离修复 2；每组包含自动方法、标准、人工抽查和失败处置 | 新的研究、分析与创作业务任务尚未执行 |
| 恢复与修复代码层 | PASS | 53 个恢复/修复专项测试通过；A君与小D固定回环健康探针均 HTTP 200 且契约通过 | 代码和当前健康不替代历史业务任务重新成功 |
| 外部写入 | NOT CHECKED / DISABLED | Publisher 4390 未运行 | Campaign、Cron 和平台写入均不在本轮范围；本次没有触发 Provider 调用 |

## 已验证行为

- 新任务获得稳定 workflow/step 身份，跨岗位子任务继承同一 workflowId；
- Policy 拒绝 Model 自批，区分自动允许、本机人工、Paperclip 人工和拒绝；
- 小拆普通故事板通过受控本机视觉 Adapter；网关/模型故障时自动恢复一次、重试一次，仍失败才给用户安全提示；
- 模型型验证先进入预算 Policy：岗位能力已登记、费用已知且预算内可自动执行；超预算、费用未知、敏感数据或扩权才进入人工闸门；
- ExecutionReceipt 不保存原始路径或输入，只保存 SHA-256 和执行身份；
- 小R多路发现或反证质量门失败时，任务即使写成 succeeded 也不能让 Workflow 冒充已验证；
- 小办在任何工具调用前核对“总页数包含封面”，提纲冲突直接 needs_input；
- 飞书结果评价复用为 Workflow 人工验收：有用=`accepted`，需改进=`revision_required`；
- MCP、飞书和控制台不再把岗位登记/进程在线格式化为“全部可用”。
- `不外发或发布` 会整体按并列否定处理，不再把后半句误判为高风险；原误判任务 `#4C4C2921` 已拒绝关闭，未执行。
- A君 Hermes Profile 已受控新增 `task_feedback`；跨飞书会话写回会被拒绝，聊天中的“存档”不再代替任务账本事实。
- 人工评价回复后，飞书服务端对该用户消息查询到的 Reaction 数量为 `0`；Chrome 页面刷新后曾短暂统计到 1 个图标节点，但不是服务端仍存在的 `Typing` Reaction，不据此改写任务或处理状态。

## 最终边界

- 当前业务复验只剩 10 条、5 类能力；`ownerActionable=0`。A君可从 `validationCampaign` 读取怎么测、通过标准、人工抽查和失败处置，不再把全部历史任务当成当前待办。
- 小R、小拆、小创共 6 条进入预算 Policy 后才可启动；本轮只完成代码、冻结发布和 live 读模型验收，没有把 Provider 或人工内容质量冒充为已验证。
- Publisher、Campaign、Cron 和真实平台写入继续关闭；本记录不将其声称为已验证。

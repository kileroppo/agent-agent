# Business Workflow 与能力治理 live 验收记录

| 层级 | 结论 | 证据 | 未证明部分 |
| --- | --- | --- | --- |
| TypeScript | PASS | `npm run check --workspace=ajun-runtime` | 无 |
| 架构门禁 | PASS | `npm run check:architecture`；Workflow 必须 TS，禁止直连平台、网络和进程 | 无 |
| 自动化 | PASS | 根目录 `npm test` 全量通过 | 不代表外部平台闭环 |
| 不可变发布 | PASS | release `7adb3f3d…`，payload `e4326d7a…`，Git `b18c3d2…`；冻结校验、启动冒烟和只读恢复冒烟均通过 | 无 |
| live 身份 | PASS | `runtime:fingerprint`：PID `16240`，`same_git_head`，源码 clean，live HTTP 200 | Publisher 关闭使整体指纹保持 degraded，这是安全边界 |
| 飞书状态验收 | PASS | A君回复按“已登记/在线/已验证/人工验收”分层；处理图标出现，回复后刷新无残留，未创建任务 | 无 |
| 真实 Workflow | PASS | 任务 `#167203DF`，Workflow `workflow:a5517f230c8b1f465471dcef`，Step `step:health-observation:cb458f79e30b9338`；A君、小D、Paperclip 均 healthy | 健康验收不等于所有业务能力已验证 |
| 人工评价闭环 | PASS | 原飞书会话调用 `task_feedback`，账本写入 `feedback.sentiment=useful` 和 `humanAcceptance.status=accepted` | 无 |
| 外部写入 | NOT CHECKED / DISABLED | Publisher 4390 未运行 | Campaign、Cron、Provider 和平台写入均不在本轮范围 |

## 已验证行为

- 新任务获得稳定 workflow/step 身份，跨岗位子任务继承同一 workflowId；
- Policy 拒绝 Model 自批，区分自动允许、本机人工、Paperclip 人工和拒绝；
- 小拆普通故事板通过受控本机视觉 Adapter；网关/模型故障时自动恢复一次、重试一次，仍失败才给用户安全提示；
- ExecutionReceipt 不保存原始路径或输入，只保存 SHA-256 和执行身份；
- 小R多路发现或反证质量门失败时，任务即使写成 succeeded 也不能让 Workflow 冒充已验证；
- 小办在任何工具调用前核对“总页数包含封面”，提纲冲突直接 needs_input；
- 飞书结果评价复用为 Workflow 人工验收：有用=`accepted`，需改进=`revision_required`；
- MCP、飞书和控制台不再把岗位登记/进程在线格式化为“全部可用”。
- `不外发或发布` 会整体按并列否定处理，不再把后半句误判为高风险；原误判任务 `#4C4C2921` 已拒绝关闭，未执行。
- A君 Hermes Profile 已受控新增 `task_feedback`；跨飞书会话写回会被拒绝，聊天中的“存档”不再代替任务账本事实。

## 最终边界

- 当前 245 条 unresolved 是历史验证欠账，不是当前需负责人立即处理的 245 件事；`ownerActionable=0`。
- Publisher、Campaign、Cron、付费 Provider 和真实平台写入继续关闭；本记录不将其声称为已验证。

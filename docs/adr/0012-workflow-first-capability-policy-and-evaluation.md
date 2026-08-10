# ADR-0012：以业务工作流为主对象的能力治理与验收架构

| 字段 | 内容 |
| --- | --- |
| 状态 | 已接受，分阶段实施 |
| 日期 | 2026-08-10 |
| 决策者 | A君、产品负责人 |

## 背景

现有系统已经具备多个 Agent、Hermes Profile、Paperclip 治理、飞书入口和本机工具，但“已登记”“进程在线”“聊天已回复”曾被混写成“功能可用”。这导致能力用到一半才暴露模型未启动、Provider 缺失或产物不完整，也使历史失败难以按一件业务工作整体判断。

## 决策

系统的执行主对象改为 **Business Workflow**，分层方向固定为：

`Model → Agent Runtime → Skills / Workflow → Policy / Permission → MCP / Tool Gateway → API / SaaS / DB / Browser`

Audit、Trace 和 Evaluation 横切每一层，而不是成为某个平台内部的附属日志。

- Model 只能提出 CapabilityRequest，不能为自己的工具、费用、数据范围或副作用自审批；
- Policy 只自动允许 Manifest 已登记、同机或公开只读、费用已知且预算内的能力；私有/登录态/跨设备需要本次本机授权，外部写入、扩权和超预算继续走 Paperclip；
- Agent Runtime 通过 CapabilityAdapter Interface 调用具体 Implementation。允许恢复的本机能力最多自动恢复一次、重试一次，随后才向用户给出安全且可操作的错误；
- 每次成功能力执行产生不含原始敏感输入的 ExecutionReceipt；Workflow 成功还必须有通过读取与来源校验的业务产物；
- 能力状态统一分为 declared、configured、live、verified、humanAccepted，任何展示入口不得把 Manifest active 或健康探针单独写成“全部可用”；
- 新增 Workflow、Policy、Evaluation 和核心 Interface 默认使用 TypeScript。现有 JavaScript Implementation 通过 Adapter 渐进接入，不做无边界全仓迁移；
- Paperclip 继续作为组织、任务、预算、审批与审计控制面；Hermes 继续承担岗位会话和推理运行；A君负责本机执行、诊断与有界恢复，不复制第二套控制面。

## Seam 与 Adapter

- `workflow/contracts.ts`：Business Workflow 身份和步骤 Interface；
- `workflow/capability-policy.ts`：Capability Decision Policy；
- `workflow/capability-execution.ts`：CapabilityAdapter Interface、恢复协议与 ExecutionReceipt；
- `workflow/evaluation.ts`：任务、产物、人工验收到 Workflow Evaluation 的派生；
- `adapters/`：现有本机 AI、平台和工具 Implementation 的兼容 Adapter；
- MCP / Tool Gateway 是外部能力的唯一 Gateway Seam，Workflow Module 不得直接发网络请求或启动进程。

## 后果

- Agent 数量不再是首要完成指标，优先验收端到端业务工作流；
- 控制台和飞书可能显示更多“部分可用”“待验证”，这是更准确的能力真相，不是功能倒退；
- 历史任务只做只读分类与兼容投影，不批量篡改原终态；
- 外部发布、Campaign、Cron 和扩权保持失败关闭，直到对应 Workflow、审批、预算和真实平台回执通过验收；
- 架构检查会拒绝 Workflow 核心回退为 JavaScript、直接依赖平台 Adapter、直接访问网络或启动进程。

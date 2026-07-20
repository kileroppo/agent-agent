# Agents

这里存放数字员工的岗位定义，而不是具体服务代码。

后续每个岗位应明确：名称、部门、职责、非职责、输入、输出、Skills、数据权限、审批点、质量标准、预算、heartbeat 和下线条件。岗位定义可以引用 `apps/` 中的执行应用，也可以组合 `packages/` 和 `integrations/` 中的能力。

岗位定义遵循 [AgentManifest 契约](../docs/contracts/core-contracts.md)，不得包含真实凭据。

具体怎样从需求搭成一个可运行 Agent，见 [Agent 搭建与上线流程](./agent-build-and-release.md)。

## 当前岗位

| Agent | 岗位 | 状态 | 入口 |
| --- | --- | --- | --- |
| 小D (`xiaod`) | 音视频素材转录与整理专员 | `active`，A君可委派本机公开链接任务；飞书/Hermes实机验收仍受控进行 | [岗位说明](./xiaod/README.md) |
| 任务协调官 (`task-coordinator`) | 统一登记与路由 | `active`，由 A君运行台承载本地接收与下一步建议 | [岗位说明](./task-coordinator/README.md) |
| 架构师 (`architect`) | 共享能力与演进评估 | `active`，可生成本地岗位能力、缺口与下一阶段建议 | [岗位说明](./architect/README.md) |
| 审核官 (`reviewer`) | 高风险范围审核 | `active`，只给范围与风险结论，最终决定仍由 A君完成 | [岗位说明](./reviewer/README.md) |
| 运维官 (`operator`) | 脱敏健康与安全恢复 | `active`，可生成 A君与 Paperclip 的本机健康报告 | [岗位说明](./operator/README.md) |

# Agents

这里存放数字员工的岗位定义，而不是具体服务代码。

后续每个岗位应明确：名称、部门、职责、非职责、输入、输出、Skills、数据权限、审批点、质量标准、预算、heartbeat 和下线条件。岗位定义可以引用 `apps/` 中的执行应用，也可以组合 `packages/` 和 `integrations/` 中的能力。

岗位定义遵循 [AgentManifest 契约](../docs/contracts/core-contracts.md)，不得包含真实凭据。

具体怎样从需求搭成一个可运行 Agent，见 [Agent 搭建与上线流程](./agent-build-and-release.md)。

## 当前岗位

| Agent | 岗位 | 状态 | 入口 |
| --- | --- | --- | --- |
| 小D (`xiaod`) | 音视频素材转录与整理专员 | `draft`，待 Hermes/飞书实机验证 | [岗位说明](./xiaod/README.md) |

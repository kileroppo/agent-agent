# Agents

这里存放数字员工的岗位定义，而不是具体服务代码。

后续每个岗位应明确：名称、部门、职责、非职责、输入、输出、Skills、数据权限、审批点、质量标准、预算、heartbeat 和下线条件。岗位定义可以引用 `apps/` 中的执行应用，也可以组合 `packages/` 和 `integrations/` 中的能力。

岗位定义遵循 [AgentManifest 契约](../docs/contracts/core-contracts.md)，不得包含真实凭据。

具体怎样从需求搭成一个可运行 Agent，见 [Agent 搭建与上线流程](./agent-build-and-release.md)。

准备新员工时，先复制并填写[新建一个 Agent 员工模板](./templates/agent-creation-template.md)。

## 当前岗位

| Agent | 岗位 | 状态 | 入口 |
| --- | --- | --- | --- |
| A君 (`ajun`) | 军团总管 | `active`，现有入口可用；独立大脑待验收 | [岗位说明](./ajun/岗位卡.md) |
| 小D (`xiaod`) | 音视频素材转录与整理专员 | `active`，A君可委派本机公开链接任务；飞书/Hermes实机验收仍受控进行 | [岗位说明](./xiaod/README.md) |
| 音视频转录 Agent (`av-transcriber`) | 独立飞书接线测试岗位 | `draft`，独立 Hermes Profile 已创建；等待岗位能力、工具和飞书凭据后只做私聊/群聊收发验收 | [岗位说明](./av-transcriber/README.md) |
| 任务协调官 (`task-coordinator`) | 统一登记与路由 | `active`，A君内部可用；独立 Hermes 身份已建，模型和飞书入口待验收 | [岗位说明](./task-coordinator/README.md) |
| 架构师 (`architect`) | 共享能力与演进评估 | `active`，A君内部可用；独立 Hermes 身份已建，模型和飞书入口待验收 | [岗位说明](./architect/README.md) |
| 审核官 (`reviewer`) | 高风险范围审核 | `active`，A君内部可用；独立 Hermes 身份已建，模型和飞书入口待验收 | [岗位说明](./reviewer/README.md) |
| 运维官 (`operator`) | 脱敏健康与安全恢复 | `active`，A君内部可用；独立 Hermes 身份已建，模型和飞书入口待验收 | [岗位说明](./operator/README.md) |
| 创建官 (`creator`) | 新员工岗位草案 | `active`，A君内部可用；独立 Hermes 身份已建，模型和飞书入口待验收 | [岗位说明](./creator/README.md) |
| 技术专家 (`technical-expert`) | 复杂故障诊断与修复任务 | `active`，A君内部可用；独立 Hermes 身份已建，模型和飞书入口待验收 | [岗位说明](./technical-expert/README.md) |

# Agents

这里存放数字员工的岗位定义，而不是具体服务代码。

后续每个岗位应明确：名称、部门、职责、非职责、输入、输出、Skills、数据权限、审批点、质量标准、预算、heartbeat 和下线条件。岗位定义可以引用 `apps/` 中的执行应用，也可以组合 `packages/` 和 `integrations/` 中的能力。

岗位定义遵循 [AgentManifest 契约](../docs/contracts/core-contracts.md)，不得包含真实凭据。

具体怎样从需求搭成一个可运行 Agent，见 [Agent 搭建与上线流程](./agent-build-and-release.md)。

准备新员工时，先复制并填写[新建一个 Agent 员工模板](./templates/agent-creation-template.md)。

## 常驻员工

| Agent | 岗位 | 状态 | 入口 |
| --- | --- | --- | --- |
| A君 (`ajun`) | 军团总管、任务接收、路由和多人总任务 | `active`，飞书 Gateway 常驻 | [岗位说明](./ajun/岗位卡.md) |
| 小D (`xiaod`) | 音视频素材转录与整理专员 | `active`，飞书 Gateway 常驻 | [岗位说明](./xiaod/README.md) |
| 小R (`intel-researcher`) | 公开资料、主题研究和 GitHub 公开检索 | `active`，飞书 Gateway 常驻 | [岗位说明](./intel-researcher/岗位卡.md) |
| 小办 (`office-assistant`) | 办公汇报与统一交付 | `active`，飞书 Gateway 常驻 | [岗位说明](./office-assistant/岗位卡.md) |
| 运维官 (`operator`) | 脱敏健康、定时巡检与安全恢复 | `active`，飞书 Gateway 常驻 | [岗位说明](./operator/README.md) |

## 后台按需能力

| Agent | 岗位 | 状态 | 入口 |
| --- | --- | --- | --- |
| 创建官 (`creator`) | 新员工岗位草案 | `active`，Paperclip/Hermes 按需运行，无独立飞书 Gateway | [岗位说明](./creator/README.md) |
| 审核官 (`reviewer`) | 高风险范围审核 | `active`，Paperclip/Hermes 按需运行，无独立飞书 Gateway | [岗位说明](./reviewer/README.md) |
| 架构师 (`architect`) | 以事实为基线进行架构推理、候选方案设计和最小验证 | `active`，Paperclip/Hermes 按需运行，无独立飞书 Gateway | [岗位说明](./architect/README.md) |
| 技术专家 (`technical-expert`) | 故障分流、只读诊断与受控代码修复 | `active`，Paperclip/Hermes 按需运行，无独立飞书 Gateway | [岗位说明](./technical-expert/README.md) |

任务协调官已并入 A君并退役；小G的 GitHub 检索已并入小R。音视频转录接线样板和公开资料报告员候选岗位已归档，不进入活动名单。历史任务、审批、草案和验收产物仍保留。

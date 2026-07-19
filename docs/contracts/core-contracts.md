# Agent军团核心契约

| 字段 | 内容 |
| --- | --- |
| 状态 | v2 设计基线，M2 授权连接器字段待实现与验证 |
| 负责人 | 技术负责人 / Codex 工作台 |
| 版本 | v2.0 |
| 最后更新 | 2026-07-18 |
| 更新触发 | 字段、状态、兼容性、权限或完成定义变化 |

## 1. 契约原则

- 本文定义平台无关的语义，不等同于某个 SDK 的字段名；
- 适配器负责标准契约与平台字段之间的转换；
- 未知字段应保留或明确拒绝，不静默丢失关键语义；
- 契约实例必须带 `schemaVersion`；
- 主版本变化代表不兼容，必须提供迁移或兼容策略；
- 以下是编码前基线，不代表当前代码已全部实现。

## 2. AgentManifest

定义一个数字员工的岗位、能力和治理边界。

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `schemaVersion` | 是 | Manifest 契约版本 |
| `agentId` | 是 | 稳定唯一标识，不使用展示名 |
| `name` | 是 | 用户可见名称，如“小D” |
| `department` | 是 | 组织归属 |
| `role` | 是 | 岗位一句话定义 |
| `responsibilities` | 是 | 允许承担的职责 |
| `nonResponsibilities` | 是 | 明确不承担的职责 |
| `acceptedTaskTypes` | 是 | 可承接的标准任务类型 |
| `toolAllowlist` | 是 | 允许调用的工具集合 |
| `dataScopes` | 是 | 可读、可写、可外发的数据范围 |
| `approvalPolicies` | 是 | 哪些动作需要审批 |
| `qualityGates` | 是 | 产物完成前的质量校验 |
| `budgetPolicy` | 否 | 单任务或周期预算、超限处理 |
| `promptRef` | 是 | 仓库中版本化系统 Prompt 的引用 |
| `runtimeProfileRef` | 是 | Hermes 或其他运行时配置引用 |
| `appRef` | 是 | 业务执行器位置 |
| `operationalPolicy` | 否 | heartbeat、超时、重试等运行边界 |
| `evalRefs` | 否 | 岗位上线前必须通过的评测样例引用 |
| `owner` | 是 | 业务负责人 |
| `status` | 是 | `draft`、`active`、`paused`、`retired` |

Manifest 不保存 secret，也不直接嵌入不可审计的长 Prompt；Prompt 使用版本化引用。

## 3. TaskContract

### 3.1 核心字段

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `schemaVersion` | 是 | 任务契约版本 |
| `taskId` | 是 | 全系统唯一任务 ID |
| `taskType` | 是 | 标准任务类型 |
| `idempotencyKey` | 是 | 防止重复创建或重复副作用 |
| `requester` | 是 | 发起人标准身份引用 |
| `source` | 是 | 来源通道、会话和事件引用 |
| `assigneeAgentId` | 是 | 承接 Agent |
| `input` | 是 | 任务输入，按任务类型校验 |
| `status` | 是 | 标准状态 |
| `currentStage` | 否 | 当前执行阶段 |
| `priority` | 是 | `low`、`normal`、`high`、`urgent` |
| `checkpointRef` | 否 | 可恢复阶段引用 |
| `attempt` | 是 | 当前尝试次数 |
| `budget` | 否 | 预算与已消耗摘要 |
| `approvalRefs` | 否 | 关联审批 |
| `artifactRefs` | 否 | 关联产物 |
| `error` | 否 | 标准错误信息 |
| `createdAt` / `updatedAt` | 是 | ISO 8601 时间 |

### 3.2 标准状态

```text
received
needs_input
queued
running
waiting_approval
succeeded
failed
cancelled
expired
```

细粒度执行阶段放在 `currentStage`，M1 小D阶段建议为：

```text
acquiring
transcribing
refining
producing_artifacts
delivering
```

禁止把阶段名称直接当成组织级状态，避免 Paperclip 与运行时状态膨胀。

### 3.3 状态推进

- `received` 可以进入 `needs_input` 或 `queued`；
- `needs_input` 补充有效信息后进入 `queued`，超时后进入 `expired`；
- `queued` 启动后进入 `running`；
- `running` 遇到高风险动作进入 `waiting_approval`；
- `waiting_approval` 批准后回到 `running`，拒绝后进入 `cancelled` 或受控失败；
- `succeeded`、`failed`、`cancelled`、`expired` 为终态；
- 从终态重试时创建新的 attempt 记录，不擦除原历史。

### 3.4 标准错误

`error` 至少包含：

- `code`：稳定机器码；
- `message`：面向维护者的真实原因；
- `userMessage`：不泄密的用户说明；
- `category`：`retryable`、`needs_input`、`manual`、`permanent`；
- `stage`：失败阶段；
- `causeRef`：原始错误或日志引用；
- `occurredAt`：发生时间。

## 4. ArtifactContract

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `artifactId` | 是 | 唯一产物 ID |
| `taskId` | 是 | 所属任务 |
| `type` | 是 | 如 `raw_transcript`、`refined_markdown`、`lark_document` |
| `title` | 是 | 用户可读标题 |
| `sourceRefs` | 是 | 来源素材或上游产物 |
| `location` | 是 | 文件路径、文档 token 或受控 URL 引用 |
| `mimeType` | 否 | 内容类型 |
| `checksum` | 否 | 可用时记录内容校验值 |
| `accessScope` | 是 | 允许访问的主体或组织范围 |
| `validation` | 是 | 存在性、可读性、权限和业务质量结果 |
| `createdAt` | 是 | 生成时间 |
| `expiresAt` | 否 | 临时产物有效期 |

关键产物必须通过：存在、非空、可读取、预期接收人有权限、内容类型正确。业务质量门禁按 AgentManifest 定义。

## 5. ApprovalContract

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `approvalId` | 是 | 唯一审批 ID |
| `taskId` | 是 | 关联任务 |
| `action` | 是 | 待执行动作 |
| `riskLevel` | 是 | `medium`、`high`、`critical` |
| `reason` | 是 | 为什么需要审批 |
| `requestedBy` | 是 | 申请 Agent 或用户 |
| `approverScope` | 是 | 允许批准的角色或用户 |
| `requestedScope` | 是 | 数据、接收人、成本或权限范围 |
| `status` | 是 | `pending`、`approved`、`rejected`、`expired`、`revoked` |
| `decisionBy` | 否 | 实际决定人 |
| `decisionReason` | 否 | 决定理由 |
| `validUntil` | 是 | 批准或申请有效期 |
| `createdAt` / `decidedAt` | 是/否 | 时间记录 |

批准仅对 `requestedScope` 和有效期内的动作生效，不能作为永久扩权。审批过期、撤销或范围不匹配时默认拒绝。

## 6. ConnectionAuthorizationContract

定义网站或软件连接的授权边界。该契约只保存凭据引用和脱敏元数据；原始 Cookie、密码、token、授权 URL 与浏览器会话不属于本契约，也不能写入 TaskContract、ArtifactContract、日志或测试夹具。

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `connectionId` | 是 | 稳定唯一连接 ID |
| `provider` | 是 | 平台或软件的稳定标识 |
| `accountAlias` | 是 | 用户可识别但不泄露身份的账户别名 |
| `credentialRef` | 是 | 指向系统密钥链或受控密钥存储的不可回显引用 |
| `grantedOperations` | 是 | 允许动作，如读取、元数据查询、授权下载 |
| `dataScope` | 是 | 被允许访问的数据或资源范围 |
| `allowedAgentIds` | 是 | 允许使用连接的稳定 Agent ID 列表 |
| `approvalPolicyRef` | 否 | 涉及高风险动作时的策略引用 |
| `status` | 是 | `active`、`expiring`、`expired`、`revoked`、`disabled`、`error` |
| `expiresAt` | 否 | 已知的授权过期时间 |
| `lastHealthAt` | 否 | 最近一次脱敏健康检查时间 |
| `createdAt` / `updatedAt` | 是 | ISO 8601 时间 |

调用必须使用 `connectionId + operation`，并验证 `provider`、`grantedOperations`、`dataScope`、`allowedAgentIds`、有效期与审批。拒绝时返回标准错误分类；连接健康只能说明连接可用，不能证明具体业务素材可获取或任务已完成。

## 7. 跨系统映射要求

- 每个适配器必须有契约测试样例；
- 平台缺少字段时必须明确使用扩展字段、本地存储或降级，不得丢弃；
- 平台增加未知状态时先映射为受控未知状态并报警，不自动当作成功；
- 时间统一使用带时区的 ISO 8601；
- 展示名可变化，内部关联只使用稳定 ID；
- 日志和测试夹具不得包含真实 secret 或不必要的私人内容。

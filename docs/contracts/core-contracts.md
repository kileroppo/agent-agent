# Agent军团核心契约

| 字段 | 内容 |
| --- | --- |
| 状态 | v3.5 实施中：M2 基线稳定，M3 图文证据链、拆解、创作与知识归档已有本地实现和契约测试 |
| 负责人 | 技术负责人 / Codex 工作台 |
| 版本 | v3.5 |
| 最后更新 | 2026-07-28 |
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
| `interaction.directFeishu` | 否 | `required` 表示独立 Gateway 常驻；`disabled` 表示保留 Profile 与 Paperclip 按需执行、但禁止独立 Gateway 自动拉起 |
| `owner` | 是 | 业务负责人 |
| `status` | 是 | `draft`、`active`、`paused`、`retired` |

Manifest 是活动岗位的唯一真相。运行时提案不能覆盖正式 Manifest 的状态，也不能单独生成活动员工；只有正式 Manifest 为 `active` 的岗位可进入活动注册表。Manifest 不保存 secret，也不直接嵌入不可审计的长 Prompt；Prompt 使用版本化引用。

### 2.1 独立员工就绪投影

`runtimeProfileRef` 的本机状态只能按以下顺序投影，不能把“选过模型”或“填过飞书应用”冒充成独立员工已经可用：

| 状态 | 事实含义 |
| --- | --- |
| `not_created` / `missing_profile` / `invalid_reference` | 独立身份尚未建立或资料无效 |
| `model_pending` | 独立身份已建立，但尚未完成模型选择 |
| `model_transport_pending` | 已选择模型，但凭据授权与一次真实无副作用调用尚未验证 |
| `channel_pending` | 模型调用已验证，独立飞书入口尚未启用 |
| `waiting_verification` | 模型和入口均已配置，但尚无真实消息闭环证据 |
| `ready` | 独立模型调用和运行入口已有验证证据 |

`modelConfigured` 只代表模型选择已写入；只有 `credentialedTransportVerified=true` 才代表模型传输已经通过。飞书实时连接状态与模型状态应分开展示；App ID、Secret、允许人员 ID 和授权链接不得进入读取接口。

模型授权入口复用 Hermes 官方 Dashboard，并且必须：

- 只由本机老板打开；
- 固定绑定 `127.0.0.1`，拒绝公网、局域网和端口冲突；
- 只接受白名单员工 ID，并用 `?profile=<员工 Profile>` 明确作用域；
- 不读取、不代理、不记录模型 token/API Key；
- 打开授权页不等于授权完成；仍需一次真实、无副作用模型调用才能把状态改为 `credentialedTransportVerified=true`。

### 2.2 AgentProposalContract

定义由飞书创建入口和治理 Agent 生成的新岗位草案。它不是已上线 Agent，不能拥有生产运行、外部账号或未批准权限。

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `proposalId` | 是 | 稳定草案 ID |
| `sourceEventRef` | 飞书入口是 | 飞书创建请求的安全引用与幂等关联；本机草案入口可为空 |
| `requestedOutcome` | 是 | 用户希望新岗位持续产出的可验证结果 |
| `candidateManifest` | 是 | 待审核的 AgentManifest 快照 |
| `promptRef` | 是 | 版本化 Prompt 草案引用 |
| `desiredSkills` | 是 | 仅可引用已审核公司技能库中的候选 Skills |
| `runtimePlan` | 是 | Hermes/A君/其他运行时及隔离方式 |
| `requestedCapabilities` | 是 | 需要的受控本机能力与连接动作 |
| `budgetPolicy` | 是 | 测试与上线后的预算上限 |
| `acceptanceTask` | 是 | 受限测试任务、预期产物和质量门禁 |
| `status` | 是 | `idea`、`draft`、`pending_approval`、`testing`、`active`、`needs_revision`、`rejected`、`archived` |
| `reviewRefs` / `paperclipAgentRef` | 否 | 审核和 Paperclip Agent 记录引用 |
| `createdAt` / `updatedAt` | 是 | ISO 8601 时间 |
| `archivedAt` / `archivedBy` / `archiveReason` | 归档时是 | 归档时间、操作者和原因；不得删除原审计、测试实例或历史任务 |

状态推进仅允许：`idea → draft → pending_approval → testing → active`。审核拒绝进入 `rejected`；草案、测试或验收失败进入 `needs_revision`；任一既有状态可由本机负责人归档为终态 `archived`。受限测试通过时草案仍保持 `testing`，必须由负责人另一次明确激活决定才可进入 `active`；激活前提除隔离实例、验收、预算和工具白名单外，还必须存在同 `agentId` 且状态为 `active` 的正式 Manifest。不得把自然语言需求、私密上下文、Cookie、token 或浏览器会话复制到草案。

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

### 3.1.1 M3 内容增长任务类型

顶层 `TaskContract` 不变，以下任务只扩展 `taskType` 和受控 `input`：

| `taskType` | 承接岗位 | 必要输入 | 关键门禁 |
| --- | --- | --- | --- |
| `content.video-benchmark-analysis` | `video-content-analyst` | `source` 或明确的转录产物引用；`depth: fast\|full`；可选 `focus`、`visualMode: auto\|off\|required`（默认 `auto`） | 只有 URL 且未给转录任务时，A君自动展开为“小D经内容获取中心获取/转录确认/视觉取证 → 小拆”的同一总任务；正式模式等待系统或人工 `confirmed_transcript`；`required` 缺少视觉证据时进入 `needs_input` |
| `content.platform-draft` | `content-creator` | `confirmed_transcript`、正式 `video_content_analysis_report`、1–3 个目标平台 | 只生成草稿；禁止外发和自动发布 |
| `content.performance-review` | `video-content-analyst` | 原拆解、原草稿、真实结构化指标 | 不把相关性写成确定因果 |
| `office.knowledge-summary` | `office-assistant` | 当前任务脱敏正文、明确的 `sourceTaskIds`/产物引用或受限会话快照 | 只写统一内容库 `Agent军团/`，不接受任意路径 |

小拆 `fast` 最长 5 分钟、最多 2 次尝试；`full` 最长 12 分钟，最多一次安全重试。超限后停止扩大模型调用并交付已有可验证部分。小创一次最多生成三个平台版本。

### 3.2 标准状态

```text
received
needs_input
queued
running
waiting_worker
pausing
paused
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
- 云端任务需要本机文件、私人账号或重型媒体能力时进入 `waiting_worker`；Mac 工作间以短租约领取后进入 `running`，租约过期可重新领取；
- `running` 遇到高风险动作进入 `waiting_approval`；
- `running` 收到暂停确认后先进入 `pausing`；只有运行时到达安全位置后才能进入 `paused`，不得提前显示为已暂停；
- `paused` 的继续操作必须重新走组织级确认，批准后回到 `queued` 或 `running`；
- `waiting_approval` 批准后回到 `running`，拒绝后进入 `cancelled` 或受控失败；
- `succeeded`、`failed`、`cancelled`、`expired` 为终态；
- 从终态重试时创建新的 attempt 记录，不擦除原历史。

### 3.4 MacWorkerLeaseContract

私人云端办公室只通过出站轮询把需要本机能力的工作交给 Mac 工作间，不把本机服务直接暴露到公网。

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `taskId` | 是 | 云端任务的稳定 ID，同时作为本机执行幂等键 |
| `workerId` | 是 | 脱敏的工作设备标识 |
| `leaseId` | 是 | 单次短租约标识；旧租约不得覆盖新结果 |
| `leaseExpiresAt` | 是 | 租约过期时间 |
| `capability` | 是 | 当前只允许白名单能力，如 `media.transcribe-and-refine` |
| `stage` / `progress` | 否 | 工作阶段和真实进度 |
| `artifactRefs` | 完成时是 | 已验证且脱敏的产物引用 |
| `error` | 失败时是 | 脱敏标准错误 |

Worker API 必须使用独立 Bearer Token；云端地址必须为 HTTPS（回环验收除外），本机小D地址必须为回环 HTTP。成功回写必须带通过存在性、可读性和权限检查的产物；不得回传本机路径、Cookie、token、浏览器会话或原始凭据。Mac 离线时任务保持 `waiting_worker`，不能误报执行中、失败或完成。

### 3.5 标准错误

`error` 至少包含：

- `code`：稳定机器码；
- `message`：面向维护者的真实原因；
- `userMessage`：不泄密的用户说明；
- `category`：`retryable`、`needs_input`、`manual`、`permanent`；
- `stage`：失败阶段；
- `causeRef`：原始错误或日志引用；
- `occurredAt`：发生时间。

### 3.6 PaperclipTaskProjection

定义进入组织级治理的最小任务信封。仅当任务涉及新 Agent、扩权/账号连接、公开发布、付费/预算、跨 Agent、长任务调度、暂停/终止或跨岗位审计时才创建或关联该投影；低风险、单 Agent、可立即完成的飞书请求，以及本次范围明确的一次性审批，都不应仅为记录而增加 Paperclip 中转。

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `taskId` | 是 | 对应 TaskContract 的稳定 ID |
| `sourceEventRef` | 是 | 飞书或其他入口事件的安全引用，用于幂等关联 |
| `governanceReasons` | 是 | 触发组织级治理的原因集合 |
| `assigneeAgentId` | 是 | 当前负责人 |
| `statusSummary` | 是 | 不含业务细节的组织级状态摘要 |
| `budgetRef` / `approvalRefs` | 否 | 关联预算与审批引用 |
| `artifactRefs` | 否 | 已验证产物的安全引用 |
| `failureSummary` | 否 | 脱敏失败分类与恢复状态 |
| `paperclipIssueRef` | 否 | 已创建或关联的 Paperclip 任务引用 |

不得将原始聊天正文、媒体文件、字幕全文、Cookie、token、浏览器会话或业务 checkpoint 写入该投影。Paperclip 的终态不能覆盖业务存储中的产物验证结果。

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

### 4.1 M3 内容证据与知识产物

| `type` | 生产者 | 必要验证 |
| --- | --- | --- |
| `source_evidence_record` | 小D | 来源引用、获取路径、真实标题/作者/平台/时长和脱敏标准链接可读取；缺失字段不编造 |
| `raw_asr_transcript` | 小D | 原始机器稿不可静默覆盖，带校验值 |
| `transcript_quality_report` | 小D | 覆盖、尾部、时间点与硬失败结论可读取 |
| `automatic_transcript_attestation` | 小D质量门禁 | 记录 `confirmationMode=automatic`、`completeListen=false`、版本、时间和机器稿校验值 |
| `human_review_attestation` | 小D听审确认入口 | 记录完整听审声明、版本、确认时间和校验值 |
| `confirmed_transcript` | 小D质量门禁或听审确认入口 | 引用机器稿与对应确认记录；明确 `confirmationMode=automatic\|human`，不得把自动确认写成人工听审 |
| `visual_evidence_package` | 小D | 视频校验值、精确时长、关键帧时间/原因/图片引用/校验值和故事板可读取；`fast≤12`、`full≤48`、每张故事板≤12 |
| `video_content_analysis_report` | 小拆 | 正式/初步模式、模块数、来源产物、`sourceMetadata`、`visualCoverage`、`visualFindings`、`completeness` 和逐项证据关联明确；画面判断必须引用合法关键帧与时间点 |
| `platform_content_draft` | 小创 | 使用确认稿和正式拆解；平台数不超过三；`externalSideEffects=0` |
| `content_performance_report` | 小拆 | 引用原拆解和草稿，包含真实指标并避免因果过度推断 |
| `knowledge_summary_note` | 小办 | 路径受限、回读成功、幂等、校验值和来源任务明确 |

`confirmed_transcript` 是正式拆解和正式创作的证据门；默认由质量门禁自动生成，异常或用户明确要求时转人工听审。`raw_asr_transcript` 只能用于明确标记的初步分析。自动或人工确认都不能覆盖机器质量报告中的音频覆盖或尾部完整性硬失败。

## 5. ApprovalContract

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `approvalId` | 是 | 唯一审批 ID |
| `taskId` | 是 | 关联任务 |
| `governanceMode` | 是 | `local`：A君保存本次审批；`paperclip`：Paperclip 保存组织级审批 |
| `decisionChannel` | 是 | 首期为 `feishu_card`；卡片是决策界面，不等于审批真相来源 |
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

`local` 只适用于一次性、范围明确、不会改变长期组织能力的任务；批准仅对 `requestedScope` 和有效期内的动作生效，不能作为永久扩权。`paperclip` 适用于新 Agent、扩权/账号连接、公开发布、付费/预算、跨 Agent 长任务、暂停/终止或组织级审计。审批过期、撤销、重复卡片回调或范围不匹配时默认拒绝；任何路径都必须由 A君在继续执行前二次校验状态、范围与有效期。

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

调用必须使用 `connectionId + operation`，并验证 `provider`、`grantedOperations`、`dataScope`、`allowedAgentIds`、有效期与审批。登录输入可由受控浏览器、OAuth、CookieBridge 或其他本机导入适配器提供；所有执行器只得到受限连接使用权，而不是原始凭据。`browser_companion` 必须使用独立配置目录和仅回环控制通道；业务 Agent 只能请求已登记的只读动作，不能读取、导出或回显浏览器 Cookie。拒绝时返回标准错误分类；连接健康只能说明连接可用，不能证明具体业务素材可获取或任务已完成。

## 7. ContentAcquisitionContract

定义业务 Agent 请求网站或软件内容、内容获取中心选择通道、并向上层交付统一内容包的边界。业务 Agent 只依赖本契约，不依赖 MediaCrawlerPro、`yt-dlp`、CookieBridge、浏览器或未来替代工具。

### 7.1 ContentAcquisitionRequest

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `requestId` | 是 | 单次内容获取请求的稳定 ID |
| `taskId` | 是 | 关联业务任务 |
| `source` | 是 | 来源 URL 或受控来源引用 |
| `requestedCapabilities` | 是 | 希望读取的能力，如 `basic_content`、`images`、`media`、`subtitles`、`comments` |
| `runtimeRequirement` | 否 | 同一能力的受控运行用途，如 `media_transcription` 或 `visual_analysis`；只影响适配器选择的音轨/视频形态，不允许指定具体下载器 |
| `connectionId` | 否 | 需要登录时使用的命名连接 |
| `requestingAgentId` | 是 | 发起请求的 Agent ID |
| `routingPolicy` | 是 | 当前固定为 `specialized_first_general_fallback` |
| `createdAt` | 是 | ISO 8601 时间 |

请求不能指定具体适配器、Cookie、浏览器标签页、命令行参数或原始凭据。平台识别、连接检查和工具选择属于内容获取中心。

### 7.2 ContentPackage

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `packageId` | 是 | 统一内容包 ID |
| `requestId` / `taskId` | 是 | 关联请求与业务任务 |
| `provider` | 是 | 已识别的平台标识；未知时为受控未知值 |
| `sourceRef` | 是 | 可追溯的安全来源引用 |
| `acquisitionPath` | 是 | `specialized` 或 `general`，只说明本次通道 |
| `providedCapabilities` | 是 | 本次实际提供的内容能力集合 |
| `capabilityNotes` | 否 | 面向用户或 Agent 的安全能力说明，不把通用结果称作“内容不完整” |
| `contentItems` | 是 | 标准化正文、图片、媒体、字幕、评论和基本信息引用 |
| `adapterRef` | 是 | 脱敏适配器标识与版本 |
| `validation` | 是 | 存在性、可读性、来源与访问范围校验结果 |
| `createdAt` | 是 | ISO 8601 时间 |

`comments` 是一项独立能力：MediaCrawlerPro 等深度通道可提供时写入 `providedCapabilities`；通用通道未声明该能力不构成失败。只有请求明确要求某能力且没有任何允许通道能提供时，才返回标准 `capability_not_available` 错误。

### 7.3 AdapterCapabilityRecord

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `adapterId` | 是 | 稳定适配器标识 |
| `providerMatchers` | 是 | 支持的平台或来源匹配规则 |
| `capabilities` | 是 | 可提供的标准内容能力 |
| `accessMode` | 是 | `public`、`authorized` 或 `either` |
| `priorityClass` | 是 | `specialized` 或 `general` |
| `healthStatus` | 是 | 脱敏可用状态 |
| `versionRef` | 是 | 受控版本引用 |

内容获取中心以注册表的 `priorityClass` 和 `healthStatus` 路由；上层 Agent 不可覆盖路由策略。B站原生字幕和 MediaCrawlerPro 可注册为固定平台的 `specialized` 适配器，`yt-dlp` 等公开媒体读取可注册为 `general` 适配器。原生字幕只有通过条数、文本量和覆盖率门禁后才允许返回 `subtitles`；否则必须继续路由到媒体音轨和本机 ASR，不能把片头推广或残缺字幕当作完整转录。视觉分析另以 `runtimeRequirement=visual_analysis` 经同一中心受控取得视频；转录用途优先音轨，视觉用途必须返回含画面的媒体，业务 Agent 不得直接切换下载器。

## 8. LocalCapabilityProviderContract

定义 A君 托管的可替换本机能力边界。业务 Agent、Hermes 与 Paperclip 只依赖受控请求和结果契约，不直接绑定下载器、ASR、浏览器伴侣、平台 SDK 或具体命令。

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `providerId` | 是 | 稳定能力提供者标识 |
| `versionRef` | 是 | 受控版本引用 |
| `capabilities` | 是 | 标准化可执行动作集合 |
| `inputContractRef` / `outputContractRef` | 是 | 输入和输出的版本化契约引用 |
| `requiredConnectionOperations` | 否 | 需要的命名连接动作；不能包含凭据原文 |
| `allowedAgentIds` | 是 | 可调用该能力的 Agent ID |
| `healthProbeRef` | 是 | 脱敏健康检查定义 |
| `lifecycle` | 是 | 安装、启动、停止、更新与卸载的受控策略引用 |
| `failureClasses` | 是 | 可恢复、需授权、需人工或永久失败的映射 |
| `recoveryActions` | 是 | 允许的低风险恢复动作集合 |

新能力先以 `draft` Provider 注册并通过契约测试和健康检查，再由策略启用。替换 Provider 不得改变上层 Agent 的任务语义；需要新增权限、外部副作用或高成本动作时，仍须经过 ConnectionAuthorizationContract 和 ApprovalContract。

## 9. OperationsHealthEventContract

定义 Agent 运维官消费的脱敏健康事件。它用于诊断和恢复，不携带原始凭据、完整浏览器会话或受限内容。

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `eventId` | 是 | 稳定事件 ID |
| `subjectType` / `subjectRef` | 是 | `connection`、`adapter`、`task` 或 `component` 及其安全引用 |
| `eventType` | 是 | 如 `connection_expired`、`adapter_unavailable`、`fallback_used`、`repeated_failure` |
| `severity` | 是 | `info`、`warning`、`error`、`critical` |
| `safeMessage` | 是 | 不泄密的诊断说明 |
| `recommendedAction` | 是 | `reauthorize`、`retry`、`restart_managed_component`、`manual_review` 等 |
| `attemptedRecovery` | 否 | 已执行的低风险恢复与结果 |
| `taskRefs` | 否 | 受影响任务的引用集合 |
| `createdAt` / `resolvedAt` | 是/否 | 时间记录 |

运维官可以通知、重试和恢复 A君自管组件；它不能根据事件读取凭据、执行登录、绕过平台限制或扩大授权。

## 10. Agent Army MCP Tool Contract

定义 Hermes Profile 访问军团真相的受控工具边界。传输使用本机 `stdio`，HTTP 下游只能是 loopback A君运行时。

| 工具类别 | 当前工具 | 约束 |
| --- | --- | --- |
| 只读能力与状态 | `capabilities`、`status`、`employee_status` | 不创建任务；回答必须来自当前运行概览 |
| 只读任务 | `task_list`、`task_get` | 只返回脱敏任务、错误、审批与白名单产物摘要 |
| 任务动作 | `task_create`、`mission_create`、`task_control` | 必须使用已上岗任务类型和幂等引用；`mission_create` 限 1–3 项并形成一个总任务；高风险只进入既有审批 |
| 审批 | `approval_list`、`approval_resolve` | 批准前必须经当前 Hermes 会话 elicitation；明确拒绝直接安全关闭，批准超时或会话离开时不执行 |
| Paperclip heartbeat | `paperclip_assignment_get`、`paperclip_assignment_complete` | 只允许存在当前 issue/run/agent 环境身份时调用；每个 heartbeat 读取和完成各最多一次；回写必须携带当前 Paperclip API key 与 run 身份，不能关闭别人的任务或以用户身份回写 |
| 受控技术修复 | `technical_repair_execute` | 仅技术专家、仅当前 `operations.technical-repair` 指派；只暴露白名单文件、测试命令和恢复检查。只有 A君返回 `verified=true`、测试与恢复检查通过并安全带回后，员工才可回报 `succeeded` |

Hermes Session 只保存对话和上下文；A君/业务 Agent 保存任务与 checkpoint；Paperclip 保存组织级真相。MCP Server 不保存 secret、聊天正文、会话数据库、任务副本或审批副本。新增工具必须复用现有服务契约、声明只读/副作用注解，并具有失败关闭和脱敏测试。

正式员工 Manifest 的 `runtimeCapabilities` 是 Profile 配置输入：`skills`、`mcpTools`、`feishuToolsets` 与 `paperclipToolsets` 必须显式列出。配置器只能从该白名单生成独立 Profile 和 Adapter；新员工不得继承另一个员工的会话、记忆或扩大后的工具集合。

## 11. 跨系统映射要求

- 每个适配器必须有契约测试样例；
- 平台缺少字段时必须明确使用扩展字段、本地存储或降级，不得丢弃；
- 平台增加未知状态时先映射为受控未知状态并报警，不自动当作成功；
- 时间统一使用带时区的 ISO 8601；
- 展示名可变化，内部关联只使用稳定 ID；
- 日志和测试夹具不得包含真实 secret 或不必要的私人内容。

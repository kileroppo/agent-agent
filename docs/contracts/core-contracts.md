# Agent军团核心契约

| 字段 | 内容 |
| --- | --- |
| 状态 | v5 实施中：M5 并行 v2 已 live apply，活动与真实发布仍关闭 |
| 负责人 | 技术负责人 / Codex 工作台 |
| 版本 | v5.0 |
| 最后更新 | 2026-08-02 |
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
| `openTaskPolicy` | 否 | 岗位开放任务域与质量门禁；存在时至少声明一个岗位专属开放任务类型 |
| `dynamicCapabilityPolicy` | 否 | 能力发现提案来源、模型策略不可变约束及需审批的敏感类别；不能自行激活能力 |
| `autonomyBudgetPolicy` | 否 | 投影给 Paperclip 的预算建议，不是 A君本地预算真相 |
| `runtimeCapabilities.modelSelection` | 是 | 主推理模型；11 个正式岗位当前固定为 `deepseek/deepseek-v4-flash` |
| `runtimeCapabilities.fallbackModels` | 否 | 有序回退；11 个正式岗位当前为空，不回退到 StepFun 文本模型 |
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
| `content.video-benchmark-analysis` | `video-content-analyst` | `source` 或明确的转录产物引用；`depth: fast\|full`；可选 `focus`、`visualMode: auto\|off\|required`（默认 `auto`）、受控 `context.boomSignal` | 只有 URL 且未给转录任务时，A君自动展开为“小D经内容获取中心获取/转录确认/视觉取证 → 小拆”的同一总任务；正式模式等待系统或人工 `confirmed_transcript`；爆款信号必须保留观察来源、冻结基线和公式，且只作筛选依据；`required` 缺少视觉证据时进入 `needs_input` |
| `content.platform-draft` | `content-creator` | `confirmed_transcript`、正式 `video_content_analysis_report`、1–3 个目标平台 | 只生成草稿；禁止外发和自动发布 |
| `content.video-script-package` | `content-creator` | 一句话主题；可选明确引用的正式拆解、平台、时长和公开来源 | 自动匹配参考案例，只返回一版主脚本；内部生产包固定五个文件，禁止生成成片和发布 |
| `content.performance-review` | `video-content-analyst` | 原拆解、原草稿、真实结构化指标 | 不把相关性写成确定因果 |
| `office.knowledge-summary` | `office-assistant` | 当前任务脱敏正文、明确的 `sourceTaskIds`/产物引用或受限会话快照 | 只写统一内容库 `Agent军团/`，不接受任意路径 |
| `office.presentation-package` | `office-assistant` | 标题、用途、受众、页数或逐页提纲；可选 `designMode`、`sourceTaskIds`、本地媒体、`outputs` 和 `dataClassification` | PPTD/PPTX 只写当前 A君受控任务工作区且自包含；结构化任务由窄适配器确定性执行，PPTX 使用锁定本地工具链离线导出；依赖未就绪时保留 PPTD 并进入 `needs_input`/`waiting_test` |

A君内建爆款雷达的正式链接评分版本为 `v2`，正式 `boomSignal` 必须携带 `scoreVersion: v2`，并由该版本决定等级和派发深度。旧 `v1` 只作为版本化回滚对照，必须标明 `controlsDispatch: false`，不得触发军团派发。缺少发布时间的评分只能描述累计表现，不能表述为实时爆发。自动派发默认关闭；单作品手动派发必须绑定精确 `work_id`，不能顺带处理其他队列项，`N0` 不得派发。

小拆 `fast` 最长 5 分钟、最多 2 次尝试；`full` 最长 12 分钟，最多一次安全重试。超限后停止扩大模型调用并交付已有可验证部分。小创一次最多生成三个平台版本。

### 3.1.2 开放任务与无状态岗位委托

11 个活动岗位各保留原专有任务，同时增加一个开放任务类型：

| 岗位 | 开放任务类型 |
| --- | --- |
| A君 | `army.goal-program` |
| 小D | `media.open-production` |
| 小R | `research.open-investigation` |
| 小办 | `office.deliverable-program` |
| 运维官 | `operations.incident-response` |
| 创建官 | `governance.capability-design` |
| 审核官 | `governance.assurance-review` |
| 架构师 | `governance.architecture-experiment` |
| 技术专家 | `operations.engineering-resolution` |
| 小拆 | `content.analysis-program` |
| 小创 | `content.creation-program` |

开放任务的 `input.goalSpec` 是执行目标输入，不是第二份任务控制面。A君通过固定、无状态映射把开放任务交给同岗位的专有执行器，并保留 `openTaskType` 供执行器理解原请求；不得生成 `autonomous_work_plan`、本地预算、checkpoint 或能力授权报告。

能力请求只和岗位 Manifest 的 `toolAllowlist`、已登记 MCP 工具及技能白名单比较；缺失能力直接进入 `needs_input`，不能生成临时授权。任务计划、Issue、预算、审批、重试和恢复使用 Paperclip；Hermes 保存会话与运行检查点。任务中的能力请求不能修改主模型或回退模型。

### 3.1.3 能力授权归属与历史兼容

动态能力只能从 Manifest、仓库、已安装 Hermes、官方来源或已审核第三方目录发现。发现结果只能形成提案；生产激活必须进入 Paperclip/插件的正式审计与授权流程，并同时具备：

- 明确 `capabilityId`、来源、版本和 SHA-256；
- 权限不超过岗位 Manifest；
- 低风险且不需要凭据、外部写入、付费动作或扩权；
- 审计与沙箱证据均通过；
- 有任务级有效期或明确回滚引用。

任一条件不满足时状态只能是 `needs_capability`、`pending_validation` 或 `waiting_approval`。未知能力不得被静默下载、安装或加入工具白名单。旧 `CapabilityGrantContract`、自主计划和 checkpoint 模块仅用于读取或迁移历史记录；生产不得实例化本地 CapabilityGrant Store，也不得写 `capability-grants.json`。

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
waiting_test
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
- 本轮自动验证未能闭合、但已保留可继续验证的产物时进入 `waiting_test`；它是本 attempt 的终态，不能冒充成功；
- `waiting_test`、`succeeded`、`failed`、`cancelled`、`expired` 为终态；
- 从终态重试时创建新的 attempt 记录，不擦除原历史。

状态 mutation 必须通过任务生命周期 Module。JSON 与 SQLite TaskStore 都只负责原子持久化，
不得绕过迁移矩阵直接覆盖 `status`；终态重试必须显式把 `attempt` 恰好增加 1。

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

### 3.7 M5 Campaign 与并行工作投影

- `CampaignGrant` 绑定平台、账号引用、主题、期限、每日/总次数、预算和允许/禁止动作；它是发布写入授权，不是第二套任务状态。
- 每日主题使用直接日期 Case；研究、证据、画面分析、生图和配音使用子 Case。并行分支必须带稳定 `caseKey`、负责人、预期 Work Product 和 blocker。
- `ParallelJoin` 只能由无模型控制器生成；研究、证据、`AssetPackage`、`GeneratedImagePackage` 与脚本后的 `VoicePackage` 未全部通过时不得解锁 `RenderPackage`。
- 发布幂等键固定为 `campaignId + platform + contentVersion + scheduledDate`。首版只允许即时发布，`scheduledDate` 必须等于 `Asia/Shanghai` 当前执行日；历史或未来日期在读取产物、凭据和调用 connector 前拒绝。`PublishReceipt` 必须含平台内容引用和可核验成功证据；CUA 还必须绑定 accountRef 页面身份哈希、内容 ID、标题、真实结果页 URL、selector 版本与观察哈希，点击发布按钮或只有“发布成功”文案不算成功。
- `PlanRevision` 必须保存上一条失败路线的执行指纹。`M5RouteExecution` 由执行器根据脱敏业务输入哈希、实际工具集合和执行策略生成；模型只能回显 revision ID，不能自行声明 `routeChanged=true`。同一 revision 再次得到相同路线指纹时必须在工具调用前失败关闭，并继续计入两次阶段重试、三次内容重规划上限，最终转 `blocked`。
- 当前源码与 live 均为 15 阶段、17 Routine、5 控制器；活动草案仍未批准，Routine 定义存在但 schedule trigger 关闭且从未触发。历史迁移 dry-run 不能冒充这次已回读的 live apply。

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
| `video_content_analysis_report` | 小拆 | 正式/初步模式、模块数、来源产物、`sourceMetadata`、可选 `boomSignal`、`visualCoverage`、`visualFindings`、`completeness` 和逐项证据关联明确；存在爆款信号时必须原样保留且不得解释为确定因果；画面判断必须引用合法关键帧与时间点 |
| `platform_content_draft` | 小创 | 使用确认稿和正式拆解；平台数不超过三；`externalSideEffects=0` |
| `video_script_package` | 小创 | 包含可读脚本、镜头、SRT、来源和 manifest；记录参考匹配、模板生命周期、校验值与 `externalSideEffects=0` |
| `content_performance_report` | 小拆 | 引用原拆解和草稿，包含真实指标并避免因果过度推断 |
| `knowledge_summary_note` | 小办 | 路径受限、回读成功、幂等、校验值和来源任务明确 |
| `office_presentation_source` | 小办 | 自包含目录、`.pptd`、逐页 `.page`、本地 `media/`、页数和源码版本/哈希完整；不得引用远程素材或越出 A君受控任务工作区 |
| `office_presentation_qa` | 小办 | 结构检查、页面数、预览引用、问题清单和结构/视觉质检状态分开记录；未运行外部图片质检时不得标记通过 |
| `office_pptx_document` | 小办 | ZIP/CRC、页数、每页唯一根级 fade 转场、合法 XML 顺序、字体部件结果和人工 Office/WPS 复核要求明确 |
| `intel_research_report` | 小R | 搜索型任务携带 `agent.army/research-method/v1`：六路可审计查询计划、路线覆盖、来源评估和主张级证据账本；搜索排名、头衔和“内幕/真相”措辞都不是可信度信号；不同域名不得冒充独立来源，未找到利益冲突或反证只能记录 `not_established` / `not_identified_at_claim_level` |
| `wechat_chat_analysis_report` | 微信聊天取件员 | 仅含摘要、主题、决定、待办、风险和回复建议；`containsRawChat=false`、`containsSenderIdentifiers=false`、`modelBoundary=loopback-only`，不得保存原文或微信内部 ID |

`confirmed_transcript` 是正式拆解和正式创作的证据门；默认由质量门禁自动生成，异常或用户明确要求时转人工听审。`raw_asr_transcript` 只能用于明确标记的初步分析。自动或人工确认都不能覆盖机器质量报告中的音频覆盖或尾部完整性硬失败。

### 4.2 M5 内容与发布产物

| `type` | 必要验证 |
| --- | --- |
| `campaign_research_report` | `agent.army/campaign-research/v2`；每条事实 claim 保存真正支持它的 `sourceIds` 与逐来源 `evidenceFragments`，不得把全部来源批量挂到每条结论；自动发现时同时携带 `agent.army/research-method/v1` |
| `evidence_package` | `agent.army/evidence-package/v2`；M5 每条来源都具有公开 URL、抓取时间、正文内容哈希和可引用片段；GitHub 搜索元数据只作发现线索，不能进入事实证据；搜索路线覆盖只描述发现过程，不替代 claim 证据 |
| `asset_package` | 真实关键帧回读、相对路径、版权依据、字节数和 SHA-256；拒绝绝对路径、穿越与符号链接逃逸 |
| `render_package` | `master.mp4`、`douyin.mp4`、`xiaohongshu.mp4` 三份固定成片；props 的 `coverSrc`/逐场景 `imageSrc` 必须在 `assetLedger` 中且渲染前复核哈希 |
| `machine_review_report` | 七项门禁完整；事实门禁逐项比对脚本 `factBindings` 与 EvidencePackage 的 claim、`sourceIds`、`evidenceFragments`，并拒绝缺 URL/时间/hash 或仅有 GitHub metadata 的来源；`passed` 时必须绑定已校验 `artifact-manifest.json` 和固定 9 项产物 |
| `platform_content_draft` | 平台、内容版本、媒体哈希、标题、正文和标签完整；抖音与小红书不能复用同一文案冒充适配 |
| `publish_receipt` | 幂等键、平台内容引用、发布时间、文件哈希和成功证据完整 |
| `metric_snapshot` | 只从同 Case 可信发布凭证派生，采集点为 2h/24h/72h |
| `learning_proposal` | 至少 5 条同类型真实 72h 指标；只允许 `proposed`，不能直接修改 Prompt、权限、频率或投流 |

固定 9 项为三份 MP4、双平台文案、`cover.png`、`sources.json`、`review.json`、
`lineage.json`。内容插件 live 已从不可变净包安装为 `0.4.7` 并处于 `ready`；
插件 ready 只证明受控工具可用，不批准 Campaign、真实 Publisher、selector/Profile
lease 或平台写权限。

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
| `privateReadGrant` | 否 | 微信私密读取批准后生成的临时授权；绑定负责人、飞书会话、岗位、单一微信会话、固定起止时间和最多 200 条，30 分钟内最多 10 次，可撤销并记录幂等使用 |

`local` 只适用于一次性或短时、范围明确、不会改变长期组织能力的任务；批准仅对 `requestedScope` 和有效期内的动作生效，不能作为永久扩权。微信私密读取是唯一允许从一次批准派生短时 `PrivateReadGrant` 的场景：首次卡片确认后，同一范围可在 30 分钟内最多读取 10 次；同一任务重试按 taskId 幂等，不重复计次。改变会话、扩大时间、新消息超出固定结束时间、超过 200 条、过期、撤销或用尽都必须重新批准。Vault 与本机模型健康检查必须在创建或扣减授权前通过，使用次数只在实际聊天读取即将开始时记录。`paperclip` 适用于新 Agent、扩权/账号连接、公开发布、付费/预算、跨 Agent 长任务、暂停/终止或组织级审计。审批过期、撤销、重复卡片回调或范围不匹配时默认拒绝；任何路径都必须由 A君在继续执行前二次校验状态、范围与有效期。

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
| `isDefault` | 否 | 同一平台内是否为任务默认账号；每个平台至多一个活动默认连接 |
| `expiresAt` | 否 | 已知的授权过期时间 |
| `lastHealthAt` | 否 | 最近一次脱敏健康检查时间 |
| `lastVerification` | 否 | 最近一次真实读取的脱敏结果：状态、时间、适配器、实际能力和失败分类 |
| `createdAt` / `updatedAt` | 是 | ISO 8601 时间 |

调用必须使用 `connectionId + operation`，并验证 `provider`、`grantedOperations`、`dataScope`、`allowedAgentIds`、有效期与审批。任务显式指定账号时优先使用该连接；未指定时使用平台默认账号；同平台存在多个活动账号且没有默认账号时必须返回 `connection_selection_required`，不得猜测。登录输入可由受控浏览器、OAuth、CookieBridge 或其他本机导入适配器提供；所有执行器只得到受限连接使用权，而不是原始凭据。`browser_companion` 必须使用独立配置目录和仅回环控制通道；业务 Agent 只能请求已登记的只读动作，不能读取、导出或回显浏览器 Cookie。拒绝时返回标准错误分类；连接健康只能说明连接可用，不能证明具体业务素材可获取或任务已完成。`lastVerification` 只能由真实适配器调用更新；授权通道失败后的公开降级不能把该账号改记为成功。

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
| `access` | 是 | 本次真实访问方式：`public_read` 或 `authorized_read`；授权读取同时保留命名连接和账号别名 |
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

### 8.1 LocalAiCapabilityInvocation

本机模型适配器以稳定能力名接收调用，不让业务 Agent 选择权重文件或底层命令。当前标准能力名为 `text.generate`、`vision.analyze`、`video.analyze`、`audio.transcribe`、`audio.synthesize`、`audio.clone_authorized`、`image.generate`、`image.edit`、`embedding.create`、`rerank.score` 和 `video.generate`。

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `requestId` | 是 | 调用方提供或网关生成的稳定 ID，用于底层取消与诊断；不是 Paperclip 业务任务 ID |
| `capability` | 是 | 标准能力名 |
| `input` | 是 | 版本化能力输入；本地媒体只能使用已存在的绝对路径或受控上传引用 |
| `options` | 否 | 温度、输出长度、抽帧数、图片尺寸等有界执行选项 |
| `approved` | 否 | 仅表示调用已携带上层授权证明；网关不得据此自行扩大权限或绕过 Paperclip/A君校验 |
| `provider` | 响应 | 实际执行的本机或台式机适配器 |
| `elapsedSeconds` | 响应 | 本次实际耗时 |
| `result` | 响应 | 标准结果或已验证本机产物引用 |

能力状态必须分别报告 `declared`、`configured`、`healthy` 和 `e2eVerified`。下载权重只满足 `configured` 的一部分；端口监听只满足健康探针的一部分；只有固定样本实际输入输出通过才可记录 `e2eVerified`。底层 `speech`、`heavy`、`retrieval` 锁只是统一内存与进程保护，不得保存业务状态、复制 Paperclip 队列或把排队视作任务执行成功。

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
| 四岗受控执行 | `employee_assignment_execute` | 仅 A君、小R、小D和小办的 Paperclip heartbeat 可调用；不接收岗位、任务、路径、命令或外部动作参数。服务端必须再次核验 Paperclip issue/run/agent、Routine 对应岗位、任务承接人和 Manifest 任务类型，随后分别复用 `LocalAjunCoordinator`、`LocalIntelResearcher`、`XiaodDelegate`、`LocalOfficeAssistant`；重复调用复用同一任务和已验证产物 |
| 岗位草案 | `agent_proposal_create_execute` | 仅创建官、仅当前 `governance.agent-proposal` 指派；只能申请已审核或已登记且有明确风险边界的能力。没有受控适配器的高风险本机能力只生成 `needs_capability` 草案；微信 Vault 在草案测试阶段仍只开放不含真实聊天的合成技术验收，正式岗位必须另有活动 Manifest、本机执行器和负责人激活决定 |
| 受控技术修复 | `technical_repair_execute` | 仅技术专家、仅当前 `operations.technical-repair` 指派；只暴露白名单文件、测试命令和恢复检查。只有 A君返回 `verified=true`、测试与恢复检查通过并安全带回后，员工才可回报 `succeeded` |

Hermes Session 只保存对话和上下文；A君/业务 Agent 保存任务与 checkpoint；Paperclip 保存组织级真相。MCP Server 不保存 secret、聊天正文、会话数据库、任务副本或审批副本。微信聊天读取必须经 `ContentAcquisitionCenter` 和 `yichen-wechat-local-vault` 受控适配器，临时授权同时匹配负责人、飞书会话、当前 Agent、单一会话、固定时间范围和最多 200 条。A君默认使用本地当天零点至当前时间、增量刷新和同名会话最近活跃策略；除联系人/群名外不要求负责人配置技术选项。受控适配器只调用已解密 Vault 的只读查询入口；固定本机执行器可在读取前调用既有增量解密脚本。私密分析仅允许回环地址上的已验收 Qwen3.5-9B，最多 120000 字符、单块不超过 20000 字符，按最新消息优先截断；不得抓取新密钥、操作微信 UI、持久化原文、发送者或把原文发送给云模型与外部平台。新增工具必须复用现有服务契约、声明只读/副作用注解，并具有失败关闭和脱敏测试。

### 10.1 架构师三层输出

架构师的 Paperclip 指派必须附带由活动 Manifest 与 A君真实任务记录生成的 `groundTruth`，至少包含快照校验值、活动岗位、岗位真实任务类型、工具白名单、仓库引用、近期任务摘要和可引用证据。架构师报告分为：

- `factClaims`：当前事实。每条必须绑定快照中真实存在的 `agent:*`、`task:*`、`task-type:*` 或 `repo:*` 引用；
- `architectureJudgments`：架构判断。必须写明事实依据、假设和 `low | medium | high` 置信度，不能冒充事实；
- `candidateProposals`：未来候选方案。允许提出当前不存在的新岗位、能力、接口或任务类型，但必须说明问题、最小验证计划、风险与非目标；
- `currentStateUnknowns`：会影响现状判断但当前快照没有覆盖的信息。

A君只对当前事实和判断引用的现状依据执行硬证据校验；不会因为候选方案超出现有能力而拒绝报告。候选方案通过验证和审批前仍不能写成已实现、已注册或已上线。旧字段 `evidenceRefs` 与 `unverifiedClaims` 仅作为兼容输入保留。快照只含脱敏数据，不包含聊天正文、secret、Cookie 或签名参数。

### 10.2 技术故障分流

普通员工故障升级技术专家前，A君必须保留脱敏错误文本并归类为 `code_defect_candidate`、`authorization_or_permission`、`input_or_source`、`transient_external_dependency` 或 `unknown`。只有 `code_defect_candidate` 且只读诊断给出的代码路径、测试路径在当前仓库真实存在时，才允许形成 `repairScope` 并进入隔离修复。授权/权限问题转授权恢复，输入/来源问题转补材料或适配器证据，外部瞬时故障遵守一次安全重试，未知或范围不足则产出 `technical_diagnosis_report` 并停在 `waiting_test`。诊断、改动、测试和恢复验证必须分别记录，不得把其中任一步冒充完整修复。

正式员工 Manifest 的 `runtimeCapabilities` 是 Profile 配置输入：`skills`、`mcpTools`、`feishuToolsets` 与 `paperclipToolsets` 必须显式列出。配置器只能从该白名单生成独立 Profile 和 Adapter；新员工不得继承另一个员工的会话、记忆或扩大后的工具集合。

## 11. 跨系统映射要求

- 每个适配器必须有契约测试样例；
- 平台缺少字段时必须明确使用扩展字段、本地存储或降级，不得丢弃；
- 平台增加未知状态时先映射为受控未知状态并报警，不自动当作成功；
- 时间统一使用带时区的 ISO 8601；
- 展示名可变化，内部关联只使用稳定 ID；
- 日志和测试夹具不得包含真实 secret 或不必要的私人内容。

# Agent军团领域语言

本文件固定核心编排使用的业务词义，避免任务、通知和内容活动在不同运行时中被重复解释。

## Language

**任务受理（Task Intake）**：
一个尚未执行、但已完成输入规范化、幂等识别、岗位路由、能力与风险门禁的任务信封。
_Avoid_: 任务创建 helper、请求预处理

**任务定义（Task Definition）**：
按唯一 taskType 固定默认岗位、开放委托目标、入口分类、展示身份与主要产物要求的版本化业务声明；所有入口和展示只能查询它，不能各自维护任务类型映射。
_Avoid_: 路由常量表、飞书岗位映射、MCP 专用任务清单

**任务状态策略（Task Status Policy）**：
集中解释任务状态是否终态、是否阻塞、是否需要负责人介入，以及对应的展示标签、优先级、Paperclip 投影和生命周期事件语义的唯一规则。
_Avoid_: 页面状态表、聊天状态判断、局部终态数组

**业务工作流（Business Workflow）**：
从用户业务目标出发，把一个或多个岗位步骤、能力请求、产物门禁和人工验收绑定到稳定 workflowId 的执行主对象。
_Avoid_: Agent 调用列表、聊天轮次、临时 DAG

**能力决策（Capability Decision）**：
Policy 根据岗位 Manifest、数据等级、副作用、凭据范围和预算，对一次能力请求作出的自动允许、人工本机授权、Paperclip 组织审批或拒绝决定。
_Avoid_: Model 自审批、工具里写死的权限判断

**能力执行（Capability Execution）**：
Agent Runtime 经 CapabilityAdapter 调用已批准能力，并在允许时完成一次有界恢复、一次重试和 ExecutionReceipt 留痕的过程。
_Avoid_: Agent 直接调 Provider、无限重试、服务报错透传

**能力真相（Capability Truth）**：
把岗位或能力区分为已声明、已配置、运行可达、任务实证、人工验收五层，禁止用前一层冒充后一层。
_Avoid_: 全部可用、已上岗即已验证

**本地 AI 插件运行时（Local AI Plugin Runtime）**：
以版本化插件代码、仓库外运行根和固定模型/依赖清单承载本机 AI 能力的可安装运行 Module；A君只通过回环能力 Interface 调用，项目目录、模型进程和运行数据互不绑定。
_Avoid_: 仓库内 venv、随 A君 release 复制模型、写死 checkout 的 LaunchAgent

**工作流评估（Workflow Evaluation）**：
从任务终态、可验证产物、执行凭证和人工验收派生 Workflow 是否真正完成、降级、失败或待人工确认。
_Avoid_: 单一 status 字段、聊天回复成功

**任务通知（Task Notification）**：
从任务链、恢复链和已验证产物派生的单条用户可见进度或交付说明。
_Avoid_: 聊天状态、完成文案

**故障恢复协调（Failure Recovery Coordination）**：
普通任务执行失败后，在后台有界启动运维诊断，并把待恢复、启动失败和重试次数写回原任务恢复链的过程。
_Avoid_: 无限重试、只发“诊断中”消息、阻塞原任务返回

**岗位执行（Role Execution）**：
已核验的 Paperclip 指派被绑定到岗位、Case、可信工具范围和唯一任务信封后，由对应岗位执行器产生并回读已验证 Work Product 的过程。
_Avoid_: 员工 handler、岗位分支集合

**飞书指挥（Feishu Command）**：
把飞书对话解释为确定性路由、任务跟进或受控审批动作，并把任务真相格式化回原会话的入口编排。
_Avoid_: 聊天 handler、关键词分支

**开放研究执行（Open Research Execution）**：
开放任务从 Manifest 能力判断、公开来源检查点、预算推进到 ResearchReport 写回的可恢复执行过程。
_Avoid_: 搜索 helper、研究路由函数

**本机内容生产（Local Content Production）**：
本机视频拆解、受控视觉分析、平台草稿生成及证据文件落盘共同组成的内容生产过程。
_Avoid_: 内容增长大类、媒体 helper

**活动生命周期（Campaign Lifecycle）**：
CampaignGrant 从草案、批准、运行、暂停/恢复到停止，并与每日 Case、Cron 和 readiness 保持一致的状态序列。
_Avoid_: Campaign helper、状态更新器

**活动阶段执行（Campaign Stage Execution）**：
活动 Case 按固定 Route 进入 Hermes 或确定性工具，并在执行前规划输入、在重放时核验同一 Case 与 Work Product 证据的过程。
_Avoid_: 阶段 method、工具参数 helper

**阶段恢复（Stage Recovery）**：
从失败 Case、Issue、Run、Event 与 Work Product 派生唯一恢复真相，生成受版本保护的 PlanRevision，并由系统 Controller 幂等消费的过程。
_Avoid_: 重试 helper、恢复状态拼装

**活动交付证据（Campaign Delivery Evidence）**：
把脚本、配音、渲染、静态卡、机器审核、PublishReceipt 与 Provider 回执绑定为同一来源链的一组可重放不变量。
_Avoid_: 输出 JSON、校验 helper

**发布尝试（Publish Execution）**：
在重新核验 CampaignGrant、连接器批准、预算和不可变媒体租约后，以唯一幂等键完成一次平台写入并保存 PublishReceipt 的安全协议。
_Avoid_: 发布请求、connector 调用

**指标采集（Metric Collection）**：
PublishReceipt 到期后，以固定 2h/24h/72h collectionKey 领取短租约、调用只读指标连接器并以 CAS 写回快照的安全协议。
_Avoid_: 指标查询、采集 helper

**CUA 发布会话（CUA Publish Session）**：
在隔离 Profile 与不可变媒体租约上按固定动作序列驱动浏览器，并从语义快照核验账号、origin、停止原因和强发布回执的有界会话。
_Avoid_: 浏览器脚本、CLI wrapper

**M5 v2 对账（M5 v2 Reconciliation）**：
在任何写入前完成只读检查和私有 rollback snapshot，再执行受控变更、写后回读，并在失败时逆序恢复的迁移协议。
_Avoid_: 迁移脚本、修数据命令

**Controller JWT 切换（Controller JWT Cutover）**：
以固定 Controller 白名单、私有不可替换快照和 pinned cleaner 完成 Run-JWT 配置切换或逆序回滚的安全协议。
_Avoid_: 配置更新脚本、JWT helper

## Relationships

- 一次 **任务受理** 产生一个可执行或等待输入/审批的任务信封。
- **任务定义**是任务受理、飞书指挥、MCP/HTTP Adapter 和任务展示共同消费的唯一任务类型真相；新增普通任务类型不得要求各入口重复登记。
- **任务状态策略**只解释已持久化状态，不自行推进任务；任务生命周期负责写状态，通知、事件和平台 Adapter 读取同一策略。
- 一次任务受理必须进入一个稳定的 **业务工作流**；跨岗位子任务继承同一 workflowId，并拥有不同 stepId。
- **能力决策** 在能力执行之前完成；Model 只提出请求，不能批准自己的权限、费用或外部副作用。
- **能力执行** 只能消费自动允许的能力决定；需要人工批准的请求交给本机授权或 Paperclip，不得静默绕过。
- **工作流评估** 同时核验任务状态、产物和 ExecutionReceipt；质量型工作流还要等待人工验收。
- **本地 AI 插件运行时**是能力执行的本机 Adapter；它可独立安装、激活、停止和回滚，但不能创建业务任务或改变能力决策。
- 控制台和飞书状态只展示 **能力真相**，Manifest active 和进程在线都不能单独证明业务可用。
- **岗位执行** 只能消费已核验的 Paperclip 指派，并将结果写回原任务信封与原 Case。
- **飞书指挥** 只解释和展示任务真相；需要外部写入或权限变化时仍必须经过审批。
- **开放研究执行** 和 **本机内容生产** 都通过岗位执行进入，不能创建第二套任务状态。
- 一个任务信封在任意时刻最多派生一条当前 **任务通知**。
- **故障恢复协调**只处理普通任务的诊断启动与失败落账，不递归恢复运维诊断、技术修复或微信私密读取任务。
- **活动生命周期** 使用 Paperclip Case 和 CampaignGrant 作为唯一活动真相，不创建第二套任务状态。
- **活动阶段执行** 只能推进活动生命周期允许的 Case；它产生的 **活动交付证据** 必须能从同一 Case、Project、Provider 回执和工作区文件重放。
- **发布尝试** 只能消费已完成重放校验的 **活动交付证据**；成功后产生的 PublishReceipt 是后续 **指标采集** 的唯一输入。
- **CUA 发布会话** 只是发布尝试的一个 Adapter，不能自行推进活动生命周期。
- **M5 v2 对账** 与 **Controller JWT 切换** 都必须先持久化可验证恢复锚，再允许第一笔变更。

## Example dialogue

> **开发者：** “收到内容发布请求后，是否直接进入活动生命周期？”
> **领域负责人：** “不。先完成任务受理；只有 CampaignGrant 经负责人批准后，活动生命周期才能启用每日 Case 和 Cron。任务通知只解释当前真相，不能推进状态。”

## Flagged ambiguities

- “状态”曾同时指任务真相和聊天展示；已明确：任务/Paperclip 保存真相，**任务通知**只是派生说明。

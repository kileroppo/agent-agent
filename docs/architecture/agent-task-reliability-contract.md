# Agent 任务可靠性契约

本契约适用于飞书、Hermes MCP、HTTP 与跨 Agent Mission。它不新增任务控制面，任务真相仍由 A君运行时保存，组织级治理仍由 Paperclip 保存。

## 一、受理与终态回告

- **持久化即受理**：任务或 Mission 已获得持久化 ID 后，入口不得再返回“未创建”。后续规划未就绪时返回已受理状态，由执行器继续分派。
- **来源决定回告**：来自飞书的任务由服务端登记完成监听；客户端只能作为兼容回退。登记结果必须显式返回，失败时不得承诺“会自动告诉你”。
- **终态只有一次**：成功、失败、需要人工输入都属于终态，必须按任务 ID 幂等回告；进度查询不能替代终态通知。

## 二、依赖与证据

- 下游任务必须同时保存 `dependsOn` 与 `sourceTaskIds`，不能只依赖执行顺序推测输入来源。
- 普通业务 Mission 与产品成熟度 Mission 的依赖都只有在前置任务 `succeeded` 后才算满足。`needs_input`、`waiting_test`、`failed`、`cancelled` 只能让总任务进入对应的显式未完成状态，不能触发下游，也不能冒充“前置已完成”。
- 业务信号上下文必须经过同一受限规范化入口穿过“入口 → A君计划 → 子任务”。爆款信号只允许保留可序列化且不超过 12KB 的 `boomSignal`，最终分析必须能回溯 `workId`、评分等级和观察证据。
- 可选能力失败时降级并明确标记缺失；只有用户声明为 `required` 的能力才阻断任务。
- 报告中的关键判断必须引用确认稿、时间点或画面证据；部分报告不得伪装成完整报告。

## 三、业务通道隔离

- 飞书业务会话只展示用户任务、必要进度、追问和最终结果；后台记忆整理、技能创建、调试日志、生命周期消息不得进入业务聊天。
- 正式业务 Profile 关闭隐式 Memory/Skill 自改与自动 Curator；显式写入必须进入人工审批。
- Hermes 升级后必须重放平台通知隔离补丁，并执行 Profile 策略检查；任一检查失败不得认定运行时交付完成。

## 四、验收证据

交付必须分别记录：代码与测试、不可变 release、A君监听端口/PID/工作目录、Hermes Gateway PID、真实 API 返回，以及需要用户发送消息才能完成的飞书外部验收。任何一层通过都不能冒充另一层通过。

## 五、任务关注与受控恢复

- `task-attention-presentation` 是首页、记录和详情共用的安全展示契约。它优先选择当前 Paperclip Run 的岗位报告，过滤无信息套话，只投影原因、影响、证据、未知风险、受控动作、验证状态和折叠技术字段；旧任务继续兼容读取，不迁移 Store。
- `task-record-service` 按 `local-owner` 与 `lan` 明确投影详情。LAN 只读访问不得获得原始输入、路由、治理、恢复事件、原始错误或产物内容；本机主人也只获得执行受控动作所需的白名单字段。
- `task-recovery` 只登记并执行 `use_confirmed_transcript_only`、`request_safe_recovery`、`request_read_only_diagnosis` 三类动作。动作必须由本机同源页面携带短期主人 nonce、幂等键和 `expectedUpdatedAt` 发起；LAN share key 永远只读。
- Paperclip 所属恢复通过 `projectChild` 追加到原 Issue 审计链；原失败任务保持失败终态。存在恢复链时只展示进度，不重复执行。`governanceMode=paperclip` 的审批不得由本机 reject 路径单边改写。
- `task-record-detail-view` 是详情区块的纯生成 Interface；`refresh-scheduler` 提供可注入的 15 秒调度、可见性门禁、不重入与清理。静态 ESM 资源必须同时通过 HTTP 200 与 JavaScript Content-Type 门禁。
- 上述实现和隔离浏览器验收只证明候选源码可用；当前 `4321` 不可变 live 未切换，飞书、Paperclip、Publisher、Provider 及真实恢复按钮均未做外部写入验收。

## 六、审批恢复与卡死显性化

- 审批通过后的恢复必须使用包含 manager 的岗位查找。A君总任务不能因为默认员工列表过滤 manager 而停在 `queued / approval_approved`。
- 找不到活动岗位或执行器时，任务必须转为 `failed / approval_resume_executor_unavailable`，并给出可重试的安全恢复入口；禁止静默保持“已批准”或“运行中”。
- Boom Monitor 接受军团任务后只记为 `submitted`，随后持续读取总任务与子任务真相，投影为 `planning`、`acquiring`、`analyzing`、`waiting_approval`、`needs_input`、`completed`、`failed` 或 `cancelled`。
- 已受理但超过门限仍没有计划、任务记录无法读取、子任务卡在需处理状态时，必须进入“需要处理”，并链接到真实任务详情。队列状态不得只停在历史 `dispatched`。

## 七、内容获取运行健康与有限恢复

- Content Acquisition Center 的健康状态必须来自运行时探测。静态注册只能说明“已配置”，不能把 CookieBridge、DownloadServer 或平台读取能力显示为绿色。
- MediaCrawler Pro 的单请求、整段指标采集和媒体下载分别有有界超时；超时统一返回 `provider_timeout`，不允许无限悬挂。
- 指标读取只允许同一适配器重试一次；仍失败后按“专用适配器优先、通用适配器兜底”切换一次。未通过动态健康探测的适配器不得收到真实读取调用。
- 获取产物必须保存安全路由证据：最终适配器、尝试次数、是否发生回退及前序失败类别。不得保存 Cookie、Token、响应正文或其他凭据。

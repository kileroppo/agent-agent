# M5 Publisher Gateway

这是无模型、确定性的发布边界。Publisher Runtime 默认关闭；`fake` 只用于本地
验收，`real` 只有通过独立生产构造门禁后才可在内存中构造：

- 假抖音和假小红书返回可核验的测试内容 ID；
- 使用 content-campaign-service 的 canonical CampaignGrant 字段和下划线动作名；
- 同一幂等键只执行一次，外发前持久化 attempt，账本可通过文件锁跨进程保护；
- 外部成功但回执未落账时，下一次只会暂停并要求核对，绝不重发；
- 发布前把实际文件复制为本次调用专用的只读私有快照并核对审核哈希；连接器只能
  流式读取该快照，拿不到源路径，调用结束后快照自动销毁；
- 验证码、身份验证、账号切换、风控、违规和未知页面立即停止；
- 上述所有 CUA 停止原因第一次出现就请求暂停活动并关闭 Cron；普通可恢复发布失败
  才使用“连续两次失败后暂停”规则；
- 同平台重复哈希、活动总量和单日平台上限触发暂停；
- 当前 connector 只执行即时发布：`scheduledDate` 必须等于执行时刻对应的
  `Asia/Shanghai` 日历日；历史或未来日期都在读取产物和调用 connector 前以
  `publisher_scheduled_date_mismatch` 拒绝，并要求把平台 Case 重排到上海当日，
  不补发历史 Case，也不提前发布未来 Case；
- connector 使用的 `accountRef` 只能来自 Paperclip 回读的 canonical
  CampaignGrant；平台返回的账号引用必须与它完全一致，错配时暂停活动，不生成可信
  PublishReceipt；
- 暂停必须由 Paperclip 控制适配器同时回写 CampaignGrant 并关闭 Cron；
- 暂停回写失败或回执不完整时，发布器持久化全局安全门闩并拒绝后续发布；
- 发布前由注入的确定性 `costReporter` 回读活动剩余预算；不足时在任何 connector
  调用前暂停 CampaignGrant 并关闭 Cron；
- Fake 和本机 CUA connector 固定记录 0 美元；抖音官方 API 只接受 HTTP 传输层
  返回的结构化实际金额和 provider 请求引用，不读取调用方费用字段；
- 费用记录与发布账本共用幂等事务；已确认记录在重启重放时不重复上报，提交结果
  未决时停止并等待核对；
- 指标只接受专用无模型 HTTP 控制器的显式调用；控制器由 Paperclip
  `executionPolicy.monitor` 唤醒，发布器不创建 2h/24h/72h 计划或进程内定时器。
- 指标 claim 只允许尚未外呼的 `prepared` 状态按租约恢复；进入 `invoking` 后成为
  持久栅栏，旧调用未明确结束前其他进程不能再次启动 connector、预算检查或计费。
- `invoking` 超过 10 分钟只会由 Paperclip Monitor 转成 `human_review` 并禁止
  自动重试；Runtime 的 `reconcileMetricInvocation` 要求调用侧注入
  `publisher.reconcile_stale_attempt` 专用 Paperclip 授权、有效持久 claimToken
  和全账本唯一 authorizationId，并在最终变更前二次核验。A君 exact replay
  只读返回旧结果，不再进入可写恢复；standalone 服务不暴露恢复路由。
- 核对为 `no_external_effect` 时只落为可重新授权的失败终态，不自动再次调用；
  核对为 `external_effect_verified` 时先暂停 Campaign/Cron 再进入 blocked/hard-stop；
  暂停或账本提交失败也会激活进程内及持久 hard-stop。
- 上述是本地失败关闭接口，不代表 live 已可恢复。Paperclip `2026.722.0` 当前没有
  原生过期、撤销和原子 consume 的一次性恢复 Approval 契约，canonical provider
  尚未实现，当前 A君 live 进程也未加载该恢复 binding。
- 抖音官方指标即使同时遇到平台风控和费用上报故障，也必须保留 hard-stop，先暂停
  Campaign/Cron；费用记录单独保持未决，不能覆盖或降级安全停止。

发布账本只保存发布 attempt、PublishReceipt、MetricSnapshot、connector 费用幂等
记录和全局安全门闩。
目标源码中的 `m5-publisher-controller` 还会把成功回执写为当前 Case/Issue 的专用
`PublishReceipt` Work Product；该 Work Product 是 Paperclip 证据，不替代网关
幂等账本。CampaignGrant 状态、Cron、阶段、恢复动作仍以 Paperclip 为唯一真相，
网关不保存副本。

### 发布账本崩溃锁

文件账本锁是同目录下的 `<ledger>.lock` 私有普通文件，固定记录
`pid / host / createdAt / nonce`。锁通过完整候选文件的原子硬链接创建，避免其他
进程看到半写入元数据；事务释放时只有仍匹配本进程 `nonce` 的锁才会被原子移出并
删除。

- 同机 PID 仍存活，或锁仍在 5 秒安全期内：最多等待 250 毫秒后停止，不抢锁；
- 只有同机 PID 已确认死亡且超过安全期：原子隔离并复核 inode、元数据后重试；
- 其他/未知主机、内容损坏、未来时间、符号链接、非普通文件或组/其他用户有权限：
  立即硬停并保留文件；
- 所有锁错误都返回唯一的 `recoveryAction`：
  `inspect_and_isolate_publisher_ledger_lock`，必须由运维官核对无人发布后处理；
- 账本 JSON schema 与既有 `schemaVersion: 2` 数据保持兼容，不把锁状态写入账本。

`DisabledRealConnector` 和直接构造的 real 网关仍会拒绝。生产网关只能由
`createProductionPublisherComposition` 经受控 real 分支创建。A君代码已经接入
这一生产 composition，并在每次发布或指标读取前先核验一次性 Paperclip
`action + runId + issueId + campaignId + agentId + authorizationId` 授权；通过后
才延迟读取 connector 批准快照、Secret 引用、预算和账号身份，并构造 Runtime。
这只是代码接线：当前 live 没有注入 `production.enabled`、Paperclip production
access 或真实 connector dependencies，因此不会进入 real 分支。
小红书没有真实 API 连接器；受控 `CuaDriverPublisherRunner` 已实现但默认关闭，
仍缺经 Paperclip 批准并冻结的真实 selector bundle、绑定授权 `accountRef` 且未过期的
`isolated_named` Profile lease、页面身份哈希、强成功证据和平台写授权。

## 生产 Runtime 构造门禁

`createPublisherRuntime({ mode: "real", ... })` 同时满足以下条件才构造：

1. `productionEnabled` 必须严格为 `true`；
2. 显式注入具有 `assertPublishAllowed` 和 `pauseCampaignAndDisableCron` 的
   Paperclip control；
3. 显式注入 schema 为 `agent.army/publisher-cost-reporter/v1` 的确定性
   `costReporter`，实现活动剩余预算查询和 connector 费用上报；
4. 抖音官方 API 必须额外注入 schema 为
   `agent.army/publisher-account-identity-verifier/v1`、`source: paperclip` 的
   确定性账号核验器；
5. 注入非空 `approvedConnectorMap`，每项的批准状态为 `approved`，
   `approvalRef` 以 `paperclip:` 开头，platform/kind 精确匹配且未过期。
6. 读取本人指标必须另行注入 `approvedMetricConnectorMap`，并持有 capability 为
   `read_own_metrics` 的独立批准；发布批准、发布 runner 或发布 Profile 都不能
   替代指标批准和指标执行身份。

批准 map 只允许这些构造描述符：

- `douyin + douyin_official_api`：注入 `httpRequest` 和
  `credentialResolver`，构造 `DouyinOfficialApiConnector`；
- `douyin|xiaohongshu + cua`：注入符合固定契约的 runner，构造
  `CuaPlatformConnector`。

指标 map 只允许这些构造描述符：

- `douyin + douyin_official_api`：复用官方只读 `video.data` 能力，但必须使用独立
  `read_own_metrics` 批准；
- `xiaohongshu + xiaohongshu_own_metrics_cua`：注入独立只读 runner、冻结 selector
  bundle 和未过期的 `isolated_named` Profile lease，构造
  `XhsOwnMetricsCuaConnector`。

小红书发布和指标读取必须使用不同 runner 与不同 Profile。两个能力均在每次真正
调用 connector 前重新检查批准有效期；批准到期、能力错配或运行时身份复用都会在
外部动作前失败关闭。

构造过程不读取环境变量、凭据或登录态，不调用 HTTP，也不创建 CUA session。
fake Runtime 一旦携带真实批准 map 会立即拒绝；生产网关只接受
`connectorMode` 以 `real:` 开头的 connector。成功回执分别记录
`real:douyin_official_api`、`real:douyin_cua` 或
`real:xiaohongshu_cua`，不会写成 fake。

这只是可注入的生产构造契约，不是生产启用配置。生产模式不能由
`AJUN_M5_PUBLISHER_MODE` 或其他环境变量开启；只有可信嵌入入口显式传入 production
对象后，A君才会建立上述延迟授权链。Paperclip 仍是活动、批准、预算和恢复的唯一
真相，没有新增第二套活动状态。

## 独立 loopback 服务

`npm run serve` 启动独立于 A君的无模型 HTTP 进程。默认
`M5_PUBLISHER_MODE=disabled`，只提供可读健康状态；发布、回执和指标接口全部返回
`publisher_runtime_disabled`。服务只能绑定 `127.0.0.1`、`::1` 或
`localhost`，配置成 `0.0.0.0`、局域网地址或公网地址会在监听前拒绝。

2026-07-30 的 live 只读核验显示 `127.0.0.1:4390` 正在监听，`GET /health`
返回 `status=disabled`、`mode=disabled`、`hardStop=false`、
`realConnectorsConfigured=false`。这只证明 disabled 服务存活，不代表生产
composition 已注入或真实发布可用。

生产准备度可用只读命令核验：

```bash
npm run production:readiness
```

它不读取或输出 Secret，不修改 Paperclip、Cron、Campaign 或本机服务。当前结果是
`not_ready`、退出码 `2`，共 6 项明确阻塞，唯一下一步为
`provide-campaign-status-snapshot`。这表示生产门禁仍关闭，不是可发布状态。

接口固定为：

- `GET /health`：返回 `disabled|ok`、当前模式和全局硬停状态；
- `POST /publish`：调用 Gateway 的 canonical CampaignGrant、文件哈希、机器审核、
  上限和幂等门禁；
- `GET /receipts/:id`：按 receipt ID 或编码后的幂等键读取回执及已落账指标；
- `POST /metrics`：只接受显式 `receiptId + collectionKey + collectedAt`，不创建定时器。

显式 fake 进程需要：

```bash
M5_PUBLISHER_MODE=fake \
M5_PUBLISHER_HOST=127.0.0.1 \
M5_PUBLISHER_PORT=4390 \
M5_PUBLISHER_WORKSPACE_ROOT=/absolute/content-workspace \
M5_PUBLISHER_LEDGER_PATH=/absolute/publisher-ledger.json \
M5_PUBLISHER_PAPERCLIP_API_BASE=http://127.0.0.1:3100 \
M5_PUBLISHER_DAILY_ROUTINE_ID=<v2-daily-routine-uuid> \
npm run serve
```

服务内置的 Paperclip control 每次发布都回读活动父 Case 和显式绑定的每日
Routine，要求同属一个 Project、父 Case 位于 `campaign_active`、Grant 为
`active` 且 Cron 已启用。安全停止时先关闭 Cron，再把 Grant 改为 `paused`，
最后回读两项状态；任一步无法核验会触发 Gateway 全局硬停。服务不保存
CampaignGrant 或 Cron 的第二份真相。

独立 loopback 服务不从环境变量发现真实 connector，也不内置 HTTP 传输、凭据
解析器或 CUA runner，并且明确拒绝注入 production composition。即使设置
`M5_PUBLISHER_MODE=real` 也不会构造真实 Runtime；`realConnectorsConfigured`
始终为 `false`。真实发布只允许经 A君 `LazyProductionPublisher` 在每个请求前刷新
Paperclip 批准快照后进入，不允许 standalone 4390 绕过提前撤销。

### macOS disabled LaunchAgent

`scripts/manage-disabled-launch-agent.mjs` 只管理固定 label
`ai.agent-army.m5-publisher-gateway`。它复用 `npm run serve`，配置严格固定为
`M5_PUBLISHER_MODE=disabled`、`127.0.0.1:4390`，WorkingDirectory 为本目录，
日志写入仓库 `work/m5-publisher-gateway/runtime/`。脚本不能接收 host、port、
fake/real mode、connector 或账号参数。

默认命令是只读 dry-run，不创建目录、plist 或进程：

```bash
npm run launch-agent:dry-run
npm run launch-agent:status
```

安装必须直接运行脚本并提供精确确认串：

```bash
node scripts/manage-disabled-launch-agent.mjs \
  --mode execute \
  --confirm I_ACCEPT_INSTALL_M5_PUBLISHER_DISABLED_LAUNCH_AGENT
```

它只写 `0600` plist、创建 `0700` 日志目录并 bootstrap 同一用户域 label；同配置已
运行时幂等返回，health 异常时只 kickstart 一次并重新核验
`status=disabled / mode=disabled / realConnectorsConfigured=false`。现有 plist 是
符号链接、组/其他用户可读写、不同 working directory、非 loopback 或不同 mode
时拒绝覆盖。

明确回滚动作只卸载该受管 label 和 plist，保留日志：

```bash
node scripts/manage-disabled-launch-agent.mjs \
  --mode rollback \
  --confirm I_ACCEPT_UNINSTALL_M5_PUBLISHER_DISABLED_LAUNCH_AGENT
```

仓库交付与测试不会自动执行安装、启动或回滚。

## 抖音官方 API 连接器源码契约

`DouyinOfficialApiConnector` 已实现且单独构造时默认 `enabled: false`。
生产 Runtime 只有在上述全部门禁通过时才可选构造它。当前只完成依赖注入下的本地契约测试，
没有内置网络传输、没有读取环境变量、没有取得账号凭据，也没有向抖音发送请求。

连接器的最小官方链路是：

1. `upload_video` 上传不可变媒体租约；
2. `create_video` 创建视频；
3. `video_basic_info` 用返回的 `item_id + video_id` 做一次核对；
4. `video.data` 只按已记录回执读取本人内容指标。

HTTP 必须通过 `httpRequest(request)` 注入。每次有响应的传输还必须返回
`actualCost: { amountUsd, providerRequestId|receiptRef, occurredAt }`；缺失、额外字段
或无请求引用都会失败关闭，连接器不猜测金额。上传请求的 `body` 是结构化 multipart
描述，其中只暴露 `createReadStream()`，不暴露源文件绝对路径；传输适配器负责将
它编码为字段名 `video` 的 multipart 请求。传输适配器不得记录或持久化
`access-token`、`open_id` 或原始请求头。凭据必须通过
`credentialResolver({ accountRef, platform, purpose })` 临时解析，并只返回内存中的
`accessToken/openId`。连接器不缓存凭据，不把它们写入结果、错误、回执或账本。
取得 `openId` 后、首个 HTTP 前，连接器会把它转换为
`sha256:<hex>`，再调用 Paperclip 背书的 `accountIdentityVerifier` 核验该哈希是否
属于授权 `accountRef`。核验器只接收 `open_id_sha256`，不接收或返回 `openId`
原文；错配、不可用或夹带自由字段统一以 `account_mismatch` 停止，HTTP 调用数为零。

官方接口没有在该发布链路中提供可依赖的幂等键，因此外部防重仍由 Gateway
“先持久化 attempt、后调用平台”承担。连接器不自动重试：创建请求发出后若断线、
响应缺少内容 ID，或创建后查询无法匹配同一 `item_id + video_id`，一律返回不确定
结果，由 Gateway 暂停 Paperclip 活动并禁止自动重发。

当前只支持不超过 50 MiB 的单次 MP4 上传，超过该上限会在读取凭据或调用 HTTP
之前拒绝；分片上传不在本次最小契约内。文案按官方 `text` 上限允许 1000 个字符，
超过会拒绝，不静默截断。
正式接线仍需单独完成并批准：HTTP 适配器审计、Paperclip Secret 引用、应用
权限和测试账号真实 1 条发布/查询/指标验收。三段链路的 scope 不能混用：

- 上传与创建：`video.create.bind`；
- 创建后基础信息核验：`posting.behavior`；
- 本人视频指标：`video.data`。

官方依据：[视频上传](https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/douyin/create-video/upload-video)、
[创建视频](https://partner.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/douyin/create-video/video-create)、
[查询视频基础信息](https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/posting-task/video-basic-info)、
[查询特定视频数据](https://open.douyin.com/platform/resource/docs/openapi/video-management/douyin/search-video/video-data)。

## A君本地 fake 接线

默认不注入 Publisher。只有显式设置 `AJUN_M5_PUBLISHER_MODE=fake` 才会启用
双假平台、真实文件哈希和文件账本；任何其他非空模式都会失败关闭。启用时必须
显式注入 Paperclip 控制适配器，并实现：

- `assertPublishAllowed(...)`：每次发布前从 Paperclip 读取父 Case，确认处于
  `campaign_active`、Cron 已启用并返回完整 `canonicalGrant`；Gateway 在任何
  预检、限额和账号选择前用它覆盖调用方携带的 Grant；
- `pauseCampaignAndDisableCron(...)`：原子或可核验地把 Grant 改为 paused 并关闭活动 Cron，
  返回 `campaignId`、`grantStatus: "paused"`、`cronStatus: "disabled"` 和 `controlEventId`。

- `AJUN_M5_PUBLISHER_WORKSPACE_ROOT`：可选的绝对工作区；默认使用 A君数据目录下的 `content-growth-artifacts`。
- `AJUN_M5_PUBLISHER_LEDGER_PATH`：可选的绝对账本路径；默认使用 A君数据目录下的 `m5-publisher/ledger.json`。
- 已授权活动可通过现有 `POST /api/tool-executions` 调用唯一动作 `publisher.fake_publish`。
- `GET /api/publish-receipts/:id` 返回 fake 回执和已采集指标。
- 2h、24h、72h 由唯一的无模型 HTTP 控制器使用 Paperclip Issue
  `executionPolicy.monitor` 唤醒；控制器只从 Case 的可信 PublishReceipt 派生
  `receiptId`、`collectionKey` 和时间，发布器只执行、幂等记录和返回
  MetricSnapshot。
- 不创建指标 Cron、`metricSchedules` 或进程内定时器；每个 MetricSnapshot
  作为当前 Case 关联 Issue 的 Work Product 写回。
- 复盘不由 Gateway 执行。目标源码中的独立 retrospective 控制器只读取可信 72h
  MetricSnapshot：少于5条写 `insufficient_sample`，达到5条才在版本化复盘
  Work Product 中附待审核 `LearningProposal`；Gateway 不能改 Prompt、权限、
  频率或投流。

这组配置不会启用抖音官方 API 连接器、账号、浏览器或 Computer Use。

## 双平台受控 CUA connector 契约

### 小红书本人指标只读 connector

`XhsOwnMetricsCuaConnector` 与发布 connector 完全分离，只执行固定五步：
导航官方创作页面、读取本人内容列表、按授权账号和回执内容 ID 过滤、打开详情、
读取指标。它不允许上传、编辑、发布、评论、私信或任意桌面操作。

每次调用都核验官方域名、独立 Profile lease、冻结 selector bundle、授权
`accountRef`、回执内容 ID 和来源身份。返回值只接受固定整数指标字段，并要求
`capturedAt` 不晚于当前时间且在 5 分钟新鲜度内；额外字段、旧证据、账号或内容
错配、验证码、风控和未知页面都会硬停。强停止先暂停活动并关闭 Cron，再记录费用；
暂停无法核验时启用持久安全门闩。

当前只完成 production composition 的本地依赖注入和契约测试，没有真实账号、
真实回执或真实小红书指标，因此不能把它描述为已上线。

`CuaPlatformConnector` 单独构造时默认关闭；生产 Runtime 只有在上述全部门禁
通过时才可选构造它。它只接受
`agent.army/cua-publisher-runner/v1` runner：

- 抖音 origin 固定为 `https://creator.douyin.com`；
- 小红书 origin 固定为 `https://creator.xiaohongshu.com`；
- 每次使用 Paperclip 批准且未过期的 `isolated_named` 独立 Profile lease；lease
  必须精确绑定平台、CampaignGrant 的 `accountRef`、Profile 名和页面账号身份哈希，
  不能携带 Cookie、Token 或登录态；
- 语义动作严格固定为上传媒体、填写标题、填写正文、填写标签、点击发布、读取结果；
- runner 多声明任何动作、允许任意桌面控制或使用其他 Profile 时，连接器拒绝构造；
- 每步 Observation 必须保持精确 origin 和已知页面状态；验证码、身份验证、
  账号切换、风控、平台违规、origin 漂移或未知页面第一次出现就返回硬停；
- 媒体只通过审核哈希绑定的 `mediaLease` 交给 runner，不传源 `mediaPath`；
- session 无论发布、硬停或异常都执行关闭。

### Selector bundle 审计与冻结

候选 bundle 和 Paperclip 批准快照只允许放在仓库
`work/m5-publisher-gateway/selector-candidates/`。CLI 不连接 Paperclip、不创建审批
数据库；它只核验调用方提供的不可写快照，并复用 `cua-trust-contracts.js` 的规范
哈希、平台 origin、版本和到期门禁。

只读检查不会创建目录或文件，输出仅包含版本、平台、origin、规范 checksum、文件
checksum、权限结论和批准到期状态，不输出输入/目标路径或 selector 细节：

```bash
npm run selector-bundle:inspect -- \
  --candidate <candidate.json> \
  --approval-snapshot <paperclip-snapshot.json> \
  --approval-ref paperclip:<approval-ref>
```

批准快照 schema 固定为
`agent.army/paperclip-cua-selector-approvals/v1`，必须声明 `source: paperclip`、
`snapshotId`、`capturedAt` 和非空 `approvals`。被引用 approval 必须完整绑定
`platform / bundleVersion / selectorChecksum / bundleChecksum / expiresAt`。

冻结需要精确确认串：

```bash
npm run selector-bundle:freeze -- \
  --candidate <candidate.json> \
  --approval-snapshot <paperclip-snapshot.json> \
  --approval-ref paperclip:<approval-ref> \
  --confirm I_ACCEPT_FREEZE_M5_CUA_SELECTOR_BUNDLE
```

通过后才会在 `work/m5-publisher-gateway/selector-bundles/` 原子、不可覆盖地写入
`<platform>-<version>.json` 和对应 manifest，两者权限均为 `0444`。manifest 只含
白名单元数据和批准引用，不含 selector、secret 或路径。过期批准、哈希漂移、重复
版本、路径逃逸、符号链接、宽写权限和夹带凭据字段一律硬停。仓库不附带或生成任何
真实平台 selector；测试只在系统临时目录使用 fake 候选。

2026-07-30 的 live 只读核验中，`selector-candidates/` 和 `selector-bundles/`
两个目录均尚不存在，持久文件数为 0；仓库 `work/` 与 Gateway 范围内也没有真实
Profile lease 文件或目录。准确结论是“尚无真实 selector 或 Profile lease
落盘”，不是“已配置但为空”，更不代表真实 CUA 已具备发布条件。

平台策略与本地假页面验收复用同一个 bounded policy renderer 和 typed browser
工具白名单，不开放桌面截图、通用桌面点击、终端、下载、写文件或结束进程。

当前已经提供默认关闭的 `CuaDriverPublisherRunner` 与 `CuaDriverCliBridge`：
runner 只接受上述六种动作；bridge 校验 CuaDriver 版本、应用身份、权限和精确
browser identity，每次会话必须由调用方注入当次交互批准 token，token 不落盘。
媒体先复制到权限为 `0400` 的私有临时租约并复核哈希与字节数，会话结束即清理。
仍未提供经 Paperclip 批准并冻结的真实 selector bundle、绑定授权 `accountRef` 且
未过期的 `isolated_named` Profile lease、页面身份哈希、强成功证据或平台写授权。
`enabled` 默认是 `false`；上述门禁、受控 runner 或活动授权任一缺失时 Runtime
都会硬拒绝，不能把这组源码能力算作真实发布验收。

当前活动仍是未批准草案 `0/14`，Publisher Runtime live 保持 disabled。
因此当前没有可信真实 PublishReceipt、平台指标、LearningProposal 或真实发布。

## 本地 fake MP4 发布与指标回流证据

单主题 v4 证据位于
`work/m5-publisher-gateway/acceptance/fake-mp4-2026-07-30-v4/`。2026-07-31
又使用已通过机器审核的 7 个主题、14 支平台 MP4 完成整条活动验收，证据位于
`work/m5-publisher-gateway/acceptance/fake-seven-day-2026-07-31-v1/`：

- 7 天证据的 schema 为
  `agent.army/fake-seven-day-publisher-acceptance/v1`，对应
  `publisher-ledger.json` 的 `schemaVersion: 2`；
- 7 个上海日历日每天分别生成 1 个抖音和 1 个小红书 fake PublishReceipt，
  共 14 个回执；每条回执记录 2h、24h、72h，共 42 个模拟 MetricSnapshot；
- 44 次 Runtime 重建后仍能重放相同 72h 快照；14 次发布授权断言全部通过，
  无暂停、无重复发布；
- 时间线明确记录 `kind=simulated_checkpoints` 和
  `actualPlatformElapsedTime=false`，因此不是等待真实平台 2/24/72 小时所得的数据；
- `realPlatformTouched=false`、`externalPublished=false`、
  `realPlatformCalls=0`、`totalCostUsd=0`。

可重复运行到新的不可覆盖输出目录：

```bash
npm run acceptance:fake:seven-day -- \
  --confirm I_ACCEPT_LOCAL_FAKE_MP4_ACCEPTANCE \
  --output /absolute/repo/work/m5-publisher-gateway/acceptance/<new-directory>
```

这组证据只证明本地 fake 发布、账本与模拟指标恢复闭环，不是抖音或小红书真实
PublishReceipt、真实平台指标或外部发布验收。

## 本地假平台 Computer Use 验收

`acceptance/fake-platform.html` 是一个只在本机工作的上传/表单夹具：

- 服务仅绑定 `127.0.0.1`，拒绝错误 Host；
- CSP 禁止外连、表单提交、图片/媒体加载和嵌入；
- 文件不会发送到服务端，页面只读取文件名和大小；
- 不包含抖音/小红书域名、Cookie、登录态或真实发布代码；
- 只生成可重复核验的本地假内容 ID。

`scripts/run-local-cua-acceptance.mjs` 默认关闭。即使给了启动开关，也会先检查
`cua-driver >= 0.14.1`、辅助功能和屏幕录制权限，并要求 `doctor` 正常；门禁失败时不会启动隔离浏览器、
bounded daemon 或执行任何 Computer Use 动作。

运行时会创建 15 分钟有效的临时 bounded policy。CuaDriver 通过受支持的
`CuaDriver.app serve` 身份启动，不使用生产不支持的裸二进制 daemon。每次启动隔离
浏览器前都要求新的交互批准 token，脚本不保存或复用批准材料。

CuaDriver 0.14.1 在批准 token 缺失、格式错误或过期时会返回结构化
`browser_consent_required` 拒绝，而不是成功结果中的 `prepared_pid`。Gateway 会保留
这个真实错误；本地验收脚本在启动 daemon 前还会拒绝空 token，不再把授权问题误报
成 `prepared_browser_pid_missing`。每次验收都应先对目标浏览器 PID 运行
`cua-driver browser-approve --pid <pid> --profile-mode isolated_new`，将当次五分钟单次
凭证只注入 `CUA_BROWSER_APPROVAL_TOKEN` 后立即运行；不得打印、落盘或复用凭证。

策略只允许：

- 新建 CuaDriver 自管的 `isolated_new` Chromium Profile，不接入现有登录 Profile；
- 访问精确的 `http://127.0.0.1:<port>` origin；
- 读取获准测试目录的第一层普通文件，拒绝符号链接和越界；
- 使用 `browser_prepare`、页面快照、导航、文件赋值、输入和点击等必要 typed browser 工具；
- 显式拒绝旧 `page`，其余未声明工具默认拒绝；无桌面截图、通用点击、终端、下载、写文件或进程终止权限。

当前随仓库提供无害的 `acceptance/fixtures/sample-upload.txt`，完整本地验收命令为：

```bash
M5_FAKE_CUA_ACCEPTANCE=1 npm run acceptance:cua:local -- \
  --confirm RUN_LOCAL_FAKE_CUA \
  --platform fake-douyin \
  --evidence-output work/m5-cua-fake-douyin-evidence.json
```

切换到 `fake-xiaohongshu` 只会改变本地假回执。脚本自动寻找已运行的
Chrome/Chromium/Edge 主进程，但实际启动的是独立临时 Profile；策略同时允许启动页
`about:blank` 和唯一目标 origin，随后绑定 `browser_prepare` 返回的精确浏览器进程
与最大可见窗口。

`--evidence-output` 必须显式提供当前 `agent-agent` 工作区内尚不存在的 `.json`
文件。成功后脚本以原子、不可覆盖的 0600 普通文件写入本地验收账本；账本只记录
平台、本地 origin、CuaDriver 版本、隔离 Profile、上传文件 basename/哈希/字节数、
策略哈希、本地 contentId、起止时间和 `realPlatformTouched=false`，不记录批准
token、Key、登录态或本机路径。符号链接、越界路径和已有文件都会在写入前拒绝。

macOS 权限必须由负责人手工授予给 `CuaDriver.app`。需要时运行
`cua-driver permissions grant` 并在系统设置中完成授权；自动化不得点击该授权对话。
授权后先用 `cua-driver permissions status --json` 核对
`accessibility: true` 和 `screen_recording: true`，并运行 `cua-driver doctor`
核对运行健康，再执行上面的本地验收。本轮这三项均已通过，并已
在两个本地假平台分别完成一次上传、填表、发布和结果读取：

- fake Douyin：`local-fake-douyin-f8812eeae958a3d5`
- fake Xiaohongshu：`local-fake-xiaohongshu-52b5133e7d77d785`

两次结果均为 `realPlatformTouched=false`；fixture 文件只在本机文件输入控件中读取
名称和字节数，没有上传到服务端。

这条验收永远不等于真实平台发布验收。真实账号、Cookie、验证码、发布和删除仍由
独立活动授权与真实 Publisher Connector 门禁控制。

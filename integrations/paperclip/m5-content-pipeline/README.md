# M5 Paperclip 内容流水线声明

这里不是第二套工作流引擎。它只把 M5 业务约束编译为 Paperclip `2026.722.0`
已有的 Goal、Project、Routine、Pipeline、Case、Review 和 Budget API。

## 安全默认值

- `npm run validate`：只校验本地声明。
- `npm run dry-run`：只写内存中的 `FakePaperclipAdapter`。
- `npm run migration:v2:dry-run`：只读 live 控制面并完整校验指定 gzip 备份；
  不创建 v2 资源，不切换入口。
- `npm run reconcile:v2:dry-run`：只读核验既有 v2 namespace，只报告
  `m5-assets`、`m5-visual-analysis` 和 16 条转换的精确差异。
- Cron Trigger 创建时固定为 `enabled: false`。
- `applyBootstrap` 必须同时获得非 Fake adapter、显式正整数预算和确认串
  `APPLY_M5_TO_PAPERCLIP`。
- 不读取 `.env`，不保存 API Key，不调用发布平台。

## 公共模块

服务端可以从 `src/index.ts` 导入：

- `validateDefinition(definition)`
- `buildBootstrapPlan(definition, bindings)`
- `dryRunBootstrap(options)`
- `applyBootstrap(options)`
- `buildCampaignCaseBatch(input)`
- `ingestCampaignCaseBatch(adapter, pipelineId, batch)`
- `buildParallelWorkCaseBatch(input)`
- `ingestParallelWorkCaseBatch(adapter, pipelineId, batch, dayCase)`
- `FakePaperclipAdapter`
- `HttpPaperclipAdapter`
- `inspectM5V2Migration(options)`
- `inspectExistingM5V2Reconcile(options)`
- `applyExistingM5V2Reconcile(options)`
- `verifyGzipBackupReference(path)`

A君控制器只应调用 `validateDefinition`、`buildBootstrapPlan` 和
`dryRunBootstrap`。真实 `applyBootstrap` 应保留在经审批的运维入口。

## 与 Paperclip 的边界

- `caseKey` 依赖 Paperclip 的 `(pipeline_id, case_key)` 唯一约束。
- 父子任务使用 `parentCaseId`；活动批量生成契约分父活动、7个日期、14个平台
  Case 三层。
- 每个日期另有一个默认不启动的并行工作批次契约：
  `日期 Case → 汇聚 Case → 研究证据/素材/画面分析/生图/配音 5 个分支 Case`。
  分支使用稳定 `caseKey + requestKey`，汇聚 Case 通过 Paperclip blockers
  依赖全部五个分支；
  重试只复用或修复同一组 Case，不生成额外分支。
- 审核使用 Paperclip `review` 的 `approve`、`reject`、`request_changes`。
- `requireChildrenTerminal` 和 `requireNoUnresolvedDrift` 放在两个 Review 阶段。
- onEnter 使用官方 `run_routine`，Routine 使用 `skip_if_active`、`skip_missed`。
- 阶段重试2、内容重规划3仍写入阶段 `m5Policy`，不在本模块另存运行状态。
  `maxConcurrency: 4` 不是 Paperclip 2026.722 Pipeline Case 的原生数字信号量；
  apps 侧无模型协调器会读取 Paperclip 原生 Issue 状态，在跨日期/跨批次活跃分支
  达到4时停止新派发。`m5Policy.maxConcurrency` 只是声明，真正门禁在协调器。
- 旧版 live 固定 2 个无唤醒活动控制阶段（`draft`、`campaign_active`）、14 个
  可执行内容阶段、独立 `done` 与 `cancelled` 终态，合计 18 阶段。复盘是
  `working` 阶段，只有版本化复盘 Work Product 写回成功后才能迁移到 `done`。
- 旧版 live 共有 15 个 Routine：14 个内容阶段入口和 1 个每日活动入口。
- 每日入口 Cron 默认禁用，只有 CampaignGrant 审批后才能由外部治理入口启用，
  并在7天到期时停用。
- 5 个无模型 HTTP Agent 各自只负责一个边界：`m5-daily-controller` 激活当天
  Case；`m5-parallel-controller` 协调最多 4 个并行分支并核验汇聚条件；
  `m5-publisher-controller` 从可信 Case 派生唯一发布并写回
  `PublishReceipt` Work Product；`m5-metrics-controller` 使用 Issue
  `executionPolicy.monitor` 安排 2h/24h/72h 并写回 `MetricSnapshot`；
  `m5-retrospective-controller` 写版本化复盘 Work Product。
- 复盘只接受同平台、标准信任、72h 的真实 `MetricSnapshot`，并按 ContentVersion
  去重。少于 5 条只写 `insufficient_sample`；达到 5 条才附状态为 `proposed` 的
  `LearningProposal`，且必须离线回放、审核和单条灰度，不直接修改生产 Prompt、
  权限、频率或投流。
- 指标链不创建第二个 Cron、`metricSchedules` 或进程内定时器。
- 重复 `apply` 会 PATCH 对账声明中的 Routine 变量、Pipeline 和阶段绑定，而不是
  只按 marker 复用旧资源；系统 Agent 权限使用专用 Paperclip 权限端点，结构比较
  不受 JSON 键顺序影响；遇到未声明阶段或跨 Project 漂移时拒绝自动删除或迁移。

## 并行分支执行边界

`buildParallelWorkCaseBatch` 和 `ingestParallelWorkCaseBatch` 已把 caseKey、父子关系、
五分支、Work Product 期望以及汇聚 blockers 编译为 Paperclip Case API。
apps 侧 `M5ParallelWorkCoordinator` 已接入真实 Routine run、Case/Issue link、全局
活跃 Issue 计数和 Work Product 回读：

1. `TopicSelection` 后先并行派发研究、素材和生图；
2. 素材 `AssetPackage` 健康后才派发小拆画面分析；研究
   `EvidencePackage` 与小拆 `VisualAnalysisPackage` 都健康后，日期主线才进入
   `script`；
3. `VoicePackage` 只在 `ScriptPackage` 健康后派发；
4. 五个分支 Issue 终态且对应健康 Work Product 全部存在后，才完成 blockers
   汇聚 Case 并把日期 Case 推进 `render`；
5. 任意时刻跨日期活跃分支 Issue 达到4即停止新派发。

日期主线改为
`topic → parallel_join_gate → script → parallel_join_gate → render`，研究、素材和
配音不再作为日期 Case 的线性阶段重复执行。Paperclip 不提供数字信号量，因此 `<=4`
由无模型协调器读取 Paperclip 原生 Issue 状态确定性执行，不保存第二份状态。

当前 v2 clone-cutover 已写入 live 的 15 阶段 Pipeline、17 个 Routine 和 5 个
无模型控制器；活动仍是未批准草案 `0/14`，每日 Cron 关闭，内容插件保持
`disabled`。该结构写入没有唤醒 Hermes、调用 StepFun 付费工具或执行外部发布。

## 既有 v2 专用对账

`reconcile:v2:dry-run` 不调用 `applyBootstrap`，会精确核验 v2 Project/Pipeline
identity、唯一岗位绑定、其余 Routine、15 个阶段、纯净 draft Campaign、从未触发且
关闭的每日 Trigger，以及 `m5-assets`/`m5-visual-analysis` 无运行记录。它只接受
已知四分支旧声明或五分支目标声明，任何无关漂移都会阻断。

```bash
npm run reconcile:v2:dry-run -- \
  --api-base http://127.0.0.1:3100 \
  --company-id <uuid> \
  --pipeline-id <v2-pipeline-uuid> \
  --project-id <v2-project-uuid>
```

强确认 apply 必须额外提供不存在的绝对回滚快照与 progress journal 路径。快照
v2 保存 assets、visual 和 transitions 的 old/target payload 与 SHA-256；两个文件
均以 `0600 + wx` 创建。每次外部写成功后 progress journal 都追加 ID、revision 和
目标 hash 并 `fsync`。允许的写集合固定为：`m5-assets` revision PATCH、新建
`m5-visual-analysis` Routine、PUT 全部 16 条转换。预算、Trigger、Campaign、
Goal、Project 和控制器都没有写入口。任一步或写后回读失败都会输出结构化
`recovery_required`，包含已确认完成的操作、失败步骤、快照和 journal 路径。

```bash
npm run reconcile:v2:apply -- \
  --api-base http://127.0.0.1:3100 \
  --company-id <uuid> \
  --pipeline-id <v2-pipeline-uuid> \
  --project-id <v2-project-uuid> \
  --rollback-output /absolute/path/m5-v2-rollback.json \
  --progress-output /absolute/path/m5-v2-progress.jsonl \
  --confirm APPLY_M5_EXISTING_V2_VISUAL_ANALYSIS_RECONCILE
```

恢复入口先整体执行 old/target/unknown 三态判断；任何 unknown 漂移都会在零写入时
停止。允许恢复时严格逆序处理 transitions、visual、assets：transitions 只从 target
恢复 old；visual 和 assets 都重新 GET 并以当前目标 revision 作为
`baseRevisionId` 做 CAS PATCH。重复 recover 为零写幂等。

```bash
npm run reconcile:v2:recover -- \
  --api-base http://127.0.0.1:3100 \
  --company-id <uuid> \
  --snapshot /absolute/path/m5-v2-rollback.json \
  --progress-output /absolute/path/m5-v2-progress.jsonl \
  --confirm RECOVER_M5_EXISTING_V2_VISUAL_ANALYSIS_RECONCILE
```

## v2 迁移门禁

`migration:v2:dry-run` 会现场读取旧 Pipeline、Case、每日 Routine/Cron，并完整解压
指定 `.sql.gz` 备份。只有旧版18阶段、无活动 Case、唯一草案活动、发布进度0/14、
Cron关闭、备份健康和目标15阶段全部成立时，`preconditionsPassed` 才为 `true`。

```bash
npm run migration:v2:dry-run -- \
  --api-base http://127.0.0.1:3100 \
  --company-id <uuid> \
  --legacy-pipeline-id <uuid> \
  --backup /absolute/path/paperclip-backup.sql.gz
```

当前只提供审计，不提供 `migrate-v2-apply`。Paperclip 2026.722 缺少把现有
Campaign/每日入口原子切换到新 Pipeline 的公开接口契约；在该能力补齐并完成独立审核
前，旧 Pipeline、Case、Issue、Work Product 和 Cron 必须原样保留。

另提供专用 `clone-cutover:v2:dry-run` 与强确认 `clone-cutover:v2:apply`。clone
路线不原地改 v1：Routine 使用 deployment namespace，运行时用显式
`M5_ACTIVE_PIPELINE_ID`、`M5_ACTIVE_PIPELINE_KEY` 和 Project 范围选择 Routine；新 v2 只创建未批准 `0/14`
草案且 Cron off，旧草案写 `supersededByCaseId` 后进入 `cancelled`、不可恢复。
回滚只允许 v2 仍未批准、无子 Case、Cron off 时取消 v2 草案。当前 live 已完成
clone-cutover，旧 v1 Pipeline 和 22 个 Case 保留，v2 草案未批准且 Cron off。

## 本机验证

```bash
npm install --ignore-scripts
npm test
npm run test:fake-e2e
npm run acceptance:fake-e2e
npm run validate
npm run dry-run
```

`test:fake-e2e` 同时执行 Pipeline 全链 Fake 验收和真实
`M5ParallelWorkCoordinator` 定向测试；`acceptance:fake-e2e` 输出经过敏感字段、
凭据值和绝对路径审计的 JSON ledger。两条命令都在子进程内禁用网络，只使用内存
Paperclip、Fake 岗位与 Fake Publisher Connector，不调用 StepFun 或真实平台。
Pipeline 自动化以当前 `npm test` 输出为准；A君全量自动化需在对应包独立执行。
`validate` 返回15阶段，`dry-run` 创建17个 Routine 和5个
无模型控制器且 `writesToLivePaperclip=false`。

当前 live v2 为17个 Routine、15个阶段和5个无模型控制器；新活动仍是
未批准草案 `0/14`，每日 Cron 关闭；旧 v1 Pipeline 和22个 Case原样保留。live 结构、Fake adapter 或本地 Work Product
测试不代表活动已启动、已发布或已完成学习。

`apply` 命令存在但默认拒绝写入。即使传入确认串，也必须显式提供 API 地址、
company UUID 和预算；上线前仍需单独审批。

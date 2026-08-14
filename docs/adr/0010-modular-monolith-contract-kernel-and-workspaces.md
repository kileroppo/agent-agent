# ADR-0010：模块化单体、共享契约内核与根 Workspace

| 字段 | 内容 |
| --- | --- |
| 状态 | 已生效；SQLite、严格 TypeScript 生产边界与正式本机 release 已切换 |
| 日期 | 2026-08-02 |
| 决策人 | A君 |
| 关联 | `docs/plans/architecture-debt-repayment-execution.md` |

## 背景

A君运行时已经从单一业务入口扩展为任务生命周期、岗位执行、恢复、M5 内容自治、
Paperclip 适配、飞书接线和本机能力网关。当前全量自动化仍然稳定，但核心文件、状态推进、
M5 契约和平台结构已经出现明显的变更扩散：多个调用方可以直接改任务状态；M5 契约在
A君、Pipeline、内容插件与 Publisher 重复；启动文件同时承担装配、生命周期与 HTTP 路由；
多个真实包仍通过深层相对路径互相引用。

当前产品规模仍是单用户、本地优先和 3–10 个并发任务。把 A君拆成微服务、引入第二套
编排平台或重写为新框架不会直接解决状态与契约分散，反而会增加部署与一致性成本。

## 决策

1. A君继续采用 Node.js ESM 模块化单体；小D、Publisher Gateway、Paperclip 和 Hermes
   继续保持现有独立运行边界，不新增微服务。
2. 任务状态只能通过任务生命周期 Module 推进。TaskStore 负责持久化，不再作为任意字段
   覆盖入口；历史兼容状态通过显式迁移和规范化读取。
3. 在 `packages/` 建立共享 M5 领域契约 Module。只有跨 A君、Pipeline、内容插件或 Publisher
   的稳定不变量进入共享契约；各 Adapter 的身份、信任和失败关闭检查仍留在自身实现。
4. M5 Pipeline/Case 编排与领域校验归 M5 内核；A君保留任务入口、受控岗位 assignment、
   查询投影与本机执行适配，不保存第二份 M5 活动状态。
5. Paperclip 只有一套底层 HTTP transport、认证和错误规范化；领域 Module 不直接依赖
   Paperclip 原始响应结构。
6. `server.js` 收敛为 3 行进程入口；Composition Root、领域 HTTP 路由、监听和后台生命周期
   拆到可注入、可测试的 Module。
7. A君本地状态从整文件 JSON 迁移到 SQLite，保留只读备份、可重复导入、迁移校验和回滚
   路径；Paperclip 的组织级真相归属不变。
8. 仓库建立根 npm Workspace、显式包依赖和统一验证入口。继续使用 `node:test`；先对现有
   JavaScript 启用静态检查，再按变更触达逐步迁移类型，不进行一次性语言重写。
9. 不可变发布继续使用既有冻结、验证、切换计划、恢复证明和进程探针门禁；本轮保持其对外
   命令与 manifest 兼容，不把架构重构与 live 切换合并为同一不可恢复动作。

## 不变量

- Paperclip 仍是唯一组织级控制面；A君不得新增组织、预算、调度或审计真相。
- Hermes 继续保存 Profile、Session、Memory 和执行历史；飞书继续只是交互与展示入口。
- 真实发布、付费调用、扩权、凭据读取和外部写入仍需原有独立授权。
- M1–M5 已验证任务、历史 JSON 状态、不可变 release manifest 和现有 HTTP 路由保持兼容，
  除非有版本化迁移和回滚证据。
- 重构期间 live 活动、Cron 与真实 Publisher 保持关闭；不得用本地测试冒充 live 或外部验收。

## 后果

- 新增共享契约、SQLite schema、根 Workspace 和静态架构检查。
- 现有大 Module 会通过兼容门面渐进收敛，避免一次性改写全部调用方。
- 每个阶段先跑聚焦测试，再跑 A君、Pipeline、插件、Publisher 的全量自动化；最终才切换
  本机 live release。
- Node 24 兼容已通过完整 `test`/`check`；正式 live 仍使用 Node 22.23.1，主版本切换继续作为
  独立发布动作。

## 候选 1–7 实施结果

- `task-lifecycle` 已接入 JSON/SQLite Store 的创建、审批、worker 租约与普通更新路径。
- `m5-contracts` 已被 A君、Pipeline、内容插件和 Publisher 消费；CampaignGrant 规则进入独立领域 Module。
- A君 Bridge 与 Pipeline Adapter 共用 `paperclip-client` transport；M5 语义 Client 集中端点，主业务路径不再拼接 Paperclip URL 或读取原始响应结构。旧 stage recovery 的结构兼容仍留在内核适配层。
- `server.js` 只保留 3 行启动入口；Composition Root、监听/后台启动和 M5 Campaign 路由均可独立注入测试。
- SQLite Store、迁移 CLI、显式开关、根 Workspace、架构检查和动态 affected tests 已落地。
- 最终 JSON 快照 `587/25/16/6/5` 已导入 SQLite，关键 ID 校验通过；JSON、校验备份和 plist
  回滚备份均保留。
- 不可变 release `389141e4…` 已绑定独立干净源码提交 `26a4a461…`，主启动、只读恢复、静态
  闭包与快照绑定通过；launchd 二次启动后 PID、cwd、SQLite 句柄和数量一致。

## 2026-08-03 抽象边界深化

- TaskService 的任务类型知识集中到 `TaskCapabilityCatalog`；执行编排和概览关注点分别进入
  `TaskExecutionCoordinator` 与 `task-overview-focus`，外层服务保留兼容 API 与装配职责。
- `M5ControlPlane` 从宽泛代理收敛为内核真实调用面；Fake 与 Paperclip Adapter 通过同一接口
  测试，路由和 Routine 契约测试归属迁回 M5 内核。
- `paperclip-client` 新增组织级语义客户端，A君的任务/子任务投影、公司和员工解析进入独立
  `PaperclipTaskProjector`；Bridge 不再自行拼装这组端点与投影正文。
- 删除 A君对 M5 内核的一行转发门面，生产调用直接使用包 exports；架构检查阻止门面回流。
- affected tests 能按上述深层 Module 选择接缝测试，未知文件或跨模块变更仍退回 Workspace
  全量验证，避免用局部通过冒充整体通过。
- 本节记录候选源码与自动化测试边界，不代表新的不可变 release、运行进程、Paperclip 资源
  或外部 Provider 已切换；这些仍需独立发布与 live 验收。

## 2026-08-07 深层 Module 继续收敛

- `TaskIntake` 以单一 `create(input)` Interface 隐藏任务规范化、幂等、岗位路由、Manifest
  能力门禁、风险审批与 Paperclip 投影；`TaskService` 不再逐项知道受理顺序。
- `TaskNotification` 以单一 `status(taskId, chatRef)` Interface 隐藏任务链选择、恢复状态与各岗位
  产物交付文案；相同完成事实只在一个 Seam 解释。
- `CampaignLifecycle` 集中活动批准、暂停/恢复、每日 Case 激活、预算/插件/Routine readiness、
  Cron 原状态恢复与串行控制；Kernel 保留兼容 Interface 和执行装配，不再同时实现生命周期。
- 这轮以 Depth、Leverage 和 Locality 为目标，不以总行数下降冒充架构改善。TaskService 与 Kernel
  两个入口分别约 545/294 行；五个责任 Module 均进入防回涨门禁。现有执行文件仍是下一轮候选。
- 后续执行收敛已完成：`task-service-execution` 只保留 M5 阶段结果写回与 Work Product 同步，
  Paperclip 指派和岗位执行分别进入独立 Module；调用方继续使用原 TaskService Interface。
- Campaign 执行以唯一 composition Seam 组合 Route、Replay、Planning 三个 method set；Work Product 来源
  血缘与脚本到发布凭证的交付校验分别进入冻结 Interface，原 Kernel 调用不需要知道内部拆分。
- 这些 Module 通过 deletion test：移除任一 Module 会让身份/Case 绑定、重放不变量或跨产物证据规则
  回流多个调用点；它们不是为了缩短文件而增加的一次性 helper。
- Publisher Gateway 继续作为唯一安全入口，但发布尝试与指标采集分别由 `publish(request)` 和
  `collect(input)` 两个小 Interface 隐藏预算、租约、幂等、连接器批准、CAS、暂停与 hard-stop 协议；
  Gateway 只保留组合、Paperclip 暂停和全局安全门闩。
- 全仓后续收敛按相同原则处理本机内容生产、开放研究、Paperclip 业务投影、飞书指挥、Stage
  Recovery、CUA Publisher Session、控制台 ES Module、媒体产物、M5 v2 对账、Controller JWT Cutover
  与本地 chaos 验收；原公开路径仅保留必要 composition/export Seam，不新增平行状态或 transport。
- 生产源码新增通用 1000 行硬门禁；本轮新增 Module 另设 100–750 行责任上限。历史 release、测试、
  data 与运维 scripts 不进入该门禁，避免为了统计数字拆散不可变归档或一次性命令。
- 本节仍只证明候选源码和自动化；没有生成不可变 release、切换 live、恢复 Campaign/Cron/Publisher
  或触发任何外部效果。

## 2026-08-08 产品装配根深化

- `runtime-composition-root.ts` 从直接认识岗位、飞书、Campaign、Publisher 和系统 Controller 的宽入口，
  收敛为组合深层运行 Module 的产品壳；公开 `createRuntime()` Interface、端口、数据目录、HTTP 路由和
  后台服务顺序保持不变。
- 活动生命周期运行装配进入 `runtime/content-campaign-composition.ts`，集中 Paperclip Control Plane、
  Publisher、预算票据、模板解析和视觉工具执行；调用方只消费 `campaigns()` 与受控执行能力。
- 岗位执行装配进入 `runtime/role-execution-composition.ts`，集中研究、办公、本机内容生产、技术修复、
  提案与 TaskService 的实现知识；删除该 Module 会让这些装配规则重新扩散到产品根入口，因此通过
  deletion test。
- 飞书指挥和 Paperclip 系统 Controller 分别进入独立装配 Module；官方飞书、Hermes 原生交付、员工
  飞书连接、heartbeat、daily/parallel、Publisher、指标、复盘与学习状态不再由产品根入口逐项构造。
- 产品装配根设置 300 行和 35 个直接 import 的双门禁，各领域装配 Module 设置独立责任上限；
  affected tests 将领域装配变更映射到真实消费者和 `runtime-start` 组合测试。
- 本节仅证明共享源码结构和自动化验证；未生成或切换不可变 release，当前 `4321` live 不因本次源码
  重构自动变化，也未恢复 Campaign/Cron/Publisher 或触发外部效果。
- 根 `repository-catalog.json` 成为 Workspace、应用类型、生命周期和正式入口的机器可读真相；
  `check:architecture` 要求全部 Workspace 和 `apps/*` 登记、入口存在、包名一致且每个 Workspace
  提供用途描述与 README。`apps/boom-monitor` 被固定为非 Workspace 的 `legacy-rollback`，正式
  replacement 仍是 A君原生 Module；其本机 SQLite/日志未做破坏性搬迁。

## 2026-08-08 任务 Interface 深化

- 删除 `TaskService` 中被 `task-approval-coordinator` 覆盖的旧审批、Paperclip 决定和小D控制实现；
  公开方法名不变，运行时只保留一套审批真相。
- 新增 `TaskOverview`，以 `read()`、`usage()` 与 `billing()` Interface 隐藏控制台展示、岗位连接状态、
  本机能力健康、用量和账单解释；`TaskService` 不再同时承担查询视图构造。
- `TaskService` 从 613 行收敛到 320 行，责任上限从 650 降到 350；审批与总览 Module 分别设置
  300/275 行上限。门禁额外拒绝外层重新声明已经委托的同名方法。
- affected tests 为审批和总览 Module 映射真实 TaskService/运行组合消费者；未知的 TaskService 变更
  继续退回 A君 Workspace 全量测试。
- 本节仍是候选源码结构，不代表当前 `4321` 不可变 release 已切换，也不证明任何飞书、Paperclip、
  Publisher 或外部 Provider 行为发生变化。

## 2026-08-14 TypeScript 运行边界与热点优化

- 生产业务源码统一迁移到严格 TypeScript；测试和一次性运维脚本仍可保留 JavaScript/MJS。浏览器
  入口以 `frontend/src/*.ts` 为唯一源码，`public/*.js` 与 `frontend/generated/*.js` 只是可重建产物。
- 本节取代“按触达渐进迁移”的过渡策略。根 `check` 同时验证全部 Workspace、浏览器构建、Paperclip
  兼容层和架构策略；生产 JavaScript 清单必须为空，避免同一业务同时维护 JS/TS 两份真相。
- `AgentRegistrySnapshotCache` 通过可注入 Adapter 提供 1 秒快照缓存和并发去重；传入 `null` 可删除缓存
  而不改变注册表行为。`TaskDefinitionRegistry` 预计算直接任务类型索引，并拒绝同一岗位的重复默认映射。
- 固定性能门禁覆盖 100 次岗位列表和 50 万次直接任务路由；相对迁移前基线分别提升约 80% 和 93%，
  任一热点回退超过 5% 即失败。
- 迁移保持 SQLite 读取/迁移、HTTP 路由、共享契约、不可变 release manifest 和外置状态目录兼容；
  Publisher、Campaign、Cron、飞书和外部 Provider 的授权状态不因语言迁移而改变。
- 正式 A君 release `5ceb5069…`（payload `49872add…`、clean Git `ee27aed…`）已在 Node 22.23.1
  上从 `src/server.ts` 启动；小D `4318` 也已从 `src/server.ts` 重启。两端 HTTP 200，A君历史
  任务总数 833、运行中 0，切换前后保持一致；旧 plist、旧 release 和小D JS rollback worktree 均保留。

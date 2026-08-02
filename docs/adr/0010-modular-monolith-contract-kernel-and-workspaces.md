# ADR-0010：模块化单体、共享契约内核与根 Workspace

| 字段 | 内容 |
| --- | --- |
| 状态 | 已确认，候选 1–7 已实施；待正式 release 切换 |
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
6. `server.js` 收敛为 Composition Root 和进程启动入口；领域 HTTP 路由拆到可注入、可测试
   的路由 Module。
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
- Node 主版本升级不与首轮结构迁移捆绑；先验证 Node 24 兼容，再通过独立 release 切换。

## 候选 1–7 实施结果

- `task-lifecycle` 已接入 JSON/SQLite Store 的创建、审批、worker 租约与普通更新路径。
- `m5-contracts` 已被 A君、Pipeline、内容插件和 Publisher 消费；CampaignGrant 规则进入独立领域 Module。
- A君 Bridge 与 Pipeline Adapter 共用 `paperclip-client` transport；M5 语义 Client 集中端点，业务服务不再拼接 Paperclip URL。
- `server.js` 只保留 3 行启动入口；Composition Root、监听/后台启动和 M5 Campaign 路由均可独立注入测试。
- SQLite 兼容 Store、迁移 CLI、显式开关、根 Workspace、架构检查和 affected tests 已落地。
- 最终临时不可变候选已通过主启动和只读恢复启动 smoke；因当前来源工作树仍为 dirty，未切换 R4 live，
  正式 release 必须在形成可追溯 source revision 后重新冻结。

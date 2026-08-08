# 标准产品仓库结构改造交接

| 字段 | 内容 |
| --- | --- |
| 状态 | 待验收 |
| 创建时间 | 2026-08-08 13:18 CST |
| 交出者 | Codex |
| 接手者 | 项目负责人 / 后续发布执行者 |
| 关联任务 | [仓库产品地图](../../product/repository-map.md)、[ADR-0010](../../adr/0010-modular-monolith-contract-kernel-and-workspaces.md) |
| 截止条件 | 候选结构冻结为可追溯不可变 release，并完成 A君核心只读路由验收 |

## 1. 接手目标

- 目标：把当前候选源码结构安全冻结为标准产品 release，不重做已完成的目录和 Module 改造。
- 用户约束与不可做事项：保留未提交用户修改；不读取或复制 `.env`；不恢复 Campaign、Cron、Publisher；不触发外发、付费或外部平台写入。
- 做完的定义：干净候选提交与不可变 release 一一绑定，A君监听 PID/cwd/release 可核对，核心只读 HTTP 路由返回正确 Content-Type，外部能力仍保持原开关状态。
- 唯一下一步：负责人确认本交接所列候选范围后，从隔离干净工作树冻结不可变 release，并只读验收 `4321/api/overview` 与 `4321/api/console-overview`。
- 允许继续的前提：明确授权提交候选源码和切换 A君 release；切换前重新核对工作树、现有监听和回滚点。

## 2. 当前事实

| 类别 | 事实 | 证据位置 | 状态 |
| --- | --- | --- | --- |
| 代码与文档 | 仓库目录清单覆盖全部 Workspace/应用；A君装配根和任务核心已深化 | `repository-catalog.json`、`apps/ajun-runtime/src/runtime/`、`apps/ajun-runtime/src/task-overview.js` | 已验证 |
| candidate 实现 | 任务关注契约、安全详情投影、三类受控恢复、详情纯视图、15 秒刷新调度与四组主导航均已落地 | `apps/ajun-runtime/src/task-attention-presentation.js`、`apps/ajun-runtime/src/task-recovery.js`、`apps/ajun-runtime/public/task-record-detail-view.js`、`apps/ajun-runtime/public/refresh-scheduler.js` | 已验证 |
| 本地运行时 | 当前 4321 仍是改造前的不可变 release `4711d139…`，PID `45694`，共享工作树修改不会自动加载 | `npm run runtime:fingerprint` 和监听/cwd 只读检查 | 已验证 |
| 外部平台 | 本轮未调用飞书、Paperclip、Publisher 或 Provider，也未更改其开关 | 本交接验证账本 | 未验证 |
| 人工确认 | 产品目录分类和候选发布范围尚待负责人确认 | 本交接 | 待确认 |

## 3. 变更与决策

- 已完成：新增机器可读仓库目录清单与产品地图；补齐 Workspace README/description；将历史 Boom Monitor 固定为非 Workspace 回滚资产；将运行装配拆入四个深层 Module；删除 TaskService 影子审批；新增 TaskOverview；建立行数、import、委托方法和 affected-test 门禁。
- 本轮补充：落地 `task-attention-presentation`、`task-recovery`、`task-recovery-policy`、`task-record-detail-view` 与 `refresh-scheduler`；详情使用分级安全投影，恢复只允许登记动作，不复制 Paperclip、飞书或 Hermes 控制面。
- 关键文件：`repository-catalog.json`、`docs/product/repository-map.md`、`apps/ajun-runtime/src/runtime/`、`apps/ajun-runtime/src/task-service.js`、`apps/ajun-runtime/src/task-overview.js`、`scripts/check-architecture-boundaries.mjs`。
- 已确定边界：继续采用模块化单体；Paperclip/Hermes/飞书不在仓库内重造控制面；`apps/boom-monitor` 暂不搬迁本机 SQLite/日志；公开 `createRuntime()` 与 `TaskService` Interface 保持兼容。
- 不要重复创建：第二套仓库目录清单、第二个任务控制台、另一套审批/预算/任务真相或平行 Paperclip Client。

## 4. 验证账本

| 层级 | 结论 | 命令或证据 | 未证明部分 |
| --- | --- | --- | --- |
| 自动化 | PASS | `npm run check && npm test && git diff --check`；A君全量、架构门禁、受影响测试和静态 ESM HTTP 路由均通过 | 不代表 live release |
| 隔离浏览器 | PASS | 随机端口临时数据；1440、768、390×844；观察两个 15 秒刷新周期 | 未点击真实恢复动作，不代表外部平台写入通过 |
| 运行时 | PARTIAL | PID `45694`、release `4711d139…`；`/api/overview` 与 `/api/console-overview` 均返回 200 JSON | 候选源码尚未冻结或切换到 4321 |
| 外部平台 | NOT CHECKED | 本轮刻意未触发外部效果 | 飞书、Paperclip、Publisher、Provider 均未做 E2E |
| 人工验收 | NOT CHECKED | 等待负责人查看产品地图与发布范围 | 目录命名和产品分类尚未人工确认 |

## 5. 风险、权限与关闭

- 当前阻塞或风险：共享工作树包含用户已有的 `docs/acceptance-fixtures/technical-repair-sandbox` 子模块修改，冻结候选时必须只选择确认过的路径；当前 `4321` 仍是旧不可变 release，候选页面不能当成 live；Publisher 健康状态与本次结构改造无关，不应为清告警而扩大范围。
- 不得复制或展示的信息：任何 API Key、token、Cookie、`.env` 内容、授权链接和自定义敏感地址。
- 需要谁确认：项目负责人确认候选范围、提交与 A君不可变 release 切换。
- 关闭条件：候选提交、不可变 release、PID/cwd/release、两个核心只读路由和回滚点均有事实证据；未授权外部能力保持关闭。
- 关闭证据链接：完成后补充到本文件，并同步 `README.md` 当前阶段说明。

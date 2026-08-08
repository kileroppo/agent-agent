# 标准产品仓库结构改造交接

| 字段 | 内容 |
| --- | --- |
| 状态 | 已关闭 |
| 创建时间 | 2026-08-08 13:18 CST |
| 交出者 | Codex |
| 接手者 | 项目负责人 / 后续发布执行者 |
| 关联任务 | [仓库产品地图](../../product/repository-map.md)、[ADR-0010](../../adr/0010-modular-monolith-contract-kernel-and-workspaces.md) |
| 截止条件 | 候选结构冻结为可追溯不可变 release，并完成 A君核心只读路由验收 |

## 1. 接手目标

- 目标：把当前候选源码结构安全冻结为标准产品 release，不重做已完成的目录和 Module 改造。
- 用户约束与不可做事项：保留未提交用户修改；不读取或复制 `.env`；不恢复 Campaign、Cron、Publisher；不触发外发、付费或外部平台写入。
- 做完的定义：干净候选提交与不可变 release 一一绑定，A君监听 PID/cwd/release 可核对，核心只读 HTTP 路由返回正确 Content-Type，外部能力仍保持原开关状态。
- 唯一下一步：无；后续若执行真实恢复动作，按任务详情逐次确认，不把本次页面验收当成外部执行授权。
- 允许继续的前提：真实恢复、飞书/Paperclip 写入、Provider 调用或平台发布继续按各自授权边界执行。

## 2. 当前事实

| 类别 | 事实 | 证据位置 | 状态 |
| --- | --- | --- | --- |
| 代码与文档 | 仓库目录清单覆盖全部 Workspace/应用；A君装配根和任务核心已深化 | `repository-catalog.json`、`apps/ajun-runtime/src/runtime/`、`apps/ajun-runtime/src/task-overview.js` | 已验证 |
| candidate 实现 | 任务关注契约、安全详情投影、三类受控恢复、详情纯视图、15 秒刷新调度与四组主导航均已落地 | `apps/ajun-runtime/src/task-attention-presentation.js`、`apps/ajun-runtime/src/task-recovery.js`、`apps/ajun-runtime/public/task-record-detail-view.js`、`apps/ajun-runtime/public/refresh-scheduler.js` | 已验证 |
| 本地运行时 | 4321 已切到提交 `d071098…` 的不可变 release `869473aa…`，payload `057f082f…`，PID `49100` | release manifest、`npm run runtime:fingerprint`、监听/cwd 与核心路由回读 | 已验证 |
| 外部平台 | 本轮未调用飞书、Paperclip、Publisher 或 Provider，也未更改其开关 | 本交接验证账本 | 未验证 |
| 授权 | 负责人已明确授权提交、冻结和切换 A君 release | 本交接对应对话 | 已确认 |

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
| 活动运行时 | PASS | PID `49100`、release `869473aa…`；`/api/overview`、`/api/console-overview`、`refresh-scheduler.js`、`task-record-detail-view.js` 均返回正确 200 Content-Type | 不代表外部平台 E2E |
| 活动浏览器 | PASS | 真实失败任务 `336712b6…`；1440、768、390×844；桌面观察两个 15 秒刷新周期 | 没有点击任何恢复动作 |
| 外部平台 | NOT CHECKED | 本轮刻意未触发外部效果 | 飞书、Paperclip、Publisher、Provider 均未做 E2E |
| 发布授权 | PASS | 负责人明确回复授权；按授权完成本机不可变 release 切换 | 不扩展到外部写入或付费调用 |

## 5. 风险、权限与关闭

- 当前阻塞或风险：共享工作树仍包含用户已有的 `docs/acceptance-fixtures/technical-repair-sandbox` 子模块修改，两个候选提交均未纳入它。release 工具不允许把旧包冒充精确回滚；当前回滚边界是新包内已验证的只读 recovery entrypoint，不挂载业务状态、无写路由、无外部效果。Publisher 健康状态与本次结构改造无关。
- 不得复制或展示的信息：任何 API Key、token、Cookie、`.env` 内容、授权链接和自定义敏感地址。
- 需要谁确认：本交接关闭不再需要确认；真实恢复或外部动作仍由负责人逐次确认。
- 关闭条件：候选提交、不可变 release、PID/cwd/release、两个核心只读路由和回滚点均有事实证据；未授权外部能力保持关闭。
- 关闭证据：提交 `22d6701`、兼容修复提交 `d071098`；release `869473aa…`；PID `49100`；真实失败页两个刷新周期、三档视口与空页面错误日志。

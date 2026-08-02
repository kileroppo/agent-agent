# Agent军团系统重构与技术负债偿还执行计划

| 字段 | 内容 |
| --- | --- |
| 状态 | 候选 1–7 代码与候选验证完成，待可追溯 release 切换 |
| 创建时间 | 2026-08-02（Asia/Shanghai） |
| 用户结果 | 完成候选 1–7，降低维护成本、变更影响面和回归范围，并保留现有真实能力 |
| 架构决策 | [ADR-0010](../adr/0010-modular-monolith-contract-kernel-and-workspaces.md) |

## 1. 当前事实

- 仓库：`agent-agent`；分支 `experiment/governance-hermes-full-migration`；起始 HEAD
  `400cc08ee88cb44b765f21001e2e447b6740497f`。
- 起始工作树已有 52 个已跟踪文件差异和多个未跟踪文件/模块，均视为用户现有工作并保留。
- A君 live PID `58141` 从 R4 不可变 release 运行，cwd 不指向可写源码；Publisher PID
  `82321` 从当前 Publisher 目录运行。
- 起始自动化：A君 `1057/1057`、Pipeline `67/67`、内容插件 `97/97`、Publisher `203/203` 通过。
- 当前 live、源码候选和外部平台是不同证据层；本计划不授权付费调用或真实平台发布。

## 2. 范围与完成条件

### 候选 1：任务生命周期

- 集中标准状态、合法迁移、attempt、审批、租约和终态规则。
- 所有直接任务状态 mutation 迁到显式生命周期入口。
- `waiting_test` 等实际状态与核心契约一致。

### 候选 2：共享 M5 契约

- 新建被 A君、Pipeline、内容插件和 Publisher 实际消费的共享 M5 契约 Module。
- 模型、平台、动作、schema、哈希与 Work Product 身份不再多处独立定义。

### 候选 3：M5 内核所有权

- M5 Pipeline/Case 编排和领域校验从 A君大 Module 收敛到 M5 内核。
- A君仅保留受控入口、assignment、查询投影和执行适配。

### 候选 4：Paperclip Adapter

- 统一底层 transport、认证、错误规范化和平台结构转换。
- 删除重复方法，业务 Module 不再直接拼接 Paperclip 路径或依赖原始字段。

### 候选 5：Composition Root

- 拆分运行时构造、领域路由和进程启动。
- 测试通过实际 HTTP 行为与公开 Interface 验证接线，不依赖源码正则位置。

### 候选 6：SQLite 持久化

- 提供版本化 schema、事务、索引、原 JSON 导入、校验、备份和回滚。
- 迁移前后任务、审批、草案、受限测试实例与会话上下文数量和关键身份一致。

### 候选 7：Workspace 与测试架构

- 根 npm Workspace、显式包 exports/dependencies、统一 `test`/`check`/`test:affected` 入口。
- 静态检查覆盖重复类方法、跨层深相对引用和非法依赖方向。
- 全量测试继续保留；普通改动可可靠运行受影响包与契约测试。

### 发布验证门禁

- 复用既有不可变 release 的冻结、验证、恢复证明和进程探针。
- 保持现有命令、manifest、R4 读取与回滚兼容；来源为 dirty 时只做临时候选验证，不激活。

## 3. 非目标

- 不拆微服务，不引入第二套控制面、任务队列、审批或 Agent 编排框架。
- 不改变飞书、Hermes、Paperclip、Publisher 的真相归属。
- 不执行真实发布、付费 Provider 调用、账号扩权或外部消息。
- 不以删除测试或降低安全校验换取更小回归范围。

## 4. 实施顺序与验证门禁

1. **保护性基线**：记录工作树、live PID/cwd、自动化与数据备份策略。
2. **状态纵切**：生命周期规则 → 一个真实调用方 → 聚焦测试 → 全量 A君。
3. **M5 契约纵切**：共享契约 → 一个 Adapter → 契约测试 → 四包回归。
4. **M5/Paperclip 收敛**：逐阶段迁移 Implementation，保留兼容门面。
5. **SQLite 纵切**：临时数据库导入/回读 → 影子校验 → 可回滚 live 切换。
6. **Composition Root 与 release**：先行为测试，再移动装配与发布内部实现。
7. **Workspace/静态检查**：显式依赖、统一命令、affected test，再做 Node 24 兼容验证。
8. **收敛**：停止并行写入、审阅完整 diff、全量自动化、不可变 release smoke、精确 live 切换。

## 5. 风险与恢复

- 任一迁移发现状态数、ID、审批引用或 artifact 引用不一致时，停止切换并保留 JSON 读取路径。
- Paperclip 版本或响应结构不兼容时，回到统一 Adapter 的版本化兼容分支，不允许业务 Module
  直接临时读取新字段。
- 新 release smoke 或 live `/api/overview` 失败时，使用已验证旧 release 或本地只读 degraded
  recovery；不得把候选源码当作 live 修复。
- 当前脏文件发生未知并发变化时立即停止重叠编辑，重新读取后再收敛。

## 6. 验收账本

| 层级 | 当前结论 | 完成要求 |
| --- | --- | --- |
| 静态契约 | PASS | 根 Workspace、架构边界检查、共享包语法检查通过 |
| 聚焦测试 | PASS | 生命周期、双 Store、M5 领域/路由、Paperclip transport 与 affected test 通过 |
| 全量自动化 | PASS | A君 1078、Pipeline 67、插件 97、Publisher 203、共享包 12 项全绿 |
| 数据迁移 | SHADOW PASS | 真实 JSON 只读影子导入 585/25/16/6/5，数量和关键 ID 摘要一致；未切 live |
| 不可变 release | CANDIDATE PASS | 临时候选 `b95f3001…` 共 7592 项，主启动/只读恢复/静态闭包/快照绑定通过并已删除；来源标记 dirty，未激活 |
| 本地 live | 仍为 R4 | PID 58141 的 cwd/entrypoint 已核对，`/api/overview` 200；Publisher `/health` 200 |
| 外部平台 | 不在本计划授权内 | 明确保持未验证、未发布、无付费调用 |
| 人工验收 | 待负责人 | 关键操作与恢复说明可理解、可执行 |

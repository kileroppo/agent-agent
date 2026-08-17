# M5 高权限内容自治交接

> 2026-08-17 归档并继续冻结：历史 PARTIAL 结论不变；只有负责人明确重开后才创建新交接，最终事实见[产品成熟度总交接](./agent-army-product-maturity-handoff.md)。

| 字段 | 内容 |
| --- | --- |
| 状态 | 已归档 / 冻结；M5 未完成，Campaign 已停止，旧 Profile lease 已过期，Publisher 与 Cron 保持关闭 |
| 创建时间 | 2026-07-31（Asia/Shanghai） |
| 最近收敛 | 2026-08-13（Asia/Shanghai） |
| 接手者 | 项目负责人 / 下一位受控发布执行者 |
| 关联验收 | [M5 高权限内容自治验收](../../reviews/m5-high-autonomy-content-operations/acceptance.md) |
| 关闭条件 | 关联验收记录中的自动化、运行时、真实 Provider、真实平台回读和人工验收均达到约定门禁 |

## 接手后先做什么

- 唯一下一步：保持 Campaign、Cron、Publisher 和外部写入关闭，不执行恢复或发布。
- 允许继续的条件：负责人明确重开 M5，并单独批准具体动作；随后从当前源码和运行时重新生成脱敏 readiness 快照，申请新的 Profile lease。旧活动、旧批准、旧 lease 和历史 PID/release 均不得复用为当前授权。
- 即使批准安装、切版或只读预检，也不自动包含 Provider 调用、浏览器写入、创建草稿、发布或群发授权。

## 当前事实

| 层级 | 已知事实 | 当前结论 |
| --- | --- | --- |
| 产品实现 | M5 的内容变体、血缘、审核、预算、审批、恢复与 readiness 契约已有实现和自动化证据 | 代码存在不等于生产闭环完成 |
| 控制面 | Paperclip 是唯一组织任务真相；不得另建 Campaign、审批或发布状态机 | 继续复用现有控制面 |
| 活动与权限 | Campaign 已停止，旧 Profile lease 已过期，Publisher 与每日 Cron 关闭 | 正确的安全状态是 `not_ready` |
| 运行时 | 历史不可变 release、PID、端口和插件包记录均可能漂移 | 重开时必须用 `npm run runtime:fingerprint`、listener/cwd/argv、manifest 与 HTTP 回读重新核对 |
| 外部闭环 | 曾有受控小红书发布及管理页回读证据；未形成当前 M5 双平台、指标回流和真实 Provider 的完整闭环 | 历史单次证据不得扩写成当前生产就绪 |
| 人工验收 | 控制台和部分内容候选曾完成本机/浏览器检查 | 不替代当前授权与平台验收 |

## 已确定边界

- 代码、测试、插件 `ready`、本地浏览器候选和 HTTP 200 都不等于真实发布授权。
- readiness 只读预检不得启用生产；输入必须按当前活动、lease、Provider 和平台状态重新生成并人工审阅。
- 技术修复候选只有进入新的干净不可变 release 并完成运行时回读后，才能写成 live；`candidate_promoted` 不能冒充已发布。
- 不展示或复制 `.env`、API Key、Cookie、飞书/平台身份、授权链接或真实用户标识。
- 不恢复旧停止活动，不沿用旧批准，不因历史真实发布自动授权再次发布。

## 验证账本

| 层级 | 结论 | 证据入口 | 未证明部分 |
| --- | --- | --- | --- |
| 自动化 | HISTORICAL PASS | [M5 验收](../../reviews/m5-high-autonomy-content-operations/acceptance.md) | 当前 HEAD 的新鲜回归 |
| 运行时 | HISTORICAL / STALE | 历史 release、插件和恢复验证见验收记录与 Git 历史 | 当前 listener、release、Paperclip 资源和 Profile 状态 |
| 安全停机 | PASS（最近记录） | stopped Campaign、expired lease、Publisher/Cron off、readiness `not_ready` | 当前状态重开前仍需只读复核 |
| 外部平台 | PARTIAL | 历史受控小红书单次回读 | 当前双平台、Provider、指标和持续运行闭环 |
| 人工验收 | PARTIAL | 历史控制台与候选内容检查 | 当前生产采用结论 |

历史实施过程、具体提交、旧 release/PID、插件包哈希、单次发布回执和历次 readiness 结果不再复制到交接单；需要追溯时从[关联验收记录](../../reviews/m5-high-autonomy-content-operations/acceptance.md)和 Git 历史读取。
